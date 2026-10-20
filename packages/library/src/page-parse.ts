// The parse-once lane for one original (docs/page-library.md), shared by the
// operator CLI (scripts/library-pages.ts) and the worker's library_ingest.
//
// A PDF becomes one unit per physical page. Each page is read locally:
//   1. the text layer (pdftotext);
//   2. DeepSeek-OCR through Ollama, for a page without one;
//   3. the vision lane, for a page DeepSeek read badly.
// Figures are found on every page (an embedded image smaller than the page,
// or a Figure/Table caption line) and described by the vision lane.
// Text, Markdown and EPUB become sections of about 1,200 words.
//
// Nothing is dropped silently: a page whose lanes failed, a page left empty,
// an escalation no vision lane resolved and a figure page nobody described
// are all listed in the result. Lane results are cached per page, so a rerun
// reads only pages it has not seen; a failed call is never cached.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { convertEpubToMarkdown } from './ebook-text.ts';
import {
  describeFigures, escalatePage, figurePagesFromImageList, hasFigureCaption, readPage,
  type LaneCall, type OcrLanes,
} from './page-ocr.ts';
import {
  PAGE_UNITS_SCHEMA_VERSION, bookId, pageNeedsOcr, renderUnitMarkdown, sectionText, splitPdfText, unitName,
  type FigureRecord, type PageDerivativeManifest, type PageUnit, type UnitParser,
} from './page-units.ts';

const run = promisify(execFile);
const RENDER_DPI = 150;
// Lane results are cached under this name; a change of lanes or prompts takes a new one.
export const LANE_CACHE = 'local-lanes-v1';

export type ParseFailureKind = 'ocr' | 'vision' | 'figures';

export interface ParseFailure { page: number; kind: ParseFailureKind; error: string }

export interface ParseUsage {
  ocrPages: number; deepseekPages: number; visionPages: number; escalated: Record<string, number>;
  figurePages: number; figures: number; refusals: number; failed: number;
}

export function emptyParseUsage(): ParseUsage {
  return { ocrPages: 0, deepseekPages: 0, visionPages: 0, escalated: {}, figurePages: 0, figures: 0, refusals: 0, failed: 0 };
}

export interface ParseObjectOptions {
  /** OCR lanes. Without them a page that needs OCR is a listed failure, unless `ocr` is false. */
  lanes?: OcrLanes;
  /** Read pages without a text layer. False keeps text layers only (an operator's explicit choice). */
  ocr: boolean;
  /** Find and describe figures. */
  figures: boolean;
  /** Directory of the per-page lane cache. */
  cacheDir: string;
  laneConcurrency: number;
  /** Every lane job's calls or failure, for the call log. */
  onCall?: (record: Record<string, unknown>) => Promise<void>;
  /** Pages finished so far, of the pages that need a lane. */
  onProgress?: (done: number, total: number) => void;
  usage?: ParseUsage;
}

export interface ParsedObject {
  objectId: string;
  kind: 'pages' | 'sections';
  units: PageUnit[];
  figures: FigureRecord[];
  /** Units still near-empty after every lane. */
  emptyUnits: string[];
  failures: ParseFailure[];
  /** Pages DeepSeek read badly that no vision lane re-read; they keep DeepSeek's text. */
  unresolvedEscalations: Array<{ page: number; reason: string }>;
  /** Figure pages without descriptions because no vision lane is configured; reachable by view_page. */
  undescribedFigurePages: number[];
  /** Title and author an EPUB declares. */
  declared?: { title?: string; creator?: string };
}

interface PageCache { ocr?: { text: string; parser: UnitParser; escalated?: string }; figures?: FigureRecord[]; calls: LaneCall[] }

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isPdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 5)).toString() === '%PDF-';
}

export function isEpub(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && Buffer.from(bytes.subarray(30, 58)).toString().includes('mimetypeapplication/epub+zip');
}

async function renderPage(pdf: string, page: number, dir: string): Promise<Uint8Array> {
  const out = join(dir, `p${page}`);
  await run('pdftoppm', ['-r', String(RENDER_DPI), '-jpeg', '-f', String(page), '-l', String(page), '-singlefile', pdf, out]);
  const jpg = await readFile(`${out}.jpg`);
  await rm(`${out}.jpg`, { force: true });
  return jpg;
}

/** Pages holding an embedded image that is not a whole-page scan (judged per page). */
async function imageFigurePages(pdf: string, pageCount: number, scanPages: ReadonlySet<number>): Promise<number[]> {
  let list = '', info = '';
  try {
    list = (await run('pdfimages', ['-list', pdf], { maxBuffer: 64 * 1024 * 1024 })).stdout;
    info = (await run('pdfinfo', ['-f', '1', '-l', String(pageCount), pdf], { maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch { return []; }
  const sizes = new Map<number, { w: number; h: number }>();
  for (const m of info.matchAll(/^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+)/gm)) sizes.set(Number(m[1]), { w: Number(m[2]), h: Number(m[3]) });
  return figurePagesFromImageList(list, (p) => sizes.get(p), scanPages);
}

async function lanePage(cacheDir: string, hex: string, page: number, kind: 'ocr' | 'vision' | 'figures', read: () => Promise<PageCache>): Promise<PageCache> {
  const path = join(cacheDir, LANE_CACHE, hex.slice(0, 2), hex, `${page}-${kind}.json`);
  if (existsSync(path)) return JSON.parse(await readFile(path, 'utf8'));
  const result = await read();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(result));
  return result;
}

export async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

/** Parse one original on disk into page or section units. */
export async function parseObject(file: string, opts: ParseObjectOptions): Promise<ParsedObject> {
  const bytes = new Uint8Array(await readFile(file));
  const hex = sha256Hex(bytes);
  const objectId = `sha256:${hex}`;
  const usage = opts.usage ?? emptyParseUsage();
  const units: PageUnit[] = [];
  const figures: FigureRecord[] = [];
  const failures: ParseFailure[] = [];
  const unresolvedEscalations: Array<{ page: number; reason: string }> = [];
  const undescribedFigurePages: number[] = [];
  if (!isPdf(bytes)) {
    let text: string;
    let declared: { title?: string; creator?: string } | undefined;
    if (isEpub(bytes)) {
      const epub = convertEpubToMarkdown(bytes);
      text = epub.markdown;
      declared = { ...(epub.title ? { title: epub.title } : {}), ...(epub.creator ? { creator: epub.creator } : {}) };
    } else {
      text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
    sectionText(text).forEach((s, i) => units.push({ unit: unitName('s', i + 1), ...(s.heading ? { heading: s.heading } : {}), parser: 'text', text: s.text }));
    return { objectId, kind: 'sections', units, figures, emptyUnits: [], failures, unresolvedEscalations, undescribedFigurePages, ...(declared ? { declared } : {}) };
  }

  const { stdout } = await run('pdftotext', ['-enc', 'UTF-8', file, '-'], { maxBuffer: 512 * 1024 * 1024 });
  const pages = splitPdfText(stdout);
  pages.forEach((text, i) => units.push({ unit: unitName('p', i + 1), sourcePage: i + 1, parser: pageNeedsOcr(text) ? 'none' : 'pdftotext', text: text.trim() }));
  const lanes = opts.lanes;
  const ocrPages = opts.ocr ? units.filter((u) => u.parser === 'none').map((u) => u.sourcePage!) : [];
  const scanPages = new Set(units.filter((u) => pageNeedsOcr(u.text)).map((u) => u.sourcePage!));
  const figPages = opts.figures
    ? [...new Set([...await imageFigurePages(file, pages.length, scanPages),
      ...units.filter((u) => u.parser === 'pdftotext' && hasFigureCaption(u.text)).map((u) => u.sourcePage!)])].sort((a, b) => a - b)
    : [];
  // A missing lane is reported per page, never skipped quietly.
  if (!lanes) for (const p of ocrPages) failures.push({ page: p, kind: 'ocr', error: 'ocr_not_configured: no DeepSeek-OCR lane (OLLAMA_URL)' });
  if (!lanes?.visionUrl) undescribedFigurePages.push(...figPages);
  const jobs = lanes
    ? [...ocrPages.map((p) => ({ p, kind: 'ocr' as const })), ...(lanes.visionUrl ? figPages : []).map((p) => ({ p, kind: 'figures' as const }))]
    : [];
  let done = 0;
  opts.onProgress?.(0, jobs.length);
  if (lanes && jobs.length) {
    const tmp = await mkdtemp(join(tmpdir(), 'page-render-'));
    try {
      await pool(jobs, opts.laneConcurrency, async ({ p, kind }) => {
        const unit = units[p - 1];
        if (!unit) return;
        let r: PageCache;
        const tag = `${hex.slice(0, 12)}:${p}:${kind}`;
        try {
          // OCR is two cached steps: DeepSeek's reading, then (when it is unusable and a vision
          // lane is configured) the vision lane's. A failed call is not cached, so the next run
          // retries it.
          r = await lanePage(opts.cacheDir, hex, p, kind, async () => {
            const img = await renderPage(file, p, tmp);
            if (kind === 'ocr') {
              const o = await readPage(img, lanes);
              if (o.calls.some((c) => c.finish === 'error')) throw new Error(o.calls.find((c) => c.error)?.error ?? 'DeepSeek-OCR failed');
              return { ocr: { text: o.text, parser: o.text.trim() ? 'deepseek-ocr' : 'none', ...(o.reason ? { escalated: o.reason } : {}) }, calls: o.calls };
            }
            const f = await describeFigures(img, unit.unit, tag, lanes);
            if (f.call.finish === 'error') throw new Error(f.call.error ?? 'vision lane failed');
            return { figures: f.figures, calls: [f.call] };
          });
          const first = r.ocr;
          if (first?.escalated) {
            if (lanes.visionUrl) {
              try {
                const v = await lanePage(opts.cacheDir, hex, p, 'vision', async () => {
                  const e = await escalatePage(await renderPage(file, p, tmp), first.text, `${hex.slice(0, 12)}:${p}:vision`, lanes);
                  if (e.call.finish === 'error') throw new Error(e.call.error ?? 'vision lane failed');
                  return { ...(e.text !== undefined ? { ocr: { text: e.text, parser: 'vision' as const, escalated: first.escalated } } : {}), calls: [e.call] };
                });
                r = { ocr: v.ocr ?? first, calls: [...r.calls, ...v.calls] };
              } catch (error) {
                failures.push({ page: p, kind: 'vision', error: (error as Error).message.slice(0, 160) });
                usage.failed++;
              }
            } else {
              unresolvedEscalations.push({ page: p, reason: first.escalated });
            }
          }
        } catch (error) {
          usage.failed++;
          failures.push({ page: p, kind, error: (error as Error).message.slice(0, 160) });
          await opts.onCall?.({ object: objectId, page: p, kind, error: (error as Error).message.slice(0, 160) });
          opts.onProgress?.(++done, jobs.length);
          return;
        }
        await opts.onCall?.({ object: objectId, page: p, kind, calls: r.calls });
        usage.refusals += r.calls.filter((c) => c.refusal).length;
        if (r.ocr) {
          usage.ocrPages++;
          if (r.ocr.parser === 'deepseek-ocr') usage.deepseekPages++;
          if (r.ocr.parser === 'vision') usage.visionPages++;
          if (r.ocr.escalated) usage.escalated[r.ocr.escalated] = (usage.escalated[r.ocr.escalated] ?? 0) + 1;
          if (r.ocr.text.trim()) { unit.text = r.ocr.text; unit.parser = r.ocr.parser; }
        }
        if (r.figures) { usage.figurePages++; usage.figures += r.figures.length; figures.push(...r.figures); }
        opts.onProgress?.(++done, jobs.length);
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
  figures.sort((a, b) => a.unit.localeCompare(b.unit) || a.label.localeCompare(b.label));
  failures.sort((a, b) => a.page - b.page || a.kind.localeCompare(b.kind));
  unresolvedEscalations.sort((a, b) => a.page - b.page);
  return {
    objectId, kind: 'pages', units, figures,
    emptyUnits: units.filter((u) => pageNeedsOcr(u.text)).map((u) => u.unit),
    failures, unresolvedEscalations, undescribedFigurePages,
  };
}

export function derivativeManifest(parsed: ParsedObject, sourceUri: string): PageDerivativeManifest {
  return {
    schemaVersion: PAGE_UNITS_SCHEMA_VERSION,
    objectId: parsed.objectId,
    sourceUri,
    kind: parsed.kind,
    units: parsed.units.map(({ text, ...u }) => ({ ...u, chars: text.length })),
    figures: parsed.figures,
    emptyUnits: parsed.emptyUnits,
  };
}

export interface BookUnit extends PageUnit { object: string; source: string; sourceUnit?: string }
export interface BookFigure extends FigureRecord { object: string; source: string; sourcePage?: number }

export interface CatalogEntry {
  book: string; title: string; creator: string; kind: 'pages' | 'sections'; units: number;
  first_unit: string; last_unit: string; figures: number; objects: string[]; sources: string[];
}

/**
 * Write one book's unit files (books/<book>/<unit>.md and fig-<unit>-<n>.md),
 * replacing any earlier files of that book, and return its catalog entry.
 */
export async function writeBook(tree: string, book: {
  book: string; title: string; creator: string; kind: 'pages' | 'sections';
  units: BookUnit[]; figures: BookFigure[]; objects: string[]; sources: string[];
}): Promise<CatalogEntry> {
  const bookDir = join(tree, 'books', book.book);
  await rm(bookDir, { recursive: true, force: true });
  await mkdir(bookDir, { recursive: true });
  const { kind, title, creator } = book;
  const label = creator ? `${creator}, ${title}` : title;
  for (const u of book.units) {
    const n = Number(u.unit.slice(1));
    const fm: Record<string, string | number> = {
      title: `${label} — ${kind === 'pages' ? `p.${n}` : `§${n}`}${u.heading ? ` (${u.heading})` : ''}`,
      type: kind === 'pages' ? 'book-page' : 'book-section', book: book.book, book_title: title, creator, unit: u.unit,
      object: u.object, source: u.source,
      ...(u.sourcePage ? { source_page: u.sourcePage } : { source_unit: u.sourceUnit ?? u.unit }), ...(u.heading ? { heading: u.heading } : {}),
    };
    await writeFile(join(bookDir, `${u.unit}.md`), renderUnitMarkdown(fm, u.text || '(no text on this page)'));
  }
  const perPage = new Map<string, number>();
  for (const f of book.figures) {
    const k = (perPage.get(f.unit) ?? 0) + 1;
    perPage.set(f.unit, k);
    const body = [f.label && `**${f.label}**`, f.caption && `Caption: ${f.caption}`, f.description].filter(Boolean).join('\n\n');
    await writeFile(join(bookDir, `fig-${f.unit}-${k}.md`), renderUnitMarkdown({
      title: `${label} — figure on p.${Number(f.unit.slice(1))}${f.label ? ` (${f.label})` : ''}`, type: 'figure', book: book.book, book_title: title,
      creator, unit: f.unit, object: f.object, source: f.source, ...(f.sourcePage ? { source_page: f.sourcePage } : {}),
    }, body));
  }
  return {
    book: book.book, title, creator, kind, units: book.units.length, first_unit: book.units[0]?.unit ?? '',
    last_unit: book.units.at(-1)?.unit ?? '', figures: book.figures.length, objects: book.objects, sources: book.sources,
  };
}

/** One parsed original as a book: its id, display names and unit files. */
export async function writeParsedBook(tree: string, parsed: ParsedObject, source: string, meta: { title: string; creator: string }): Promise<CatalogEntry> {
  return writeBook(tree, {
    book: bookId(meta.title, parsed.objectId), title: meta.title, creator: meta.creator, kind: parsed.kind,
    units: parsed.units.map((u) => ({ ...u, object: parsed.objectId, source })),
    figures: parsed.figures.map((f) => ({ ...f, object: parsed.objectId, source, sourcePage: Number(f.unit.slice(1)) })),
    objects: [parsed.objectId], sources: [source],
  });
}

/** Add or replace catalog entries by book id, and drop the `remove` books, written atomically. */
export async function upsertCatalog(tree: string, entries: CatalogEntry[], remove: readonly string[] = []): Promise<number> {
  const path = join(tree, 'catalog.json');
  let books: CatalogEntry[] = [];
  if (existsSync(path)) books = (JSON.parse(await readFile(path, 'utf8')) as { books?: CatalogEntry[] }).books ?? [];
  const byBook = new Map(books.map((b) => [b.book, b]));
  for (const b of remove) byBook.delete(b);
  for (const e of entries) byBook.set(e.book, e);
  const next = [...byBook.values()].sort((a, b) => a.book.localeCompare(b.book));
  await mkdir(tree, { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify({ schemaVersion: PAGE_UNITS_SCHEMA_VERSION, books: next }, null, 1) + '\n');
  await rename(tmp, path);
  return next.length;
}
