// Ingest into a domain's page library (docs/page-library.md): the worker side
// of the parse-once lane, behind the library_ingest tool and acquisitions.
//
// A job takes originals the worker has already placed (a gs:// URI that
// view_page can render from, plus a local copy to parse) and, per source:
//   parse    page units, local OCR (text layer, DeepSeek-OCR, vision lane),
//            figure descriptions (packages/library/src/page-parse.ts);
//   write    the book's unit files into the domain's tree, replacing an
//            earlier ingest of the same original, and its catalog entry;
// then for the whole job:
//   index    the books' units into the search index (idempotent) and, for a
//            library kept in the database, their catalog entries;
//   embed    chunks without a vector.
//
// A library kept in the database (a route without a tree root) is written
// through a staging tree under the job's state, removed when the job ends: the
// database is the only copy, so ingest on one host serves workers on any.
//
// Jobs run one at a time in the background. Their state is a JSON file per
// job, rewritten as it moves, so status is observable while a job runs and
// after a restart. Every page failure, empty page, unresolved escalation and
// undescribed figure page is listed; nothing is dropped silently. A job the
// worker was restarted during resumes on the next start: lane results are
// cached per page, so only unread pages cost anything again.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  deepLane, emptyParseUsage, parseObject, upsertCatalog, writeParsedBook,
  type CatalogEntry, type OcrLanes, type ParseFailure,
} from '@expert-agents/library';
import { readTreeCatalog, readTreeUnits, type ImportResult, type PageIndexUnit } from './page-index.ts';

export type IngestJobState = 'queued' | 'parsing' | 'indexing' | 'embedding' | 'done' | 'done_with_failures' | 'failed';
const TERMINAL: readonly IngestJobState[] = ['done', 'done_with_failures', 'failed'];

export interface IngestSourceInput {
  /** Display name: the original's file name. */
  name: string;
  /** Where view_page reads the original from. */
  uri: string;
  /** A local copy to parse; the job owns it and deletes it when the job ends. */
  file: string;
  title?: string;
  creator?: string;
}

export interface IngestSourceStatus {
  name: string;
  uri: string;
  state: 'queued' | 'parsing' | 'parsed' | 'failed';
  title?: string;
  creator?: string;
  object_id?: string;
  book?: string;
  kind?: 'pages' | 'sections';
  units?: number;
  /** Pages that needed a lane (OCR or figures), and how many are finished. */
  lane_pages?: { total: number; done: number };
  parsers?: Record<string, number>;
  figures?: number;
  empty_units?: string[];
  failures?: ParseFailure[];
  unresolved_escalations?: Array<{ page: number; reason: string }>;
  undescribed_figure_pages?: number[];
  refusals?: number;
  error?: string;
}

export interface IngestJob {
  kind: 'page_ingest_job';
  job_id: string;
  domain_id: string;
  source_id: string;
  state: IngestJobState;
  created_at: string;
  updated_at: string;
  sources: IngestSourceStatus[];
  index?: ImportResult & { embedded: number; pending_embeddings: number };
  error?: string;
  /** Inputs, kept until the job ends so a restart can resume it. */
  inputs?: IngestSourceInput[];
  root?: string;
  /** The library is the database; `root` is the job's staging tree. */
  database?: boolean;
  /** The named database the library lives in; absent, the default one. */
  database_name?: string;
}

/** What the queue needs from the search index: the writer side of PageIndex. */
export interface PageIndexWriter {
  importUnits(source: string, units: readonly PageIndexUnit[], opts: { books: readonly string[] }): Promise<ImportResult>;
  embedPending(source: string): Promise<{ embedded: number; tokens: number }>;
  pendingEmbeddings(source: string): Promise<number>;
  /** The catalog of a library kept in the database. */
  catalog(source: string): Promise<CatalogEntry[]>;
  replaceBooks(source: string, entries: readonly CatalogEntry[], opts: { books: readonly string[] }): Promise<unknown>;
}

export class PageIngestError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

export interface PageIngestOptions {
  /** <dataDir>/page-ingest: job files, owned copies of originals, the lane cache. */
  stateDir: string;
  lanes?: OcrLanes;
  laneConcurrency?: number;
  /** The index writer of a named database (the default one when absent); throws when it is not configured. */
  writer: (database?: string) => PageIndexWriter;
  /** Called once a job changed a domain's tree or index, so readers drop caches. */
  changed?: (domainId: string, library: { sourceId: string; database?: string }) => void;
  log?: (record: Record<string, unknown>) => void;
}

const JOB_ID = /^[a-z0-9-]{8,64}$/;

export class PageIngestQueue {
  private readonly pending: Array<{ domainId: string; jobId: string }> = [];
  private running?: Promise<void>;

  constructor(private readonly options: PageIngestOptions) {}

  /** The lanes this worker reads pages with, for status and dry runs. */
  lanes(): { deepseek_ocr: boolean; vision: boolean } {
    return { deepseek_ocr: Boolean(this.options.lanes), vision: deepLane(this.options.lanes) };
  }

  /** A directory the caller may place owned copies of originals in before enqueueing. */
  async scratch(domainId: string): Promise<string> {
    const dir = join(this.options.stateDir, domainId, 'originals', randomUUID());
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async enqueue(domainId: string, config: { root?: string; sourceId: string; database?: string }, inputs: IngestSourceInput[]): Promise<IngestJob> {
    if (!inputs.length) throw new PageIngestError('page_ingest_no_sources', 'There is nothing to ingest.');
    // A library in the database needs its writer before anything is parsed.
    if (!config.root) this.options.writer(config.database);
    const now = new Date().toISOString();
    const jobId = randomUUID();
    const job: IngestJob = {
      kind: 'page_ingest_job', job_id: jobId, domain_id: domainId, source_id: config.sourceId, state: 'queued',
      created_at: now, updated_at: now,
      sources: inputs.map((s) => ({ name: s.name, uri: s.uri, state: 'queued', ...(s.title ? { title: s.title } : {}), ...(s.creator ? { creator: s.creator } : {}) })),
      inputs,
      ...(config.root ? { root: config.root } : { root: join(this.options.stateDir, domainId, 'staging', jobId), database: true }),
      ...(config.database !== undefined ? { database_name: config.database } : {}),
    };
    await this.save(job);
    this.pending.push({ domainId, jobId: job.job_id });
    this.kick();
    return publicJob(job);
  }

  async get(domainId: string, jobId: string): Promise<IngestJob> {
    if (!JOB_ID.test(jobId)) throw new PageIngestError('invalid_request', 'job_id is not a job id.');
    const job = await this.load(domainId, jobId);
    if (!job) throw new PageIngestError('page_ingest_job_not_found', 'No such ingest job for this domain.', 404);
    return publicJob(job);
  }

  async list(domainId: string, limit = 20): Promise<IngestJob[]> {
    const dir = join(this.options.stateDir, domainId, 'jobs');
    let files: string[] = [];
    try { files = (await readdir(dir)).filter((f) => f.endsWith('.json')); } catch { return []; }
    const jobs = (await Promise.all(files.map((f) => this.load(domainId, f.slice(0, -5))))).filter((j): j is IngestJob => Boolean(j));
    return jobs.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit).map(publicJob);
  }

  /** Requeue jobs a restart interrupted. */
  async resume(): Promise<number> {
    let domains: string[] = [];
    try { domains = await readdir(this.options.stateDir); } catch { return 0; }
    let n = 0;
    for (const domainId of domains) {
      let files: string[] = [];
      try { files = (await readdir(join(this.options.stateDir, domainId, 'jobs'))).filter((f) => f.endsWith('.json')); } catch { continue; }
      for (const f of files) {
        const job = await this.load(domainId, f.slice(0, -5));
        if (!job || TERMINAL.includes(job.state) || this.pending.some((p) => p.jobId === job.job_id)) continue;
        this.pending.push({ domainId, jobId: job.job_id });
        n++;
      }
    }
    if (n) this.kick();
    return n;
  }

  /** Resolves when every queued job has finished (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private kick(): void {
    if (this.running) return;
    this.running = (async () => {
      try {
        while (this.pending.length) {
          const next = this.pending.shift()!;
          const job = await this.load(next.domainId, next.jobId);
          if (job && !TERMINAL.includes(job.state)) await this.run(job);
        }
      } finally {
        this.running = undefined;
      }
    })();
  }

  private async run(job: IngestJob): Promise<void> {
    const inputs = job.inputs ?? [];
    const root = job.root!;
    const cacheDir = join(this.options.stateDir, job.domain_id, 'lane-cache');
    const entries: CatalogEntry[] = [];
    const replaced = new Set<string>();
    let changed = false;
    try {
      job.state = 'parsing';
      await this.save(job);
      for (const [i, input] of inputs.entries()) {
        const status = job.sources[i]!;
        if (status.state === 'parsed' && status.book) { entries.push(...await catalogEntries(root, [status.book])); continue; }
        status.state = 'parsing';
        await this.save(job);
        try {
          const usage = emptyParseUsage();
          let lastSaved = 0;
          const parsed = await parseObject(input.file, {
            ...(this.options.lanes ? { lanes: this.options.lanes } : {}),
            ocr: true, figures: true, cacheDir, laneConcurrency: this.options.laneConcurrency ?? 2, usage,
            onProgress: (done, total) => {
              status.lane_pages = { total, done };
              if (done === total || done - lastSaved >= 10) { lastSaved = done; void this.save(job); }
            },
          });
          const meta = {
            title: input.title ?? parsed.declared?.title ?? titleFromName(input.name).title,
            creator: input.creator ?? parsed.declared?.creator ?? titleFromName(input.name).creator,
          };
          const entry = await writeParsedBook(root, parsed, input.uri, meta);
          // An earlier ingest of the same original under other display names is replaced, not kept twice.
          const holding = await booksHoldingObject(root, parsed.objectId);
          if (job.database) holding.push(...(await this.options.writer(job.database_name).catalog(job.source_id)).filter((b) => (b.objects ?? []).includes(parsed.objectId)).map((b) => b.book));
          const stale = [...new Set(holding)].filter((b) => b !== entry.book);
          for (const old of stale) { replaced.add(old); await rm(join(root, 'books', old), { recursive: true, force: true }); }
          // The catalog follows each book, so a restart resumes from what is already written.
          await upsertCatalog(root, [entry], stale);
          entries.push(entry);
          changed = true;
          const parsers: Record<string, number> = {};
          for (const u of parsed.units) parsers[u.parser] = (parsers[u.parser] ?? 0) + 1;
          Object.assign(status, {
            state: 'parsed', title: meta.title, creator: meta.creator, object_id: parsed.objectId, book: entry.book, kind: parsed.kind,
            units: parsed.units.length, parsers, figures: parsed.figures.length, empty_units: parsed.emptyUnits,
            failures: parsed.failures, unresolved_escalations: parsed.unresolvedEscalations,
            undescribed_figure_pages: parsed.undescribedFigurePages, refusals: usage.refusals,
          } satisfies Partial<IngestSourceStatus>);
        } catch (error) {
          status.state = 'failed';
          status.error = (error as Error).message.slice(0, 300);
        }
        await this.save(job);
      }
      const books = [...new Set([...entries.map((e) => e.book), ...replaced])];
      if (books.length) {
        job.state = 'indexing';
        await this.save(job);
        const writer = this.options.writer(job.database_name);
        const units = await readTreeUnits(root, entries.map((e) => e.book));
        const imported = await writer.importUnits(job.source_id, units, { books });
        // Units first, then the catalog that lists them, so a reader never meets a listed book without pages.
        if (job.database) await writer.replaceBooks(job.source_id, await readTreeCatalog(root, entries.map((e) => e.book)), { books });
        job.state = 'embedding';
        job.index = { ...imported, embedded: 0, pending_embeddings: await writer.pendingEmbeddings(job.source_id) };
        await this.save(job);
        const embedded = await writer.embedPending(job.source_id);
        job.index = { ...imported, embedded: embedded.embedded, pending_embeddings: await writer.pendingEmbeddings(job.source_id) };
      }
      const failed = job.sources.some((s) => s.state === 'failed' || (s.failures?.length ?? 0) > 0)
        || (job.index?.pending_embeddings ?? 0) > 0;
      job.state = failed ? 'done_with_failures' : 'done';
    } catch (error) {
      job.state = 'failed';
      job.error = (error as Error).message.slice(0, 300);
    } finally {
      if (changed) this.options.changed?.(job.domain_id, { sourceId: job.source_id, ...(job.database_name !== undefined ? { database: job.database_name } : {}) });
    }
    if (TERMINAL.includes(job.state)) {
      for (const input of inputs) await rm(input.file, { force: true });
      delete job.inputs;
      if (job.database) await rm(root, { recursive: true, force: true });
    }
    await this.save(job);
    this.options.log?.({ kind: 'page_ingest_job', domain_id: job.domain_id, job_id: job.job_id, state: job.state, sources: job.sources.length });
  }

  private path(domainId: string, jobId: string): string {
    return join(this.options.stateDir, domainId, 'jobs', `${jobId}.json`);
  }

  private async save(job: IngestJob): Promise<void> {
    job.updated_at = new Date().toISOString();
    const path = this.path(job.domain_id, job.job_id);
    await mkdir(join(this.options.stateDir, job.domain_id, 'jobs'), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(job));
    await rename(tmp, path);
  }

  private async load(domainId: string, jobId: string): Promise<IngestJob | undefined> {
    const path = this.path(domainId, jobId);
    if (!existsSync(path)) return undefined;
    try { return JSON.parse(await readFile(path, 'utf8')) as IngestJob; } catch { return undefined; }
  }
}

function publicJob(job: IngestJob): IngestJob {
  const { inputs: _inputs, root: _root, ...rest } = job;
  return JSON.parse(JSON.stringify(rest)) as IngestJob;
}

async function readCatalog(root: string): Promise<CatalogEntry[]> {
  try { return (JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8')) as { books?: CatalogEntry[] }).books ?? []; }
  catch { return []; }
}

async function booksHoldingObject(root: string, objectId: string): Promise<string[]> {
  return (await readCatalog(root)).filter((b) => (b.objects ?? []).includes(objectId)).map((b) => b.book);
}

async function catalogEntries(root: string, books: string[]): Promise<CatalogEntry[]> {
  return (await readCatalog(root)).filter((b) => books.includes(b.book));
}

/** `author---title-words.pdf` → author and title; otherwise the file name is the title. */
export function titleFromName(name: string): { title: string; creator: string } {
  const stem = name.replace(/\.[a-z0-9]{1,5}$/i, '');
  const [creator, title] = stem.includes('---') ? stem.split('---', 2) as [string, string] : ['', stem];
  const words = (s: string) => s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return { title: words(title) || words(stem) || 'Untitled', creator: words(creator) };
}
