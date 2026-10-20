// The page library's search engine: Postgres full text and pgvector over the
// assembled tree, fused with reciprocal rank fusion, then reranked by Voyage.
//
//   import   one row per unit (PDF page, ~1,200-word section or figure), keyed
//            by (source, slug) with a content hash. A re-import changes only
//            rows whose text changed and deletes rows whose file is gone, so
//            running it twice leaves the index as it was.
//   embed    Voyage `voyage-4` (1024 dimensions) for rows without a vector.
//            Vectors are also kept by text hash, so a unit whose text comes
//            back unchanged is never paid for twice.
//   search   two arms over one source: full text with the query's words ORed
//            (a sentence query is not an AND of every word), and nearest
//            vectors. RRF merges them and `rerank-3` orders the top of the list.
//
// Secrets (the database URL and the Voyage key) come from the caller and are
// never part of an error.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SQL } from 'bun';
import { parseUnitSlug, unitBody } from '@expert-agents/library';
import { PageLibraryError, type PageSearchHit } from './page-library.ts';

export const PAGE_INDEX_EMBED_MODEL = 'voyage-4';
export const PAGE_INDEX_DIMENSIONS = 1024;
export const PAGE_INDEX_RERANK_MODEL = 'rerank-3';
export const RRF_K = 60;
const ARM_LIMIT = 100;
const RERANK_POOL = 60;
const EMBED_BATCH = 64;
const EMBED_DOC_CHARS = 24_000;
const RERANK_DOC_CHARS = 4_000;
const VOYAGE_URL = 'https://api.voyageai.com/v1';

export interface PageIndexUnit { slug: string; book: string; unit: string; title: string; body: string }

/** The text a unit is embedded and reranked as: its citation title, then its body. */
export function unitDocument(u: Pick<PageIndexUnit, 'title' | 'body'>, maxChars = EMBED_DOC_CHARS): string {
  return `${u.title}\n\n${u.body}`.slice(0, maxChars);
}

export function contentHash(u: Pick<PageIndexUnit, 'title' | 'body'>): string {
  return createHash('sha256').update(u.title).update('\0').update(u.body).digest('hex');
}

export function embeddingKey(model: string, dimensions: number, text: string): string {
  return createHash('sha256').update(`${model}\0${dimensions}\0`).update(text).digest('hex');
}

/** Merge ranked lists: each slug scores the sum of 1/(k + rank) over the lists it appears in. */
export function reciprocalRankFusion(lists: ReadonlyArray<readonly string[]>, k = RRF_K): Array<{ slug: string; score: number }> {
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((slug, i) => scores.set(slug, (scores.get(slug) ?? 0) + 1 / (k + i + 1)));
  return [...scores].map(([slug, score]) => ({ slug, score })).sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
}

/** Read every unit of an assembled tree (books/<book>/<unit>.md). */
export async function readTreeUnits(root: string): Promise<PageIndexUnit[]> {
  const units: PageIndexUnit[] = [];
  const books = (await readdir(join(root, 'books'), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const book of books) {
    for (const file of (await readdir(join(root, 'books', book))).filter((f) => f.endsWith('.md')).sort()) {
      const slug = `books/${book}/${file.slice(0, -3)}`;
      if (!parseUnitSlug(slug)) continue;
      // Postgres text cannot hold NUL, which some PDF text layers carry.
      const md = (await readFile(join(root, 'books', book, file), 'utf8')).replaceAll('\0', '');
      const title = /^title:\s*(.*)$/m.exec(md.slice(0, md.indexOf('\n---', 4)))?.[1] ?? '';
      let parsedTitle = title;
      try { parsedTitle = JSON.parse(title); } catch { /* plain YAML scalar */ }
      units.push({ slug, book, unit: file.slice(0, -3), title: parsedTitle, body: unitBody(md) });
    }
  }
  return units;
}

export interface VoyageClient {
  embed(texts: string[], inputType: 'document' | 'query'): Promise<{ vectors: number[][]; tokens: number }>;
  rerank(query: string, documents: string[], topK: number): Promise<{ order: Array<{ index: number; score: number }>; tokens: number }>;
}

export function voyageClient(apiKey: string, opts: { embedModel?: string; rerankModel?: string; fetch?: typeof fetch } = {}): VoyageClient {
  const f = opts.fetch ?? fetch;
  async function call<T>(path: string, body: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await f(`${VOYAGE_URL}/${path}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
        });
      } catch {
        if (attempt < 4) { await Bun.sleep(2000 * (attempt + 1)); continue; }
        throw new PageLibraryError('page_search_unavailable', `Voyage ${path} is unreachable`, 503);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 6) { await Bun.sleep(3000 * (attempt + 1)); continue; }
      if (!res.ok) throw new PageLibraryError('page_search_failed', `Voyage ${path} answered ${res.status}`, 502);
      return await res.json() as T;
    }
  }
  return {
    async embed(texts, inputType) {
      const r = await call<{ data: Array<{ index: number; embedding: number[] }>; usage?: { total_tokens?: number } }>('embeddings', {
        input: texts, model: opts.embedModel ?? PAGE_INDEX_EMBED_MODEL, input_type: inputType, output_dimension: PAGE_INDEX_DIMENSIONS,
      });
      const vectors: number[][] = [];
      for (const d of r.data) vectors[d.index] = d.embedding;
      return { vectors, tokens: r.usage?.total_tokens ?? 0 };
    },
    async rerank(query, documents, topK) {
      const r = await call<{ data: Array<{ index: number; relevance_score: number }>; usage?: { total_tokens?: number } }>('rerank', {
        query, documents, model: opts.rerankModel ?? PAGE_INDEX_RERANK_MODEL, top_k: topK, truncation: true,
      });
      return { order: r.data.map((d) => ({ index: d.index, score: d.relevance_score })), tokens: r.usage?.total_tokens ?? 0 };
    },
  };
}

const vectorLiteral = (v: readonly number[]) => `[${v.join(',')}]`;
// Array parameters go over as one comma-joined text; slugs and hex keys never hold a comma.
function csv(values: readonly string[]): string {
  if (values.some((v) => v.includes(','))) throw new Error('a key holds a comma');
  return values.join(',');
}

export interface ImportResult { units: number; inserted: number; updated: number; unchanged: number; deleted: number; reusedVectors: number }

export class PageIndex {
  readonly sql: SQL;
  private readonly model: string;
  /** Tokens sent to Voyage by this instance, for spend receipts. */
  readonly tokens = { embed: 0, rerank: 0 };

  constructor(databaseUrl: string, private readonly voyage: VoyageClient, opts: { embedModel?: string; maxConnections?: number } = {}) {
    this.sql = new SQL({ url: databaseUrl, max: opts.maxConnections ?? 8 });
    this.model = opts.embedModel ?? PAGE_INDEX_EMBED_MODEL;
  }

  async close(): Promise<void> { await this.sql.close(); }

  async migrate(): Promise<void> {
    await this.sql.unsafe(`
      CREATE EXTENSION IF NOT EXISTS vector;
      CREATE TABLE IF NOT EXISTS page_units (
        source text NOT NULL,
        slug text NOT NULL,
        book text NOT NULL,
        unit text NOT NULL,
        title text NOT NULL,
        body text NOT NULL,
        content_hash text NOT NULL,
        embed_key text,
        embedding vector(${PAGE_INDEX_DIMENSIONS}),
        tsv tsvector GENERATED ALWAYS AS (
          setweight(to_tsvector('english', title), 'B') || setweight(to_tsvector('english', body), 'A')) STORED,
        PRIMARY KEY (source, slug)
      );
      CREATE INDEX IF NOT EXISTS page_units_tsv ON page_units USING gin (tsv);
      CREATE INDEX IF NOT EXISTS page_units_embedding ON page_units USING hnsw (embedding vector_cosine_ops);
      CREATE TABLE IF NOT EXISTS page_embeddings (
        embed_key text PRIMARY KEY,
        embedding vector(${PAGE_INDEX_DIMENSIONS}) NOT NULL
      );
    `);
  }

  /** Make the index for `source` match `units` exactly. Vectors survive for unchanged text. */
  async importUnits(source: string, units: readonly PageIndexUnit[]): Promise<ImportResult> {
    const existing = new Map<string, string>();
    for (const r of await this.sql`SELECT slug, content_hash FROM page_units WHERE source = ${source}` as Array<{ slug: string; content_hash: string }>) {
      existing.set(r.slug, r.content_hash);
    }
    const result: ImportResult = { units: units.length, inserted: 0, updated: 0, unchanged: 0, deleted: 0, reusedVectors: 0 };
    const seen = new Set<string>();
    const changed: Array<PageIndexUnit & { hash: string; key: string }> = [];
    for (const u of units) {
      if (seen.has(u.slug)) throw new Error(`duplicate unit ${u.slug}`);
      seen.add(u.slug);
      const hash = contentHash(u);
      const before = existing.get(u.slug);
      if (before === hash) { result.unchanged++; continue; }
      if (before === undefined) result.inserted++; else result.updated++;
      changed.push({ ...u, hash, key: embeddingKey(this.model, PAGE_INDEX_DIMENSIONS, unitDocument(u)) });
    }
    for (let i = 0; i < changed.length; i += 500) {
      const rows = changed.slice(i, i + 500).map((u) => ({
        source, slug: u.slug, book: u.book, unit: u.unit, title: u.title, body: u.body, content_hash: u.hash, embed_key: u.key,
      }));
      await this.sql`
        INSERT INTO page_units ${this.sql(rows)}
        ON CONFLICT (source, slug) DO UPDATE SET book = EXCLUDED.book, unit = EXCLUDED.unit, title = EXCLUDED.title,
          body = EXCLUDED.body, content_hash = EXCLUDED.content_hash, embed_key = EXCLUDED.embed_key, embedding = NULL`;
      const keys = rows.map((r) => r.embed_key);
      const reused = await this.sql`
        UPDATE page_units u SET embedding = e.embedding FROM page_embeddings e
        WHERE u.source = ${source} AND u.embed_key = e.embed_key AND u.embed_key = ANY(string_to_array(${csv(keys)}, ',')) RETURNING u.slug`;
      result.reusedVectors += reused.length;
    }
    const gone = [...existing.keys()].filter((s) => !seen.has(s));
    for (let i = 0; i < gone.length; i += 1000) {
      await this.sql`DELETE FROM page_units WHERE source = ${source} AND slug = ANY(string_to_array(${csv(gone.slice(i, i + 1000))}, ','))`;
    }
    result.deleted = gone.length;
    return result;
  }

  async pendingEmbeddings(source: string): Promise<number> {
    const [r] = await this.sql`SELECT count(*)::int AS n FROM page_units WHERE source = ${source} AND embedding IS NULL` as Array<{ n: number }>;
    return r?.n ?? 0;
  }

  /** Embed rows without a vector, in batches. Stops early once `maxTokens` is spent. */
  async embedPending(source: string, opts: { concurrency?: number; maxTokens?: number; onProgress?: (done: number, tokens: number) => void } = {}): Promise<{ embedded: number; tokens: number }> {
    let embedded = 0, tokens = 0;
    // One pending list, cut into batches: each text is embedded once even when units share it.
    const pending = await this.sql`
      SELECT DISTINCT ON (embed_key) embed_key, title, body FROM page_units
      WHERE source = ${source} AND embedding IS NULL ORDER BY embed_key` as Array<{ embed_key: string; title: string; body: string }>;
    const batches: Array<typeof pending> = [];
    for (let i = 0; i < pending.length; i += EMBED_BATCH) batches.push(pending.slice(i, i + EMBED_BATCH));
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        if (opts.maxTokens && tokens >= opts.maxTokens) return;
        const rows = batches[next++]!;
        const { vectors, tokens: used } = await this.voyage.embed(rows.map((r) => unitDocument(r)), 'document');
        tokens += used; this.tokens.embed += used;
        const cache = rows.map((r, i) => ({ embed_key: r.embed_key, embedding: vectorLiteral(vectors[i]!) }));
        await this.sql`INSERT INTO page_embeddings ${this.sql(cache)} ON CONFLICT (embed_key) DO NOTHING`;
        const keys = rows.map((r) => r.embed_key);
        const done = await this.sql`UPDATE page_units u SET embedding = e.embedding FROM page_embeddings e
          WHERE u.source = ${source} AND u.embedding IS NULL AND u.embed_key = e.embed_key AND u.embed_key = ANY(string_to_array(${csv(keys)}, ',')) RETURNING u.slug`;
        embedded += done.length;
        opts.onProgress?.(embedded, tokens);
      }
    };
    await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker));
    return { embedded, tokens };
  }

  async keywordArm(source: string, query: string, limit = ARM_LIMIT): Promise<string[]> {
    const rows = await this.sql`
      WITH q AS (SELECT to_tsquery('english', replace(plainto_tsquery('english', ${query})::text, ' & ', ' | ')) AS q)
      SELECT slug FROM page_units, q
      WHERE source = ${source} AND q.q::text <> '' AND tsv @@ q.q
      ORDER BY ts_rank_cd(tsv, q.q, 1) DESC, slug LIMIT ${limit}` as Array<{ slug: string }>;
    return rows.map((r) => r.slug);
  }

  async vectorArm(source: string, vector: readonly number[], limit = ARM_LIMIT): Promise<string[]> {
    const v = vectorLiteral(vector);
    const rows = await this.sql.begin(async (tx) => {
      await tx`SET LOCAL hnsw.ef_search = 200`;
      return await tx`SELECT slug FROM page_units WHERE source = ${source} AND embedding IS NOT NULL
        ORDER BY embedding <=> ${v}::vector LIMIT ${limit}`;
    }) as Array<{ slug: string }>;
    return rows.map((r) => r.slug);
  }

  async search(source: string, query: string, k: number): Promise<PageSearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    const [keyword, embedded] = await Promise.all([this.keywordArm(source, q), this.voyage.embed([q], 'query')]);
    this.tokens.embed += embedded.tokens;
    const vector = await this.vectorArm(source, embedded.vectors[0]!);
    const fused = reciprocalRankFusion([keyword, vector]).slice(0, RERANK_POOL);
    if (!fused.length) return [];
    const slugs = fused.map((f) => f.slug);
    const rows = await this.sql`SELECT slug, title, body FROM page_units WHERE source = ${source} AND slug = ANY(string_to_array(${csv(slugs)}, ','))` as Array<{ slug: string; title: string; body: string }>;
    const bySlug = new Map(rows.map((r) => [r.slug, r]));
    const pool = slugs.map((s) => bySlug.get(s)).filter((r): r is { slug: string; title: string; body: string } => Boolean(r));
    const ranked = await this.voyage.rerank(q, pool.map((r) => unitDocument(r, RERANK_DOC_CHARS)), Math.min(k, pool.length));
    this.tokens.rerank += ranked.tokens;
    return ranked.order.map(({ index, score }) => ({ slug: pool[index]!.slug, text: pool[index]!.body, score }));
  }
}
