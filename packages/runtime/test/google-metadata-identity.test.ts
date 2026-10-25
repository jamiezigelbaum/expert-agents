import { describe, expect, test } from 'bun:test';
import { domainExpertGoogleConfigFromEnv } from '../src/workers/domain-expert/index.ts';
import { googleUploadVehicle } from './google-vehicle.ts';

const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

interface Call { url: string; headers: Record<string, string> }

function metadataFetch(calls: Call[], options: { metadataReachable: boolean }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).entries());
    calls.push({ url, headers });
    if (url === METADATA_TOKEN_URL) {
      if (!options.metadataReachable) throw new TypeError('fixture: metadata server unreachable');
      if (headers['metadata-flavor'] !== 'Google') return Response.json({ error: 'missing Metadata-Flavor' }, { status: 403 });
      return Response.json({ access_token: 'fixture-metadata-token', expires_in: 3599, token_type: 'Bearer' });
    }
    if (url.startsWith('https://storage.googleapis.com/upload/')) return Response.json({ name: 'ok', generation: '1' });
    return Response.json({ error: `unexpected fixture URL: ${url}` }, { status: 500 });
  }) as typeof fetch;
}

async function health(worker: { fetch(request: Request): Promise<Response> }): Promise<Record<string, any>> {
  return await (await worker.fetch(new Request('http://worker.test/v1/health'))).json() as Record<string, any>;
}

const uploads = (calls: Call[]) => calls.filter((call) => call.url.startsWith('https://storage.googleapis.com/upload/'));

describe('attached-identity (metadata server) Google credentials', () => {
  test('health reports ready and Google calls carry the metadata token, fetched once', async () => {
    const calls: Call[] = [];
    const vehicle = googleUploadVehicle({ metadataServerToken: true, fetchImpl: metadataFetch(calls, { metadataReachable: true }) });
    const status = await health(vehicle.worker);
    expect(status.configured.google).toBe(true);
    expect(status.configuration_status).toEqual({ google: 'ready' });

    for (let i = 0; i < 2; i += 1) {
      const { body } = await vehicle.run();
      expect(body.rag_ingest.error).toBeUndefined();
    }
    // Two acquisitions of the same original upload it twice-or-once; either way every upload carries the token.
    expect(uploads(calls).length).toBeGreaterThan(0);
    for (const call of uploads(calls)) expect(call.headers.authorization).toBe('Bearer fixture-metadata-token');
    // The health probe is one metadata read; the uploads share one cached token.
    expect(calls.filter((call) => call.url === METADATA_TOKEN_URL)).toHaveLength(2);
    expect(calls.some((call) => call.url.startsWith('https://oauth2.googleapis.com'))).toBe(false);
  });

  test('an unreachable metadata server is unreadable in health and fails the upload closed', async () => {
    const calls: Call[] = [];
    const vehicle = googleUploadVehicle({ metadataServerToken: true, fetchImpl: metadataFetch(calls, { metadataReachable: false }) });
    const status = await health(vehicle.worker);
    expect(status.configured.google).toBe(false);
    expect(status.configuration_status.google).toBe('unreadable');

    const { body } = await vehicle.run();
    expect(body.rag_ingest).toMatchObject({ status: 'blocked', error: { code: 'google_auth_not_configured' } });
    expect(uploads(calls)).toHaveLength(0);
  });

  test('service-account JSON keeps precedence over the metadata flag', async () => {
    const calls: Call[] = [];
    const vehicle = googleUploadVehicle({ metadataServerToken: true, serviceAccountJson: '{"client_email":"","private_key":""}', fetchImpl: metadataFetch(calls, { metadataReachable: true }) });
    expect((await health(vehicle.worker)).configuration_status.google).toBe('unreadable');
    expect(calls).toHaveLength(0);
  });

  test('the environment flag is parsed as a boolean', () => {
    expect(domainExpertGoogleConfigFromEnv({ EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_METADATA_TOKEN: '1' }).metadataServerToken).toBe(true);
    expect(domainExpertGoogleConfigFromEnv({ EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_METADATA_TOKEN: 'false' }).metadataServerToken).toBeUndefined();
    expect(domainExpertGoogleConfigFromEnv({})).not.toHaveProperty('metadataServerToken');
    expect(() => domainExpertGoogleConfigFromEnv({ EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_METADATA_TOKEN: 'maybe' })).toThrow();
  });
});
