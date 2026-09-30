import { runFactory, FactoryError, type FactoryCommand } from '../packages/provisioning/src/factory.ts';
import type { FactoryConfig, FactoryRequest } from '../packages/provisioning/src/factory-types.ts';
import { DomainExpertClient } from '../packages/runtime/src/core/domain-expert-client.ts';
import type { ExpertAgentsConfig } from '../packages/runtime/src/core/config.ts';
import { OperationError } from '../packages/runtime/src/core/operation-error.ts';

/** Packaged Bun adapter. Credentials arrive through private stdin, never argv or a receipt. */
export async function executeFactoryEnvelope(value: unknown): Promise<unknown> {
  const envelope = value as { factory: FactoryConfig; worker: ExpertAgentsConfig; request: FactoryRequest };
  if (!envelope || typeof envelope !== 'object' || !envelope.factory || !envelope.worker || !envelope.request) {
    return { error: { code: 'factory_invalid_envelope', message: 'Invalid factory invocation.' } };
  }
  try {
    const client = new DomainExpertClient(envelope.worker);
    return { result: await runFactory(envelope.factory, envelope.request, { command: runFactoryCommand, worker: (tool, params) => client.run(tool, params) }) };
  } catch (error) {
    // Child command stderr, provider response bodies and paths may include secrets or personal
    // content. Only our fixed factory errors are suitable for the model-facing protocol.
    return { error: error instanceof FactoryError || error instanceof OperationError
      ? { code: error.code, message: error.message }
      : { code: 'factory_step_failed', message: 'A factory dependency failed. Progress was retained; inspect the deployment privately before resuming.' } };
  }
}

export const runFactoryCommand: FactoryCommand = async (argv, cwd) => {
  // Read-only fleet lint can exceed 90 seconds on installations with many
  // plugins. Keep every check, bounded within the outer 300-second invocation.
  const healthCheck = argv[1] === 'doctor' && argv[2] === '--lint';
  const child = Bun.spawn(argv, { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: healthCheck ? 180_000 : 90_000 });
  const readBounded = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > 1024 * 1024) { child.kill(); throw new FactoryError('factory_command_output_limit', 'A factory command exceeded its output limit.'); }
        parts.push(item.value);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(parts).toString('utf8');
  };
  const [code, output, errorOutput] = await Promise.all([child.exited, readBounded(child.stdout), readBounded(child.stderr)]);
  // A fresh OpenClaw installation may have no Telegram section. Recognize only the
  // installed CLI's exact missing-path contract; authentication, parse and validation
  // failures must not be converted into an empty configuration.
  const plainError = errorOutput.replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (code === 1 && argv.slice(1).join('\0') === ['config', 'get', 'channels.telegram', '--json'].join('\0')
    && output.trim() === '' && plainError === 'Config path not found: channels.telegram. Run openclaw config validate to inspect config shape.') return '{}';
  if (code !== 0) throw new FactoryError('factory_command_failed', healthCheck
    ? 'The OpenClaw health check failed or exceeded its 180-second budget. Its private output was withheld; inspect the operation before retrying.'
    : `A required ${argv[0] === 'git' ? 'Git' : 'deployment'} command failed. Its private output was withheld; inspect the operation before retrying.`);
  return output;
};

// Bun's entrypoint test spelled without import.meta.main: OpenClaw's plugin source scan
// (2026.9.5) rewrites import.meta.url but rejects any other import.meta member in dist/factory.js.
if (Bun.fileURLToPath(import.meta.url) === Bun.main) {
  try {
    // Refuse unbounded requests before parsing. Bun stdin remains private process input.
    const bytes = await Bun.stdin.bytes();
    if (bytes.byteLength > 64 * 1024) throw new Error('request too large');
    console.log(JSON.stringify(await executeFactoryEnvelope(JSON.parse(new TextDecoder().decode(bytes)))));
  } catch {
    console.log(JSON.stringify({ error: { code: 'factory_invalid_envelope', message: 'The factory requires one bounded JSON request on stdin.' } }));
    process.exitCode = 1;
  }
}
