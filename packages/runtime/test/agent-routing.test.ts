import { describe, expect, test } from 'bun:test';
import {
  AgentRoutingConfigError,
  RETIRED_VERTEX_ROUTING_KEYS,
  agentRoutingConfigFromEnv,
  validateAgentRoutingConfig,
} from '../src/core/agent-routing.ts';

const ROUTING_ENV = 'EXPERT_AGENTS_DOMAIN_EXPERT_AGENTS_JSON';
const library = { bucket: 'fixture-bucket', prefix: 'v1' };

describe('agent routing config', () => {
  test('accepts strict inline and @-file routing configuration', () => {
    const value = {
      history: {
        displayName: 'History Research',
        library: { bucket: 'shared-library-fixture', prefix: 'v1' },
        scopeManifestPath: '/agent/library/scope.json',
        pageLibrary: { sourceId: 'history' },
      },
    } as const;

    expect(agentRoutingConfigFromEnv({ [ROUTING_ENV]: JSON.stringify(value) })).toEqual({
      history: { domainId: 'history', ...value.history },
    });
    expect(agentRoutingConfigFromEnv(
      { [ROUTING_ENV]: '@/config/agents.json' },
      (path) => {
        expect(path).toBe('/config/agents.json');
        return JSON.stringify(value);
      },
    )).toEqual({ history: { domainId: 'history', ...value.history } });
  });

  test('accepts a page library block and refuses unsafe ones', () => {
    const base = { library };
    const pageLibrary = { root: '/var/lib/page-library/history/tree', sourceId: 'history' };
    expect(validateAgentRoutingConfig({ history: { ...base, pageLibrary } }).history!.pageLibrary).toEqual(pageLibrary);
    for (const bad of [
      { ...pageLibrary, root: 'relative/tree' },
      { ...pageLibrary, root: '/var/lib/../etc' },
      { ...pageLibrary, sourceId: 'Has Spaces' },
      // The index's database URL is a secret; routing never carries it.
      { ...pageLibrary, databaseUrl: 'postgres://user:pass@127.0.0.1/pages' },
      { ...pageLibrary, extra: true },
    ]) {
      expect(() => validateAgentRoutingConfig({ history: { ...base, pageLibrary: bad } })).toThrow(AgentRoutingConfigError);
    }
  });

  test('accepts the retired Vertex routing keys and drops them from the validated route', () => {
    const entry = {
      library,
      pageLibrary: { sourceId: 'history' },
      targetCorpusDisplayName: 'history-primary',
      servingCorpusDisplayNames: ['history-primary', 'public-shelf'],
      retrieval: { topK: 24, contextLimit: 8, reranker: 'llm', multiQuery: false },
      ingestion: { importResultSink: 'client', explicitCorpusRequiredFor: ['web_import'] },
    };
    expect([...RETIRED_VERTEX_ROUTING_KEYS].sort()).toEqual(['ingestion', 'retrieval', 'servingCorpusDisplayNames', 'targetCorpusDisplayName']);
    const route = validateAgentRoutingConfig({ history: entry }).history!;
    expect(route).toEqual({ domainId: 'history', library, pageLibrary: { sourceId: 'history' } });
    for (const key of RETIRED_VERTEX_ROUTING_KEYS) expect(Object.keys(route)).not.toContain(key);
    expect(JSON.stringify(route)).not.toContain('history-primary');
    const fromEnv = agentRoutingConfigFromEnv({ [ROUTING_ENV]: JSON.stringify({ history: entry }) }).history!;
    expect(fromEnv).toEqual(route);
  });

  test('refuses an entry without pageLibrary', () => {
    for (const entry of [
      { library },
      { library, targetCorpusDisplayName: 'history-primary' },
    ]) {
      expect(() => validateAgentRoutingConfig({ history: entry })).toThrow('an entry is missing pageLibrary');
    }
  });

  test('rejects malformed, unknown, and invalid routing fields without echoing values', () => {
    const sensitiveValue = 'private-fixture-value';
    const pageLibrary = { sourceId: 'history' };
    const invalidCases: unknown[] = [
      [],
      { 'History Name': { library, pageLibrary } },
      { history: { library, pageLibrary: { sourceId: sensitiveValue.toUpperCase() } } },
      { history: { library: { bucket: sensitiveValue, prefix: '/invalid/' }, pageLibrary } },
      { history: { library, pageLibrary, extra: sensitiveValue } },
      { history: { library, pageLibrary, displayName: 5 } },
      { history: { library, pageLibrary, readOnlySourceRoots: [] } },
      { history: { library, pageLibrary: [] } },
      { history: { pageLibrary } },
    ];

    for (const invalid of invalidCases) {
      try {
        validateAgentRoutingConfig(invalid);
        throw new Error('expected routing validation to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(AgentRoutingConfigError);
        expect(String(error)).not.toContain(sensitiveValue);
      }
    }
    expect(() => agentRoutingConfigFromEnv({ [ROUTING_ENV]: '{not-json' })).toThrow(AgentRoutingConfigError);
    expect(() => agentRoutingConfigFromEnv({ [ROUTING_ENV]: '@/missing' }, () => {
      throw new Error(sensitiveValue);
    })).toThrow('the @ file could not be read');
  });
});
