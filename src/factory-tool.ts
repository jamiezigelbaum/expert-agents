import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ExpertAgentsConfig } from '../packages/runtime/src/core/config.ts';
import type { FactoryConfig, FactoryRequest } from '../packages/provisioning/src/factory-types.ts';

export interface FactoryPluginConfig extends FactoryConfig { bunBin: string }
export interface FactoryToolContext {
  agentId?: string;
  workspaceDir?: string;
  senderIsOwner?: boolean;
  sandboxed?: boolean;
  fsPolicy?: { workspaceOnly: boolean };
}

export const factoryParameters = {
  type: 'object', additionalProperties: false,
  required: ['action', 'agent_id'],
  properties: {
    action: { type: 'string', enum: ['create', 'resume', 'status'], description: 'Create plans unless apply=true. Resume advances a saved creation. Status only reads saved progress.' },
    agent_id: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,47}$', description: 'New lowercase agent id, also its domain id and Telegram account id. main/default are reserved.' },
    apply: { type: 'boolean', description: 'Set true only when the owner has authorized creating this expert; otherwise the call is a plan.' },
    display_name: { type: 'string', maxLength: 64, description: 'Required for create.' },
    purpose: { type: 'string', maxLength: 8000, description: 'Required for create. The requested expertise, behavior and boundaries. Never include secrets.' },
    telegram_username: { type: 'string', maxLength: 32, description: 'Required for create. A suggested bot username ending in bot. Availability cannot be checked before creation, so do not spend effort on it: if Telegram reports it taken, the owner picks another name inside the confirmation flow and the factory adopts the bot actually created.' },
    soul: { type: 'string', maxLength: 20000, description: 'Optional authored soul, when the owner authorized drafting it. End with an italic change-notification line. Otherwise a minimal purpose-based soul is written.' },
  },
};

/** One child per invocation: no human wait, no shell, no token-bearing arguments. */
export async function invokeFactory(
  factory: Partial<FactoryPluginConfig>, worker: ExpertAgentsConfig, request: unknown,
  context: FactoryToolContext, signal?: AbortSignal,
): Promise<{ result?: unknown; error?: { code: string; message: string } }> {
  if (context.senderIsOwner !== true || context.sandboxed === true || context.fsPolicy?.workspaceOnly === true) {
    return failure('factory_owner_required', 'Agent creation requires a trusted owner session with host filesystem authority.');
  }
  if (factory.enabled !== true) return failure('factory_disabled', 'The deployment owner must configure and enable the expert factory first.');
  if (!worker.domainExpert.enabled) return failure('factory_worker_disabled', 'Enable and configure the Expert Agents worker before creating an agent.');
  if (!factory.bunBin?.startsWith('/')) return failure('factory_invalid_config', 'Configure an absolute Bun executable path for the packaged factory.');
  signal?.throwIfAborted();
  const entry = fileURLToPath(new URL('./factory.js', import.meta.url));
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'HOME', 'USER', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_STATE_DIR', 'OPENCLAW_PROFILE']) {
    if (process.env[name]) env[name] = process.env[name]!;
  }
  return new Promise((resolve) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(factory.bunBin!, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: grouped });
    let output = '';
    let bytes = 0;
    let settled = false;
    const finish = (value: { result?: unknown; error?: { code: string; message: string } }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const stop = () => { try { if (grouped && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill(); } catch { /* already exited */ } };
    const abort = () => { stop(); finish(failure('factory_interrupted', 'Factory invocation interrupted. Inspect saved progress before resuming.')); };
    const timeout = setTimeout(() => { stop(); finish(failure('factory_timeout', 'Factory invocation timed out. Inspect saved progress before resuming.')); }, 300_000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 64 * 1024) { stop(); finish(failure('factory_output_limit', 'Factory output exceeded its bounded response limit.')); }
      else output += chunk.toString('utf8');
    });
    // stderr is drained and discarded: it can include loader or provider credentials.
    child.stderr.on('data', () => {});
    child.on('error', () => finish(failure('factory_unavailable', 'The packaged factory could not start. Check the configured Bun path and installed artifact.')));
    child.stdin.on('error', () => {});
    child.on('close', () => {
      if (settled) return;
      try {
        const parsed = JSON.parse(output);
        if (parsed.result?.kind === 'expert_factory' || (typeof parsed.error?.code === 'string' && typeof parsed.error?.message === 'string')) finish(parsed);
        else finish(failure('factory_invalid_response', 'The packaged factory returned an invalid response.'));
      } catch { finish(failure('factory_invalid_response', 'The packaged factory returned no valid response.')); }
    });
    child.stdin.end(JSON.stringify({ factory, worker, request: request as FactoryRequest }));
  });
}

function failure(code: string, message: string) { return { error: { code, message } }; }
