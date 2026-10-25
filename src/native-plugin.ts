import { DomainExpertClient, type DomainExpertTool } from '../packages/runtime/src/core/domain-expert-client.ts';
import type { ExpertAgentsConfig } from '../packages/runtime/src/core/config.ts';
import { OperationError } from '../packages/runtime/src/core/operation-error.ts';
import { readSecretInput } from '../packages/runtime/src/core/secret-input.ts';
import { factoryParameters, invokeFactory, type FactoryPluginConfig, type FactoryToolContext } from './factory-tool.ts';
import type { FactoryGatewaySelection, FactoryGitHubSelection } from '../packages/provisioning/src/factory-types.ts';
import { researchToolSchemas } from './tool-schemas.ts';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const AUTH_TOKEN_CONFIG_PATH = 'plugins.entries.expert-agents.config.domainExpert.authToken';
const AUTH_TOKEN_CONTRACT_PATH = 'domainExpert.authToken';

interface RuntimeToolContext extends FactoryToolContext {
  runtimeConfig?: unknown;
  getRuntimeConfig?: () => unknown;
}

interface OpenClawPluginApi {
  pluginConfig?: unknown;
  runtime?: { state?: { resolveStateDir?: (env: NodeJS.ProcessEnv) => string } };
  registerTool(tool: NativeTool | ((context: RuntimeToolContext) => NativeTool), options?: { name: string }): void;
}

export interface NativeTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<NativeToolResult>;
}

interface NativeToolResult {
  // Text first; a page image, when there is one, follows it.
  content: [{ type: 'text'; text: string }, ...Array<{ type: 'image'; data: string; mimeType: string }>];
  details?: unknown;
  isError?: boolean;
}

const definitions: Array<{ name: DomainExpertTool; description: string }> = [
  { name: 'domain_agent', description: 'Plan or inspect an independently managed domain expert.' },
  { name: 'domain_library', description: 'Search, read and view the pages of a domain page library: hybrid search, exact grep, whole pages or sections, page ranges and page images.' },
  { name: 'library_ingest', description: 'Add sources to a domain page library (files, web pages, Notion, audio and video): page units, local OCR, local transcription and figure descriptions, then indexing. Runs in the background; check status by job id.' },
  { name: 'annas_archive_search', description: 'Search candidate book metadata without downloading.' },
  { name: 'annas_archive_import', description: 'Import an explicitly approved item through the configured bounded sink.' },
];

const plugin = {
  id: 'expert-agents',
  name: 'Expert Agents',
  description: 'Independent expert-agent runtime and skills for OpenClaw.',
  register(api: OpenClawPluginApi) {
    // Domain custody belongs to this registration generation. Credential reload
    // must not unbind a retained expert when factory configuration is removed.
    const bindingFactory = asRecord(asRecord(api.pluginConfig).factory) as unknown as Partial<FactoryPluginConfig>;
    for (const definition of definitions) {
      api.registerTool((context) => ({
        name: definition.name,
        label: definition.name.split('_').map(titleCase).join(' '),
        description: definition.description,
        parameters: researchToolSchemas[definition.name],
        async execute(_toolCallId, params, signal) {
          signal?.throwIfAborted?.();
          try {
            const current = currentPluginConfig(api, context);
            const config = configFromPluginConfig(current);
            const boundDomainId = await factoryDomain(bindingFactory, context);
            const client = new DomainExpertClient(boundDomainId
              ? { ...config, domainExpert: { ...config.domainExpert, defaultDomainId: boundDomainId } }
              : config);
            const request = asParams(params);
            if (boundDomainId && request.domain_id !== undefined && request.domain_id !== boundDomainId) {
              throw new OperationError('domain_expert_domain_mismatch', 'This factory-created agent is bound to its own library domain.');
            }
            const result = await client.run(definition.name, request);
            return resultPayload(result);
          } catch (error) {
            if (error instanceof OperationError) {
              const detail = { error: { code: error.code, message: error.message, remediation: error.remediation } };
              return { content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }], details: detail, isError: true };
            }
            throw error;
          }
        },
      }), { name: definition.name });
    }
    api.registerTool((context) => ({
      name: 'expert_factory',
      label: 'Expert Factory',
      description: 'Create or resume an independent expert agent with a page library and Telegram bot. Owner-only and deployment-enabled. Returns a Telegram confirmation link promptly; keep resuming after the owner confirms until readiness or an explicit deployment prerequisite is reported.',
      parameters: factoryParameters,
      async execute(_toolCallId, params, signal) {
        try {
          const current = currentPluginConfig(api, context);
          const config = configFromPluginConfig(current);
          const factory = asRecord(asRecord(current).factory) as unknown as Partial<FactoryPluginConfig>;
          const response = await invokeFactory(factory, config, params, context, signal, systemGitHub(api, context), gatewayReload(context));
          return response.error
            ? { content: [{ type: 'text', text: JSON.stringify(response) }], details: response, isError: true }
            : resultPayload(response.result);
        } catch (error) {
          if (!(error instanceof OperationError)) throw error;
          const detail = { error: { code: error.code, message: error.message, remediation: error.remediation } };
          return { content: [{ type: 'text', text: JSON.stringify(detail) }], details: detail, isError: true };
        }
      },
    }), { name: 'expert_factory' });
  },
};

// OpenClaw tool contexts carry the full runtime snapshot. Read it on every
// invocation so retained tools observe credential rotation and config removal.
// Older hosts without that surface still supply entry-scoped pluginConfig.
function currentPluginConfig(api: OpenClawPluginApi, context: RuntimeToolContext): unknown {
  if (context.getRuntimeConfig || context.runtimeConfig !== undefined) {
    const runtime = context.getRuntimeConfig ? context.getRuntimeConfig() : context.runtimeConfig;
    const entry = asRecord(asRecord(asRecord(runtime).plugins).entries)['expert-agents'];
    return asRecord(entry).config;
  }
  return api.pluginConfig;
}

// The factory pushes as the Gateway's System GitHub identity (tools.github), the profile the
// Gateway keeps refreshed. Read the selection from the live runtime snapshot on every invocation so
// reconnects and profile changes apply; the factory validates the profile itself before each use
// and refuses rather than falling back when either value is absent.
function systemGitHub(api: OpenClawPluginApi, context: RuntimeToolContext): FactoryGitHubSelection {
  const runtime = context.getRuntimeConfig ? context.getRuntimeConfig() : context.runtimeConfig;
  const profileId = asRecord(asRecord(asRecord(runtime).tools).github).profileId;
  let stateDir: unknown;
  try { stateDir = api.runtime?.state?.resolveStateDir?.(process.env); } catch { stateDir = undefined; }
  return { profileId, stateDir };
}

// The running Gateway's reload mode from the same live snapshot. With reload off, config the
// factory writes is never loaded, so its preflight refuses before creating anything.
function gatewayReload(context: RuntimeToolContext): FactoryGatewaySelection | undefined {
  if (!context.getRuntimeConfig && context.runtimeConfig === undefined) return undefined;
  const runtime = context.getRuntimeConfig ? context.getRuntimeConfig() : context.runtimeConfig;
  return { reloadMode: asRecord(asRecord(asRecord(runtime).gateway).reload).mode };
}

async function factoryDomain(factory: Partial<FactoryPluginConfig>, context: FactoryToolContext): Promise<string | undefined> {
  // Creation authority can be switched off after provisioning. Existing experts must
  // retain their domain binding when that switch changes.
  if (!factory.rootDir || !context.agentId || !context.workspaceDir) return undefined;
  const root = await realpath(factory.rootDir);
  return resolve(context.workspaceDir) === join(root, 'agents', context.agentId) ? context.agentId : undefined;
}

function configFromPluginConfig(value: unknown): ExpertAgentsConfig {
  const root = asRecord(value);
  const domainExpert = asRecord(root.domainExpert);
  // Registration leaves references opaque. A request without a resolved
  // runtime credential fails here before any worker request or factory spawn.
  const authToken = readSecretInput(
    domainExpert.authToken,
    AUTH_TOKEN_CONFIG_PATH,
    AUTH_TOKEN_CONTRACT_PATH,
  );
  return {
    domainExpert: {
      enabled: domainExpert.enabled === true,
      baseUrl: stringValue(domainExpert.baseUrl) || 'http://127.0.0.1:8040/v1',
      requestTimeoutSeconds: positiveNumber(domainExpert.requestTimeoutSeconds, 120),
      ...(authToken ? { authToken } : {}),
      ...(stringValue(domainExpert.defaultDomainId)
        ? { defaultDomainId: stringValue(domainExpert.defaultDomainId) }
        : {}),
    },
  };
}

function resultPayload(result: unknown): NativeToolResult {
  // A page image (domain_library view_page) goes to the model as an image
  // block, not as base64 inside the JSON text.
  const { image, ...rest } = asRecord(result);
  const picture = asRecord(image);
  if (typeof picture.data === 'string' && typeof picture.mime_type === 'string') {
    return {
      content: [{ type: 'text', text: JSON.stringify(rest, null, 2) }, { type: 'image', data: picture.data, mimeType: picture.mime_type }],
      details: { status: 'completed', result: rest },
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    details: { status: 'completed', result },
  };
}

function asParams(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default plugin;
