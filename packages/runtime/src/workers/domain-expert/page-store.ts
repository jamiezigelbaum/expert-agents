// Where a page library's catalog and units are read from (docs/page-library.md).
//
//   database  the library database itself: page_books holds the catalog and
//             page_units each unit's text and front matter, under one source
//             id. A worker on any host reads it over the network, ingest from
//             any host writes into it, and moving the library is one dump and
//             restore. The default for new libraries.
//   tree      an assembled tree on local disk (catalog.json + books/<book>/
//             <unit>.md), as `scripts/library-pages.ts assemble` writes it.
//
// Both answer the same four questions, so the tools above them are one code path.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SQL } from 'bun';
import { unitBody, unitFrontmatter } from '@expert-agents/library';
import { PageLibraryError } from './page-library.ts';

/** One catalog row as `upsertCatalog` writes it. */
export interface PageCatalogBook {
  book: string; title: string; creator: string; kind: 'pages' | 'sections'; units: number;
  first_unit: string; last_unit: string; figures: number; sources?: string[]; objects?: string[];
  /** A fetched source (web page or Notion page): where it was read from, and when. */
  origin?: string; source_url?: string; retrieved_at?: string;
  /** A transcript's section time ranges, cited instead of section numbers. */
  timecodes?: Record<string, string>;
}

export interface PageStoreUnit { body: string; meta: Record<string, unknown> }

export interface PageStore {
  readonly kind: 'tree' | 'database';
  /** Every book in the library; an empty library has none. */
  catalog(): Promise<PageCatalogBook[]>;
  /** One unit, or undefined when the book has no such unit. */
  unit(book: string, unit: string): Promise<PageStoreUnit | undefined>;
  /**
   * Units of the named books for grep, in book then unit order. A store may use `pattern` to skip
   * units that cannot match and `limit` to stop after that many candidates; the caller still
   * matches every line itself.
   */
  scan(books: readonly string[], pattern: string, limit: number): AsyncIterable<{ book: string; unit: string; body: string }>;
  /** Characters of a book's page or section units, figure descriptions excluded. */
  extent(book: string): Promise<number>;
}

export class TreePageStore implements PageStore {
  readonly kind = 'tree';
  constructor(private readonly root: string) {}

  async catalog(): Promise<PageCatalogBook[]> {
    try { return (JSON.parse(await readFile(join(this.root, 'catalog.json'), 'utf8')) as { books?: PageCatalogBook[] }).books ?? []; }
    catch (error) {
      // A library nothing has been ingested into yet has no catalog: it is empty, not broken.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new PageLibraryError('page_library_unavailable', 'The page library catalog is not readable.', 503);
    }
  }

  async unit(book: string, unit: string): Promise<PageStoreUnit | undefined> {
    let markdown: string;
    try { markdown = await readFile(join(this.root, 'books', book, `${unit}.md`), 'utf8'); } catch { return undefined; }
    return { body: unitBody(markdown), meta: unitFrontmatter(markdown) };
  }

  async *scan(books: readonly string[]): AsyncIterable<{ book: string; unit: string; body: string }> {
    for (const book of books) {
      const dir = join(this.root, 'books', book);
      let files: string[];
      try { files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort(); } catch { continue; }
      for (const f of files) yield { book, unit: f.slice(0, -3), body: unitBody(await readFile(join(dir, f), 'utf8')) };
    }
  }

  async extent(book: string): Promise<number> {
    const dir = join(this.root, 'books', book);
    let files: string[] = [];
    try { files = (await readdir(dir)).filter((f) => /^[ps]\d+\.md$/.test(f)); } catch { /* an empty book has no extent */ }
    let chars = 0;
    for (const f of files) chars += unitBody(await readFile(join(dir, f), 'utf8')).length;
    return chars;
  }
}

const GREP_STATEMENT_TIMEOUT_MS = 15_000;
const SCAN_PAGE = 500;

/**
 * A JavaScript pattern as a Postgres one that matches at least the same lines. `(?n)` makes `^`,
 * `$` and `.` work per line, as grep tests each line; `\b`/`\B` are spelled `\y`/`\Y` there.
 */
export function postgresLinePattern(pattern: string): string {
  return `(?n)${pattern.replace(/\\(.)/gs, (all, c: string) => (c === 'b' ? '\\y' : c === 'B' ? '\\Y' : all))}`;
}

const asJson = <T>(value: unknown): T => (typeof value === 'string' ? JSON.parse(value) : value) as T;
// Book ids are slugs, so a comma-joined list is unambiguous (page-index.ts sends arrays the same way).
const bookList = (books: readonly string[]) => books.join(',');

export class DatabasePageStore implements PageStore {
  readonly kind = 'database';
  constructor(private readonly sql: SQL, private readonly source: string) {}

  private async query<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch {
      throw new PageLibraryError('page_library_unavailable', 'The page library database could not be read.', 503);
    }
  }

  async catalog(): Promise<PageCatalogBook[]> {
    const rows = await this.query(() => this.sql`SELECT entry FROM page_books WHERE source = ${this.source} ORDER BY book`) as Array<{ entry: unknown }>;
    return rows.map((r) => asJson<PageCatalogBook>(r.entry));
  }

  async unit(book: string, unit: string): Promise<PageStoreUnit | undefined> {
    const [row] = await this.query(() => this.sql`SELECT body, meta FROM page_units WHERE source = ${this.source} AND slug = ${`books/${book}/${unit}`}`) as Array<{ body: string; meta: unknown }>;
    return row ? { body: row.body, meta: asJson<Record<string, unknown>>(row.meta) ?? {} } : undefined;
  }

  async *scan(books: readonly string[], pattern: string, limit: number): AsyncIterable<{ book: string; unit: string; body: string }> {
    if (!books.length) return;
    // Postgres filters by the pattern so only candidate units cross the network.
    const filtered = await this.sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = ${GREP_STATEMENT_TIMEOUT_MS}`);
      return await tx`SELECT book, unit, body FROM page_units
        WHERE source = ${this.source} AND book = ANY(string_to_array(${bookList(books)}, ',')) AND body ~* ${postgresLinePattern(pattern)}
        ORDER BY book, unit LIMIT ${limit}`;
    }).then((rows) => rows as Array<{ book: string; unit: string; body: string }>, (error: unknown) => {
      const e = error as { errno?: string; code?: string };
      if (e.errno === '57014' || e.code === '57014') throw new PageLibraryError('page_library_grep_timeout', 'The pattern took too long; narrow it or name a book.', 504);
      // A pattern JavaScript reads but Postgres does not (named groups, say) is scanned unfiltered below.
      if (e.errno === '2201B' || e.code === '2201B') return undefined;
      throw new PageLibraryError('page_library_unavailable', 'The page library database could not be read.', 503);
    });
    if (filtered) { yield* filtered; return; }
    let after = '';
    for (;;) {
      const page = await this.query(() => this.sql`SELECT book, unit, body, slug FROM page_units
        WHERE source = ${this.source} AND book = ANY(string_to_array(${bookList(books)}, ',')) AND slug > ${after}
        ORDER BY slug LIMIT ${SCAN_PAGE}`) as Array<{ book: string; unit: string; body: string; slug: string }>;
      yield* page;
      if (page.length < SCAN_PAGE) return;
      after = page.at(-1)!.slug;
    }
  }

  async extent(book: string): Promise<number> {
    const [row] = await this.query(() => this.sql`SELECT coalesce(sum(length(body)), 0)::bigint AS chars FROM page_units
      WHERE source = ${this.source} AND book = ${book} AND unit ~ '^[ps][0-9]+$'`) as Array<{ chars: number | string | bigint }>;
    return Number(row?.chars ?? 0);
  }
}
