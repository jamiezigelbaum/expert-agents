// The page library tool belt (docs/page-library.md): six actions over the
// page-addressed units the parse-once lane assembles.
//
//   catalog     books in the library, optionally filtered by author/title
//   search      hybrid keyword + vector search with reranking (page-index.ts)
//   grep        case-insensitive regex over the full text, optionally one book
//   read        one unit (a PDF page or a ~1,200-word section)
//   read_range  consecutive units of one book, at most 25 per call
//   view_page   the image of one PDF page, rendered from the original
//
// Units are addressed `books/<book>/<unit>`; every result carries a citation
// label. The tree is local, read-only state assembled by
// `scripts/library-pages.ts assemble`; callers cannot name paths outside it.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseUnitSlug, unitBody, unitName, unitNumber } from '@expert-agents/library';

const run = promisify(execFile);

export const PAGE_LIBRARY_ACTIONS = ['catalog', 'search', 'grep', 'read', 'read_range', 'view_page'] as const;
export type PageLibraryAction = typeof PAGE_LIBRARY_ACTIONS[number];

export const READ_MAX_CHARS = 12_000;
export const RANGE_MAX_UNITS = 25;
export const RANGE_MAX_CHARS = 60_000;
export const SEARCH_MAX_K = 25;
export const GREP_MAX_HITS = 50;
const GREP_PATTERN_MAX = 200;
const PDF_MAX_BYTES = 100_000_000;
const VIEW_DPI = 110;

export class PageLibraryError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

export interface PageLibraryConfig {
  /** Absolute path of the assembled tree (catalog.json + books/). */
  root: string;
  /** Search index source id the tree was imported under. */
  sourceId: string;
  /** Buckets the originals may be read from for view_page. */
  originalBuckets: readonly string[];
}

export interface PageSearchHit { slug: string; text: string; score?: number }

export interface PageLibraryDependencies {
  search(query: string, k: number, sourceId: string): Promise<PageSearchHit[]>;
  download(bucket: string, name: string, maxBytes: number, timeoutMs: number): Promise<Uint8Array | null>;
  /** JPEG bytes of one page; defaults to pdftoppm. */
  renderPage?: (pdf: Uint8Array, page: number) => Promise<Uint8Array>;
}

export interface PageLibraryParams {
  action: PageLibraryAction;
  query?: string;
  k?: number;
  pattern?: string;
  book?: string;
  max_hits?: number;
  slug?: string;
  from_unit?: string;
  to_unit?: string;
}

interface CatalogBook {
  book: string; title: string; creator: string; kind: 'pages' | 'sections'; units: number;
  first_unit: string; last_unit: string; figures: number; sources?: string[];
}

/** One unit's worth of text with its address and citation label. */
export interface PageExcerpt { slug: string; cite: string; text: string }

export interface PageBookInfo { book: string; title: string; creator: string; sources: string[]; chars: number }

const FIELDS: Record<PageLibraryAction, string[]> = {
  catalog: ['query'],
  search: ['query', 'k', 'book'],
  grep: ['pattern', 'book', 'max_hits'],
  read: ['slug'],
  read_range: ['book', 'from_unit', 'to_unit'],
  view_page: ['slug'],
};

export function parsePageLibraryParams(value: Record<string, unknown>): PageLibraryParams {
  const action = value.action;
  if (typeof action !== 'string' || !(PAGE_LIBRARY_ACTIONS as readonly string[]).includes(action)) {
    throw new PageLibraryError('invalid_request', `action must be one of ${PAGE_LIBRARY_ACTIONS.join(', ')}.`);
  }
  const allowed = ['action', 'domain_id', 'session_id', ...FIELDS[action as PageLibraryAction]];
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  if (extra.length) throw new PageLibraryError('invalid_request', `unexpected fields for ${action}: ${extra.join(', ')}`);
  const str = (k: string, required: boolean, max = 500) => {
    const v = value[k];
    if (v === undefined && !required) return undefined;
    if (typeof v !== 'string' || !v.trim() || v.length > max) throw new PageLibraryError('invalid_request', `${k} must be a non-empty string of at most ${max} characters.`);
    return v;
  };
  const int = (k: string, max: number) => {
    const v = value[k];
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new PageLibraryError('invalid_request', `${k} must be a positive integer.`);
    return Math.min(v, max);
  };
  const p: PageLibraryParams = { action: action as PageLibraryAction };
  switch (p.action) {
    case 'catalog': { const q = value.query === '' ? undefined : str('query', false); if (q) p.query = q; break; }
    case 'search': p.query = str('query', true); { const k = int('k', SEARCH_MAX_K); if (k) p.k = k; } { const b = str('book', false, 64); if (b) p.book = b; } break;
    case 'grep': p.pattern = str('pattern', true, GREP_PATTERN_MAX); { const b = str('book', false, 64); if (b) p.book = b; } { const m = int('max_hits', GREP_MAX_HITS); if (m) p.max_hits = m; } break;
    case 'read': case 'view_page': p.slug = str('slug', true, 120); break;
    case 'read_range': p.book = str('book', true, 64); p.from_unit = str('from_unit', true, 8); p.to_unit = str('to_unit', true, 8); break;
  }
  return p;
}

export class PageLibrary {
  private catalogCache?: { books: CatalogBook[]; byBook: Map<string, CatalogBook> };
  private readonly extentCache = new Map<string, PageBookInfo>();

  constructor(private readonly config: PageLibraryConfig, private readonly deps: PageLibraryDependencies) {
    if (!config.root || resolve(config.root) !== config.root) throw new PageLibraryError('page_library_misconfigured', 'The page library root must be an absolute path.', 500);
  }

  async run(params: PageLibraryParams): Promise<Record<string, unknown>> {
    switch (params.action) {
      case 'catalog': return this.catalog(params.query);
      case 'search': return this.search(params.query!, params.k ?? 10, params.book);
      case 'grep': return this.grep(params.pattern!, params.book, params.max_hits ?? 30);
      case 'read': return this.read(params.slug!);
      case 'read_range': return this.readRange(params.book!, params.from_unit!, params.to_unit!);
      case 'view_page': return this.viewPage(params.slug!);
    }
  }

  private async books(): Promise<{ books: CatalogBook[]; byBook: Map<string, CatalogBook> }> {
    if (!this.catalogCache) {
      let parsed: { books?: CatalogBook[] };
      try { parsed = JSON.parse(await readFile(join(this.config.root, 'catalog.json'), 'utf8')); }
      catch (error) {
        // A library nothing has been ingested into yet has no catalog: it is empty, not broken.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new PageLibraryError('page_library_unavailable', 'The page library catalog is not readable.', 503);
        return { books: [], byBook: new Map() };
      }
      const books = (parsed.books ?? []).filter((b) => typeof b.book === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(b.book));
      this.catalogCache = { books, byBook: new Map(books.map((b) => [b.book, b])) };
    }
    return this.catalogCache;
  }

  private async cite(book: string, unit: string): Promise<string> {
    const b = (await this.books()).byBook.get(book);
    const page = unit.replace(/^fig-(p\d+)-\d+$/, '$1');
    const loc = page.startsWith('p') ? `p.${unitNumber(page)}` : `section ${unitNumber(page)}`;
    return `${b?.creator ? `${b.creator}, ` : ''}${b?.title ?? book}, ${loc}`;
  }

  private async requireBook(book: string): Promise<CatalogBook> {
    const b = (await this.books()).byBook.get(book);
    if (!b) throw new PageLibraryError('page_library_unknown_book', 'No book with that id; use catalog.', 404);
    return b;
  }

  private async unitFile(slug: string): Promise<{ book: string; unit: string; markdown: string }> {
    const parsed = parseUnitSlug(slug);
    if (!parsed) throw new PageLibraryError('invalid_request', 'slug must look like books/<book>/<unit>.');
    await this.requireBook(parsed.book);
    try {
      return { ...parsed, markdown: await readFile(join(this.config.root, 'books', parsed.book, `${parsed.unit}.md`), 'utf8') };
    } catch {
      throw new PageLibraryError('page_library_unknown_unit', 'No such unit in this book; check its unit range in catalog.', 404);
    }
  }

  async catalog(query?: string): Promise<Record<string, unknown>> {
    const q = query?.toLowerCase();
    const rows = (await this.books()).books.filter((b) => !q || `${b.creator} ${b.title} ${b.book}`.toLowerCase().includes(q));
    return {
      books: rows.slice(0, 200).map((b) => ({ book: b.book, creator: b.creator, title: b.title, units: b.units, range: `${b.first_unit}–${b.last_unit}`, figures: b.figures })),
      total: rows.length,
      complete: rows.length <= 200,
    };
  }

  async search(query: string, k: number, book?: string): Promise<Record<string, unknown>> {
    if (book) await this.requireBook(book);
    // A book filter is applied after ranking, so ask for more and cut.
    const hits = await this.deps.search(query, book ? SEARCH_MAX_K * 2 : k, this.config.sourceId);
    const out = [];
    for (const h of hits) {
      const parsed = parseUnitSlug(h.slug);
      if (!parsed || (book && parsed.book !== book)) continue;
      // source_uri names the stored original, as domain_ask passages do, so evaluations can match evidence.
      const source = (await this.bookIdentity(parsed.book).catch(() => undefined))?.sources[0];
      out.push({ slug: h.slug, cite: await this.cite(parsed.book, parsed.unit), ...(source ? { source_uri: source } : {}), text: h.text.slice(0, 700) });
      if (out.length >= k) break;
    }
    return { results: out };
  }

  async grep(pattern: string, book: string | undefined, maxHits: number): Promise<Record<string, unknown>> {
    let re: RegExp;
    try { re = new RegExp(pattern, 'i'); } catch { throw new PageLibraryError('invalid_request', 'pattern is not a valid regular expression.'); }
    const books = book ? [await this.requireBook(book)] : (await this.books()).books;
    const hits: Array<Record<string, string>> = [];
    let scanned = 0;
    outer: for (const b of books) {
      const dir = join(this.config.root, 'books', b.book);
      let files: string[];
      try { files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort(); } catch { continue; }
      for (const f of files) {
        const body = unitBody(await readFile(join(dir, f), 'utf8'));
        scanned++;
        let perUnit = 0;
        for (const line of body.split('\n')) {
          if (!re.test(line)) continue;
          const unit = f.slice(0, -3);
          hits.push({ slug: `books/${b.book}/${unit}`, cite: await this.cite(b.book, unit), line: line.trim().slice(0, 300) });
          if (hits.length >= maxHits) break outer;
          if (++perUnit >= 3) break;
        }
      }
    }
    return { hits, complete: hits.length < maxHits, units_scanned: scanned };
  }

  async read(slug: string): Promise<Record<string, unknown>> {
    const { slug: page, cite, text } = await this.unitText(slug);
    return { slug: page, cite, text: text.slice(0, READ_MAX_CHARS), truncated: text.length > READ_MAX_CHARS };
  }

  async readRange(book: string, fromUnit: string, toUnit: string): Promise<Record<string, unknown>> {
    const range = await this.rangeParts(book, fromUnit, toUnit);
    return {
      units: range.parts.map((p) => p.slug),
      text: range.parts.map((p) => `[${p.slug} | ${p.cite}]\n${p.text}`).join('\n\n'),
      ...(range.next_unit ? { next_unit: range.next_unit } : {}),
      note: `at most ${RANGE_MAX_UNITS} units or ${RANGE_MAX_CHARS} characters per call; continue from next_unit`,
    };
  }

  /** The units read_range returns, one entry per unit, and the unit to continue from. */
  async rangeParts(book: string, fromUnit: string, toUnit: string): Promise<{ parts: PageExcerpt[]; next_unit?: string }> {
    const b = await this.requireBook(book);
    let from: number, to: number;
    try { from = unitNumber(fromUnit); to = unitNumber(toUnit); } catch { throw new PageLibraryError('invalid_request', 'from_unit and to_unit must be unit names like p0012 or s0003.'); }
    const kind = b.kind === 'pages' ? 'p' : 's';
    if (fromUnit[0] !== kind || toUnit[0] !== kind || to < from) throw new PageLibraryError('invalid_request', `this book's units are ${b.first_unit}–${b.last_unit}.`);
    const last = Math.min(to, from + RANGE_MAX_UNITS - 1, unitNumber(b.last_unit));
    const parts: PageExcerpt[] = [];
    let chars = 0;
    for (let n = from; n <= last; n++) {
      const unit = unitName(kind, n);
      const path = join(this.config.root, 'books', book, `${unit}.md`);
      if (!existsSync(path)) break;
      const slug = `books/${book}/${unit}`;
      const cite = await this.cite(book, unit);
      const text = unitBody(await readFile(path, 'utf8'));
      const size = slug.length + cite.length + text.length + 4;
      if (chars + size > RANGE_MAX_CHARS && parts.length) break;
      parts.push({ slug, cite, text }); chars += size;
    }
    const nextN = from + parts.length;
    return { parts, ...(nextN <= Math.min(to, unitNumber(b.last_unit)) ? { next_unit: unitName(kind, nextN) } : {}) };
  }

  /** The full text of the page or section a slug addresses (a figure slug addresses its page). */
  async unitText(slug: string): Promise<PageExcerpt> {
    const f = await this.unitFile(slug);
    const unit = f.unit.replace(/^fig-(p\d+)-\d+$/, '$1');
    const page = unit === f.unit ? f : await this.unitFile(`books/${f.book}/${unit}`);
    return { slug: `books/${f.book}/${unit}`, cite: await this.cite(f.book, unit), text: unitBody(page.markdown) };
  }

  /**
   * What disclosure needs to know about one book: its catalog identity, the
   * originals it was built from, and its real extent — the characters of its
   * page or section units, figure descriptions excluded.
   */
  async bookInfo(book: string): Promise<PageBookInfo> {
    const cached = this.extentCache.get(book);
    if (cached) return cached;
    const identity = await this.bookIdentity(book);
    const dir = join(this.config.root, 'books', book);
    let chars = 0;
    let files: string[] = [];
    try { files = (await readdir(dir)).filter((f) => /^[ps]\d+\.md$/.test(f)); } catch { /* an empty book has no extent */ }
    for (const f of files) chars += unitBody(await readFile(join(dir, f), 'utf8')).length;
    const info: PageBookInfo = { ...identity, chars };
    this.extentCache.set(book, info);
    return info;
  }

  /** A book's catalog identity and originals, without reading its units. */
  async bookIdentity(book: string): Promise<Omit<PageBookInfo, 'chars'>> {
    const b = await this.requireBook(book);
    return { book, title: b.title, creator: b.creator, sources: Array.isArray(b.sources) ? b.sources.filter((s) => typeof s === 'string') : [] };
  }

  async viewPage(slug: string): Promise<Record<string, unknown>> {
    const f = await this.unitFile(slug);
    const fm = frontmatter(f.markdown);
    const source = fm.source, page = Number(fm.source_page);
    const m = typeof source === 'string' ? /^gs:\/\/([^/]+)\/(.+\.pdf)$/i.exec(source) : null;
    if (!m || !Number.isInteger(page) || page < 1) throw new PageLibraryError('page_library_not_a_pdf_page', 'Only PDF pages have an image to view.');
    if (!this.config.originalBuckets.includes(m[1]!)) throw new PageLibraryError('page_library_source_not_available', 'The original is outside this library.', 404);
    const pdf = await this.deps.download(m[1]!, m[2]!, PDF_MAX_BYTES, 60_000);
    if (!pdf) throw new PageLibraryError('page_library_source_not_available', 'The original could not be read.', 404);
    const jpeg = await (this.deps.renderPage ?? renderWithPdftoppm)(pdf, page);
    const unit = f.unit.replace(/^fig-(p\d+)-\d+$/, '$1');
    return { slug: `books/${f.book}/${unit}`, cite: await this.cite(f.book, unit), image: { mime_type: 'image/jpeg', data: Buffer.from(jpeg).toString('base64') } };
  }
}

function frontmatter(markdown: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!markdown.startsWith('---\n')) return out;
  const end = markdown.indexOf('\n---\n', 4);
  for (const line of markdown.slice(4, end < 0 ? 0 : end).split('\n')) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const raw = line.slice(i + 1).trim();
    try { out[line.slice(0, i).trim()] = JSON.parse(raw); } catch { out[line.slice(0, i).trim()] = raw; }
  }
  return out;
}

async function renderWithPdftoppm(pdf: Uint8Array, page: number): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'view-page-'));
  try {
    await writeFile(join(dir, 'in.pdf'), pdf);
    await run('pdftoppm', ['-r', String(VIEW_DPI), '-jpeg', '-f', String(page), '-l', String(page), '-singlefile', join(dir, 'in.pdf'), join(dir, 'out')], { timeout: 60_000 });
    return new Uint8Array(await readFile(join(dir, 'out.jpg')));
  } catch {
    throw new PageLibraryError('page_library_render_failed', 'The page could not be rendered.', 502);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
