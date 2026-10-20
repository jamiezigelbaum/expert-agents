import { PageIndex, readTreeCatalog, readTreeUnits, voyageClient } from "../packages/runtime/src/workers/domain-expert/page-index.ts";

/**
 * Operator CLI for the page library's search engine (docs/page-library.md).
 *
 *   migrate [--reader <role>] [--writer <role>]  create tables and indexes; grant the serving
 *                                                role read and the ingest role write
 *   import  --source <id> --tree <dir> [--books a,b] [--whole-units]
 *                                                make the library match the tree (idempotent):
 *                                                units, front matter and catalog; with --books,
 *                                                only those books, the rest of the library untouched
 *   embed   --source <id> [--max-tokens N]       embed chunks without a vector
 *   search  --source <id> --query <text> [--k 10]
 *
 * env: PAGE_INDEX_DATABASE_URL, VOYAGE_API_KEY (never printed).
 */

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function need(argv: string[], name: string): string {
  const v = flag(argv, name);
  if (!v) throw new Error(`--${name} is required`);
  return v;
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const url = process.env.PAGE_INDEX_DATABASE_URL;
  if (!url) throw new Error("PAGE_INDEX_DATABASE_URL is not set");
  const index = new PageIndex(url, voyageClient(process.env.VOYAGE_API_KEY ?? ""));
  try {
    if (command === "migrate") {
      await index.migrate();
      const reader = flag(rest, "reader"), writer = flag(rest, "writer");
      await index.grant({ ...(reader ? { reader } : {}), ...(writer ? { writer } : {}) });
      console.log(JSON.stringify({ migrated: true, ...(reader ? { reader } : {}), ...(writer ? { writer } : {}) }));
    } else if (command === "import") {
      const tree = need(rest, "tree"), source = need(rest, "source");
      const books = flag(rest, "books")?.split(",").filter(Boolean);
      const units = await readTreeUnits(tree, books);
      const catalog = await readTreeCatalog(tree, books);
      // The catalog is what readers list; a tree without one would empty the library's.
      if (units.length && !catalog.length) throw new Error("the tree has units but no catalog.json entries for them");
      const t = Date.now();
      const r = await index.importUnits(source, units, { chunk: !rest.includes("--whole-units"), ...(books ? { books } : {}) });
      // Units first, then the catalog that lists them.
      const c = await index.replaceBooks(source, catalog, books ? { books } : {});
      console.log(JSON.stringify({ ...r, catalog: c, pendingEmbeddings: await index.pendingEmbeddings(source), seconds: Math.round((Date.now() - t) / 1000) }));
    } else if (command === "embed") {
      if (!process.env.VOYAGE_API_KEY) throw new Error("VOYAGE_API_KEY is not set");
      const max = flag(rest, "max-tokens");
      const r = await index.embedPending(need(rest, "source"), {
        concurrency: Number(flag(rest, "concurrency") ?? 4), ...(max ? { maxTokens: Number(max) } : {}),
        onProgress: (done, tokens) => { if (done % 2048 < 64) console.error(`[embed] ${done} chunks, ${tokens} tokens`); },
      });
      console.log(JSON.stringify({ ...r, pending: await index.pendingEmbeddings(need(rest, "source")) }));
    } else if (command === "search") {
      if (!process.env.VOYAGE_API_KEY) throw new Error("VOYAGE_API_KEY is not set");
      const hits = await index.search(need(rest, "source"), need(rest, "query"), Number(flag(rest, "k") ?? 10));
      for (const h of hits) console.log(`${h.score?.toFixed(3)}  ${h.slug}  ${h.text.slice(0, 100).replace(/\s+/g, " ")}`);
    } else {
      console.log("usage: bun scripts/page-index.ts migrate [--reader <role>] [--writer <role>] | import --source <id> --tree <dir> [--books a,b] | embed --source <id> [--max-tokens N] | search --source <id> --query <text> [--k 10]");
    }
  } finally {
    await index.close();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => { console.error((error as Error).message); process.exit(1); });
}
