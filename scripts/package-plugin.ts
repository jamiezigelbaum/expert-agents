import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const root = 'dist/plugin-package';
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
for (const file of ['openclaw.plugin.json', 'package.json']) await cp(file, join(root, file));
await cp('dist/plugin.js', join(root, 'dist/plugin.js'));
await cp('dist/factory.js', join(root, 'dist/factory.js'));
await cp('skills', join(root, 'skills'), { recursive: true });

const files = await walk(root);
console.log(`staged expert-agents plugin package with ${files.length} files; install with: openclaw plugins install <path-to-dist/plugin-package> --force --accept-capabilities`);

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
