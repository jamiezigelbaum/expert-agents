// Ingest into a domain's page library (docs/page-library.md): the worker side
// of the parse-once lane, behind the library_ingest tool and acquisitions.
//
// A job takes originals the worker has already placed (a gs:// URI that
// view_page can render from, plus a local copy to parse), or references it
// fetches itself (a web page, a Notion page, a Drive file), and, per source:
//   fetch    a reference only: the worker's materializer turns it into a local
//            file with its provenance (URL, retrieval time, stable origin);
//   parse    page units, local OCR (text layer, DeepSeek-OCR, vision lane),
//            figure descriptions, or a local transcript for audio and video
//            (packages/library/src/page-parse.ts);
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

/** A source the job fetches itself before parsing it. */
export interface IngestSourceRef { type: 'url' | 'notion' | 'drive'; ref: string }

/** A fetched reference: a local file to parse and where it came from. */
export interface MaterializedSource {
  name: string;
  file: string;
  uri: string;
  /** The stable identity of the source (`url:…`, `notion:…`, `drive:…`); re-ingesting it replaces its book. */
  origin: string;
  sourceUrl?: string;
  retrievedAt?: string;
  title?: string;
  creator?: string;
}

export interface IngestSourceInput {
  /** Display name: the original's file name, or the reference. */
  name: string;
  /** Where view_page reads the original from; set when fetched for a reference. */
  uri?: string;
  /** A local copy to parse; the job owns it and deletes it when the job ends. Set when fetched for a reference. */
  file?: string;
  /** Fetched by the job when there is no file yet. */
  ref?: IngestSourceRef;
  origin?: string;
  sourceUrl?: string;
  retrievedAt?: string;
  title?: string;
  creator?: string;
}

export interface IngestSourceStatus {
  name: string;
  uri?: string;
  state: 'queued' | 'fetching' | 'parsing' | 'parsed' | 'failed';
  origin?: string;
  source_url?: string;
  retrieved_at?: string;
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
  /** Audio and video: the recording's length in seconds and the transcript's segment count. */
  media?: { duration_seconds: number; segments: number };
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
  /** Fetches a reference into `dir`; throws a PageIngestError (or any error) when it cannot. */
  materialize?: (domainId: string, ref: IngestSourceRef, dir: string) => Promise<MaterializedSource>;
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
  lanes(): { deepseek_ocr: boolean; vision: boolean; transcription: boolean } {
    return { deepseek_ocr: Boolean(this.options.lanes), vision: deepLane(this.options.lanes), transcription: Boolean(this.options.lanes) };
  }

  /** A directory the caller may place owned copies of originals in before enqueueing. */
  async scratch(domainId: string): Promise<string> {
    const dir = join(this.options.stateDir, domainId, 'originals', randomUUID());
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async enqueue(domainId: string, config: { root?: string; sourceId: string; database?: string }, inputs: IngestSourceInput[]): Promise<IngestJob> {
    if (!inputs.length) throw new PageIngestError('page_ingest_no_sources', 'There is nothing to ingest.');
    if (inputs.some((s) => !(s.file && s.uri) && !s.ref)) throw new PageIngestError('page_ingest_no_sources', 'Every source needs a local copy or a reference to fetch.');
    if (inputs.some((s) => s.ref) && !this.options.materialize) throw new PageIngestError('page_ingest_fetch_not_configured', 'This worker cannot fetch sources.', 503);
    // A library in the database needs its writer before anything is parsed.
    if (!config.root) this.options.writer(config.database);
    const now = new Date().toISOString();
    const jobId = randomUUID();
    const job: IngestJob = {
      kind: 'page_ingest_job', job_id: jobId, domain_id: domainId, source_id: config.sourceId, state: 'queued',
      created_at: now, updated_at: now,
      sources: inputs.map((s) => ({
        name: s.name, ...(s.uri ? { uri: s.uri } : {}), state: 'queued', ...(s.origin ? { origin: s.origin } : {}),
        ...(s.title ? { title: s.title } : {}), ...(s.creator ? { creator: s.creator } : {}),
      })),
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
        try {
          if (!input.file) {
            status.state = 'fetching';
            await this.save(job);
            const dir = join(this.options.stateDir, job.domain_id, 'originals', job.job_id);
            await mkdir(dir, { recursive: true });
            const got = await this.options.materialize!(job.domain_id, input.ref!, dir);
            // Kept on the job's inputs, so a restart parses what was fetched instead of fetching again.
            Object.assign(input, {
              file: got.file, uri: got.uri, origin: got.origin,
              ...(got.sourceUrl ? { sourceUrl: got.sourceUrl } : {}), ...(got.retrievedAt ? { retrievedAt: got.retrievedAt } : {}),
              title: input.title ?? got.title, creator: input.creator ?? got.creator, name: got.name,
            });
            Object.assign(status, { name: got.name, uri: got.uri, origin: got.origin, ...(got.sourceUrl ? { source_url: got.sourceUrl } : {}), ...(got.retrievedAt ? { retrieved_at: got.retrievedAt } : {}) });
          }
          status.state = 'parsing';
          await this.save(job);
          const file = input.file!, uri = input.uri!;
          const usage = emptyParseUsage();
          let lastSaved = 0;
          const parsed = await parseObject(file, {
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
          const entry = await writeParsedBook(root, parsed, uri, {
            ...meta, ...(input.origin ? { origin: input.origin } : {}),
            ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}), ...(input.retrievedAt ? { retrievedAt: input.retrievedAt } : {}),
          });
          // An earlier ingest of the same original under other display names, or of the same fetched
          // source (its page may have changed since), is replaced, not kept twice.
          const holds = (b: CatalogEntry) => (b.objects ?? []).includes(parsed.objectId) || Boolean(input.origin && b.origin === input.origin);
          const holding = (await readCatalog(root)).filter(holds).map((b) => b.book);
          if (job.database) holding.push(...(await this.options.writer(job.database_name).catalog(job.source_id)).filter(holds).map((b) => b.book));
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
            ...(entry.source_url ? { source_url: entry.source_url } : {}), ...(entry.retrieved_at ? { retrieved_at: entry.retrieved_at } : {}),
            ...(parsed.media ? { media: { duration_seconds: Math.round(parsed.media.duration), segments: parsed.media.segments } } : {}),
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
      for (const input of inputs) if (input.file) await rm(input.file, { force: true });
      await rm(join(this.options.stateDir, job.domain_id, 'originals', job.job_id), { recursive: true, force: true });
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
