import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainExpertClient } from '../src/core/domain-expert-client.ts';
import { domainPolicy } from '../src/core/domain-expert.ts';
import {
  createDomainExpertWorker as createRawDomainExpertWorker,
  type DomainExpertWorkerOptions,
} from '../src/workers/domain-expert/index.ts';
import { TEST_AGENT_ROUTING } from './routing-fixture.ts';

interface CapturedCall {
  url: string;
  method: string;
}

function createDomainExpertWorker(options: DomainExpertWorkerOptions = {}) {
  return createRawDomainExpertWorker({
    agentRouting: TEST_AGENT_ROUTING,
    dataDir: mkdtempSync(join(tmpdir(), 'expert-agents-validation-data-')),
    ...options,
  });
}

function postDomainResponse(
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

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe('live mutation approval validation', () => {
  function visualWorker(calls: CapturedCall[] = []) {
    return createDomainExpertWorker({
      google: {
        accessToken: 'fixture-google-token',
        fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : String(input);
          const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
          calls.push({ url, method });
          if (method === 'GET' && url.includes('/documents/')) return jsonResponse({});
          if (method === 'POST' && url.endsWith(':batchUpdate')) return jsonResponse({ replies: [] });
          return jsonResponse({ error: `unexpected Google fixture URL: ${url}` }, 500);
        }) as typeof fetch,
      },
    });
  }

  function acquisitionFixture(calls: CapturedCall[] = []) {
    const base = mkdtempSync(join(tmpdir(), 'expert-agents-validation-annas-'));
    const booksRoot = join(base, 'books');
    mkdirSync(booksRoot);
    return {
      worker: createDomainExpertWorker({
        annas: {
          apiKey: 'fixture-acquisition-token',
          baseUrl: 'https://annas.example',
          booksRoot,
        },
        fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : String(input);
          const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
          calls.push({ url, method });
          return new Response('fixture-book-bytes', {
            status: 200,
            headers: { 'content-type': 'application/epub+zip' },
          });
        }) as typeof fetch,
      }),
      cleanup: () => rmSync(base, { recursive: true, force: true }),
    };
  }

  for (const approval of [
    { name: 'spaces', value: '   ' },
    { name: 'empty', value: '' },
    { name: 'tab', value: '\t' },
    { name: 'missing', value: undefined },
  ]) {
    test(`${approval.name} approval id is rejected on Google Docs mutations`, async () => {
      const calls: CapturedCall[] = [];
      const response = await postDomainResponse(visualWorker(calls), 'domain_doc', {
        action: 'visual_insert',
        document_id: 'fixture-document',
        text: 'Approved text',
        range_start: 1,
        ...(approval.value === undefined ? {} : { approval_id: approval.value }),
        dry_run: false,
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'approval_required' } });
      expect(calls).toHaveLength(0);
    });

    test(`${approval.name} approval id is rejected on Anna downloads`, async () => {
      const calls: CapturedCall[] = [];
      const fixture = acquisitionFixture(calls);
      try {
        const response = await postDomainResponse(fixture.worker, 'annas_archive_import', {
          annas_archive_id: 'book-one',
          title: 'Fixture Book',
          format: 'epub',
          copyright_posture: 'approved_fixture_use',
          ...(approval.value === undefined ? {} : { approval_id: approval.value }),
          dry_run: false,
        });

        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: 'approval_required' } });
        expect(calls).toHaveLength(0);
      } finally {
        fixture.cleanup();
      }
    });
  }

  test('a non-empty approval id passes both live mutation gates', async () => {
    const visualCalls: CapturedCall[] = [];
    const visualResponse = await postDomainResponse(visualWorker(visualCalls), 'domain_doc', {
      action: 'visual_insert',
      document_id: 'fixture-document',
      text: 'Approved text',
      range_start: 1,
      approval_id: 'approval-fixture',
      dry_run: false,
    });
    expect(visualResponse.status).toBe(200);
    expect(visualCalls.some((call) => call.method === 'POST' && call.url.endsWith(':batchUpdate'))).toBe(true);

    const annasCalls: CapturedCall[] = [];
    const fixture = acquisitionFixture(annasCalls);
    try {
      const annasResponse = await postDomainResponse(fixture.worker, 'annas_archive_import', {
        annas_archive_id: 'book-one',
        title: 'Fixture Book',
        format: 'epub',
        copyright_posture: 'approved_fixture_use',
        approval_id: 'approval-fixture',
        dry_run: false,
      });
      expect(annasResponse.status).toBe(200);
      expect(annasCalls).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('optional string parameter validation', () => {
  for (const invalidDomainId of [123, {}]) {
    test(`domain_id ${JSON.stringify(invalidDomainId)} is rejected instead of defaulting`, async () => {
      const response = await postDomainResponse(createDomainExpertWorker(), 'domain_agent', {
        action: 'status',
        domain_id: invalidDomainId,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'invalid_params',
          message: expect.stringContaining('domain_id'),
        },
      });
    });
  }

  test('the client preserves absent default routing and forwards invalid supplied domain ids', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = new DomainExpertClient({
      domainExpert: {
        enabled: true,
        baseUrl: 'http://worker.test/v1',
        requestTimeoutSeconds: 1,
        defaultDomainId: 'history',
      },
    }, {
      requestJson: async (_url, init) => {
        sent.push((JSON.parse(String(init.body)) as { params: Record<string, unknown> }).params);
        return { policy: domainPolicy() };
      },
    });

    await client.run('domain_agent', { action: 'status' });
    await client.run('domain_agent', { action: 'status', domain_id: 123 });
    await client.run('domain_agent', { action: 'status', domain_id: {} });

    expect(sent).toEqual([
      { action: 'status', domain_id: 'history' },
      { action: 'status', domain_id: 123 },
      { action: 'status', domain_id: {} },
    ]);
  });

  test('non-string values on other optional string parameters are named and rejected', async () => {
    const response = await postDomainResponse(createDomainExpertWorker(), 'annas_archive_search', {
      query: { nested: 'not a string' },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'invalid_params',
        message: expect.stringContaining('query'),
      },
    });
  });
});

describe('Anna Archive search limit validation', () => {
  function searchWorker(calls: CapturedCall[] = []) {
    return createDomainExpertWorker({
      annas: { apiKey: 'fixture-acquisition-token', baseUrl: 'https://annas.example' },
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        calls.push({ url, method });
        return jsonResponse({ results: [] });
      }) as typeof fetch,
    });
  }

  for (const field of ['top_n', 'max_results'] as const) {
    for (const value of [-1, 0, 1.5, 10_000]) {
      test(`${field} rejects ${value}`, async () => {
        const calls: CapturedCall[] = [];
        const response = await postDomainResponse(searchWorker(calls), 'annas_archive_search', {
          query: 'fixture query',
          [field]: value,
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: {
            code: 'invalid_params',
            message: expect.stringContaining(field),
          },
        });
        expect(calls).toHaveLength(0);
      });
    }
  }

  for (const field of ['top_n', 'max_results'] as const) {
    for (const value of [1, 50]) {
      test(`${field} accepts boundary ${value}`, async () => {
        const calls: CapturedCall[] = [];
        const response = await postDomainResponse(searchWorker(calls), 'annas_archive_search', {
          query: 'fixture query',
          [field]: value,
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          kind: 'annas_archive_search_result',
          search: { top_n: value },
        });
        expect(calls).toHaveLength(1);
      });
    }
  }
});

describe('RAG delete not-found classification', () => {
  const corpusResource = 'projects/fixture-project/locations/us-central1/ragCorpora/1234567890123456789';
  const ragFileName = `${corpusResource}/ragFiles/fixture-file`;

  function deleteWorker(missing: 'file' | 'corpus', calls: CapturedCall[]) {
    let corpusListCalls = 0;
    return createDomainExpertWorker({
      gcpProject: 'fixture-project',
      google: {
        accessToken: 'fixture-google-token',
        fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : String(input);
          const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
          const path = new URL(url).pathname;
          calls.push({ url, method });
          if (method === 'GET' && path.endsWith('/ragCorpora')) {
            corpusListCalls += 1;
            return jsonResponse({
              ragCorpora: missing === 'corpus' && corpusListCalls > 1
                ? []
                : [{ name: corpusResource, displayName: 'research-library' }],
            });
          }
          if (method === 'DELETE' && path.includes('/ragFiles/')) {
            if (missing === 'file') {
              return jsonResponse({
                error: {
                  code: 404,
                  message: 'RagFile not found',
                  status: 'NOT_FOUND',
                  details: [{
                    '@type': 'type.googleapis.com/google.rpc.ResourceInfo',
                    resourceType: 'aiplatform.googleapis.com/RagFile',
                    resourceName: ragFileName,
                  }],
                },
              }, 404);
            }
            return jsonResponse({ error: { code: 404, message: 'not found', status: 'NOT_FOUND' } }, 404);
          }
          if (method === 'GET' && path.endsWith(`/ragCorpora/${corpusResource.split('/').at(-1)}`)) {
            return missing === 'corpus'
              ? jsonResponse({ error: { code: 404, message: 'not found', status: 'NOT_FOUND' } }, 404)
              : jsonResponse({ name: corpusResource, displayName: 'research-library' });
          }
          return jsonResponse({ error: `unexpected Google fixture URL: ${url}` }, 500);
        }) as typeof fetch,
      },
    });
  }

  test('a missing child file with a live corpus reports file not-found', async () => {
    const calls: CapturedCall[] = [];
    const response = await postDomainResponse(deleteWorker('file', calls), 'rag_corpus', {
      action: 'delete_file',
      domain_id: 'research',
      corpus_id: 'research-library',
      rag_file_name: ragFileName,
      dry_run: false,
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'rag_file_not_found' } });
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
  });

  test('a missing corpus retains the corpus-level not-found contract', async () => {
    const calls: CapturedCall[] = [];
    const response = await postDomainResponse(deleteWorker('corpus', calls), 'rag_corpus', {
      action: 'delete_file',
      domain_id: 'research',
      corpus_id: 'research-library',
      rag_file_name: ragFileName,
      dry_run: false,
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'rag_corpus_not_found' } });
    expect(calls.some((call) => call.method === 'GET' && call.url.endsWith(`/ragCorpora/${corpusResource.split('/').at(-1)}`))).toBe(true);
  });
});

// 2026-10-08: after a worker restart, deleting a rag file named with the
// project number (as Vertex lists it) was refused as foreign until something
// listed the corpus first, because number aliases lived only in memory.
describe('RAG delete accepts the project-number spelling Resource Manager confirms', () => {
  const corpusResource = 'projects/fixture-project/locations/us-central1/ragCorpora/1234567890123456789';
  const numberedFile = (projectNumber: string) => `projects/${projectNumber}/locations/us-central1/ragCorpora/1234567890123456789/ragFiles/fixture-file`;

  function numberWorker(calls: CapturedCall[]) {
    return createDomainExpertWorker({
      gcpProject: 'fixture-project',
      google: {
        accessToken: 'fixture-google-token',
        fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : String(input);
          const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
          const path = new URL(url).pathname;
          calls.push({ url, method });
          if (url === 'https://cloudresourcemanager.googleapis.com/v1/projects/fixture-project') {
            return jsonResponse({ projectId: 'fixture-project', projectNumber: '111111111111' });
          }
          if (method === 'GET' && path.endsWith('/ragCorpora')) {
            return jsonResponse({ ragCorpora: [{ name: corpusResource, displayName: 'research-library' }] });
          }
          if (method === 'DELETE' && path.includes('/ragFiles/')) {
            return jsonResponse({ name: `${corpusResource}/operations/delete-1` });
          }
          return jsonResponse({ error: `unexpected Google fixture URL: ${url}` }, 500);
        }) as typeof fetch,
      },
    });
  }

  test('a fresh worker deletes a file named with the confirmed project number, with no listing first', async () => {
    const calls: CapturedCall[] = [];
    const response = await postDomainResponse(numberWorker(calls), 'rag_corpus', {
      action: 'delete_file',
      domain_id: 'research',
      corpus_id: 'research-library',
      rag_file_name: numberedFile('111111111111'),
      dry_run: false,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'delete_file_requested' });
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
    expect(calls.some((call) => call.url.endsWith('/ragCorpora/1234567890123456789/ragFiles') && call.method === 'GET')).toBe(false);
  });

  test('a project number Resource Manager does not confirm is still refused', async () => {
    const calls: CapturedCall[] = [];
    const response = await postDomainResponse(numberWorker(calls), 'rag_corpus', {
      action: 'delete_file',
      domain_id: 'research',
      corpus_id: 'research-library',
      rag_file_name: numberedFile('999999999999'),
      dry_run: false,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'rag_file_foreign_corpus' } });
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
  });
});
