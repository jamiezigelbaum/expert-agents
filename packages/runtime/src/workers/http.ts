import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function resolveWorkerBindHost(
  env: Record<string, string | undefined>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return '127.0.0.1';
}

export function workerAuthTokenFromEnv(env: Record<string, string | undefined>): string | undefined {
  return env.EXPERT_AGENTS_DOMAIN_EXPERT_AUTH_TOKEN?.trim() || undefined;
}

export const ALLOW_UNAUTHENTICATED_ENV = 'EXPERT_AGENTS_DOMAIN_EXPERT_ALLOW_UNAUTHENTICATED';

/**
 * Scoped client tokens: each names the domains, tools and (optionally)
 * actions one client may call, so a deployment on another host gets read
 * access to its own route and nothing else. The file holds SHA-256 digests,
 * never tokens. Value is JSON or `@/path/to/file.json`:
 * `{"<client>": {"tokenSha256": "<64 hex>", "domains": ["<id>"], "tools": ["domain_library"], "actions": ["search"]}}`.
 */
export const CLIENT_TOKENS_ENV = 'EXPERT_AGENTS_DOMAIN_EXPERT_CLIENT_TOKENS_JSON';

export interface WorkerClientGrant {
  client: string;
  tokenSha256: Buffer;
  domains: ReadonlySet<string>;
  tools: ReadonlySet<string>;
  actions?: ReadonlySet<string>;
}

const MAX_CLIENT_REQUEST_BYTES = 1_048_576;

export function workerClientGrantsFromEnv(
  env: Record<string, string | undefined>,
  readTextFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): WorkerClientGrant[] {
  const raw = env[CLIENT_TOKENS_ENV]?.trim();
  if (!raw) return [];
  const fail = (message: string): never => { throw new Error(`${CLIENT_TOKENS_ENV} is invalid: ${message}`); };
  let text = raw;
  if (raw.startsWith('@')) {
    try { text = readTextFile(raw.slice(1).trim()); } catch { fail('the @ file could not be read'); }
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { fail('the JSON document is malformed'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('the top-level value must be an object');
  const list = (value: unknown, label: string, required: boolean): Set<string> | undefined => {
    if (value === undefined && !required) return undefined;
    if (!Array.isArray(value) || value.length < 1 || value.some((item) => typeof item !== 'string' || !item.trim())) {
      fail(`${label} must list one or more names`);
    }
    return new Set(value as string[]);
  };
  const grants = Object.entries(parsed as Record<string, unknown>).map(([client, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`client ${client} must be an object`);
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => !['tokenSha256', 'domains', 'tools', 'actions'].includes(key))) fail(`client ${client} has an unknown key`);
    if (typeof record.tokenSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.tokenSha256)) fail(`client ${client} tokenSha256 must be 64 lowercase hex`);
    const actions = list(record.actions, `client ${client} actions`, false);
    return {
      client,
      tokenSha256: Buffer.from(record.tokenSha256 as string, 'hex'),
      domains: list(record.domains, `client ${client} domains`, true)!,
      tools: list(record.tools, `client ${client} tools`, true)!,
      ...(actions ? { actions } : {}),
    };
  });
  // Set but empty would leave no credential at all, and an unauthenticated worker serves every tool.
  if (grants.length === 0) fail('it names no clients');
  if (new Set(grants.map((g) => g.tokenSha256.toString('hex'))).size !== grants.length) fail('two clients share a token');
  return grants;
}

// Loopback is not a trust boundary. Every local process on the host can reach
// a loopback port, and this worker's tool surface includes library ingest and
// acquisition, so an unauthenticated worker grants those to anything
// running on the box. Absence of a token is therefore fatal by default; local
// development opts out explicitly.
export function warnIfWorkerAuthDisabled(
  label: string,
  token: string | undefined,
  hostname: string,
  env: Record<string, string | undefined> = process.env,
): void {
  // Only validated grants count as authentication: the parser refuses an empty or malformed document.
  if (token || workerClientGrantsFromEnv(env).length > 0) return;
  if (!['127.0.0.1', '::1', 'localhost'].includes(hostname)) {
    throw new Error(`${label} cannot bind to a non-loopback host without EXPERT_AGENTS_DOMAIN_EXPERT_AUTH_TOKEN.`);
  }
  if (env[ALLOW_UNAUTHENTICATED_ENV] !== '1') {
    throw new Error(
      `${label} refuses to start without EXPERT_AGENTS_DOMAIN_EXPERT_AUTH_TOKEN. `
      + `Set ${ALLOW_UNAUTHENTICATED_ENV}=1 to run unauthenticated on loopback for local development only.`,
    );
  }
}

export function withWorkerBearerAuth(
  handler: (request: Request) => Response | Promise<Response>,
  options: { authToken?: string; clients?: readonly WorkerClientGrant[]; domainPath?: string },
): (request: Request) => Promise<Response> {
  const clients = options.clients ?? [];
  const domainPath = options.domainPath ?? '/v1/domain';
  return async (request) => {
    const header = request.headers.get('Authorization') ?? '';
    if (options.authToken) {
      const expected = `Bearer ${options.authToken}`;
      const presentedDigest = createHash('sha256').update(header).digest();
      const expectedDigest = createHash('sha256').update(expected).digest();
      if (timingSafeEqual(presentedDigest, expectedDigest)) return handler(request);
    } else if (clients.length === 0) {
      return handler(request);
    }
    const presented = createHash('sha256').update(header.startsWith('Bearer ') ? header.slice(7) : '').digest();
    let grant: WorkerClientGrant | undefined;
    for (const candidate of clients) {
      if (timingSafeEqual(presented, candidate.tokenSha256)) grant = candidate;
    }
    if (!grant) {
      return Response.json({ error: { code: 'unauthorized', message: 'Worker authorization failed.' } }, { status: 401 });
    }
    return scopedClientRequest(handler, request, grant, domainPath);
  };
}

/** A client token reaches only POST <domainPath> with a tool, domain and action its grant names. */
async function scopedClientRequest(
  handler: (request: Request) => Response | Promise<Response>,
  request: Request,
  grant: WorkerClientGrant,
  domainPath: string,
): Promise<Response> {
  const refuse = () => Response.json({ error: { code: 'client_not_permitted', message: 'This client may not make that request.' } }, { status: 403 });
  if (request.method !== 'POST' || new URL(request.url).pathname !== domainPath) return refuse();
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_CLIENT_REQUEST_BYTES) return refuse();
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(body)); } catch { return refuse(); }
  const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  const params = record.params && typeof record.params === 'object' && !Array.isArray(record.params) ? record.params as Record<string, unknown> : {};
  if (typeof record.tool !== 'string' || !grant.tools.has(record.tool)) return refuse();
  if (typeof params.domain_id !== 'string' || !grant.domains.has(params.domain_id)) return refuse();
  if (grant.actions && (typeof params.action !== 'string' || !grant.actions.has(params.action))) return refuse();
  return handler(new Request(request.url, { method: 'POST', headers: request.headers, body }));
}
