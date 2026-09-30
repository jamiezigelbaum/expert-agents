import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

export interface DeployReceiptFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface DeployReceipt {
  schemaVersion: 1;
  files: DeployReceiptFile[];
}

export interface PackageDeployOptions {
  repositoryRoot?: string;
  outputRoot?: string;
}

export async function packageDeploy(options: PackageDeployOptions = {}): Promise<DeployReceipt> {
  const repositoryRoot = resolve(options.repositoryRoot ?? join(import.meta.dir, '..'));
  const outputRoot = resolve(options.outputRoot ?? join(repositoryRoot, 'dist/deploy-package'));
  const workerRelativePath = 'packages/runtime/dist/server.js';
  const workerOutputPath = join(outputRoot, workerRelativePath);

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(dirname(workerOutputPath), { recursive: true });
  await buildWorkerBundle(repositoryRoot, workerOutputPath);
  await cp(join(repositoryRoot, 'deploy'), join(outputRoot, 'deploy'), { recursive: true });

  const files = await walk(outputRoot);
  const receipts: DeployReceiptFile[] = [];
  for (const path of files) {
    const bytes = await readFile(path);
    receipts.push({
      path: portableRelativePath(outputRoot, path),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength,
    });
  }

  const receipt: DeployReceipt = { schemaVersion: 1, files: receipts };
  await writeFile(join(outputRoot, 'DEPLOY_RECEIPT.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

async function buildWorkerBundle(repositoryRoot: string, outputPath: string): Promise<void> {
  const entrypoint = join(repositoryRoot, 'packages/runtime/src/workers/domain-expert/server.ts');
  const buildProcess = Bun.spawn([
    process.execPath,
    'build',
    entrypoint,
    '--target=bun',
    '--packages=bundle',
    '--reject-unresolved',
    `--outfile=${outputPath}`,
  ], {
    cwd: repositoryRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    buildProcess.exited,
    new Response(buildProcess.stdout).text(),
    new Response(buildProcess.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`failed to build self-contained deploy worker:\n${stderr || stdout}`);
  }
}

if (import.meta.main) {
  const receipt = await packageDeploy();
  console.log(`packaged expert-agents deployment with ${receipt.files.length} files`);
}

async function walk(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await walk(child));
    else if (entry.name !== 'DEPLOY_RECEIPT.json') files.push(child);
  }
  return files.sort();
}

function portableRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}
