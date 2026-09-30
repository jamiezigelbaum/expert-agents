// Container health probe for the domain expert worker. Runs inside the
// container, so the bearer token never leaves the container environment and
// the probe works with networking disabled. Exit 0 only when the worker
// answers GET /v1/health with its own health document.
const host = process.env.EXPERT_AGENTS_DOMAIN_EXPERT_HOST || '127.0.0.1';
const port = process.env.EXPERT_AGENTS_DOMAIN_EXPERT_PORT || '8040';
const token = process.env.EXPERT_AGENTS_DOMAIN_EXPERT_AUTH_TOKEN;
const origin = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
try {
  const response = await fetch(`${origin}/v1/health`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(4000),
  });
  const body = await response.json();
  process.exit(response.ok && body && body.kind === 'domain_expert_health' && body.reachable === true ? 0 : 1);
} catch {
  process.exit(1);
}
