import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAgentRoutingConfig } from '../src/core/agent-routing.ts';
import { AgentRegistrationStore } from '../src/core/agent-registration.ts';
import { canonicalJson } from '@expert-agents/library';
import { createDomainExpertWorker } from '../src/workers/domain-expert/index.ts';

const library = { bucket: 'neutral-library', prefix: 'factory' };
const route = { library: { ...library, prefix: 'factory/history' }, targetCorpusDisplayName: 'history-library' };
const corpus = 'projects/neutral-project/locations/us-central1/ragCorpora/123';
const creationOperation = 'projects/neutral-project/locations/us-central1/operations/create-1';

function fixture(options: { enabled?: boolean; configured?: boolean; networkFailure?: boolean; operationName?: string; projectNumber?: string; projectId?: string; projectLookupStatus?: number; creationResponse?: unknown } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-registration-'));
  const calls: string[] = [];
  let listed = false;
  let state = 'INITIALIZED';
  let duplicates = false;
  let listedDisplayName = route.targetCorpusDisplayName;
  const operationName = options.operationName ?? creationOperation;
  let operationResponse: unknown = { name: operationName, done: false };
  let projectLookupStatus = options.projectLookupStatus ?? 200;
  const workerOptions = {
    dataDir, gcpProject: 'neutral-project',
    ...(options.enabled === false ? {} : { registrationLibrary: library }),
    agentRouting: validateAgentRoutingConfig(options.configured ? { history: route } : {}),
    google: { accessToken: 'synthetic-token', fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (url.endsWith('/ragCorpora') && method === 'GET') return Response.json({ ragCorpora: listed ? [
        { name: corpus, displayName: listedDisplayName },
        ...(duplicates ? [{ name: corpus.replace('/123', '/456'), displayName: route.targetCorpusDisplayName }] : []),
      ] : [] });
      if (url.endsWith('/ragCorpora') && method === 'POST') {
        if (options.networkFailure) throw new Error('synthetic timeout');
        return Response.json(options.creationResponse ?? { name: operationName, done: false });
      }
      if (url === `https://us-central1-aiplatform.googleapis.com/v1/${operationName}`) return Response.json(operationResponse);
      if (url === 'https://cloudresourcemanager.googleapis.com/v1/projects/neutral-project') return projectLookupStatus === 200
        ? Response.json({ projectId: options.projectId ?? 'neutral-project', projectNumber: options.projectNumber ?? '987654321' })
        : Response.json({ error: { message: 'synthetic private Resource Manager failure' } }, { status: projectLookupStatus });
      if (url.endsWith('/ragCorpora/123')) return Response.json({ name: corpus, corpusStatus: { state } });
      throw new Error('unexpected upstream request');
    }) as typeof fetch },
  };
  let worker = createDomainExpertWorker(workerOptions);
  const request = async (tool: string, params: Record<string, unknown>) => {
    const response = await worker.fetch(new Request('http://worker.test/v1/domain', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool, params }),
    }));
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  return {
    calls, dataDir, request,
    register: (extra: Record<string, unknown> = {}) => request('domain_agent', {
      action: 'register', domain_id: 'history', library: route.library, target_corpus_display_name: route.targetCorpusDisplayName,
      approval_id: 'factory-operation-1', dry_run: false, ...extra,
    }),
    ensure: (extra: Record<string, unknown> = {}) => request('rag_corpus', {
      action: 'ensure', domain_id: 'history', approval_id: 'factory-operation-1', dry_run: false, ...extra,
    }),
    restart() { worker = createDomainExpertWorker(workerOptions); },
    provider(nextState: string, duplicate = false, displayName = route.targetCorpusDisplayName) { listed = true; state = nextState; duplicates = duplicate; listedDisplayName = displayName; },
    operation(response: unknown) { operationResponse = response; },
    projectLookup(status: number) { projectLookupStatus = status; },
    receipt() {
      const directory = join(dataDir, 'corpus-creations');
      return JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]!), 'utf8'));
    },
    cleanup() { rmSync(dataDir, { recursive: true, force: true }); },
  };
}

describe('operator-bounded durable agent registration', () => {
  test('old stored registrations compute the same client-receipt default as new requests', async () => {
    const f = fixture();
    try {
      const directory = join(f.dataDir, 'agent-registrations');
      mkdirSync(directory, { recursive: true });
      const original = canonicalJson(route);
      writeFileSync(join(directory, 'history.json'), original);
      const store = new AgentRegistrationStore(f.dataDir, validateAgentRoutingConfig({}), library);
      expect(store.routes().history!.ingestion).toEqual({ importResultSink: 'client' });
      expect(store.register('history', route, false).existing).toBe(true);
      f.restart();
      expect((await f.register()).body.status).toBe('already_registered');
      expect(readFileSync(join(directory, 'history.json'), 'utf8')).toBe(original);
    } finally { f.cleanup(); }
  });

  test('an old reservation without a published registration can still resume', () => {
    const f = fixture();
    try {
      const directory = join(f.dataDir, 'agent-registrations', 'corpus-reservations');
      mkdirSync(directory, { recursive: true });
      const name = createHash('sha256').update(route.targetCorpusDisplayName).digest('hex');
      const original = canonicalJson({ domain_id: 'history', route: validateAgentRoutingConfig({ history: route }).history });
      writeFileSync(join(directory, `${name}.json`), original);
      const store = new AgentRegistrationStore(f.dataDir, validateAgentRoutingConfig({}), library);
      expect(store.register('history', route, false).routes.history!.ingestion).toEqual({ importResultSink: 'client' });
      expect(readFileSync(join(directory, `${name}.json`), 'utf8')).toBe(original);
      expect(store.register('history', route, false).existing).toBe(true);
    } finally { f.cleanup(); }
  });

  test.each([undefined, 'gcs', 'client'] as const)('explicit base route keeps its original sink policy: %s', sink => {
    const f = fixture();
    try {
      const directory = join(f.dataDir, 'agent-registrations');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'history.json'), canonicalJson(route));
      const base = validateAgentRoutingConfig({ history: { ...route, ...(sink ? { ingestion: { importResultSink: sink } } : {}) } });
      const store = new AgentRegistrationStore(f.dataDir, base, library);
      expect(store.routes().history).toEqual(base.history);
      expect(() => store.register('history', route, false)).toThrow('already configured');
    } finally { f.cleanup(); }
  });

  test.each(['ingestion', 'importResultSink', 'retrieval', 'scopeManifestPath'])('registration input still rejects caller-controlled %s', field => {
    const f = fixture();
    try {
      const store = new AgentRegistrationStore(f.dataDir, validateAgentRoutingConfig({}), library);
      expect(() => store.register('history', { ...route, [field]: { importResultSink: 'gcs' } }, false)).toThrow('unsupported settings');
      expect(readdirSync(f.dataDir)).not.toContain('agent-registrations');
    } finally { f.cleanup(); }
  });

  test('is disabled unless the deployment grants a library subtree', async () => {
    const f = fixture({ enabled: false });
    try {
      const result = await f.register();
      expect(result.body.error.code).toBe('agent_registration_disabled');
      expect(f.calls).toHaveLength(0);
    } finally { f.cleanup(); }
  });

  test('dry run previews the explicit route without persisting or contacting Google', async () => {
    const f = fixture();
    try {
      const result = await f.register({ dry_run: true, approval_id: undefined });
      expect(result.body.status).toBe('dry_run_registration_ready');
      expect(result.body.manifest.routing.configured).toBe(true);
      expect(readdirSync(f.dataDir)).not.toContain('agent-registrations');
      expect(f.calls).toHaveLength(0);
    } finally { f.cleanup(); }
  });

  test('live registration requires approval and enforces bucket and prefix boundaries', async () => {
    const f = fixture();
    try {
      expect((await f.register({ approval_id: undefined })).status).toBeGreaterThanOrEqual(400);
      for (const target of [{ bucket: 'foreign-library', prefix: 'factory/history' }, { ...library, prefix: 'factory-other/history' }]) {
        expect((await f.register({ library: target })).body.error.code).toBe('agent_registration_library_denied');
      }
      expect(f.calls).toHaveLength(0);
    } finally { f.cleanup(); }
  });

  test('identical registration survives restart and changed settings cannot replace it', async () => {
    const f = fixture();
    try {
      const first = await f.register();
      expect(first.status).toBe(200);
      expect(first.body.status).toBe('registered');
      expect(first.body.policy.raw_runtime_secrets_exposed).toBe(false);
      f.restart();
      expect((await f.register()).body.status).toBe('already_registered');
      expect((await f.register({ target_corpus_display_name: 'another-library' })).body.error.code).toBe('agent_registration_conflict');
    } finally { f.cleanup(); }
  });

  test('operator environment routes cannot be overwritten even with matching input', async () => {
    const f = fixture({ configured: true });
    try { expect((await f.register()).body.error.code).toBe('agent_registration_conflict'); }
    finally { f.cleanup(); }
  });

  test('new registrations cannot adopt an unrelated existing corpus', async () => {
    const f = fixture();
    try {
      f.provider('ACTIVE');
      expect((await f.register()).body.error.code).toBe('agent_registration_conflict');
      expect(readdirSync(f.dataDir)).not.toContain('agent-registrations');
      expect(f.calls.filter(call => call.startsWith('POST'))).toHaveLength(0);
    } finally { f.cleanup(); }
  });

  test.each(['123', 'projects/neutral-project/locations/us-central1/ragCorpora/123', 'projects/foreign-project/locations/us-central1/ragCorpora/123', ' 123 ', 'history/library', 'history%2Flibrary', 'History Library', 'history--library'])('refuses alias-shaped registration target %s before cloud or persistence', async target => {
    const f = fixture();
    try {
      f.provider('ACTIVE', false, 'private-library');
      expect((await f.register({ target_corpus_display_name: target })).body.error.code).toBe('invalid_agent_registration');
      expect((await f.ensure({ corpus_id: target })).status).toBeGreaterThanOrEqual(400);
      expect((await f.request('rag_corpus', { action: 'list_files', domain_id: 'history', corpus_id: target, dry_run: false })).status).toBeGreaterThanOrEqual(400);
      expect(readdirSync(f.dataDir)).not.toContain('agent-registrations');
      expect(f.calls).toHaveLength(0);
    } finally { f.cleanup(); }
  });

  test('two agents cannot register the same not-yet-created corpus', async () => {
    const f = fixture();
    try {
      const results = await Promise.all([f.register(), f.register({ domain_id: 'science' })]);
      expect(results.filter(result => result.body.status === 'registered')).toHaveLength(1);
      expect(results.filter(result => result.body.error?.code === 'agent_registration_conflict')).toHaveLength(1);
    } finally { f.cleanup(); }
  });
});

describe('retry-safe corpus ensure', () => {
  test('polls a pinned creation operation and durably reports terminal failure without replay', async () => {
    const f = fixture();
    try {
      await f.register();
      expect((await f.ensure()).body.status).toBe('create_requested');
      f.operation({ name: creationOperation, done: true, error: { code: 8, message: 'synthetic private quota failure' } });
      f.restart();
      const failed = await f.ensure();
      expect(failed.body.error.code).toBe('rag_corpus_creation_failed');
      expect(JSON.stringify(failed.body)).not.toContain('synthetic private quota failure');
      f.restart();
      expect((await f.ensure()).body.error.code).toBe('rag_corpus_creation_failed');
      expect(f.calls.filter(call => call.startsWith('POST'))).toHaveLength(1);
      expect(f.calls.filter(call => call.includes('/operations/'))).toHaveLength(1);
      const receipts = join(f.dataDir, 'corpus-creations');
      const receipt = readFileSync(join(receipts, readdirSync(receipts)[0]!), 'utf8');
      expect(JSON.parse(receipt).status).toBe('creation_failed');
      expect(receipt).not.toContain('synthetic private quota failure');
    } finally { f.cleanup(); }
  });

  test.each([
    { name: creationOperation, done: 'true', error: { code: 8 } },
    { name: creationOperation.replace('neutral-project', 'foreign-project'), done: true, error: { code: 8 } },
    { name: creationOperation, done: false, error: { code: 8 } },
    { name: creationOperation, done: true },
    { name: creationOperation, done: true, response: { name: corpus.replace('neutral-project', 'foreign-project'), displayName: route.targetCorpusDisplayName } },
    { name: creationOperation, done: true, response: { name: corpus, displayName: 'private-library' } },
  ])('rejects malformed or mismatched poll proof: %j', async response => {
    const f = fixture();
    try {
      await f.register(); await f.ensure(); f.operation(response);
      expect((await f.ensure()).body.error.code).toBe('rag_corpus_creation_operation_invalid');
      expect(f.calls.filter(call => call.startsWith('POST'))).toHaveLength(1);
      expect(f.calls.filter(call => call.includes('foreign-project'))).toHaveLength(0);
    } finally { f.cleanup(); }
  });

  test('valid operation completion still waits for an ACTIVE discovered corpus', async () => {
    const f = fixture();
    try {
      await f.register(); await f.ensure();
      f.operation({ name: creationOperation, done: true, response: { name: corpus, displayName: route.targetCorpusDisplayName } });
      expect((await f.ensure()).body.status).toBe('create_requested');
      f.restart();
      expect((await f.ensure()).body.status).toBe('create_requested');
      expect(f.calls.filter(call => call.includes('/operations/'))).toHaveLength(1);
      f.provider('ACTIVE');
      expect((await f.ensure()).body.status).toBe('ready');
    } finally { f.cleanup(); }
  });

  test('numeric operation parent requires a verified project-number mapping, including after restart', async () => {
    const numericOperation = creationOperation.replace('neutral-project', '987654321');
    const f = fixture({ operationName: numericOperation });
    try {
      await f.register(); await f.ensure(); f.restart();
      f.operation({ name: numericOperation, done: true, error: { code: 8 } });
      expect((await f.ensure()).body.error.code).toBe('rag_corpus_creation_failed');
      expect(f.calls.filter(call => call.includes('cloudresourcemanager'))).toHaveLength(2);
      expect(f.calls.filter(call => call.includes('/operations/'))).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  test.each([403, 429, 503, 504])('retains the submitted LRO through Resource Manager HTTP %i and resumes without replay', async projectLookupStatus => {
    const numericOperation = creationOperation.replace('neutral-project', '987654321');
    const f = fixture({ operationName: numericOperation, projectLookupStatus });
    try {
      await f.register();
      const submitted = await f.ensure();
      expect(submitted.status).toBe(200);
      expect(submitted.body.status).toBe('create_requested');
      expect(submitted.body.creation_pending).toBe(true);
      expect(JSON.stringify(submitted.body)).not.toContain(numericOperation);
      expect(JSON.stringify(submitted.body)).not.toContain('synthetic private');
      expect(f.receipt().operation_name).toBe(numericOperation);
      expect(f.receipt().status).toBe('creation_pending');
      expect(JSON.stringify(f.receipt())).not.toContain('synthetic private');
      f.restart();
      expect((await f.ensure()).body.status).toBe('create_requested');
      expect(f.receipt().operation_name).toBe(numericOperation);
      expect(f.calls.filter(call => call.includes('/operations/'))).toHaveLength(0);
      f.projectLookup(200);
      f.operation({ name: numericOperation, done: true, error: { code: 8 } });
      expect((await f.ensure()).body.error.code).toBe('rag_corpus_creation_failed');
      expect(f.receipt().status).toBe('creation_failed');
      expect(f.calls.filter(call => call.includes('/operations/'))).toHaveLength(1);
      expect(f.calls.filter(call => call.startsWith('POST'))).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  test('restored lookup access cannot authorize a different numeric project', async () => {
    const numericOperation = creationOperation.replace('neutral-project', '987654321');
    const f = fixture({ operationName: numericOperation, projectLookupStatus: 403, projectNumber: '123456789' });
    try {
      await f.register();
      expect((await f.ensure()).body.status).toBe('create_requested');
      f.restart(); f.projectLookup(200);
      expect((await f.ensure()).body.error.code).toBe('rag_corpus_creation_operation_scope_invalid');
      expect(f.receipt().operation_name).toBe(numericOperation);
      expect(f.calls.filter(call => call.includes('/operations/'))).toHaveLength(0);
      expect(f.calls.filter(call => call.startsWith('POST'))).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  test.each(['submission', 'poll'])('does not accept numeric completion proof from %s before alias validation', async phase => {
    const operationName = phase === 'submission' ? creationOperation.replace('neutral-project', '987654321') : creationOperation;
    const completed = { name: operationName, done: true, response: {
      name: corpus.replace('neutral-project', '987654321'), displayName: route.targetCorpusDisplayName,
    } };
    const f = fixture({ operationName, projectLookupStatus: 403, ...(phase === 'submission' ? { creationResponse: completed } : {}) });
    try {
      await f.register();
      expect((await f.ensure()).body.status).toBe('create_requested');
      f.operation(completed);
      if (phase === 'poll') expect((await f.ensure()).body.status).toBe('create_requested');
      expect(f.receipt().operation_name).toBe(operationName);
      expect(f.receipt().status).toBe('creation_pending');
      expect(f.calls.filter(call => call.includes('/operations/'))).toHaveLength(phase === 'submission' ? 0 : 1);
      f.restart(); f.projectLookup(200);
      expect((await f.ensure()).body.status).toBe('create_requested');
      expect(f.receipt().status).toBe('creation_complete');
      f.provider('ACTIVE');
      expect((await f.ensure()).body.status).toBe('ready');
      expect(f.calls.filter(call => call.startsWith('POST'))).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  test('ACTIVE discovery can reconcile a submitted corpus while alias lookup stays unavailable', async () => {
    const f = fixture({ operationName: creationOperation.replace('neutral-project', '987654321'), projectLookupStatus: 403 });
    try {
      await f.register(); await f.ensure(); f.restart(); f.provider('ACTIVE');
      expect((await f.ensure()).body.status).toBe('ready');
      expect(f.calls.filter(call => call.includes('/operations/'))).toHaveLength(0);
      expect(f.calls.filter(call => call.startsWith('POST'))).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  test.each([
    { name: creationOperation.replace('neutral-project', '987654321'), done: 'false' },
    { name: creationOperation.replace('neutral-project', '987654321'), done: false, error: { code: 8 } },
    { name: creationOperation.replace('neutral-project', '987654321'), done: true, response: { name: corpus.replace('neutral-project', 'foreign-project'), displayName: route.targetCorpusDisplayName } },
    { name: creationOperation.replace('neutral-project', '987654321').replace('us-central1', 'us-east1'), done: false },
    { name: creationOperation.replace('neutral-project', 'foreign-project'), done: false },
    { name: `${creationOperation}?secret=synthetic`, done: false },
    { name: `${creationOperation}${'a'.repeat(512)}`, done: false },
  ])('does not defer malformed or outside-project submission proof when lookup is unavailable: %j', async creationResponse => {
    const f = fixture({ creationResponse, projectLookupStatus: 403 });
    try {
      await f.register();
      const result = await f.ensure();
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.body.error.code).toMatch(/^rag_corpus_creation_operation_(invalid|scope_invalid)$/);
      expect(f.receipt().operation_name).toBeUndefined();
      expect(f.calls.filter(call => call.includes('cloudresourcemanager') || call.includes('/operations/'))).toHaveLength(0);
    } finally { f.cleanup(); }
  });

  test.each([
    { operationName: creationOperation.replace('neutral-project', 'foreign-project') },
    { operationName: creationOperation.replace('neutral-project', '987654321'), projectNumber: '123456789' },
    { operationName: creationOperation.replace('neutral-project', '987654321'), projectId: 'foreign-project' },
  ])('does not poll an operation whose configured project ownership is unproven: %j', async options => {
    const f = fixture(options);
    try {
      await f.register();
      expect((await f.ensure()).body.error.code).toBe('rag_corpus_creation_operation_scope_invalid');
      expect(f.calls.filter(call => call.includes('/operations/'))).toHaveLength(0);
      const resumed = await f.ensure();
      if (options.operationName.includes('/987654321/')) expect(resumed.body.error.code).toBe('rag_corpus_creation_operation_scope_invalid');
      else expect(resumed.body.status).toBe('create_requested');
      expect(f.calls.filter(call => call.startsWith('POST'))).toHaveLength(1);
    } finally { f.cleanup(); }
  });
  test('requires a configured route and approval before any provider operation', async () => {
    const f = fixture();
    try {
      expect((await f.ensure()).status).toBeGreaterThanOrEqual(400);
      await f.register();
      f.calls.length = 0;
      expect((await f.ensure({ approval_id: undefined })).status).toBeGreaterThanOrEqual(400);
      expect((await f.ensure({ corpus_id: 'foreign-library' })).status).toBeGreaterThanOrEqual(400);
      expect((await f.ensure({ dry_run: true })).body.status).toBe('dry_run_ensure_ready');
      expect(f.calls).toHaveLength(0);
    } finally { f.cleanup(); }
  });

  test('creates once across concurrent calls and restarts, then waits for ACTIVE', async () => {
    const f = fixture();
    try {
      await f.register();
      const results = await Promise.all([f.ensure(), f.ensure()]);
      expect(results.every(result => result.body.status === 'create_requested')).toBe(true);
      f.restart();
      expect((await f.ensure()).body.status).toBe('create_requested');
      expect(f.calls.filter(call => call.startsWith('POST'))).toHaveLength(1);
      f.provider('INITIALIZED');
      expect((await f.ensure()).body.creation_pending).toBe(true);
      f.provider('ACTIVE');
      const ready = await f.ensure();
      expect(ready.body.status).toBe('ready');
      expect(ready.body.resolved_corpus.resource_name).toBe(corpus);
      expect(f.calls.filter(call => call.startsWith('POST'))).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  test('reconciles a lost creation response without replaying the POST', async () => {
    const f = fixture({ networkFailure: true });
    try {
      await f.register();
      expect((await f.ensure()).status).toBeGreaterThanOrEqual(400);
      f.restart();
      expect((await f.ensure()).body.status).toBe('create_requested');
      f.provider('ACTIVE');
      expect((await f.ensure()).body.status).toBe('ready');
      expect(f.calls.filter(call => call.startsWith('POST'))).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  test('failed intent persistence prevents corpus creation', async () => {
    const f = fixture();
    try {
      await f.register();
      writeFileSync(join(f.dataDir, 'corpus-creations'), 'blocked');
      expect((await f.ensure()).status).toBeGreaterThanOrEqual(400);
      expect(f.calls.filter(call => call.startsWith('POST'))).toHaveLength(0);
    } finally { f.cleanup(); }
  });

  test('an error state or ambiguous display name never reports ready', async () => {
    const f = fixture();
    try {
      await f.register();
      f.provider('ERROR');
      expect((await f.ensure()).body.error.code).toBe('rag_corpus_creation_failed');
      f.provider('ACTIVE', true);
      expect((await f.ensure()).body.error.code).toBe('rag_corpus_ambiguous');
      expect(f.calls.filter(call => call.startsWith('POST'))).toHaveLength(0);
    } finally { f.cleanup(); }
  });
});
