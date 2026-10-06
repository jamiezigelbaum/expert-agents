import { describe, expect, test } from 'bun:test';
import manifest from '../openclaw.plugin.json' with { type: 'json' };
import plugin, { type NativeTool } from '../src/native-plugin.ts';
import { assertSupportedSchema, validateAgainstSchema } from './json-schema-subset.ts';

type RegisteredTool = NativeTool;
type Registration = Parameters<Parameters<typeof plugin.register>[0]['registerTool']>[0];
const resolveTool = (tool: Registration): NativeTool => typeof tool === 'function' ? tool({ senderIsOwner: true }) : tool;

describe('Expert Agents OpenClaw plugin', () => {
  // The host's activation planner selects plugins from the manifest alone. A
  // plugin that registers tools without declaring the capability is loaded in a
  // discovery mode where registerTool is a no-op: every call is discarded and
  // nothing fails, so the gateway reports a healthy load with zero tools. That
  // is what happened at the 2026-07-30 cutover, which is why this is asserted
  // here rather than left to the first boot on a real gateway.
  test('the manifest declares the activation the host needs to run tool registration', () => {
    expect(manifest.activation).toEqual({ onStartup: true, onCapabilities: ['tool'] });
  });

  test('the tools the manifest claims are exactly the tools the plugin registers', () => {
    const registered: string[] = [];
    plugin.register({ registerTool: (tool) => registered.push(resolveTool(tool).name) });
    expect(manifest.contracts.tools).toEqual(registered);
  });

  test('registers exactly the bounded expert tools under its independent identity', () => {
    const names: string[] = [];
    plugin.register({ registerTool: (tool) => names.push(resolveTool(tool).name) });
    expect(plugin.id).toBe('expert-agents');
    expect(names).toEqual([
      'domain_agent',
      'domain_ask',
      'domain_read',
      'domain_source',
      'rag_corpus',
      'domain_doc',
      'annas_archive_search',
      'annas_archive_import',
      'expert_factory',
    ]);
  });

  test('a configured default domain id reaches the worker request, an explicit one is sent unchanged', async () => {
    // Deployment-level parity with the integration this plugin replaces: the
    // knob is only worth anything if gateway plugin config actually carries it
    // all the way into the request body.
    const bodies = await capturedRequestBodies(
      { domainExpert: { enabled: true, baseUrl: 'http://127.0.0.1:8040/v1', defaultDomainId: 'governance' } },
      [{ question: 'Fixture question' }, { question: 'Fixture question', domain_id: 'history' }],
    );

    expect(bodies).toEqual([
      { tool: 'domain_ask', params: { question: 'Fixture question', domain_id: 'governance' } },
      { tool: 'domain_ask', params: { question: 'Fixture question', domain_id: 'history' } },
    ]);
  });

  test('an unset default domain id changes nothing about the request', async () => {
    const bodies = await capturedRequestBodies(
      { domainExpert: { enabled: true, baseUrl: 'http://127.0.0.1:8040/v1', defaultDomainId: '   ' } },
      [{ question: 'Fixture question' }],
    );

    expect(bodies).toEqual([{ tool: 'domain_ask', params: { question: 'Fixture question' } }]);
  });

  test('reports execution completion separately from a degraded service health result', async () => {
    const serviceResult = {
      kind: 'domain_agent_status',
      status: 'completed',
      health: 'degraded',
      health_issues: [{ code: 'workspace_seed_incomplete' }],
      policy: { expert_agents_control_plane_only: true, raw_runtime_secrets_exposed: false },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json(serviceResult)) as unknown as typeof globalThis.fetch;
    try {
      let status: RegisteredTool['execute'] | undefined;
      plugin.register({
        pluginConfig: { domainExpert: { enabled: true, baseUrl: 'http://127.0.0.1:8040/v1' } },
        registerTool: (tool) => {
          tool = resolveTool(tool);
          if (tool.name === 'domain_agent') status = tool.execute;
        },
      });
      if (!status) throw new Error('The plugin registered no domain_agent tool.');

      const result = await status('fixture-status', { action: 'status' });

      expect(result.isError).toBeUndefined();
      expect(result.details).toEqual({ status: 'completed', result: serviceResult });
      expect(JSON.parse(result.content[0]!.text)).toEqual(serviceResult);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// The gateway validates plugin config against this manifest's configSchema
// before it resolves any SecretRef, so a schema that accepts only `string`
// rejects the broker-backed ref at validation time — before the value it names
// could ever be resolved. That is what forced a literal bearer token into
// gateway config at the 2026-07-30 cutover, which is the exact plaintext-at-rest
// outcome the broker exists to prevent.
describe('the worker credential surface in the plugin manifest', () => {
  const configSchema = manifest.configSchema;
  const secretRefSources = ['env', 'file', 'exec'] as const;
  const validConfig = (authToken: unknown) => ({
    domainExpert: { enabled: true, baseUrl: 'http://127.0.0.1:8040/v1', authToken },
  });

  test('the schema stays inside the keyword subset these tests can actually evaluate', () => {
    expect(() => assertSupportedSchema(configSchema)).not.toThrow();
  });

  test('accepts a literal bearer credential', () => {
    expect(validateAgainstSchema(configSchema, validConfig('fixture-worker-token'))).toEqual([]);
  });

  test('accepts the SecretRef object shape the gateway resolves, for every source it knows', () => {
    for (const source of secretRefSources) {
      const ref = { source, provider: 'op_domain_expert', id: 'domain-expert/worker-bearer' };
      expect(validateAgainstSchema(configSchema, validConfig(ref))).toEqual([]);
    }
  });

  test('rejects SecretRef shapes the host would not recognise as refs', () => {
    // The host narrows a ref with `isSecretRef`: exactly source/provider/id, a
    // known source, non-empty strings. Anything looser would validate here and
    // then fail to resolve, which is the silent half of the failure.
    const rejected: unknown[] = [
      { source: 'vault', provider: 'op_domain_expert', id: 'worker-bearer' },
      { source: 'exec', provider: 'op_domain_expert' },
      { provider: 'op_domain_expert', id: 'worker-bearer' },
      { source: 'exec', provider: '', id: 'worker-bearer' },
      { source: 'exec', provider: 'op_domain_expert', id: '' },
      { source: 'exec', provider: 'op_domain_expert', id: 'worker-bearer', fallback: 'literal' },
    ];
    for (const authToken of rejected) {
      expect(validateAgainstSchema(configSchema, validConfig(authToken))).not.toEqual([]);
    }
  });

  test('rejects wrong types for the credential', () => {
    for (const authToken of [42, true, '', ['fixture-worker-token']]) {
      expect(validateAgainstSchema(configSchema, validConfig(authToken))).not.toEqual([]);
    }
  });

  test('loosening the credential loosened nothing else', () => {
    expect(validateAgainstSchema(configSchema, { domainExpert: {}, unknownSection: true })).not.toEqual([]);
    expect(validateAgainstSchema(configSchema, { domainExpert: { unknownKey: true } })).not.toEqual([]);
    expect(validateAgainstSchema(configSchema, { domainExpert: { enabled: 'yes' } })).not.toEqual([]);
    expect(validateAgainstSchema(configSchema, { domainExpert: { baseUrl: 8040 } })).not.toEqual([]);
    expect(validateAgainstSchema(configSchema, { domainExpert: { requestTimeoutSeconds: 0 } })).not.toEqual([]);
    expect(validateAgainstSchema(configSchema, { domainExpert: { requestTimeoutSeconds: 301 } })).not.toEqual([]);
  });

  test('declares the credential as a SecretRef surface so the gateway resolves it', () => {
    // A schema that merely tolerates the ref shape is half a fix: OpenClaw only
    // resolves plugin-config SecretRefs at paths the manifest declares here, so
    // without this the ref would validate and then arrive unresolved.
    expect(manifest.configContracts.secretInputs.paths).toEqual([
      { path: 'domainExpert.authToken', expected: 'string' },
    ]);
  });
});

describe('the plugin turning configured credentials into worker auth', () => {
  test('a literal credential becomes exactly one trimmed Bearer header', async () => {
    const requests = await capturedRequests(
      { domainExpert: { enabled: true, baseUrl: 'http://127.0.0.1:8040/v1', authToken: '  fixture-worker-token  ' } },
      [{ question: 'Fixture question' }],
    );

    expect(requests.map((request) => request.headers.get('authorization'))).toEqual([
      'Bearer fixture-worker-token',
    ]);
  });

  test('no configured credential sends no authorization header at all', async () => {
    const requests = await capturedRequests(
      { domainExpert: { enabled: true, baseUrl: 'http://127.0.0.1:8040/v1' } },
      [{ question: 'Fixture question' }],
    );

    expect(requests.map((request) => request.headers.get('authorization'))).toEqual([null]);
  });

  test('unresolved references preserve every registration but refuse each request without transport', async () => {
    const registered: NativeTool[] = [];
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => { requests++; throw new Error('must not send'); }) as unknown as typeof fetch;
    try {
      plugin.register({
        pluginConfig: { domainExpert: {
          enabled: true,
          authToken: { source: 'exec', provider: 'fixture', id: 'worker-bearer' },
        } },
        registerTool: (tool) => registered.push(resolveTool(tool)),
      });
      expect(registered.map((tool) => tool.name)).toEqual(manifest.contracts.tools);
      for (const tool of registered) {
        const result = await tool.execute('fixture', {});
        expect(result.isError).toBe(true);
        expect(result.details).toMatchObject({ error: { code: 'domain_expert_unresolved_secret_ref' } });
        expect(JSON.stringify(result)).toContain('plugins.entries.expert-agents.config.domainExpert.authToken');
        expect(JSON.stringify(result)).not.toContain('[object Object]');
      }
      expect(requests).toBe(0);
    } finally { globalThis.fetch = originalFetch; }
  });

  test('factory and research tools accept the supplied runtime snapshot over unresolved registration config', async () => {
    const registered: NativeTool[] = [];
    plugin.register({
      pluginConfig: { domainExpert: { enabled: true, authToken: { source: 'file', provider: 'fixture', id: 'worker' } } },
      registerTool: (definition) => registered.push(typeof definition === 'function' ? definition({
        senderIsOwner: true,
        runtimeConfig: { plugins: { entries: { 'expert-agents': { config: {
          domainExpert: { enabled: true, authToken: 'fixture-resolved' }, factory: { enabled: false },
        } } } } },
      }) : definition),
    });
    const result = await registered.find((tool) => tool.name === 'expert_factory')!.execute('fixture', {});
    expect(result.details).toMatchObject({ error: { code: 'factory_disabled' } });
    expect(JSON.stringify(result)).not.toContain('fixture-resolved');
  });

  test('retained tools use the current runtime credential and refuse later unresolved config', async () => {
    const headers: Array<string | null> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      headers.push(new Headers(init.headers).get('authorization'));
      return Response.json({ policy: { expert_agents_control_plane_only: true, raw_runtime_secrets_exposed: false } });
    }) as unknown as typeof fetch;
    const ref = { source: 'file', provider: 'fixture', id: 'worker' };
    const snapshot = (authToken: unknown) => ({ plugins: { entries: { 'expert-agents': {
      config: { domainExpert: { enabled: true, authToken } },
    } } } });
    let runtime: unknown = snapshot('fixture-first');
    let ask: NativeTool | undefined;
    try {
      plugin.register({
        pluginConfig: { domainExpert: { enabled: true, authToken: ref } },
        registerTool: (definition) => {
          const tool = typeof definition === 'function'
            ? definition({ getRuntimeConfig: () => runtime }) : definition;
          if (tool.name === 'domain_ask') ask = tool;
        },
      });
      expect((await ask!.execute('first', { question: 'Fixture?' })).isError).toBeUndefined();
      runtime = snapshot('fixture-rotated');
      expect((await ask!.execute('second', { question: 'Fixture?' })).isError).toBeUndefined();
      runtime = snapshot(ref);
      const refused = await ask!.execute('third', { question: 'Fixture?' });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused)).not.toContain('fixture-rotated');
      runtime = { plugins: { entries: {} } };
      expect((await ask!.execute('removed', { question: 'Fixture?' })).isError).toBe(true);
      expect(headers).toEqual(['Bearer fixture-first', 'Bearer fixture-rotated']);
    } finally { globalThis.fetch = originalFetch; }
  });

});

async function capturedRequestBodies(
  pluginConfig: unknown,
  calls: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  return (await capturedRequests(pluginConfig, calls)).map((request) => request.body);
}

async function capturedRequests(
  pluginConfig: unknown,
  calls: Array<Record<string, unknown>>,
): Promise<Array<{ body: Record<string, unknown>; headers: Headers }>> {
  const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
  const originalFetch = globalThis.fetch;
  // Install the transport stub before invoking the registered tools.
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    requests.push({
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      headers: new Headers(init.headers),
    });
    return Response.json({ policy: { expert_agents_control_plane_only: true, raw_runtime_secrets_exposed: false } });
  }) as unknown as typeof globalThis.fetch;
  try {
    let ask: RegisteredTool['execute'] | undefined;
    plugin.register({
      pluginConfig,
      registerTool: (tool) => {
        tool = resolveTool(tool);
        if (tool.name === 'domain_ask') ask = tool.execute;
      },
    });
    if (!ask) throw new Error('The plugin registered no domain_ask tool.');
    for (const params of calls) {
      expect((await ask('fixture-call', params)).isError).toBeUndefined();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  return requests;
}
