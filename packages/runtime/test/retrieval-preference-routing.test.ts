import { describe, expect, test } from 'bun:test';
import { AgentRoutingConfigError, validateAgentRoutingConfig } from '../src/core/agent-routing.ts';
import { domainManifest, planDomainAsk, type DomainAskParams } from '../src/core/domain-expert.ts';

const base = { library: { bucket: 'fixture-shared-library', prefix: 'v1' }, targetCorpusDisplayName: 'fixture-primary' };
const path = '/operator/fixture/preferences.json';

function manifest(configured = false) {
  return domainManifest('research', undefined, {
    env: {},
    agentRouting: validateAgentRoutingConfig({ research: { ...base, ...(configured ? { retrieval: { preferenceProfilePath: path } } : {}) } }),
  });
}

describe('preference and ingestion routing configuration', () => {
  test('accepts explicit operator paths and both provider-receipt sink choices', () => {
    for (const importResultSink of ['client', 'gcs'] as const) {
      const config = validateAgentRoutingConfig({ research: { ...base, retrieval: { preferenceProfilePath: path }, ingestion: { importResultSink } } });
      expect(config.research!.retrieval!.preferenceProfilePath).toBe(path);
      expect(config.research!.ingestion!.importResultSink).toBe(importResultSink);
      expect(Object.isFrozen(config.research!.retrieval)).toBe(true);
      expect(Object.isFrozen(config.research!.ingestion)).toBe(true);
    }
    const config = validateAgentRoutingConfig({ research: base });
    expect(config.research).not.toHaveProperty('retrieval');
    expect(config.research).not.toHaveProperty('ingestion');
  });

  test('rejects malformed paths, unknown controlling keys, and unsupported sink values without echoing them', () => {
    const invalid: unknown[] = [
      ...['private-relative.json', '', '/private\u0000fixture', `/private-${'x'.repeat(4096)}`, 123, null].map(preferenceProfilePath => ({ ...base, retrieval: { preferenceProfilePath } })),
      ...['private-invalid-sink', false, null].map(importResultSink => ({ ...base, ingestion: { importResultSink } })),
      { ...base, ingestion: { unknown: 'private-invalid-sink' } },
      { ...base, retrieval: { unknown: 'private-invalid-sink' } },
    ];
    for (const entry of invalid) {
      let caught: unknown;
      try { validateAgentRoutingConfig({ research: entry }); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(AgentRoutingConfigError);
      expect(String(caught)).not.toContain('private-');
    }
  });
});

describe('preference selection in ask plans', () => {
  test('preserves the unconfigured plan shape and advertises configuration without a private path', () => {
    const unconfigured = planDomainAsk({ question: 'Find relevant evidence.' }, manifest());
    expect(unconfigured.retrieval).not.toHaveProperty('preferences');
    const configured = planDomainAsk({ question: 'Find relevant evidence.' }, manifest(true));
    expect(configured.retrieval).toHaveProperty('preferences', { configured: true, requested_mode: 'profile_default' });
    expect(JSON.stringify(configured)).not.toContain(path);
    expect(manifest(true).retrieval.preference_profile_configured).toBe(true);
  });

  test('preserves explicit preferred and history selection in configured and unconfigured plans', () => {
    for (const configured of [false, true]) {
      for (const retrievalMode of ['preferred', 'history'] as const) {
        const plan = planDomainAsk({ question: 'Find relevant evidence.', retrievalMode }, manifest(configured));
        expect(plan.retrieval).toHaveProperty('preferences', { configured, requested_mode: retrievalMode });
      }
    }
  });

  test('rejects unsupported retrieval modes with a static validation error', () => {
    const params = { question: 'Find relevant evidence.', retrievalMode: 'private-invalid-value' } as unknown as DomainAskParams;
    expect(() => planDomainAsk(params, manifest())).toThrow('retrieval_mode must be preferred or history');
  });
});
