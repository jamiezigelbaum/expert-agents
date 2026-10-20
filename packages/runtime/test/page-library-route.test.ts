import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderUnitMarkdown } from '@expert-agents/library';
import { AgentRoutingConfigError, pageLibraryOriginalBuckets, validateAgentRoutingConfig } from '../src/core/agent-routing.ts';
import { AgentRegistrationStore } from '../src/core/agent-registration.ts';
import { createDomainExpertWorker } from '../src/workers/domain-expert/index.ts';

let tree: string;
let dataDir: string;
const registrationLibrary = { bucket: 'neutral-library', prefix: 'factory' };

beforeAll(async () => {
  tree = await mkdtemp(join(tmpdir(), 'page-route-tree-'));
  dataDir = await mkdtemp(join(tmpdir(), 'page-route-data-'));
  const book = join(tree, 'books', 'sample-book-aaaaaa');
  await mkdir(book, { recursive: true });
  for (const [n, bucket] of [[1, 'originals-bucket'], [2, 'foreign-bucket']] as const) {
    const unit = `p000${n}`;
    await writeFile(join(book, `${unit}.md`), renderUnitMarkdown({
      title: `Sample — p.${n}`, book: 'sample-book-aaaaaa', unit, source: `gs://${bucket}/v1/sample.pdf`, source_page: n,
    }, `Page ${n} text.`));
  }
  await writeFile(join(tree, 'catalog.json'), JSON.stringify({ books: [
    { book: 'sample-book-aaaaaa', title: 'Sample Book', creator: 'A. Author', kind: 'pages', units: 2, first_unit: 'p0001', last_unit: 'p0002', figures: 0 },
  ] }));
});

afterAll(async () => {
  await rm(tree, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe('page-library-only routes', () => {
  test('need neither a corpus nor a library location', () => {
    const routes = validateAgentRoutingConfig({ history: { pageLibrary: { root: '/srv/pages/history', sourceId: 'history', originalBuckets: ['originals-bucket'] } } });
    expect(routes.history).toEqual({ domainId: 'history', pageLibrary: { root: '/srv/pages/history', sourceId: 'history', originalBuckets: ['originals-bucket'] } });
    // Without a library, the originals buckets must be explicit.
    expect(() => validateAgentRoutingConfig({ history: { pageLibrary: { root: '/srv/pages/history', sourceId: 'history' } } })).toThrow(AgentRoutingConfigError);
    // Vertex retrieval settings without a corpus mean nothing.
    expect(() => validateAgentRoutingConfig({ history: {
      pageLibrary: { root: '/srv/pages/history', sourceId: 'history', originalBuckets: ['originals-bucket'] }, retrieval: { topK: 5 },
    } })).toThrow(AgentRoutingConfigError);
    // A Vertex route still needs both fields.
    expect(() => validateAgentRoutingConfig({ history: { library: { bucket: 'b', prefix: 'p' } } })).toThrow(AgentRoutingConfigError);
    expect(() => validateAgentRoutingConfig({ history: { pageLibrary: { root: '/srv/x', sourceId: 'history', originalBuckets: ['Bad Bucket'] } } })).toThrow(AgentRoutingConfigError);
  });

  test('view_page originals come from the explicit list, else the library locations', () => {
    expect(pageLibraryOriginalBuckets({ library: { bucket: 'lib', prefix: 'p' }, readOnlySourceRoots: [{ bucket: 'ro', prefix: 'q' }], pageLibrary: { root: '/x', sourceId: 'x' } }))
      .toEqual(['lib', 'ro']);
    expect(pageLibraryOriginalBuckets({ library: { bucket: 'lib', prefix: 'p' }, pageLibrary: { root: '/x', sourceId: 'x', originalBuckets: ['only'] } }))
      .toEqual(['only']);
  });

  test('serve domain_library, refuse the Vertex tools, and view only allowlisted originals', async () => {
    const downloads: string[] = [];
    const worker = createDomainExpertWorker({
      dataDir, gcpProject: 'neutral-project',
      agentRouting: validateAgentRoutingConfig({ history: { pageLibrary: { root: tree, sourceId: 'history', originalBuckets: ['originals-bucket'] } } }),
      pageSearch: async () => [{ slug: 'books/sample-book-aaaaaa/p0001', text: 'Page 1 text.' }],
      google: { accessToken: 'synthetic-token', fetchImpl: (async (input: RequestInfo | URL) => {
        downloads.push(String(input));
        return new Response('not a pdf', { status: 404 });
      }) as typeof fetch },
    });
    const call = async (tool: string, params: Record<string, unknown>) => {
      const response = await worker.fetch(new Request('http://worker.test/v1/domain', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool, params: { domain_id: 'history', ...params } }),
      }));
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const search = await call('domain_library', { action: 'search', query: 'page' });
    expect(search.status).toBe(200);
    expect(search.body.results[0].cite).toBe('A. Author, Sample Book, p.1');

    for (const [tool, params] of [
      ['domain_ask', { question: 'What is on page one?' }],
      ['domain_read', { action: 'catalog' }],
      ['rag_corpus', { action: 'ensure', dry_run: false, approval_id: 'op-1' }],
    ] as const) {
      const refused = await call(tool, params);
      expect(refused.status).toBe(404);
      expect(refused.body.error.code).toBe('vertex_not_configured');
    }

    const foreign = await call('domain_library', { action: 'view_page', slug: 'books/sample-book-aaaaaa/p0002' });
    expect(foreign.body.error.code).toBe('page_library_source_not_available');
    expect(downloads.some((url) => url.includes('foreign-bucket'))).toBe(false);
    await call('domain_library', { action: 'view_page', slug: 'books/sample-book-aaaaaa/p0001' });
    expect(downloads.some((url) => url.includes('originals-bucket'))).toBe(true);
  });
});

describe('page-library registrations', () => {
  test('need no corpus, and the operator owns the tree path and index source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'page-route-reg-'));
    try {
      const store = new AgentRegistrationStore(dir, validateAgentRoutingConfig({}), registrationLibrary, '/srv/pages');
      const library = { bucket: 'neutral-library', prefix: 'factory/history' };
      const { routes } = store.register('history', { displayName: 'History', library, pageLibrary: {} }, false);
      expect(routes.history!.pageLibrary).toEqual({ root: '/srv/pages/history', sourceId: 'history' });
      expect(routes.history!.targetCorpusDisplayName).toBeUndefined();
      expect(pageLibraryOriginalBuckets(routes.history!)).toEqual(['neutral-library']);
      // Persisted, reloaded, and idempotent.
      const reloaded = new AgentRegistrationStore(dir, validateAgentRoutingConfig({}), registrationLibrary, '/srv/pages');
      expect(reloaded.routes().history).toEqual(routes.history);
      expect(reloaded.register('history', { displayName: 'History', library, pageLibrary: {} }, false).existing).toBe(true);

      for (const bad of [
        { library, pageLibrary: { root: '/etc' } },
        { library, pageLibrary: { sourceId: 'someone-else' } },
        { library },
        { pageLibrary: {} },
      ]) {
        expect(() => store.register('other', bad, true)).toThrow();
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('a page library already assigned to a deployment route conflicts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'page-route-reg-'));
    try {
      const base = validateAgentRoutingConfig({ shared: { pageLibrary: { root: '/srv/pages/history', sourceId: 'shared', originalBuckets: ['x-bucket'] } } });
      const store = new AgentRegistrationStore(dir, base, registrationLibrary, '/srv/pages');
      expect(() => store.register('history', { library: { bucket: 'neutral-library', prefix: 'factory/history' }, pageLibrary: {} }, true))
        .toThrow('already assigned');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('domain_agent register accepts the snake_case wire form', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'page-route-reg-'));
    try {
      const worker = createDomainExpertWorker({
        dataDir: dir, gcpProject: 'neutral-project', registrationLibrary, pageLibraryRoot: '/srv/pages',
        agentRouting: validateAgentRoutingConfig({}),
        google: { accessToken: 'synthetic-token', fetchImpl: (async () => { throw new Error('no upstream call expected'); }) as unknown as typeof fetch },
      });
      const response = await worker.fetch(new Request('http://worker.test/v1/domain', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'domain_agent', params: {
          action: 'register', domain_id: 'history', library: { bucket: 'neutral-library', prefix: 'factory/history' },
          page_library: { source_id: 'history' }, approval_id: 'op-1', dry_run: false,
        } }),
      }));
      const body = await response.json() as Record<string, any>;
      expect(response.status).toBe(200);
      expect(body.status).toBe('registered');
      expect(body.manifest.routing.page_library).toEqual({ source_id: 'history' });
      expect(body.manifest.routing.target_corpus_display_name).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
