import { createHash, timingSafeEqual } from 'node:crypto';

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

// Loopback is not a trust boundary. Every local process on the host can reach
// a loopback port, and this worker's tool surface includes corpus mutation and
// rag_corpus delete_file, so an unauthenticated worker grants those to anything
// running on the box. Absence of a token is therefore fatal by default; local
// development opts out explicitly.
export function warnIfWorkerAuthDisabled(
  label: string,
  token: string | undefined,
  hostname: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (token) return;
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
  options: { authToken?: string },
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (options.authToken) {
      const expected = `Bearer ${options.authToken}`;
      const presentedDigest = createHash('sha256').update(request.headers.get('Authorization') ?? '').digest();
      const expectedDigest = createHash('sha256').update(expected).digest();
      if (!timingSafeEqual(presentedDigest, expectedDigest)) {
        return Response.json({ error: { code: 'unauthorized', message: 'Worker authorization failed.' } }, { status: 401 });
      }
    }
    return handler(request);
  };
}
