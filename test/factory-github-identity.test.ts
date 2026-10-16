import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { factoryCommand } from '../scripts/expert-factory.ts';
import type { FactoryGitHubSelection } from '../packages/provisioning/src/factory-types.ts';

// The factory runs Git from the Gateway process, whose environment carries no GitHub credential.
// These tests push through a real Git smart-HTTP server that accepts only the managed System
// profile's credential, using a stand-in `gh` that follows GitHub CLI's precedence: environment
// token, then GH_CONFIG_DIR's hosts.yml, then the host login in ~/.config/gh.
const MANAGED = `synthetic-managed-credential-${randomUUID()}`;
const ROTATED = `synthetic-rotated-credential-${randomUUID()}`;
const HOST = `synthetic-host-credential-${randomUUID()}`;
const PUSH = ['git', 'push', '--set-upstream', 'origin', 'HEAD'];
const IDENTITY_ARGS = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', '-c', 'core.askPass=', '-c', 'core.hooksPath=/dev/null'];
const GIT_ISOLATED = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

const roots: string[] = [];
const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const profileId = () => `ghp_${randomBytes(16).toString('hex')}`;
const exists = (path: string) => lstat(path).then(() => true, () => false);
const hostsYaml = (token: string) => `github.com:\n    user: example-user\n    oauth_token: ${token}\n    git_protocol: https\n    users:\n        example-user:\n            oauth_token: ${token}\n`;

async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn(['git', ...args], { cwd, env: { ...process.env, ...GIT_ISOLATED, ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout: stdout.trim() };
}

async function writeProfile(stateDir: string, id: string, hosts: string): Promise<string> {
  const dir = join(stateDir, 'credentials', 'github', 'system', id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await writeFile(join(dir, 'hosts.yml'), hosts, { mode: 0o600 });
  return dir;
}

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'expert-github-identity-')));
  roots.push(base);
  const stateDir = join(base, 'state');
  const id = profileId();
  const profileDir = await writeProfile(stateDir, id, hostsYaml(MANAGED));
  const home = join(base, 'home');
  // The host's own GitHub CLI login, which the factory must never use.
  await mkdir(join(home, '.config', 'gh'), { recursive: true });
  await writeFile(join(home, '.config', 'gh', 'hosts.yml'), hostsYaml(HOST), { mode: 0o600 });
  const bin = join(base, 'bin');
  await mkdir(bin);
  const ghLog = join(base, 'gh.log');
  const hostLog = join(base, 'host-helper.log');
  await writeFile(join(bin, 'gh.mjs'), `import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
await Bun.stdin.text();
appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify({ args, configDir: process.env.GH_CONFIG_DIR ?? null, ghToken: process.env.GH_TOKEN !== undefined, githubToken: process.env.GITHUB_TOKEN !== undefined }) + '\\n');
if (args.join(' ') !== 'auth git-credential get') process.exit(0);
let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  try { token = Bun.YAML.parse(readFileSync((process.env.GH_CONFIG_DIR || process.env.HOME + '/.config/gh') + '/hosts.yml', 'utf8'))?.['github.com']?.oauth_token; } catch {}
}
if (!token) process.exit(1);
process.stdout.write('username=x-access-token\\npassword=' + token + '\\n');
`);
  await writeFile(join(bin, 'gh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(bin, 'gh.mjs'))} "$@"\n`, { mode: 0o700 });
  // Inherited host credential sources: a helper and an askpass program that answer with the host credential.
  for (const name of ['host-helper', 'host-askpass']) {
    await writeFile(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(hostLog)}\ncat >/dev/null 2>&1 || true\nprintf 'username=host-user\\npassword=%s\\n' ${JSON.stringify(HOST)}\n`, { mode: 0o700 });
  }

  const server = { accepted: MANAGED, seen: [] as string[] };
  const repositories = join(base, 'server');
  await mkdir(repositories);
  const bare = join(repositories, 'example.git');
  await git(base, ['init', '--quiet', '--bare', bare]);
  const listener = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const header = request.headers.get('authorization');
    const presented = header?.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString('utf8') : undefined;
    server.seen.push(presented === undefined ? 'none' : presented === `x-access-token:${server.accepted}` ? 'managed'
      : presented.includes(HOST) ? 'host' : 'other');
    if (presented !== `x-access-token:${server.accepted}`) {
      return new Response(`credential refused: ${presented ?? ''}`, { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="fixture"' } });
    }
    return gitHttpBackend(request, repositories, base);
  } });
  servers.push(listener);
  const remote = `http://127.0.0.1:${listener.port}/example.git`;
  const workspace = join(base, 'workspace');
  await git(base, ['init', '--quiet', '--initial-branch=main', workspace]);
  await git(workspace, ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'Initialize']);
  await git(workspace, ['remote', 'add', 'origin', remote]);

  const harness = join(base, 'harness.ts');
  await writeFile(harness, `import { factoryCommand } from ${JSON.stringify(resolve('scripts/expert-factory.ts'))};
const { selection, argv, cwd, identity } = JSON.parse(await Bun.stdin.text());
const spawned = [];
const spawn = Bun.spawn;
Bun.spawn = (command, options) => { spawned.push({ argv: [...command], env: options?.env ?? null }); return spawn(command, options); };
try { await factoryCommand(selection)(argv, cwd, identity ? { githubIdentity: true } : undefined); console.log(JSON.stringify({ ok: true, spawned })); }
catch (error) { console.log(JSON.stringify({ ok: false, code: error.code, message: String(error), spawned })); }
`);
  // Exactly what the plugin's allowlist gives the factory process; no GitHub identity of any kind.
  const gatewayEnv = { PATH: `${bin}:${process.env.PATH}`, HOME: home, USER: 'example', TMPDIR: tmpdir() };
  const selection: FactoryGitHubSelection = { profileId: id, stateDir };

  const run = async (options: { identity: boolean; env?: Record<string, string>; selection?: FactoryGitHubSelection }) => {
    const child = Bun.spawn([process.execPath, harness], {
      cwd: workspace, env: options.env ?? gatewayEnv, stdout: 'pipe', stderr: 'pipe',
      stdin: new Blob([JSON.stringify({ selection: options.selection ?? selection, argv: PUSH, cwd: workspace, identity: options.identity })]),
    });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const result = JSON.parse(stdout) as { ok: boolean; code?: string; message?: string; spawned: { argv: string[]; env: Record<string, string> | null }[] };
    return { ...result, transcript: stdout + stderr };
  };
  const ghCalls = async () => (await readFile(ghLog, 'utf8').catch(() => '')).split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; configDir: string | null; ghToken: boolean; githubToken: boolean });
  const hostCalls = async () => (await readFile(hostLog, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const pushed = async () => (await git(bare, ['rev-parse', '--verify', '--quiet', 'refs/heads/main'])).stdout;
  const head = async () => (await git(workspace, ['rev-parse', 'HEAD'])).stdout;
  const decoy = join(base, 'decoy.git');
  const hookLog = join(base, 'hook.log');
  return { base, stateDir, id, profileDir, home, bin, bare, decoy, hookLog, remote, workspace, server, gatewayEnv, selection, run, ghCalls, hostCalls, pushed, head };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

// CGI bridge to `git http-backend`: a real smart-HTTP Git remote, behind the fixture's authentication.
async function gitHttpBackend(request: Request, root: string, home: string): Promise<Response> {
  const url = new URL(request.url);
  const body = new Uint8Array(await request.arrayBuffer());
  const child = Bun.spawn(['git', 'http-backend'], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...GIT_ISOLATED, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1',
      REQUEST_METHOD: request.method, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REMOTE_USER: 'x-access-token', REMOTE_ADDR: '127.0.0.1',
      CONTENT_TYPE: request.headers.get('content-type') ?? '', CONTENT_LENGTH: String(body.byteLength),
      HTTP_CONTENT_ENCODING: request.headers.get('content-encoding') ?? '', GIT_PROTOCOL: request.headers.get('git-protocol') ?? '' },
    stdin: body, stdout: 'pipe', stderr: 'pipe',
  });
  const [output] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
  const bytes = Buffer.from(output);
  const split = bytes.indexOf('\r\n\r\n') >= 0 ? bytes.indexOf('\r\n\r\n') + 4 : bytes.indexOf('\n\n') + 2;
  const headers = new Headers();
  let status = 200;
  for (const line of bytes.subarray(0, split).toString('utf8').split(/\r?\n/).filter(Boolean)) {
    const [name, ...rest] = line.split(':');
    if (name!.toLowerCase() === 'status') status = Number.parseInt(rest.join(':').trim(), 10);
    else headers.set(name!, rest.join(':').trim());
  }
  return new Response(bytes.subarray(split), { status, headers });
}

describe('factory pushes as the System GitHub identity', () => {
  test('authenticates with only the Gateway environment and no host credential configuration', async () => {
    const f = await fixture();
    const result = await f.run({ identity: true });
    expect(result).toMatchObject({ ok: true });
    expect(await f.pushed()).toBe(await f.head());
    expect(f.server.seen).toContain('managed');
    expect(f.server.seen).not.toContain('host');
    // One Git process: the stock helper only, inherited helpers and askpass cleared, nothing else widened.
    expect(result.spawned).toHaveLength(1);
    expect(result.spawned[0]!.argv).toEqual(['git', ...IDENTITY_ARGS, 'push', '--set-upstream', 'origin', 'HEAD']);
    const env = result.spawned[0]!.env!;
    expect(Object.keys(env).sort()).toEqual(['GH_CONFIG_DIR', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'HOME', 'PATH', 'TMPDIR', 'USER']);
    expect(env).toMatchObject({ GH_CONFIG_DIR: f.profileDir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
    // The push ran with an empty private HOME that is removed afterwards.
    expect(env.HOME).not.toBe(f.home);
    expect(await exists(env.HOME!)).toBe(false);
    const lookups = (await f.ghCalls()).filter((call) => call.args.join(' ') === 'auth git-credential get');
    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups.every((call) => call.configDir === f.profileDir && !call.ghToken && !call.githubToken)).toBe(true);
    // The credential reaches Git only through gh's helper pipe: never argv, environment or output.
    expect(JSON.stringify(result.spawned)).not.toContain(MANAGED);
    expect(result.transcript).not.toContain(MANAGED);
  }, 30_000);

  test('ignores ambient tokens, inherited and URL-scoped credential helpers, injected Git config and askpass', async () => {
    const f = await fixture();
    const helper = `!${join(f.bin, 'host-helper')}`;
    await writeFile(join(f.home, '.gitconfig'), `[credential]\n\thelper = ${helper}\n[credential "${f.remote}"]\n\thelper = ${helper}\n[core]\n\taskPass = ${join(f.bin, 'host-askpass')}\n`);
    const result = await f.run({ identity: true, env: { ...f.gatewayEnv, GH_TOKEN: HOST, GITHUB_TOKEN: HOST,
      GIT_ASKPASS: join(f.bin, 'host-askpass'), SSH_ASKPASS: join(f.bin, 'host-askpass'),
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: helper,
      GIT_CONFIG_PARAMETERS: `'credential.helper'='${helper}'`, GIT_TRACE_CURL: join(f.base, 'curl-trace') } });
    expect(result).toMatchObject({ ok: true });
    expect(await f.pushed()).toBe(await f.head());
    expect(f.server.seen).not.toContain('host');
    expect(await f.hostCalls()).toEqual([]);
    expect((await f.ghCalls()).every((call) => !call.ghToken && !call.githubToken)).toBe(true);
    expect(Object.keys(result.spawned[0]!.env!).filter((name) => /^(GH_TOKEN|GITHUB_|GIT_ASKPASS|SSH_ASKPASS|GIT_CONFIG_(COUNT|KEY|VALUE|PARAMETERS)|GIT_TRACE)/.test(name))).toEqual([]);
    expect(await exists(join(f.base, 'curl-trace'))).toBe(false);
  }, 30_000);

  test.each([
    ['a netrc entry', async (f: Fixture) => {
      await writeFile(join(f.home, '.netrc'), `machine 127.0.0.1 login host-user password ${HOST}\n`, { mode: 0o600 });
    }],
    ['a global extra Authorization header', async (f: Fixture) => {
      await writeFile(join(f.home, '.gitconfig'), `[http]\n\textraHeader = Authorization: Basic ${Buffer.from(`host-user:${HOST}`).toString('base64')}\n`);
    }],
    ['a global URL rewrite', async (f: Fixture) => {
      await git(f.base, ['init', '--quiet', '--bare', f.decoy]);
      await writeFile(join(f.home, '.gitconfig'), `[url "file://${f.decoy}"]\n\tinsteadOf = ${f.remote}\n`);
    }],
    ['a global hooks path', async (f: Fixture) => {
      await mkdir(join(f.base, 'global-hooks'));
      await writeFile(join(f.base, 'global-hooks', 'pre-push'), `#!/bin/sh\necho "$GH_CONFIG_DIR" >> ${JSON.stringify(f.hookLog)}\n`, { mode: 0o755 });
      await writeFile(join(f.home, '.gitconfig'), `[core]\n\thooksPath = ${join(f.base, 'global-hooks')}\n`);
    }],
    ['a repository pre-push hook', async (f: Fixture) => {
      await writeFile(join(f.workspace, '.git', 'hooks', 'pre-push'), `#!/bin/sh\necho "$GH_CONFIG_DIR" >> ${JSON.stringify(f.hookLog)}\n`, { mode: 0o755 });
    }],
  ])('host Git configuration cannot authenticate, redirect or observe the push: %s', async (_name, configure) => {
    const f = await fixture();
    await configure(f);
    expect(await f.run({ identity: true })).toMatchObject({ ok: true });
    expect(await f.pushed()).toBe(await f.head());
    expect(f.server.seen).toContain('managed');
    expect(f.server.seen).not.toContain('host');
    expect(await exists(f.hookLog)).toBe(false);
    expect((await git(f.base, ['--git-dir', f.decoy, 'for-each-ref'])).stdout).toBe('');
  }, 30_000);

  test('fails closed without asking a host askpass when gh cannot answer', async () => {
    const f = await fixture();
    await writeFile(join(f.bin, 'gh'), '#!/bin/sh\ncat >/dev/null\nexit 1\n', { mode: 0o700 });
    await writeFile(join(f.home, '.gitconfig'), `[core]\n\taskPass = ${join(f.bin, 'host-askpass')}\n`);
    const askpass = join(f.bin, 'host-askpass');
    const result = await f.run({ identity: true, env: { ...f.gatewayEnv, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass } });
    expect(result).toMatchObject({ ok: false, code: 'factory_command_failed' });
    expect(await f.hostCalls()).toEqual([]);
    expect(f.server.seen).not.toContain('host');
    expect(f.server.seen).not.toContain('managed');
    expect(await f.pushed()).toBe('');
  }, 30_000);

  test('negative control: without the identity the same push falls through to the host login and fails', async () => {
    const f = await fixture();
    // The host's global helper, as `gh auth setup-git` writes it.
    await writeFile(join(f.home, '.gitconfig'), `[credential "${f.remote}"]\n\thelper =\n\thelper = !gh auth git-credential\n`);
    const before = await f.run({ identity: false });
    expect(before).toMatchObject({ ok: false, code: 'factory_command_failed' });
    expect(f.server.seen).toContain('host');
    expect(f.server.seen).not.toContain('managed');
    expect(await f.pushed()).toBe('');
    expect(before.transcript).not.toContain(HOST);
    const after = await f.run({ identity: true });
    expect(after).toMatchObject({ ok: true });
    expect(await f.pushed()).toBe(await f.head());
  }, 30_000);

  test('negative control: without the inherited-helper reset a host helper answers first and the push fails', async () => {
    const f = await fixture();
    await writeFile(join(f.home, '.gitconfig'), `[credential]\n\thelper = !${join(f.bin, 'host-helper')}\n`);
    // The identity arguments minus the reset: what a regression in the factory would run.
    const child = Bun.spawn(['git', '-c', 'credential.helper=!gh auth git-credential', ...PUSH.slice(1)], {
      cwd: f.workspace, env: { ...f.gatewayEnv, GH_CONFIG_DIR: f.profileDir, GIT_TERMINAL_PROMPT: '0' }, stdout: 'pipe', stderr: 'pipe',
    });
    expect(await child.exited).not.toBe(0);
    expect(await f.hostCalls()).not.toEqual([]);
    expect(f.server.seen).toContain('host');
    expect(await f.pushed()).toBe('');
  }, 30_000);

  test('reads the profile at use time, so a Gateway token refresh applies to the next push', async () => {
    const f = await fixture();
    expect(await f.run({ identity: true })).toMatchObject({ ok: true });
    await writeFile(join(f.profileDir, 'hosts.yml'), hostsYaml(ROTATED), { mode: 0o600 });
    f.server.accepted = ROTATED;
    await git(f.workspace, ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'Second']);
    expect(await f.run({ identity: true })).toMatchObject({ ok: true });
    expect(await f.pushed()).toBe(await f.head());
  }, 30_000);

  test('a rejected push withholds remote output that echoes the credential', async () => {
    const f = await fixture();
    const marker = join(f.base, 'hook-ran');
    await writeFile(join(f.bare, 'hooks', 'pre-receive'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\necho "refused x-access-token:${MANAGED}" >&2\nexit 1\n`, { mode: 0o755 });
    const result = await f.run({ identity: true });
    expect(result).toMatchObject({ ok: false, code: 'factory_command_failed' });
    expect(result.message).toContain('System GitHub identity');
    expect(await Bun.file(marker).exists()).toBe(true);
    expect(result.transcript).not.toContain(MANAGED);
  }, 30_000);
});

describe('the System GitHub identity fails closed', () => {
  const withProfile = async (f: Fixture, change: (dir: string) => Promise<unknown>) => {
    const id = profileId();
    await change(await writeProfile(f.stateDir, id, hostsYaml(MANAGED)));
    return { profileId: id, stateDir: f.stateDir };
  };
  const cases: [string, (f: Fixture) => Promise<FactoryGitHubSelection | undefined>, string][] = [
    ['no selection', async () => undefined, 'factory_github_identity_missing'],
    ['tools.github unset', async (f) => ({ stateDir: f.stateDir }), 'factory_github_identity_missing'],
    ['empty profile id', async (f) => ({ profileId: '', stateDir: f.stateDir }), 'factory_github_identity_missing'],
    ['malformed profile id', async (f) => ({ profileId: f.id.slice(0, 12), stateDir: f.stateDir }), 'factory_github_identity_missing'],
    ['profile id escaping the system root', async (f) => ({ profileId: `../${f.id}`, stateDir: f.stateDir }), 'factory_github_identity_missing'],
    ['non-string profile id', async (f) => ({ profileId: 42, stateDir: f.stateDir }), 'factory_github_identity_missing'],
    ['no state directory', async (f) => ({ profileId: f.id }), 'factory_github_identity_missing'],
    ['relative state directory', async (f) => ({ profileId: f.id, stateDir: 'state' }), 'factory_github_identity_missing'],
    ['missing profile directory', async (f) => ({ profileId: profileId(), stateDir: f.stateDir }), 'factory_github_identity_unavailable'],
    ['symlinked profile directory', async (f) => {
      const id = profileId();
      await symlink(f.profileDir, join(f.stateDir, 'credentials', 'github', 'system', id));
      return { profileId: id, stateDir: f.stateDir };
    }, 'factory_github_identity_unavailable'],
    ['symlinked hosts.yml', async (f) => {
      const id = profileId();
      const dir = join(f.stateDir, 'credentials', 'github', 'system', id);
      await mkdir(dir, { mode: 0o700 });
      await symlink(join(f.profileDir, 'hosts.yml'), join(dir, 'hosts.yml'));
      return { profileId: id, stateDir: f.stateDir };
    }, 'factory_github_identity_unavailable'],
    ['missing hosts.yml', async (f) => {
      const id = profileId();
      await mkdir(join(f.stateDir, 'credentials', 'github', 'system', id), { mode: 0o700 });
      return { profileId: id, stateDir: f.stateDir };
    }, 'factory_github_identity_unavailable'],
    ['tokenless profile', async (f) => {
      const id = profileId();
      await writeProfile(f.stateDir, id, 'github.com:\n    user: example-user\n    git_protocol: https\n');
      return { profileId: id, stateDir: f.stateDir };
    }, 'factory_github_identity_unavailable'],
    ['empty token', async (f) => {
      const id = profileId();
      await writeProfile(f.stateDir, id, 'github.com:\n    user: example-user\n    oauth_token: ""\n');
      return { profileId: id, stateDir: f.stateDir };
    }, 'factory_github_identity_unavailable'],
    ['unparseable hosts.yml', async (f) => {
      const id = profileId();
      await writeProfile(f.stateDir, id, `github.com:\n    oauth_token: ${MANAGED}\n  broken: [\n`);
      return { profileId: id, stateDir: f.stateDir };
    }, 'factory_github_identity_unavailable'],
    ['group-readable profile directory', async (f) => { await chmod(f.profileDir, 0o750); return f.selection; }, 'factory_github_identity_unavailable'],
    ['world-readable hosts.yml', async (f) => { await chmod(join(f.profileDir, 'hosts.yml'), 0o644); return f.selection; }, 'factory_github_identity_unavailable'],
    ['hosts.yml that is a FIFO', (f) => withProfile(f, async (dir) => {
      await rm(join(dir, 'hosts.yml'));
      expect(Bun.spawnSync(['mkfifo', '-m', '600', join(dir, 'hosts.yml')]).exitCode).toBe(0);
    }), 'factory_github_identity_unavailable'],
    ['world-readable config.yml', (f) => withProfile(f, (dir) => writeFile(join(dir, 'config.yml'), 'git_protocol: https\n', { mode: 0o644 })), 'factory_github_identity_unavailable'],
    ['symlinked config.yml', (f) => withProfile(f, async (dir) => {
      await writeFile(join(f.base, 'config.yml'), 'git_protocol: https\n', { mode: 0o600 });
      await symlink(join(f.base, 'config.yml'), join(dir, 'config.yml'));
    }), 'factory_github_identity_unavailable'],
    ['unparseable config.yml', (f) => withProfile(f, (dir) => writeFile(join(dir, 'config.yml'), 'aliases:\n  co: [\n', { mode: 0o600 })), 'factory_github_identity_unavailable'],
  ];

  test.each(cases)('%s refuses before Git starts and never uses the host login', async (_name, select, code) => {
    const f = await fixture();
    const selection = await select(f);
    const original = Bun.spawn;
    let spawned = 0;
    Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => { spawned++; return original(...args); }) as typeof Bun.spawn;
    let error: unknown;
    try { await factoryCommand(selection)(PUSH, f.workspace, { githubIdentity: true }); }
    catch (caught) { error = caught; }
    finally { Bun.spawn = original; }
    expect(error).toMatchObject({ code });
    expect(spawned).toBe(0);
    expect(f.server.seen).toEqual([]);
    for (const secret of [MANAGED, HOST, f.id, f.stateDir]) expect(String(error)).not.toContain(secret);
  });

  test('a GitHub identity applies only to Git commands', async () => {
    const f = await fixture();
    await expect(factoryCommand(f.selection)(['/fixture/openclaw', 'config', 'validate'], undefined, { githubIdentity: true }))
      .rejects.toMatchObject({ code: 'factory_invalid_command' });
  });
});
