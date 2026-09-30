import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateAgentRoutingConfig } from '../packages/runtime/src/core/agent-routing.ts';

// Static half of the container gate. The Docker build itself runs in CI
// (scripts/docker-smoke.sh); this keeps the invariants that make that image
// the same artifact the systemd runbook installs visible to every verify run,
// Docker or not.
const repositoryRoot = join(import.meta.dir, '..');
const read = (path: string) => readFile(join(repositoryRoot, path), 'utf8');
// Instructions only: prose in comments must not satisfy or trip an assertion.
const readInstructions = async (path: string) => (await read(path)).split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
const environmentIdentifier = /EXPERT_AGENTS_[A-Z0-9_]+/g;

describe('domain expert container image', () => {
  test('pins Bun 1.3.14 in every stage and never builds a second worker path', async () => {
    const dockerfile = await readInstructions('Dockerfile');
    const froms = dockerfile.split('\n').filter((line) => line.startsWith('FROM '));
    expect(froms.length).toBe(2);
    for (const line of froms) expect(line).toMatch(/^FROM oven\/bun:1\.3\.14(?:-slim)?(?: |$)/);
    expect(dockerfile).toContain('bun install --frozen-lockfile');
    expect(dockerfile).toContain('bun run package:deploy');
    expect(dockerfile).not.toContain('bun run build');
    expect(dockerfile).toContain('/src/dist/deploy-package /opt/expert-agents/current');
  });

  test('runs the packaged worker as the unprivileged service account on loopback', async () => {
    const dockerfile = await readInstructions('Dockerfile');
    const unit = await read('deploy/systemd/expert-agents-domain-expert.service');
    const execStart = /^ExecStart=\S+ (\S+)$/m.exec(unit)?.[1];
    expect(execStart).toBe('/opt/expert-agents/current/packages/runtime/dist/server.js');
    expect(dockerfile).toContain(`CMD ["bun", "${execStart}"]`);
    expect(dockerfile).toMatch(/^USER expert-agents$/m);
    expect(dockerfile).toContain('--uid 10001 --gid 10001');
    expect(dockerfile).toContain('EXPERT_AGENTS_DOMAIN_EXPERT_HOST=127.0.0.1');
    expect(dockerfile).not.toMatch(/^EXPOSE /m);
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).toContain('deploy/docker/healthcheck.js');
  });

  test('keeps secrets, dependencies and generated output out of the build context', async () => {
    const ignored = (await read('.dockerignore')).split('\n').map((line) => line.trim());
    for (const entry of ['.git', 'node_modules', '**/node_modules', 'dist', '**/dist', '.env', '.env.*', 'archive', 'migration']) {
      expect(ignored, `${entry} must be in .dockerignore`).toContain(entry);
    }
  });

  test('the health probe uses the bearer from the environment and the health document', async () => {
    const probe = await read('deploy/docker/healthcheck.js');
    expect(probe).toContain('EXPERT_AGENTS_DOMAIN_EXPERT_AUTH_TOKEN');
    expect(probe).toContain('/v1/health');
    expect(probe).toContain("'domain_expert_health'");
  });

  test('the public-expert environment example is documented and its routing validates', async () => {
    const example = await read('deploy/docker/domain-expert.container.env.example');
    const documented = new Set((await read('deploy/systemd/domain-expert.env.example')).match(environmentIdentifier) ?? []);
    const used = [...new Set(example.match(environmentIdentifier) ?? [])];
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((identifier) => !documented.has(identifier))).toEqual([]);

    const assignments = new Map(example.split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const));
    expect(assignments.get('EXPERT_AGENTS_DOMAIN_EXPERT_HOST')).toBe('127.0.0.1');
    expect(assignments.get('EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_METADATA_TOKEN')).toBe('1');
    expect(assignments.get('EXPERT_AGENTS_DOMAIN_EXPERT_AUTH_TOKEN')).toMatch(/^<.*>$/);

    const routing = validateAgentRoutingConfig(JSON.parse(assignments.get('EXPERT_AGENTS_DOMAIN_EXPERT_AGENTS_JSON')!));
    const entries = Object.values(routing);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.retrieval).toEqual({ multiQuery: true, reranker: 'rank-service' });
    expect(entries[0]!.disclosure).toEqual({ excludedSources: [] });
  });

  test('the smoke script disables networking and drops privileges', async () => {
    const smoke = await read('scripts/docker-smoke.sh');
    expect(smoke).toContain('--network none');
    expect(smoke).toContain('--read-only');
    expect(smoke).toContain('--cap-drop ALL');
    expect(smoke).toContain('uid=10001,gid=10001');
  });
});
