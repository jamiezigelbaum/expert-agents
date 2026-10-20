// The page library's search engine: Postgres full text and pgvector over the
// assembled tree, fused with reciprocal rank fusion, then reranked by Voyage.
//
//   import   one row per unit (PDF page, ~1,200-word section or figure), keyed
//            by (source, slug) with a content hash, and its search chunks: a
//            unit up to ~480 words is one chunk; a longer one is cut into
//            ~380-word windows that overlap by 60 words. A re-import changes
//            only units whose text changed and deletes units whose file is
//            gone, so running it twice leaves the index as it was.
//   embed    Voyage `voyage-4` (1024 dimensions) for chunks without a vector.
//            Vectors are also kept by text hash, so a chunk whose text comes
//            back unchanged is never paid for twice.
//   search   two arms over one source's chunks: full text scored by the IDF
//            of the query's content words (ORed, never an AND of a sentence), and
//            nearest vectors. Each arm keeps a unit's best chunk; `rerank-3`
//            orders the vector arm's top 100 and the keyword arm's top 50 by
//            that chunk.
//            Hits are units, so citations stay page- and section-addressed.
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
export const CHUNK_WORDS = 380;
export const CHUNK_OVERLAP_WORDS = 60;
// A unit this short stays one chunk: a typical book page, which keeps its whole-unit vector.
const CHUNK_SPLIT_WORDS = 480;
const ARM_LIMIT = 100;
const ARM_CHUNKS = 400;
// The rerank pool is the vector arm's top 100 and the keyword arm's top 50, deduplicated.
const VECTOR_POOL = 100;
const KEYWORD_POOL = 50;
// Query words in more than this share of the source's chunks carry no signal for the keyword arm.
const KEYWORD_MAX_DF_SHARE = 0.2;
const EMBED_BATCH = 64;
const EMBED_DOC_CHARS = 24_000;
const RERANK_DOC_CHARS = 4_000;
const VOYAGE_URL = 'https://api.voyageai.com/v1';

export interface PageIndexUnit { slug: string; book: string; unit: string; title: string; body: string }

/** The text a unit or chunk is embedded and reranked as: its citation title, then its text. */
export function unitDocument(u: Pick<PageIndexUnit, 'title' | 'body'>, maxChars = EMBED_DOC_CHARS): string {
  return `${u.title}\n\n${u.body}`.slice(0, maxChars);
}

/** A unit's search chunks: the whole body when short, else overlapping word windows that keep the original spacing. */
export function chunkText(body: string, words = CHUNK_WORDS, overlap = CHUNK_OVERLAP_WORDS, splitAt = CHUNK_SPLIT_WORDS): string[] {
  const tokens = body.match(/\S+\s*/g) ?? [];
  if (tokens.length <= splitAt) return [body];
  const chunks: string[] = [];
  for (let start = 0; ; start += words - overlap) {
    const end = Math.min(tokens.length, start + words);
    // A short tail joins the previous window instead of standing alone.
    if (tokens.length - end < overlap * 2 && end < tokens.length) {
      chunks.push(tokens.slice(start).join('').trim());
      break;
    }
    chunks.push(tokens.slice(start, end).join('').trim());
    if (end >= tokens.length) break;
  }
  return chunks;
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

/** One arm's hit: a unit and the chunk of it that matched best. */
export interface ArmHit { slug: string; chunk: number }

export interface ImportResult { units: number; inserted: number; updated: number; unchanged: number; deleted: number; chunks: number; reusedVectors: number }

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
        PRIMARY KEY (source, slug)
      );
      DROP INDEX IF EXISTS page_units_tsv;
      DROP INDEX IF EXISTS page_units_embedding;
      ALTER TABLE page_units DROP COLUMN IF EXISTS tsv, DROP COLUMN IF EXISTS embedding, DROP COLUMN IF EXISTS embed_key;
      CREATE TABLE IF NOT EXISTS page_chunks (
        source text NOT NULL,
        slug text NOT NULL,
        chunk int NOT NULL,
        title text NOT NULL,
        text text NOT NULL,
        embed_key text NOT NULL,
        embedding vector(${PAGE_INDEX_DIMENSIONS}),
        tsv tsvector GENERATED ALWAYS AS (
          setweight(to_tsvector('english', title), 'B') || setweight(to_tsvector('english', text), 'A')) STORED,
        PRIMARY KEY (source, slug, chunk),
        FOREIGN KEY (source, slug) REFERENCES page_units (source, slug) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS page_chunks_tsv ON page_chunks USING gin (tsv);
      CREATE INDEX IF NOT EXISTS page_chunks_embedding ON page_chunks USING hnsw (embedding vector_cosine_ops);
      CREATE TABLE IF NOT EXISTS page_embeddings (
        embed_key text PRIMARY KEY,
        embedding vector(${PAGE_INDEX_DIMENSIONS}) NOT NULL
      );
    `);
  }

  /** Make the index for `source` match `units` exactly. Vectors survive for unchanged text. */
  async importUnits(source: string, units: readonly PageIndexUnit[], opts: { chunk?: boolean } = {}): Promise<ImportResult> {
    const existing = new Map<string, string>();
    // A unit without chunks (an import cut short) counts as changed.
    for (const r of await this.sql`
      SELECT u.slug, CASE WHEN EXISTS (SELECT 1 FROM page_chunks c WHERE c.source = u.source AND c.slug = u.slug) THEN u.content_hash ELSE '' END AS content_hash
      FROM page_units u WHERE u.source = ${source}` as Array<{ slug: string; content_hash: string }>) {
      existing.set(r.slug, r.content_hash);
    }
    const result: ImportResult = { units: units.length, inserted: 0, updated: 0, unchanged: 0, deleted: 0, chunks: 0, reusedVectors: 0 };
    const seen = new Set<string>();
    const changed: Array<PageIndexUnit & { hash: string }> = [];
    for (const u of units) {
      if (seen.has(u.slug)) throw new Error(`duplicate unit ${u.slug}`);
      seen.add(u.slug);
      const hash = contentHash(u);
      const before = existing.get(u.slug);
      if (before === hash) { result.unchanged++; continue; }
      if (before === undefined) result.inserted++; else result.updated++;
      changed.push({ ...u, hash });
    }
    for (let i = 0; i < changed.length; i += 500) {
      const batch = changed.slice(i, i + 500);
      const rows = batch.map((u) => ({ source, slug: u.slug, book: u.book, unit: u.unit, title: u.title, body: u.body, content_hash: u.hash }));
      const chunks = batch.flatMap((u) => (opts.chunk === false ? [u.body] : chunkText(u.body)).map((text, chunk) => ({
        source, slug: u.slug, chunk, title: u.title, text, embed_key: embeddingKey(this.model, PAGE_INDEX_DIMENSIONS, unitDocument({ title: u.title, body: text })),
      })));
      await this.sql.begin(async (tx) => {
        await tx`
          INSERT INTO page_units ${tx(rows)}
          ON CONFLICT (source, slug) DO UPDATE SET book = EXCLUDED.book, unit = EXCLUDED.unit, title = EXCLUDED.title,
            body = EXCLUDED.body, content_hash = EXCLUDED.content_hash`;
        await tx`DELETE FROM page_chunks WHERE source = ${source} AND slug = ANY(string_to_array(${csv(rows.map((r) => r.slug))}, ','))`;
        for (let j = 0; j < chunks.length; j += 1000) await tx`INSERT INTO page_chunks ${tx(chunks.slice(j, j + 1000))}`;
      });
      result.chunks += chunks.length;
      const reused = await this.sql`
        UPDATE page_chunks c SET embedding = e.embedding FROM page_embeddings e
        WHERE c.source = ${source} AND c.embed_key = e.embed_key AND c.slug = ANY(string_to_array(${csv(rows.map((r) => r.slug))}, ',')) RETURNING c.slug`;
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
    const [r] = await this.sql`SELECT count(*)::int AS n FROM page_chunks WHERE source = ${source} AND embedding IS NULL` as Array<{ n: number }>;
    return r?.n ?? 0;
  }

  /** Embed chunks without a vector, in batches. Stops early once `maxTokens` is spent. */
  async embedPending(source: string, opts: { concurrency?: number; maxTokens?: number; onProgress?: (done: number, tokens: number) => void } = {}): Promise<{ embedded: number; tokens: number }> {
    let embedded = 0, tokens = 0;
    // One pending list, cut into batches: each text is embedded once even when chunks share it.
    const pending = await this.sql`
      SELECT DISTINCT ON (embed_key) embed_key, title, text AS body FROM page_chunks
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
        const done = await this.sql`UPDATE page_chunks c SET embedding = e.embedding FROM page_embeddings e
          WHERE c.source = ${source} AND c.embedding IS NULL AND c.embed_key = e.embed_key AND c.embed_key = ANY(string_to_array(${csv(keys)}, ',')) RETURNING c.slug`;
        embedded += done.length;
        opts.onProgress?.(embedded, tokens);
      }
    };
    await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker));
    return { embedded, tokens };
  }

  private readonly docFreq = new Map<string, number>();
  private readonly chunkCount = new Map<string, number>();

  /**
   * Units whose chunks hold the query's content words, best chunk first. Postgres full text has no
   * notion of a word's rarity, so ts_rank over a sentence's words ORed favours long chunks full of
   * common words. Each chunk instead scores the summed IDF of the query words it holds (BM25's
   * weight without length normalisation); words in over a fifth of the chunks are dropped.
   */
  async keywordArm(source: string, query: string, limit = ARM_LIMIT): Promise<ArmHit[]> {
    const lexemes = await this.sql`SELECT unnest(tsvector_to_array(to_tsvector('english', ${query}))) AS t` as Array<{ t: string }>;
    const terms = [...new Set(lexemes.map((r) => r.t))].filter((t) => /^[\p{L}\p{N}]+$/u.test(t));
    if (!terms.length) return [];
    if (!this.chunkCount.has(source)) {
      const [r] = await this.sql`SELECT count(*)::int AS n FROM page_chunks WHERE source = ${source}` as Array<{ n: number }>;
      this.chunkCount.set(source, r?.n ?? 0);
    }
    const n = this.chunkCount.get(source)!;
    const unknown = terms.filter((t) => !this.docFreq.has(`${source}\0${t}`));
    if (unknown.length) {
      const rows = await this.sql`
        SELECT t, (SELECT count(*)::int FROM page_chunks WHERE source = ${source} AND tsv @@ to_tsquery('simple', t)) AS df
        FROM unnest(string_to_array(${csv(unknown)}, ',')) AS t` as Array<{ t: string; df: number }>;
      for (const r of rows) this.docFreq.set(`${source}\0${r.t}`, r.df);
    }
    const weighted = terms
      .map((t) => ({ t, df: this.docFreq.get(`${source}\0${t}`) ?? 0 }))
      .filter((w) => w.df > 0 && w.df <= n * KEYWORD_MAX_DF_SHARE)
      .map((w) => ({ t: w.t, idf: Math.log(1 + (n - w.df + 0.5) / (w.df + 0.5)) }));
    if (!weighted.length) return [];
    return await this.sql`
      WITH w AS (SELECT t, idf::float8 AS idf FROM unnest(string_to_array(${csv(weighted.map((x) => x.t))}, ','), string_to_array(${weighted.map((x) => x.idf.toFixed(6)).join(',')}, ',')) AS x(t, idf)),
      cand AS (SELECT slug, chunk, tsv FROM page_chunks WHERE source = ${source} AND tsv @@ to_tsquery('simple', ${weighted.map((x) => x.t).join(' | ')})),
      scored AS (SELECT c.slug, c.chunk, sum(w.idf) AS score FROM cand c JOIN w ON c.tsv @@ to_tsquery('simple', w.t) GROUP BY c.slug, c.chunk)
      SELECT slug, chunk FROM (SELECT DISTINCT ON (slug) slug, chunk, score FROM scored ORDER BY slug, score DESC, chunk) best
      ORDER BY score DESC, slug LIMIT ${limit}` as ArmHit[];
  }

  /** Units whose chunks lie nearest the query vector, best chunk first. */
  async vectorArm(source: string, vector: readonly number[], limit = ARM_LIMIT): Promise<ArmHit[]> {
    const v = vectorLiteral(vector);
    const rows = await this.sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL hnsw.ef_search = ${ARM_CHUNKS}`);
      return await tx`SELECT slug, chunk FROM page_chunks WHERE source = ${source} AND embedding IS NOT NULL
        ORDER BY embedding <=> ${v}::vector LIMIT ${ARM_CHUNKS}`;
    }) as ArmHit[];
    const best = new Map<string, ArmHit>();
    for (const r of rows) if (!best.has(r.slug)) best.set(r.slug, r);
    return [...best.values()].slice(0, limit);
  }

  async search(source: string, query: string, k: number): Promise<PageSearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    const [keyword, embedded] = await Promise.all([this.keywordArm(source, q), this.voyage.embed([q], 'query')]);
    this.tokens.embed += embedded.tokens;
    const vector = await this.vectorArm(source, embedded.vectors[0]!);
    const pooled = new Set([...vector.slice(0, VECTOR_POOL), ...keyword.slice(0, KEYWORD_POOL)].map((h) => h.slug));
    const fused = reciprocalRankFusion([keyword.map((h) => h.slug), vector.map((h) => h.slug)]).filter((f) => pooled.has(f.slug));
    if (!fused.length) return [];
    // Each unit is reranked by its best chunk: the vector arm's when it has one, else the keyword arm's.
    const bestChunk = new Map<string, number>();
    for (const h of [...keyword].reverse()) bestChunk.set(h.slug, h.chunk);
    for (const h of vector) bestChunk.set(h.slug, h.chunk);
    const slugs = fused.map((f) => f.slug);
    const rows = await this.sql`
      SELECT u.slug, u.title, u.body, c.chunk, c.text FROM page_units u JOIN page_chunks c ON c.source = u.source AND c.slug = u.slug
      WHERE u.source = ${source} AND u.slug = ANY(string_to_array(${csv(slugs)}, ','))` as Array<{ slug: string; title: string; body: string; chunk: number; text: string }>;
    const bySlug = new Map<string, { slug: string; title: string; body: string; passage: string }>();
    for (const r of rows) {
      if (r.chunk === bestChunk.get(r.slug)) bySlug.set(r.slug, { slug: r.slug, title: r.title, body: r.body, passage: r.text });
    }
    const pool = slugs.map((s) => bySlug.get(s)).filter((r): r is { slug: string; title: string; body: string; passage: string } => Boolean(r));
    const ranked = await this.voyage.rerank(q, pool.map((r) => unitDocument({ title: r.title, body: r.passage }, RERANK_DOC_CHARS)), Math.min(k, pool.length));
    this.tokens.rerank += ranked.tokens;
    return ranked.order.map(({ index, score }) => ({ slug: pool[index]!.slug, text: pool[index]!.body, score }));
  }
}
