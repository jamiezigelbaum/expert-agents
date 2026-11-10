// One route reading several page libraries (docs/page-library.md section 5): a
// PageStore that unions their catalogs and routes each book to the library that
// owns it, and a search that asks every library's index and merges by score.
// A single-library route does not come through here.
import { parseUnitSlug } from '@expert-agents/library';
import type { PageCatalogBook, PageStore, PageStoreUnit } from './page-store.ts';
import { pageSearchResult, type PageSearchHit, type PageSearchResult, type PageSearchScope } from './page-library.ts';

// Matches the page library's own catalog cache: books ingested elsewhere appear within this long.
const OWNERS_TTL_MS = 60_000;

export interface PageLibraryMember {
  sourceId: string;
  /** Named database, absent for the default one. */
  database?: string;
  store: PageStore;
  search(query: string, k: number, scope?: PageSearchScope): Promise<PageSearchHit[] | PageSearchResult>;
}

export class MultiPageStore implements PageStore {
  readonly kind: 'tree' | 'database';
  private owners?: { byBook: Map<string, number>; at: number };

  constructor(private readonly members: readonly PageLibraryMember[]) {
    this.kind = members[0]?.store.kind ?? 'database';
  }

  /** Union of the catalogs; a book id two libraries hold belongs to the first. */
  async catalog(): Promise<PageCatalogBook[]> {
    const lists = await Promise.all(this.members.map((m) => m.store.catalog()));
    const byBook = new Map<string, number>();
    const books: PageCatalogBook[] = [];
    lists.forEach((list, i) => {
      for (const b of list) {
        if (byBook.has(b.book)) continue;
        byBook.set(b.book, i);
        books.push(b);
      }
    });
    this.owners = { byBook, at: Date.now() };
    return books;
  }

  private async ownerOf(book: string): Promise<PageStore | undefined> {
    if (!this.owners || !this.owners.byBook.has(book)) await this.catalog();
    const i = this.owners!.byBook.get(book);
    return i === undefined ? undefined : this.members[i]!.store;
  }

  async unit(book: string, unit: string): Promise<PageStoreUnit | undefined> {
    return (await this.ownerOf(book))?.unit(book, unit);
  }

  async extent(book: string): Promise<number> {
    return (await this.ownerOf(book))?.extent(book) ?? 0;
  }

  async *scan(books: readonly string[], pattern: string, limit: number): AsyncIterable<{ book: string; unit: string; body: string }> {
    if (!this.owners || books.some((b) => !this.owners!.byBook.has(b))) await this.catalog();
    for (const [i, m] of this.members.entries()) {
      const mine = books.filter((b) => this.owners!.byBook.get(b) === i);
      if (mine.length) yield* m.store.scan(mine, pattern, limit);
    }
  }

  /**
   * Hits from every library, best score first; a hit on a book another library owns is dropped.
   * Inside one book only the library that owns it is asked.
   */
  async search(query: string, k: number, scope: PageSearchScope = {}): Promise<PageSearchResult> {
    if (!this.owners || Date.now() - this.owners.at > OWNERS_TTL_MS || (scope.book !== undefined && !this.owners.byBook.has(scope.book))) await this.catalog();
    const owner = scope.book === undefined ? undefined : this.owners!.byBook.get(scope.book);
    if (scope.book !== undefined && owner === undefined) return { hits: [] };
    const results = await Promise.all(this.members.map(async (m, i) => pageSearchResult(owner === undefined || owner === i ? await m.search(query, k, scope) : { hits: [] })));
    const merged: Array<{ hit: PageSearchHit; at: number }> = [];
    results.forEach(({ hits }, i) => {
      for (const hit of hits) {
        const book = parseUnitSlug(hit.slug)?.book;
        const owner = book === undefined ? undefined : this.owners!.byBook.get(book);
        if (owner !== undefined && owner !== i) continue;
        merged.push({ hit, at: merged.length });
      }
    });
    merged.sort((a, b) => (b.hit.score ?? -Infinity) - (a.hit.score ?? -Infinity) || a.at - b.at);
    // The merge is as degraded as its worst library.
    const modes = results.map((r) => r.degraded);
    const degraded = modes.includes('keyword_only') ? 'keyword_only' : modes.includes('unranked') ? 'unranked' : undefined;
    return { hits: merged.slice(0, k).map((x) => x.hit), ...(degraded ? { degraded } : {}) };
  }
}
