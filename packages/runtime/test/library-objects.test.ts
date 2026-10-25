import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibraryObjectExistsError, LibraryReadError, LocalLibraryObjects } from '../src/workers/domain-expert/library-objects.ts';

// Library objects kept on the worker's own disk: the same bucket-and-name
// addressing as Cloud Storage, so stored gs:// references keep resolving.

let root: string;
let store: LocalLibraryObjects;
const bytes = (text: string) => new TextEncoder().encode(text);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'library-objects-'));
  store = new LocalLibraryObjects(root);
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('local library objects', () => {
  test('an object written under a bucket reads back whole, by head, and as text', async () => {
    await store.uploadGcsObject('neutral-library', 'v2/books/charter.txt', bytes('The charter of the assembly.'));
    expect(await readFile(join(root, 'neutral-library', 'v2', 'books', 'charter.txt'), 'utf8')).toBe('The charter of the assembly.');
    expect(new TextDecoder().decode((await store.downloadGcsObject('neutral-library', 'v2/books/charter.txt'))!)).toBe('The charter of the assembly.');
    expect(new TextDecoder().decode((await store.readGcsObjectHead('neutral-library', 'v2/books/charter.txt', 3))!)).toBe('The');
    expect(await store.downloadGcsText('neutral-library', 'v2/books/charter.txt', 1_000, 1_000)).toBe('The charter of the assembly.');
  });

  test('a missing object is null, not an error', async () => {
    expect(await store.downloadGcsObject('neutral-library', 'v2/none.pdf')).toBeNull();
    expect(await store.downloadLibraryObject('neutral-library', 'v2/none.pdf', 10, 1_000)).toBeNull();
    expect(await store.readGcsObjectHead('neutral-library', 'v2/none.pdf', 4)).toBeNull();
    expect(await store.getGcsObjectMetadata('neutral-library', 'v2/none.pdf')).toBeNull();
    expect(await store.downloadGcsText('other-library', 'v2/none.txt', 10, 1_000)).toBeNull();
  });

  test('metadata carries the size and an MD5 that matches the bytes, as GCS reports it', async () => {
    const content = bytes('minutes of the council');
    await store.uploadGcsObject('neutral-library', 'v2/minutes.txt', content);
    const meta = await store.getGcsObjectMetadata('neutral-library', 'v2/minutes.txt');
    expect(meta).toMatchObject({ size: String(content.byteLength), md5Hash: createHash('md5').update(content).digest('base64') });
    expect(meta!.generation).toMatch(/^\d+$/);
  });

  test('a create-only write never overwrites an existing object', async () => {
    await store.uploadGcsObject('neutral-library', 'v2/originals/a.pdf', bytes('first'), { ifGenerationMatch: '0' });
    const second = store.uploadGcsObject('neutral-library', 'v2/originals/a.pdf', bytes('second'), { ifGenerationMatch: '0' });
    await expect(second).rejects.toBeInstanceOf(LibraryObjectExistsError);
    await expect(second).rejects.toMatchObject({ status: 412 });
    expect(await readFile(join(root, 'neutral-library', 'v2', 'originals', 'a.pdf'), 'utf8')).toBe('first');
    // No temporary file is left beside it.
    expect(await readdir(join(root, 'neutral-library', 'v2', 'originals'))).toEqual(['a.pdf']);
  });

  test('a plain write replaces the object', async () => {
    await store.uploadGcsObject('neutral-library', 'v2/ledger.json', bytes('{"v":1}'));
    await store.uploadGcsObject('neutral-library', 'v2/ledger.json', bytes('{"v":2}'));
    expect(await store.downloadGcsText('neutral-library', 'v2/ledger.json', 100, 1_000)).toBe('{"v":2}');
  });

  test('listing matches a prefix the way Cloud Storage does, even mid-name', async () => {
    await store.uploadGcsObject('list-library', 'shelf/books/a-one.txt', bytes('1'));
    await store.uploadGcsObject('list-library', 'shelf/books/a-two.txt', bytes('2'));
    await store.uploadGcsObject('list-library', 'shelf/books/b-three.txt', bytes('3'));
    await store.uploadGcsObject('list-library', 'shelf/deep/x/y.txt', bytes('4'));
    expect(await store.listLibraryObjectNames('list-library', 'shelf/books/a-', 1_000)).toEqual(['shelf/books/a-one.txt', 'shelf/books/a-two.txt']);
    expect(await store.listLibraryObjectNames('list-library', 'shelf/', 1_000)).toEqual(['shelf/books/a-one.txt', 'shelf/books/a-two.txt', 'shelf/books/b-three.txt', 'shelf/deep/x/y.txt']);
    expect(await store.listLibraryObjectNames('list-library', 'shel', 1_000)).toHaveLength(4);
    expect(await store.listLibraryObjectNames('list-library', 'absent/', 1_000)).toEqual([]);
  });

  test('a reading over the size limit is refused with the reader\'s error', async () => {
    await store.uploadGcsObject('neutral-library', 'v2/big.txt', bytes('x'.repeat(64)));
    await expect(store.downloadLibraryObject('neutral-library', 'v2/big.txt', 10, 1_000)).rejects.toBeInstanceOf(LibraryReadError);
    await expect(store.downloadLibraryObject('neutral-library', 'v2/big.txt', 10, 1_000)).rejects.toMatchObject({ code: 'library_source_too_large', status: 413 });
    await expect(store.downloadGcsText('neutral-library', 'v2/big.txt', 10, 1_000)).rejects.toThrow('completion read limit');
  });

  test('names that would leave the root are refused', async () => {
    for (const name of ['../escape.txt', 'v2/../../escape.txt', '/abs.txt', 'v2//double.txt', 'v2/./dot.txt', '']) {
      await expect(store.uploadGcsObject('neutral-library', name, bytes('x'))).rejects.toThrow('Not a library object name');
      await expect(store.downloadGcsObject('neutral-library', name)).rejects.toThrow('Not a library object name');
    }
    for (const bucket of ['..', 'UPPER', 'a/b', '']) {
      await expect(store.downloadGcsObject(bucket, 'v2/a.txt')).rejects.toThrow('Not a library bucket name');
    }
    expect(await readdir(root)).not.toContain('escape.txt');
  });
});
