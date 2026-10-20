import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderUnitMarkdown } from '@expert-agents/library';
import {
  PageLibrary,
  PageLibraryError,
  parsePageLibraryParams,
  type PageSearchHit,
} from '../src/workers/domain-expert/page-library.ts';

let root: string;
const searches: Array<[string, number, string]> = [];
const downloads: string[] = [];

function library(hits: PageSearchHit[] = []) {
  return new PageLibrary({ root, sourceId: 'research', originalBuckets: ['library-bucket'] }, {
    search: async (q, k, s) => { searches.push([q, k, s]); return hits; },
    download: async (bucket, name) => { downloads.push(`${bucket}/${name}`); return new Uint8Array([1, 2, 3]); },
    renderPage: async (_pdf, page) => new Uint8Array([0xff, 0xd8, page]),
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'page-library-test-'));
  const book = join(root, 'books', 'sample-book-aaaaaa');
  await mkdir(book, { recursive: true });
  for (let n = 1; n <= 30; n++) {
    const unit = `p${String(n).padStart(4, '0')}`;
    await writeFile(join(book, `${unit}.md`), renderUnitMarkdown({
      title: `Sample — p.${n}`, book: 'sample-book-aaaaaa', unit, source: 'gs://library-bucket/v2/objects/sample.pdf', source_page: n,
    }, n === 12 ? 'The Witness is not an object.\nA second line.' : `Page ${n} text.`));
  }
  await writeFile(join(book, 'fig-p0012-1.md'), renderUnitMarkdown({ title: 'figure', unit: 'p0012' }, 'A diagram of four quadrants.'));
  const other = join(root, 'books', 'other-text-bbbbbb');
  await mkdir(other, { recursive: true });
  await writeFile(join(other, 's0001.md'), renderUnitMarkdown({ title: 'Other — §1', source: 'gs://elsewhere/x.md' }, 'Section text with the witness.'));
  await writeFile(join(root, 'catalog.json'), JSON.stringify({ books: [
    { book: 'sample-book-aaaaaa', title: 'Sample Book', creator: 'A. Author', kind: 'pages', units: 30, first_unit: 'p0001', last_unit: 'p0030', figures: 1 },
    { book: 'other-text-bbbbbb', title: 'Other Text', creator: '', kind: 'sections', units: 1, first_unit: 's0001', last_unit: 's0001', figures: 0 },
  ] }));
});

afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('page library params', () => {
  test('each action takes only its own fields', () => {
    expect(parsePageLibraryParams({ action: 'search', query: 'witness', k: 99 })).toEqual({ action: 'search', query: 'witness', k: 25 });
    expect(() => parsePageLibraryParams({ action: 'read', slug: 'books/a/p0001', book: 'a' })).toThrow(PageLibraryError);
    expect(() => parsePageLibraryParams({ action: 'delete' })).toThrow(PageLibraryError);
    expect(() => parsePageLibraryParams({ action: 'grep', pattern: 'x'.repeat(201) })).toThrow(PageLibraryError);
  });
});

describe('page library tools', () => {
  test('catalog filters by author or title', async () => {
    const r = await library().catalog('author');
    expect(r.books).toEqual([{ book: 'sample-book-aaaaaa', creator: 'A. Author', title: 'Sample Book', units: 30, range: 'p0001–p0030', figures: 1 }]);
  });

  test('search passes the source id, cites every hit and drops unknown slugs', async () => {
    const r = await library([{ slug: 'books/sample-book-aaaaaa/p0012', text: 'The Witness' }, { slug: '../../etc/passwd', text: 'x' }]).search('witness', 5);
    expect(searches.at(-1)).toEqual(['witness', 5, 'research']);
    expect(r.results).toEqual([{ slug: 'books/sample-book-aaaaaa/p0012', cite: 'A. Author, Sample Book, p.12', text: 'The Witness' }]);
  });

  test('grep finds every book, or one book, and caps its hits', async () => {
    const all = await library().grep('witness', undefined, 10);
    expect((all.hits as Array<{ slug: string }>).map((h) => h.slug).sort()).toEqual(['books/other-text-bbbbbb/s0001', 'books/sample-book-aaaaaa/p0012']);
    const one = await library().grep('page \\d+ text', 'sample-book-aaaaaa', 3);
    expect(one.hits).toHaveLength(3);
    expect(one.complete).toBe(false);
    await expect(library().grep('(', undefined, 3)).rejects.toThrow(PageLibraryError);
  });

  test('read returns the body without front matter; a figure slug reads its page', async () => {
    const r = await library().read('books/sample-book-aaaaaa/fig-p0012-1');
    expect(r).toMatchObject({ slug: 'books/sample-book-aaaaaa/p0012', cite: 'A. Author, Sample Book, p.12', truncated: false });
    expect(r.text).toBe('The Witness is not an object.\nA second line.');
    await expect(library().read('books/sample-book-aaaaaa/p0099')).rejects.toThrow(PageLibraryError);
    await expect(library().read('books/../p0001')).rejects.toThrow(PageLibraryError);
  });

  test('read_range reads at most 25 units and says where to continue', async () => {
    const r = await library().readRange('sample-book-aaaaaa', 'p0001', 'p0030');
    expect(r.units).toHaveLength(25);
    expect(r.next_unit).toBe('p0026');
    const tail = await library().readRange('sample-book-aaaaaa', 'p0026', 'p0040');
    expect(tail.units).toHaveLength(5);
    expect(tail.next_unit).toBeUndefined();
    await expect(library().readRange('sample-book-aaaaaa', 's0001', 's0002')).rejects.toThrow(PageLibraryError);
  });

  test('view_page renders the original page from an allowed bucket only', async () => {
    const r = await library().viewPage('books/sample-book-aaaaaa/p0012');
    expect(downloads.at(-1)).toBe('library-bucket/v2/objects/sample.pdf');
    expect(r.image).toEqual({ mime_type: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 12]).toString('base64') });
    await expect(library().viewPage('books/other-text-bbbbbb/s0001')).rejects.toThrow(PageLibraryError);
  });
});
