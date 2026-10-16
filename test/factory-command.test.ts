import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyFailure, executeFactoryEnvelope, gatewayReloadMode, runFactoryCommand } from '../scripts/expert-factory.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function command(stderr: string, stdout = '') {
  const root = await mkdtemp(join(tmpdir(), 'expert-command-test-')); roots.push(root);
  const path = join(root, 'openclaw-fixture');
  await writeFile(path, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});process.exit(1);\n`, { mode: 0o700 });
  return path;
}

test('a fresh host with no Telegram section is an empty configuration', async () => {
  const path = await command('Config path not found: channels.telegram. Run openclaw config validate to inspect config shape.\n');
  expect(await runFactoryCommand([path, 'config', 'get', 'channels.telegram', '--json'])).toBe('{}');
});

test('malformed and unavailable configuration never becomes an empty account map or leaks stderr', async () => {
  const secret = 'sensitive-private-fixture';
  const path = await command(`Configuration invalid: ${secret}`);
  let error: unknown;
  try { await runFactoryCommand([path, 'config', 'get', 'channels.telegram', '--json']); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ code: 'factory_command_failed' });
  expect(String(error)).not.toContain(secret);
  const absent = await command('Config path not found: channels.telegram. Run openclaw config validate to inspect config shape.\n');
  await expect(runFactoryCommand([absent, 'config', 'get', 'agents', '--json'])).rejects.toMatchObject({ code: 'factory_command_failed' });
});

test('a 106-second health check can complete while ordinary commands remain bounded at 90 seconds', async () => {
  const original = Bun.spawn;
  // A virtual subprocess consumes 106 seconds. The real runner must select
  // enough budget for lint, without widening ordinary command timeouts.
  Bun.spawn = ((_argv: string[], options: { timeout: number }) => ({
    exited: Promise.resolve(options.timeout >= 106_000 ? 0 : 124),
    stdout: new Response('{"ok":true}').body!,
    stderr: new Response('').body!,
    kill() {},
  })) as typeof Bun.spawn;
  try {
    expect(await runFactoryCommand(['/fixture/openclaw', 'doctor', '--lint', '--severity-min', 'error', '--non-interactive'])).toBe('{"ok":true}');
    await expect(runFactoryCommand(['/fixture/openclaw', 'config', 'validate'])).rejects.toMatchObject({ code: 'factory_command_failed' });
  } finally { Bun.spawn = original; }
});

test('a failed health check still blocks and never exposes private diagnostic output', async () => {
  const path = await command('private-health-check-detail');
  let error: unknown;
  try { await runFactoryCommand([path, 'doctor', '--lint']); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ code: 'factory_command_failed' });
  expect(String(error)).toContain('health check failed');
  expect(String(error)).not.toContain('private-health-check-detail');
});

describe('failure categories', () => {
  // Messages as the installed tools print them; only the category may leave the factory.
  test.each([
    ['auth', "remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/example-owner/example.git/'"],
    ['auth', "fatal: could not read Username for 'https://github.com': terminal prompts disabled"],
    ['auth', 'X Failed to log in to github.com account example-user\n  - The token in /fixture/profile is invalid.'],
    ['auth', "remote: Permission to example-owner/example.git denied to example-user.\nfatal: unable to access 'https://github.com/example-owner/example.git/': The requested URL returned error: 403"],
    ['not_found', "remote: Repository not found.\nfatal: repository 'https://github.com/example-owner/example.git/' not found"],
    ['not_found', 'Error: agent "example" not found'],
    ['rejected', ' ! [rejected]        HEAD -> main (fetch first)\nerror: failed to push some refs'],
    ['unavailable', "fatal: unable to access 'https://github.com/example-owner/example.git/': Could not resolve host: github.com"],
    ['unavailable', 'gateway closed (1006): connect ECONNREFUSED 127.0.0.1:18789'],
    ['invalid', 'Config invalid: channels.telegram.accounts.example.dmPolicy must be one of the allowed values'],
    ['failed', 'something unexpected happened'],
  ])('%s from %j', (category, output) => {
    expect(classifyFailure(null, output)).toBe(category as never);
  });

  test('a command stopped by its time limit is a timeout whatever it printed; a crash is not', () => {
    expect(classifyFailure('SIGTERM', 'Authentication failed')).toBe('timeout');
    expect(classifyFailure('SIGSEGV', 'Authentication failed')).toBe('failed');
  });

  test('a failed command carries only its category, never its output', async () => {
    const secret = 'sensitive-private-fixture';
    const path = await command(`fatal: Authentication failed for 'https://github.com/${secret}.git/'`, secret);
    let error: unknown;
    try { await runFactoryCommand([path, 'push']); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'factory_command_failed', details: { category: 'auth' } });
    expect(JSON.stringify([String(error), (error as { details: unknown }).details])).not.toContain(secret);
  });

  test('a program that cannot start is missing_command; a missing working directory is not', async () => {
    await expect(runFactoryCommand(['/nonexistent/expert-factory-program', 'run'])).rejects.toMatchObject({ code: 'factory_command_failed', details: { category: 'missing_command' } });
    await expect(runFactoryCommand(['git', 'status'], '/nonexistent/expert-factory-workspace')).rejects.toMatchObject({ code: 'factory_command_failed', details: { category: 'not_found' } });
  });

  test('a command stopped at its time limit reports timeout', async () => {
    const original = Bun.spawn;
    Bun.spawn = (() => ({
      exited: Promise.resolve(143), signalCode: 'SIGTERM',
      stdout: new Response('').body!, stderr: new Response('Authentication failed').body!, kill() {},
    })) as unknown as typeof Bun.spawn;
    try { await expect(runFactoryCommand(['/fixture/openclaw', 'config', 'validate'])).rejects.toMatchObject({ details: { category: 'timeout' } }); }
    finally { Bun.spawn = original; }
  });
});

describe('unset configuration paths', () => {
  const unset = (path: string) => JSON.stringify({ ok: false, error: { type: 'cli_error', message: `Config path is valid but unset: ${path}. The runtime default applies until you set an authored value with openclaw config set ${path} <value>.` } }, null, 2);

  test('the current CLI shape for an unset Telegram section is an empty configuration', async () => {
    const path = await command('', unset('channels.telegram'));
    expect(await runFactoryCommand([path, 'config', 'get', 'channels.telegram', '--json'])).toBe('{}');
  });

  test.each([
    ['another path', (path: string) => command('', unset('channels.other')), 'channels.telegram'],
    ['a different CLI error', () => command('', JSON.stringify({ ok: false, error: { type: 'cli_error', message: 'Unknown config path: channels.telegram. Run openclaw config schema to inspect valid paths.' } })), 'channels.telegram'],
    ['an unset message with stderr noise', () => command('warning: plugin load failed', unset('channels.telegram')), 'channels.telegram'],
    ['a path the factory does not read', () => command('', unset('gateway.port')), 'gateway.port'],
  ])('is not trusted for %s', async (_name, make, path) => {
    const program = await make(path);
    await expect(runFactoryCommand([program, 'config', 'get', path, '--json'])).rejects.toMatchObject({ code: 'factory_command_failed' });
  });
});

describe('gateway reload mode', () => {
  test('the live runtime value from the plugin wins, including its default', async () => {
    expect(await gatewayReloadMode({ reloadMode: 'off' }, '/nonexistent/openclaw')).toBe('off');
    expect(await gatewayReloadMode({}, '/nonexistent/openclaw')).toBeUndefined();
  });

  test('without a runtime value the configured value is read, and an unset path is the default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'expert-command-test-')); roots.push(root);
    const cli = join(root, 'openclaw');
    const answer = async (stdout: string, code: number) => writeFile(cli, `#!${process.execPath}\nif (process.argv.slice(2).join(' ') !== 'config get gateway.reload.mode --json') process.exit(64);\nprocess.stdout.write(${JSON.stringify(stdout)});process.exit(${code});\n`, { mode: 0o700 });
    await answer('"off"\n', 0);
    expect(await gatewayReloadMode(undefined, cli)).toBe('off');
    await answer(JSON.stringify({ ok: false, error: { type: 'cli_error', message: 'Config path is valid but unset: gateway.reload.mode. The runtime default applies until you set an authored value with openclaw config set gateway.reload.mode <value>.' } }), 1);
    expect(await gatewayReloadMode(undefined, cli)).toBeUndefined();
    await answer('not json', 0);
    await expect(gatewayReloadMode(undefined, cli)).rejects.toMatchObject({ code: 'factory_command_failed', details: { category: 'invalid' } });
  });
});

describe('packaged factory preflight', () => {
  async function envelope(gateway: unknown) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'expert-command-test-'))); roots.push(root);
    const factoryRoot = join(root, 'factory'); const tokens = join(root, 'tokens');
    await mkdir(factoryRoot, { mode: 0o700 }); await mkdir(tokens, { mode: 0o700 });
    const manager = join(root, 'manager.token');
    await writeFile(manager, 'synthetic-manager-placeholder', { mode: 0o600 });
    const cli = join(root, 'openclaw');
    await writeFile(cli, `#!${process.execPath}\nconst args = process.argv.slice(2).join(' ');\nif (args === 'agents list --json' || args === 'agents bindings --json') process.stdout.write('[]');\nelse if (args === 'config get channels.telegram --json') process.stdout.write('{}');\nelse if (args === 'config validate') process.stdout.write('ok');\nelse process.exit(64);\n`, { mode: 0o700 });
    return executeFactoryEnvelope({
      factory: { enabled: true, rootDir: factoryRoot, tokenDirectory: tokens, managerTokenFile: manager, ownerTelegramUserId: 1234,
        libraryBucket: 'fixture-library', libraryPrefix: 'experts', openclawBin: cli },
      // An unreachable worker: the negative control proceeds past preflight and fails there.
      worker: { domainExpert: { enabled: true, baseUrl: 'http://127.0.0.1:9/v1', requestTimeoutSeconds: 2, authToken: 'synthetic-placeholder' } },
      request: { action: 'create', agent_id: 'example', display_name: 'Example', purpose: 'A neutral purpose', telegram_username: 'ExampleFactoryBot', apply: true },
      ...(gateway === undefined ? {} : { gateway }),
    }) as Promise<{ error?: Record<string, unknown> }>;
  }

  test('reload off refuses with its phase and step before anything is created', async () => {
    const result = await envelope({ reloadMode: 'off' });
    expect(result.error).toEqual({ code: 'factory_gateway_reload_off', message: expect.stringContaining('gateway.reload.mode'), phase: 'preflight', step: 'gateway reload mode' });
    // Negative control: hybrid reload passes preflight and stops at the unreachable worker instead.
    const hybrid = await envelope({ reloadMode: 'hybrid' });
    expect(hybrid.error?.code).not.toBe('factory_gateway_reload_off');
    expect(hybrid.error?.code).toBeDefined();
  }, 30_000);
});
