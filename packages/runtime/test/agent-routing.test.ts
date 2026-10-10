import { describe, expect, test } from 'bun:test';
import {
  AgentRoutingConfigError,
  agentRoutingConfigFromEnv,
  validateAgentRoutingConfig,
} from '../src/core/agent-routing.ts';

const ROUTING_ENV = 'EXPERT_AGENTS_DOMAIN_EXPERT_AGENTS_JSON';

describe('agent routing config', () => {
  test('accepts strict inline and @-file routing configuration', () => {
    const value = {
      history: {
        displayName: 'History Research',
        library: { bucket: 'shared-library-fixture', prefix: 'v1' },
        targetCorpusDisplayName: 'history-primary',
        scopeManifestPath: '/agent/library/scope.json',
        retrieval: { topK: 24, contextLimit: 8, reranker: 'llm', multiQuery: false },
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

  test('accepts an explicit-corpus requirement alongside the import result sink', () => {
    const route = {
      library: { bucket: 'fixture-bucket', prefix: 'v1' },
      targetCorpusDisplayName: 'private-library',
      servingCorpusDisplayNames: ['private-library', 'public-shelf'],
    };
    expect(validateAgentRoutingConfig({ history: { ...route, ingestion: { explicitCorpusRequiredFor: ['annas_archive_import', 'web_import'] } } }).history!.ingestion)
      .toEqual({ explicitCorpusRequiredFor: ['annas_archive_import', 'web_import'] });
    expect(validateAgentRoutingConfig({ history: { ...route, ingestion: { importResultSink: 'client', explicitCorpusRequiredFor: ['web_import'] } } }).history!.ingestion)
      .toEqual({ importResultSink: 'client', explicitCorpusRequiredFor: ['web_import'] });
    expect(validateAgentRoutingConfig({ history: { ...route, ingestion: { importResultSink: 'gcs' } } }).history!.ingestion)
      .toEqual({ importResultSink: 'gcs' });
  });

  test('rejects malformed, unknown, and invalid routing fields without echoing values', () => {
    const sensitiveValue = 'private-fixture-value';
    const invalidCases: unknown[] = [
      [],
      { 'History Name': { library: { bucket: 'fixture-bucket', prefix: 'v1' }, targetCorpusDisplayName: 'primary' } },
      { history: { library: { bucket: 'fixture-bucket', prefix: 'v1' } } },
      { history: { library: { bucket: sensitiveValue, prefix: '/invalid/' }, targetCorpusDisplayName: 'primary' } },
      { history: { library: { bucket: 'fixture-bucket', prefix: 'v1' }, targetCorpusDisplayName: 'primary', extra: sensitiveValue } },
      { history: { library: { bucket: 'fixture-bucket', prefix: 'v1' }, targetCorpusDisplayName: 'primary', retrieval: { topK: 0 } } },
      { history: { library: { bucket: 'fixture-bucket', prefix: 'v1' }, targetCorpusDisplayName: 'primary', retrieval: { topK: 101 } } },
      { history: { library: { bucket: 'fixture-bucket', prefix: 'v1' }, targetCorpusDisplayName: 'primary', retrieval: { multiQuery: 'yes' } } },
      { history: { library: { bucket: 'fixture-bucket', prefix: 'v1' }, targetCorpusDisplayName: 'primary', servingCorpusDisplayNames: [] } },
      { history: { library: { bucket: 'fixture-bucket', prefix: 'v1' }, targetCorpusDisplayName: 'primary', servingCorpusDisplayNames: ['a', 'a'] } },
      { history: { library: { bucket: 'fixture-bucket', prefix: 'v1' }, targetCorpusDisplayName: 'primary', servingCorpusDisplayNames: [sensitiveValue, ''] } },
      { history: { library: { bucket: 'fixture-bucket', prefix: 'v1' }, targetCorpusDisplayName: 'primary', ingestion: { explicitCorpusRequiredFor: [] } } },
      { history: { library: { bucket: 'fixture-bucket', prefix: 'v1' }, targetCorpusDisplayName: 'primary', ingestion: { explicitCorpusRequiredFor: 'web_import' } } },
      { history: { library: { bucket: 'fixture-bucket', prefix: 'v1' }, targetCorpusDisplayName: 'primary', ingestion: { explicitCorpusRequiredFor: ['web_import', 'web_import'] } } },
      { history: { library: { bucket: 'fixture-bucket', prefix: 'v1' }, targetCorpusDisplayName: 'primary', ingestion: { explicitCorpusRequiredFor: [sensitiveValue] } } },
      { history: { library: { bucket: 'fixture-bucket', prefix: 'v1' }, targetCorpusDisplayName: 'primary', ingestion: { explicitCorpusRequiredFor: ['stage_import'] } } },
      { history: { library: { bucket: 'fixture-bucket', prefix: 'v1' }, targetCorpusDisplayName: 'primary', ingestion: { explicitCorpusRequiredFor: [1] } } },
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
