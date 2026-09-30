import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDomainExpertWorker as createRawDomainExpertWorker, type DomainExpertWorkerOptions } from '../src/workers/domain-expert/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { TEST_AGENT_ROUTING } from './routing-fixture.ts';

function createDomainExpertWorker(options: DomainExpertWorkerOptions = {}) {
  return createRawDomainExpertWorker({
    agentRouting: TEST_AGENT_ROUTING,
    dataDir: mkdtempSync(join(tmpdir(), 'expert-agents-error-paths-')),
    ...options,
  });
}

type GoogleFailurePoint = 'retrieve' | 'reformulate' | 'answer';

interface CapturedCall {
  url: string;
  body: string;
}

const CORPUS_RESOURCE = 'projects/fixture-project/locations/us-central1/ragCorpora/1234567890123456789';
const UPSTREAM_ONLY_TEXT = 'fixture upstream detail that must remain private';

function failingGoogleFetch(
  calls: CapturedCall[],
  failurePoint: GoogleFailurePoint,
  status: number,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const body = init?.body ? await new Response(init.body as BodyInit).text() : '';
    calls.push({ url, body });

    if (url.endsWith('/ragCorpora')) {
      return jsonResponse({
        ragCorpora: [{ name: CORPUS_RESOURCE, displayName: 'research-library' }],
      });
    }
    if (url.endsWith(':retrieveContexts')) {
      if (failurePoint === 'retrieve') return upstreamFailure(status);
      return jsonResponse({
        contexts: {
          contexts: [{
            id: 'fixture-context',
            text: 'fixture evidence',
            sourceUri: 'gs://fixture/source.pdf',
            sourceDisplayName: 'Fixture Source',
            score: 0.9,
          }],
        },
      });
    }
    if (url.includes(':generateContent')) {
      const reformulation = body.includes('Generate exactly two concise retrieval-query reformulations');
      if (reformulation) {
        if (failurePoint === 'reformulate') return upstreamFailure(status);
        return jsonResponse({ candidates: [{ content: { parts: [{ text: '["fixture alternate one","fixture alternate two"]' }] } }] });
      }
      if (failurePoint === 'answer') return upstreamFailure(status);
      return jsonResponse({ candidates: [{ content: { parts: [{ text: 'Fixture answer [1234567890123456789:1].' }] } }] });
    }
    return jsonResponse({ fixture: 'unexpected Google fixture URL' }, 500);
  }) as typeof fetch;
}

function upstreamFailure(status: number): Response {
  // Deliberately avoid Google's `error` envelope. The public contract for an
  // unstructured upstream failure is bounded and must not expose response text.
  return jsonResponse({ upstream_detail: UPSTREAM_ONLY_TEXT }, status);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function postDomain(worker: { fetch(request: Request): Promise<Response> }): Promise<Response> {
  return worker.fetch(new Request('http://worker.test/v1/domain', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tool: 'domain_ask',
      params: {
        domain_id: 'research',
        question: 'What does the fixture say?',
        corpus_id: '1234567890123456789',
      },
    }),
  }));
}

function workerForFailure(failurePoint: GoogleFailurePoint, status: number, calls: CapturedCall[] = []) {
  return createDomainExpertWorker({
    gcpProject: 'fixture-project',
    google: {
      accessToken: 'fixture-google-token',
      multiQuery: true,
      fetchImpl: failingGoogleFetch(calls, failurePoint, status),
    },
  });
}

const GOOGLE_FAILURE_STATUSES = [401, 403, 429, 500] as const;

describe('Vertex domain_ask error paths', () => {
  function workerWithAnswer(answer: unknown) {
    const normal = failingGoogleFetch([], 'answer', 500);
    return createDomainExpertWorker({
      gcpProject: 'fixture-project',
      google: { accessToken: 'fixture-google-token', multiQuery: false, fetchImpl: (async (input, init) => {
        if (String(input).includes(':generateContent')) return jsonResponse(answer);
        return normal(input, init);
      }) as typeof fetch },
    });
  }

  test.each([
    {},
    { candidates: [] },
    { candidates: [{ content: { parts: [{ text: '  ' }] } }] },
    { candidates: [{ content: { parts: [{ text: 'private thought', thought: true }] } }] },
  ])('empty or non-answer HTTP 200 response never reports answered: %j', async answer => {
    const response = await postDomain(workerWithAnswer(answer));
    const body = await response.json() as Record<string, any>;
    expect(response.status).toBe(502);
    expect(body.error.code).toBe('google_generation_empty');
    expect(JSON.stringify(body)).not.toContain('private thought');
  });

  test.each(['SAFETY', 'MAX_TOKENS', 'RECITATION'])('rejects incomplete generation with %s finish reason', async finishReason => {
    const response = await postDomain(workerWithAnswer({ candidates: [{ finishReason, content: { parts: [{ text: 'partial private answer' }] } }] }));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('partial private answer');
  });

  test('concatenates all answer text parts while excluding thought parts', async () => {
    const response = await postDomain(workerWithAnswer({ candidates: [{ finishReason: 'STOP', content: { parts: [
      { text: 'private thought', thought: true }, { text: 'Fixture answer ' }, { text: '[1234567890123456789:1].' },
    ] } }] }));
    const body = await response.json() as Record<string, any>;
    expect(response.status).toBe(200);
    expect(body.answer).toBe('Fixture answer [1234567890123456789:1].');
    expect(JSON.stringify(body)).not.toContain('private thought');
  });

  for (const failurePoint of ['retrieve', 'answer'] as const) {
    for (const status of GOOGLE_FAILURE_STATUSES) {
      test(`${failurePoint} HTTP ${status} preserves the bounded google_api_error contract`, async () => {
        const calls: CapturedCall[] = [];
        const response = await postDomain(workerForFailure(failurePoint, status, calls));
        const text = await response.text();
        const body = JSON.parse(text) as Record<string, any>;

        expect(response.status).toBe(status);
        expect(body.error).toEqual({
          code: 'google_api_error',
          message: `Google API request failed with HTTP ${status}.`,
        });
        expect(body.policy).toBeDefined();
        expect(text).not.toContain(UPSTREAM_ONLY_TEXT);
        expect(text).not.toContain('fixture evidence');
        expect(text).not.toContain('Fixture answer');

        const answerCalls = calls.filter((call) => call.url.includes(':generateContent')
          && !call.body.includes('Generate exactly two concise retrieval-query reformulations'));
        expect(answerCalls).toHaveLength(failurePoint === 'retrieve' ? 0 : 1);
      });
    }
  }

  for (const status of GOOGLE_FAILURE_STATUSES) {
    test(`reformulation HTTP ${status} degrades to a single retrieval query`, async () => {
      const calls: CapturedCall[] = [];
      const response = await postDomain(workerForFailure('reformulate', status, calls));
      const body = await response.json() as Record<string, any>;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        kind: 'domain_answer',
        status: 'answered',
        answer: 'Fixture answer [1234567890123456789:1].',
        retrieval_plan: { multi_query: { enabled: true } },
      });
      expect(calls.filter((call) => call.url.endsWith(':retrieveContexts'))).toHaveLength(1);
      expect(calls.filter((call) => call.url.includes(':generateContent'))).toHaveLength(2);
    });
  }
});

describe('worker bearer auth negative contract', () => {
  const unauthorized = {
    error: { code: 'unauthorized', message: 'Worker authorization failed.' },
  };
  const cases: Array<{ name: string; headers?: Headers; rawAuthorization?: string }> = [
    { name: 'missing Authorization header' },
    { name: 'bare Bearer', headers: new Headers({ Authorization: 'Bearer' }) },
    { name: 'Basic scheme', headers: new Headers({ Authorization: 'Basic x' }) },
    { name: 'lowercase bearer scheme', headers: new Headers({ Authorization: 'bearer fixture-token' }) },
    // Request/Headers normalizes surrounding whitespace, so this fixture calls
    // the wrapper at its actual boundary with the raw value an HTTP adapter may
    // expose before Fetch normalization.
    { name: 'token with trailing whitespace', rawAuthorization: 'Bearer fixture-token ' },
    {
      name: 'duplicate Authorization headers',
      headers: (() => {
        const headers = new Headers();
        headers.append('Authorization', 'Bearer fixture-token');
        headers.append('Authorization', 'Bearer fixture-token');
        return headers;
      })(),
    },
  ];

  for (const authCase of cases) {
    test(`${authCase.name} is rejected before the inner handler runs`, async () => {
      let handlerCalls = 0;
      const route = withWorkerBearerAuth(async () => {
        handlerCalls += 1;
        return Response.json({ ok: true });
      }, { authToken: 'fixture-token' });

      const request = authCase.rawAuthorization === undefined
        ? new Request('http://127.0.0.1/v1/counting-fixture', { headers: authCase.headers })
        : ({
            headers: { get: (name: string) => name.toLowerCase() === 'authorization' ? authCase.rawAuthorization! : null },
          } as unknown as Request);
      const response = await route(request);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(unauthorized);
      expect(handlerCalls).toBe(0);
    });
  }
});
