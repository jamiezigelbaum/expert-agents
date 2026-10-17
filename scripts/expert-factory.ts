import { constants, existsSync, rmSync } from 'node:fs';
import { lstat, mkdtemp, open, rm } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { cleanupOnExit, runFactory, FactoryError, type FactoryCommand, type FactoryFailureCategory } from '../packages/provisioning/src/factory.ts';
import { factoryNetworkEnv, type FactoryConfig, type FactoryGatewaySelection, type FactoryGitHubSelection, type FactoryRequest } from '../packages/provisioning/src/factory-types.ts';
import { DomainExpertClient } from '../packages/runtime/src/core/domain-expert-client.ts';
import type { ExpertAgentsConfig } from '../packages/runtime/src/core/config.ts';
import { OperationError } from '../packages/runtime/src/core/operation-error.ts';

/** Packaged Bun adapter. Credentials arrive through private stdin, never argv or a receipt. */
export async function executeFactoryEnvelope(value: unknown): Promise<unknown> {
  const envelope = value as { factory: FactoryConfig; worker: ExpertAgentsConfig; request: FactoryRequest; github?: FactoryGitHubSelection; gateway?: FactoryGatewaySelection };
  if (!envelope || typeof envelope !== 'object' || !envelope.factory || !envelope.worker || !envelope.request) {
    return { error: { code: 'factory_invalid_envelope', message: 'Invalid factory invocation.' } };
  }
  try {
    const client = new DomainExpertClient(envelope.worker);
    const command = factoryCommand(envelope.github);
    return { result: await runFactory(envelope.factory, envelope.request, {
      command, worker: (tool, params) => client.run(tool, params), workerHealth: () => client.health(),
      gatewayReloadMode: () => gatewayReloadMode(envelope.gateway, envelope.factory.openclawBin),
    }) };
  } catch (error) {
    // Child command stderr, provider response bodies and paths may include secrets or personal
    // content. Only our fixed factory errors, and their fixed phase, step and category, are
    // suitable for the model-facing protocol.
    return { error: error instanceof FactoryError
      ? { code: error.code, message: error.message, ...error.details }
      : error instanceof OperationError
        ? { code: error.code, message: error.message }
        : { code: 'factory_step_failed', message: 'A factory dependency failed. Progress was retained; inspect the deployment privately before resuming.' } };
  }
}

// The plugin passes the live runtime value. Without it (another host or a direct invocation), the
// factory reads the configured value; an unset path means OpenClaw's default.
export async function gatewayReloadMode(gateway: FactoryGatewaySelection | undefined, openclawBin: string): Promise<unknown> {
  if (gateway && typeof gateway === 'object') return gateway.reloadMode;
  const output = (await runFactoryCommand([openclawBin, 'config', 'get', 'gateway.reload.mode', '--json'])).trim();
  if (output === '') return undefined;
  try { return JSON.parse(output); }
  catch { throw new FactoryError('factory_command_failed', 'The configured Gateway reload mode could not be read.', { category: 'invalid' }); }
}

// OpenClaw's managed profile id shape (tools.github.profileId).
const MANAGED_PROFILE_ID = /^ghp_[a-f0-9]{32}$/;
// OpenClaw's own worker checkout pattern: inherited credential helpers cleared and the stock gh
// helper as the only one. No askpass program or hook runs, so a missing credential fails instead
// of prompting and nothing else sees the profile.
const GITHUB_GIT_CONFIG = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', '-c', 'core.askPass=', '-c', `core.hooksPath=${devNull}`];
// Like OpenClaw's authenticated worker Git, inherited Git, GitHub CLI and askpass settings never
// reach the push: they could supply another credential, reroute the remote or trace headers. The
// host's credential-free proxy and CA trust variables are kept, so a host behind a proxy can still
// reach GitHub.
const INHERITED_GIT_SETTINGS = /^(GIT_|GH_|GITHUB_|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$|SSL_CERT_(FILE|DIR)$|NODE_EXTRA_CA_CERTS$|SSH_ASKPASS$|NETRC$|XDG_CONFIG_HOME$)/i;
// Repository settings that could still redirect, proxy or authenticate the push: URL rewrites,
// HTTP settings, includes, and per-remote push URLs, proxies or remote helpers.
// GitHub CLI's check of the profile's active credential, the only gh command given the identity.
const GITHUB_PROBE = ['gh', 'auth', 'status', '--active', '--hostname', 'github.com'];
const REDIRECTING_REPOSITORY_SETTINGS = /^(url\.|http\.|include\.|includeif\.|remote\..+\.(pushurl|proxy|proxyauthmethod|vcs)$)/i;

/** Runs factory commands. Only commands the factory marks as GitHub operations receive the System identity. */
export function factoryCommand(github?: FactoryGitHubSelection): FactoryCommand {
  return async (argv, cwd, options) => {
    if (!options?.githubIdentity) return runFactoryCommand(argv, cwd);
    // Git, and GitHub CLI's own credential check, are the only programs that receive the identity.
    const probe = argv.length === GITHUB_PROBE.length && GITHUB_PROBE.every((arg, index) => argv[index] === arg);
    if (argv[0] !== 'git' && !probe) throw new FactoryError('factory_invalid_command', 'Only Git commands and the GitHub CLI credential check can use the System GitHub identity.');
    const profileDir = await systemGitHubProfile(github);
    // An empty private HOME with no global or system Git config: host netrc entries, extra
    // headers, URL rewrites and hooks cannot authenticate or redirect this push.
    const home = await mkdtemp(join(tmpdir(), 'expert-factory-github-'));
    // The plugin ends a timed-out or interrupted factory with SIGTERM; the HOME is removed then too.
    const stopCleanup = cleanupOnExit(() => rmSync(home, { recursive: true, force: true }));
    try {
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !INHERITED_GIT_SETTINGS.test(name)) env[name] = value;
      Object.assign(env, factoryNetworkEnv(process.env).env, { HOME: home, GH_CONFIG_DIR: profileDir, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
      // Git's credential helper is gh. A missing gh would surface only as a failed credential
      // prompt, so both programs must resolve on PATH before Git starts.
      for (const program of ['git', 'gh']) {
        if (!Bun.which(program, { PATH: env.PATH ?? '' })) throw new FactoryError('factory_command_failed', `${program} is not an executable on PATH.`, { category: 'missing_command' });
      }
      if (probe) return await runFactoryCommand(argv, home, env);
      // A check against a remote before the repository exists runs outside any repository.
      const workdir = cwd ?? home;
      if (cwd === undefined) env.GIT_CEILING_DIRECTORIES = dirname(home);
      // Every setting the push itself reads: with global and system config off, that is the
      // repository's config, its worktree config and anything they include.
      const settings = await runFactoryCommand(['git', 'config', '--list', '--name-only', '--includes', '-z'], workdir, env);
      if (settings.split('\0').some((name) => REDIRECTING_REPOSITORY_SETTINGS.test(name.trim()))) {
        throw new FactoryError('factory_repository_git_config', 'The agent repository has its own Git URL rewrite, HTTP, include, push-URL or remote-helper setting that could redirect or authenticate the GitHub push. Remove it, then resume.');
      }
      return await runFactoryCommand(['git', ...GITHUB_GIT_CONFIG, ...argv.slice(1)], workdir, env);
    } catch (error) {
      if (!(error instanceof FactoryError) || error.code !== 'factory_command_failed' || error.details.category === 'missing_command') throw error;
      throw new FactoryError('factory_command_failed', 'A required command failed as the System GitHub identity. Its private output was withheld; check that System GitHub is connected and can write the remote, then resume.', error.details);
    } finally {
      stopCleanup();
      await rm(home, { recursive: true, force: true });
    }
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
  let child;
  try { child = Bun.spawn(argv, { cwd, ...(env ? { env } : {}), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: healthCheck ? 180_000 : 90_000 }); }
  catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== 'ENOENT' && code !== 'EACCES') throw error;
    // Bun reports a missing working directory the same way as a missing program.
    if (cwd !== undefined && !existsSync(cwd)) throw new FactoryError('factory_command_failed', 'A required command could not start because its working directory is missing.', { category: 'not_found' });
    throw new FactoryError('factory_command_failed', 'A required program could not start; it is missing or not executable.', { category: 'missing_command' });
  }
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
  // A fresh OpenClaw installation may have no Telegram section or reload setting. Recognize only
  // the CLI's exact unset-path contracts; authentication, parse and validation failures must not
  // be converted into an empty or default configuration.
  const plainError = errorOutput.replace(/\x1b\[[0-9;]*m/g, '').trim();
  const unset = UNSET_CONFIG_DEFAULTS.get(argv[3] ?? '');
  if (code === 1 && unset !== undefined && argv.length === 5 && argv[1] === 'config' && argv[2] === 'get' && argv[4] === '--json'
    && isUnsetConfigPath(argv[3]!, output, plainError)) return unset;
  if (code !== 0) throw new FactoryError('factory_command_failed', healthCheck
    ? 'The OpenClaw health check failed or exceeded its 180-second budget. Its private output was withheld; inspect the operation before retrying.'
    : `A required ${argv[0] === 'git' ? 'Git' : 'deployment'} command failed. Its private output was withheld; inspect the operation before retrying.`,
  { category: classifyFailure(child.signalCode, `${plainError}\n${output}`) });
  return output;
}

// Unset paths the factory may read, with the value an unset path means.
const UNSET_CONFIG_DEFAULTS = new Map([['channels.telegram', '{}'], ['gateway.reload.mode', '']]);

function isUnsetConfigPath(path: string, output: string, plainError: string): boolean {
  // OpenClaw up to 2026.9: a plain stderr message and no output.
  if (output.trim() === '' && plainError === `Config path not found: ${path}. Run openclaw config validate to inspect config shape.`) return true;
  // OpenClaw 2026.10: a JSON error on stdout and nothing on stderr.
  if (plainError !== '') return false;
  try {
    const parsed = JSON.parse(output) as { ok?: unknown; error?: { type?: unknown; message?: unknown } };
    return parsed.ok === false && parsed.error?.type === 'cli_error' && typeof parsed.error.message === 'string'
      && parsed.error.message.startsWith(`Config path is valid but unset: ${path}. The runtime default applies until`);
  } catch { return false; }
}

// A closed set of causes read privately from a failed command's output. Only the category leaves
// this function; the output itself never does.
const FAILURE_PATTERNS: [FactoryFailureCategory, RegExp][] = [
  ['auth', /authentication failed|could not read (username|password)|terminal prompts disabled|invalid username or (password|token)|bad credentials|permission to .* denied|permission denied|requires authentication|not logged in|failed to log in|token .*(invalid|expired|revoked)|unauthori[sz]ed|forbidden|returned error: 40[13]|http 40[13]\b/i],
  ['not_found', /repository not found|\bnot found\b|does not exist|does not appear to be a git repository|no such (remote|agent|file)|unknown agent|returned error: 404|http 404\b/i],
  ['rejected', /\[(remote )?rejected\]|non-fast-forward|fetch first|hook declined|protected branch/i],
  ['unavailable', /could not resolve host|connection (refused|reset|timed out)|failed to connect|couldn't connect|error connecting|dial tcp|i\/o timeout|network is unreachable|econnrefused|enotfound|etimedout|eai_again|rate limit|service unavailable|bad gateway|returned error: 5\d\d|http 5\d\d\b|gateway (is )?(not running|unreachable|closed)/i],
  ['invalid', /\binvalid\b|validation failed|failed validation|schema/i],
];

export function classifyFailure(signal: string | null, output: string): FactoryFailureCategory {
  // The time limit stops a command with SIGTERM; a command that crashes on another signal failed.
  if (signal === 'SIGTERM' || signal === 'SIGKILL') return 'timeout';
  if (signal !== null) return 'failed';
  return FAILURE_PATTERNS.find(([, pattern]) => pattern.test(output))?.[0] ?? 'failed';
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
