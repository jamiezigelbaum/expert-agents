import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_REPO_GITIGNORE, serializeScopeManifest } from '@expert-agents/library';
import {
  DOMAIN_EXPERT_GOOGLE_CREDENTIAL_GUIDANCE,
  connectGcpSource,
  validateServiceAccountKey,
} from '../src/core/connect-gcp.ts';
import { DirectHttpDomainExpertTransport, DomainExpertClient } from '../src/core/domain-expert-client.ts';
import {
  DOMAIN_ASK_RETRIEVAL_DEFAULTS,
  domainManifest,
  domainPolicy,
  planDomainAgent,
  planDomainAsk,
  planDomainSource,
  planAnnasArchiveImport,
  planRagCorpus,
} from '../src/core/domain-expert.ts';
import { OperationError } from '../src/core/operation-error.ts';
import { validateAgentRoutingConfig } from '../src/core/agent-routing.ts';
import {
  createDomainExpertWorker as createRawDomainExpertWorker,
  DOMAIN_EXPERT_NOTION_CREDENTIAL_GUIDANCE,
  domainExpertGoogleConfigFromEnv,
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
      corpora: [],
      routing: { configured: false, source_env: 'EXPERT_AGENTS_DOMAIN_EXPERT_AGENTS_JSON' },
    });
    expect(domainPolicy()).toMatchObject({
      expert_agents_control_plane_only: true,
      raw_runtime_secrets_exposed: false,
    });
  });

  test('the RAG location is us-central1 unless the environment names another region', () => {
    expect(domainManifest('history', undefined, { agentRouting: TEST_AGENT_ROUTING, env: {} }).rag_location).toBe('us-central1');
    expect(domainManifest('history', undefined, {
      agentRouting: TEST_AGENT_ROUTING,
      env: { EXPERT_AGENTS_DOMAIN_EXPERT_RAG_LOCATION: 'europe-west4' },
    }).rag_location).toBe('europe-west4');
    for (const invalid of ['us', 'US-CENTRAL1', 'projects/x/locations/us-central1', 'us-central1/']) {
      expect(() => domainManifest('history', undefined, {
        agentRouting: TEST_AGENT_ROUTING,
        env: { EXPERT_AGENTS_DOMAIN_EXPERT_RAG_LOCATION: invalid },
      })).toThrow('EXPERT_AGENTS_DOMAIN_EXPERT_RAG_LOCATION');
    }
  });

  test('derives cloud routing and retrieval only from configured agent manifest', () => {
    const manifest = domainManifest('history', undefined, {
      agentRouting: TEST_AGENT_ROUTING,
      env: { EXPERT_AGENTS_GCP_PROJECT: 'fixture-project' },
    });

    expect(manifest).toMatchObject({
      display_name: 'History Expert',
      gcp_project: 'fixture-project',
      allowed_gcs_prefixes: ['gs://fixture-shared-library/v1'],
      corpora: [{ id: 'history-library' }],
      routing: {
        configured: true,
        library: { bucket: 'fixture-shared-library', prefix: 'v1', uri: 'gs://fixture-shared-library/v1' },
        target_corpus_display_name: 'history-library',
      },
      retrieval: {
        candidate_top_k: 18,
        synthesis_context_limit: 7,
        reranker: 'off',
        multi_query: false,
      },
    });
    expect(planRagCorpus({ action: 'create', domainId: 'history' }, manifest)).toMatchObject({
      status: 'dry_run_corpus_lifecycle_ready',
      corpus: { corpus_id: 'history-library', routing_configured: true },
      allowed_gcs_prefixes: ['gs://fixture-shared-library/v1'],
    });
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
      body: JSON.stringify({ tool: 'domain_ask', params: { domain_id: 'unconfigured', question: 'Fixture question?' } }),
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
      body: JSON.stringify({ tool: 'rag_corpus', params: { action: 'create', domain_id: 'unconfigured', dry_run: true } }),
    }));
    expect(planResponse.status).toBe(200);
    expect(await planResponse.json()).toMatchObject({
      kind: 'rag_corpus_plan',
      status: 'dry_run_agent_not_configured',
      corpus: { routing_configured: false },
      allowed_gcs_prefixes: [],
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

// The planner used to resolve ingest targets on its own: a dry run reported no
// target while the identical live request imported into the domain's routing
// corpus. Planning and execution now share one resolver, so these assert the
// target the worker would choose.
describe('ingest target resolution is the same when planning and when executing', () => {
  const ROUTED_MANIFEST = domainManifest('history', undefined, { agentRouting: TEST_AGENT_ROUTING });
  const UNROUTED_MANIFEST = domainManifest('unrouted', undefined, { agentRouting: TEST_AGENT_ROUTING });
  const ACQUISITION = {
    domainId: 'history',
    annasArchiveId: 'fixture-book',
    copyrightPosture: 'approved_for_fixture',
    ingest: true,
  };

  test('an explicit corpus_id is planned as the request choice', () => {
    const plan = planAnnasArchiveImport({ ...ACQUISITION, corpusId: 'named-corpus' }, ROUTED_MANIFEST);
    expect(plan.rag_ingest).toEqual({
      status: 'planned',
      target_corpus_id: 'named-corpus',
      target_corpus_source: 'request',
    });
  });

  test('no corpus_id on a configured domain is planned as the routing default', () => {
    const plan = planAnnasArchiveImport(ACQUISITION, ROUTED_MANIFEST);
    expect(plan.rag_ingest).toEqual({
      status: 'planned',
      target_corpus_id: 'history-library',
      target_corpus_source: 'domain_default',
    });
    expect(ROUTED_MANIFEST.corpora[0]!.id).toBe('history-library');
  });

  test('no corpus_id and no configured corpus stays the undecidable case', () => {
    const plan = planAnnasArchiveImport({ ...ACQUISITION, domainId: 'unrouted' }, UNROUTED_MANIFEST);
    expect(plan.rag_ingest).toMatchObject({ status: 'needs_corpus_decision' });
    expect((plan.rag_ingest as Record<string, unknown>).target_corpus_id).toBeUndefined();
  });

  test('ingest not requested plans no target at all', () => {
    const plan = planAnnasArchiveImport({ ...ACQUISITION, ingest: false }, ROUTED_MANIFEST);
    expect(plan.rag_ingest).toEqual({ status: 'not_requested' });
  });

  // Same divergence class in the rag_corpus planner: it refused an import the
  // worker resolves to the routing corpus and runs.
  test('web_import and notion_import plan the routing corpus rather than refusing', () => {
    expect(planRagCorpus({ action: 'web_import', domainId: 'history', urls: ['https://example.test/a'] }, ROUTED_MANIFEST))
      .toMatchObject({ corpus: { corpus_id: 'history-library', web_import: { target_corpus_id: 'history-library' } } });
    expect(planRagCorpus({ action: 'notion_import', domainId: 'history', pageIds: ['fixture-page'] }, ROUTED_MANIFEST))
      .toMatchObject({ corpus: { corpus_id: 'history-library', notion_import: { target_corpus_id: 'history-library' } } });
  });

  test('web_import and notion_import still require corpus_id with no configured corpus', () => {
    expect(() => planRagCorpus({ action: 'web_import', domainId: 'unrouted', urls: ['https://example.test/a'] }, UNROUTED_MANIFEST))
      .toThrow(/web_import requires corpus_id/);
    expect(() => planRagCorpus({ action: 'notion_import', domainId: 'unrouted', pageIds: ['fixture-page'] }, UNROUTED_MANIFEST))
      .toThrow(/notion_import requires corpus_id/);
  });
});

describe('bounded worker and client', () => {
  test('web_import dry run reports derived metadata without changing workspace bytes', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'expert-agents-web-dry-run-'));
    const dataDir = join(fixture, 'data');
    const manifest = domainManifest('history', undefined, { env: { EXPERT_AGENTS_GCP_PROJECT: 'fixture-project' } });
    // The corpus the `history` fixture domain is routed to: a web_import plan
    // may only target a corpus configured for its domain.
    const corpusId = 'history-library';
    const mappingKey = `${manifest.gcp_project}/${manifest.rag_location}/${corpusId}`;
    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, 'rag-corpus-mapping.json'), JSON.stringify({
        version: 1,
        corpora: {
          [mappingKey]: {
            display_name: corpusId,
            corpus_id: 'corpus-1',
            resource_name: `projects/${manifest.gcp_project}/locations/${manifest.rag_location}/ragCorpora/corpus-1`,
            project: manifest.gcp_project,
            location: manifest.rag_location,
            updated_at: '2026-07-22T00:00:00.000Z',
          },
        },
      }));
      const before = await snapshotDirectory(fixture);
      const worker = createDomainExpertWorker({
        gcpProject: 'fixture-project',
        roots: [{ rootId: 'expert_agents_workspace', path: fixture, maxWriteBytes: 1024 * 1024, allowOverwrite: false }],
        dataDir,
        resolveHostImpl: async () => ['93.184.216.34'],
        webImportFetchImpl: async () => new Response(
          '<html><head><title>Fixture Page</title></head><body><main><p>Grounded fixture text.</p></main></body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        ),
        summarizeBin: '/neutral/bin/summarize',
        summarizeExtract: async () => ({ exitCode: 0, stdout: 'Grounded fixture text.\n', stderr: '' }),
      });

      const response = await worker.fetch(new Request('http://localhost/v1/domain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tool: 'rag_corpus',
          params: {
            action: 'web_import',
            domain_id: 'history',
            corpus_id: corpusId,
            urls: ['https://example.com/article'],
            batch_id: 'dry-run-fixture',
            dry_run: true,
          },
        }),
      }));

      expect(response.status).toBe(200);
      const result = await response.json() as Record<string, any>;
      expect(result).toMatchObject({
        kind: 'rag_corpus_web_import_plan',
        status: 'dry_run_web_import_ready',
        eligible_file_count: 1,
        derived_files: [{
          kind: 'html',
          workspace_relative_path: 'experts/history/sources/web-imports/dry-run-fixture/fixture-page.md',
        }],
      });
      expect(result.derived_files[0].bytes).toBeGreaterThan(0);
      expect(result.derived_files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(await snapshotDirectory(fixture)).toEqual(before);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test('domain plans promise only returned answer fields and registration-only source effects', () => {
    const askPlan = planDomainAsk({ question: 'What changed?' });
    expect(askPlan.expected_output).toEqual({ answer: true, citations: true });

    const sourcePlan = planDomainSource({
      action: 'add',
      domainId: 'history',
      url: 'https://example.com/source',
    });
    expect(sourcePlan).toMatchObject({
      status: 'dry_run_source_registration_ready',
      source_record: { ingest_status: 'not_ingested' },
      registration_effects: ['append source-registry.jsonl and ingest-log.md'],
      ingestion: {
        performed_by_domain_source_add: false,
        available_via: [
          'rag_corpus stage_import or import',
          'rag_corpus web_import',
          'rag_corpus notion_import',
          'annas_archive_import',
        ],
      },
    });
    expect(sourcePlan).not.toHaveProperty('ingest_pipeline');
  });

  test('domain_ask plan reports the execution defaults from the shared retrieval constants', () => {
    const executionDefaults = domainExpertGoogleConfigFromEnv({});
    expect(executionDefaults).toMatchObject({
      retrievalTopK: DOMAIN_ASK_RETRIEVAL_DEFAULTS.candidateTopK,
      answerContextLimit: DOMAIN_ASK_RETRIEVAL_DEFAULTS.synthesisContextLimit,
      reranker: DOMAIN_ASK_RETRIEVAL_DEFAULTS.reranker,
      multiQuery: DOMAIN_ASK_RETRIEVAL_DEFAULTS.multiQuery,
    });
    expect(planDomainAsk({ question: 'What changed?' })).toMatchObject({
      kind: 'domain_ask_plan',
      status: 'runtime_execution_available',
      retrieval: {
        backend: 'vertex-rag',
        configuration_required: true,
        candidate_top_k: DOMAIN_ASK_RETRIEVAL_DEFAULTS.candidateTopK,
        synthesis_context_limit: DOMAIN_ASK_RETRIEVAL_DEFAULTS.synthesisContextLimit,
        reranker: {
          mode: DOMAIN_ASK_RETRIEVAL_DEFAULTS.reranker,
          model: DOMAIN_ASK_RETRIEVAL_DEFAULTS.rerankerModel,
        },
        multi_query: {
          enabled: DOMAIN_ASK_RETRIEVAL_DEFAULTS.multiQuery,
          max_queries: DOMAIN_ASK_RETRIEVAL_DEFAULTS.maxQueries,
        },
      },
    });
  });

  test('domain_ask rejects max_results outside the bounded positive-integer range', async () => {
    for (const maxResults of [0, -1, 1.5, DOMAIN_ASK_RETRIEVAL_DEFAULTS.maxResultsCap + 1]) {
      let error: unknown;
      try {
        planDomainAsk({ question: 'What changed?', maxResults });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'invalid_params' });
    }
    expect(() => planDomainAsk({ question: 'What changed?', maxResults: 1 })).not.toThrow();
    expect(() => planDomainAsk({
      question: 'What changed?',
      maxResults: DOMAIN_ASK_RETRIEVAL_DEFAULTS.maxResultsCap,
    })).not.toThrow();

    const worker = createDomainExpertWorker();
    const response = await worker.fetch(new Request('http://localhost/v1/domain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'domain_ask', params: { question: 'What changed?', max_results: 0 } }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_params' } });
  });

  test('domain_agent status inspects workspace files, source records, tombstones, and corpus mappings offline', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'expert-agents-status-'));
    const dataDir = join(fixture, 'data');
    const workspace = join(fixture, 'experts', 'history');
    const scopeManifestPath = join(fixture, 'scope.json');
    try {
      await mkdir(join(workspace, 'references'), { recursive: true });
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(workspace, 'PROPOSAL.md'), '# History\n');
      await writeFile(join(workspace, 'references', 'source-registry.jsonl'), [
        JSON.stringify({ source_id: 'source-1', ingest_status: 'registered' }),
        JSON.stringify({ source_id: 'source-1', ingest_status: 'removed', removed: true }),
        JSON.stringify({ source_id: 'source-2', ingest_status: 'registered' }),
        '',
      ].join('\n'));
      await writeFile(join(dataDir, 'rag-corpus-mapping.json'), JSON.stringify({
        version: 1,
        corpora: { first: {}, second: {} },
      }));
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
            targetCorpusDisplayName: TEST_AGENT_ROUTING.history!.targetCorpusDisplayName,
            retrieval: TEST_AGENT_ROUTING.history!.retrieval,
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
          seeded_file_count: 2,
          seeded_file_total: 12,
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
        source_registry: { exists: true, record_count: 3, tombstone_count: 1, malformed_line_count: 0 },
        corpus_mapping_cache: { exists: true, readable: true, entry_count: 2 },
        scope_manifest: {
          configured: true,
          present: true,
          parseable: true,
          agent_id: 'history',
          selected_object_count: 2,
          target_corpus_display_name: 'history-library',
          target_matches_routing: true,
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
      expect(bootstrap.files).toHaveLength(12);
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
          seeded_file_count: 12,
          seeded_file_total: 12,
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
            targetCorpusDisplayName: TEST_AGENT_ROUTING.history!.targetCorpusDisplayName,
            retrieval: TEST_AGENT_ROUTING.history!.retrieval,
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
          expect.objectContaining({ code: 'source_registry_missing' }),
          expect.objectContaining({ code: 'corpus_mapping_cache_missing' }),
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
    await withDefault.run('domain_ask', { question: 'Fixture question' });
    await withDefault.run('domain_ask', { question: 'Fixture question', domain_id: 'history' });
    await withDefault.run('domain_ask', { question: 'Fixture question', domain_id: '   ' });
    await new DomainExpertClient(configured(), transport).run('domain_ask', { question: 'Fixture question' });

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

async function snapshotDirectory(root: string, relativePath = ''): Promise<Array<[string, 'directory' | 'file', string?]>> {
  const directory = join(root, relativePath);
  const entries = await readdir(directory, { withFileTypes: true });
  const snapshot: Array<[string, 'directory' | 'file', string?]> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      snapshot.push([entryRelativePath, 'directory']);
      snapshot.push(...await snapshotDirectory(root, entryRelativePath));
    } else if (entry.isFile()) {
      snapshot.push([entryRelativePath, 'file', Buffer.from(await readFile(join(root, entryRelativePath))).toString('base64')]);
    }
  }
  return snapshot;
}

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
      googleGuidance: DOMAIN_EXPERT_GOOGLE_CREDENTIAL_GUIDANCE,
      notionGuidance: DOMAIN_EXPERT_NOTION_CREDENTIAL_GUIDANCE,
      askPlan: planDomainAsk({ question: 'Fixture question' }),
      sourcePlan: planDomainSource({ action: 'add', url: 'https://example.com/source' }),
      acquisitionPlan: planAnnasArchiveImport({
        annasArchiveId: 'fixture-book',
        copyrightPosture: 'approved_for_fixture',
      }),
    });
    expect(ownerWordsIn(builtSurfaces)).toEqual([]);
    expect(builtSurfaces).not.toMatch(NONEXISTENT_CONNECT_COMMAND_PATTERN);
  });

  test('operator credential guidance names real environment fields and no nonexistent connect commands', async () => {
    expect(DOMAIN_EXPERT_GOOGLE_CREDENTIAL_GUIDANCE).toContain('EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_JSON');
    expect(DOMAIN_EXPERT_GOOGLE_CREDENTIAL_GUIDANCE).toContain('EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_JSON_FILE');
    expect(DOMAIN_EXPERT_GOOGLE_CREDENTIAL_GUIDANCE).toContain('EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_ACCESS_TOKEN');
    expect(DOMAIN_EXPERT_NOTION_CREDENTIAL_GUIDANCE).toContain('EXPERT_AGENTS_DOMAIN_EXPERT_NOTION_TOKEN');
    for (const guidance of [DOMAIN_EXPERT_GOOGLE_CREDENTIAL_GUIDANCE, DOMAIN_EXPERT_NOTION_CREDENTIAL_GUIDANCE]) {
      expect(guidance).toContain('deploy/systemd/domain-expert.env.example');
      expect(guidance).not.toMatch(/expert-agents connect/i);
    }

    const dryRun = await connectGcpSource({
      project: 'expert-agents-test1',
      serviceAccount: 'expert-agents-runtime',
      dryRun: true,
      secretStore: { get: () => undefined, set: () => undefined },
    });
    expect(JSON.stringify(dryRun)).not.toMatch(/expert-agents connect/i);
  });

  test('workspace roots parse from the Expert Agents namespace', () => {
    const roots = domainExpertRootsFromEnv({
      EXPERT_AGENTS_DOMAIN_EXPERT_ROOTS_JSON: JSON.stringify({
        library: { path: '/tmp/example-library', max_write_bytes: 1024, allow_overwrite: false },
      }),
    });
    expect(roots).toEqual([{ rootId: 'library', path: '/tmp/example-library', maxWriteBytes: 1024, allowOverwrite: false }]);
  });

  test('GCP dry-run never reads or writes credentials', async () => {
    let secretCalls = 0;
    const result = await connectGcpSource({
      project: 'expert-agents-test1',
      serviceAccount: 'expert-agents-runtime',
      dryRun: true,
      secretStore: {
        get: () => { secretCalls += 1; return undefined; },
        set: () => { secretCalls += 1; },
      },
    });
    expect(result.ok).toBe(true);
    expect(secretCalls).toBe(0);
    expect(result.messages.join('\n')).not.toMatch(/olympus/i);
  });

  test('stored GCP credential must carry an https token_uri', () => {
    const base = {
      type: 'service_account',
      project_id: 'expert-agents-test1',
      client_email: 'runtime@expert-agents-test1.iam.gserviceaccount.com',
      // Satisfies the validator's "PRIVATE KEY" check without tripping the
      // repository's high-confidence secret scan on a real PEM header.
      private_key: 'fixture PRIVATE KEY material',
    };
    const email = base.client_email;

    expect(validateServiceAccountKey(JSON.stringify(base), email).token_uri).toBeUndefined();
    expect(
      validateServiceAccountKey(JSON.stringify({ ...base, token_uri: 'https://oauth2.example.invalid/token' }), email).token_uri,
    ).toBe('https://oauth2.example.invalid/token');
    expect(() => validateServiceAccountKey(
      JSON.stringify({ ...base, token_uri: 'http://token-sink.example.invalid/token' }),
      email,
    )).toThrow(/token_uri must be an https URL/);
    expect(() => validateServiceAccountKey(
      JSON.stringify({ ...base, token_uri: 42 }),
      email,
    )).toThrow(/token_uri must be an https URL/);
  });

  test('disabled client fails explicitly', async () => {
    const client = new DomainExpertClient({
      domainExpert: { enabled: false, baseUrl: 'http://127.0.0.1:8040/v1', requestTimeoutSeconds: 1 },
    });
    await expect(client.run('domain_agent', { action: 'status' })).rejects.toBeInstanceOf(OperationError);
  });
});
