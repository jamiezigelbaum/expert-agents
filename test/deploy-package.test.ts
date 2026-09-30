import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageDeploy, type DeployReceipt } from '../scripts/package-deploy.ts';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('deploy package', () => {
  test('contains only expected files with a deterministic verified receipt', async () => {
    const repositoryRoot = await createFixture();
    const outputRoot = join(repositoryRoot, 'dist/deploy-package');
    const expectedPayloadPaths = [
      'deploy/README.md',
      'deploy/systemd/domain-expert.env.example',
      'deploy/systemd/expert-agents-domain-expert.service',
      'packages/runtime/dist/server.js',
    ];

    await packageDeploy({ repositoryRoot });
    const firstReceiptText = await readFile(join(outputRoot, 'DEPLOY_RECEIPT.json'), 'utf8');
    const receipt = JSON.parse(firstReceiptText) as DeployReceipt;

    expect(await walkRelative(outputRoot)).toEqual(['DEPLOY_RECEIPT.json', ...expectedPayloadPaths]);
    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.files.map((file) => file.path)).toEqual(expectedPayloadPaths);
    expect(firstReceiptText).not.toContain('synthetic-worker-payload');

    for (const file of receipt.files) {
      const bytes = await readFile(join(outputRoot, file.path));
      expect(file.bytes).toBe(bytes.byteLength);
      expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    }

    await packageDeploy({ repositoryRoot });
    expect(await readFile(join(outputRoot, 'DEPLOY_RECEIPT.json'), 'utf8')).toBe(firstReceiptText);

    await rm(join(repositoryRoot, 'packages/runtime/src'), { recursive: true, force: true });
    await rm(join(repositoryRoot, 'packages/library'), { recursive: true, force: true });
    const packagedWorker = await import(`${pathToFileURL(join(outputRoot, 'packages/runtime/dist/server.js')).href}?smoke=1`);
    expect(packagedWorker.fixtureMarker).toBe('workspace-library-bundled');
  }, 30_000);
});

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'expert-agents-deploy-package-test-'));
  temporaryRoots.push(root);
  await mkdir(join(root, 'packages/runtime/src/workers/domain-expert'), { recursive: true });
  await mkdir(join(root, 'packages/library/src'), { recursive: true });
  await mkdir(join(root, 'node_modules/@expert-agents'), { recursive: true });
  await mkdir(join(root, 'deploy/systemd'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"private":true,"workspaces":["packages/*"]}\n');
  await writeFile(
    join(root, 'packages/runtime/src/workers/domain-expert/server.ts'),
    "export { fixtureMarker } from '@expert-agents/library';\n",
  );
  await writeFile(
    join(root, 'packages/library/package.json'),
    '{"name":"@expert-agents/library","type":"module","exports":"./src/index.ts"}\n',
  );
  await writeFile(join(root, 'packages/library/src/index.ts'), "export const fixtureMarker = 'workspace-library-bundled';\n");
  await symlink(join(root, 'packages/library'), join(root, 'node_modules/@expert-agents/library'), 'dir');
  await writeFile(join(root, 'deploy/README.md'), 'synthetic runbook\n');
  await writeFile(join(root, 'deploy/systemd/domain-expert.env.example'), '# SYNTHETIC=value\n');
  await writeFile(join(root, 'deploy/systemd/expert-agents-domain-expert.service'), '[Service]\nType=simple\n');
  return root;
}

async function walkRelative(root: string): Promise<string[]> {
  const files = await walk(root);
  return files.map((path) => relative(root, path).split(sep).join('/')).sort();
}

async function walk(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await walk(child));
    else files.push(child);
  }
  return files.sort();
}
