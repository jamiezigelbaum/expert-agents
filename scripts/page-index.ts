import { PageIndex, readTreeUnits, voyageClient } from "../packages/runtime/src/workers/domain-expert/page-index.ts";

/**
 * Operator CLI for the page library's search engine (docs/page-library.md).
 *
 *   migrate                                      create tables and indexes
 *   import  --source <id> --tree <dir>           make the index match the tree (idempotent)
 *   embed   --source <id> [--max-tokens N]       embed rows without a vector
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
      console.log(JSON.stringify({ migrated: true }));
    } else if (command === "import") {
      const units = await readTreeUnits(need(rest, "tree"));
      const t = Date.now();
      const r = await index.importUnits(need(rest, "source"), units);
      console.log(JSON.stringify({ ...r, pendingEmbeddings: await index.pendingEmbeddings(need(rest, "source")), seconds: Math.round((Date.now() - t) / 1000) }));
    } else if (command === "embed") {
      if (!process.env.VOYAGE_API_KEY) throw new Error("VOYAGE_API_KEY is not set");
      const max = flag(rest, "max-tokens");
      const r = await index.embedPending(need(rest, "source"), {
        concurrency: Number(flag(rest, "concurrency") ?? 4), ...(max ? { maxTokens: Number(max) } : {}),
        onProgress: (done, tokens) => { if (done % 2048 < 64) console.error(`[embed] ${done} units, ${tokens} tokens`); },
      });
      console.log(JSON.stringify({ ...r, pending: await index.pendingEmbeddings(need(rest, "source")) }));
    } else if (command === "search") {
      if (!process.env.VOYAGE_API_KEY) throw new Error("VOYAGE_API_KEY is not set");
      const hits = await index.search(need(rest, "source"), need(rest, "query"), Number(flag(rest, "k") ?? 10));
      for (const h of hits) console.log(`${h.score?.toFixed(3)}  ${h.slug}  ${h.text.slice(0, 100).replace(/\s+/g, " ")}`);
    } else {
      console.log("usage: bun scripts/page-index.ts migrate | import --source <id> --tree <dir> | embed --source <id> [--max-tokens N] | search --source <id> --query <text> [--k 10]");
    }
  } finally {
    await index.close();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => { console.error((error as Error).message); process.exit(1); });
}
