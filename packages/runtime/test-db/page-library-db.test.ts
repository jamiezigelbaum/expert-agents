// The page library kept in Postgres, against a real database (docs/page-library.md).
// Run with `bun run test:db`; PAGE_LIBRARY_TEST_DATABASE_URL names a Postgres with pgvector
// whose user may create databases. Each run makes its own databases and drops them.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';
import { validateAgentRoutingConfig, type AgentRoutingConfig } from '../src/core/agent-routing.ts';
import { createDomainExpertWorker } from '../src/workers/domain-expert/index.ts';
import { PageIndex, PAGE_INDEX_DIMENSIONS, voyageClient } from '../src/workers/domain-expert/page-index.ts';
import { PageLibrary } from '../src/workers/domain-expert/page-library.ts';
import { DatabasePageStore, postgresLinePattern } from '../src/workers/domain-expert/page-store.ts';
import { renderUnitMarkdown, upsertCatalog } from '@expert-agents/library';
import { scanAndFigurePdf } from '../../library/test/pdf-fixture.ts';
import { main as pageIndexCli } from '../../../scripts/page-index.ts';

const ADMIN_URL = process.env.PAGE_LIBRARY_TEST_DATABASE_URL;
if (!ADMIN_URL) throw new Error('PAGE_LIBRARY_TEST_DATABASE_URL must name a Postgres with pgvector whose user may create databases.');

const run = randomSuffix();
const PUBLIC_DB = `pl_public_${run}`;
const PRIVATE_DB = `pl_private_${run}`;
const SOURCE = 'shared-pages';
const scanText = 'Chapter Two. A scanned page read by the local OCR lane, with more than enough words and letters to stand on its own as the text of the page.';
const figureReply = JSON.stringify({ figures: [{ label: 'Figure 1', caption: 'The four quadrants of the map.', description: 'A square divided into four labelled quadrants.' }] });

let admin: SQL;
let dir: string;

function randomSuffix(): string { return Math.random().toString(36).slice(2, 10); }
function databaseUrl(name: string): string { const u = new URL(ADMIN_URL!); u.pathname = `/${name}`; return u.toString(); }

// Voyage stand-in: bag-of-words vectors and an overlap rerank, so search runs both arms for real.
function words(text: string): string[] { return text.toLowerCase().match(/[a-z]{3,}/g) ?? []; }
function vector(text: string): number[] {
  const v = new Array<number>(PAGE_INDEX_DIMENSIONS).fill(0);
  for (const w of words(text)) v[createHash('sha256').update(w).digest().readUInt16BE(0) % PAGE_INDEX_DIMENSIONS]! += 1;
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}
const voyageFetch = (async (url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body));
  if (String(url).endsWith('/embeddings')) {
    return Response.json({ data: (body.input as string[]).map((t, index) => ({ index, embedding: vector(t) })), usage: { total_tokens: 1 } });
  }
  const q = new Set(words(body.query));
  const scored = (body.documents as string[]).map((d, index) => ({ index, relevance_score: words(d).filter((w) => q.has(w)).length }));
  return Response.json({ data: scored.sort((a, b) => b.relevance_score - a.relevance_score).slice(0, body.top_k), usage: { total_tokens: 1 } });
}) as unknown as typeof fetch;

// The model router: the OCR profile reads scans, the deep profile describes figures.
const ocrFetch = (async (_url: string, init: RequestInit) => {
  const profile = JSON.parse(String(init.body)).model;
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: profile === 'delphi/vision-quality' ? scanText : figureReply } }] });
}) as unknown as typeof fetch;

const library = { bucket: 'neutral-library', prefix: 'factory/shared' };
const BOUNDS = { maxQuoteChars: 40, maxQuotesPerSource: 1, maxSourceCoveragePerSession: 0.9 };

function worker(db: string, routes: Record<string, unknown>, downloads: string[] = [], extra: Record<string, unknown> = {}) {
  const pdf = scanAndFigurePdf();
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://storage.googleapis.com/upload/')) return Response.json({ name: 'ok', generation: '1' });
    if (url.startsWith('https://storage.googleapis.com/storage/v1/b/')) { downloads.push(url); return new Response(new Blob([pdf.slice().buffer as ArrayBuffer])); }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  // Every worker gets its own data directory: nothing it serves may come from local files.
  const instance = createDomainExpertWorker({
    dataDir: join(dir, `data-${randomSuffix()}`),
    roots: [{ rootId: 'expert_agents_workspace', path: join(dir, 'workspace'), maxWriteBytes: 20 * 1024 * 1024, allowOverwrite: false }],
    agentRouting: validateAgentRoutingConfig(routes) as AgentRoutingConfig,
    annas: { importGcsPrefix: 'gs://neutral-acquisitions/imports/' },
    ocrLanes: { routerUrl: 'http://router.invalid/v1', fetch: ocrFetch },
    pageIndexDatabaseUrl: databaseUrl(db),
    pageIndexWriterDatabaseUrl: databaseUrl(db),
    voyageApiKey: 'synthetic-key',
    voyageFetch,
    ...extra,
    google: { accessToken: 'synthetic-token', fetchImpl },
  });
  return async (domainId: string, tool: string, params: Record<string, unknown>) => {
    const response = await instance.fetch(new Request('http://worker.test/v1/domain', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool, params: { domain_id: domainId, ...params } }),
    }));
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
}

async function finished(call: ReturnType<typeof worker>, domainId: string, jobId: string) {
  for (let i = 0; i < 400; i++) {
    const r = await call(domainId, 'library_ingest', { action: 'status', job_id: jobId });
    if (['done', 'done_with_failures', 'failed'].includes(r.body.job?.state)) return r.body.job;
    await Bun.sleep(25);
  }
  throw new Error('ingest job did not finish');
}

beforeAll(async () => {
  admin = new SQL({ url: ADMIN_URL, max: 1 });
  for (const db of [PUBLIC_DB, PRIVATE_DB]) {
    await admin.unsafe(`CREATE DATABASE ${db}`);
    const index = new PageIndex(databaseUrl(db), voyageClient('synthetic-key', { fetch: voyageFetch }));
    await index.migrate();
    await index.migrate(); // migrations are idempotent
    await index.close();
  }
  dir = await mkdtemp(join(tmpdir(), 'page-library-db-'));
  await mkdir(join(dir, 'workspace', 'inbox'), { recursive: true });
  await writeFile(join(dir, 'workspace', 'inbox', 'author---a-sample-book.pdf'), scanAndFigurePdf());
});

afterAll(async () => {
  for (const db of [PUBLIC_DB, PRIVATE_DB]) await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin.close();
  await rm(dir, { recursive: true, force: true });
});

describe('a page library kept in the database', () => {
  let book = '';

  test('ingest writes units and catalog to the database and leaves no tree behind', async () => {
    const owner = worker(PUBLIC_DB, { owner: { library, pageLibrary: { sourceId: SOURCE } } });
    const started = await owner('owner', 'library_ingest', { action: 'start', workspace_relative_path: 'inbox/author---a-sample-book.pdf', dry_run: false, approval_id: 'owner-1' });
    expect(started.status).toBe(200);
    const job = await finished(owner, 'owner', started.body.job.job_id);
    expect(job.state).toBe('done');
    expect(job.index).toMatchObject({ units: 3, inserted: 3, embedded: 3, pending_embeddings: 0 });
    book = job.sources[0].book;

    const sql = new SQL({ url: databaseUrl(PUBLIC_DB), max: 1 });
    const [catalog] = await sql`SELECT entry FROM page_books WHERE source = ${SOURCE}` as Array<{ entry: Record<string, unknown> }>;
    expect(catalog!.entry).toMatchObject({ book, title: 'a sample book', creator: 'author', units: 2, figures: 1 });
    const [unit] = await sql`SELECT meta FROM page_units WHERE source = ${SOURCE} AND slug = ${`books/${book}/p0002`}` as Array<{ meta: Record<string, unknown> }>;
    expect(unit!.meta).toMatchObject({ source_page: 2, source: expect.stringMatching(/^gs:\/\/neutral-acquisitions\/imports\/owner\/originals\/[0-9a-f]{64}\.pdf$/) });
    await sql.close();
    // The staging tree is removed with the job: the database is the only copy.
    const stagingRoots = await readdir(dir);
    for (const d of stagingRoots.filter((d) => d.startsWith('data-'))) {
      expect(await readdir(join(dir, d, 'page-ingest', 'owner', 'staging')).catch(() => [])).toEqual([]);
    }

    // Re-ingesting under a new title replaces the book in units and catalog alike.
    const again = await owner('owner', 'library_ingest', { action: 'start', workspace_relative_path: 'inbox/author---a-sample-book.pdf', dry_run: false, approval_id: 'owner-1', title: 'The Sample Book, Revised', creator: 'A. Author' });
    const second = await finished(owner, 'owner', again.body.job.job_id);
    expect(second.state).toBe('done');
    const catalogAfter = await owner('owner', 'domain_library', { action: 'catalog' });
    expect(catalogAfter.body.books).toEqual([expect.objectContaining({ book: second.sources[0].book, title: 'The Sample Book, Revised' })]);
    book = second.sources[0].book;
  });

  test('two routes share one library: one unbounded, one under disclosure bounds, on a worker with no local files', async () => {
    const downloads: string[] = [];
    const serve = worker(PUBLIC_DB, {
      owner: { library, pageLibrary: { sourceId: SOURCE, originalBuckets: ['neutral-acquisitions'] } },
      served: { library, pageLibrary: { sourceId: SOURCE, originalBuckets: ['neutral-acquisitions'] }, disclosure: { bounds: BOUNDS } },
    }, downloads);

    const full = await serve('owner', 'domain_library', { action: 'read', slug: `books/${book}/p0002` });
    expect(full.body).toMatchObject({ cite: 'A. Author, The Sample Book, Revised, p.2', text: scanText, truncated: false });
    const hits = await serve('owner', 'domain_library', { action: 'search', query: 'scanned page local OCR lane' });
    expect(hits.body.results[0]).toMatchObject({ slug: `books/${book}/p0002`, source_uri: expect.stringMatching(/^gs:\/\/neutral-acquisitions\//) });
    // grep reads per line: ^ anchors a line, not the unit; \b is a word boundary.
    const grep = await serve('owner', 'domain_library', { action: 'grep', pattern: '^chapter two\\b' });
    expect(grep.body.hits).toEqual([expect.objectContaining({ slug: `books/${book}/p0002` })]);
    // A pattern Postgres cannot read is still answered.
    const named = await serve('owner', 'domain_library', { action: 'grep', pattern: '(?<word>scanned) page' });
    expect(named.body.hits.map((h: { slug: string }) => h.slug)).toEqual([`books/${book}/p0002`]);
    const range = await serve('owner', 'domain_library', { action: 'read_range', book, from_unit: 'p0001', to_unit: 'p0002' });
    expect(range.body.units).toEqual([`books/${book}/p0001`, `books/${book}/p0002`]);
    const view = await serve('owner', 'domain_library', { action: 'view_page', slug: `books/${book}/p0002` });
    expect(view.body.image.mime_type).toBe('image/jpeg');
    expect(downloads.some((u) => u.includes('/b/neutral-acquisitions/'))).toBe(true);

    expect((await serve('served', 'domain_library', { action: 'read', slug: `books/${book}/p0002` })).body.error.code).toBe('disclosure_session_required');
    const bounded = await serve('served', 'domain_library', { action: 'read', slug: `books/${book}/p0002`, session_id: 's1' });
    expect(bounded.status).toBe(200);
    expect(bounded.body.text.length).toBeLessThanOrEqual(BOUNDS.maxQuoteChars);
    const boundedRange = await serve('served', 'domain_library', { action: 'read_range', book, from_unit: 'p0001', to_unit: 'p0002', session_id: 's2' });
    expect(boundedRange.body.units).toHaveLength(BOUNDS.maxQuotesPerSource);

    const health = await (await createDomainExpertWorker({
      dataDir: join(dir, `data-${randomSuffix()}`),
      agentRouting: validateAgentRoutingConfig({ served: { library, pageLibrary: { sourceId: SOURCE } } }) as AgentRoutingConfig,
      pageIndexDatabaseUrl: databaseUrl(PUBLIC_DB), voyageApiKey: 'synthetic-key', voyageFetch,
      google: { accessToken: 'synthetic-token', fetchImpl: (async () => { throw new Error('no network'); }) as unknown as typeof fetch },
    }).fetch(new Request('http://worker.test/v1/health'))).json() as Record<string, any>;
    expect(health.page_library.domains).toEqual([expect.objectContaining({ domain_id: 'served', store: 'database', catalog: 'ready', books: 1, index: expect.objectContaining({ status: 'ready', units: 3 }) })]);
  });

  test('a private library lives in its own database: a public worker cannot reach it, even under the same source id', async () => {
    const privateIndex = new PageIndex(databaseUrl(PRIVATE_DB), voyageClient('synthetic-key', { fetch: voyageFetch }));
    await privateIndex.importUnits(SOURCE, [{ slug: 'books/minutes-aaaaaa/s0001', book: 'minutes-aaaaaa', unit: 's0001', title: 'Board minutes', body: 'Confidential governance minutes.', meta: {} }]);
    await privateIndex.replaceBooks(SOURCE, [{ book: 'minutes-aaaaaa', title: 'Board minutes', creator: '', kind: 'sections', units: 1, first_unit: 's0001', last_unit: 's0001', figures: 0, objects: [], sources: [] }]);
    await privateIndex.close();

    const privateWorker = worker(PRIVATE_DB, { governance: { library, pageLibrary: { sourceId: SOURCE } } });
    const publicWorker = worker(PUBLIC_DB, { governance: { library, pageLibrary: { sourceId: SOURCE } } });
    expect((await privateWorker('governance', 'domain_library', { action: 'catalog' })).body.books.map((b: { book: string }) => b.book)).toEqual(['minutes-aaaaaa']);
    expect((await publicWorker('governance', 'domain_library', { action: 'catalog' })).body.books.map((b: { book: string }) => b.book)).toEqual([book]);
    expect((await publicWorker('governance', 'domain_library', { action: 'grep', pattern: 'Confidential' })).body.hits).toEqual([]);
    expect((await publicWorker('governance', 'domain_library', { action: 'read', slug: 'books/minutes-aaaaaa/s0001' })).body.error.code).toBe('page_library_unknown_book');
  });
});

describe('one route reading two databases', () => {
  const NOTES = 'private-notes';
  const both = { governance: { library, pageLibrary: { sourceId: SOURCE, also: [{ sourceId: NOTES, database: 'private' }] } } };
  // The private database is known to the worker only through its named URLs.
  const named = { pageLibraryDatabaseUrls: { private: databaseUrl(PRIVATE_DB) }, pageLibraryWriterDatabaseUrls: { private: databaseUrl(PRIVATE_DB) } };

  test('reads span both, a single-database route sees only its own, and ingest lands in the database of the named library', async () => {
    const privateIndex = new PageIndex(databaseUrl(PRIVATE_DB), voyageClient('synthetic-key', { fetch: voyageFetch }));
    await privateIndex.importUnits(NOTES, [{ slug: 'books/ledger-bbbbbb/s0001', book: 'ledger-bbbbbb', unit: 's0001', title: 'Ledger', body: 'Confidential treasury ledger entries.', meta: {} }]);
    await privateIndex.replaceBooks(NOTES, [{ book: 'ledger-bbbbbb', title: 'Ledger', creator: '', kind: 'sections', units: 1, first_unit: 's0001', last_unit: 's0001', figures: 0, objects: [], sources: [] }]);
    await privateIndex.embedPending(NOTES);
    await privateIndex.close();

    const call = worker(PUBLIC_DB, both, [], named);
    const books = (await call('governance', 'domain_library', { action: 'catalog' })).body.books.map((b: { book: string }) => b.book);
    expect(books).toHaveLength(2);
    expect(books).toContain('ledger-bbbbbb');
    expect((await call('governance', 'domain_library', { action: 'read', slug: 'books/ledger-bbbbbb/s0001' })).body.text).toBe('Confidential treasury ledger entries.');
    const found = await call('governance', 'domain_library', { action: 'search', query: 'confidential treasury ledger' });
    expect(found.body.results[0].slug).toBe('books/ledger-bbbbbb/s0001');
    expect((await call('governance', 'domain_library', { action: 'grep', pattern: 'treasury' })).body.hits.map((h: { slug: string }) => h.slug)).toEqual(['books/ledger-bbbbbb/s0001']);
    const health = await (await createDomainExpertWorker({
      dataDir: join(dir, `data-${randomSuffix()}`),
      agentRouting: validateAgentRoutingConfig(both) as AgentRoutingConfig,
      pageIndexDatabaseUrl: databaseUrl(PUBLIC_DB), ...named, voyageApiKey: 'synthetic-key', voyageFetch,
      google: { accessToken: 'synthetic-token', fetchImpl: (async () => { throw new Error('no network'); }) as unknown as typeof fetch },
    }).fetch(new Request('http://worker.test/v1/health'))).json() as Record<string, any>;
    expect(health.page_library.domains[0].libraries).toEqual([
      { source_id: SOURCE, database: 'default', catalog: 'ready', books: 1 },
      { source_id: NOTES, database: 'private', catalog: 'ready', books: 1 },
    ]);

    // The same route without the named database cannot see the private book.
    const solo = worker(PUBLIC_DB, { governance: { library, pageLibrary: { sourceId: SOURCE } } }, [], named);
    expect((await solo('governance', 'domain_library', { action: 'read', slug: 'books/ledger-bbbbbb/s0001' })).body.error.code).toBe('page_library_unknown_book');
    expect((await solo('governance', 'domain_library', { action: 'grep', pattern: 'treasury' })).body.hits).toEqual([]);

    // Ingest needs a source_id and writes through that library's database.
    const sql = (db: string) => new SQL({ url: databaseUrl(db), max: 1 });
    const count = async (db: string, source: string) => { const c = sql(db); try { const [r] = await c`SELECT count(*)::int AS n FROM page_books WHERE source = ${source}` as Array<{ n: number }>; return r!.n; } finally { await c.close(); } };
    const start = { action: 'start', workspace_relative_path: 'inbox/author---a-sample-book.pdf', dry_run: false, approval_id: 'owner-1' };
    expect((await call('governance', 'library_ingest', start)).body.error.code).toBe('page_ingest_source_required');
    const queued = await call('governance', 'library_ingest', { ...start, source_id: NOTES });
    expect(queued.status).toBe(200);
    expect((await finished(call, 'governance', queued.body.job.job_id)).state).toBe('done');
    expect(await count(PRIVATE_DB, NOTES)).toBe(2);
    expect(await count(PUBLIC_DB, NOTES)).toBe(0);
    expect(await count(PUBLIC_DB, SOURCE)).toBe(1);
  });
});

describe('the database page store', () => {
  test('meta-only changes are stored without re-chunking, and a book replaced in the catalog is gone from it', async () => {
    const index = new PageIndex(databaseUrl(PUBLIC_DB), voyageClient('synthetic-key', { fetch: voyageFetch }));
    const unit = { slug: 'books/meta-bbbbbb/p0001', book: 'meta-bbbbbb', unit: 'p0001', title: 'M', body: 'Body text.' };
    await index.importUnits('meta-src', [{ ...unit, meta: { source_page: 1 } }]);
    const again = await index.importUnits('meta-src', [{ ...unit, meta: { source_page: 7 } }]);
    expect(again).toMatchObject({ unchanged: 1, updated: 0, chunks: 0 });
    const store = new DatabasePageStore(index.sql, 'meta-src');
    expect((await store.unit('meta-bbbbbb', 'p0001'))?.meta).toEqual({ source_page: 7 });
    expect(await store.extent('meta-bbbbbb')).toBe('Body text.'.length);

    const entry = (b: string) => ({ book: b, title: b, creator: '', kind: 'pages' as const, units: 1, first_unit: 'p0001', last_unit: 'p0001', figures: 0, objects: [], sources: [] });
    await index.replaceBooks('meta-src', [entry('a-cccccc'), entry('b-cccccc')]);
    expect(await index.replaceBooks('meta-src', [entry('c-cccccc')], { books: ['a-cccccc', 'c-cccccc'] })).toEqual({ books: 1, removed: 1 });
    expect((await store.catalog()).map((b) => b.book)).toEqual(['b-cccccc', 'c-cccccc']);
    const lib = new PageLibrary({ sourceId: 'meta-src', originalBuckets: [] }, { store, search: async () => [], download: async () => null });
    expect((await lib.catalog()).total).toBe(2);
    await index.close();
  });

  test('a long section of many chunks comes back once, whole, from the chunk that matched', async () => {
    const index = new PageIndex(databaseUrl(PUBLIC_DB), voyageClient('synthetic-key', { fetch: voyageFetch }));
    const filler = Array.from({ length: 4000 }, (_, i) => `filler${String.fromCharCode(97 + (i % 26))}`).join(' ');
    const body = `${filler} the lantern keeper walks the harbour wall at dusk ${filler}`;
    await index.importUnits('long-src', [{ slug: 'books/long-eeeeee/s0001', book: 'long-eeeeee', unit: 's0001', title: 'Long', body }]);
    const [{ chunks }] = await index.sql`SELECT count(*)::int AS chunks FROM page_chunks WHERE source = 'long-src'` as Array<{ chunks: number }>;
    expect(chunks).toBeGreaterThan(10);
    const hits = await index.search('long-src', 'lantern keeper harbour', 5);
    expect(hits.map((h) => h.slug)).toEqual(['books/long-eeeeee/s0001']);
    expect(hits[0]!.text).toBe(body);
    await index.close();
  });

  test('JavaScript word boundaries become Postgres ones; escaped backslashes are left alone', () => {
    expect(postgresLinePattern('\\bword\\B')).toBe('(?n)\\yword\\Y');
    expect(postgresLinePattern('a\\\\b')).toBe('(?n)a\\\\b');
  });

  test('the operator CLI imports a tree from another host, catalog included, and grants the serving and ingest roles', async () => {
    const tree = join(dir, 'cli-tree');
    await mkdir(join(tree, 'books', 'remote-dddddd'), { recursive: true });
    await writeFile(join(tree, 'books', 'remote-dddddd', 'p0001.md'), renderUnitMarkdown({ title: 'R. Writer, Remote — p.1', book: 'remote-dddddd', unit: 'p0001', source: 'gs://neutral-library/remote.pdf', source_page: 1 }, 'Parsed on another host.'));
    await upsertCatalog(tree, [{ book: 'remote-dddddd', title: 'Remote', creator: 'R. Writer', kind: 'pages', units: 1, first_unit: 'p0001', last_unit: 'p0001', figures: 0, objects: [], sources: ['gs://neutral-library/remote.pdf'] }]);
    const reader = `pl_reader_${run}`, writer = `pl_writer_${run}`;
    await admin.unsafe(`CREATE ROLE ${reader}; CREATE ROLE ${writer}`);
    const previous = process.env.PAGE_INDEX_DATABASE_URL;
    process.env.PAGE_INDEX_DATABASE_URL = databaseUrl(PUBLIC_DB);
    try {
      await pageIndexCli(['migrate', '--reader', reader, '--writer', writer]);
      await pageIndexCli(['import', '--source', 'cli-src', '--tree', tree, '--books', 'remote-dddddd']);
      await pageIndexCli(['import', '--source', 'cli-src', '--tree', tree, '--books', 'remote-dddddd']);
    } finally {
      if (previous === undefined) delete process.env.PAGE_INDEX_DATABASE_URL; else process.env.PAGE_INDEX_DATABASE_URL = previous;
    }
    const sql = new SQL({ url: databaseUrl(PUBLIC_DB), max: 1 });
    try {
      const store = new DatabasePageStore(sql, 'cli-src');
      expect((await store.catalog()).map((b) => b.book)).toEqual(['remote-dddddd']);
      expect(await store.unit('remote-dddddd', 'p0001')).toEqual({ body: 'Parsed on another host.', meta: expect.objectContaining({ source_page: 1, source: 'gs://neutral-library/remote.pdf' }) });
      const [privileges] = await sql`SELECT has_table_privilege(${reader}, 'page_books', 'SELECT') AS reads, has_table_privilege(${reader}, 'page_books', 'INSERT') AS reader_writes,
        has_table_privilege(${writer}, 'page_units', 'DELETE') AS writes` as Array<Record<string, boolean>>;
      expect(privileges).toEqual({ reads: true, reader_writes: false, writes: true });
      await sql.unsafe(`REVOKE ALL ON page_units, page_chunks, page_embeddings, page_books FROM ${reader}, ${writer}`);
    } finally {
      await sql.close();
      await admin.unsafe(`DROP ROLE ${reader}; DROP ROLE ${writer}`);
    }
  });
});
