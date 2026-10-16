import { constants } from 'node:fs';
import { lstat, mkdtemp, open, rm } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { runFactory, FactoryError, type FactoryCommand } from '../packages/provisioning/src/factory.ts';
import type { FactoryConfig, FactoryGitHubSelection, FactoryRequest } from '../packages/provisioning/src/factory-types.ts';
import { DomainExpertClient } from '../packages/runtime/src/core/domain-expert-client.ts';
import type { ExpertAgentsConfig } from '../packages/runtime/src/core/config.ts';
import { OperationError } from '../packages/runtime/src/core/operation-error.ts';

/** Packaged Bun adapter. Credentials arrive through private stdin, never argv or a receipt. */
export async function executeFactoryEnvelope(value: unknown): Promise<unknown> {
  const envelope = value as { factory: FactoryConfig; worker: ExpertAgentsConfig; request: FactoryRequest; github?: FactoryGitHubSelection };
  if (!envelope || typeof envelope !== 'object' || !envelope.factory || !envelope.worker || !envelope.request) {
    return { error: { code: 'factory_invalid_envelope', message: 'Invalid factory invocation.' } };
  }
  try {
    const client = new DomainExpertClient(envelope.worker);
    return { result: await runFactory(envelope.factory, envelope.request, { command: factoryCommand(envelope.github), worker: (tool, params) => client.run(tool, params) }) };
  } catch (error) {
    // Child command stderr, provider response bodies and paths may include secrets or personal
    // content. Only our fixed factory errors are suitable for the model-facing protocol.
    return { error: error instanceof FactoryError || error instanceof OperationError
      ? { code: error.code, message: error.message }
      : { code: 'factory_step_failed', message: 'A factory dependency failed. Progress was retained; inspect the deployment privately before resuming.' } };
  }
}

// OpenClaw's managed profile id shape (tools.github.profileId).
const MANAGED_PROFILE_ID = /^ghp_[a-f0-9]{32}$/;
// OpenClaw's own worker checkout pattern: inherited credential helpers cleared and the stock gh
// helper as the only one. No askpass program or hook runs, so a missing credential fails instead
// of prompting and nothing else sees the profile.
const GITHUB_GIT_CONFIG = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', '-c', 'core.askPass=', '-c', `core.hooksPath=${devNull}`];
// Like OpenClaw's authenticated worker Git, inherited Git, GitHub CLI and askpass settings never
// reach the push: they could supply another credential, reroute the remote or trace headers.
const INHERITED_GIT_SETTINGS = /^(GIT_|GH_|GITHUB_|SSH_ASKPASS$|NETRC$|XDG_CONFIG_HOME$)/i;

/** Runs factory commands. Only commands the factory marks as GitHub operations receive the System identity. */
export function factoryCommand(github?: FactoryGitHubSelection): FactoryCommand {
  return async (argv, cwd, options) => {
    if (!options?.githubIdentity) return runFactoryCommand(argv, cwd);
    if (argv[0] !== 'git') throw new FactoryError('factory_invalid_command', 'Only Git commands can use the System GitHub identity.');
    const profileDir = await systemGitHubProfile(github);
    // An empty private HOME with no global or system Git config: host netrc entries, extra
    // headers, URL rewrites and hooks cannot authenticate or redirect this push.
    const home = await mkdtemp(join(tmpdir(), 'expert-factory-github-'));
    try {
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !INHERITED_GIT_SETTINGS.test(name)) env[name] = value;
      Object.assign(env, { HOME: home, GH_CONFIG_DIR: profileDir, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
      return await runFactoryCommand(['git', ...GITHUB_GIT_CONFIG, ...argv.slice(1)], cwd, env);
    } catch (error) {
      if (!(error instanceof FactoryError) || error.code !== 'factory_command_failed') throw error;
      throw new FactoryError('factory_command_failed', 'A required Git command failed as the System GitHub identity. Its private output was withheld; check that System GitHub is connected and can write the remote, then resume.');
    } finally { await rm(home, { recursive: true, force: true }); }
  };
}

/**
 * Resolves the System profile for one GitHub Git command. `GH_CONFIG_DIR` then points the stock
 * helper at it, so gh reads the Gateway-refreshed credential at use time. A missing, insecure or
 * tokenless profile refuses before Git starts; gh consults the OS keyring only for a profile
 * without a token, which this check excludes immediately before use.
 */
async function systemGitHubProfile(github: FactoryGitHubSelection | undefined): Promise<string> {
  const profileId = github?.profileId;
  const stateDir = github?.stateDir;
  if (typeof profileId !== 'string' || !MANAGED_PROFILE_ID.test(profileId) || typeof stateDir !== 'string' || stateDir.length > 4096 || !isAbsolute(stateDir) || /[\x00-\x1F\x7F]/.test(stateDir)) {
    throw new FactoryError('factory_github_identity_missing', 'Pushing to GitHub requires the System GitHub identity (tools.github). Connect System GitHub in OpenClaw, then resume; host GitHub logins are never used.');
  }
  const profileDir = join(stateDir, 'credentials', 'github', 'system', profileId);
  if (!await managedProfileHoldsToken(profileDir)) {
    throw new FactoryError('factory_github_identity_unavailable', 'The System GitHub profile is missing, not private or holds no token. Reconnect System GitHub in OpenClaw, then resume; host GitHub logins are never used.');
  }
  return profileDir;
}

// Mirrors OpenClaw's own profile check: an owner-only real directory whose owner-only hosts.yml
// and optional config.yml parse, and whose hosts.yml holds a github.com token. The token is never
// kept or returned.
async function managedProfileHoldsToken(profileDir: string): Promise<boolean> {
  const uid = process.getuid?.();
  try {
    const profile = await lstat(profileDir);
    if (!profile.isDirectory() || (profile.mode & 0o077) !== 0 || (uid !== undefined && profile.uid !== uid)) return false;
    await privateYaml(join(profileDir, 'config.yml'), uid).catch((error: unknown) => {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    });
    const hosts = await privateYaml(join(profileDir, 'hosts.yml'), uid) as Record<string, Record<string, unknown> | undefined> | null;
    const token = hosts?.['github.com']?.oauth_token;
    return typeof token === 'string' && token.trim() !== '';
  } catch { return false; }
}

// Opened without following links or blocking on a FIFO; anything but a small owner-only regular
// file that parses as YAML is refused.
async function privateYaml(path: string, uid: number | undefined): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || (uid !== undefined && metadata.uid !== uid) || metadata.size > 64 * 1024) throw new Error('not a private profile file');
    return Bun.YAML.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}

export async function runFactoryCommand(argv: string[], cwd?: string, env?: Record<string, string>): Promise<string> {
  // Read-only fleet lint can exceed 90 seconds on installations with many
  // plugins. Keep every check, bounded within the outer 300-second invocation.
  const healthCheck = argv[1] === 'doctor' && argv[2] === '--lint';
  const child = Bun.spawn(argv, { cwd, ...(env ? { env } : {}), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: healthCheck ? 180_000 : 90_000 });
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
}

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
