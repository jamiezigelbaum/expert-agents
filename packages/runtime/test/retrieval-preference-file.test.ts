import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadRetrievalPreferenceFile,
  RETRIEVAL_PREFERENCE_MAX_BYTES,
} from '../src/core/retrieval-preference-file.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'retrieval-profile-test-'));
  directories.push(directory);
  return directory;
}
function profile(multiplier = 1.5) {
  return {
    schema_version: 1,
    corpus: 'projects/fixture-project/locations/fixture-region/ragCorpora/fixture-corpus',
    query_layer: { candidate_top_k: 20, default_mode: 'preferred', multipliers: { selected: multiplier }, max_per_work_default: 2 },
    units: [{ rag_file_id: 'fixture-file', unit_id: 'fixture-unit', source_id: 'fixture-source', work_family: 'fixture-work', kind: 'text', priority: 'selected', title: 'private metadata fixture' }],
    notes: 'private metadata fixture',
  };
}
const staticReadError = 'Configured retrieval preference file could not be read or validated';

async function expectStaticError(path: string) {
  let caught: unknown;
  try { await loadRetrievalPreferenceFile(path); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe(staticReadError);
  expect(String(caught)).not.toContain(path);
  expect(String(caught)).not.toContain('private metadata fixture');
  expect(caught).not.toHaveProperty('cause');
}

describe('bounded operator preference file loading', () => {
  test('returns an exact-byte digest and validated controlling fields without descriptive metadata', async () => {
    const path = join(await workspace(), 'policy.json');
    const bytes = Buffer.from(`${JSON.stringify(profile(), null, 2)}\n`);
    await writeFile(path, bytes);
    const result = await loadRetrievalPreferenceFile(path);
    expect(result.bytes).toBe(bytes.length);
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(result.profile.query_layer.multipliers.selected).toBe(1.5);
    expect(result.profile).not.toHaveProperty('notes');
    expect(result.profile.units[0]).not.toHaveProperty('title');
    expect(JSON.stringify(result)).not.toContain('private metadata fixture');
  });

  test('reports malformed JSON, invalid schema, and invalid UTF-8 through the same static error', async () => {
    const path = join(await workspace(), 'policy.json');
    for (const bytes of [Buffer.from('{"private metadata fixture":'), Buffer.from(JSON.stringify({ ...profile(), schema_version: 7 })), Buffer.from([0xff, 0xfe, 0x7b])]) {
      await writeFile(path, bytes);
      await expectStaticError(path);
    }
  });

  test('reports missing paths and directories without exposing filesystem details', async () => {
    const directory = await workspace();
    await expectStaticError(join(directory, 'private-missing-profile.json'));
    await expectStaticError(directory);
    await expect(loadRetrievalPreferenceFile('private-relative-profile.json')).rejects.toThrow('Configured retrieval preference file is invalid');
  });

  test('accepts exactly the byte cap and refuses a larger file', async () => {
    const path = join(await workspace(), 'policy.json');
    const document = Buffer.from(JSON.stringify(profile()));
    const bytes = Buffer.alloc(RETRIEVAL_PREFERENCE_MAX_BYTES, ' ');
    document.copy(bytes);
    await writeFile(path, bytes);
    const loaded = await loadRetrievalPreferenceFile(path);
    expect(loaded.bytes).toBe(RETRIEVAL_PREFERENCE_MAX_BYTES);
    await writeFile(path, Buffer.concat([bytes, Buffer.from(' ')]));
    await expectStaticError(path);
  });

  test('observes fresh atomic replacement without mutating an earlier loaded profile', async () => {
    const directory = await workspace();
    const path = join(directory, 'policy.json');
    const replacement = join(directory, 'policy.next.json');
    await writeFile(path, JSON.stringify(profile(1.3)));
    const first = await loadRetrievalPreferenceFile(path);
    await writeFile(replacement, JSON.stringify(profile(1.7)));
    await rename(replacement, path);
    const second = await loadRetrievalPreferenceFile(path);
    expect(first.profile.query_layer.multipliers.selected).toBe(1.3);
    expect(second.profile.query_layer.multipliers.selected).toBe(1.7);
    expect(second.sha256).not.toBe(first.sha256);
  });
});
