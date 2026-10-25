import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderUnitMarkdown } from '@expert-agents/library';
import { validateAgentRoutingConfig } from '../src/core/agent-routing.ts';
import { createDomainExpertWorker } from '../src/workers/domain-expert/index.ts';
import { buildPdf } from '../../library/test/pdf-fixture.ts';

// Bounds chosen so each one is reachable with a ten-page book: a page is
// 1,000 characters, so the book's real extent is 10,000 and a session may
// see 20% of it, 2,000 characters.
const BOUNDS = { maxQuoteChars: 600, maxQuotesPerSource: 2, maxSourceCoveragePerSession: 0.2 };
const PAGE_CHARS = 1_000;
const BOUNDED = 'bounded-book-aaaaaa';
const WITHHELD = 'withheld-book-bbbbbb';
const BY_URI = 'uri-withheld-cccccc';

let tree: string;
let dataDir: string;

function pageText(n: number): string {
  const head = `Page ${n} of the bounded book. `;
  return `${(head + 'evidence '.repeat(200)).slice(0, PAGE_CHARS - 1)}.`;
}

async function writeBookUnits(book: string, title: string, source: string, pages: number, text: (n: number) => string) {
  const dir = join(tree, 'books', book);
  await mkdir(dir, { recursive: true });
  for (let n = 1; n <= pages; n++) {
    const unit = `p${String(n).padStart(4, '0')}`;
    await writeFile(join(dir, `${unit}.md`), renderUnitMarkdown({ title: `${title} — p.${n}`, book, unit, source, source_page: n }, text(n)));
  }
  return { book, title, creator: 'A. Author', kind: 'pages', units: pages, first_unit: 'p0001', last_unit: `p${String(pages).padStart(4, '0')}`, figures: 0, objects: [], sources: [source] };
}

beforeAll(async () => {
  tree = await mkdtemp(join(tmpdir(), 'page-disclosure-tree-'));
  dataDir = await mkdtemp(join(tmpdir(), 'page-disclosure-data-'));
  const books = [
    await writeBookUnits(BOUNDED, 'Bounded Book', 'gs://originals-bucket/bounded.pdf', 10, pageText),
    await writeBookUnits(WITHHELD, 'Withheld Book', 'gs://originals-bucket/withheld.pdf', 2, (n) => `Withheld evidence page ${n}.`),
    await writeBookUnits(BY_URI, 'Another Book', 'gs://originals-bucket/by-uri.pdf', 2, (n) => `Evidence by uri page ${n}.`),
  ];
  await writeFile(join(tree, 'catalog.json'), JSON.stringify({ books }));
});

afterAll(async () => {
  await rm(tree, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

function worker(disclosure: Record<string, unknown>) {
  const pdf = buildPdf(Array.from({ length: 10 }, (_, i) => ({ lines: [`Page ${i + 1}`] })));
  const instance = createDomainExpertWorker({
    dataDir,
    agentRouting: validateAgentRoutingConfig({ history: {
      pageLibrary: { root: tree, sourceId: 'history', originalBuckets: ['originals-bucket'] },
      disclosure,
    } }),
    pageSearch: async () => [
      { slug: `books/${BOUNDED}/p0001`, text: pageText(1) },
      { slug: `books/${WITHHELD}/p0001`, text: 'Withheld evidence page 1.' },
      { slug: `books/${BOUNDED}/p0002`, text: pageText(2) },
      { slug: `books/${BOUNDED}/p0003`, text: pageText(3) },
    ],
    google: { accessToken: 'synthetic-token', fetchImpl: (async () => new Response(new Blob([pdf as unknown as BlobPart]), { status: 200 })) as unknown as typeof fetch },
  });
  return async (params: Record<string, unknown>) => {
    const response = await instance.fetch(new Request('http://worker.test/v1/domain', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'domain_library', params: { domain_id: 'history', ...params } }),
    }));
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
}

const bounded = () => worker({
  bounds: BOUNDS,
  excludedSources: [{ displayName: 'Withheld Book' }, { uri: 'gs://originals-bucket/by-uri.pdf' }],
});

describe('page library under a disclosure policy', () => {
  test('requires a session id', async () => {
    const call = bounded();
    const refused = await call({ action: 'read', slug: `books/${BOUNDED}/p0001` });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('disclosure_session_required');
  });

  test('a read is cut to maxQuoteChars and reports the bounds', async () => {
    const read = await bounded()({ action: 'read', slug: `books/${BOUNDED}/p0001`, session_id: 'quote' });
    expect(read.status).toBe(200);
    expect(read.body.text).toHaveLength(BOUNDS.maxQuoteChars);
    expect(read.body.truncated).toBe(true);
    expect(read.body.cite).toBe('A. Author, Bounded Book, p.1');
    expect(read.body.disclosure).toMatchObject({ posture_declared: true, bounds: { max_quote_chars: 600, max_quotes_per_source: 2 }, excerpts_disclosed: 1, excerpts_truncated: 1 });
  });

  test('search keeps maxQuotesPerSource hits per book and drops excluded books', async () => {
    const search = await bounded()({ action: 'search', query: 'evidence', session_id: 'search' });
    expect(search.status).toBe(200);
    expect(search.body.results.map((r: { slug: string }) => r.slug)).toEqual([`books/${BOUNDED}/p0001`, `books/${BOUNDED}/p0002`]);
    expect(search.body.results.every((r: { text: string }) => r.text.length <= BOUNDS.maxQuoteChars)).toBe(true);
    expect(search.body.disclosure).toMatchObject({ excerpts_disclosed: 2, excerpts_withheld: 2 });
  });

  test('read_range returns at most maxQuotesPerSource units and resumes after them', async () => {
    const range = await bounded()({ action: 'read_range', book: BOUNDED, from_unit: 'p0001', to_unit: 'p0010', session_id: 'range' });
    expect(range.status).toBe(200);
    expect(range.body.units).toEqual([`books/${BOUNDED}/p0001`, `books/${BOUNDED}/p0002`]);
    expect(range.body.next_unit).toBe('p0003');
    expect(range.body.excerpt_truncated).toBe(true);
  });

  test('cumulative coverage is bounded per book from its real extent, per session', async () => {
    const call = bounded();
    // 600 + 600 + 600 of a 2,000-character budget.
    for (const n of [1, 2, 3]) {
      expect((await call({ action: 'read', slug: `books/${BOUNDED}/p000${n}`, session_id: 'walk' })).status).toBe(200);
    }
    const refused = await call({ action: 'read', slug: `books/${BOUNDED}/p0004`, session_id: 'walk' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('disclosure_source_coverage_exhausted');
    // A refusal spends nothing, and a range read draws on the same budget.
    expect((await call({ action: 'read_range', book: BOUNDED, from_unit: 'p0004', to_unit: 'p0005', session_id: 'walk' })).status).toBe(403);
    // Other books and other sessions have their own budgets.
    expect((await call({ action: 'read', slug: `books/${BOUNDED}/p0004`, session_id: 'other' })).status).toBe(200);
  });

  test('view_page charges its page in full', async () => {
    const call = bounded();
    for (const n of [1, 2]) {
      const view = await call({ action: 'view_page', slug: `books/${BOUNDED}/p000${n}`, session_id: 'view' });
      expect(view.status).toBe(200);
      expect(view.body.image.mime_type).toBe('image/jpeg');
    }
    const refused = await call({ action: 'view_page', slug: `books/${BOUNDED}/p0003`, session_id: 'view' });
    expect(refused.body.error.code).toBe('disclosure_source_coverage_exhausted');
  });

  test('excluded sources are absent from the catalog and refused by name', async () => {
    const call = bounded();
    const catalog = await call({ action: 'catalog', session_id: 'excluded' });
    expect(catalog.body.books.map((b: { book: string }) => b.book)).toEqual([BOUNDED]);
    for (const params of [
      { action: 'read', slug: `books/${WITHHELD}/p0001` },
      { action: 'read', slug: `books/${BY_URI}/p0001` },
      { action: 'read_range', book: WITHHELD, from_unit: 'p0001', to_unit: 'p0002' },
      { action: 'grep', pattern: 'evidence', book: BY_URI },
      { action: 'view_page', slug: `books/${WITHHELD}/p0001` },
    ]) {
      const refused = await call({ ...params, session_id: 'excluded' });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('disclosure_source_excluded');
    }
    const grep = await call({ action: 'grep', pattern: 'evidence', session_id: 'excluded' });
    expect(new Set(grep.body.hits.map((h: { slug: string }) => h.slug.split('/')[1]))).toEqual(new Set([BOUNDED]));
  });

  test('a library whose posture is not full is refused', async () => {
    const call = worker({ corpora: [{ corpusId: 'history', disclosure: 'derived' }] });
    const refused = await call({ action: 'search', query: 'evidence', session_id: 'posture' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('disclosure_corpus_not_disclosable');
  });

  test('without a disclosure policy the library is unbounded and needs no session', async () => {
    const instance = createDomainExpertWorker({
      dataDir,
      agentRouting: validateAgentRoutingConfig({ history: { pageLibrary: { root: tree, sourceId: 'history', originalBuckets: ['originals-bucket'] } } }),
      pageSearch: async () => [],
      google: { accessToken: 'synthetic-token', fetchImpl: (async () => new Response('', { status: 404 })) as unknown as typeof fetch },
    });
    const response = await instance.fetch(new Request('http://worker.test/v1/domain', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'domain_library', params: { domain_id: 'history', action: 'read', slug: `books/${BOUNDED}/p0001` } }),
    }));
    const body = await response.json() as Record<string, any>;
    expect(body.text).toHaveLength(PAGE_CHARS);
    expect(body.disclosure).toBeUndefined();
  });
});
