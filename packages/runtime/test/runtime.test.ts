import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_REPO_GITIGNORE, serializeScopeManifest } from '@expert-agents/library';
import { DirectHttpDomainExpertTransport, DomainExpertClient } from '../src/core/domain-expert-client.ts';
import {
  domainManifest,
  domainPolicy,
  planDomainAgent,
  planAnnasArchiveImport,
} from '../src/core/domain-expert.ts';
import { OperationError } from '../src/core/operation-error.ts';
import { validateAgentRoutingConfig } from '../src/core/agent-routing.ts';
import {
  createDomainExpertWorker as createRawDomainExpertWorker,
  DOMAIN_EXPERT_NOTION_CREDENTIAL_GUIDANCE,
  domainExpertRootsFromEnv,
  type DomainExpertWorkerOptions,
} from '../src/workers/domain-expert/index.ts';
import { TEST_AGENT_ROUTING } from './routing-fixture.ts';
import { ownerWordsIn } from '../../provisioning/src/owner-names.ts';

function createDomainExpertWorker(options: DomainExpertWorkerOptions = {}) {
  return createRawDomainExpertWorker({ agentRouting: TEST_AGENT_ROUTING, ...options });
}

const NONEXISTENT_CONNECT_COMMAND_PATTERN = new RegExp(
  `expert-agents ${'con'}nect\\s+(?:g${'cp'}|not${'ion'})`,
  'i',
);

describe('independent runtime identity', () => {
  test('default manifest is tenant-neutral and carries no legacy provider defaults', () => {
    const manifest = domainManifest();
    expect(manifest.domain_id).toBe('research');
    expect(manifest.display_name).toBe('Research Expert');
    expect(ownerWordsIn(JSON.stringify(manifest))).toEqual([]);
    expect(JSON.stringify(manifest)).not.toMatch(/olympus/i);
    expect(manifest).toMatchObject({
      allowed_gcs_prefixes: [],
      routing: { configured: false, source_env: 'EXPERT_AGENTS_DOMAIN_EXPERT_AGENTS_JSON' },
    });
    expect(domainPolicy()).toMatchObject({
      expert_agents_control_plane_only: true,
      raw_runtime_secrets_exposed: false,
    });
  });

  test('derives routing and the page library only from the configured agent manifest', () => {
    const manifest = domainManifest('history', undefined, {
      agentRouting: TEST_AGENT_ROUTING,
      env: {},
    });

    expect(manifest).toMatchObject({
      display_name: 'History Expert',
      allowed_gcs_prefixes: ['gs://fixture-shared-library/v1'],
      routing: {
        configured: true,
        library: { bucket: 'fixture-shared-library', prefix: 'v1', uri: 'gs://fixture-shared-library/v1' },
        page_library: { source_id: 'history' },
      },
    });
    expect(Object.keys(manifest)).not.toContain('corpora');
    expect(Object.keys(manifest)).not.toContain('retrieval');
    expect(Object.keys(manifest.routing)).not.toContain('target_corpus_display_name');
  });

  test('refuses unconfigured live cloud operations while preserving a marked dry-run plan', async () => {
    let cloudCalls = 0;
    const worker = createDomainExpertWorker({
      agentRouting: {},
      google: {
        accessToken: 'fixture-token',
        fetchImpl: (async () => {
          cloudCalls += 1;
          return new Response('{}', { status: 200 });
        }) as unknown as typeof fetch,
      },
    });

    const liveResponse = await worker.fetch(new Request('http://localhost/v1/domain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'domain_library', params: { action: 'catalog', domain_id: 'unconfigured' } }),
    }));
    expect(liveResponse.status).toBe(503);
    expect(await liveResponse.json()).toMatchObject({
      error: {
        code: 'agent_not_configured',
        message: expect.stringContaining('EXPERT_AGENTS_DOMAIN_EXPERT_AGENTS_JSON'),
      },
    });

    const planResponse = await worker.fetch(new Request('http://localhost/v1/domain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'annas_archive_import', params: { annas_archive_id: 'fixture-book', copyright_posture: 'approved_for_fixture', domain_id: 'unconfigured', dry_run: true } }),
    }));
    expect(planResponse.status).toBe(200);
    expect(await planResponse.json()).toMatchObject({
      kind: 'annas_archive_import_plan',
      status: 'dry_run_acquisition_ready',
      domain: { routing: { configured: false } },
    });
    expect(cloudCalls).toBe(0);
  });

  test('bootstrap plans an independent expert workspace', () => {
    const plan = planDomainAgent({ action: 'bootstrap', domainId: 'history', displayName: 'History Expert' });
    expect(plan).toMatchObject({
      kind: 'domain_agent_plan',
      domain: { domain_id: 'history', workspace_root_id: 'expert_agents_workspace' },
      openclaw_agent: { created_by_skill: 'expert-agent-workshop' },
    });
    expect(ownerWordsIn(JSON.stringify(plan))).toEqual([]);
    expect(JSON.stringify(plan)).not.toMatch(/olympus/i);
  });

  test('bootstrap hands over version control the control plane cannot run itself', () => {
    const plan = planDomainAgent({ action: 'bootstrap', domainId: 'history', displayName: 'History Expert' });
    const scaffold = (plan as Record<string, any>).workspace_scaffold;

    expect(scaffold.version_control).toMatchObject({
      required: true,
      first_commit_required: true,
      ignore_file: 'experts/history/.gitignore',
      remote: { required: true, visibility: 'private', wired_by_operator: true },
    });
    expect(scaffold.version_control.operator_commands).toContain('git init');
    expect(scaffold.version_control.operator_commands).toContain('git push -u origin HEAD');
    expect(scaffold.version_control.operator_commands)
      .toContain('git remote add origin <private-repository-url>');
    expect(scaffold.files).toContainEqual({
      relative_path: 'experts/history/.gitignore',
      kind: 'ignore_rules',
    });
    // No hosting account is assumed anywhere the plan is materialized.
    expect(JSON.stringify(plan)).not.toMatch(/github\.com/i);
  });

  test('acquisition plans use neutral destinations and runtime wording', () => {
    const plan = planAnnasArchiveImport({
      annasArchiveId: 'fixture-book',
      copyrightPosture: 'approved_for_fixture',
    });
    expect(plan).toMatchObject({
      acquisition: { destination: 'books_folder' },
    });
    expect(plan.ingest_pipeline).toContain('download approved file inside the configured runtime worker');
    expect(ownerWordsIn(JSON.stringify(plan))).toEqual([]);
  });
});

describe('ingest target planning follows the domain page library', () => {
  const ROUTED_MANIFEST = domainManifest('history', undefined, { agentRouting: TEST_AGENT_ROUTING });
  const UNROUTED_MANIFEST = domainManifest('unrouted', undefined, { agentRouting: TEST_AGENT_ROUTING });
  const ACQUISITION = {
    domainId: 'history',
    annasArchiveId: 'fixture-book',
    copyrightPosture: 'approved_for_fixture',
    ingest: true,
  };

  test('a domain with a page library plans the page library as the ingest target', () => {
    expect(planAnnasArchiveImport(ACQUISITION, ROUTED_MANIFEST).rag_ingest)
      .toEqual({ status: 'planned', target: 'page_library' });
  });

  test('a domain without a page library plans the ingest as blocked', () => {
    const plan = planAnnasArchiveImport({ ...ACQUISITION, domainId: 'unrouted' }, UNROUTED_MANIFEST);
    expect(plan.rag_ingest).toMatchObject({ status: 'blocked' });
    expect((plan.rag_ingest as Record<string, unknown>).target).toBeUndefined();
  });

  test('ingest not requested plans no target at all', () => {
    const plan = planAnnasArchiveImport({ ...ACQUISITION, ingest: false }, ROUTED_MANIFEST);
    expect(plan.rag_ingest).toEqual({ status: 'not_requested' });
  });
});

describe('bounded worker and client', () => {
  test('domain_agent status inspects workspace files and the scope manifest offline', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'expert-agents-status-'));
    const dataDir = join(fixture, 'data');
    const workspace = join(fixture, 'experts', 'history');
    const scopeManifestPath = join(fixture, 'scope.json');
    try {
      await mkdir(join(workspace, 'references'), { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(workspace, 'PROPOSAL.md'), '# History\n');
      await writeFile(scopeManifestPath, serializeScopeManifest({
        agentId: 'history',
        schemaVersion: 1,
        selection: {
          objectIds: [
            `sha256:${'1'.repeat(64)}`,
            `sha256:${'2'.repeat(64)}`,
          ],
        },
        targetCorpusDisplayName: 'history-library',
        masterRevision: 3,
      }));
      let fetchCalls = 0;
      const worker = createDomainExpertWorker({
        agentRouting: validateAgentRoutingConfig({
          history: {
            displayName: TEST_AGENT_ROUTING.history!.displayName,
            library: TEST_AGENT_ROUTING.history!.library,
            pageLibrary: TEST_AGENT_ROUTING.history!.pageLibrary,
            scopeManifestPath,
          },
        }),
        roots: [{ rootId: 'expert_agents_workspace', path: fixture, maxWriteBytes: 1024 * 1024, allowOverwrite: false }],
        dataDir,
        fetchImpl: (async () => {
          fetchCalls += 1;
          throw new Error('status must not call the network');
        }) as unknown as typeof fetch,
      });

      const response = await worker.fetch(new Request('http://localhost/v1/domain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool: 'domain_agent', params: { action: 'status', domain_id: 'history' } }),
      }));

      expect(response.status).toBe(200);
      const result = await response.json() as Record<string, any>;
      expect(result).toMatchObject({
        kind: 'domain_agent_status',
        status: 'completed',
        health: 'degraded',
        health_issues: [{
          code: 'workspace_seed_incomplete',
          missing_requirement_count: 10,
        }],
        inspection_scope: 'filesystem',
        cloud_calls_made: false,
        workspace: {
          relative_path: 'experts/history',
          exists: true,
          seeded_file_count: 1,
          seeded_file_total: 11,
          recommended_recovery: {
            action: 'bootstrap_missing_workspace_seed',
            tool: 'domain_agent',
            params: {
              action: 'bootstrap',
              domain_id: 'history',
              dry_run: false,
            },
          },
        },
        scope_manifest: {
          configured: true,
          present: true,
          parseable: true,
          agent_id: 'history',
          selected_object_count: 2,
        },
      });
      expect(result.workspace.seeded_files).toContainEqual({
        relative_path: 'experts/history/PROPOSAL.md',
        kind: 'operating_doctrine',
        exists: true,
      });
      expect(result.workspace.seeded_files).toContainEqual({
        relative_path: 'experts/history/domain.manifest.json',
        kind: 'domain_manifest',
        exists: false,
      });
      expect(result.workspace.missing_requirements).toHaveLength(10);
      expect(result.workspace.missing_requirements).toContainEqual({
        relative_path: 'experts/history/.gitignore',
        kind: 'ignore_rules',
      });

      const bootstrapResponse = await worker.fetch(new Request('http://localhost/v1/domain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tool: 'domain_agent',
          params: { action: 'bootstrap', domain_id: 'history', dry_run: false },
        }),
      }));
      expect(bootstrapResponse.status).toBe(200);
      const bootstrap = await bootstrapResponse.json() as Record<string, any>;
      expect(bootstrap.files).toHaveLength(11);
      expect(bootstrap.files).toContainEqual(expect.objectContaining({
        relative_path: 'experts/history/.gitignore',
        status: 'created',
      }));
      expect(await readFile(join(workspace, '.gitignore'), 'utf8')).toBe(AGENT_REPO_GITIGNORE);

      const recoveredResponse = await worker.fetch(new Request('http://localhost/v1/domain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool: 'domain_agent', params: { action: 'status', domain_id: 'history' } }),
      }));
      expect(recoveredResponse.status).toBe(200);
      expect(await recoveredResponse.json()).toMatchObject({
        kind: 'domain_agent_status',
        status: 'completed',
        health: 'healthy',
        health_issues: [],
        cloud_calls_made: false,
        workspace: {
          seeded_file_count: 11,
          seeded_file_total: 11,
          missing_requirements: [],
        },
      });
      expect(fetchCalls).toBe(0);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test('domain_agent status reports malformed configured scope files without exposing content', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'expert-agents-scope-status-'));
    const scopeManifestPath = join(fixture, 'scope.json');
    try {
      await writeFile(scopeManifestPath, 'private malformed fixture content');
      const worker = createDomainExpertWorker({
        roots: [{ rootId: 'expert_agents_workspace', path: fixture, maxWriteBytes: 1024, allowOverwrite: false }],
        agentRouting: validateAgentRoutingConfig({
          history: {
            displayName: TEST_AGENT_ROUTING.history!.displayName,
            library: TEST_AGENT_ROUTING.history!.library,
            pageLibrary: TEST_AGENT_ROUTING.history!.pageLibrary,
            scopeManifestPath,
          },
        }),
      });

      const response = await worker.fetch(new Request('http://localhost/v1/domain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool: 'domain_agent', params: { action: 'status', domain_id: 'history' } }),
      }));
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, any>;
      expect(body).toMatchObject({
        status: 'completed',
        health: 'degraded',
        health_issues: [
          expect.objectContaining({ code: 'workspace_missing' }),
          expect.objectContaining({ code: 'workspace_seed_incomplete' }),
          expect.objectContaining({ code: 'scope_manifest_unparseable' }),
        ],
      });
      expect(body.scope_manifest).toEqual({ configured: true, present: true, parseable: false });
      expect(JSON.stringify(body)).not.toContain('private malformed fixture content');
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test('health and dry-run tool responses expose the bounded policy', async () => {
    const worker = createDomainExpertWorker();
    const health = await worker.fetch(new Request('http://localhost/v1/health'));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ policy: { expert_agents_control_plane_only: true } });

    const response = await worker.fetch(new Request('http://localhost/v1/domain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'domain_agent', params: { action: 'bootstrap', domain_id: 'history' } }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'domain_agent_plan', domain: { domain_id: 'history' } });
  });

  test('client refuses a response that lacks the policy contract', async () => {
    const client = new DomainExpertClient(
      { domainExpert: { enabled: true, baseUrl: 'http://127.0.0.1:8040/v1', requestTimeoutSeconds: 1 } },
      { requestJson: async () => ({}) },
    );
    await expect(client.run('domain_agent', { action: 'status' })).rejects.toMatchObject({ code: 'domain_expert_error' });
  });

  test('client reads the worker health report under the same policy contract', async () => {
    const worker = createDomainExpertWorker();
    const requests: string[] = [];
    const config = { domainExpert: { enabled: true, baseUrl: 'http://worker.test/v1', requestTimeoutSeconds: 1 } };
    const client = new DomainExpertClient(config, { requestJson: async (url, init) => {
      requests.push(`${init.method} ${url}`);
      return (await worker.fetch(new Request(url, init))).json();
    } });
    expect(await client.health()).toMatchObject({ kind: 'domain_expert_health', configuration_status: { google: expect.any(String) } });
    expect(requests).toEqual(['GET http://worker.test/v1/health']);
    await expect(new DomainExpertClient(config, { requestJson: async () => ({}) }).health()).rejects.toMatchObject({ code: 'domain_expert_error' });
  });

  test('client requires the independent worker contract and rejects a legacy endpoint', async () => {
    const clientFor = (policy: Record<string, unknown>) => new DomainExpertClient(
      { domainExpert: { enabled: true, baseUrl: 'http://127.0.0.1:8040/v1', requestTimeoutSeconds: 1 } },
      { requestJson: async () => ({ policy }) },
    );
    const status = { action: 'status', domain_id: 'history' };

    await expect(clientFor({ olympus_control_plane_only: true, raw_runtime_secrets_exposed: false })
      .run('domain_agent', status)).rejects.toMatchObject({ code: 'domain_expert_error' });
    expect(await clientFor(domainPolicy()).run('domain_agent', status))
      .toMatchObject({ policy: { expert_agents_control_plane_only: true } });
    await expect(clientFor({ raw_runtime_secrets_exposed: false }).run('domain_agent', status))
      .rejects.toMatchObject({ code: 'domain_expert_error' });
    await expect(clientFor({ olympus_control_plane_only: true, raw_runtime_secrets_exposed: true })
      .run('domain_agent', status)).rejects.toMatchObject({ code: 'domain_expert_error' });
  });

  test('a configured default domain id fills an omitted domain_id and never overrides an explicit one', async () => {
    // Live model traffic sometimes omits domain_id, and this runtime routes no
    // default domain of its own, so the omission fails closed at the worker.
    // The deployment default travels with the request instead.
    const sent: Array<Record<string, unknown>> = [];
    const transport = {
      requestJson: async (_url: string, init: RequestInit) => {
        sent.push((JSON.parse(String(init.body)) as { params: Record<string, unknown> }).params);
        return { policy: domainPolicy() };
      },
    };
    const configured = (defaultDomainId?: string) => ({
      domainExpert: {
        enabled: true,
        baseUrl: 'http://127.0.0.1:8040/v1',
        requestTimeoutSeconds: 1,
        ...(defaultDomainId ? { defaultDomainId } : {}),
      },
    });

    const withDefault = new DomainExpertClient(configured('governance'), transport);
    await withDefault.run('domain_library', { question: 'Fixture question' });
    await withDefault.run('domain_library', { question: 'Fixture question', domain_id: 'history' });
    await withDefault.run('domain_library', { question: 'Fixture question', domain_id: '   ' });
    await new DomainExpertClient(configured(), transport).run('domain_library', { question: 'Fixture question' });

    expect(sent).toEqual([
      { question: 'Fixture question', domain_id: 'governance' },
      { question: 'Fixture question', domain_id: 'history' },
      { question: 'Fixture question', domain_id: 'governance' },
      { question: 'Fixture question' },
    ]);
  });

  test('transport adds no authorization header when no token is configured', async () => {
    let authorization: string | null = 'unobserved';
    const transport = new DirectHttpDomainExpertTransport(async (_url, init) => {
      authorization = new Headers(init.headers).get('authorization');
      return Response.json({ policy: domainPolicy() });
    });
    await transport.requestJson('http://127.0.0.1/v1/domain', { method: 'POST' });
    expect(authorization).toBeNull();
  });
});

async function collectTextFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      // Built output is scanned by scripts/verify-built-artifacts.ts after the
      // build step; scanning it here depends on whatever stale dist/ the local
      // checkout happens to hold, and on CI (tests run pre-build) none exists.
      if (entry.name === 'dist' || entry.name === 'node_modules') continue;
      files.push(...await collectTextFiles(path));
    } else if (entry.isFile() && ['.ts', '.js', '.json', '.md'].includes(extname(entry.name))) {
      files.push(path);
    }
  }
  return files.sort();
}

describe('configuration boundaries', () => {
  test('active runtime sources contain no per-domain bucket generation template', async () => {
    const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const runtimeSourceFiles = await collectTextFiles(join(repositoryRoot, 'packages/runtime/src'));
    const legacyTemplate = `gs://${['expert', 'agents'].join('-')}-${'${domainId}'}-rag`;
    const violations = [];
    for (const file of runtimeSourceFiles) {
      if ((await readFile(file, 'utf8')).includes(legacyTemplate)) {
        violations.push(file.slice(repositoryRoot.length + 1));
      }
    }
    expect(violations).toEqual([]);
  });

  test('active package text and built operator surfaces pass the runtime truth string gate', async () => {
    const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const activePackageFiles = await collectTextFiles(join(repositoryRoot, 'packages'));
    const violations = [];
    for (const file of activePackageFiles) {
      const content = await readFile(file, 'utf8');
      if (ownerWordsIn(content).length > 0 || NONEXISTENT_CONNECT_COMMAND_PATTERN.test(content)) {
        violations.push(file.slice(repositoryRoot.length + 1));
      }
    }
    expect(violations).toEqual([]);

    const builtSurfaces = JSON.stringify({
      notionGuidance: DOMAIN_EXPERT_NOTION_CREDENTIAL_GUIDANCE,
      acquisitionPlan: planAnnasArchiveImport({
        annasArchiveId: 'fixture-book',
        copyrightPosture: 'approved_for_fixture',
      }),
    });
    expect(ownerWordsIn(builtSurfaces)).toEqual([]);
    expect(builtSurfaces).not.toMatch(NONEXISTENT_CONNECT_COMMAND_PATTERN);
  });

  test('operator credential guidance names real environment fields and no nonexistent connect commands', () => {
    expect(DOMAIN_EXPERT_NOTION_CREDENTIAL_GUIDANCE).toContain('EXPERT_AGENTS_DOMAIN_EXPERT_NOTION_TOKEN');
    expect(DOMAIN_EXPERT_NOTION_CREDENTIAL_GUIDANCE).toContain('deploy/systemd/domain-expert.env.example');
    expect(DOMAIN_EXPERT_NOTION_CREDENTIAL_GUIDANCE).not.toMatch(/expert-agents connect/i);
  });

  test('workspace roots parse from the Expert Agents namespace', () => {
    const roots = domainExpertRootsFromEnv({
      EXPERT_AGENTS_DOMAIN_EXPERT_ROOTS_JSON: JSON.stringify({
        library: { path: '/tmp/example-library', max_write_bytes: 1024, allow_overwrite: false },
      }),
    });
    expect(roots).toEqual([{ rootId: 'library', path: '/tmp/example-library', maxWriteBytes: 1024, allowOverwrite: false }]);
  });

  test('disabled client fails explicitly', async () => {
    const client = new DomainExpertClient({
      domainExpert: { enabled: false, baseUrl: 'http://127.0.0.1:8040/v1', requestTimeoutSeconds: 1 },
    });
    await expect(client.run('domain_agent', { action: 'status' })).rejects.toBeInstanceOf(OperationError);
  });
});
