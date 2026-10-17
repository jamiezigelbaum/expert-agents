import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDomainExpertWorker } from '../packages/runtime/src/workers/domain-expert/index.ts';

// The worker answers the factory's workspace calls with the fields the factory reads: the root id
// in the registration manifest, that root's allow_overwrite in health, and the seed status.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function worker(allowOverwrite: boolean) {
  const base = await mkdtemp(join(tmpdir(), 'factory-worker-contract-')); roots.push(base);
  const instance = createDomainExpertWorker({
    dataDir: join(base, 'data'), gcpProject: 'neutral-project',
    roots: [{ rootId: 'expert_agents_workspace', path: base, maxWriteBytes: 1_000_000, allowOverwrite }],
    registrationLibrary: { bucket: 'neutral-library', prefix: 'experts' },
    google: { accessToken: 'synthetic-token', fetchImpl: (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/ragCorpora')) return Response.json({ ragCorpora: [] });
      throw new Error('unexpected upstream request');
    }) as typeof fetch },
  });
  const call = async (params: Record<string, unknown>) => (await (await instance.fetch(new Request('http://worker.test/v1/domain', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'domain_agent', params: { domain_id: 'example', ...params } }),
  }))).json()) as Record<string, any>;
  const health = async () => (await (await instance.fetch(new Request('http://worker.test/v1/health'))).json()) as Record<string, any>;
  const register = (dryRun: boolean) => call({ action: 'register', library: { bucket: 'neutral-library', prefix: 'experts/example' },
    target_corpus_display_name: 'expert-example', approval_id: 'factory-operation-1', dry_run: dryRun });
  return { base, call, health, register };
}

describe('factory workspace contract with the worker', () => {
  test('the registration manifest names a root whose overwrite setting health reports', async () => {
    for (const allowOverwrite of [false, true]) {
      const w = await worker(allowOverwrite);
      const rootId = (await w.register(true)).manifest.workspace_root_id;
      expect((await w.health()).roots.find((root: Record<string, unknown>) => root.root_id === rootId)).toMatchObject({ allow_overwrite: allowOverwrite });
    }
  });

  test('on a root without overwrite, bootstrap restores a missing seed file and keeps the owner\'s files', async () => {
    const w = await worker(false);
    expect((await w.register(false)).status).toBe('registered');
    const status = async () => (await w.call({ action: 'status' })).workspace as { exists: boolean; missing_requirements: unknown[] };
    expect((await status()).exists).toBe(false);
    expect((await w.call({ action: 'bootstrap', dry_run: false })).status).toBe('workspace_bootstrapped');
    expect(await status()).toMatchObject({ exists: true, missing_requirements: [] });
    // The owner records a source and deletes one template; the worker now recommends bootstrap.
    const registry = join(w.base, 'experts', 'example', 'references', 'source-registry.jsonl');
    const owned = '{"source_id":"owner-source"}\n';
    await writeFile(registry, owned);
    await unlink(join(w.base, 'experts', 'example', 'templates', 'source-card.md'));
    expect((await status()).missing_requirements).toHaveLength(1);
    expect((await w.call({ action: 'bootstrap', dry_run: false })).status).toBe('workspace_bootstrapped');
    expect(await status()).toMatchObject({ exists: true, missing_requirements: [] });
    expect(await readFile(registry, 'utf8')).toBe(owned);
  });

  test('negative control: on a root that allows overwrite, the same bootstrap empties the source registry, which is why the factory refuses it', async () => {
    const w = await worker(true);
    await w.register(false);
    await w.call({ action: 'bootstrap', dry_run: false });
    const registry = join(w.base, 'experts', 'example', 'references', 'source-registry.jsonl');
    await writeFile(registry, '{"source_id":"owner-source"}\n');
    await w.call({ action: 'bootstrap', dry_run: false });
    expect(await readFile(registry, 'utf8')).toBe('');
  });
});
