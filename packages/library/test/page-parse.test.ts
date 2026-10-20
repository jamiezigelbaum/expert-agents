import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEEPSEEK_OCR_PROMPT, type OcrLanes } from '../src/page-ocr.ts';
import { parseObject, upsertCatalog, writeParsedBook } from '../src/page-parse.ts';
import { scanAndFigurePdf } from './pdf-fixture.ts';

let dir: string;
let pdf: string;
const scanText = 'Chapter Two. A scanned page read by the local OCR lane, with more than enough words and letters to stand on its own as the text of the page.';
const figureReply = JSON.stringify({ figures: [{ label: 'Figure 1', caption: 'The four quadrants of the map.', description: 'A square divided into four labelled quadrants.', box_2d: [100, 100, 400, 400] }] });

function lanes(calls: string[], options: { vision?: boolean; failDeepseek?: boolean } = {}): OcrLanes {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.model === 'delphi/vision-quality') {
      calls.push(`deepseek:${body.messages[0].content[0].text}`);
      if (options.failDeepseek) return new Response('down', { status: 503 });
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: scanText } }] });
    }
    const prompt = String(body.messages[0].content[0].text);
    calls.push(prompt.includes('List the figures') ? 'vision:figures' : 'vision:transcribe');
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: figureReply } }] });
  }) as unknown as typeof fetch;
  return { routerUrl: 'http://router.invalid/v1', ...(options.vision === false ? { deep: false } : {}), fetch: fetchImpl };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'page-parse-'));
  pdf = join(dir, 'author---a-sample-book.pdf');
  await writeFile(pdf, scanAndFigurePdf());
});

afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe('parsing one original', () => {
  test('text layer, then DeepSeek-OCR for the scan page, and a described figure', async () => {
    const calls: string[] = [];
    const parsed = await parseObject(pdf, { lanes: lanes(calls), ocr: true, figures: true, cacheDir: join(dir, 'cache-a'), laneConcurrency: 1 });
    expect(parsed.kind).toBe('pages');
    expect(parsed.units.map((u) => [u.unit, u.parser])).toEqual([['p0001', 'pdftotext'], ['p0002', 'deepseek-ocr']]);
    expect(parsed.units[0]!.text).toContain('witness is not an object');
    expect(parsed.units[1]!.text).toBe(scanText);
    expect(calls).toContain(`deepseek:${DEEPSEEK_OCR_PROMPT}`);
    // The scan page is not mistaken for a figure; the captioned figure page is described.
    expect(parsed.figures).toEqual([expect.objectContaining({ unit: 'p0001', label: 'Figure 1', description: 'A square divided into four labelled quadrants.' })]);
    expect(parsed.failures).toEqual([]);
    expect(parsed.emptyUnits).toEqual([]);

    // Lane results are cached per page: a rerun calls no lane.
    const again: string[] = [];
    const reparsed = await parseObject(pdf, { lanes: lanes(again), ocr: true, figures: true, cacheDir: join(dir, 'cache-a'), laneConcurrency: 1 });
    expect(again).toEqual([]);
    expect(reparsed.units).toEqual(parsed.units);
  });

  test('a failed lane and a missing lane are listed, never dropped', async () => {
    const failed = await parseObject(pdf, { lanes: lanes([], { failDeepseek: true }), ocr: true, figures: true, cacheDir: join(dir, 'cache-b'), laneConcurrency: 1 });
    expect(failed.failures).toEqual([{ page: 2, kind: 'ocr', error: expect.stringContaining('503') }]);
    expect(failed.emptyUnits).toEqual(['p0002']);
    expect(failed.units).toHaveLength(2);

    const noLanes = await parseObject(pdf, { ocr: true, figures: true, cacheDir: join(dir, 'cache-c'), laneConcurrency: 1 });
    expect(noLanes.failures).toEqual([{ page: 2, kind: 'ocr', error: expect.stringContaining('ocr_not_configured') }]);
    expect(noLanes.undescribedFigurePages).toEqual([1]);

    const noVision = await parseObject(pdf, { lanes: lanes([], { vision: false }), ocr: true, figures: true, cacheDir: join(dir, 'cache-d'), laneConcurrency: 1 });
    expect(noVision.undescribedFigurePages).toEqual([1]);
    expect(noVision.figures).toEqual([]);
  });

  test('a parsed book becomes unit files and a catalog entry, replaced on re-ingest', async () => {
    const tree = join(dir, 'tree');
    const parsed = await parseObject(pdf, { lanes: lanes([]), ocr: true, figures: true, cacheDir: join(dir, 'cache-a'), laneConcurrency: 1 });
    const entry = await writeParsedBook(tree, parsed, 'gs://originals/book.pdf', { title: 'A Sample Book', creator: 'Author' });
    expect(entry).toMatchObject({ title: 'A Sample Book', kind: 'pages', units: 2, first_unit: 'p0001', last_unit: 'p0002', figures: 1 });
    expect(entry.book).toMatch(/^a-sample-book-[0-9a-f]{6}$/);
    expect((await readdir(join(tree, 'books', entry.book))).sort()).toEqual(['fig-p0001-1.md', 'p0001.md', 'p0002.md']);
    const page = await readFile(join(tree, 'books', entry.book, 'p0002.md'), 'utf8');
    expect(page).toContain('source: "gs://originals/book.pdf"');
    expect(page).toContain('source_page: 2');
    expect(await upsertCatalog(tree, [entry])).toBe(1);
    expect(await upsertCatalog(tree, [entry])).toBe(1);
    const catalog = JSON.parse(await readFile(join(tree, 'catalog.json'), 'utf8'));
    expect(catalog.books).toEqual([entry]);
  });
});
