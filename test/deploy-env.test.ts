import { describe, expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const repositoryRoot = join(import.meta.dir, '..');
const workerSourceRoot = join(repositoryRoot, 'packages/runtime/src');
const envExamplePath = join(repositoryRoot, 'deploy/systemd/domain-expert.env.example');
const environmentIdentifier = /EXPERT_AGENTS_[A-Z0-9_]+/g;

describe('domain expert deploy environment', () => {
  test('documents every environment variable referenced by the worker', async () => {
    const source = (await Promise.all((await walk(workerSourceRoot)).map((path) => readFile(path, 'utf8')))).join('\n');
    const referenced = [...new Set(source.match(environmentIdentifier) ?? [])].sort();
    const envExample = await readFile(envExamplePath, 'utf8');
    const documented = new Set(envExample.match(environmentIdentifier) ?? []);
    const missing = referenced.filter((identifier) => !documented.has(identifier));

    expect(referenced.length).toBeGreaterThan(0);
    expect(missing, `missing from ${envExamplePath}: ${missing.join(', ')}`).toEqual([]);
  });
});

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
