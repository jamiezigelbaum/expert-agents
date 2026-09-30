import {
  createDomainExpertWorker,
  domainExpertAnnasConfigFromEnv,
  domainExpertGoogleConfigFromEnv,
  domainExpertNotionConfigFromEnv,
  domainExpertRootsFromEnv,
} from './index.ts';
import { agentRoutingConfigFromEnv } from '../../core/agent-routing.ts';
import {
  resolveWorkerBindHost,
  warnIfWorkerAuthDisabled,
  withWorkerBearerAuth,
  workerAuthTokenFromEnv,
} from '../http.ts';

export function resolveDomainExpertBindHostFromEnv(env: Record<string, string | undefined> = process.env): string {
  return resolveWorkerBindHost(env, ['EXPERT_AGENTS_DOMAIN_EXPERT_HOST']);
}

function main(): void {
  const port = parsePort(process.env.EXPERT_AGENTS_DOMAIN_EXPERT_PORT ?? '8040');
  const hostname = resolveDomainExpertBindHostFromEnv(process.env);
  const authToken = workerAuthTokenFromEnv(process.env);
  const roots = domainExpertRootsFromEnv(process.env);
  const agentRouting = agentRoutingConfigFromEnv(process.env);
  const worker = createDomainExpertWorker({
    roots,
    agentRouting,
    gcpProject: process.env.EXPERT_AGENTS_GCP_PROJECT,
    google: domainExpertGoogleConfigFromEnv(process.env),
    annas: domainExpertAnnasConfigFromEnv(process.env),
    notion: domainExpertNotionConfigFromEnv(process.env),
    ...(process.env.EXPERT_AGENTS_DOMAIN_EXPERT_DATA_DIR
      ? { dataDir: process.env.EXPERT_AGENTS_DOMAIN_EXPERT_DATA_DIR }
      : {}),
  });
  warnIfWorkerAuthDisabled('domain expert worker', authToken, hostname);

  Bun.serve({
    hostname,
    port,
    fetch: withWorkerBearerAuth(worker.fetch, { authToken }),
  });

  console.log(`Expert Agents domain expert worker listening on http://${hostname}:${port}/v1`);
  console.log(
    roots.length > 0
      ? `Configured domain expert workspace roots: ${roots.map((root) => root.rootId).join(', ')}.`
      : 'No workspace roots configured; workspace file tools, domain_source registry writes, and staged imports are disabled until EXPERT_AGENTS_DOMAIN_EXPERT_ROOTS_JSON is set. Serving (domain_ask) is unaffected.',
  );
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('EXPERT_AGENTS_DOMAIN_EXPERT_PORT must be an integer from 1 to 65535.');
  }
  return port;
}

if (import.meta.main) {
  main();
}
