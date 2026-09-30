import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDomainExpertWorker, domainExpertGoogleConfigFromEnv } from '../src/workers/domain-expert/index.ts';
import { TEST_AGENT_ROUTING } from './routing-fixture.ts';

const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const CORPUS = 'projects/fixture-project/locations/us-central1/ragCorpora/1001';

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
    if (url.endsWith(':retrieveContexts')) {
      return Response.json({ contexts: { contexts: [{ id: 'c', text: 'fixture evidence', sourceUri: 'gs://fixture/source.pdf', sourceDisplayName: 'Fixture Source', score: 0.9 }] } });
    }
    if (new URL(url).pathname.endsWith('/ragCorpora')) {
      return Response.json({ ragCorpora: [{ name: CORPUS, displayName: 'research-library' }] });
    }
    return Response.json({ error: `unexpected fixture URL: ${url}` }, { status: 500 });
  }) as typeof fetch;
}

async function withWorker<T>(metadataReachable: boolean, body: (worker: ReturnType<typeof createDomainExpertWorker>, calls: Call[]) => Promise<T>): Promise<T> {
  const dataDir = mkdtempSync(join(tmpdir(), 'google-metadata-identity-'));
  const calls: Call[] = [];
  try {
    const worker = createDomainExpertWorker({
      dataDir,
      gcpProject: 'fixture-project',
      agentRouting: TEST_AGENT_ROUTING,
      google: { metadataServerToken: true, multiQuery: false, fetchImpl: metadataFetch(calls, { metadataReachable }) },
    });
    return await body(worker, calls);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function health(worker: ReturnType<typeof createDomainExpertWorker>): Promise<Record<string, any>> {
  return await (await worker.fetch(new Request('http://worker.test/v1/health'))).json() as Record<string, any>;
}

async function ask(worker: ReturnType<typeof createDomainExpertWorker>): Promise<Response> {
  return worker.fetch(new Request('http://worker.test/v1/domain', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'domain_ask', params: { domain_id: 'research', question: 'fixture question', output: 'passages' } }),
  }));
}

describe('attached-identity (metadata server) Google credentials', () => {
  test('health reports ready and Vertex calls carry the metadata token, fetched once', async () => {
    await withWorker(true, async (worker, calls) => {
      const status = await health(worker);
      expect(status.configured.google).toBe(true);
      expect(status.configuration_status).toEqual({ google: 'ready', google_credentials: 'ready', google_project: 'ready' });

      for (let i = 0; i < 2; i += 1) {
        const response = await ask(worker);
        expect(response.status).toBe(200);
        expect(((await response.json()) as Record<string, any>).kind).toBe('domain_passages');
      }
      const vertex = calls.filter((call) => call.url.includes('aiplatform.googleapis.com'));
      expect(vertex.length).toBeGreaterThan(0);
      for (const call of vertex) expect(call.headers.authorization).toBe('Bearer fixture-metadata-token');
      // The health probe is one metadata read; the two asks share one cached token.
      expect(calls.filter((call) => call.url === METADATA_TOKEN_URL)).toHaveLength(2);
      expect(calls.some((call) => call.url.startsWith('https://oauth2.googleapis.com'))).toBe(false);
    });
  });

  test('an unreachable metadata server is unreadable in health and fails the ask closed', async () => {
    await withWorker(false, async (worker, calls) => {
      const status = await health(worker);
      expect(status.configured.google).toBe(false);
      expect(status.configuration_status.google_credentials).toBe('unreadable');

      const response = await ask(worker);
      expect(response.status).toBe(503);
      expect(((await response.json()) as Record<string, any>).error.code).toBe('google_auth_not_configured');
      expect(calls.some((call) => call.url.includes('aiplatform.googleapis.com'))).toBe(false);
    });
  });

  test('service-account JSON keeps precedence over the metadata flag', async () => {
    const calls: Call[] = [];
    const worker = createDomainExpertWorker({
      gcpProject: 'fixture-project',
      agentRouting: TEST_AGENT_ROUTING,
      google: { metadataServerToken: true, serviceAccountJson: '{"client_email":"","private_key":""}', fetchImpl: metadataFetch(calls, { metadataReachable: true }) },
    });
    expect((await health(worker)).configuration_status.google_credentials).toBe('unreadable');
    expect(calls).toHaveLength(0);
  });

  test('the environment flag is parsed as a boolean', () => {
    expect(domainExpertGoogleConfigFromEnv({ EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_METADATA_TOKEN: '1' }).metadataServerToken).toBe(true);
    expect(domainExpertGoogleConfigFromEnv({ EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_METADATA_TOKEN: 'false' }).metadataServerToken).toBeUndefined();
    expect(domainExpertGoogleConfigFromEnv({})).not.toHaveProperty('metadataServerToken');
    expect(() => domainExpertGoogleConfigFromEnv({ EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_METADATA_TOKEN: 'maybe' })).toThrow();
  });
});
