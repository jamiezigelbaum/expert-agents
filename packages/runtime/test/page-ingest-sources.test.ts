import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogEntry } from '@expert-agents/library';
import { validateAgentRoutingConfig } from '../src/core/agent-routing.ts';
import { createDomainExpertWorker, type DomainExpertWorkerOptions } from '../src/workers/domain-expert/index.ts';
import type { PageIndexWriter } from '../src/workers/domain-expert/page-ingest.ts';
import type { PageIndexUnit } from '../src/workers/domain-expert/page-index.ts';
import { scanAndFigurePdf } from '../../library/test/pdf-fixture.ts';

// Sources library_ingest fetches itself: web pages, Notion pages, Drive files,
// and audio or video it transcribes locally. Each lands as a book that
// domain_library cites, with its provenance.

let dir: string;
let workspace: string;

const words = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed}${i % 7}`).join(' ');
const ARTICLE = (marker: string) => `<!doctype html><html><head><title>Assemblies of Old</title></head><body>
<nav>Home | About | Subscribe</nav>
<article><h1>Assemblies of Old</h1>
<p>The ${marker} assembly met at dawn on the hill, and every citizen could speak.</p>
<p>${words(200, 'deliberation')}</p></article>
<footer>Copyright notice and links</footer></body></html>`;

/** One second of 16 kHz mono silence: ffmpeg reads it; the router fixture supplies the speech. */
function silentWav(): Uint8Array {
  const samples = 16_000;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16_000, 24); buf.writeUInt32LE(32_000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples * 2, 40);
  return new Uint8Array(buf);
}

// Twenty-four segments of 30 seconds each: twelve minutes of speech.
const SEGMENTS = Array.from({ length: 24 }, (_, i) => ({ start: i * 30, end: i * 30 + 29.5, text: `${i === 13 ? 'The archon read the decree aloud. ' : ''}${words(60, 'spoken')}` }));

function recordingWriter() {
  const imports: Array<{ source: string; units: PageIndexUnit[]; books: readonly string[] }> = [];
  let books: CatalogEntry[] = [];
  const writer: PageIndexWriter = {
    async importUnits(source, units, opts) {
      imports.push({ source, units: [...units], books: opts.books });
      return { units: units.length, inserted: units.length, updated: 0, unchanged: 0, deleted: 0, chunks: units.length, reusedVectors: 0 };
    },
    async embedPending() { return { embedded: 0, tokens: 0 }; },
    async pendingEmbeddings() { return 0; },
    async catalog() { return books; },
    async replaceBooks(_source, entries, opts) { books = [...books.filter((b) => !opts.books.includes(b.book)), ...entries]; return {}; },
  };
  return { imports, writer, books: () => books };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'page-ingest-sources-'));
  workspace = join(dir, 'workspace');
  await mkdir(join(workspace, 'talks'), { recursive: true });
  await writeFile(join(workspace, 'talks', 'speaker---a-public-talk.wav'), silentWav());
});

afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

interface Fixture { page: string; uploads: string[]; transcriptions: string[] }

function worker(fx: Fixture, options: { tree?: string; writer?: PageIndexWriter; routes?: Record<string, unknown>; notion?: boolean; private?: PageIndexWriter } = {}) {
  const pdf = scanAndFigurePdf();
  const google = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://storage.googleapis.com/upload/')) {
      fx.uploads.push(decodeURIComponent(/[?&]name=([^&]+)/.exec(url)![1]!));
      return Response.json({ name: 'ok', generation: '1' });
    }
    if (url.startsWith('https://www.googleapis.com/drive/v3/files/doc-0123456789?fields=')) {
      return Response.json({ id: 'doc-0123456789', name: 'Charter Draft', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://docs.google.com/document/d/doc-0123456789/edit' });
    }
    if (url.startsWith('https://www.googleapis.com/drive/v3/files/doc-0123456789/export?mimeType=application%2Fpdf')) {
      return new Response(new Blob([pdf.slice().buffer as ArrayBuffer]));
    }
    if (url.startsWith('https://www.googleapis.com/drive/v3/files/txt-0123456789?fields=')) {
      return Response.json({ id: 'txt-0123456789', name: 'minutes.txt', mimeType: 'text/plain' });
    }
    if (url.startsWith('https://www.googleapis.com/drive/v3/files/txt-0123456789?alt=media')) {
      return new Response(`# Minutes\n\nThe council adopted the quorum rule.\n\n${words(150, 'minute')}`);
    }
    if (url.startsWith('https://www.googleapis.com/drive/v3/files/dir-0123456789?fields=')) {
      return Response.json({ id: 'dir-0123456789', name: 'Folder', mimeType: 'application/vnd.google-apps.folder' });
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  const router = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/audio/transcriptions')) {
      const form = init!.body as FormData;
      fx.transcriptions.push(String(form.get('model')));
      return Response.json({ text: '', duration: 719.5, segments: SEGMENTS });
    }
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '' } }] });
  }) as unknown as typeof fetch;
  const notionFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    const page = (id: string, title: string) => ({ object: 'page', id, url: `https://www.notion.so/${id}`, properties: { Name: { type: 'title', title: [{ plain_text: title }] } } });
    const para = (text: string) => ({ type: 'paragraph', has_children: false, paragraph: { rich_text: [{ plain_text: text }] } });
    if (path === '/v1/pages/11111111111111111111111111111111') return Response.json(page('11111111111111111111111111111111', 'Constitution Notes'));
    if (path === '/v1/blocks/11111111111111111111111111111111/children') {
      return Response.json({ object: 'list', has_more: false, next_cursor: null, results: [
        { type: 'heading_1', has_children: false, heading_1: { rich_text: [{ plain_text: 'Article One' }] } },
        para(`The assembly holds the power to amend. ${words(500, 'clause')}`),
        { type: 'heading_1', has_children: false, heading_1: { rich_text: [{ plain_text: 'Article Two' }] } },
        para(`Magistrates serve one year. ${words(500, 'term')}`),
      ] });
    }
    if (path === '/v1/databases/33333333333333333333333333333333' && method === 'GET') {
      return Response.json({ object: 'database', id: '33333333333333333333333333333333', title: [{ plain_text: 'Decisions' }] });
    }
    if (path === '/v1/pages/33333333333333333333333333333333') return Response.json({ object: 'error', status: 404 }, { status: 404 });
    if (path === '/v1/databases/33333333333333333333333333333333/query') {
      return Response.json({ object: 'list', has_more: false, next_cursor: null, results: [page('44444444444444444444444444444444', 'Decision A'), page('55555555555555555555555555555555', 'Decision B')] });
    }
    return Response.json({ error: `unexpected ${path}` }, { status: 500 });
  }) as typeof fetch;
  const routes = options.routes ?? { history: {
    library: { bucket: 'neutral-library', prefix: 'factory/history' },
    pageLibrary: options.tree ? { root: options.tree, sourceId: 'history' } : { sourceId: 'history' },
  } };
  const opts: DomainExpertWorkerOptions = {
    dataDir: join(dir, `data-${Math.random().toString(36).slice(2)}`),
    gcpProject: 'neutral-project',
    roots: [{ rootId: 'expert_agents_workspace', path: workspace, maxWriteBytes: 20 * 1024 * 1024, allowOverwrite: false }],
    agentRouting: validateAgentRoutingConfig(routes),
    annas: { importGcsPrefix: 'gs://neutral-acquisitions/imports/' },
    ocrLanes: { routerUrl: 'http://router.invalid/v1', fetch: router, deep: false },
    ...(options.writer ? { pageIndexWriter: options.writer } : {}),
    ...(options.private ? { pageIndexWriters: { private: options.private } } : {}),
    pageSearch: async () => [],
    google: { accessToken: 'synthetic-token', fetchImpl: google },
    resolveHostImpl: async () => ['93.184.216.34'],
    webImportFetchImpl: async (url) => {
      if (url.pathname.endsWith('.pdf')) return new Response(new Blob([pdf.slice().buffer as ArrayBuffer]), { headers: { 'content-type': 'application/pdf' } });
      return new Response(fx.page, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
    ...(options.notion !== false ? { notion: { token: 'fixture-notion-token', fetchImpl: notionFetch } } : {}),
  };
  return createDomainExpertWorker(opts);
}

async function call(w: ReturnType<typeof worker>, tool: string, params: Record<string, unknown>) {
  const response = await w.fetch(new Request('http://worker.test/v1/domain', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool, params: { domain_id: 'history', ...params } }),
  }));
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function ingest(w: ReturnType<typeof worker>, params: Record<string, unknown>) {
  const started = await call(w, 'library_ingest', { action: 'start', dry_run: false, approval_id: 'owner-1', ...params });
  expect(started.body.error).toBeUndefined();
  expect(started.body.status).toBe('queued');
  for (let i = 0; i < 400; i++) {
    const r = await call(w, 'library_ingest', { action: 'status', job_id: started.body.job.job_id });
    if (['done', 'done_with_failures', 'failed'].includes(r.body.job?.state)) return r.body.job;
    await Bun.sleep(25);
  }
  throw new Error('ingest job did not finish');
}

const fixture = (): Fixture => ({ page: ARTICLE('first'), uploads: [], transcriptions: [] });

describe('library_ingest web pages', () => {
  test('a page keeps its main text, URL and retrieval date, and re-ingesting the URL replaces its book', async () => {
    const fx = fixture();
    const tree = join(dir, 'tree-web');
    const { writer } = recordingWriter();
    const w = worker(fx, { tree, writer });

    const dry = await call(w, 'library_ingest', { action: 'start', urls: ['https://example.org/essays/assemblies?utm_source=feed'] });
    expect(dry.body).toMatchObject({ status: 'dry_run', sources: [{ type: 'url', origin: 'url:https://example.org/essays/assemblies' }] });

    const job = await ingest(w, { urls: ['https://example.org/essays/assemblies'] });
    expect(job.state).toBe('done');
    const [source] = job.sources;
    expect(source).toMatchObject({ state: 'parsed', title: 'Assemblies of Old', kind: 'sections', source_url: 'https://example.org/essays/assemblies', origin: 'url:https://example.org/essays/assemblies' });
    expect(source.retrieved_at).toMatch(/^\d{4}-\d\d-\d\dT/);

    const read = await call(w, 'domain_library', { action: 'read', slug: `books/${source.book}/s0001` });
    expect(read.body.cite).toBe('Assemblies of Old, section 1');
    expect(read.body.text).toContain('The first assembly met at dawn');
    // Main text only: the extractor drops navigation and footer, and the front matter is metadata, not text.
    expect(read.body.text).not.toContain('retrieved_at');
    const catalog = await call(w, 'domain_library', { action: 'catalog' });
    expect(catalog.body.books).toEqual([expect.objectContaining({ book: source.book, title: 'Assemblies of Old', source_url: 'https://example.org/essays/assemblies', retrieved_at: source.retrieved_at })]);

    // Unchanged page fetched again: the same book.
    const again = await ingest(w, { urls: ['https://example.org/essays/assemblies'] });
    expect(again.sources[0].book).toBe(source.book);
    // The page changed: a new book replaces the old one.
    fx.page = ARTICLE('second');
    const changed = await ingest(w, { urls: ['https://example.org/essays/assemblies'] });
    expect(changed.sources[0].book).not.toBe(source.book);
    expect(await readdir(join(tree, 'books'))).toEqual([changed.sources[0].book]);
  });

  test('a linked PDF is stored for view_page and read as pages', async () => {
    const fx = fixture();
    const w = worker(fx, { tree: join(dir, 'tree-web-pdf'), writer: recordingWriter().writer });
    const job = await ingest(w, { urls: ['https://example.org/papers/charter.pdf'], title: 'The Charter', creator: 'A. Drafter' });
    expect(job.sources[0]).toMatchObject({ state: 'parsed', kind: 'pages', title: 'The Charter', source_url: 'https://example.org/papers/charter.pdf' });
    expect(fx.uploads).toEqual([expect.stringMatching(/^imports\/history\/originals\/[0-9a-f]{64}\.pdf$/)]);
  });

  test('refuses plain http and Notion URLs at start', async () => {
    const w = worker(fixture(), { tree: join(dir, 'tree-web-refuse'), writer: recordingWriter().writer });
    expect((await call(w, 'library_ingest', { action: 'start', urls: ['http://example.org/a'] })).body.error.code).toBe('web_import_https_required');
    expect((await call(w, 'library_ingest', { action: 'start', urls: ['https://www.notion.so/Page-11111111111111111111111111111111'] })).body.error.code).toBe('notion_requires_api_import');
    expect((await call(w, 'library_ingest', { action: 'start', urls: ['https://example.org/a'], workspace_relative_path: 'talks' })).body.error.code).toBe('invalid_params');
  });

  test('on a route with a private library, a URL goes only where source_id says', async () => {
    const pub = recordingWriter(), priv = recordingWriter();
    const routes = { history: { library: { bucket: 'neutral-library', prefix: 'factory/history' }, pageLibrary: { sourceId: 'history', also: [{ sourceId: 'private-notes', database: 'private' }] } } };
    const w = worker(fixture(), { routes, writer: pub.writer, private: priv.writer });
    expect((await call(w, 'library_ingest', { action: 'start', urls: ['https://example.org/a'] })).body.error.code).toBe('page_ingest_source_required');
    const job = await ingest(w, { urls: ['https://example.org/essays/assemblies'], source_id: 'private-notes' });
    expect(job.state).toBe('done');
    expect(priv.imports.map((i) => i.source)).toEqual(['private-notes']);
    expect(pub.imports).toEqual([]);
    expect(priv.books()).toEqual([expect.objectContaining({ origin: 'url:https://example.org/essays/assemblies' })]);
  });
});

describe('library_ingest Notion', () => {
  test('a page becomes one book whose blocks become sections; a database adds each row page', async () => {
    const fx = fixture();
    const w = worker(fx, { tree: join(dir, 'tree-notion'), writer: recordingWriter().writer });
    const job = await ingest(w, { notion: ['https://www.notion.so/Constitution-Notes-11111111111111111111111111111111'] });
    expect(job.state).toBe('done');
    const [source] = job.sources;
    expect(source).toMatchObject({ title: 'Constitution Notes', kind: 'sections', units: 2, origin: 'notion:11111111111111111111111111111111' });
    const second = await call(w, 'domain_library', { action: 'read', slug: `books/${source.book}/s0002` });
    expect(second.body.text).toStartWith('# Article Two');

    const dry = await call(w, 'library_ingest', { action: 'start', notion: ['33333333333333333333333333333333'] });
    expect(dry.body.sources.map((s: { name: string }) => s.name)).toEqual(['Decision A', 'Decision B']);
  });

  test('without the Notion credential, start says so', async () => {
    const w = worker(fixture(), { tree: join(dir, 'tree-notion-off'), writer: recordingWriter().writer, notion: false });
    const r = await call(w, 'library_ingest', { action: 'start', notion: ['11111111111111111111111111111111'] });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('notion_not_configured');
  });
});

describe('library_ingest Drive', () => {
  test('a Google Doc is exported as PDF pages; a text file is read as sections; a folder is refused', async () => {
    const fx = fixture();
    const w = worker(fx, { tree: join(dir, 'tree-drive'), writer: recordingWriter().writer });
    const job = await ingest(w, { drive_file_ids: ['https://docs.google.com/document/d/doc-0123456789/edit', 'txt-0123456789', 'dir-0123456789'] });
    expect(job.state).toBe('done_with_failures');
    const [doc, txt, folder] = job.sources;
    expect(doc).toMatchObject({ state: 'parsed', kind: 'pages', title: 'Charter Draft', origin: 'drive:doc-0123456789', source_url: 'https://docs.google.com/document/d/doc-0123456789/edit' });
    expect(fx.uploads).toEqual([expect.stringMatching(/^imports\/history\/originals\/[0-9a-f]{64}\.pdf$/)]);
    expect(txt).toMatchObject({ state: 'parsed', kind: 'sections', title: 'minutes' });
    expect(folder.state).toBe('failed');
    expect(folder.error).toContain('folder');
    const read = await call(w, 'domain_library', { action: 'read', slug: `books/${txt.book}/s0001` });
    expect(read.body.text).toContain('quorum rule');
  });
});

describe('library_ingest audio and video', () => {
  test('a recording is transcribed locally into time-ranged sections cited by timestamp', async () => {
    const fx = fixture();
    const w = worker(fx, { tree: join(dir, 'tree-media'), writer: recordingWriter().writer });
    const dry = await call(w, 'library_ingest', { action: 'start', workspace_relative_path: 'talks' });
    expect(dry.body).toMatchObject({ sources: [{ name: 'speaker---a-public-talk.wav' }], lanes: { transcription: true } });

    const job = await ingest(w, { workspace_relative_path: 'talks' });
    expect(job.state).toBe('done');
    const [source] = job.sources;
    expect(source).toMatchObject({ title: 'a public talk', creator: 'speaker', kind: 'sections', parsers: { transcription: source.units }, media: { duration_seconds: 720, segments: 24 } });
    expect(fx.transcriptions).toEqual(['delphi/transcription']);
    expect(source.units).toBeGreaterThan(1);

    const first = await call(w, 'domain_library', { action: 'read', slug: `books/${source.book}/s0001` });
    expect(first.body.cite).toMatch(/^speaker, a public talk, 00:00:00–00:\d\d:\d\d$/);
    expect(first.body.text).toStartWith('[00:00:00] ');
    const grep = await call(w, 'domain_library', { action: 'grep', pattern: 'archon read the decree' });
    expect(grep.body.hits).toEqual([expect.objectContaining({ cite: expect.stringMatching(/, 00:0\d:\d\d–00:\d\d:\d\d$/), line: expect.stringMatching(/^\[00:06:00\] /) })]);

    // Re-ingesting reuses the cached transcript.
    await ingest(w, { workspace_relative_path: 'talks' });
    expect(fx.transcriptions).toHaveLength(1);
  });

  test('without the router, a recording fails with the reason instead of being skipped', async () => {
    const fx = fixture();
    const w = createDomainExpertWorker({
      dataDir: join(dir, 'data-no-router'), gcpProject: 'neutral-project',
      roots: [{ rootId: 'expert_agents_workspace', path: workspace, maxWriteBytes: 20 * 1024 * 1024, allowOverwrite: false }],
      agentRouting: validateAgentRoutingConfig({ history: { library: { bucket: 'neutral-library', prefix: 'factory/history' }, pageLibrary: { root: join(dir, 'tree-media-off'), sourceId: 'history' } } }),
      annas: { importGcsPrefix: 'gs://neutral-acquisitions/imports/' },
      pageIndexWriter: recordingWriter().writer,
      pageSearch: async () => [],
      google: { accessToken: 'synthetic-token', fetchImpl: (async (input: RequestInfo | URL) => {
        fx.uploads.push(String(input));
        return Response.json({ name: 'ok', generation: '1' });
      }) as typeof fetch },
    });
    const job = await ingest(w, { workspace_relative_path: 'talks' });
    expect(job.state).toBe('done_with_failures');
    expect(job.sources[0]).toMatchObject({ state: 'failed', error: expect.stringContaining('transcription_not_configured') });
  });
});
