import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDomainExpertWorker } from '../src/workers/domain-expert/index.ts';
import { TEST_AGENT_ROUTING } from './routing-fixture.ts';

function fixture(): { base: string; workspace: string; dataDir: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'expert-agents-domain-fs-'));
  const workspace = join(base, 'workspace');
  const dataDir = join(base, 'data');
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(dataDir, { mode: 0o700 });
  return {
    base,
    workspace,
    dataDir,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function workerFor(input: {
  workspace: string;
  dataDir: string;
  annas?: { booksRoot: string; fetchImpl: typeof fetch };
}) {
  return createDomainExpertWorker({
    agentRouting: TEST_AGENT_ROUTING,
    dataDir: input.dataDir,
    roots: [{
      rootId: 'expert_agents_workspace',
      path: input.workspace,
      maxWriteBytes: 20 * 1024 * 1024,
      allowOverwrite: false,
    }],
    ...(input.annas ? {
      annas: {
        apiKey: 'fixture-acquisition-token',
        baseUrl: 'https://annas.example',
        booksRoot: input.annas.booksRoot,
      },
      fetchImpl: input.annas.fetchImpl,
    } : {}),
  });
}

function googleCorpusFetch(): typeof fetch {
  const resourceName = 'projects/fixture-project/locations/us-central1/ragCorpora/1234567890123456789';
  return (async (input: string | URL | Request): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const parsed = new URL(url);
    if (parsed.hostname === 'storage.googleapis.com') return Response.json({ name: 'fixture-object' });
    if (parsed.pathname.endsWith('/ragFiles:import')) return Response.json({ name: `${parsed.pathname.replace(/^\/v1\//, '').replace(/\/ragFiles:import$/, '')}/operations/fixture-import` });
    if (parsed.pathname.endsWith('/ragFiles')) return Response.json({ ragFiles: [] });
    if (parsed.pathname.endsWith('/ragCorpora')) {
      return Response.json({ ragCorpora: [{ name: resourceName, displayName: 'research-library' }] });
    }
    if (url.includes('/ragCorpora/')) return Response.json({ name: resourceName, displayName: 'research-library' });
    return Response.json({ error: 'unexpected fixture request' }, { status: 500 });
  }) as typeof fetch;
}

async function postDomain(
  worker: { fetch(request: Request): Promise<Response> },
  tool: string,
  params: Record<string, unknown>,
): Promise<Response> {
  return worker.fetch(new Request('http://worker.test/v1/domain', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool, params }),
  }));
}

describe('domain expert filesystem hardening', () => {
  test('workspace writes reject a preplanted symlink below the configured root', async () => {
    const testFixture = fixture();
    try {
      const outside = join(testFixture.base, 'outside');
      mkdirSync(outside, { mode: 0o700 });
      symlinkSync(outside, join(testFixture.workspace, 'experts'));
      const worker = workerFor(testFixture);

      const response = await postDomain(worker, 'domain_agent', {
        action: 'bootstrap',
        domain_id: 'research',
        dry_run: false,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'path_escape_denied' } });
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      testFixture.cleanup();
    }
  });

  test('book writes reject a preplanted symlink below the configured books root', async () => {
    const testFixture = fixture();
    try {
      const booksRoot = join(testFixture.base, 'books');
      const outside = join(testFixture.base, 'outside-books');
      mkdirSync(booksRoot, { mode: 0o700 });
      mkdirSync(outside, { mode: 0o700 });
      // The worker slugifies the topic (safeObjectName lowercases), so the
      // planted symlink must sit at the slug the code writes — a capitalized
      // plant only matched on case-insensitive filesystems and let the test
      // pass locally while missing the guard on Linux.
      symlinkSync(outside, join(booksRoot, 'research'));
      let fetches = 0;
      const worker = workerFor({
        ...testFixture,
        annas: {
          booksRoot,
          fetchImpl: (async () => {
            fetches += 1;
            return new Response('fixture-book-bytes', { status: 200 });
          }) as unknown as typeof fetch,
        },
      });

      const response = await postDomain(worker, 'annas_archive_import', {
        annas_archive_id: 'book-one',
        title: 'Fixture Book',
        author: 'Example Author',
        topic: 'Research',
        format: 'epub',
        copyright_posture: 'approved_fixture_use',
        approval_id: 'approval-fixture',
        dry_run: false,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'path_escape_denied' } });
      expect(fetches).toBe(0);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      testFixture.cleanup();
    }
  });

  test('the edit ledger and corpus mapping cache are private files', async () => {
    const testFixture = fixture();
    const corpusName = 'projects/fixture-project/locations/us-central1/ragCorpora/1234567890123456789';
    try {
      const googleFetch = (async (input: string | URL | Request): Promise<Response> => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes('docs.googleapis.com') && url.includes(':batchUpdate')) {
          return Response.json({ documentId: 'fixture-doc' });
        }
        if (url.includes('docs.googleapis.com')) {
          return Response.json({ documentId: 'fixture-doc', revisionId: '1', body: { content: [{ endIndex: 1 }] } });
        }
        if (new URL(url).pathname.endsWith('/ragCorpora')) {
          return Response.json({ ragCorpora: [{ name: corpusName, displayName: 'research-library' }] });
        }
        if (url.includes('/ragCorpora/')) return Response.json({ name: corpusName, displayName: 'research-library' });
        return Response.json({ error: 'unexpected fixture request' }, { status: 500 });
      }) as typeof fetch;
      const worker = createDomainExpertWorker({
        agentRouting: TEST_AGENT_ROUTING,
        gcpProject: 'fixture-project',
        dataDir: testFixture.dataDir,
        google: { accessToken: 'fixture-token', fetchImpl: googleFetch },
      });

      const corpusResponse = await postDomain(worker, 'rag_corpus', {
        action: 'status',
        domain_id: 'research',
        corpus_id: 'research-library',
        dry_run: false,
      });
      expect(corpusResponse.status).toBe(200);

      const editResponse = await postDomain(worker, 'domain_doc', {
        action: 'visual_insert',
        domain_id: 'research',
        document_id: 'fixture-doc',
        text: 'private fixture edit',
        approval_id: 'fixture-approval',
        dry_run: false,
      });
      expect(editResponse.status).toBe(200);

      expect(statSync(testFixture.dataDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(testFixture.dataDir, 'rag-corpus-mapping.json')).mode & 0o777).toBe(0o600);
      expect(statSync(join(testFixture.dataDir, 'domain-doc-edits.jsonl')).mode & 0o777).toBe(0o600);
    } finally {
      testFixture.cleanup();
    }
  });

  test('worker startup rejects a group- or world-writable data directory', () => {
    const testFixture = fixture();
    try {
      chmodSync(testFixture.dataDir, 0o777);
      expect(() => createDomainExpertWorker({ dataDir: testFixture.dataDir })).toThrow(
        /must not be group- or world-writable/,
      );
    } finally {
      testFixture.cleanup();
    }
  });

  for (const invalidMapping of [
    {
      name: 'invalid Vertex resource name',
      resourceName: 'not-a-vertex-resource-name',
      project: 'fixture-project',
      location: 'us-central1',
    },
    {
      name: 'foreign configured project and location',
      resourceName: 'projects/foreign-project/locations/europe-west4/ragCorpora/999',
      project: 'foreign-project',
      location: 'europe-west4',
    },
  ]) {
    test(`discarding a corpus cache entry with ${invalidMapping.name}`, async () => {
      const testFixture = fixture();
      const key = 'fixture-project/us-central1/research-library';
      const validResourceName = 'projects/fixture-project/locations/us-central1/ragCorpora/1234567890123456789';
      try {
        writeFileSync(join(testFixture.dataDir, 'rag-corpus-mapping.json'), JSON.stringify({
          version: 1,
          corpora: {
            [key]: {
              display_name: 'research-library',
              corpus_id: '999',
              resource_name: invalidMapping.resourceName,
              project: invalidMapping.project,
              location: invalidMapping.location,
              updated_at: new Date(0).toISOString(),
            },
          },
        }), { mode: 0o600 });
        let listCalls = 0;
        const googleFetch = (async (input: string | URL | Request): Promise<Response> => {
          const url = input instanceof Request ? input.url : String(input);
          if (new URL(url).pathname.endsWith('/ragCorpora')) {
            listCalls += 1;
            return Response.json({ ragCorpora: [{ name: validResourceName, displayName: 'research-library' }] });
          }
          if (url.includes('/ragCorpora/')) return Response.json({ name: validResourceName, displayName: 'research-library' });
          return Response.json({ error: 'unexpected fixture request' }, { status: 500 });
        }) as typeof fetch;
        const worker = createDomainExpertWorker({
          agentRouting: TEST_AGENT_ROUTING,
          gcpProject: 'fixture-project',
          dataDir: testFixture.dataDir,
          google: { accessToken: 'fixture-token', fetchImpl: googleFetch },
        });

        const response = await postDomain(worker, 'rag_corpus', {
          action: 'status',
          domain_id: 'research',
          corpus_id: 'research-library',
          dry_run: false,
        });
        const body = await response.json() as Record<string, any>;

        expect(response.status).toBe(200);
        expect(listCalls).toBe(1);
        expect(body).toMatchObject({
          resolved_corpus: { resource_name: validResourceName },
          warnings: [{ code: 'rag_corpus_mapping_file_unreadable', mapping_file: 'rag-corpus-mapping.json' }],
        });
        const persisted = JSON.parse(readFileSync(join(testFixture.dataDir, 'rag-corpus-mapping.json'), 'utf8'));
        expect(persisted.corpora[key]).toMatchObject({
          project: 'fixture-project',
          location: 'us-central1',
          resource_name: validResourceName,
        });
      } finally {
        testFixture.cleanup();
      }
    });
  }

  test('web import skips an over-limit derivative before creating its import tree', async () => {
    const testFixture = fixture();
    try {
      const worker = createDomainExpertWorker({
        agentRouting: TEST_AGENT_ROUTING,
        gcpProject: 'fixture-project',
        dataDir: testFixture.dataDir,
        roots: [{
          rootId: 'expert_agents_workspace',
          path: testFixture.workspace,
          maxWriteBytes: 1,
          allowOverwrite: false,
        }],
        google: { accessToken: 'fixture-token', fetchImpl: googleCorpusFetch() },
        resolveHostImpl: async () => ['93.184.216.34'],
        webImportFetchImpl: async () => new Response(
          '<html><head><title>Large Fixture</title></head><body>large fixture body</body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        ),
        summarizeBin: '/fixture/bin/summarize',
        summarizeExtract: async () => ({ exitCode: 0, stdout: '# Large Fixture\n\nlarge fixture body\n', stderr: '' }),
      });

      const response = await postDomain(worker, 'rag_corpus', {
        action: 'web_import',
        domain_id: 'research',
        corpus_id: '1234567890123456789',
        urls: ['https://example.com/large'],
        batch_id: 'over-limit-web',
        dry_run: false,
      });
      const body = await response.json() as Record<string, any>;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        status: 'web_import_no_importable_files',
        eligible_file_count: 0,
        skipped_files: [{ reason: 'file_size_limit_exceeded' }],
      });
      expect(() => statSync(join(
        testFixture.workspace,
        'experts/research/sources/web-imports/over-limit-web',
      ))).toThrow();
    } finally {
      testFixture.cleanup();
    }
  });

  test('web import creates private files exclusively and preserves an existing target', async () => {
    const testFixture = fixture();
    const batchPath = join(testFixture.workspace, 'experts/research/sources/web-imports/private-web');
    const targetPath = join(batchPath, 'private-fixture.md');
    try {
      const worker = createDomainExpertWorker({
        agentRouting: TEST_AGENT_ROUTING,
        gcpProject: 'fixture-project',
        dataDir: testFixture.dataDir,
        roots: [{
          rootId: 'expert_agents_workspace',
          path: testFixture.workspace,
          maxWriteBytes: 1024 * 1024,
          allowOverwrite: true,
        }],
        google: { accessToken: 'fixture-token', fetchImpl: googleCorpusFetch() },
        // The fixture operation never finishes; do not wait for an outcome.
        annas: { importPollTimeoutMs: 0 },
        resolveHostImpl: async () => ['93.184.216.34'],
        webImportFetchImpl: async () => new Response(
          '<html><head><title>Private Fixture</title></head><body>private fixture body</body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        ),
        summarizeBin: '/fixture/bin/summarize',
        summarizeExtract: async () => ({ exitCode: 0, stdout: '# Private Fixture\n\nprivate fixture body\n', stderr: '' }),
      });
      const params = {
        action: 'web_import',
        domain_id: 'research',
        corpus_id: '1234567890123456789',
        urls: ['https://example.com/private'],
        batch_id: 'private-web',
        dry_run: false,
      };

      const first = await postDomain(worker, 'rag_corpus', params);
      expect(first.status).toBe(200);
      expect(statSync(batchPath).mode & 0o777).toBe(0o700);
      expect(statSync(targetPath).mode & 0o777).toBe(0o600);

      writeFileSync(targetPath, 'preserve-existing-bytes', { mode: 0o600 });
      const second = await postDomain(worker, 'rag_corpus', params);
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({ error: { code: 'workspace_file_exists' } });
      expect(readFileSync(targetPath, 'utf8')).toBe('preserve-existing-bytes');
    } finally {
      testFixture.cleanup();
    }
  });

  test('Notion import skips an over-limit derivative before creating its import tree', async () => {
    const testFixture = fixture();
    const pageId = '11111111111111111111111111111111';
    try {
      const notionFetch = (async (input: string | URL | Request): Promise<Response> => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path.endsWith('/users/me')) return Response.json({ id: 'fixture-user' });
        if (path.endsWith(`/pages/${pageId}`)) {
          return Response.json({
            id: pageId,
            properties: { title: { type: 'title', title: [{ plain_text: 'Large Notion Fixture' }] } },
          });
        }
        if (path.endsWith(`/blocks/${pageId}/children`)) {
          return Response.json({ results: [], has_more: false, next_cursor: null });
        }
        return Response.json({ error: 'unexpected Notion fixture request' }, { status: 500 });
      }) as typeof fetch;
      const worker = createDomainExpertWorker({
        agentRouting: TEST_AGENT_ROUTING,
        gcpProject: 'fixture-project',
        dataDir: testFixture.dataDir,
        roots: [{
          rootId: 'expert_agents_workspace',
          path: testFixture.workspace,
          maxWriteBytes: 1,
          allowOverwrite: false,
        }],
        google: { accessToken: 'fixture-token', fetchImpl: googleCorpusFetch() },
        notion: { token: 'fixture-notion-token', fetchImpl: notionFetch },
      });

      const response = await postDomain(worker, 'rag_corpus', {
        action: 'notion_import',
        domain_id: 'research',
        corpus_id: '1234567890123456789',
        page_ids: [pageId],
        batch_id: 'over-limit-notion',
        dry_run: false,
      });
      const body = await response.json() as Record<string, any>;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        status: 'notion_import_no_importable_files',
        eligible_file_count: 0,
        skipped_files: [{ reason: 'file_size_limit_exceeded' }],
      });
      expect(() => statSync(join(
        testFixture.workspace,
        'experts/research/sources/notion-imports/over-limit-notion',
      ))).toThrow();
    } finally {
      testFixture.cleanup();
    }
  });

  test('Notion recursive block fetching shares the configured object budget', async () => {
    const testFixture = fixture();
    const pageId = '22222222222222222222222222222222';
    const calls: string[] = [];
    try {
      const notionFetch = (async (input: string | URL | Request): Promise<Response> => {
        const url = input instanceof Request ? input.url : String(input);
        calls.push(url);
        const path = new URL(url).pathname;
        if (path.endsWith('/users/me')) return Response.json({ id: 'fixture-user' });
        if (path.endsWith(`/pages/${pageId}`)) {
          return Response.json({
            id: pageId,
            properties: { title: { type: 'title', title: [{ plain_text: 'Budgeted Notion Fixture' }] } },
          });
        }
        if (path.endsWith(`/blocks/${pageId}/children`)) {
          return Response.json({
            results: [
              {
                id: 'child-block',
                type: 'toggle',
                has_children: true,
                toggle: { rich_text: [{ plain_text: 'First block' }] },
              },
              {
                id: 'unfetched-sibling',
                type: 'paragraph',
                has_children: false,
                paragraph: { rich_text: [{ plain_text: 'Second block' }] },
              },
            ],
            has_more: false,
            next_cursor: null,
          });
        }
        if (path.endsWith('/blocks/child-block/children')) {
          return Response.json({
            results: [{
              id: 'grandchild-block',
              type: 'toggle',
              has_children: true,
              toggle: { rich_text: [{ plain_text: 'Budget-ending block' }] },
            }],
            has_more: false,
            next_cursor: null,
          });
        }
        return Response.json({ error: 'unexpected Notion fixture request' }, { status: 500 });
      }) as typeof fetch;
      const worker = createDomainExpertWorker({
        agentRouting: TEST_AGENT_ROUTING,
        gcpProject: 'fixture-project',
        dataDir: testFixture.dataDir,
        roots: [{
          rootId: 'expert_agents_workspace',
          path: testFixture.workspace,
          maxWriteBytes: 1,
          allowOverwrite: false,
        }],
        google: { accessToken: 'fixture-token', fetchImpl: googleCorpusFetch() },
        notion: { token: 'fixture-notion-token', maxObjects: 2, fetchImpl: notionFetch },
      });

      const response = await postDomain(worker, 'rag_corpus', {
        action: 'notion_import',
        domain_id: 'research',
        corpus_id: '1234567890123456789',
        page_ids: [pageId],
        batch_id: 'budgeted-notion',
        dry_run: false,
      });
      const body = await response.json() as Record<string, any>;

      expect(response.status).toBe(200);
      expect(body.derived_files[0].warnings).toContain('notion_page_block_count_capped');
      expect(calls.some((url) => url.includes('/blocks/child-block/children?page_size=1'))).toBe(true);
      expect(calls.some((url) => url.includes('/blocks/grandchild-block/children'))).toBe(false);
      expect(calls.some((url) => url.includes('start_cursor='))).toBe(false);
    } finally {
      testFixture.cleanup();
    }
  });
});
