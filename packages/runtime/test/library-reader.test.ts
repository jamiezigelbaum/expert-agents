import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalObjectRelativePath, finalizeMasterManifest, serializeMasterManifest, serializeScopeManifest,
  type LibraryObject, type Sha256Id,
} from '@expert-agents/library';
import { validateAgentRoutingConfig } from '../src/core/agent-routing.ts';
import { domainManifest } from '../src/core/domain-expert.ts';
import { createDomainExpertWorker } from '../src/workers/domain-expert/index.ts';
import { LibraryReader, parseLibraryReadParams, LIBRARY_READ_MAX_BYTES } from '../src/workers/domain-expert/library-reader.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(text = '# Sample Book\nBody\n\n# References\n' + 'Example Author. A Reference Work.\n'.repeat(1000) + '\n# Index\nIndex text', mediaType = 'text/markdown') {
  const directory = mkdtempSync(join(tmpdir(), 'library-read-test-'));
  directories.push(directory);
  const bytes = Buffer.from(text);
  const id = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as Sha256Id;
  const object: LibraryObject = {
    id, title: 'Sample Book', creator: 'Example Writer', mediaType, derivativeKind: null, byteSize: bytes.length,
    relativePath: canonicalObjectRelativePath(id, mediaType), sourceLocators: ['https://example.invalid/source'],
    provenance: { acquiredBy: 'fixture', acquiredAt: '2026-01-01T00:00:00.000Z', acquisitionMethod: 'fixture' },
    trustTier: 'reviewed', copyrightPosture: 'public-domain', lineage: { supersedes: [], supersededBy: [] },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const scopePath = join(directory, 'scope.json');
  const scope = { agentId: 'research', schemaVersion: 1 as const, selection: { objectIds: [id] }, targetCorpusDisplayName: 'research-library', masterRevision: 1 };
  const updateScope = (objectIds: Sha256Id[]) => writeFileSync(scopePath, serializeScopeManifest({ ...scope, selection: { objectIds } }));
  updateScope([id]);
  const master = () => serializeMasterManifest(finalizeMasterManifest({ schemaVersion: 1, revision: 1, ingestionCursor: null, objects: [object], tombstones: [] }));
  const stored = new Map<string, Uint8Array>([
    ['library/manifest/master.json', Buffer.from(master())], ['library/' + object.relativePath, bytes],
  ]);
  const route = { library: { bucket: 'fixture-bucket', prefix: 'library' }, targetCorpusDisplayName: 'research-library', scopeManifestPath: scopePath };
  const downloads: string[] = [];
  const reader = new LibraryReader({ download: async (bucket, name) => { expect(bucket).toBe('fixture-bucket'); downloads.push(name); return stored.get(name) ?? null; } });
  return { reader, route, object, bytes, id, text, stored, downloads, updateScope, scope, scopePath, directory, master };
}

describe('direct library reading', () => {
  test('explicit prior source roots remain read-only and domain-specific', async () => {
    const f = fixture();
    const routes = validateAgentRoutingConfig({ research: { ...f.route, readOnlySourceRoots: [{ bucket: 'prior-library', prefix: 'staged/research' }] } });
    expect(domainManifest('research', undefined, { agentRouting: routes, env: { EXPERT_AGENTS_GCP_PROJECT: 'fixture-project' } }).allowed_gcs_prefixes).toEqual(['gs://fixture-bucket/library']);
    const calls: string[] = [];
    const reader = new LibraryReader({ download: async (bucket, name) => {
      calls.push(`${bucket}/${name}`);
      return bucket === 'fixture-bucket' ? f.stored.get(name) ?? null : Buffer.from('Prior source text.');
    } });
    const params = { action: 'read' as const, rag_file_name: 'projects/fixture/locations/us-central1/ragCorpora/1/ragFiles/2' };
    const resolver = async () => ({ uri: 'gs://prior-library/staged/research/source.md' });
    expect(await reader.run(routes.research!, params, resolver)).toMatchObject({ text: 'Prior source text.' });
    expect(calls).toContain('prior-library/staged/research/source.md');
    calls.length = 0;
    await expect(reader.run(f.route, params, resolver)).rejects.toMatchObject({ code: 'library_source_not_available' });
    expect(calls).toEqual(['fixture-bucket/library/manifest/master.json']);
    for (const roots of [[], [{ bucket: 'prior-library', prefix: '' }], [{ bucket: 'prior-library', prefix: '../private' }], Array(17).fill({ bucket: 'prior-library', prefix: 'staged/research' })]) {
      expect(() => validateAgentRoutingConfig({ research: { ...f.route, readOnlySourceRoots: roots } })).toThrow();
    }
  });
  test('reads existing legacy imports with fresh membership checks and pinned continuation', async () => {
    const f = fixture();
    const text = '# References\n' + 'An older reference entry.\n'.repeat(1000);
    f.stored.set('library/book-imports/research/old.md', Buffer.from(text));
    const name = 'projects/fixture-project/locations/us-central1/ragCorpora/10/ragFiles/20';
    let calls = 0;
    const resolve = async () => { calls++; return { uri: 'gs://fixture-bucket/library/book-imports/research/old.md', title: 'Older Book' }; };
    const first = await f.reader.run(f.route, { action: 'read', rag_file_name: name, limit: 24000 }, resolve) as any;
    const second = await f.reader.run(f.route, { action: 'read', rag_file_name: name, offset: first.next_offset, text_revision: first.text_revision }, resolve) as any;
    expect(first.text + second.text).toBe(text);
    expect(calls).toBe(2);
    expect(first.rag_file_name).toBe(name);
    expect(first).not.toHaveProperty('object_id');
    expect(second.complete).toBeTrue();
    f.stored.set('library/book-imports/research/old.md', Buffer.from(text + 'changed'));
    await expect(f.reader.run(f.route, { action: 'read', rag_file_name: name, offset: first.next_offset, text_revision: first.text_revision }, resolve)).rejects.toMatchObject({ code: 'library_text_revision_changed' });
  });

  test('legacy references cannot escape the root or bypass canonical selection and tombstones', async () => {
    const f = fixture();
    const params = { action: 'read' as const, rag_file_name: 'projects/fixture/locations/us-central1/ragCorpora/1/ragFiles/2' };
    const resolve = (uri: string) => async () => ({ uri });
    await expect(f.reader.run(f.route, params, resolve('gs://other-bucket/library/private.txt'))).rejects.toMatchObject({ code: 'library_source_not_available' });
    await expect(f.reader.run(f.route, params, resolve('gs://fixture-bucket/library-other/private.txt'))).rejects.toMatchObject({ code: 'library_source_not_available' });
    f.updateScope([]);
    await expect(f.reader.run(f.route, params, resolve(`gs://fixture-bucket/library/${f.object.relativePath}`))).rejects.toMatchObject({ code: 'library_source_not_available' });
    expect(f.downloads.every(name => name.endsWith('master.json'))).toBeTrue();
    f.stored.set('library/staged/alias.md', f.bytes);
    await expect(f.reader.run(f.route, params, resolve('gs://fixture-bucket/library/staged/alias.md'))).rejects.toMatchObject({ code: 'library_source_not_available' });
    f.stored.set('library/manifest/master.json', Buffer.from(serializeMasterManifest(finalizeMasterManifest({
      schemaVersion: 1, revision: 2, ingestionCursor: null, objects: [], tombstones: [{ objectId: f.id, revision: 2, reason: 'removed' }],
    }))));
    await expect(f.reader.run(f.route, params, resolve('gs://fixture-bucket/library/staged/alias.md'))).rejects.toMatchObject({ code: 'library_source_not_available' });
    await expect(f.reader.run({ ...f.route, disclosure: {} }, params, async () => { throw new Error('Must not resolve'); })).rejects.toMatchObject({ code: 'library_read_disclosure_restricted' });
  });
  test('catalog identifies exact objects; sequential reads cover a full reference section and whole book', async () => {
    const f = fixture();
    const catalog = await f.reader.run(f.route, { action: 'catalog', query: 'sample' });
    expect(catalog).toMatchObject({ total_objects: 1, objects: [{ object_id: f.id, title: 'Sample Book' }] });
    expect(f.downloads).toEqual(['library/manifest/master.json']);
    const opened = await f.reader.run(f.route, { action: 'open', object_id: f.id }) as any;
    const section = opened.sections.find((s: any) => s.title === 'References');
    let joined = '';
    let offset = section.start;
    do {
      const page = await f.reader.run(f.route, { action: 'read', object_id: f.id, text_revision: opened.text_revision, section: section.index, offset, limit: 5000 }) as any;
      expect(page.range.start).toBe(offset);
      joined += page.text;
      offset = page.next_offset;
      expect(page.complete).toBe(offset === null);
    } while (offset !== null);
    expect(joined).toBe(f.text.slice(section.start, section.end));
    expect(joined).not.toContain('Index text');
    joined = ''; offset = 0;
    do {
      const page = await f.reader.run(f.route, { action: 'read', object_id: f.id, text_revision: opened.text_revision, offset, limit: 24000 }) as any;
      joined += page.text; offset = page.next_offset;
    } while (offset !== null);
    expect(joined).toBe(f.text);
    expect(opened.extraction.original_completeness).toBe('unverified');
  });

  test('scope revocation applies to the next page, before source bytes are read', async () => {
    const f = fixture();
    const first = await f.reader.run(f.route, { action: 'read', object_id: f.id, limit: 100 }) as any;
    f.updateScope([]);
    f.downloads.length = 0;
    await expect(f.reader.run(f.route, { action: 'read', object_id: f.id, offset: first.next_offset, text_revision: first.text_revision })).rejects.toMatchObject({ code: 'library_source_not_available' });
    expect(f.downloads).toEqual(['library/manifest/master.json']);
  });

  test('all actions refuse disclosure-bounded routes before cloud access', async () => {
    const f = fixture();
    for (const action of ['catalog', 'open', 'find', 'read'] as const) {
      await expect(f.reader.run({ ...f.route, disclosure: {} }, { action, object_id: f.id, query: 'References' })).rejects.toMatchObject({ code: 'library_read_disclosure_restricted' });
    }
    expect(f.downloads).toEqual([]);
  });

  test('refuses a foreign object, scope mismatch, and missing scope', async () => {
    const f = fixture();
    await expect(f.reader.run(f.route, { action: 'read', object_id: 'sha256:' + 'b'.repeat(64) })).rejects.toMatchObject({ code: 'library_source_not_available' });
    await expect(f.reader.run({ ...f.route, targetCorpusDisplayName: 'other-library' }, { action: 'read', object_id: f.id })).rejects.toMatchObject({ code: 'library_read_scope_mismatch' });
    await expect(f.reader.run({ ...f.route, scopeManifestPath: undefined }, { action: 'read', object_id: f.id })).rejects.toMatchObject({ code: 'library_read_not_configured' });
    expect(f.downloads).toEqual(['library/manifest/master.json']);
  });

  test('rejects modified bytes and changed text revisions with content-free errors', async () => {
    const f = fixture();
    await expect(f.reader.run(f.route, { action: 'read', object_id: f.id, text_revision: '0'.repeat(64) })).rejects.toMatchObject({ code: 'library_text_revision_changed' });
    f.stored.set('library/' + f.object.relativePath, Buffer.from('private modified source'));
    await expect(f.reader.run(f.route, { action: 'read', object_id: f.id })).rejects.toMatchObject({ code: 'library_source_integrity_failed' });
    f.stored.set('library/manifest/master.json', Buffer.from('secret malformed manifest'));
    await expect(f.reader.run(f.route, { action: 'catalog' })).rejects.toMatchObject({ code: 'library_read_unavailable', message: 'The source or library state could not be read or validated.' });
  });

  test('PDF coverage reports blank pages and physical page locators without claiming OCR', async () => {
    const f = fixture('%PDF fixture', 'application/pdf');
    const reader = new LibraryReader({ download: async (_bucket, name) => f.stored.get(name) ?? null,
      extractPdf: async () => 'Title\n\f\fReferences\nExample Writer. Work.\n\f' });
    const page = await reader.run(f.route, { action: 'read', object_id: f.id }) as any;
    expect(page.extraction).toMatchObject({ method: 'pdf_text_layer', page_count: 3, pages_without_text: 1, physical_page_start: 1, physical_page_end: 3, original_completeness: 'unverified' });
    const empty = new LibraryReader({ download: async (_bucket, name) => f.stored.get(name) ?? null, extractPdf: async () => '\f\f' });
    await expect(empty.run(f.route, { action: 'open', object_id: f.id })).rejects.toMatchObject({ code: 'library_source_text_unavailable' });
  });

  test('HTML is read as extracted text and malformed UTF-8 is refused', async () => {
    const f = fixture('<h1>References</h1><p>Example reference</p>', 'text/html');
    const page = await f.reader.run(f.route, { action: 'read', object_id: f.id }) as any;
    expect(page.text).toContain('Example reference');
    expect(page.text).not.toContain('<h1>');
    expect(page.extraction.method).toBe('html_to_markdown');
    const invalidBytes = new Uint8Array([0xc3, 0x28]);
    const invalidId = `sha256:${createHash('sha256').update(invalidBytes).digest('hex')}` as Sha256Id;
    f.object.id = invalidId; f.object.mediaType = 'text/plain'; f.object.byteSize = 2;
    f.object.relativePath = canonicalObjectRelativePath(invalidId, 'text/plain');
    f.updateScope([invalidId]);
    f.stored.set('library/manifest/master.json', Buffer.from(f.master()));
    f.stored.set('library/' + f.object.relativePath, invalidBytes);
    await expect(f.reader.run(f.route, { action: 'read', object_id: invalidId })).rejects.toMatchObject({ code: 'library_read_unavailable' });
  });

  test('tombstoned sources are not read even if still selected and physically present', async () => {
    const f = fixture();
    f.stored.set('library/manifest/master.json', Buffer.from(serializeMasterManifest(finalizeMasterManifest({
      schemaVersion: 1, revision: 2, ingestionCursor: null, objects: [], tombstones: [{ objectId: f.id, revision: 2, reason: 'removed' }],
    }))));
    await expect(f.reader.run(f.route, { action: 'read', object_id: f.id })).rejects.toMatchObject({ code: 'library_source_not_available' });
    expect(f.downloads).toEqual(['library/manifest/master.json']);
  });

  test('a bounded concurrency slot is released after failed reads', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reader = new LibraryReader({ download: async () => { await gate; throw new Error('private provider failure'); } });
    const first = reader.run(f.route, { action: 'catalog' }).catch(error => error);
    const second = reader.run(f.route, { action: 'catalog' }).catch(error => error);
    await expect(reader.run(f.route, { action: 'catalog' })).rejects.toMatchObject({ code: 'library_read_busy' });
    release();
    expect((await first).code).toBe('library_read_unavailable');
    expect((await second).code).toBe('library_read_unavailable');
    await expect(reader.run(f.route, { action: 'catalog' })).rejects.toMatchObject({ code: 'library_read_unavailable' });
  });

  test('unsupported media and large declared sources fail before a source download', async () => {
    const f = fixture('raw', 'application/octet-stream');
    await expect(f.reader.run(f.route, { action: 'read', object_id: f.id })).rejects.toMatchObject({ code: 'library_source_format_unsupported' });
    f.object.byteSize = LIBRARY_READ_MAX_BYTES + 1;
    f.stored.set('library/manifest/master.json', Buffer.from(f.master()));
    await expect(f.reader.run(f.route, { action: 'read', object_id: f.id })).rejects.toMatchObject({ code: 'library_source_too_large' });
    expect(f.downloads.every(name => name.endsWith('master.json'))).toBeTrue();
  });

  test('wire contract rejects arbitrary paths, malformed ranges, and unpinned continuations', () => {
    const id = 'sha256:' + 'a'.repeat(64);
    for (const params of [
      { action: 'read', object_id: '/tmp/source' }, { action: 'read', object_id: id, url: 'gs://other/source' },
      { action: 'read', object_id: id, offset: 1 }, { action: 'read', object_id: id, section: 0 },
      { action: 'read', object_id: id, limit: NaN }, { action: 'read', object_id: id, query: '' },
      { action: 'read', object_id: id, section: 0, end: 20, text_revision: 'a'.repeat(64) },
      { action: 'open', object_id: id, section: 0, text_revision: 'a'.repeat(64) },
    ]) expect(() => parseLibraryReadParams(params)).toThrow();
  });
});

describe('domain_read HTTP surface', () => {
  test('cold reads prove numeric project aliases through the configured project without trusting caller aliases', async () => {
    const f = fixture();
    const corpus = 'projects/fixture-project/locations/us-central1/ragCorpora/10';
    const numericName = 'projects/123456789/locations/us-central1/ragCorpora/10/ragFiles/20';
    let sourceReads = 0;
    let returnedName = numericName;
    const requests: string[] = [];
    const worker = createDomainExpertWorker({ gcpProject: 'fixture-project', dataDir: join(f.directory, 'runtime'),
      agentRouting: validateAgentRoutingConfig({ research: f.route }),
      google: { accessToken: 'fixture-token', fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input); requests.push(url);
        if (url.includes('/ragFiles/')) {
          expect(url).toBe('https://us-central1-aiplatform.googleapis.com/v1/' + corpus + '/ragFiles/20');
          return Response.json({ name: returnedName, gcsSource: { uris: ['gs://fixture-bucket/library/staged/research/older.md'] } });
        }
        if (url.includes('/ragCorpora')) return Response.json({ ragCorpora: [{ name: corpus, displayName: 'research-library' }] });
        const objectName = decodeURIComponent(new URL(url).pathname.split('/o/')[1]!);
        if (objectName.endsWith('master.json')) return new Response(new Uint8Array(f.stored.get(objectName)!));
        sourceReads++; return new Response('Verified legacy text.');
      }) as typeof fetch } });
    const request = (name = numericName) => worker.fetch(new Request('http://worker/v1/domain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'domain_read', params: { domain_id: 'research', action: 'read', rag_file_name: name } }) }));
    expect(await (await request()).json()).toMatchObject({ text: 'Verified legacy text.' });
    expect(await (await request(corpus + '/ragFiles/20')).json()).toMatchObject({ text: 'Verified legacy text.' });
    expect((await request(numericName.replace('123456789', '999999999'))).status).toBe(404);
    returnedName = numericName.replace('/10/', '/99/');
    expect((await request()).status).toBe(404);
    returnedName = numericName.replace('123456789', 'foreign-project');
    expect((await request()).status).toBe(404);
    expect(sourceReads).toBe(2);
    expect(requests.some(url => url.includes('/projects/123456789/') || url.includes('/projects/999999999/'))).toBeFalse();
  });
  test('legacy file access verifies corpus identity, current existence, and source root through the handler', async () => {
    const f = fixture();
    const corpus = 'projects/fixture-project/locations/us-central1/ragCorpora/10';
    const name = corpus + '/ragFiles/20';
    const text = 'A legacy reference list not in the master manifest.';
    let removed = false;
    let uri = 'gs://fixture-bucket/library/book-imports/research/old.md';
    const fileCalls: string[] = [];
    let sourceReads = 0;
    const worker = createDomainExpertWorker({ gcpProject: 'fixture-project', dataDir: join(f.directory, 'runtime'),
      agentRouting: validateAgentRoutingConfig({ research: f.route }),
      google: { accessToken: 'fixture-token', fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/ragFiles/')) { fileCalls.push(url); return removed ? new Response('{}', { status: 404 }) : Response.json({ name, gcsSource: { uris: [uri] }, displayName: 'Older Book' }); }
        if (url.includes('/ragCorpora')) return Response.json({ ragCorpora: [{ name: corpus, displayName: 'research-library' }] });
        const objectName = decodeURIComponent(new URL(url).pathname.split('/o/')[1]!);
        if (objectName.endsWith('master.json')) return new Response(new Uint8Array(f.stored.get(objectName)!));
        sourceReads++;
        if (objectName !== 'library/book-imports/research/old.md') throw new Error('Foreign source reached transport');
        return new Response(text);
      }) as typeof fetch } });
    const request = (ragFile = name) => worker.fetch(new Request('http://worker/v1/domain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'domain_read', params: { domain_id: 'research', action: 'read', rag_file_name: ragFile } }) }));
    expect(await (await request()).json()).toMatchObject({ text, rag_file_name: name, complete: true });
    expect(sourceReads).toBe(1);
    for (const foreign of [name.replace('ragCorpora/10', 'ragCorpora/99'), name.replace('fixture-project', 'foreign-project'), name.replace('us-central1', 'europe-west1')]) {
      expect((await request(foreign)).status).not.toBe(200);
    }
    expect(fileCalls).toHaveLength(1);
    expect(sourceReads).toBe(1);
    removed = true;
    expect((await request()).status).toBe(404);
    removed = false; uri = 'gs://foreign-bucket/library/private.md';
    expect((await request()).status).toBe(404);
    expect(sourceReads).toBe(1);
  });
  test('reads through the real worker handler with GCS only and the bounded policy stamp', async () => {
    const f = fixture();
    const calls: string[] = [];
    const worker = createDomainExpertWorker({ gcpProject: 'fixture-project', dataDir: join(f.directory, 'runtime'),
      agentRouting: validateAgentRoutingConfig({ research: f.route }),
      google: { accessToken: 'fixture-token', fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input); calls.push(url);
        const prefix = 'https://storage.googleapis.com/storage/v1/b/fixture-bucket/o/';
        expect(url.startsWith(prefix)).toBeTrue();
        const name = decodeURIComponent(url.slice(prefix.length).split('?')[0]!);
        return f.stored.has(name) ? new Response(new Uint8Array(f.stored.get(name)!)) : new Response('', { status: 404 });
      }) as typeof fetch } });
    const response = await worker.fetch(new Request('http://worker/v1/domain', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'domain_read', params: { domain_id: 'research', action: 'read', object_id: f.id, limit: 100 } }) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'domain_read_result', text: f.text.slice(0, 100), complete: false,
      policy: { expert_agents_control_plane_only: true, raw_runtime_secrets_exposed: false } });
    expect(calls).toHaveLength(2);
  });

  test('oversized streaming manifest is cancelled without trusting content-length', async () => {
    const f = fixture();
    let cancelled = false;
    const worker = createDomainExpertWorker({ gcpProject: 'fixture-project', dataDir: join(f.directory, 'runtime'),
      agentRouting: validateAgentRoutingConfig({ research: f.route }),
      google: { accessToken: 'fixture-token', fetchImpl: (async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(1_000_000)); }, cancel() { cancelled = true; },
      }))) as unknown as typeof fetch } });
    const response = await worker.fetch(new Request('http://worker/v1/domain', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'domain_read', params: { domain_id: 'research', action: 'catalog' } }) }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: 'library_source_too_large' } });
    expect(cancelled).toBeTrue();
  });
});
