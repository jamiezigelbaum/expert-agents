import { describe, expect, test } from 'bun:test';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { googleUploadVehicle } from './google-vehicle.ts';

interface CapturedCall {
  url: string;
  body: string;
}

const UPSTREAM_ONLY_TEXT = 'fixture upstream detail that must remain private';

function storageFetch(calls: CapturedCall[], status: number): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, body: init?.body ? 'body' : '' });
    if (url.startsWith('https://storage.googleapis.com/')) {
      // Deliberately avoid Google's `error` envelope. The public contract for an
      // unstructured upstream failure is bounded and must not expose response text.
      return new Response(JSON.stringify({ upstream_detail: UPSTREAM_ONLY_TEXT }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
}

describe('Cloud Storage upload error paths', () => {
  test.each([401, 403, 429, 500] as const)('upstream HTTP %i preserves the bounded google_api_error contract', async status => {
    const calls: CapturedCall[] = [];
    const vehicle = googleUploadVehicle({ accessToken: 'fixture-google-token', fetchImpl: storageFetch(calls, status) });
    const { body } = await vehicle.run();
    const text = JSON.stringify(body);

    expect(body.rag_ingest).toMatchObject({ status: 'blocked', target: 'page_library' });
    expect(body.rag_ingest.error).toMatchObject({
      code: 'google_api_error',
      message: `Google API request failed with HTTP ${status}.`,
    });
    expect(text).not.toContain(UPSTREAM_ONLY_TEXT);
    expect(calls.filter((call) => call.url.startsWith('https://storage.googleapis.com/upload/'))).toHaveLength(1);
  });
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
