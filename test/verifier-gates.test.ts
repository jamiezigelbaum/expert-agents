import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bunPath = Bun.which('bun');
const repositoryRoot = join(import.meta.dir, '..');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('package script verifier', () => {
  for (const command of ['true', ':', 'eslint .']) {
    test.skipIf(bunPath === null)(`rejects vacuous lifecycle command ${JSON.stringify(command)}`, async () => {
      const root = await packageFixture(command);
      const result = await runVerifier('scripts/verify-package-scripts.ts', root);

      expect(result.code).toBe(1);
      for (const script of ['typecheck', 'test', 'build']) {
        expect(result.stderr).toContain(`@expert-agents/vacuous: ${script} script must invoke`);
      }
    });
  }

  test.skipIf(bunPath === null)('accepts all four repository packages', async () => {
    const result = await runVerifier('scripts/verify-package-scripts.ts', repositoryRoot);

    expect(result).toEqual({
      code: 0,
      stdout: 'verified required scripts for 4 packages\n',
      stderr: '',
    });
  });
});

describe('built artifact verifier', () => {
  test.skipIf(bunPath === null)('rejects an empty expected root when another root is populated', async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, 'packages'));
    await mkdir(join(root, 'dist/plugin-package'), { recursive: true });
    await mkdir(join(root, 'dist/deploy-package'));
    await writeFile(join(root, 'dist/plugin-package/manifest.json'), '{}\n');
    await writeFile(join(root, 'dist/plugin.js'), 'export {};\n');

    const result = await runVerifier('scripts/verify-built-artifacts.ts', root);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('dist/deploy-package: expected built output is empty');
    expect(result.stderr).not.toContain('dist/plugin-package: expected built output is empty');
  });
});

async function packageFixture(command: string): Promise<string> {
  const root = await temporaryRoot();
  const packageRoot = join(root, 'packages/vacuous');
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: '@expert-agents/vacuous',
    scripts: { typecheck: command, test: command, build: command },
  }, null, 2)}\n`);
  return root;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'expert-agents-verifier-test-'));
  temporaryRoots.push(root);
  return root;
}

async function runVerifier(script: string, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const process = Bun.spawn([bunPath!, join(repositoryRoot, script)], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { code, stdout, stderr };
}
