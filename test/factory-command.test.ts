import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFactoryCommand } from '../scripts/expert-factory.ts';

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
