import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFactory, type FactoryDependencies } from '../src/factory.ts';
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
  const calls: { argv: string[]; cwd?: string }[] = [];
  const workers: { tool: string; params: Record<string, unknown> }[] = [];
  const state = {
    agents: [] as Record<string, unknown>[], accounts: {} as Record<string, unknown>,
    bindings: [] as Record<string, unknown>[], corpusReady: true, confirmed: false,
    running: true, probeOk: true, observedBotId: 987654321, ownerSeen: 0,
    beginCount: 0, provisionCount: 0, probeCount: 0, validationFails: false,
    channelError: false, registrationStatus: 'registered',
    remoteCreateCalls: [] as string[][], remoteCreateFails: false,
    latestUpdateId: 0, confirmedUsername: 'ExampleFactoryTestBot',
    renamedCandidates: [] as { botId: number; username: string; updateId: number }[],
    probeInputs: [] as Record<string, unknown>[],
  };
  const dependencies: FactoryDependencies = {
    command: async (argv, cwd) => {
      calls.push({ argv: [...argv], cwd });
      if (argv[0] === 'git') {
        const child = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        if (code !== 0) throw new Error(`Fixture git failed: ${stderr}`);
        return stdout;
      }
      if (argv[0] === config.activationCommand) return '';
      if (argv[0] === config.remoteCreateCommand) {
        state.remoteCreateCalls.push(argv.slice(1));
        if (state.remoteCreateFails) throw new Error('Fixture remote creation failed');
        const bare = new URL(argv[2]!).pathname;
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
    worker: async (tool, params) => {
      workers.push({ tool, params });
      return tool === 'domain_agent' ? { status: params.dry_run ? 'dry_run_registration_ready' : state.registrationStatus }
        : { status: state.corpusReady ? 'ready' : 'pending' };
    },
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
    config.remoteCreateCommand = '/fixture/create-remote';
  };
  const run = (next: FactoryRequest = request) => runFactory(config, next, dependencies);
  const resume = () => run({ action: 'resume', agent_id: 'example', apply: true });
  return { base, config, state, calls, workers, dependencies, run, resume, wireRemote, workspace: join(config.rootDir, 'agents', 'example') };
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
    expect(f.workers.filter((call) => call.tool === 'domain_agent' && call.params.dry_run === false)).toHaveLength(1);
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
    await expect(f.resume()).rejects.toThrow('Fixture Gateway unavailable');
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
    await expect(f.resume()).rejects.toThrow('Fixture account enable unavailable');
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
    await expect(f.resume()).rejects.toThrow('Fixture response lost after creation');
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
    f.config.activationCommand = '/fixture/activate';
    await f.run(); f.state.confirmed = true;
    expect((await f.resume()).status).toBe('waiting_for_activation');
    expect((await f.resume()).status).toBe('waiting_for_activation');
    expect(f.calls.filter((call) => call.argv[0] === '/fixture/activate')).toEqual([{ argv: ['/fixture/activate'], cwd: undefined }]);
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
    expect(freshCalls).toEqual(failure === 'worker_unavailable' ? ['domain_agent'] : ['domain_agent', 'rag_corpus']);
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
    }, 60_000);

    test('a failed remote creation retains the commit and resumes without a second commit', async () => {
      const f = await fixture(); f.wireRemote(); f.state.remoteCreateFails = true;
      await expect(f.run()).rejects.toMatchObject({ message: 'Fixture remote creation failed' });
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
});
