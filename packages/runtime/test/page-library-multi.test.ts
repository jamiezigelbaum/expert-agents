import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRoutingConfigError, pageLibraryMembers, validateAgentRoutingConfig } from '../src/core/agent-routing.ts';
import { createDomainExpertWorker } from '../src/workers/domain-expert/index.ts';
import { MultiPageStore, type PageLibraryMember } from '../src/workers/domain-expert/page-libraries.ts';
import type { PageIndexWriter } from '../src/workers/domain-expert/page-ingest.ts';
import type { PageSearchHit } from '../src/workers/domain-expert/page-library.ts';
import type { PageCatalogBook, PageStore } from '../src/workers/domain-expert/page-store.ts';
import { scanAndFigurePdf } from '../../library/test/pdf-fixture.ts';

const buckets = ['originals-bucket'];

describe('pageLibrary routing: database and also', () => {
  const base = { sourceId: 'history', originalBuckets: buckets };
  const route = (pageLibrary: unknown, extra: Record<string, unknown> = {}) => validateAgentRoutingConfig({ history: { pageLibrary, ...extra } }).history!;

  test('accept a named database and extra read libraries, primary first', () => {
    const r = route({ ...base, also: [{ sourceId: 'private-notes', database: 'private' }, { sourceId: 'more' }] });
    expect(pageLibraryMembers(r.pageLibrary!)).toEqual([{ sourceId: 'history' }, { sourceId: 'private-notes', database: 'private' }, { sourceId: 'more' }]);
    expect(route({ ...base, database: 'private' }).pageLibrary).toEqual({ ...base, database: 'private' });
    // Absent keys leave the config exactly as before.
    expect(route(base).pageLibrary).toEqual(base);
  });

  test('refuse bad names, duplicates, too many, extra keys, and root with database', () => {
    const bad: unknown[] = [
      { ...base, database: 'Private' }, { ...base, database: '-x' }, { ...base, database: 'a'.repeat(33) }, { ...base, database: 'a_b' },
      { ...base, also: [] },
      { ...base, also: Array.from({ length: 9 }, (_, i) => ({ sourceId: `s${i}` })) },
      { ...base, also: [{ sourceId: 'history' }] },
      { ...base, database: 'p', also: [{ sourceId: 'history', database: 'p' }] },
      { ...base, also: [{ sourceId: 'x' }, { sourceId: 'x' }] },
      { ...base, also: [{ sourceId: 'x', root: '/srv/x' }] },
      { ...base, also: [{ sourceId: 'Bad Id' }] },
      { ...base, also: [{ sourceId: 'x', databaseUrl: 'postgres://u:p@h/db' }] },
      { root: '/srv/pages/history', sourceId: 'history', database: 'private', originalBuckets: buckets },
    ];
    for (const pageLibrary of bad) expect(() => route(pageLibrary)).toThrow(AgentRoutingConfigError);
    // The same source id in a different database is a different library.
    expect(() => route({ ...base, also: [{ sourceId: 'history', database: 'private' }] })).not.toThrow();
  });

  test('a route under a disclosure policy cannot read a named database', () => {
    const disclosure = { corpora: [{ corpusId: 'history', disclosure: 'derived' }] };
    const probe = (pageLibrary: unknown) => validateAgentRoutingConfig({ history: { pageLibrary, disclosure } });
    expect(() => probe({ ...base, database: 'private' })).toThrow(/disclosure policy cannot read a named \(private\) page library/);
    expect(() => probe({ ...base, also: [{ sourceId: 'x', database: 'private' }] })).toThrow(/disclosure policy cannot read a named/);
  });
});

// ---- composite reads -----------------------------------------------------------------------

function book(slug: string, title: string): PageCatalogBook {
  return { book: slug, title, creator: 'A. Author', kind: 'pages', units: 1, first_unit: 'p0001', last_unit: 'p0001', figures: 0 };
}

/** An in-memory library: books by id, one unit each, counting the reads it served. */
function fakeStore(books: Record<string, string>, reads: string[] = []): PageStore {
  return {
    kind: 'database',
    async catalog() { return Object.keys(books).map((b) => book(b, `Title of ${b}`)); },
    async unit(b, unit) { reads.push(`${b}/${unit}`); return books[b] === undefined ? undefined : { body: books[b]!, meta: { source: 'gs://originals-bucket/v1/x.pdf', source_page: 1 } }; },
    async *scan(bs) { for (const b of bs) if (books[b] !== undefined) yield { book: b, unit: 'p0001', body: books[b]! }; },
    async extent(b) { return books[b]?.length ?? 0; },
  };
}

const hit = (b: string, score: number): PageSearchHit => ({ slug: `books/${b}/p0001`, text: `text of ${b}`, score });

describe('MultiPageStore', () => {
  const pub = fakeStore({ 'history-aaaaaa': 'public history text', 'shared-bbbbbb': 'public copy' });
  const priv = fakeStore({ 'notes-cccccc': 'private notes text', 'shared-bbbbbb': 'private copy' });
  const members: PageLibraryMember[] = [
    { sourceId: 'history', store: pub, search: async () => [hit('history-aaaaaa', 0.4), hit('shared-bbbbbb', 0.9)] },
    { sourceId: 'private-notes', database: 'private', store: priv, search: async () => [hit('notes-cccccc', 0.8), hit('shared-bbbbbb', 0.95)] },
  ];
  const multi = new MultiPageStore(members);

  test('unions catalogs; a book id both hold belongs to the first library', async () => {
    expect((await multi.catalog()).map((b) => b.book)).toEqual(['history-aaaaaa', 'shared-bbbbbb', 'notes-cccccc']);
    expect((await multi.unit('shared-bbbbbb', 'p0001'))?.body).toBe('public copy');
    expect((await multi.unit('notes-cccccc', 'p0001'))?.body).toBe('private notes text');
    expect(await multi.unit('missing-dddddd', 'p0001')).toBeUndefined();
    expect(await multi.extent('notes-cccccc')).toBe('private notes text'.length);
  });

  test('scan goes to the owner; search merges by score, drops shadowed books, and cuts to k', async () => {
    const scanned: string[] = [];
    for await (const u of multi.scan(['notes-cccccc', 'shared-bbbbbb'], 'x', 10)) scanned.push(`${u.book}:${u.body}`);
    expect(scanned.sort()).toEqual(['notes-cccccc:private notes text', 'shared-bbbbbb:public copy']);
    expect((await multi.search('q', 10)).map((h) => h.slug)).toEqual(['books/shared-bbbbbb/p0001', 'books/notes-cccccc/p0001', 'books/history-aaaaaa/p0001']);
    expect(await multi.search('q', 2)).toHaveLength(2);
  });
});

describe('domain_library over a route with several libraries', () => {
  const publicBooks = fakeStore({ 'history-aaaaaa': 'public history text' });
  const privateReads: string[] = [];
  const privateBooks = fakeStore({ 'notes-cccccc': 'private notes text' }, privateReads);
  const searched: string[] = [];

  let dataDir: string;
  beforeAll(async () => { dataDir = await mkdtemp(join(tmpdir(), 'page-multi-data-')); });
  afterAll(async () => { await rm(dataDir, { recursive: true, force: true }); });
  const make = (routes: Record<string, unknown>) => {
    const w = createDomainExpertWorker({
      dataDir,agentRouting: validateAgentRoutingConfig(routes),
      pageStore: (sourceId, database) => (database === 'private' ? privateBooks : sourceId === 'history' ? publicBooks : fakeStore({})),
      pageSearch: async (_q, _k, sourceId, database) => {
        searched.push(`${database ?? 'default'}/${sourceId}`);
        return database === 'private' ? [hit('notes-cccccc', 0.9)] : [hit('history-aaaaaa', 0.5)];
      },
      pageIndexStatus: async (sourceId) => ({ units: sourceId === 'history' ? 1 : 2, chunks: 1, pending_embeddings: 0 }),
      google: { accessToken: 'synthetic-token', fetchImpl: (async () => { throw new Error('no network'); }) as unknown as typeof fetch },
    });
    const call = async (tool: string, params: Record<string, unknown>) => {
      const r = await w.fetch(new Request('http://worker.test/v1/domain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool, params: { domain_id: 'history', ...params } }) }));
      return { status: r.status, body: await r.json() as Record<string, any> };
    };
    const health = async () => (await (await w.fetch(new Request('http://worker.test/v1/health'))).json() as Record<string, any>).page_library;
    return { w, call, health };
  };
  const both = { history: { pageLibrary: { sourceId: 'history', originalBuckets: buckets, also: [{ sourceId: 'private-notes', database: 'private' }] } } };
  const publicOnly = { history: { pageLibrary: { sourceId: 'history', originalBuckets: buckets } } };

  test('catalog, read and search span both libraries; the single-library route sees only its own', async () => {
    const m = make(both);
    expect((await m.call('domain_library', { action: 'catalog' })).body.books.map((b: { book: string }) => b.book)).toEqual(['history-aaaaaa', 'notes-cccccc']);
    expect((await m.call('domain_library', { action: 'read', slug: 'books/notes-cccccc/p0001' })).body.text).toBe('private notes text');
    searched.length = 0;
    const found = await m.call('domain_library', { action: 'search', query: 'q' });
    expect(found.body.results.map((r: { slug: string }) => r.slug)).toEqual(['books/notes-cccccc/p0001', 'books/history-aaaaaa/p0001']);
    expect(found.body.results[0].cite).toBe('A. Author, Title of notes-cccccc, p.1');
    expect(searched.sort()).toEqual(['default/history', 'private/private-notes']);
    expect((await m.call('domain_library', { action: 'grep', pattern: 'private' })).body.hits.map((h: { slug: string }) => h.slug)).toEqual(['books/notes-cccccc/p0001']);

    // A route naming only the default database never reaches the private one.
    privateReads.length = 0; searched.length = 0;
    const solo = make(publicOnly);
    expect((await solo.call('domain_library', { action: 'catalog' })).body.books.map((b: { book: string }) => b.book)).toEqual(['history-aaaaaa']);
    expect((await solo.call('domain_library', { action: 'read', slug: 'books/notes-cccccc/p0001' })).body.error.code).toBe('page_library_unknown_book');
    await solo.call('domain_library', { action: 'search', query: 'q' });
    expect(searched).toEqual(['default/history']);
    expect(privateReads).toEqual([]);
  });

  test('health lists each library without any URL', async () => {
    const h = await make(both).health();
    expect(h.domains[0]).toMatchObject({
      source_id: 'history', catalog: 'ready', books: 1,
      libraries: [
        { source_id: 'history', database: 'default', catalog: 'ready', books: 1 },
        { source_id: 'private-notes', database: 'private', catalog: 'ready', books: 1 },
      ],
    });
    expect(JSON.stringify(h)).not.toMatch(/postgres(ql)?:\/\//);
  });
});

// ---- ingest target ---------------------------------------------------------------------------

describe('library_ingest source_id on a route with several libraries', () => {
  let dir: string;
  let workspace: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'page-multi-ingest-'));
    workspace = join(dir, 'workspace');
    await mkdir(join(workspace, 'inbox'), { recursive: true });
    await writeFile(join(workspace, 'inbox', 'author---a-sample-book.pdf'), scanAndFigurePdf());
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  function recording() {
    const sources: string[] = [];
    const writer: PageIndexWriter = {
      async importUnits(source, units) { sources.push(source); return { units: units.length, inserted: units.length, updated: 0, unchanged: 0, deleted: 0, chunks: units.length, reusedVectors: 0 }; },
      async embedPending() { return { embedded: 0, tokens: 0 }; },
      async pendingEmbeddings() { return 0; },
      async catalog() { return []; },
      async replaceBooks() { return {}; },
    };
    return { sources, writer };
  }
  const ocrFetch = (async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'A scanned page read by the local OCR lane, with enough words to stand on its own as text.' } }] })) as unknown as typeof fetch;

  function make(routes: Record<string, unknown>, writers: { default?: PageIndexWriter; private?: PageIndexWriter }) {
    const w = createDomainExpertWorker({
      dataDir: join(dir, `data-${Math.random().toString(36).slice(2)}`),
      roots: [{ rootId: 'expert_agents_workspace', path: workspace, maxWriteBytes: 20 * 1024 * 1024, allowOverwrite: false }],
      agentRouting: validateAgentRoutingConfig(routes),
      annas: { importGcsPrefix: 'gs://neutral-acquisitions/imports/' },
      ocrLanes: { routerUrl: 'http://router.invalid/v1', fetch: ocrFetch },
      ...(writers.default ? { pageIndexWriter: writers.default } : {}),
      ...(writers.private ? { pageIndexWriters: { private: writers.private } } : {}),
      pageSearch: async () => [],
      google: { accessToken: 'synthetic-token', fetchImpl: (async (input: RequestInfo | URL) => {
        if (String(input).startsWith('https://storage.googleapis.com/upload/')) return Response.json({ name: 'ok', generation: '1' });
        throw new Error('unexpected request');
      }) as typeof fetch },
    });
    return async (tool: string, params: Record<string, unknown>) => {
      const r = await w.fetch(new Request('http://worker.test/v1/domain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool, params: { domain_id: 'history', ...params } }) }));
      return { status: r.status, body: await r.json() as Record<string, any> };
    };
  }
  type Call = ReturnType<typeof make>;
  async function finished(call: Call, jobId: string) {
    for (let i = 0; i < 200; i++) {
      const r = await call('library_ingest', { action: 'status', job_id: jobId });
      if (['done', 'done_with_failures', 'failed'].includes(r.body.job?.state)) return r.body.job;
      await Bun.sleep(25);
    }
    throw new Error('ingest job did not finish');
  }
  const library = { bucket: 'neutral-library', prefix: 'factory/history' };
  const multi = { history: { library, pageLibrary: { sourceId: 'history', also: [{ sourceId: 'private-notes', database: 'private' }] } } };
  const start = { action: 'start', workspace_relative_path: 'inbox', dry_run: false, approval_id: 'owner-1' };

  test('is required for start, even as a dry run, and must name one of the route libraries', async () => {
    const call = make(multi, { default: recording().writer, private: recording().writer });
    const missing = await call('library_ingest', { action: 'start', workspace_relative_path: 'inbox' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('page_ingest_source_required');
    expect((await call('library_ingest', { ...start })).body.error.code).toBe('page_ingest_source_required');
    expect((await call('library_ingest', { ...start, source_id: 'elsewhere' })).body.error.code).toBe('page_ingest_source_unknown');
    // status and list need no source.
    expect((await call('library_ingest', { action: 'list' })).status).toBe(200);
    const dry = await call('library_ingest', { action: 'start', workspace_relative_path: 'inbox', source_id: 'private-notes' });
    expect(dry.body).toMatchObject({ status: 'dry_run', source_id: 'private-notes', index_writer_configured: true });
  });

  test('a job writes through the writer of the library it names, and a missing writer fails before queuing', async () => {
    const pub = recording(), priv = recording();
    const call = make(multi, { default: pub.writer, private: priv.writer });
    const queued = await call('library_ingest', { ...start, source_id: 'private-notes' });
    expect(queued.body.status).toBe('queued');
    expect(queued.body.job.source_id).toBe('private-notes');
    await finished(call, queued.body.job.job_id);
    expect(priv.sources).toEqual(['private-notes']);
    expect(pub.sources).toEqual([]);

    const pubJob = await call('library_ingest', { ...start, source_id: 'history' });
    await finished(call, pubJob.body.job.job_id);
    expect(pub.sources).toEqual(['history']);

    const noPrivate = make(multi, { default: recording().writer });
    const dry = await noPrivate('library_ingest', { action: 'start', workspace_relative_path: 'inbox', source_id: 'private-notes' });
    expect(dry.body.index_writer_configured).toBe(false);
    const refused = await noPrivate('library_ingest', { ...start, source_id: 'private-notes' });
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('page_ingest_writer_not_configured');
  });

  test('a named database finds its writer through the upper-cased environment variable', async () => {
    const name = 'EXPERT_AGENTS_DOMAIN_EXPERT_PAGE_LIBRARY_WRITER_DATABASE_URL_PRIVATE_SHELF';
    const routes = { history: { library, pageLibrary: { sourceId: 'history', also: [{ sourceId: 'private-notes', database: 'private-shelf' }] } } };
    const dry = { action: 'start', workspace_relative_path: 'inbox', source_id: 'private-notes' };
    const call = make(routes, { default: recording().writer });
    expect((await call('library_ingest', dry)).body.index_writer_configured).toBe(false);
    process.env[name] = 'postgres://writer:secret@127.0.0.1:1/private';
    try {
      // The Voyage key is the other half of "configured"; a writer URL alone is not enough.
      expect((await make(routes, { default: recording().writer })('library_ingest', dry)).body.index_writer_configured).toBe(false);
      const w = createDomainExpertWorker({
        dataDir: join(dir, 'env'),voyageApiKey: 'synthetic-key',
        roots: [{ rootId: 'expert_agents_workspace', path: workspace, maxWriteBytes: 20 * 1024 * 1024, allowOverwrite: false }],
        agentRouting: validateAgentRoutingConfig(routes), pageSearch: async () => [],
        google: { accessToken: 'synthetic-token', fetchImpl: (async () => { throw new Error('no network'); }) as unknown as typeof fetch },
      });
      const r = await w.fetch(new Request('http://worker.test/v1/domain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'library_ingest', params: { domain_id: 'history', ...dry } }) }));
      const body = await r.json() as Record<string, any>;
      expect(body.index_writer_configured).toBe(true);
      expect(JSON.stringify(body)).not.toMatch(/postgres|writer:/);
    } finally { delete process.env[name]; }
  });

  test('a single-library route takes no source_id, or its own', async () => {
    const one = recording();
    const call = make({ history: { library, pageLibrary: { sourceId: 'history' } } }, { default: one.writer });
    const queued = await call('library_ingest', start);
    expect(queued.body.status).toBe('queued');
    await finished(call, queued.body.job.job_id);
    const again = await call('library_ingest', { ...start, source_id: 'history' });
    expect(again.body.status).toBe('queued');
    await finished(call, again.body.job.job_id);
    expect((await call('library_ingest', { ...start, source_id: 'other' })).body.error.code).toBe('page_ingest_source_unknown');
  });

  test('annas_archive_import with ingest follows the same rule', async () => {
    const call = make(multi, { default: recording().writer, private: recording().writer });
    const params = { annas_archive_id: 'fixture-item', format: 'pdf', copyright_posture: 'public-domain', ingest: true };
    expect((await call('annas_archive_import', params)).body.error.code).toBe('page_ingest_source_required');
    expect((await call('annas_archive_import', { ...params, source_id: 'nope' })).body.error.code).toBe('page_ingest_source_unknown');
    const ok = await call('annas_archive_import', { ...params, source_id: 'private-notes' });
    expect(ok.body.error?.code).toBeUndefined();
  });
});
