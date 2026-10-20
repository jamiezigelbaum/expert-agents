import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderUnitMarkdown } from '@expert-agents/library';
import {
  contentHash,
  embeddingKey,
  readTreeUnits,
  reciprocalRankFusion,
  unitDocument,
  voyageClient,
} from '../src/workers/domain-expert/page-index.ts';
import { PageLibraryError } from '../src/workers/domain-expert/page-library.ts';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'page-index-test-'));
  await mkdir(join(root, 'books', 'sample-book-aaaaaa'), { recursive: true });
  await writeFile(join(root, 'books', 'sample-book-aaaaaa', 'p0001.md'), renderUnitMarkdown({ title: 'A. Author, Sample — p.1', unit: 'p0001' }, 'First page.'));
  await writeFile(join(root, 'books', 'sample-book-aaaaaa', 'fig-p0001-1.md'), renderUnitMarkdown({ title: 'A. Author, Sample — figure on p.1' }, 'A diagram.'));
  await writeFile(join(root, 'books', 'sample-book-aaaaaa', 'notes.md'), 'not a unit');
});

afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('page index', () => {
  test('reads every unit of a tree, figures included, and skips files that are not units', async () => {
    const units = await readTreeUnits(root);
    expect(units.map((u) => u.slug)).toEqual(['books/sample-book-aaaaaa/fig-p0001-1', 'books/sample-book-aaaaaa/p0001']);
    expect(units[1]).toEqual({ slug: 'books/sample-book-aaaaaa/p0001', book: 'sample-book-aaaaaa', unit: 'p0001', title: 'A. Author, Sample — p.1', body: 'First page.' });
  });

  test('a unit is indexed as its citation title and body; its hash and embedding key follow that text', () => {
    const u = { title: 'T', body: 'B' };
    expect(unitDocument(u)).toBe('T\n\nB');
    expect(unitDocument({ title: 'T', body: 'x'.repeat(100) }, 10)).toHaveLength(10);
    expect(contentHash(u)).toBe(contentHash({ title: 'T', body: 'B' }));
    expect(contentHash(u)).not.toBe(contentHash({ title: 'T', body: 'C' }));
    expect(embeddingKey('voyage-4', 1024, 'x')).not.toBe(embeddingKey('voyage-4', 512, 'x'));
  });

  test('reciprocal rank fusion rewards agreement between the arms', () => {
    const fused = reciprocalRankFusion([['a', 'b', 'c'], ['c', 'a', 'd']]);
    expect(fused.map((f) => f.slug)).toEqual(['a', 'c', 'b', 'd']);
    expect(fused[0]!.score).toBeCloseTo(1 / 61 + 1 / 62);
  });
});

describe('Voyage client', () => {
  test('embeds with the input type and dimensions, and reranks with top_k', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push({ url, ...body });
      if (url.endsWith('/embeddings')) return Response.json({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }], usage: { total_tokens: 7 } });
      return Response.json({ data: [{ index: 1, relevance_score: 0.9 }], usage: { total_tokens: 3 } });
    }) as unknown as typeof fetch;
    const v = voyageClient('secret-key', { fetch: fetchImpl });
    expect(await v.embed(['a', 'b'], 'query')).toEqual({ vectors: [[1], [2]], tokens: 7 });
    expect(bodies[0]).toMatchObject({ model: 'voyage-4', input_type: 'query', output_dimension: 1024 });
    expect(await v.rerank('q', ['x', 'y'], 1)).toEqual({ order: [{ index: 1, score: 0.9 }], tokens: 3 });
    expect(bodies[1]).toMatchObject({ model: 'rerank-3', top_k: 1 });
  });

  test('a refused call is an error that names no key', async () => {
    const v = voyageClient('secret-key', { fetch: (async () => new Response('no', { status: 401 })) as unknown as typeof fetch });
    const error = await v.embed(['a'], 'document').catch((e) => e as Error);
    expect(error).toBeInstanceOf(PageLibraryError);
    expect(String((error as Error).message)).not.toContain('secret-key');
  });
});
