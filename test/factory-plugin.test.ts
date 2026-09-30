import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import plugin, { type NativeTool } from '../src/native-plugin.ts';
import manifest from '../openclaw.plugin.json' with { type: 'json' };
import type { FactoryToolContext } from '../src/factory-tool.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function factoryTool(config: unknown, context: FactoryToolContext): NativeTool {
  let found: NativeTool | undefined;
  plugin.register({ pluginConfig: config, registerTool: (registration) => {
    const tool = typeof registration === 'function' ? registration(context) : registration;
    if (tool.name === 'expert_factory') found = tool;
  } });
  if (!found) throw new Error('factory missing');
  return found;
}

describe('packaged expert factory', () => {
  test('declares distinct skill names that cannot be shadowed by legacy factory skills', async () => {
    expect(manifest.skills).toEqual(['./skills']);
    await assertSkillDiscovery('.');
  });

  test.each([
    {}, { senderIsOwner: false }, { senderIsOwner: true, sandboxed: true },
    { senderIsOwner: true, fsPolicy: { workspaceOnly: true } },
  ])('creation refuses untrusted or restricted host context %j', async (context) => {
    const tool = factoryTool({ factory: { enabled: true, bunBin: '/does-not-exist' } }, context);
    const output = await tool.execute('test', { action: 'create', agent_id: 'example', apply: true });
    expect(output.isError).toBe(true);
    expect(output.content[0]!.text).toContain('factory_owner_required');
  });

  test('default-disabled factory reports the actual prerequisite', async () => {
    const output = await factoryTool({}, { senderIsOwner: true }).execute('test', { action: 'status', agent_id: 'example' });
    expect(output.isError).toBe(true);
    expect(output.content[0]!.text).toContain('factory_disabled');
  });

  test('a standalone bundle runs the factory without a machinery checkout', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'expert-plugin-factory-')));
    roots.push(root);
    const bundleRoot = join(root, 'bundle');
    const dist = join(bundleRoot, 'dist');
    await mkdir(dist, { recursive: true });
    for (const [entry, output, target] of [
      ['src/native-plugin.ts', 'plugin.js', 'node'],
      ['scripts/expert-factory.ts', 'factory.js', 'bun'],
    ]) {
      const child = Bun.spawn([process.execPath, 'build', entry!, `--target=${target}`, '--packages=bundle', `--outfile=${join(dist, output!)}`], { stdout: 'pipe', stderr: 'pipe' });
      const [code, , error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, error).toBe(0);
    }
    for (const entry of ['skills', 'package.json', 'openclaw.plugin.json']) {
      await cp(entry, join(bundleRoot, entry), { recursive: true });
    }
    const packager = Bun.spawn([process.execPath, resolve('scripts/package-plugin.ts')], {
      cwd: bundleRoot, stdout: 'pipe', stderr: 'pipe',
    });
    const [packageCode, , packageError] = await Promise.all([
      packager.exited, new Response(packager.stdout).text(), new Response(packager.stderr).text(),
    ]);
    expect(packageCode, packageError).toBe(0);
    const installedRoot = join(bundleRoot, 'dist', 'plugin-package');
    const installedManifest = JSON.parse(await readFile(join(installedRoot, 'openclaw.plugin.json'), 'utf8'));
    expect(installedManifest.skills).toEqual(['./skills']);
    await assertSkillDiscovery(installedRoot);
    // OpenClaw's plugin source scan (2026.9.5) parses every shipped module the entry references and
    // rewrites only these import.meta members; any other use fails `openclaw update` and plugin load.
    const unsupportedImportMeta = /import\.meta(?!\.(?:url|dirname|filename|env|resolve)\b)/;
    for (const file of await readdir(join(installedRoot, 'dist'))) {
      const lines = (await readFile(join(installedRoot, 'dist', file), 'utf8')).split('\n');
      expect(lines.filter((line) => unsupportedImportMeta.test(line)), file).toEqual([]);
    }
    const factoryRoot = join(root, 'private-factory');
    const tokens = join(root, 'private-tokens');
    await mkdir(factoryRoot, { mode: 0o700 });
    await mkdir(tokens, { mode: 0o700 });
    const manager = join(root, 'manager.token');
    await writeFile(manager, 'synthetic-manager-placeholder', { mode: 0o600 });
    const installed = (await import(pathToFileURL(join(installedRoot, 'dist', 'plugin.js')).href)).default;
    let factory: NativeTool | undefined;
    installed.register({ pluginConfig: {
      domainExpert: { enabled: true },
      factory: { enabled: true, rootDir: factoryRoot, tokenDirectory: tokens, managerTokenFile: manager,
        ownerTelegramUserId: 1234, libraryBucket: 'fixture-library', libraryPrefix: 'experts',
        bunBin: process.execPath, openclawBin: '/fixture/openclaw' },
    }, registerTool: (registration: NativeTool | ((context: FactoryToolContext) => NativeTool)) => {
      const tool = typeof registration === 'function' ? registration({ senderIsOwner: true }) : registration;
      if (tool.name === 'expert_factory') factory = tool;
    } });
    const output = await factory!.execute('fixture', { action: 'create', agent_id: 'example',
      display_name: 'Example', purpose: 'A private expertise request', telegram_username: 'ExampleFactoryBot' });
    expect(output.isError).toBeUndefined();
    expect(JSON.parse(output.content[0]!.text)).toMatchObject({ status: 'planned', agent_id: 'example' });
    expect(output.content[0]!.text).not.toContain('private expertise');
    expect(await readdir(factoryRoot)).toEqual([]);
    expect(await readdir(tokens)).toEqual([]);
  }, 30_000);

  test.each([true, false])('factory-created agent retains its own domain with creation enabled=%s', async (enabled) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'expert-plugin-domain-')));
    roots.push(root); await chmod(root, 0o700);
    let runtimeConfig = { plugins: { entries: { 'expert-agents': { config: { domainExpert: { enabled: true, defaultDomainId: 'legacy-domain' } } } } } };
    let ask: NativeTool | undefined;
    const requests: unknown[] = [];
    const previous = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      return Response.json({ policy: { expert_agents_control_plane_only: true, raw_runtime_secrets_exposed: false } });
    }) as unknown as typeof fetch;
    try {
      plugin.register({ pluginConfig: { domainExpert: { enabled: true, defaultDomainId: 'legacy-domain' }, factory: { enabled, rootDir: root } },
        registerTool: (registration) => {
          const tool = typeof registration === 'function' ? registration({ agentId: 'example', workspaceDir: join(root, 'agents', 'example'), getRuntimeConfig: () => runtimeConfig }) : registration;
          if (tool.name === 'domain_ask') ask = tool;
        },
      });
      expect((await ask!.execute('one', { question: 'What is in my library?' })).isError).toBeUndefined();
      expect(requests).toEqual([{ tool: 'domain_ask', params: { question: 'What is in my library?', domain_id: 'example' } }]);
      expect((await ask!.execute('two', { question: 'Other library?', domain_id: 'legacy-domain' })).isError).toBe(true);
      expect(requests).toHaveLength(1);
      // A retained tool must stay bound even when refreshed config omits the
      // factory section (for example after provisioning is retired).
      runtimeConfig = { plugins: { entries: { 'expert-agents': { config: { domainExpert: { enabled: true, defaultDomainId: 'changed-domain' } } } } } };
      expect((await ask!.execute('three', { question: 'Other library?', domain_id: 'changed-domain' })).isError).toBe(true);
      expect(requests).toHaveLength(1);
    } finally { globalThis.fetch = previous; }
  });
});

async function assertSkillDiscovery(root: string): Promise<void> {
  const skillRoot = join(root, 'skills');
  const skillManifest = JSON.parse(await readFile(join(skillRoot, 'manifest.json'), 'utf8'));
  const directories = (await readdir(skillRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  expect(directories).toEqual(skillManifest.skills);
  expect(directories).toEqual([
    'domain-research', 'expert-agent-workshop', 'expert-annas-archive-acquisition', 'soul-workshop',
  ]);
  const names: string[] = [];
  for (const directory of directories) {
    const skill = await readFile(join(skillRoot, directory, 'SKILL.md'), 'utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill)?.[1] ?? '';
    const name = /^name:\s*(\S+)\s*$/m.exec(frontmatter)?.[1];
    expect(name).toBe(directory);
    names.push(name!);
  }
  expect(new Set(names).size).toBe(names.length);
  for (const legacyName of ['agent-workshop', 'annas-archive-acquisition']) {
    expect(names).not.toContain(legacyName);
  }
}
