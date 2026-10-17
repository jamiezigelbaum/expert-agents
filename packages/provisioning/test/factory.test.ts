import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FACTORY_PHASES, FactoryError, runFactory, type FactoryCommandOptions, type FactoryDependencies } from '../src/factory.ts';
import type { FactoryConfig, FactoryRequest } from '../src/factory-types.ts';
import { probeManagedBotProvision } from '../../../scripts/expert-telegram-provision.ts';

const roots: string[] = [];
const TOKEN = `123456789:AA${'synthetic_only_fixture_'.repeat(2)}`;
const PURPOSE = 'Private owner purpose that must never appear in tool receipts';
const request: FactoryRequest = {
  action: 'create', agent_id: 'example', display_name: 'Example', purpose: PURPOSE,
  telegram_username: 'ExampleFactoryTestBot', apply: true,
};
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'expert-factory-test-')));
  roots.push(base);
  const config: FactoryConfig = {
    enabled: true, rootDir: join(base, 'factory'), tokenDirectory: join(base, 'tokens'),
    managerTokenFile: join(base, 'manager.token'), ownerTelegramUserId: 12345,
    libraryBucket: 'factory-test-library', libraryPrefix: 'experts', openclawBin: '/fixture/openclaw',
  };
  await mkdir(config.rootDir, { mode: 0o700 });
  await mkdir(config.tokenDirectory, { mode: 0o700 });
  await writeFile(config.managerTokenFile, TOKEN, { mode: 0o600 });
  // Deployment-owned programs must exist and be executable before anything is created.
  const bin = join(base, 'bin');
  await mkdir(bin);
  const programs = { activate: join(bin, 'activate'), createRemote: join(bin, 'create-remote') };
  for (const program of Object.values(programs)) await writeFile(program, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const calls: { argv: string[]; cwd?: string; options?: FactoryCommandOptions }[] = [];
  const workers: { tool: string; params: Record<string, unknown> }[] = [];
  const state = {
    agents: [] as Record<string, unknown>[], accounts: {} as Record<string, unknown>,
    bindings: [] as Record<string, unknown>[], corpusReady: true, confirmed: false,
    running: true, probeOk: true, observedBotId: 987654321, ownerSeen: 0,
    beginCount: 0, provisionCount: 0, probeCount: 0, validationFails: false,
    channelError: false, registrationStatus: 'registered',
    remoteCreateCalls: [] as string[][], remoteCreateFails: false,
    reloadMode: undefined as unknown, githubAuth: 'valid' as 'valid' | 'invalid',
    latestUpdateId: 0, confirmedUsername: 'ExampleFactoryTestBot',
    renamedCandidates: [] as { botId: number; username: string; updateId: number }[],
    probeInputs: [] as Record<string, unknown>[],
    // The worker's domain workspace: seeded by bootstrap, reported by status.
    seeded: false, bootstrapCount: 0, googleStatus: 'ready' as unknown,
    roots: [{ root_id: 'expert_agents_workspace', max_write_bytes: 1_000_000, allow_overwrite: false }] as Record<string, unknown>[],
  };
  const dependencies: FactoryDependencies = {
    command: async (argv, cwd, options) => {
      calls.push({ argv: [...argv], cwd, ...(options ? { options } : {}) });
      if (argv[0] === 'git') {
        // HTTPS remotes resolve to local bare repositories under base/https/<host>/.
        const local = ['github.com', 'git.example.com'].flatMap((host) => ['-c', `url.file://${join(base, 'https', host)}/.insteadOf=https://${host}/`]);
        const child = Bun.spawn(['git', ...local, ...argv.slice(1)], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        // Categorized like the packaged adapter; a missing local remote stands in for GitHub's 404.
        if (code !== 0) throw new FactoryError('factory_command_failed', `Fixture git failed: ${stderr}`, { category: /does not appear to be a git repository/.test(stderr) ? 'not_found' : 'failed' });
        return stdout;
      }
      if (argv.join(' ') === 'gh auth status --active --hostname github.com') {
        if (state.githubAuth === 'invalid') throw new FactoryError('factory_command_failed', 'Fixture identity refused', { category: 'auth' });
        return '';
      }
      if (argv[0] === config.activationCommand) return '';
      if (argv[0] === config.remoteCreateCommand) {
        state.remoteCreateCalls.push(argv.slice(1));
        if (state.remoteCreateFails) throw new Error('Fixture remote creation failed');
        const url = new URL(argv[2]!);
        const bare = url.protocol === 'file:' ? url.pathname : join(base, 'https', url.hostname, url.pathname);
        await mkdir(bare, { recursive: true });
        const child = Bun.spawn(['git', 'init', '--bare', '--quiet', bare], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
        if (await child.exited !== 0) throw new Error('Fixture bare init failed');
        return '';
      }
      const args = argv.slice(1);
      if (args[0] === 'agents' && args[1] === 'list') return JSON.stringify(state.agents);
      if (args[0] === 'agents' && args[1] === 'bindings') return JSON.stringify(state.bindings);
      if (args[0] === 'config' && args[1] === 'get') return JSON.stringify({ accounts: state.accounts });
      if (args[0] === 'config' && args[1] === 'validate') {
        if (state.validationFails) throw new Error('Fixture configuration invalid');
        return '{}';
      }
      if (args[0] === 'agents' && args[1] === 'add') {
        throw new Error('Plugin startup failed: domain_expert_unresolved_secret_ref');
      }
      if (args[0] === 'gateway' && args[1] === 'call') {
        const params = JSON.parse(args[args.indexOf('--params') + 1]!);
        if (args[2] === 'agents.create') {
          state.agents.push({ id: params.name, workspace: params.workspace, name: params.name, model: params.model });
          return JSON.stringify({ ok: true, agentId: params.name, workspace: params.workspace, model: params.model });
        }
        if (args[2] === 'agents.update') {
          const agent = state.agents.find((agent) => agent.id === params.agentId);
          if (!agent) throw new Error('Fixture agent not found');
          agent.name = params.name;
          return JSON.stringify({ ok: true, agentId: params.agentId });
        }
      }
      if (args[0] === 'config' && args[1] === 'set') {
        if (!args.includes('--dry-run')) state.accounts.example = JSON.parse(args[3]!);
        return '{}';
      }
      if (args[0] === 'agents' && args[1] === 'bind') {
        state.bindings.push({ agentId: 'example', match: { channel: 'telegram', accountId: 'example' } });
        return '{}';
      }
      if (args[0] === 'doctor') return '{}';
      if (args[0] === 'channels' && args[1] === 'status') {
        if (state.channelError) throw new Error('Unavailable probe');
        return JSON.stringify({ channelAccounts: { telegram: [{ accountId: 'example', running: state.running,
          probe: { ok: state.probeOk, bot: { id: state.observedBotId } } }] } });
      }
      throw new Error(`Unexpected fixture command: ${argv.join(' ')}`);
    },
    gatewayReloadMode: async () => state.reloadMode,
    worker: async (tool, params) => {
      workers.push({ tool, params });
      if (tool === 'rag_corpus') return { status: state.corpusReady ? 'ready' : 'pending' };
      if (params.action === 'status') {
        return { kind: 'domain_agent_status', health: state.seeded ? 'healthy' : 'degraded',
          workspace: { exists: state.seeded, missing_requirements: state.seeded ? [] : [{ relative_path: 'example/PROPOSAL.md', kind: 'proposal' }] } };
      }
      if (params.action === 'bootstrap') { state.bootstrapCount++; state.seeded = true; return { status: 'workspace_bootstrapped' }; }
      return params.dry_run ? { status: 'dry_run_registration_ready', manifest: { domain_id: params.domain_id, workspace_root_id: 'expert_agents_workspace' } }
        : { status: state.registrationStatus };
    },
    workerHealth: async () => ({ kind: 'domain_expert_health', configured: { workspace_roots: state.roots.length },
      configuration_status: { google: state.googleStatus }, roots: state.roots }),
    beginTelegram: async ({ username }) => {
      state.beginCount++;
      return { managerUsername: 'FactoryManagerBot', requestedUsername: username, deepLink: 'https://t.me/FactoryManagerBot?start=fixture' };
    },
    probeTelegram: async (input) => {
      state.ownerSeen = input.ownerUserId;
      state.probeCount++;
      state.probeInputs.push({ ...input });
      const candidates = input.sinceUpdateId === undefined ? {}
        : { candidates: state.renamedCandidates.filter((candidate) => candidate.updateId > input.sinceUpdateId!) };
      return state.confirmed
        ? { status: 'confirmed', botId: 987654321, actualUsername: 'ExampleFactoryTestBot', latestUpdateId: state.latestUpdateId, ...candidates }
        : { status: 'pending', latestUpdateId: state.latestUpdateId, ...candidates };
    },
    provisionTelegram: async (args) => {
      state.provisionCount++;
      const tokenFilePath = args[args.indexOf('--token-file') + 1]!;
      await writeFile(tokenFilePath, TOKEN, { mode: 0o600 });
      return { mode: 'provision', requestedUsername: 'ExampleFactoryTestBot', actualUsername: state.confirmedUsername,
        botId: 987654321, tokenFilePath, tokenFingerprint: 'fixture-fingerprint', avatarSet: false, resolvedFrom: 'user-id' };
    },
  };
  const wireRemote = () => {
    config.remoteUrlTemplate = `file://${join(base, 'remotes')}/{agentId}.git`;
    config.remoteCreateCommand = programs.createRemote;
  };
  const run = (next: FactoryRequest = request) => runFactory(config, next, dependencies);
  const resume = () => run({ action: 'resume', agent_id: 'example', apply: true });
  return { base, config, state, calls, workers, dependencies, programs, run, resume, wireRemote, workspace: join(config.rootDir, 'agents', 'example') };
}

describe('conversational expert factory', () => {
  test('plan and missing status perform no writes or external calls', async () => {
    const f = await fixture();
    expect((await f.run({ ...request, apply: false })).status).toBe('planned');
    expect((await f.run({ action: 'status', agent_id: 'example' })).status).toBe('not_found');
    expect(await readdir(f.config.rootDir)).toEqual([]);
    expect(await readdir(f.config.tokenDirectory)).toEqual([]);
    expect(f.calls).toHaveLength(0);
    expect(f.workers).toHaveLength(0);
    expect(f.state.beginCount).toBe(0);
  });

  test('creates a committed independent repository, waits for owner, resumes ready without duplicate resources', async () => {
    const f = await fixture();
    const first = await f.run();
    expect(first.status).toBe('waiting_for_telegram');
    expect(first.commit).toMatch(/^[a-f0-9]{40,64}$/);
    expect(first.confirmation_url).toContain('https://t.me/');
    expect(f.state.ownerSeen).toBe(f.config.ownerTelegramUserId);
    expect(f.state.provisionCount).toBe(0);
    const tracked = await f.dependencies.command(['git', 'ls-files'], f.workspace);
    expect(tracked).toContain('SOUL.md');
    expect(tracked).not.toContain('.token');
    expect(await f.dependencies.command(['git', 'status', '--porcelain'], f.workspace)).toBe('');
    expect(await readFile(join(f.workspace, 'SOUL.md'), 'utf8')).toContain(PURPOSE);
    expect(await readFile(join(f.workspace, 'TOOLS.md'), 'utf8')).toContain('domain_id: "example"');
    expect(f.workers[0]?.params.dry_run).toBe(true);
    expect(f.workers.find((call) => call.params.dry_run === false)?.params.library).toEqual({ bucket: 'factory-test-library', prefix: 'experts/example' });
    f.state.confirmed = true;
    const ready = await f.resume();
    expect(ready.status).toBe('ready_empty_library');
    expect(ready.telegram_url).toBe('https://t.me/ExampleFactoryTestBot');
    expect(ready.confirmation_url).toBeUndefined();
    expect(JSON.stringify([first, ready])).not.toContain(PURPOSE);
    expect(JSON.stringify([first, ready])).not.toContain(TOKEN);
    expect(f.state.accounts.example).toEqual({ enabled: true, tokenFile: join(f.config.tokenDirectory, 'example.token'), dmPolicy: 'allowlist', allowFrom: ['12345'], groupPolicy: 'disabled' });
    const callsBefore = f.calls.length;
    expect((await f.resume()).status).toBe('ready_empty_library');
    expect(f.calls.slice(callsBefore).every((call) => call.argv[1] === 'channels'
      || (call.argv[1] === 'agents' && ['list', 'bindings'].includes(call.argv[2]!))
      || (call.argv[1] === 'config' && call.argv[2] === 'get'))).toBe(true);
    expect(f.state.beginCount).toBe(1);
    expect(f.state.provisionCount).toBe(1);
    expect(f.workers.filter((call) => call.tool === 'rag_corpus')).toHaveLength(3);
    expect(f.workers.filter((call) => call.params.action === 'register' && call.params.dry_run === false)).toHaveLength(1);
    expect(f.state.bootstrapCount).toBe(1);
    expect((await stat(join(f.config.rootDir, 'operations', 'example', 'state.json'))).mode & 0o077).toBe(0);
  }, 60_000);

  test('Gateway creation survives CLI plugin startup failure and preserves model, id and display name', async () => {
    const f = await fixture(); f.config.model = 'openai/gpt-5.6-sol';
    await expect(f.dependencies.command([f.config.openclawBin, 'agents', 'add', 'example'])).rejects.toThrow('domain_expert_unresolved_secret_ref');
    f.calls.length = 0;
    await f.run(); f.state.confirmed = true;
    expect((await f.resume()).status).toBe('ready_empty_library');
    const rpcCalls = f.calls.filter((call) => call.argv[1] === 'gateway');
    expect(rpcCalls.map((call) => call.argv)).toEqual([
      [f.config.openclawBin, 'gateway', 'call', 'agents.create', '--params', JSON.stringify({
        name: 'example', workspace: f.workspace, model: f.config.model,
      }), '--json'],
      [f.config.openclawBin, 'gateway', 'call', 'agents.update', '--params', JSON.stringify({
        agentId: 'example', name: 'Example',
      }), '--json'],
    ]);
    expect(f.state.agents).toEqual([{ id: 'example', workspace: f.workspace, name: 'Example', model: f.config.model }]);
    expect(f.calls.some((call) => call.argv[1] === 'agents' && call.argv[2] === 'add')).toBe(false);
    expect(await readFile(join(f.workspace, 'SOUL.md'), 'utf8')).toContain(PURPOSE);
  }, 60_000);

  test.each([
    ['agents.create', 'not-json'],
    ['agents.create', JSON.stringify({ ok: false, agentId: 'example', workspace: '<workspace>' })],
    ['agents.create', JSON.stringify({ agentId: 'example', workspace: '<workspace>' })],
    ['agents.create', JSON.stringify({ ok: true, agentId: 'other', workspace: '<workspace>' })],
    ['agents.create', JSON.stringify({ ok: true, agentId: 'example', workspace: '/other' })],
    ['agents.create', JSON.stringify({ ok: true, agentId: 'example' })],
    ['agents.update', 'not-json'],
    ['agents.update', JSON.stringify({ ok: false, agentId: 'example' })],
    ['agents.update', JSON.stringify({ agentId: 'example' })],
    ['agents.update', JSON.stringify({ ok: true, agentId: 'other' })],
  ])('refuses an unconfirmed %s response %s before account setup', async (method, output) => {
    const f = await fixture(); await f.run(); f.state.confirmed = true;
    const command = f.dependencies.command;
    f.dependencies.command = async (argv, cwd) => {
      if (argv[1] === 'gateway' && argv[3] === method) return output!.replace('<workspace>', f.workspace);
      return command(argv, cwd);
    };
    await expect(f.resume()).rejects.toMatchObject({ code: 'factory_gateway_contract' });
    expect(f.state.accounts).toEqual({});
    expect(f.state.bindings).toEqual([]);
    const state = JSON.parse(await readFile(join(f.config.rootDir, 'operations', 'example', 'state.json'), 'utf8'));
    expect(state.gatewayConfigured).not.toBe(true);
    expect(await Bun.file(join(f.config.rootDir, 'factory.lock')).exists()).toBe(false);
  }, 60_000);

  test.each(['agents.create', 'agents.update'])('retries a failed %s without duplicating agent creation or Telegram provisioning', async (method) => {
    const f = await fixture(); await f.run(); f.state.confirmed = true;
    const command = f.dependencies.command;
    f.dependencies.command = async (argv, cwd) => {
      if (argv[1] === 'gateway' && argv[3] === method) throw new Error('Fixture Gateway unavailable');
      return command(argv, cwd);
    };
    await expect(f.resume()).rejects.toMatchObject({ code: 'factory_command_failed', details: { phase: 'configuring_gateway', step: method, category: 'failed' } });
    expect(f.state.agents).toHaveLength(method === 'agents.update' ? 1 : 0);
    expect(f.state.accounts).toEqual({});
    expect(f.state.bindings).toEqual([]);
    f.dependencies.command = command;
    expect((await f.resume()).status).toBe('ready_empty_library');
    expect(f.calls.filter((call) => call.argv[1] === 'gateway' && call.argv[3] === 'agents.create')).toHaveLength(1);
    expect(f.state.agents).toEqual([{ id: 'example', workspace: f.workspace, name: 'Example', model: undefined }]);
    expect(f.state.provisionCount).toBe(1);
    expect(f.state.beginCount).toBe(1);
  }, 60_000);

  test('installs the agent route before Telegram polling can start and preserves it on retry', async () => {
    const f = await fixture(); await f.run(); f.state.confirmed = true;
    const command = f.dependencies.command;
    let failEnable = true;
    f.dependencies.command = async (argv, cwd) => {
      if (argv[1] === 'config' && argv[2] === 'set' && !argv.includes('--dry-run')) {
        expect(f.state.bindings).toEqual([{ agentId: 'example', match: { channel: 'telegram', accountId: 'example' } }]);
        if (failEnable) throw new Error('Fixture account enable unavailable');
      }
      return command(argv, cwd);
    };
    await expect(f.resume()).rejects.toMatchObject({ code: 'factory_command_failed', details: { phase: 'configuring_gateway', step: 'openclaw config set' } });
    expect(f.state.accounts).toEqual({});
    failEnable = false;
    expect((await f.resume()).status).toBe('ready_empty_library');
    expect(f.calls.filter((call) => call.argv[1] === 'agents' && call.argv[2] === 'bind')).toHaveLength(1);
  }, 60_000);

  test('recovers a lost response after Gateway agent creation without creating another agent', async () => {
    const f = await fixture(); await f.run(); f.state.confirmed = true;
    const command = f.dependencies.command;
    f.dependencies.command = async (argv, cwd) => {
      const output = await command(argv, cwd);
      if (argv[1] === 'gateway' && argv[3] === 'agents.create') throw new Error('Fixture response lost after creation');
      return output;
    };
    await expect(f.resume()).rejects.toMatchObject({ code: 'factory_command_failed', details: { phase: 'configuring_gateway', step: 'agents.create' } });
    expect(f.state.agents).toHaveLength(1);
    expect(f.state.accounts).toEqual({});
    f.dependencies.command = command;
    expect((await f.resume()).status).toBe('ready_empty_library');
    expect(f.calls.filter((call) => call.argv[1] === 'gateway' && call.argv[3] === 'agents.create')).toHaveLength(1);
    expect(f.state.agents[0]?.name).toBe('Example');
    expect(f.state.provisionCount).toBe(1);
  }, 60_000);

  test('pending corpus resumes ensure with the same approval and never installs Telegram early', async () => {
    const f = await fixture(); f.state.corpusReady = false;
    const pending = await f.run();
    expect(pending.status).toBe('waiting_for_corpus');
    expect(pending.confirmation_url).toBeDefined();
    expect(f.state.provisionCount).toBe(0);
    expect(f.state.probeCount).toBe(1);
    f.state.corpusReady = true;
    expect((await f.resume()).status).toBe('waiting_for_telegram');
    const ensures = f.workers.filter((call) => call.tool === 'rag_corpus');
    expect(ensures).toHaveLength(2);
    expect(ensures[0]!.params).toEqual(ensures[1]!.params);
    expect(f.state.beginCount).toBe(1);
  }, 60_000);

  test.each(['../escape', '/tmp/escape', 'main', 'default', 'Example', 'a.b', 'a'])('rejects unsafe agent id %s before effects', async (agent_id) => {
    const f = await fixture();
    await expect(f.run({ ...request, agent_id })).rejects.toMatchObject({ code: 'factory_invalid_request' });
    expect(await readdir(f.config.rootDir)).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  test.each(['workspace', 'token_file', 'owner_user_id', 'command'])('rejects caller supplied %s', async (key) => {
    const f = await fixture();
    await expect(f.run({ ...request, [key]: '/tmp/arbitrary' } as FactoryRequest)).rejects.toMatchObject({ code: 'factory_invalid_request' });
    expect(f.calls).toHaveLength(0);
  });

  test('refuses a preexisting arbitrary workspace without changing its content', async () => {
    const f = await fixture(); await mkdir(f.workspace, { recursive: true });
    await writeFile(join(f.workspace, 'owner.txt'), 'preserve');
    await expect(f.run()).rejects.toMatchObject({ code: 'factory_target_exists' });
    expect(await readFile(join(f.workspace, 'owner.txt'), 'utf8')).toBe('preserve');
    expect(f.workers).toHaveLength(0);
  });

  test('refuses symlink traversal and public factory roots', async () => {
    const f = await fixture();
    await symlink(f.config.tokenDirectory, join(f.config.rootDir, 'agents'));
    await expect(f.run()).rejects.toMatchObject({ code: 'factory_symlink' });
    await rm(join(f.config.rootDir, 'agents'));
    await chmod(f.config.rootDir, 0o755);
    await expect(f.run()).rejects.toMatchObject({ code: 'factory_invalid_config' });
  });

  test.each(['agent', 'account', 'binding'])('refuses existing gateway %s collision before provisioning', async (kind) => {
    const f = await fixture();
    if (kind === 'agent') f.state.agents.push({ id: 'example', workspace: '/another-owner' });
    if (kind === 'account') f.state.accounts.example = { tokenFile: '/another-token' };
    if (kind === 'binding') f.state.bindings.push({ agentId: 'other', match: { channel: 'telegram', accountId: 'example' } });
    await expect(f.run()).rejects.toMatchObject({ code: `factory_${kind}_collision` });
    expect(f.state.beginCount).toBe(0);
    expect(f.workers).toHaveLength(0);
  });

  test('refuses mismatched retry purpose and deployment owner', async () => {
    const f = await fixture(); await f.run();
    await expect(f.run({ ...request, purpose: 'Another purpose' })).rejects.toMatchObject({ code: 'factory_spec_conflict' });
    f.config.ownerTelegramUserId++;
    await expect(f.resume()).rejects.toMatchObject({ code: 'factory_state_conflict' });
    expect(f.state.beginCount).toBe(1);
  }, 60_000);

  test('refuses an account policy changed while waiting for Telegram', async () => {
    const f = await fixture(); await f.run(); f.state.confirmed = true;
    f.state.accounts.example = { enabled: true, tokenFile: join(f.config.tokenDirectory, 'example.token'), dmPolicy: 'open', allowFrom: ['*'], groupPolicy: 'open' };
    await expect(f.resume()).rejects.toMatchObject({ code: 'factory_account_policy_conflict' });
    expect(f.state.accounts.example).toMatchObject({ dmPolicy: 'open' });
    expect(f.calls.some((call) => call.argv[1] === 'agents' && call.argv[2] === 'bind')).toBe(false);
  }, 60_000);

  test('wrong-owner Telegram update cannot authorize token installation', async () => {
    const f = await fixture();
    f.dependencies.probeTelegram = (input, deps) => probeManagedBotProvision(input, { ...deps,
      fetchImpl: async (url) => Response.json({ ok: true, result: url.endsWith('/getWebhookInfo') ? { url: '' }
        : [{ update_id: 1, managed_bot: { user: { id: 54321 }, bot: { id: 987654321, is_bot: true, username: 'ExampleFactoryTestBot' } } }] }),
    });
    expect((await f.run()).status).toBe('waiting_for_telegram');
    expect(f.state.provisionCount).toBe(0);
    expect(await readdir(f.config.tokenDirectory)).toEqual([]);
  }, 60_000);

  test('unavailable Telegram probe remains resumable without another bot creation', async () => {
    const f = await fixture(); await f.run();
    const probe = f.dependencies.probeTelegram!;
    f.dependencies.probeTelegram = async () => { throw new Error('Fixture Telegram unavailable'); };
    await expect(f.resume()).rejects.toThrow();
    expect((await f.run({ action: 'status', agent_id: 'example' })).status).toBe('waiting_for_telegram');
    f.dependencies.probeTelegram = probe; f.state.confirmed = true;
    expect((await f.resume()).status).toBe('ready_empty_library');
    expect(f.state.beginCount).toBe(1);
  }, 60_000);

  test('failed registration does not create a corpus or configure an agent', async () => {
    const f = await fixture(); f.state.registrationStatus = 'error';
    await expect(f.run()).rejects.toMatchObject({ code: 'factory_registration_incomplete' });
    expect(f.workers.some((call) => call.tool === 'rag_corpus')).toBe(false);
    expect(f.state.agents).toEqual([]);
    f.state.registrationStatus = 'registered';
    expect((await f.resume()).status).toBe('waiting_for_telegram');
    expect(f.state.beginCount).toBe(1);
  }, 60_000);

  test('preexisting token is never adopted or overwritten', async () => {
    const f = await fixture();
    await writeFile(join(f.config.tokenDirectory, 'example.token'), 'existing-owner-token', { mode: 0o600 });
    await expect(f.run()).rejects.toMatchObject({ code: 'factory_target_exists' });
    expect(await readFile(join(f.config.tokenDirectory, 'example.token'), 'utf8')).toBe('existing-owner-token');
    expect(f.state.beginCount).toBe(0);
  });

  test('failed configuration validation leaves no local agent or remote resource', async () => {
    const f = await fixture(); f.state.validationFails = true;
    await expect(f.run()).rejects.toThrow();
    expect(f.workers).toHaveLength(0);
    expect(f.state.beginCount).toBe(0);
    expect(await Bun.file(join(f.workspace, 'agent.json')).exists()).toBe(false);
    expect(await Bun.file(join(f.config.rootDir, 'factory.lock')).exists()).toBe(false);
  });

  test.each(['error', 'registered', 'planned', undefined])('rejects unsuccessful dry-run status %s before creating resources', async (status) => {
    const f = await fixture();
    f.dependencies.worker = async () => ({ status });
    await expect(f.run()).rejects.toMatchObject({ code: 'factory_registration_preflight_failed' });
    expect(f.state.beginCount).toBe(0);
    expect(await Bun.file(join(f.workspace, 'agent.json')).exists()).toBe(false);
    expect(await readdir(f.config.tokenDirectory)).toEqual([]);
  });

  test.each(['rootDir', 'tokenDirectory', 'managerTokenFile'])('refuses %s under an ancestor Git checkout', async (key) => {
    const f = await fixture();
    const repo = join(f.base, 'existing-repository'); await mkdir(repo);
    await f.dependencies.command(['git', 'init'], repo);
    const nested = join(repo, 'private', 'nested'); await mkdir(nested, { recursive: true, mode: 0o700 });
    if (key === 'managerTokenFile') {
      f.config.managerTokenFile = join(nested, 'manager.token');
      await writeFile(f.config.managerTokenFile, TOKEN, { mode: 0o600 });
    } else f.config[key as 'rootDir' | 'tokenDirectory'] = nested;
    await expect(f.run()).rejects.toMatchObject({ code: 'factory_invalid_config' });
    expect(f.state.beginCount).toBe(0);
    expect(f.workers).toHaveLength(0);
  }, 60_000);

  test('a linked-worktree .git file also excludes factory-owned directories', async () => {
    const f = await fixture();
    await writeFile(join(f.base, '.git'), 'gitdir: /fixture/linked-worktree');
    await expect(f.run()).rejects.toMatchObject({ code: 'factory_invalid_config' });
    expect(f.workers).toHaveLength(0);
  });

  test.each(['public', 'symlink', 'directory', 'missing'])('refuses a %s manager credential', async (kind) => {
    const f = await fixture();
    if (kind === 'public') await chmod(f.config.managerTokenFile, 0o644);
    if (kind === 'symlink') {
      const link = join(f.base, 'credential-link'); await symlink(f.config.managerTokenFile, link);
      f.config.managerTokenFile = link;
    }
    if (kind === 'directory') f.config.managerTokenFile = f.config.tokenDirectory;
    if (kind === 'missing') f.config.managerTokenFile = join(f.base, 'missing.token');
    await expect(f.run()).rejects.toMatchObject({ code: 'factory_invalid_config' });
    expect(f.calls).toHaveLength(0);
    expect(f.workers).toHaveLength(0);
  });

  test.each([
    ['libraryPrefix', undefined], ['libraryPrefix', {}], ['libraryPrefix', 'x'.repeat(513)],
    ['libraryBucket', undefined], ['ownerTelegramUserId', '12345'], ['enabled', 'true'],
    ['activationCommand', ''], ['activationCommand', 42], ['openclawBin', undefined],
    ['model', {}], ['model', 'x'.repeat(201)], ['model', 'model\n--argument'], ['model', TOKEN],
    ['remoteUrlTemplate', 42], ['remoteUrlTemplate', 'https://example.com/experts.git'], ['remoteUrlTemplate', 'https://example.com/{agentId}/{agentId}.git'],
    ['remoteUrlTemplate', 'https://token@example.com/{agentId}.git'], ['remoteUrlTemplate', 'http://example.com/{agentId}.git'],
    ['remoteUrlTemplate', '--upload-pack=x https://example.com/{agentId}.git'], ['remoteUrlTemplate', `https://example.com/{agentId}.git?${TOKEN}`],
    ['remoteCreateCommand', '/fixture/create-remote'], ['remoteCreateCommand', 'relative/create-remote'],
  ])('returns a typed config refusal for malformed %s', async (key, value) => {
    const f = await fixture();
    (f.config as unknown as Record<string, unknown>)[key as string] = value;
    await expect(f.run()).rejects.toMatchObject({ code: 'factory_invalid_config' });
    expect(f.calls).toHaveLength(0);
  });

  test.each([undefined, null, 1234, { toString: () => 'example' }])('rejects non-string agent id before path construction', async (agent_id) => {
    const f = await fixture();
    await expect(f.run({ ...request, agent_id } as unknown as FactoryRequest)).rejects.toMatchObject({ code: 'factory_invalid_request' });
  });

  test('fresh polling failure downgrades previously ready state durably', async () => {
    const f = await fixture(); await f.run(); f.state.confirmed = true;
    expect((await f.resume()).status).toBe('ready_empty_library');
    f.state.running = false;
    expect((await f.resume()).status).toBe('waiting_for_activation');
    expect((await f.run({ action: 'status', agent_id: 'example' })).status).toBe('waiting_for_activation');
    f.state.running = true;
    expect((await f.resume()).status).toBe('ready_empty_library');
  }, 60_000);

  test.each(['agent', 'account', 'binding', 'rerouted', 'workspace', 'policy'])('fresh readiness rejects %s gateway drift despite healthy polling', async (kind) => {
    const f = await fixture(); await f.run(); f.state.confirmed = true;
    expect((await f.resume()).status).toBe('ready_empty_library');
    const callsBefore = f.calls.length;
    if (kind === 'agent') f.state.agents = [];
    if (kind === 'account') delete f.state.accounts.example;
    if (kind === 'binding') f.state.bindings = [];
    if (kind === 'rerouted') f.state.bindings[0]!.agentId = 'another-agent';
    if (kind === 'workspace') f.state.agents[0]!.workspace = '/another-workspace';
    if (kind === 'policy') (f.state.accounts.example as Record<string, unknown>).dmPolicy = 'open';
    await expect(f.resume()).rejects.toMatchObject({ code: kind === 'rerouted' ? 'factory_binding_collision'
      : kind === 'workspace' ? 'factory_agent_collision' : kind === 'policy' ? 'factory_account_policy_conflict' : 'factory_gateway_drift' });
    expect((await f.run({ action: 'status', agent_id: 'example' })).status).toBe('waiting_for_activation');
    expect(f.calls.slice(callsBefore).some((call) => call.argv[1] === 'channels')).toBe(false);
    expect(f.state.provisionCount).toBe(1);
  }, 60_000);

  test.each(['running', 'probe', 'identity', 'unavailable'])('does not claim readiness when %s proof fails', async (kind) => {
    const f = await fixture(); await f.run(); f.state.confirmed = true;
    if (kind === 'running') f.state.running = false;
    if (kind === 'probe') f.state.probeOk = false;
    if (kind === 'identity') f.state.observedBotId = 42;
    if (kind === 'unavailable') f.state.channelError = true;
    expect((await f.resume()).status).toBe('waiting_for_activation');
    f.state.running = true; f.state.probeOk = true; f.state.observedBotId = 987654321; f.state.channelError = false;
    expect((await f.resume()).status).toBe('ready_empty_library');
    expect(f.state.provisionCount).toBe(1);
  }, 60_000);

  test('activation wrapper is attempted once, with no caller arguments', async () => {
    const f = await fixture(); f.state.running = false;
    f.config.activationCommand = f.programs.activate;
    await f.run(); f.state.confirmed = true;
    expect((await f.resume()).status).toBe('waiting_for_activation');
    expect((await f.resume()).status).toBe('waiting_for_activation');
    expect(f.calls.filter((call) => call.argv[0] === f.programs.activate)).toEqual([{ argv: [f.programs.activate], cwd: undefined }]);
  }, 60_000);

  test.each([
    { configured: false }, { connected: false }, { restartPending: true },
    { healthState: 'starting' }, { healthState: 'disconnected' }, { healthState: 'stale-socket' },
    { healthState: 'stuck' }, { healthState: 'not-running' },
  ])('rejects explicit unhealthy channel state %j despite successful getMe', async (extra) => {
    const f = await fixture(); await f.run(); f.state.confirmed = true;
    const command = f.dependencies.command;
    f.dependencies.command = async (argv, cwd) => {
      const output = await command(argv, cwd);
      if (argv[1] !== 'channels') return output;
      const status = JSON.parse(output); Object.assign(status.channelAccounts.telegram[0], extra);
      return JSON.stringify(status);
    };
    expect((await f.resume()).status).toBe('waiting_for_activation');
    f.dependencies.command = command;
    expect((await f.resume()).status).toBe('ready_empty_library');
  }, 60_000);

  test('healthy host healthState remains compatible with readiness', async () => {
    const f = await fixture(); await f.run(); f.state.confirmed = true;
    const command = f.dependencies.command;
    f.dependencies.command = async (argv, cwd) => {
      const output = await command(argv, cwd);
      if (argv[1] !== 'channels') return output;
      const status = JSON.parse(output);
      Object.assign(status.channelAccounts.telegram[0], { healthState: 'healthy', configured: true, connected: true, restartPending: false });
      return JSON.stringify(status);
    };
    expect((await f.resume()).status).toBe('ready_empty_library');
  }, 60_000);

  test.each(['worker_unavailable', 'route_removed', 'corpus_inactive'])('fresh %s worker proof cannot reuse an old ready receipt', async (failure) => {
    const f = await fixture(); await f.run(); f.state.confirmed = true;
    expect((await f.resume()).status).toBe('ready_empty_library');
    const worker = f.dependencies.worker;
    const freshCalls: string[] = [];
    f.dependencies.worker = async (tool, params) => {
      freshCalls.push(tool);
      const durable = JSON.parse(await readFile(join(f.config.rootDir, 'operations', 'example', 'state.json'), 'utf8'));
      expect(durable.corpusReady).toBe(false);
      if (failure === 'worker_unavailable' || (failure === 'route_removed' && tool === 'rag_corpus')) throw new Error('Fixture worker proof unavailable');
      if (failure === 'corpus_inactive' && tool === 'rag_corpus') return { status: 'create_requested', creation_pending: true };
      return worker(tool, params);
    };
    if (failure === 'corpus_inactive') expect((await f.resume()).status).toBe('waiting_for_corpus');
    else await expect(f.resume()).rejects.toThrow();
    const status = await f.run({ action: 'status', agent_id: 'example' });
    expect(status.status).not.toBe('ready_empty_library');
    expect(status.corpus_ready).toBe(false);
    expect(freshCalls).toEqual(failure === 'worker_unavailable' ? ['domain_agent'] : ['domain_agent', 'domain_agent', 'rag_corpus']);
    expect(f.state.provisionCount).toBe(1);
    f.dependencies.worker = worker;
    expect((await f.resume()).status).toBe('ready_empty_library');
  }, 60_000);

  test.each(['resume', 'status'] as const)('rejects creation-only fields on %s', async (action) => {
    const f = await fixture();
    for (const key of ['purpose', 'display_name', 'telegram_username', 'soul']) {
      await expect(f.run({ action, agent_id: 'example', [key]: 'ignored?' })).rejects.toMatchObject({ code: 'factory_invalid_request' });
    }
    expect(f.calls).toHaveLength(0);
  });

  test('preexisting managed-bot confirmation is not adopted by an initial creation', async () => {
    const f = await fixture();
    f.dependencies.probeTelegram = (input, deps) => probeManagedBotProvision(input, { ...deps,
      fetchImpl: async (url) => Response.json({ ok: true, result: url.endsWith('/getWebhookInfo') ? { url: '' }
        : [{ update_id: 1, managed_bot: { user: { id: 12345 }, bot: { id: 987654321, is_bot: true, username: 'ExampleFactoryTestBot' } } }] }),
    });
    await expect(f.run()).rejects.toMatchObject({ code: 'factory_telegram_username_taken' });
    expect(f.state.beginCount).toBe(0);
    expect(f.state.provisionCount).toBe(0);
    expect(await Bun.file(join(f.workspace, 'agent.json')).exists()).toBe(false);
  });

  test('initial invocation returns its link even if a confirmation arrives during creation', async () => {
    const f = await fixture();
    const begin = f.dependencies.beginTelegram!;
    f.dependencies.beginTelegram = async (...args) => { f.state.confirmed = true; return begin(...args); };
    const first = await f.run();
    expect(first.status).toBe('waiting_for_telegram');
    expect(first.confirmation_url).toBeDefined();
    expect(f.state.probeCount).toBe(1);
    expect(f.state.provisionCount).toBe(0);
    expect((await f.resume()).status).toBe('ready_empty_library');
  }, 60_000);

  test.each(['waiting', 'ready'])('another operation cannot reuse a %s Telegram username with different casing', async (phase) => {
    const f = await fixture(); await f.run();
    if (phase === 'ready') { f.state.confirmed = true; await f.resume(); }
    const before = f.state.provisionCount;
    await expect(f.run({ ...request, agent_id: 'aardvark', telegram_username: 'examplefactorytestbot' })).rejects.toMatchObject({ code: 'factory_telegram_collision' });
    expect(f.state.beginCount).toBe(1);
    expect(f.state.provisionCount).toBe(before);
    expect(await Bun.file(join(f.config.tokenDirectory, 'aardvark.token')).exists()).toBe(false);
    expect(f.state.accounts.aardvark).toBeUndefined();
  }, 60_000);

  test('distinct pending usernames cannot resolve to the same confirmed numeric bot identity', async () => {
    const f = await fixture(); await f.run();
    await f.run({ ...request, agent_id: 'aardvark', telegram_username: 'OtherFactoryTestBot' });
    f.state.confirmed = true; expect((await f.resume()).status).toBe('ready_empty_library');
    f.dependencies.probeTelegram = async ({ username }) => ({ status: 'confirmed', botId: 987654321, actualUsername: username, latestUpdateId: 0 });
    await expect(f.run({ action: 'resume', agent_id: 'aardvark', apply: true })).rejects.toMatchObject({ code: 'factory_telegram_collision' });
    expect(f.state.provisionCount).toBe(1);
    expect(await Bun.file(join(f.config.tokenDirectory, 'aardvark.token')).exists()).toBe(false);
    expect(f.state.accounts.aardvark).toBeUndefined();
  }, 60_000);

  test('deployment lock serializes distinct concurrent requests', async () => {
    const f = await fixture();
    let release!: () => void; let entered!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const begin = f.dependencies.beginTelegram!;
    f.dependencies.beginTelegram = async (...args) => { entered(); await wait; return begin(...args); };
    const running = f.run(); await started;
    try {
      await expect(f.run({ ...request, agent_id: 'other-agent' })).rejects.toMatchObject({ code: 'factory_busy' });
    } finally { release(); }
    expect((await running).status).toBe('waiting_for_telegram');
    expect(f.state.beginCount).toBe(1);
  }, 60_000);

  test.each(['purpose', 'soul', 'display_name'])('rejects pasted credentials in %s without echoing them', async (field) => {
    const f = await fixture();
    try { await f.run({ ...request, [field]: TOKEN }); throw new Error('Expected credential refusal'); }
    catch (error) {
      expect(error).toMatchObject({ code: 'factory_invalid_request' });
      expect(String(error)).not.toContain(TOKEN);
    }
    expect(f.calls).toHaveLength(0);
  });
  describe('self-healing deployment lock', () => {
    const lockPath = (f: Awaited<ReturnType<typeof fixture>>) => join(f.config.rootDir, 'factory.lock');
    const owner = (pid: number, start?: string) => JSON.stringify({ pid, ...(start ? { start } : {}), nonce: '00000000-0000-4000-8000-000000000001' }) + '\n';
    // A process id that belonged to a process which has since exited.
    const exitedPid = async () => { const child = Bun.spawn(['true']); await child.exited; return child.pid; };
    const ownStart = async () => (await readFile('/proc/self/stat', 'utf8')).split(') ')[1]!.split(' ')[19]!;

    test('a lock left by an exited process is taken over, and released afterwards', async () => {
      const f = await fixture();
      await writeFile(lockPath(f), owner(await exitedPid()), { mode: 0o600 });
      expect((await f.run()).status).toBe('waiting_for_telegram');
      expect((await readdir(f.config.rootDir)).sort()).toEqual(['agents', 'operations']);
    }, 60_000);

    test('a lock whose process id now belongs to a different process is taken over', async () => {
      const f = await fixture();
      // This process is alive, but it started at a different time than the recorded owner.
      await writeFile(lockPath(f), owner(process.pid, String(Number(await ownStart()) + 1)), { mode: 0o600 });
      expect((await f.run()).status).toBe('waiting_for_telegram');
      expect(await Bun.file(lockPath(f)).exists()).toBe(false);
    }, 60_000);

    test.each([
      ['a live owner', async () => owner(process.pid, await ownStart()), 'is running'],
      ['a live owner without a start time', async () => owner(process.pid), 'is running'],
      ['an unreadable lock from an earlier version', async () => '', 'remove factory.lock'],
      ['a malformed owner', async () => JSON.stringify({ pid: 'self', nonce: '../escape' }), 'remove factory.lock'],
    ])('never takes %s', async (_name, content, message) => {
      const f = await fixture();
      const text = await content();
      await writeFile(lockPath(f), text, { mode: 0o600 });
      const error = await f.run().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'factory_busy' });
      expect(String(error)).toContain(message);
      expect(await readFile(lockPath(f), 'utf8')).toBe(text);
      expect(f.state.beginCount).toBe(0);
      expect(await readdir(join(f.config.rootDir, 'operations'))).toEqual(['example']);
      expect(await readdir(join(f.config.rootDir, 'operations', 'example'))).toEqual([]);
    }, 60_000);

    test('a factory root whose filesystem has no hard links refuses with a coded error', async () => {
      const f = await fixture();
      const link = spyOn(fsPromises, 'link').mockImplementation(async () => { throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' }); });
      try {
        const error = await f.run().catch((caught: unknown) => caught);
        expect(error).toMatchObject({ code: 'factory_lock_unsupported' });
        expect(String(error)).toContain('hard links');
      } finally { link.mockRestore(); }
      expect((await readdir(f.config.rootDir)).sort()).toEqual(['operations']);
      expect(f.state.beginCount).toBe(0);
    }, 60_000);

    test('a takeover claim left by an exited invocation does not block the lock', async () => {
      const f = await fixture();
      const stale = '00000000-0000-4000-8000-000000000001';
      await writeFile(lockPath(f), owner(await exitedPid()), { mode: 0o600 });
      // The claim on that lock, by an invocation that exited while holding it.
      await writeFile(`${lockPath(f)}.${stale}`, JSON.stringify({ pid: await exitedPid(), nonce: '00000000-0000-4000-8000-000000000002' }) + '\n', { mode: 0o600 });
      expect((await f.run()).status).toBe('waiting_for_telegram');
      expect((await readdir(f.config.rootDir)).sort()).toEqual(['agents', 'operations']);
    }, 60_000);

    test('a takeover claim held by a live invocation is respected', async () => {
      const f = await fixture();
      await writeFile(lockPath(f), owner(await exitedPid()), { mode: 0o600 });
      const claim = `${lockPath(f)}.00000000-0000-4000-8000-000000000001`;
      const live = JSON.stringify({ pid: process.pid, start: await ownStart(), nonce: '00000000-0000-4000-8000-000000000002' }) + '\n';
      await writeFile(claim, live, { mode: 0o600 });
      await expect(f.run()).rejects.toMatchObject({ code: 'factory_busy' });
      expect(await readFile(claim, 'utf8')).toBe(live);
      expect(f.state.beginCount).toBe(0);
    }, 60_000);

    test('two invocations finding the same abandoned lock: exactly one takes it over', async () => {
      const f = await fixture();
      await writeFile(lockPath(f), owner(await exitedPid()), { mode: 0o600 });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const begin = f.dependencies.beginTelegram!;
      f.dependencies.beginTelegram = async (...args) => { await gate; return begin(...args); };
      const runs = [f.run(), f.run({ ...request, agent_id: 'other-agent', telegram_username: 'OtherFactoryTestBot' })];
      const first = await Promise.race(runs.map((run) => run.then(() => 'completed', (error: unknown) => error)));
      expect(first).toMatchObject({ code: 'factory_busy' });
      release();
      const outcomes = await Promise.allSettled(runs);
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(f.state.beginCount).toBe(1);
      expect(await Bun.file(lockPath(f)).exists()).toBe(false);
    }, 60_000);
  });

  describe('workspace seed', () => {
    const statePath = (f: Awaited<ReturnType<typeof fixture>>) => join(f.config.rootDir, 'operations', 'example', 'state.json');

    test('creation bootstraps the registered domain workspace once, between registration and the corpus', async () => {
      const f = await fixture();
      await f.run();
      const order = f.workers.filter((call) => call.params.dry_run !== true).map((call) => `${call.tool} ${call.params.action}`);
      expect(order).toEqual(['domain_agent register', 'domain_agent status', 'domain_agent bootstrap', 'domain_agent status', 'rag_corpus ensure']);
      expect(f.workers.find((call) => call.params.action === 'bootstrap')!.params).toEqual({ action: 'bootstrap', domain_id: 'example', dry_run: false });
      // A resume re-proves the seed read-only and never rewrites a seeded workspace.
      f.state.confirmed = true;
      expect((await f.resume()).status).toBe('ready_empty_library');
      expect(f.state.bootstrapCount).toBe(1);
      expect(f.workers.filter((call) => call.params.action === 'status')).toHaveLength(3);
    }, 60_000);

    test('a resume re-seeds a workspace whose seed files went missing', async () => {
      const f = await fixture(); await f.run(); f.state.confirmed = true;
      expect((await f.resume()).status).toBe('ready_empty_library');
      f.state.seeded = false;
      expect((await f.resume()).status).toBe('ready_empty_library');
      expect(f.state.bootstrapCount).toBe(2);
      expect(f.state.seeded).toBe(true);
    }, 60_000);

    test('an operation recorded before the seed step existed is seeded on its next resume', async () => {
      const f = await fixture(); await f.run(); f.state.confirmed = true;
      expect((await f.resume()).status).toBe('ready_empty_library');
      const { workspaceSeeded: _seeded, ...earlier } = JSON.parse(await readFile(statePath(f), 'utf8'));
      await writeFile(statePath(f), JSON.stringify(earlier) + '\n', { mode: 0o600 });
      f.state.seeded = false;
      expect((await f.resume()).status).toBe('ready_empty_library');
      expect(f.state.bootstrapCount).toBe(2);
      expect(f.state.provisionCount).toBe(1);
      expect(JSON.parse(await readFile(statePath(f), 'utf8')).workspaceSeeded).toBe(true);
    }, 60_000);

    test.each([
      ['an unconfirmed bootstrap', { status: 'dry_run_scaffold_ready' }, 'factory_workspace_seed_incomplete'],
      ['a bootstrap that leaves seed files missing', 'still-missing', 'factory_workspace_seed_incomplete'],
      ['a refused bootstrap', Object.assign(new Error('Workspace root is not configured.'), { code: 'workspace_root_not_configured' }), 'workspace_root_not_configured'],
    ])('%s stops at bootstrapping_workspace before the corpus and resumes there', async (_name, outcome, code) => {
      const f = await fixture();
      const worker = f.dependencies.worker;
      f.dependencies.worker = async (tool, params) => {
        if (params.action !== 'bootstrap') return worker(tool, params);
        f.workers.push({ tool, params });
        if (outcome instanceof Error) throw outcome;
        return outcome === 'still-missing' ? { status: 'workspace_bootstrapped' } : outcome;
      };
      await expect(f.run()).rejects.toMatchObject({ code, details: { phase: 'bootstrapping_workspace' } });
      expect((await f.run({ action: 'status', agent_id: 'example' })).status).toBe('bootstrapping_workspace');
      expect(f.workers.some((call) => call.tool === 'rag_corpus')).toBe(false);
      f.dependencies.worker = worker;
      expect((await f.resume()).status).toBe('waiting_for_telegram');
      expect(f.state.seeded).toBe(true);
    }, 60_000);
  });

  test('a corpus that was never requested resumes as creating_corpus, not as a pending Vertex creation', async () => {
    const f = await fixture();
    const worker = f.dependencies.worker;
    f.dependencies.worker = async (tool, params) => {
      if (tool === 'rag_corpus') throw Object.assign(new Error('Vertex unavailable.'), { code: 'rag_corpus_unavailable' });
      return worker(tool, params);
    };
    await expect(f.run()).rejects.toMatchObject({ code: 'rag_corpus_unavailable', details: { phase: 'creating_corpus', step: 'worker corpus ensure' } });
    await expect(f.resume()).rejects.toMatchObject({ code: 'rag_corpus_unavailable', details: { phase: 'creating_corpus' } });
    const status = await f.run({ action: 'status', agent_id: 'example' });
    expect(status.status).toBe('creating_corpus');
    expect(status.next_action).not.toContain('pending');
    expect(status.confirmation_url).toBe('https://t.me/FactoryManagerBot?start=fixture');
    f.dependencies.worker = worker;
    expect((await f.resume()).status).toBe('waiting_for_telegram');
  }, 60_000);

  describe('remote history wiring', () => {
    async function gitOutput(cwd: string, args: string[]): Promise<string> {
      const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
      const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      if (code !== 0) throw new Error(`git ${args.join(' ')} failed`);
      return stdout.trim();
    }

    test('without a template the repository stays local and the result names no remote', async () => {
      const f = await fixture();
      const result = await f.run();
      expect(result.repository_remote).toBeUndefined();
      expect(await gitOutput(f.workspace, ['remote'])).toBe('');
      expect(f.calls.some((call) => call.argv[0] === 'git' && call.argv[1] === 'push')).toBe(false);
    }, 60_000);

    test('creation creates the remote once, pushes the initial commit and records the proven remote', async () => {
      const f = await fixture(); f.wireRemote();
      const result = await f.run();
      const remote = `file://${join(f.base, 'remotes')}/example.git`;
      expect(f.state.remoteCreateCalls).toEqual([['example', remote]]);
      expect(result.repository_remote).toBe(remote);
      expect(await gitOutput(f.workspace, ['remote', 'get-url', 'origin'])).toBe(remote);
      expect(await gitOutput(f.workspace, ['rev-parse', '@{upstream}'])).toBe(result.commit!);
      expect(await gitOutput(join(f.base, 'remotes', 'example.git'), ['rev-parse', 'HEAD'])).toBe(result.commit!);
      const status = await f.run({ action: 'status', agent_id: 'example' });
      expect(status.repository_remote).toBe(remote);
      f.state.confirmed = true;
      await f.resume();
      expect(f.state.remoteCreateCalls).toHaveLength(1);
      expect(f.calls.filter((call) => call.argv[0] === 'git' && call.argv[1] === 'push')).toHaveLength(1);
      expect(f.calls.filter((call) => call.options)).toEqual([]);
    }, 60_000);

    test.each([
      ['https://github.com/example-owner/{agentId}.git', true],
      ['https://git.example.com/example-owner/{agentId}.git', false],
    ])('%s pushes with the System GitHub identity: %p, and no other command receives it', async (template, identity) => {
      const f = await fixture();
      f.config.remoteUrlTemplate = template;
      const remote = template.replace('{agentId}', 'example');
      const bare = join(f.base, 'https', new URL(remote).hostname, 'example-owner', 'example.git');
      await mkdir(bare, { recursive: true });
      await gitOutput(f.base, ['init', '--bare', '--quiet', bare]);
      const result = await f.run();
      expect(result.repository_remote).toBe(remote);
      expect(await gitOutput(bare, ['rev-parse', 'HEAD'])).toBe(result.commit!);
      // Preflight checks the identity and the remote the same way the push uses them.
      expect(f.calls.filter((call) => call.options?.githubIdentity).map((call) => call.argv)).toEqual(identity
        ? [['git', 'ls-remote', remote], ['gh', 'auth', 'status', '--active', '--hostname', 'github.com'], ['git', 'push', '--set-upstream', 'origin', 'HEAD']]
        : []);
      expect(f.calls.filter((call) => call.options && !call.options.githubIdentity)).toEqual([]);
    }, 60_000);

    test('the repository is created without a host Git template that could seed its settings', async () => {
      const f = await fixture();
      const template = join(f.base, 'template');
      await mkdir(join(template, 'hooks'), { recursive: true });
      await writeFile(join(template, 'config'), '[url "file:///decoy/"]\n\tinsteadOf = https://github.com/\n');
      const previous = process.env.GIT_TEMPLATE_DIR;
      process.env.GIT_TEMPLATE_DIR = template;
      try { await f.run(); } finally { if (previous === undefined) delete process.env.GIT_TEMPLATE_DIR; else process.env.GIT_TEMPLATE_DIR = previous; }
      expect(await readFile(join(f.workspace, '.git', 'config'), 'utf8')).not.toContain('insteadOf');
    }, 60_000);

    test('an unavailable System GitHub identity stops at wiring_remote and resumes once reconnected', async () => {
      const f = await fixture();
      f.config.remoteUrlTemplate = 'https://github.com/example-owner/{agentId}.git';
      const bare = join(f.base, 'https', 'github.com', 'example-owner', 'example.git');
      await mkdir(bare, { recursive: true });
      await gitOutput(f.base, ['init', '--bare', '--quiet', bare]);
      const command = f.dependencies.command;
      // Available at preflight, then disconnected before the push.
      let connected = true;
      let reconnected = false;
      f.dependencies.command = async (argv, cwd, options) => {
        if (options?.githubIdentity && argv[1] === 'push' && !reconnected) connected = false;
        if (options?.githubIdentity && !connected) throw new FactoryError('factory_github_identity_unavailable', 'Fixture identity unavailable');
        return command(argv, cwd, options);
      };
      await expect(f.run()).rejects.toMatchObject({ code: 'factory_github_identity_unavailable', details: { phase: 'wiring_remote', step: 'git push' } });
      expect((await f.run({ action: 'status', agent_id: 'example' })).status).toBe('wiring_remote');
      // A resume before reconnecting stops at its preflight and still reports the recorded step.
      await expect(f.resume()).rejects.toMatchObject({ code: 'factory_github_identity_unavailable', details: { phase: 'preflight', step: 'git ls-remote' } });
      expect((await f.run({ action: 'status', agent_id: 'example' })).status).toBe('wiring_remote');
      expect(f.workers.filter((call) => call.params.dry_run === false)).toHaveLength(0);
      connected = true; reconnected = true;
      const result = await f.resume();
      expect(result.repository_remote).toBe('https://github.com/example-owner/example.git');
      expect(await gitOutput(bare, ['rev-parse', 'HEAD'])).toBe(result.commit!);
      expect(f.calls.filter((call) => call.argv[0] === 'git' && call.argv.includes('commit'))).toHaveLength(1);
    }, 60_000);

    test('a failed remote creation retains the commit and resumes without a second commit', async () => {
      const f = await fixture(); f.wireRemote(); f.state.remoteCreateFails = true;
      await expect(f.run()).rejects.toMatchObject({ code: 'factory_command_failed', details: { phase: 'wiring_remote', step: 'remote creation command', category: 'failed' } });
      expect((await f.run({ action: 'status', agent_id: 'example' })).status).toBe('wiring_remote');
      expect(f.workers.filter((call) => call.params.dry_run === false)).toHaveLength(0);
      f.state.remoteCreateFails = false;
      const result = await f.resume();
      expect(result.status).toBe('waiting_for_telegram');
      expect(result.repository_remote).toBe(`file://${join(f.base, 'remotes')}/example.git`);
      expect(f.calls.filter((call) => call.argv[0] === 'git' && call.argv.includes('commit'))).toHaveLength(1);
    }, 60_000);

    test('an operation recorded before wiring existed is adopted on resume and keeps its identity', async () => {
      const f = await fixture();
      await f.run();
      const statePath = join(f.config.rootDir, 'operations', 'example', 'state.json');
      const before = JSON.parse(await readFile(statePath, 'utf8')) as { operationId: string; commit: string };
      f.wireRemote();
      // An operator may already have wired the same remote by hand; the factory must reuse it, not fail on a second add.
      await mkdir(join(f.base, 'remotes'), { recursive: true });
      await gitOutput(f.base, ['init', '--bare', '--quiet', join(f.base, 'remotes', 'example.git')]);
      await gitOutput(f.workspace, ['remote', 'add', 'origin', `file://${join(f.base, 'remotes')}/example.git`]);
      f.state.confirmed = true;
      const result = await f.resume();
      expect(result.status).toBe('ready_empty_library');
      expect(result.repository_remote).toBe(`file://${join(f.base, 'remotes')}/example.git`);
      const after = JSON.parse(await readFile(statePath, 'utf8')) as { operationId: string; commit: string };
      expect(after.operationId).toBe(before.operationId);
      expect(after.commit).toBe(before.commit);
      expect(await gitOutput(f.workspace, ['rev-parse', '@{upstream}'])).toBe(before.commit);
    }, 60_000);

    test('a remote that does not record the head is not claimed', async () => {
      const f = await fixture(); f.wireRemote();
      const command = f.dependencies.command;
      f.dependencies.command = async (argv, cwd) => {
        if (argv[0] === 'git' && argv[1] === 'rev-parse' && argv[2] === '@{upstream}') return `${'0'.repeat(40)}\n`;
        return command(argv, cwd);
      };
      await expect(f.run()).rejects.toMatchObject({ code: 'factory_remote_proof_missing' });
      expect((await f.run({ action: 'status', agent_id: 'example' })).repository_remote).toBeUndefined();
    }, 60_000);
  });
  describe('renamed confirmation', () => {
    test('adopts the one newer bot the owner created under another name and installs its token by id', async () => {
      const f = await fixture(); f.state.latestUpdateId = 7;
      await f.run();
      expect(f.state.probeInputs[0]).not.toHaveProperty('sinceUpdateId');
      f.state.confirmedUsername = 'ExampleRenamed_tBot';
      f.state.renamedCandidates = [{ botId: 987654321, username: 'ExampleRenamed_tBot', updateId: 8 }];
      const result = await f.resume();
      expect(f.state.probeInputs[1]).toMatchObject({ sinceUpdateId: 7 });
      expect(result.status).toBe('ready_empty_library');
      expect(result.telegram_url).toBe('https://t.me/ExampleRenamed_tBot');
      expect(result.telegram_username_changed_from).toBe('ExampleFactoryTestBot');
      expect(f.state.provisionCount).toBe(1);
      expect(await readdir(f.config.tokenDirectory)).toEqual(['example.token']);
      const status = await f.run({ action: 'status', agent_id: 'example' });
      expect(status.telegram_username_changed_from).toBe('ExampleFactoryTestBot');
    }, 60_000);

    test('passes the accept-rename flag to the provision CLI only for a renamed bot', async () => {
      const f = await fixture();
      const provisionArgs: string[][] = [];
      const provision = f.dependencies.provisionTelegram!;
      f.dependencies.provisionTelegram = async (args, deps) => { provisionArgs.push([...args]); return provision(args, deps); };
      await f.run(); f.state.confirmed = true;
      expect((await f.resume()).status).toBe('ready_empty_library');
      expect(provisionArgs[0]).not.toContain('--accept-username-change');
      const g = await fixture();
      const provisionArgsRenamed: string[][] = [];
      const provisionRenamed = g.dependencies.provisionTelegram!;
      g.dependencies.provisionTelegram = async (args, deps) => { provisionArgsRenamed.push([...args]); return provisionRenamed(args, deps); };
      await g.run();
      g.state.confirmedUsername = 'ExampleRenamed_tBot';
      g.state.renamedCandidates = [{ botId: 987654321, username: 'ExampleRenamed_tBot', updateId: 1 }];
      expect((await g.resume()).status).toBe('ready_empty_library');
      expect(provisionArgsRenamed[0]).toContain('--accept-username-change');
      expect(provisionArgsRenamed[0]).toContain('987654321');
    }, 90_000);

    test('refuses to guess between two newer bots and installs nothing', async () => {
      const f = await fixture();
      await f.run();
      f.state.renamedCandidates = [
        { botId: 111, username: 'ExampleOne_tBot', updateId: 1 },
        { botId: 987654321, username: 'ExampleTwo_tBot', updateId: 2 },
      ];
      await expect(f.resume()).rejects.toMatchObject({ code: 'factory_telegram_ambiguous', message: expect.stringContaining('@ExampleOne_tBot') });
      expect(f.state.provisionCount).toBe(0);
      expect((await f.run({ action: 'status', agent_id: 'example' })).status).toBe('waiting_for_telegram');
      f.state.renamedCandidates = [{ botId: 987654321, username: 'ExampleTwo_tBot', updateId: 2 }];
      f.state.confirmedUsername = 'ExampleTwo_tBot';
      expect((await f.resume()).status).toBe('ready_empty_library');
    }, 60_000);

    test('a newer bot another operation already claims is not a candidate', async () => {
      const f = await fixture();
      await f.run();
      const otherDir = join(f.config.rootDir, 'operations', 'other-agent');
      await mkdir(otherDir, { recursive: true, mode: 0o700 });
      await writeFile(join(otherDir, 'state.json'), JSON.stringify({ schemaVersion: 1, operationId: 'other', phase: 'waiting_for_activation', configFingerprint: 'x',
        spec: { agentId: 'other-agent', displayName: 'Other', purpose: 'p', telegramUsername: 'OtherExpertBot', soul: 's' }, botId: 555, botUsername: 'OtherRenamed_tBot' }) + '\n', { mode: 0o600 });
      f.state.renamedCandidates = [{ botId: 555, username: 'OtherRenamed_tBot', updateId: 1 }];
      expect((await f.resume()).status).toBe('waiting_for_telegram');
      expect(f.state.provisionCount).toBe(0);
    }, 60_000);

    test('a bot queued before the confirmation link is never adopted, end to end through the real probe', async () => {
      const f = await fixture();
      const updates = [{ update_id: 41, managed_bot: { user: { id: 12345 }, bot: { id: 777, is_bot: true, username: 'EarlierUnrelated_tBot' } } }];
      f.dependencies.probeTelegram = (input, deps) => probeManagedBotProvision(input, { ...deps,
        fetchImpl: async (url) => Response.json({ ok: true, result: url.endsWith('/getWebhookInfo') ? { url: '' } : updates }),
      });
      expect((await f.run()).status).toBe('waiting_for_telegram');
      expect((await f.resume()).status).toBe('waiting_for_telegram');
      expect(f.state.provisionCount).toBe(0);
      updates.push({ update_id: 42, managed_bot: { user: { id: 12345 }, bot: { id: 987654321, is_bot: true, username: 'ExampleRenamed_tBot' } } });
      f.state.confirmedUsername = 'ExampleRenamed_tBot';
      const result = await f.resume();
      expect(result.status).toBe('ready_empty_library');
      expect(result.telegram_url).toBe('https://t.me/ExampleRenamed_tBot');
      expect(f.state.provisionCount).toBe(1);
    }, 60_000);
  });

  describe('preflight', () => {
    async function nothingCreated(f: Awaited<ReturnType<typeof fixture>>) {
      expect(await Bun.file(join(f.config.rootDir, 'operations', 'example', 'state.json')).exists()).toBe(false);
      expect(await Bun.file(join(f.workspace, 'agent.json')).exists()).toBe(false);
      expect(f.state.beginCount).toBe(0);
      expect(f.state.remoteCreateCalls).toEqual([]);
      expect(f.workers.filter((call) => call.params.dry_run !== true)).toEqual([]);
      expect(await Bun.file(join(f.config.rootDir, 'factory.lock')).exists()).toBe(false);
    }
    const githubRemote = (f: Awaited<ReturnType<typeof fixture>>, create = true) => {
      f.config.remoteUrlTemplate = 'https://github.com/example-owner/{agentId}.git';
      if (!create) delete f.config.remoteCreateCommand; else f.config.remoteCreateCommand = f.programs.createRemote;
    };

    test('refuses before anything is created when the running Gateway does not reload config', async () => {
      const f = await fixture(); f.state.reloadMode = 'off';
      const error = await f.run().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'factory_gateway_reload_off', details: { phase: 'preflight', step: 'gateway reload mode' } });
      expect(String(error)).toContain('gateway.reload.mode');
      await nothingCreated(f);
      // Negative controls: the default and hybrid reload proceed.
      for (const mode of [undefined, 'hybrid']) {
        const g = await fixture(); g.state.reloadMode = mode;
        expect((await g.run()).status).toBe('waiting_for_telegram');
      }
    }, 60_000);

    test.each([
      ['not_configured', 'not_configured'], ['project_not_configured', 'project_not_configured'], ['unreadable', 'unreadable'],
      [undefined, 'not ready'], ['private-detail', 'not ready'],
    ])('refuses before anything is created when the worker reports Google %p', async (google, reported) => {
      const f = await fixture(); f.state.googleStatus = google;
      const error = await f.run().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'factory_google_not_ready', details: { phase: 'preflight', step: 'worker health' } });
      expect(String(error)).toContain(`Google configuration as ${reported},`);
      expect(String(error)).not.toContain('private-detail');
      await nothingCreated(f);
      f.state.googleStatus = 'ready';
      expect((await f.run()).status).toBe('waiting_for_telegram');
    }, 60_000);

    test('an unreachable worker health check refuses with its own code before the Telegram link', async () => {
      const f = await fixture();
      f.dependencies.workerHealth = async () => { throw Object.assign(new Error('Domain expert worker is unreachable.'), { code: 'domain_expert_unreachable' }); };
      await expect(f.run()).rejects.toMatchObject({ code: 'domain_expert_unreachable', details: { phase: 'preflight', step: 'worker health' } });
      await nothingCreated(f);
    }, 60_000);

    test('a resume also needs Google, since it re-proves the corpus', async () => {
      const f = await fixture(); await f.run(); f.state.confirmed = true;
      f.state.googleStatus = 'unreadable';
      await expect(f.resume()).rejects.toMatchObject({ code: 'factory_google_not_ready', details: { phase: 'preflight' } });
      expect((await f.run({ action: 'status', agent_id: 'example' })).status).toBe('waiting_for_telegram');
      expect(f.state.provisionCount).toBe(0);
      f.state.googleStatus = 'ready';
      expect((await f.resume()).status).toBe('ready_empty_library');
    }, 60_000);

    test.each([
      ['no workspace roots', []],
      ['only another root', [{ root_id: 'other_root', allow_overwrite: false }]],
    ])('refuses before anything is created when the worker has %s for the domain workspace', async (_name, roots) => {
      const f = await fixture(); f.state.roots = roots;
      const error = await f.run().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'factory_workspace_root_missing', details: { phase: 'preflight', step: 'worker health' } });
      expect(String(error)).toContain('EXPERT_AGENTS_DOMAIN_EXPERT_ROOTS_JSON');
      await nothingCreated(f);
    }, 60_000);

    test.each([true, undefined])('refuses a workspace root whose allow_overwrite is %p, so bootstrap can never rewrite owner files', async (allowOverwrite) => {
      const f = await fixture(); f.state.roots = [{ root_id: 'expert_agents_workspace', ...(allowOverwrite === undefined ? {} : { allow_overwrite: allowOverwrite }) }];
      await expect(f.run()).rejects.toMatchObject({ code: 'factory_workspace_root_overwrites', details: { phase: 'preflight', step: 'worker health' } });
      await nothingCreated(f);
    }, 60_000);

    test('an owner who deleted a seed file on an overwriting root gets a refusal, not a rewritten workspace', async () => {
      const f = await fixture(); await f.run(); f.state.confirmed = true;
      expect((await f.resume()).status).toBe('ready_empty_library');
      f.state.seeded = false;
      f.state.roots = [{ root_id: 'expert_agents_workspace', allow_overwrite: true }];
      await expect(f.resume()).rejects.toMatchObject({ code: 'factory_workspace_root_overwrites', details: { phase: 'preflight' } });
      expect(f.state.bootstrapCount).toBe(1);
      f.state.roots = [{ root_id: 'expert_agents_workspace', allow_overwrite: false }];
      expect((await f.resume()).status).toBe('ready_empty_library');
      expect(f.state.bootstrapCount).toBe(2);
    }, 60_000);

    test('a resume refuses with reload off until the Gateway is configured, then readiness still checks', async () => {
      const f = await fixture(); await f.run(); f.state.confirmed = true; f.state.reloadMode = 'off';
      await expect(f.resume()).rejects.toMatchObject({ code: 'factory_gateway_reload_off', details: { phase: 'preflight' } });
      expect((await f.run({ action: 'status', agent_id: 'example' })).status).toBe('waiting_for_telegram');
      expect(f.state.provisionCount).toBe(0);
      f.state.reloadMode = undefined;
      expect((await f.resume()).status).toBe('ready_empty_library');
      // Once configured, reload no longer gates a readiness check.
      f.state.reloadMode = 'off'; f.state.running = false;
      expect((await f.resume()).status).toBe('waiting_for_activation');
    }, 60_000);

    test('refuses a refused System GitHub identity before the Telegram link or any repository', async () => {
      const f = await fixture(); githubRemote(f); f.state.githubAuth = 'invalid';
      const error = await f.run().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'factory_command_failed', details: { phase: 'preflight', step: 'gh auth status', category: 'auth' } });
      expect(String(error)).toContain('System GitHub');
      expect(String(error)).toContain('Nothing was changed');
      await nothingCreated(f);
      // Negative control: a valid identity and an absent remote that the factory will create.
      f.state.githubAuth = 'valid';
      const result = await f.run();
      expect(result.repository_remote).toBe('https://github.com/example-owner/example.git');
      expect(f.state.remoteCreateCalls).toHaveLength(1);
    }, 60_000);

    test.each([
      ['a refused credential', new FactoryError('factory_command_failed', 'refused', { category: 'auth' }), 'factory_command_failed', 'auth'],
      ['an unreachable service', new FactoryError('factory_command_failed', 'unreachable', { category: 'unavailable' }), 'factory_command_failed', 'unavailable'],
      ['a redirecting repository setting', new FactoryError('factory_repository_git_config', 'redirect'), 'factory_repository_git_config', undefined],
      ['a missing gh or git', new FactoryError('factory_command_failed', 'missing', { category: 'missing_command' }), 'factory_command_failed', 'missing_command'],
    ])('a remote check failing with %s refuses even when the remote will be created', async (_name, failure, code, category) => {
      const f = await fixture(); githubRemote(f);
      const command = f.dependencies.command;
      f.dependencies.command = async (argv, cwd, options) => {
        if (argv[1] === 'ls-remote') throw failure;
        return command(argv, cwd, options);
      };
      await expect(f.run()).rejects.toMatchObject({ code, details: { phase: 'preflight', step: 'git ls-remote', ...(category ? { category } : {}) } });
      await nothingCreated(f);
      // The remote is checked first, so an outage is not reported as a refused credential.
      expect(f.calls.some((call) => call.argv[0] === 'gh')).toBe(false);
    }, 60_000);

    test('a missing gh is reported as a missing program, not a credential problem', async () => {
      const f = await fixture(); githubRemote(f);
      const command = f.dependencies.command;
      f.dependencies.command = async (argv, cwd, options) => {
        if (argv[1] === 'ls-remote') throw new FactoryError('factory_command_failed', 'missing', { category: 'missing_command' });
        return command(argv, cwd, options);
      };
      const error = await f.run().catch((caught: unknown) => caught);
      expect(String(error)).toContain('GitHub CLI (gh)');
      expect(String(error)).not.toContain('Reconnect System GitHub');
    }, 60_000);

    const bareWithHistory = async (f: Awaited<ReturnType<typeof fixture>>) => {
      const bare = join(f.base, 'https', 'github.com', 'example-owner', 'example.git');
      const source = join(f.base, 'unrelated-history');
      await mkdir(bare, { recursive: true }); await mkdir(source);
      const git = (cwd: string, args: string[]) => expect(Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).exitCode).toBe(0);
      git(f.base, ['init', '--bare', '--quiet', bare]);
      git(source, ['init', '--quiet']);
      git(source, ['-c', 'user.name=Other', '-c', 'user.email=other@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'Unrelated']);
      git(source, ['push', '--quiet', bare, 'HEAD:refs/heads/main']);
      return bare;
    };

    test.each([true, false])('refuses a GitHub remote that already has other history before anything is created (creation command: %p)', async (create) => {
      const f = await fixture(); githubRemote(f, create);
      await bareWithHistory(f);
      const error = await f.run().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'factory_remote_has_history', details: { phase: 'preflight', step: 'git ls-remote' } });
      expect(String(error)).toContain('never adopts or overwrites');
      await nothingCreated(f);
    }, 60_000);

    test('a push whose proof a crash lost resumes, because the only remote history is this operation\'s commit', async () => {
      const f = await fixture(); githubRemote(f, false);
      const bare = join(f.base, 'https', 'github.com', 'example-owner', 'example.git');
      await mkdir(bare, { recursive: true });
      expect(Bun.spawnSync(['git', 'init', '--bare', '--quiet', bare], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).exitCode).toBe(0);
      const command = f.dependencies.command;
      let crash = true;
      f.dependencies.command = async (argv, cwd, options) => {
        if (crash && argv[1] === 'rev-parse' && argv[2] === '@{upstream}') { crash = false; throw new Error('Fixture crash after the push'); }
        return command(argv, cwd, options);
      };
      await expect(f.run()).rejects.toMatchObject({ details: { phase: 'wiring_remote' } });
      const result = await f.resume();
      expect(result.status).toBe('waiting_for_telegram');
      expect(result.repository_remote).toBe('https://github.com/example-owner/example.git');
      const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: bare, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout.toString().trim();
      expect(head).toBe(result.commit!);
      expect(f.calls.filter((call) => call.argv[0] === 'git' && call.argv.includes('commit'))).toHaveLength(1);
    }, 60_000);

    test('refuses an absent GitHub remote when nothing is configured to create it', async () => {
      const f = await fixture(); githubRemote(f, false);
      await expect(f.run()).rejects.toMatchObject({ code: 'factory_remote_missing', details: { phase: 'preflight', step: 'git ls-remote', category: 'not_found' } });
      await nothingCreated(f);
      // Negative control: an existing remote needs no creation command.
      const bare = join(f.base, 'https', 'github.com', 'example-owner', 'example.git');
      await mkdir(bare, { recursive: true });
      expect(Bun.spawnSync(['git', 'init', '--bare', '--quiet', bare], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).exitCode).toBe(0);
      expect((await f.run()).repository_remote).toBe('https://github.com/example-owner/example.git');
    }, 60_000);

    test.each([
      ['remote creation command', 'missing'], ['remote creation command', 'not executable'],
      ['activation command', 'missing'], ['activation command', 'not executable'],
    ])('refuses a %s that is %s before anything is created', async (step, problem) => {
      const f = await fixture(); f.wireRemote();
      const program = join(f.base, 'bin', 'deployment-program');
      if (problem === 'not executable') await writeFile(program, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
      if (step === 'remote creation command') f.config.remoteCreateCommand = program; else f.config.activationCommand = program;
      await expect(f.run()).rejects.toMatchObject({ code: 'factory_command_failed', details: { phase: 'preflight', step, category: 'missing_command' } });
      await nothingCreated(f);
      // Negative control: the same program once present and executable.
      await writeFile(program, '#!/bin/sh\nexit 0\n');
      await chmod(program, 0o700);
      expect((await f.run()).status).toBe('waiting_for_telegram');
    }, 60_000);
  });

  test('an activation program removed after configuration does not block a ready expert', async () => {
    const f = await fixture(); f.config.activationCommand = f.programs.activate;
    await f.run(); f.state.confirmed = true;
    expect((await f.resume()).status).toBe('ready_empty_library');
    await rm(f.programs.activate);
    expect((await f.resume()).status).toBe('ready_empty_library');
  }, 60_000);

  describe('diagnosable failures', () => {
    const PRIVATE = `private-output ${TOKEN}`;
    // One failing command per step, with the phase it must report.
    const steps: [string, string, (argv: string[]) => boolean, string][] = [
      ['committing_repository', 'git commit', (argv) => argv[0] === 'git' && argv.includes('commit'), 'create'],
      ['wiring_remote', 'git push', (argv) => argv[0] === 'git' && argv[1] === 'push', 'create'],
      ['configuring_gateway', 'agents.update', (argv) => argv[3] === 'agents.update', 'resume'],
      ['configuring_gateway', 'openclaw agents bind', (argv) => argv[1] === 'agents' && argv[2] === 'bind', 'resume'],
      ['configuring_gateway', 'openclaw doctor', (argv) => argv[1] === 'doctor', 'resume'],
    ];
    test.each(steps)('%s: %s names its phase, step and category, and status agrees', async (phase, step, matches, when) => {
      const f = await fixture(); f.wireRemote();
      if (when === 'resume') { await f.run(); f.state.confirmed = true; }
      const command = f.dependencies.command;
      f.dependencies.command = async (argv, cwd, options) => {
        if (matches(argv)) throw new FactoryError('factory_command_failed', PRIVATE, { category: 'not_found' });
        return command(argv, cwd, options);
      };
      const error = await (when === 'create' ? f.run() : f.resume()).catch((caught: unknown) => caught) as FactoryError;
      expect(error).toMatchObject({ code: 'factory_command_failed', details: { phase, step, category: 'not_found' } });
      expect(error.message.startsWith(`${phase}: ${step} failed (not_found).`)).toBe(true);
      expect(error.message).toContain('resume this operation; never start another');
      expect(JSON.stringify([error.message, error.details])).not.toContain('private-output');
      expect(JSON.stringify([error.message, error.details])).not.toContain(TOKEN);
      expect((await f.run({ action: 'status', agent_id: 'example' })).status).toBe(phase);
    }, 60_000);

    test('an agent the running Gateway cannot see points at config reload', async () => {
      const f = await fixture(); await f.run(); f.state.confirmed = true;
      const command = f.dependencies.command;
      f.dependencies.command = async (argv, cwd, options) => {
        if (argv[3] === 'agents.update') throw new FactoryError('factory_command_failed', 'agent not found', { category: 'not_found' });
        return command(argv, cwd, options);
      };
      await expect(f.resume()).rejects.toThrow('Gateway config reload is off');
      // Negative controls: another step, or another category on the same step, carries no reload hint.
      const g = await fixture(); await g.run(); g.state.confirmed = true;
      const other = g.dependencies.command;
      g.dependencies.command = async (argv, cwd, options) => {
        if (argv[3] === 'agents.create') throw new FactoryError('factory_command_failed', 'model not found', { category: 'not_found' });
        return other(argv, cwd, options);
      };
      const created = await g.resume().catch((caught: unknown) => caught);
      expect(created).toMatchObject({ details: { step: 'agents.create', category: 'not_found' } });
      expect(String(created)).not.toContain('reload');
      f.dependencies.command = async (argv, cwd, options) => {
        if (argv[3] === 'agents.update') throw new FactoryError('factory_command_failed', 'refused', { category: 'auth' });
        return command(argv, cwd, options);
      };
      const error = await f.resume().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ details: { phase: 'configuring_gateway', step: 'agents.update', category: 'auth' } });
      expect(String(error)).not.toContain('reload');
    }, 60_000);

    test('an unexpected failure is replaced with its location and no private detail', async () => {
      const f = await fixture(); await f.run(); f.state.confirmed = true;
      f.dependencies.provisionTelegram = async () => { throw new Error(PRIVATE); };
      const error = await f.resume().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'factory_step_failed', details: { phase: 'installing_telegram_token', step: 'Telegram token installation' } });
      expect(String(error)).toContain('resume this operation');
      expect(String(error)).not.toContain('private-output');
      expect((await f.run({ action: 'status', agent_id: 'example' })).status).toBe('installing_telegram_token');
      // Coded worker errors keep their own code and message and gain the location.
      const g = await fixture();
      g.dependencies.worker = async () => { throw Object.assign(new Error('Worker refused the plan.'), { code: 'domain_expert_policy_violation' }); };
      await expect(g.run()).rejects.toMatchObject({ code: 'domain_expert_policy_violation', message: 'Worker refused the plan.', details: { phase: 'preflight', step: 'worker registration check' } });
    }, 60_000);

    test('a fresh create stopped before its Telegram link says nothing was created, not resume', async () => {
      const f = await fixture();
      f.dependencies.beginTelegram = async () => { throw new Error(PRIVATE); };
      const error = await f.run().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'factory_step_failed', details: { phase: 'preflight', step: 'Telegram confirmation link' } });
      expect(String(error)).toContain('Nothing was created by this call');
      expect(String(error)).not.toContain('resume');
      expect(String(error)).not.toContain('private-output');
      expect(await Bun.file(join(f.config.rootDir, 'operations', 'example', 'state.json')).exists()).toBe(false);
    }, 60_000);

    test('a resume records the step it is in, so a corpus re-check failure is not reported as another step', async () => {
      const f = await fixture(); await f.run(); f.state.confirmed = true;
      expect((await f.resume()).status).toBe('ready_empty_library');
      const worker = f.dependencies.worker;
      f.dependencies.worker = async (tool, params) => {
        if (tool === 'rag_corpus') throw Object.assign(new Error('Corpus check unavailable.'), { code: 'rag_corpus_unavailable' });
        return worker(tool, params);
      };
      await expect(f.resume()).rejects.toMatchObject({ code: 'rag_corpus_unavailable', details: { phase: 'waiting_for_corpus', step: 'worker corpus ensure' } });
      expect((await f.run({ action: 'status', agent_id: 'example' })).status).toBe('waiting_for_corpus');
      f.dependencies.worker = worker;
      expect((await f.resume()).status).toBe('ready_empty_library');
    }, 60_000);

    test('every phase an operation records is a declared phase', async () => {
      const f = await fixture(); f.wireRemote(); f.state.running = false;
      const seen = new Set<string>();
      const statePath = join(f.config.rootDir, 'operations', 'example', 'state.json');
      const record = async () => {
        const saved = await readFile(statePath, 'utf8').then((text) => JSON.parse(text).phase as string, () => undefined);
        if (saved) seen.add(saved);
      };
      const command = f.dependencies.command;
      f.dependencies.command = async (argv, cwd, options) => { await record(); return command(argv, cwd, options); };
      const worker = f.dependencies.worker;
      f.dependencies.worker = async (tool, params) => { await record(); return worker(tool, params); };
      for (const status of [(await f.run()).status, ...await (async () => { f.state.confirmed = true; return [(await f.resume()).status]; })()]) seen.add(status);
      f.state.running = true;
      seen.add((await f.resume()).status);
      expect([...seen].filter((phase) => !(FACTORY_PHASES as readonly string[]).includes(phase))).toEqual([]);
      for (const phase of ['registering_library', 'bootstrapping_workspace', 'creating_corpus', 'configuring_gateway', 'ready_empty_library']) expect(seen.has(phase)).toBe(true);
    }, 60_000);
  });
});
