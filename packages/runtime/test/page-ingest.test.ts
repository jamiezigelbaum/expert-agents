import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAgentRoutingConfig } from '../src/core/agent-routing.ts';
import { createDomainExpertWorker } from '../src/workers/domain-expert/index.ts';
import type { PageIndexWriter } from '../src/workers/domain-expert/page-ingest.ts';
import type { PageIndexUnit } from '../src/workers/domain-expert/page-index.ts';
import { scanAndFigurePdf } from '../../library/test/pdf-fixture.ts';

let dir: string;
let tree: string;
let workspace: string;
const scanText = 'Chapter Two. A scanned page read by the local OCR lane, with more than enough words and letters to stand on its own as the text of the page.';
const figureReply = JSON.stringify({ figures: [{ label: 'Figure 1', caption: 'The four quadrants of the map.', description: 'A square divided into four labelled quadrants.' }] });

const ocrFetch = (async (url: string, init: RequestInit) => {
  if (String(url).endsWith('/api/generate')) return Response.json({ response: scanText, done_reason: 'stop' });
  void init;
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: figureReply } }] });
}) as unknown as typeof fetch;

function recordingWriter() {
  const imports: Array<{ source: string; units: PageIndexUnit[]; books: readonly string[] }> = [];
  const writer: PageIndexWriter = {
    async importUnits(source, units, opts) {
      imports.push({ source, units: [...units], books: opts.books });
      return { units: units.length, inserted: units.length, updated: 0, unchanged: 0, deleted: 0, chunks: units.length, reusedVectors: 0 };
    },
    async embedPending() { return { embedded: imports.at(-1)?.units.length ?? 0, tokens: 10 }; },
    async pendingEmbeddings() { return 0; },
  };
  return { imports, writer };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'page-ingest-'));
  tree = join(dir, 'tree');
  workspace = join(dir, 'workspace');
  await mkdir(join(workspace, 'inbox'), { recursive: true });
  await writeFile(join(workspace, 'inbox', 'author---a-sample-book.pdf'), scanAndFigurePdf());
  await writeFile(join(workspace, 'inbox', 'notes.docx'), 'not ingestible');
});

afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

function worker(options: { writer?: PageIndexWriter; uploads?: string[]; downloads?: string[]; annas?: Record<string, unknown>; acquisitionFetch?: typeof fetch } = {}) {
  const pdf = scanAndFigurePdf();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://storage.googleapis.com/upload/')) {
      options.uploads?.push(decodeURIComponent(/[?&]name=([^&]+)/.exec(url)![1]!));
      return Response.json({ name: 'ok', generation: '1' });
    }
    if (url.startsWith('https://storage.googleapis.com/storage/v1/b/')) {
      options.downloads?.push(url);
      return new Response(new Blob([pdf.slice().buffer as ArrayBuffer]));
    }
    void init;
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  return createDomainExpertWorker({
    dataDir: join(dir, `data-${Math.random().toString(36).slice(2)}`),
    gcpProject: 'neutral-project',
    roots: [{ rootId: 'expert_agents_workspace', path: workspace, maxWriteBytes: 20 * 1024 * 1024, allowOverwrite: false }],
    agentRouting: validateAgentRoutingConfig({ history: {
      library: { bucket: 'neutral-library', prefix: 'factory/history' },
      pageLibrary: { root: tree, sourceId: 'history' },
    } }),
    annas: { importGcsPrefix: 'gs://neutral-acquisitions/imports/', ...(options.annas ?? {}) },
    ...(options.acquisitionFetch ? { fetchImpl: options.acquisitionFetch } : {}),
    ocrLanes: { ollamaUrl: 'http://ollama.invalid', visionUrl: 'http://vision.invalid/v1', fetch: ocrFetch },
    ...(options.writer ? { pageIndexWriter: options.writer } : {}),
    pageSearch: async () => [],
    google: { accessToken: 'synthetic-token', fetchImpl },
  });
}

async function call(w: ReturnType<typeof worker>, tool: string, params: Record<string, unknown>) {
  const response = await w.fetch(new Request('http://worker.test/v1/domain', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool, params: { domain_id: 'history', ...params } }),
  }));
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function finished(w: ReturnType<typeof worker>, jobId: string) {
  for (let i = 0; i < 200; i++) {
    const r = await call(w, 'library_ingest', { action: 'status', job_id: jobId });
    if (['done', 'done_with_failures', 'failed'].includes(r.body.job?.state)) return r.body.job;
    await Bun.sleep(25);
  }
  throw new Error('ingest job did not finish');
}

describe('library_ingest', () => {
  test('a workspace PDF with a scan and a figure becomes cited, viewable pages', async () => {
    const { imports, writer } = recordingWriter();
    const uploads: string[] = [];
    const downloads: string[] = [];
    const w = worker({ writer, uploads, downloads });

    const dry = await call(w, 'library_ingest', { action: 'start', workspace_relative_path: 'inbox' });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ status: 'dry_run', lanes: { deepseek_ocr: true, vision: true }, index_writer_configured: true });
    expect(dry.body.sources.map((s: { name: string }) => s.name)).toEqual(['author---a-sample-book.pdf']);
    expect(dry.body.skipped).toEqual([{ path: 'inbox/notes.docx', reason: 'unsupported_type' }]);
    expect(uploads).toEqual([]);

    expect((await call(w, 'library_ingest', { action: 'start', workspace_relative_path: 'inbox', dry_run: false })).body.error.code).toBe('approval_required');

    const started = await call(w, 'library_ingest', { action: 'start', workspace_relative_path: 'inbox/author---a-sample-book.pdf', dry_run: false, approval_id: 'owner-1' });
    expect(started.status).toBe(200);
    expect(started.body.status).toBe('queued');
    // The original is stored, content-addressed, in the domain's acquisition directory.
    expect(uploads).toEqual([expect.stringMatching(/^imports\/history\/originals\/[0-9a-f]{64}\.pdf$/)]);

    const job = await finished(w, started.body.job.job_id);
    expect(job.state).toBe('done');
    const [source] = job.sources;
    expect(source).toMatchObject({
      state: 'parsed', title: 'a sample book', creator: 'author', kind: 'pages', units: 2, figures: 1,
      parsers: { pdftotext: 1, 'deepseek-ocr': 1 }, failures: [], empty_units: [], undescribed_figure_pages: [], refusals: 0,
    });
    expect(job.index).toMatchObject({ units: 3, embedded: 3, pending_embeddings: 0 });
    expect(imports).toHaveLength(1);
    expect(imports[0]!.source).toBe('history');
    expect(imports[0]!.books).toEqual([source.book]);
    expect(imports[0]!.units.map((u) => u.unit).sort()).toEqual(['fig-p0001-1', 'p0001', 'p0002']);

    const read = await call(w, 'domain_library', { action: 'read', slug: `books/${source.book}/p0002` });
    expect(read.body).toMatchObject({ cite: 'author, a sample book, p.2', text: scanText });
    const catalog = await call(w, 'domain_library', { action: 'catalog' });
    expect(catalog.body.books).toEqual([expect.objectContaining({ book: source.book, units: 2, figures: 1 })]);
    // view_page reads the stored original from the acquisition bucket.
    await call(w, 'domain_library', { action: 'view_page', slug: `books/${source.book}/p0001` });
    expect(downloads.some((url) => url.includes('/b/neutral-acquisitions/'))).toBe(true);

    // Re-ingesting the same file replaces its book instead of adding another.
    const again = await call(w, 'library_ingest', { action: 'start', workspace_relative_path: 'inbox/author---a-sample-book.pdf', dry_run: false, approval_id: 'owner-1', title: 'The Sample Book, Revised', creator: 'A. Author' });
    const second = await finished(w, again.body.job.job_id);
    expect(second.state).toBe('done');
    expect(second.sources[0].book).not.toBe(source.book);
    expect([...imports.at(-1)!.books].sort()).toEqual([source.book, second.sources[0].book].sort());
    expect(await readdir(join(tree, 'books'))).toEqual([second.sources[0].book]);
    expect(JSON.parse(await readFile(join(tree, 'catalog.json'), 'utf8')).books.map((b: { book: string }) => b.book)).toEqual([second.sources[0].book]);

    const listed = await call(w, 'library_ingest', { action: 'list' });
    expect(listed.body.jobs.map((j: { job_id: string }) => j.job_id)).toEqual([second.job_id, job.job_id]);
  });

  test('refuses without an index writer, outside the library, and for a domain without a page library', async () => {
    const w = worker();
    const noWriter = await call(w, 'library_ingest', { action: 'start', workspace_relative_path: 'inbox', dry_run: false, approval_id: 'owner-1' });
    expect(noWriter.status).toBe(503);
    expect(noWriter.body.error.code).toBe('page_ingest_writer_not_configured');
    const foreign = await call(w, 'library_ingest', { action: 'start', gcs_uri: 'gs://someone-else/book.pdf' });
    expect(foreign.body.error.code).toBe('gcs_source_not_allowed');
    const both = await call(w, 'library_ingest', { action: 'start', gcs_uri: 'gs://neutral-library/factory/history/a.pdf', workspace_relative_path: 'inbox' });
    expect(both.body.error.code).toBe('invalid_params');
    const unknownJob = await call(w, 'library_ingest', { action: 'status', job_id: '00000000-0000-0000-0000-000000000000' });
    expect(unknownJob.status).toBe(404);
  });

  test('an acquisition for a page-library domain lands in its page library', async () => {
    const { imports, writer } = recordingWriter();
    const booksRoot = join(dir, 'acquired');
    await mkdir(booksRoot, { recursive: true });
    const pdf = scanAndFigurePdf();
    const acquisitionFetch = (async (input: RequestInfo | URL) => {
      if (String(input).startsWith('https://annas.example/download/')) return new Response(new Blob([pdf.slice().buffer as ArrayBuffer]), { headers: { 'content-type': 'application/pdf' } });
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;
    const uploads: string[] = [];
    const w = worker({ writer, uploads, acquisitionFetch, annas: { apiKey: 'fixture-acquisition-token', baseUrl: 'https://annas.example', booksRoot, minPdfPages: 0 } });
    const r = await call(w, 'annas_archive_import', {
      annas_archive_id: 'book-two', title: 'Acquired Book', author: 'B. Writer', format: 'pdf',
      approval_id: 'owner-1', copyright_posture: 'owner_library', ingest: true, dry_run: false,
    });
    expect(r.body.error).toBeUndefined();
    expect(r.body.rag_ingest).toMatchObject({ status: 'page_ingest_queued', target: 'page_library' });
    expect(uploads).toEqual([expect.stringMatching(/^imports\/history\/originals\/[0-9a-f]{64}\.pdf$/)]);
    const job = await finished(w, r.body.rag_ingest.job_id);
    expect(job.state).toBe('done');
    expect(job.sources[0]).toMatchObject({ title: 'Acquired Book', creator: 'B. Writer', units: 2 });
    expect(imports).toHaveLength(1);

    // The book-scale floor still applies.
    const strict = worker({ writer, acquisitionFetch, annas: { apiKey: 'fixture-acquisition-token', baseUrl: 'https://annas.example', booksRoot: join(dir, 'acquired-2'), minPdfPages: 60 } });
    await mkdir(join(dir, 'acquired-2'), { recursive: true });
    const short = await call(strict, 'annas_archive_import', {
      annas_archive_id: 'book-three', title: 'Short Book', author: 'C. Writer', format: 'pdf', approval_id: 'owner-1', copyright_posture: 'owner_library', ingest: true, dry_run: false,
    });
    expect(short.body.rag_ingest.error.code).toBe('annas_artifact_scale_implausible');
  });
});
