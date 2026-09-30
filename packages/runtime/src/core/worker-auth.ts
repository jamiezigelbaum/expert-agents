import type { ExpertAgentsConfig } from './config.ts';

export function workerAuthTokenFromConfig(config: ExpertAgentsConfig): string | undefined {
  const token = config.domainExpert.authToken?.trim();
  return token || undefined;
}

export function withWorkerAuthHeader(init: RequestInit, token?: string): RequestInit {
  if (!token) return init;
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}
