import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAgentRoutingConfig } from '../src/core/agent-routing.ts';
import { AgentRegistrationStore } from '../src/core/agent-registration.ts';
import { canonicalJson } from '@expert-agents/library';
import { createDomainExpertWorker } from '../src/workers/domain-expert/index.ts';

const library = { bucket: 'neutral-library', prefix: 'factory' };
const route = { library: { ...library, prefix: 'factory/history' }, pageLibrary: {} };
const configuredRoute = { library: route.library, pageLibrary: { sourceId: 'history' } };

function fixture(options: { enabled?: boolean; configured?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-registration-'));
  const workerOptions = {
    dataDir,
    ...(options.enabled === false ? {} : { registrationLibrary: library }),
    agentRouting: validateAgentRoutingConfig(options.configured ? { history: configuredRoute } : {}),
  };
  let worker = createDomainExpertWorker(workerOptions);
  const request = async (tool: string, params: Record<string, unknown>) => {
    const response = await worker.fetch(new Request('http://worker.test/v1/domain', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool, params }),
    }));
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  return {
    dataDir, request,
    register: (extra: Record<string, unknown> = {}) => request('domain_agent', {
      action: 'register', domain_id: 'history', library: route.library, page_library: {},
      approval_id: 'factory-operation-1', dry_run: false, ...extra,
    }),
    restart() { worker = createDomainExpertWorker(workerOptions); },
    cleanup() { rmSync(dataDir, { recursive: true, force: true }); },
  };
}

describe('operator-bounded durable agent registration', () => {
  test('a stored registration persisted with a retired corpus name loads and drops that key', async () => {
    const f = fixture();
    try {
      const directory = join(f.dataDir, 'agent-registrations');
      mkdirSync(directory, { recursive: true });
      const original = canonicalJson({ ...route, targetCorpusDisplayName: 'history-library' });
      writeFileSync(join(directory, 'history.json'), original);
      const store = new AgentRegistrationStore(f.dataDir, validateAgentRoutingConfig({}), library);
      const loaded = store.routes().history!;
      expect(loaded.pageLibrary).toEqual({ sourceId: 'history' });
      expect(loaded.library).toEqual(route.library);
      expect(Object.keys(loaded)).not.toContain('targetCorpusDisplayName');
      expect(JSON.stringify(loaded)).not.toContain('history-library');
      // Registering the same thing again, with or without the retired key, is idempotent.
      expect(store.register('history', route, false).existing).toBe(true);
      expect(store.register('history', { ...route, targetCorpusDisplayName: 'history-library' }, false).existing).toBe(true);
      f.restart();
      expect((await f.register()).body.status).toBe('already_registered');
      expect(readFileSync(join(directory, 'history.json'), 'utf8')).toBe(original);
    } finally { f.cleanup(); }
  });

  test('a registration without pageLibrary is refused', () => {
    const f = fixture();
    try {
      const store = new AgentRegistrationStore(f.dataDir, validateAgentRoutingConfig({}), library);
      expect(() => store.register('history', { library: route.library }, false)).toThrow('page library');
      expect(readdirSync(f.dataDir)).not.toContain('agent-registrations');
    } finally { f.cleanup(); }
  });

  test('a registration page library names only the domain itself', () => {
    const f = fixture();
    try {
      const store = new AgentRegistrationStore(f.dataDir, validateAgentRoutingConfig({}), library);
      expect(store.register('history', { ...route, pageLibrary: { sourceId: 'history' } }, true).routes.history!.pageLibrary).toEqual({ sourceId: 'history' });
      for (const pageLibrary of [{ sourceId: 'other' }, { root: '/elsewhere' }, { database: 'private' }, []]) {
        expect(() => store.register('history', { ...route, pageLibrary }, false)).toThrow('page library');
      }
      expect(readdirSync(f.dataDir)).not.toContain('agent-registrations');
    } finally { f.cleanup(); }
  });

  test('an operator page-library root places the registered tree under the domain id', () => {
    const f = fixture();
    try {
      const store = new AgentRegistrationStore(f.dataDir, validateAgentRoutingConfig({}), library, '/var/lib/page-library');
      expect(store.register('history', route, true).routes.history!.pageLibrary)
        .toEqual({ root: '/var/lib/page-library/history', sourceId: 'history' });
    } finally { f.cleanup(); }
  });

  test('two agents cannot share one page library', () => {
    const f = fixture();
    try {
      const base = validateAgentRoutingConfig({ science: { library: route.library, pageLibrary: { sourceId: 'history' } } });
      const store = new AgentRegistrationStore(f.dataDir, base, library);
      expect(() => store.register('history', route, false)).toThrow('already assigned');
      expect(readdirSync(f.dataDir)).not.toContain('agent-registrations');
    } finally { f.cleanup(); }
  });

  test.each(['ingestion', 'importResultSink', 'retrieval', 'scopeManifestPath', 'servingCorpusDisplayNames'])('registration input still rejects caller-controlled %s', field => {
    const f = fixture();
    try {
      const store = new AgentRegistrationStore(f.dataDir, validateAgentRoutingConfig({}), library);
      expect(() => store.register('history', { ...route, [field]: { importResultSink: 'client' } }, false)).toThrow('unsupported settings');
      expect(readdirSync(f.dataDir)).not.toContain('agent-registrations');
    } finally { f.cleanup(); }
  });

  test('is disabled unless the deployment grants a library subtree', async () => {
    const f = fixture({ enabled: false });
    try {
      const result = await f.register();
      expect(result.body.error.code).toBe('agent_registration_disabled');
    } finally { f.cleanup(); }
  });

  test('dry run previews the explicit route without persisting', async () => {
    const f = fixture();
    try {
      const result = await f.register({ dry_run: true, approval_id: undefined });
      expect(result.body.status).toBe('dry_run_registration_ready');
      expect(result.body.manifest.routing.configured).toBe(true);
      expect(readdirSync(f.dataDir)).not.toContain('agent-registrations');
    } finally { f.cleanup(); }
  });

  test('live registration requires approval and enforces bucket and prefix boundaries', async () => {
    const f = fixture();
    try {
      expect((await f.register({ approval_id: undefined })).status).toBeGreaterThanOrEqual(400);
      for (const target of [{ bucket: 'foreign-library', prefix: 'factory/history' }, { ...library, prefix: 'factory-other/history' }]) {
        expect((await f.register({ library: target })).body.error.code).toBe('agent_registration_library_denied');
      }
      expect(readdirSync(f.dataDir)).not.toContain('agent-registrations');
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
      expect((await f.register({ library: { ...library, prefix: 'factory/another' } })).body.error.code).toBe('agent_registration_conflict');
    } finally { f.cleanup(); }
  });

  test('operator environment routes cannot be overwritten even with matching input', async () => {
    const f = fixture({ configured: true });
    try { expect((await f.register()).body.error.code).toBe('agent_registration_conflict'); }
    finally { f.cleanup(); }
  });
});
