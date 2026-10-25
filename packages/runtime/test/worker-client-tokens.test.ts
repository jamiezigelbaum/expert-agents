import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  CLIENT_TOKENS_ENV,
  warnIfWorkerAuthDisabled,
  withWorkerBearerAuth,
  workerClientGrantsFromEnv,
} from '../src/workers/http.ts';

const sha = (token: string) => createHash('sha256').update(token).digest('hex');
const grantsJson = JSON.stringify({
  'reader-a': { tokenSha256: sha('token-a'), domains: ['public-a'], tools: ['domain_library'], actions: ['search'] },
  'reader-b': { tokenSha256: sha('token-b'), domains: ['public-b'], tools: ['domain_library'] },
});

function handlerWith(options: { authToken?: string }) {
  const seen: unknown[] = [];
  const handler = withWorkerBearerAuth(async (request) => {
    seen.push(request.method === 'POST' ? await request.json() : request.method);
    return new Response('ok');
  }, { ...options, clients: workerClientGrantsFromEnv({ [CLIENT_TOKENS_ENV]: grantsJson }) });
  return { handler, seen };
}

function call(token: string, body: unknown, path = '/v1/domain', method = 'POST') {
  return new Request(`http://100.64.0.1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

const search = (domain: string, action = 'search') => ({ tool: 'domain_library', params: { domain_id: domain, action, query: 'q', session_id: 's' } });

describe('scoped worker client tokens', () => {
  test('a client reaches only its own domain, tool and actions', async () => {
    const { handler, seen } = handlerWith({});
    expect((await handler(call('token-a', search('public-a')))).status).toBe(200);
    expect(seen).toEqual([search('public-a')]);
    expect((await handler(call('token-a', search('public-b')))).status).toBe(403);
    expect((await handler(call('token-a', search('public-a', 'view_page')))).status).toBe(403);
    expect((await handler(call('token-a', { tool: 'library_ingest', params: { domain_id: 'public-a', action: 'start' } }))).status).toBe(403);
    expect((await handler(call('token-a', {}, '/v1/health', 'GET'))).status).toBe(403);
    expect((await handler(call('token-b', search('public-b', 'read_range')))).status).toBe(200);
    expect(seen).toHaveLength(2);
  });

  test('unknown tokens are refused, and the owner token keeps full access', async () => {
    const { handler } = handlerWith({ authToken: 'owner-token' });
    expect((await handler(call('nope', search('public-a')))).status).toBe(401);
    expect((await handler(call('owner-token', { tool: 'library_ingest', params: { domain_id: 'private' } }))).status).toBe(200);
    expect((await handler(call('owner-token', {}, '/v1/health', 'GET'))).status).toBe(200);
  });

  test('client tokens alone satisfy the bind guard', () => {
    expect(() => warnIfWorkerAuthDisabled('test worker', undefined, '100.64.0.1', { [CLIENT_TOKENS_ENV]: grantsJson })).not.toThrow();
  });

  test('a malformed grant file is refused at start', () => {
    expect(() => workerClientGrantsFromEnv({ [CLIENT_TOKENS_ENV]: '{"x":{"tokenSha256":"raw-token","domains":["a"],"tools":["t"]}}' }))
      .toThrow(/tokenSha256/);
    expect(() => workerClientGrantsFromEnv({ [CLIENT_TOKENS_ENV]: `{"x":{"tokenSha256":"${sha('t')}","domains":[],"tools":["t"]}}` }))
      .toThrow(/domains/);
    expect(() => workerClientGrantsFromEnv({ [CLIENT_TOKENS_ENV]: '{}' })).toThrow(/names no clients/);
    expect(() => warnIfWorkerAuthDisabled('test worker', undefined, '100.64.0.1', { [CLIENT_TOKENS_ENV]: '{}' })).toThrow();
    expect(() => workerClientGrantsFromEnv({ [CLIENT_TOKENS_ENV]: '@/nonexistent' }, () => { throw new Error('no'); }))
      .toThrow(/could not be read/);
  });
});
