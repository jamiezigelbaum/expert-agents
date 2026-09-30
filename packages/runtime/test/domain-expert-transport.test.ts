import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDomainExpertWorker as createRawDomainExpertWorker,
  type DomainExpertWorkerOptions,
} from '../src/workers/domain-expert/index.ts';
import {
  GoogleVertexAdapter,
  StaticAccessTokenProvider,
  VertexPaginationError,
} from '../../library-materializer/src/index.ts';
import { TEST_AGENT_ROUTING } from './routing-fixture.ts';

const ANNAS_API_KEY = 'fixture-annas-secret';
const GOOGLE_ACCESS_TOKEN = 'fixture-google-secret';

function createDomainExpertWorker(options: DomainExpertWorkerOptions = {}) {
  return createRawDomainExpertWorker({
    agentRouting: TEST_AGENT_ROUTING,
    dataDir: mkdtempSync(join(tmpdir(), 'expert-agents-transport-')),
    ...options,
  });
}

function postDomain(
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

function streamedBody(bytes: number, onCancel?: () => void): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(bytes);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      onCancel?.();
    },
  });
}

describe('domain expert upstream response transport bounds', () => {
  test('caps streamed Anna HTML before parsing and sends a deadline signal', async () => {
    let suppliedSignal: AbortSignal | null = null;
    let cancelled = false;
    const worker = createDomainExpertWorker({
      annas: { apiKey: ANNAS_API_KEY, baseUrl: 'https://annas.example' },
      fetchImpl: (async (_input, init) => {
        suppliedSignal = init?.signal as AbortSignal;
        return new Response(streamedBody(4 * 1024 * 1024 + 1, () => { cancelled = true; }), {
          headers: { 'content-type': 'text/html' },
        });
      }) as typeof fetch,
    });

    const response = await postDomain(worker, 'annas_archive_search', { query: 'transport limit' });
    const body = await response.json() as Record<string, any>;

    expect(suppliedSignal).toBeInstanceOf(AbortSignal);
    expect(response.status).toBe(502);
    expect(body.error).toEqual({
      code: 'upstream_response_size_limit_exceeded',
      message: 'Upstream HTML response exceeded the 4194304 byte limit.',
    });
    expect(cancelled).toBe(true);
  });

  test('caps streamed Google JSON before parsing and sends a deadline signal', async () => {
    let suppliedSignal: AbortSignal | null = null;
    let cancelled = false;
    const worker = createDomainExpertWorker({
      gcpProject: 'fixture-project',
      google: {
        accessToken: GOOGLE_ACCESS_TOKEN,
        fetchImpl: (async (_input, init) => {
          suppliedSignal = init?.signal as AbortSignal;
          return new Response(streamedBody(8 * 1024 * 1024 + 1, () => { cancelled = true; }), {
            headers: { 'content-type': 'application/json' },
          });
        }) as typeof fetch,
      },
    });

    const response = await postDomain(worker, 'domain_ask', {
      domain_id: 'research',
      question: 'Does the transport stay bounded?',
      corpus_id: '1234567890123456789',
    });
    const body = await response.json() as Record<string, any>;

    expect(suppliedSignal).toBeInstanceOf(AbortSignal);
    expect(response.status).toBe(502);
    expect(body.error).toEqual({
      code: 'upstream_response_size_limit_exceeded',
      message: 'Upstream JSON response exceeded the 8388608 byte limit.',
    });
    expect(cancelled).toBe(true);
  });
});

describe('Anna credentialed response disposal', () => {
  test('cancels a redirect body before following Location', async () => {
    let redirectCancelled = false;
    let calls = 0;
    const worker = createDomainExpertWorker({
      annas: { apiKey: ANNAS_API_KEY, baseUrl: 'https://annas.example' },
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(streamedBody(1, () => { redirectCancelled = true; }), {
            status: 302,
            headers: { location: '/search?page=2' },
          });
        }
        return Response.json({ results: [] });
      }) as unknown as typeof fetch,
    });

    const response = await postDomain(worker, 'annas_archive_search', { query: 'redirect disposal' });

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(redirectCancelled).toBe(true);
  });

  test('cancels a failed direct-download body before preserving the bounded error', async () => {
    const booksRoot = mkdtempSync(join(tmpdir(), 'expert-agents-transport-books-'));
    mkdirSync(join(booksRoot, 'Research'));
    let errorCancelled = false;
    const worker = createDomainExpertWorker({
      annas: {
        apiKey: ANNAS_API_KEY,
        baseUrl: 'https://annas.example',
        booksRoot,
      },
      fetchImpl: (async () => new Response(streamedBody(1, () => { errorCancelled = true; }), {
        status: 503,
      })) as unknown as typeof fetch,
    });

    const response = await postDomain(worker, 'annas_archive_import', {
      annas_archive_id: 'fixture-book',
      title: 'Fixture Book',
      author: 'Fixture Author',
      topic: 'Research',
      format: 'epub',
      copyright_posture: 'approved_fixture_use',
      approval_id: 'approval-fixture',
      ingest: false,
      dry_run: false,
    });
    const body = await response.json() as Record<string, any>;

    expect(response.status).toBe(503);
    expect(body.error).toEqual({
      code: 'annas_archive_error',
      message: 'Anna Archive download failed.',
    });
    expect(errorCancelled).toBe(true);
  });
});

describe('Vertex pagination bounds', () => {
  test('the runtime corpus resolver rejects a repeated nextPageToken', async () => {
    let calls = 0;
    const worker = createDomainExpertWorker({
      gcpProject: 'fixture-project',
      google: {
        accessToken: GOOGLE_ACCESS_TOKEN,
        fetchImpl: (async () => {
          calls += 1;
          return Response.json({ ragCorpora: [], nextPageToken: 'repeated-token' });
        }) as unknown as typeof fetch,
      },
    });

    const response = await postDomain(worker, 'domain_ask', {
      domain_id: 'research',
      question: 'Does pagination terminate?',
      corpus_id: 'research-library',
    });
    const body = await response.json() as Record<string, any>;

    expect(calls).toBe(2);
    expect(response.status).toBe(502);
    expect(body.error).toEqual({
      code: 'google_api_error',
      message: 'Vertex pagination violated the 100-page cap (repeated nextPageToken).',
    });
  });

  test('the materializer corpus loop rejects a repeated nextPageToken with a typed error', async () => {
    let calls = 0;
    const adapter = new GoogleVertexAdapter({
      project: 'fixture-project',
      location: 'us-central1',
      tokenProvider: new StaticAccessTokenProvider(GOOGLE_ACCESS_TOKEN),
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ ragCorpora: [], nextPageToken: 'repeated-token' });
      },
    });

    try {
      await adapter.ensureCorpus('fixture-corpus');
      throw new Error('expected pagination to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(VertexPaginationError);
      expect((error as VertexPaginationError).maxPages).toBe(100);
      expect((error as Error).message).toContain('100-page cap (repeated nextPageToken)');
    }
    expect(calls).toBe(2);
  });

  test('the materializer file loop stops at the named page cap', async () => {
    let calls = 0;
    const adapter = new GoogleVertexAdapter({
      project: 'fixture-project',
      location: 'us-central1',
      tokenProvider: new StaticAccessTokenProvider(GOOGLE_ACCESS_TOKEN),
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ ragFiles: [], nextPageToken: `page-${calls}` });
      },
    });

    try {
      await adapter.listFiles('projects/fixture-project/locations/us-central1/ragCorpora/123');
      throw new Error('expected pagination to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(VertexPaginationError);
      expect((error as VertexPaginationError).maxPages).toBe(100);
      expect((error as Error).message).toContain('100-page cap (page cap reached)');
    }
    expect(calls).toBe(100);
  });
});

describe('upstream-derived string sanitization', () => {
  test('bounds Google error serialization and removes the configured bearer value', async () => {
    const worker = createDomainExpertWorker({
      gcpProject: 'fixture-project',
      google: {
        accessToken: GOOGLE_ACCESS_TOKEN,
        multiQuery: false,
        fetchImpl: (async () => Response.json({
          error: {
            message: `reflected=${GOOGLE_ACCESS_TOKEN}:${'x'.repeat(5_000)}`,
          },
        }, { status: 403 })) as unknown as typeof fetch,
      },
    });

    const response = await postDomain(worker, 'domain_ask', {
      domain_id: 'research',
      question: 'Is the error bounded?',
      corpus_id: '1234567890123456789',
    });
    const body = await response.json() as Record<string, any>;

    expect(response.status).toBe(403);
    expect(body.error.code).toBe('google_api_error');
    expect(body.error.message.length).toBe(2_000);
    expect(body.error.message).toContain('reflected=redacted');
    expect(JSON.stringify(body)).not.toContain(GOOGLE_ACCESS_TOKEN);
  });

  test('bounds Anna candidate strings and redacts credential-bearing URL parameters', async () => {
    const worker = createDomainExpertWorker({
      annas: { apiKey: ANNAS_API_KEY, baseUrl: 'https://annas.example' },
      fetchImpl: (async () => Response.json({
        results: [{
          id: 'fixture-id',
          title: `${ANNAS_API_KEY}-${'t'.repeat(2_000)}`,
          author: `${ANNAS_API_KEY}-${'a'.repeat(2_000)}`,
          url: `https://annas.example/item?key=${ANNAS_API_KEY}&token=token-secret&signature=sig-secret&X-Amz-Credential=aws-secret&safe=visible`,
        }],
      })) as unknown as typeof fetch,
    });

    const response = await postDomain(worker, 'annas_archive_search', { query: 'fixture' });
    const body = await response.json() as Record<string, any>;
    const candidate = body.candidates[0] as Record<string, string>;
    const candidateUrl = new URL(candidate.url);

    expect(response.status).toBe(200);
    expect(candidate.title.length).toBe(1_000);
    expect(candidate.author.length).toBe(1_000);
    expect(candidate.title).toStartWith('redacted-');
    expect(candidate.author).toStartWith('redacted-');
    expect(candidateUrl.searchParams.get('key')).toBe('redacted');
    expect(candidateUrl.searchParams.get('token')).toBe('redacted');
    expect(candidateUrl.searchParams.get('signature')).toBe('redacted');
    expect(candidateUrl.searchParams.get('X-Amz-Credential')).toBe('redacted');
    expect(candidateUrl.searchParams.get('safe')).toBe('visible');
    expect(JSON.stringify(body)).not.toContain(ANNAS_API_KEY);
    expect(JSON.stringify(body)).not.toContain('token-secret');
    expect(JSON.stringify(body)).not.toContain('sig-secret');
    expect(JSON.stringify(body)).not.toContain('aws-secret');
  });
});

describe('Anna acquisition audit hardening', () => {
  test('stores canonical URL origin and path in a 0600 audit file', async () => {
    const booksRoot = mkdtempSync(join(tmpdir(), 'expert-agents-audit-books-'));
    const suppliedUrl = `https://annas.example/download/fixture.epub?key=${ANNAS_API_KEY}&token=private#account-fragment`;
    const worker = createDomainExpertWorker({
      annas: {
        apiKey: ANNAS_API_KEY,
        baseUrl: 'https://annas.example',
        booksRoot,
      },
      fetchImpl: (async () => new Response('fixture-book-bytes', {
        headers: { 'content-type': 'application/epub+zip' },
      })) as unknown as typeof fetch,
    });

    const response = await postDomain(worker, 'annas_archive_import', {
      url: suppliedUrl,
      title: 'Audited Fixture',
      author: 'Fixture Author',
      topic: 'Research',
      format: 'epub',
      copyright_posture: 'approved_fixture_use',
      approval_id: 'approval-fixture',
      ingest: false,
      dry_run: false,
    });
    const auditPath = join(booksRoot, '.expert-agents-annas-audit.jsonl');
    const audit = JSON.parse(readFileSync(auditPath, 'utf8').trim()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(audit.selected.url).toBe('https://annas.example/download/fixture.epub');
    expect(JSON.stringify(audit)).not.toContain(ANNAS_API_KEY);
    expect(JSON.stringify(audit)).not.toContain('private');
    expect(JSON.stringify(audit)).not.toContain('account-fragment');
    expect(statSync(auditPath).mode & 0o777).toBe(0o600);
  });
});
