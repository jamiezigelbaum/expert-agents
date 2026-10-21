import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  PAGE_UNITS_SCHEMA_VERSION,
  bookId,
  derivativeManifest,
  emptyParseUsage,
  offsetUnits,
  pageDerivativePrefix,
  parseObject,
  partOf,
  pool,
  writeBook,
  type BookFigure,
  type BookUnit,
  type CatalogEntry,
  type FigureRecord,
  type OcrLanes,
  type PageDerivativeManifest,
  type PageUnit,
  type ParseUsage,
} from "../packages/library/src/index.ts";

/**
 * The parse-once lane (docs/page-library.md). Three steps, each resumable:
 *
 *   parse     every served original → page-addressed units + figure
 *             descriptions, written as a derivative keyed by the original's
 *             SHA-256 (`derivatives/pages/v2/<xx>/<hex>/`), optionally uploaded
 *             beside the originals in the library bucket.
 *   assemble  derivatives → one Markdown file per unit under books/<book>/,
 *             parts of a split PDF merged back into original page numbers,
 *             plus catalog.json. This tree is what the worker's page tools
 *             read and what the search index imports (from a copy).
 *
 * PDF pages use the text layer (pdftotext). A page without one is rendered and
 * read locally through the model router (OCR_ROUTER_URL): DeepSeek-OCR on its
 * OCR profile, then its deep profile (`delphi/vision-deep`) for pages DeepSeek
 * reads badly. No cloud model is on this path, so no page can
 * be refused. Every page holding an embedded image that is not a whole-page
 * scan gets figure descriptions from the vision lane. Lane results are cached
 * per page, so a rerun reads only pages it has not seen; every call's finish
 * reason and any refusal go to `<out>/lane-calls.jsonl`.
 *
 * Secrets: the Google access token (download and upload only) is read from
 * the environment and never printed.
 */

const run = promisify(execFile);
const RENDER_DPI = 150;
// Lane results are cached under this name; a change of lanes or prompts takes a new one.
const LANE_CACHE = "local-lanes-v1";

interface Args { [key: string]: string | boolean | undefined }

function parseArgs(argv: string[]): { command: string; args: Args } {
  const [command = "help", ...rest] = argv;
  const args: Args = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) args[a.slice(2)] = true;
    else { args[a.slice(2)] = next; i++; }
  }
  return { command, args };
}

function need(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v) throw new Error(`--${key} is required`);
  return v;
}

// ---------- Google Cloud Storage ----------

let cachedToken: { value: string; at: number } | undefined;
async function googleToken(): Promise<string> {
  const fromEnv = process.env.EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_ACCESS_TOKEN;
  if (fromEnv) return fromEnv;
  if (cachedToken && Date.now() - cachedToken.at < 30 * 60_000) return cachedToken.value;
  for (const argv of [["auth", "application-default", "print-access-token"], ["auth", "print-access-token"]]) {
    try {
      const { stdout } = await run("gcloud", argv);
      if (stdout.trim()) { cachedToken = { value: stdout.trim(), at: Date.now() }; return cachedToken.value; }
    } catch { /* try the next credential */ }
  }
  throw new Error("no Google access token: set EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_ACCESS_TOKEN or sign in with gcloud");
}

function splitGcsUri(uri: string): { bucket: string; name: string } {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!m) throw new Error(`not a gs:// URI: ${uri}`);
  return { bucket: m[1]!, name: m[2]! };
}

async function gcsDownload(uri: string): Promise<Uint8Array> {
  const { bucket, name } = splitGcsUri(uri);
  const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}?alt=media`,
    { headers: { Authorization: `Bearer ${await googleToken()}` } });
  if (!res.ok) throw new Error(`GCS download failed (${res.status}) for ${uri}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function gcsUpload(bucket: string, name: string, body: string, contentType: string): Promise<void> {
  const res = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(name)}`,
    { method: "POST", headers: { Authorization: `Bearer ${await googleToken()}`, "Content-Type": contentType }, body });
  if (!res.ok) throw new Error(`GCS upload failed (${res.status}) for gs://${bucket}/${name}`);
}

// ---------- parse ----------

interface SourceRow { uri: string; file: string }

async function loadSources(args: Args): Promise<SourceRow[]> {
  const lines = (await readFile(need(args, "sources"), "utf8")).split("\n").map((l) => l.trim()).filter(Boolean);
  const uris = [...new Set(lines.map((l) => l.split("\t").pop()!).filter((u) => u.startsWith("gs://")))].sort();
  const originals = resolve(need(args, "originals"));
  const indexPath = join(originals, "index.json");
  const index: Record<string, string> = existsSync(indexPath) ? JSON.parse(await readFile(indexPath, "utf8")) : {};
  const byUri = new Map(Object.entries(index).map(([file, uri]) => [uri, file]));
  const rows: SourceRow[] = [];
  for (const uri of uris) {
    let file = byUri.get(uri);
    if (!file) {
      const ext = (extname(splitGcsUri(uri).name).toLowerCase() || ".txt").slice(0, 6);
      file = `${createHash("sha1").update(uri).digest("hex").slice(0, 16)}${ext}`;
      await mkdir(originals, { recursive: true });
      await writeFile(join(originals, file), await gcsDownload(uri));
      index[file] = uri;
      await writeFile(indexPath, JSON.stringify(index, null, 0));
    }
    rows.push({ uri, file: join(originals, file) });
  }
  return rows;
}

interface ParseOptions { ocr: boolean; figures: boolean; force: boolean; lanes?: OcrLanes; laneConcurrency: number; callLog: string }

async function parseOne(row: SourceRow, out: string, cache: string, opts: ParseOptions, usage: ParseUsage): Promise<Record<string, unknown>> {
  const bytes = await readFile(row.file);
  const objectId = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const dir = join(out, pageDerivativePrefix(objectId));
  if (!opts.force && existsSync(join(dir, "manifest.json"))) {
    const m = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as PageDerivativeManifest;
    return { uri: row.uri, objectId, kind: m.kind, units: m.units.length, empty: m.emptyUnits.length, figures: m.figures.length, cached: true };
  }
  const parsed = await parseObject(row.file, {
    ocr: opts.ocr, figures: opts.figures, cacheDir: join(cache, "lane-pages"), laneConcurrency: opts.laneConcurrency, usage,
    ...(opts.lanes ? { lanes: opts.lanes } : {}),
    onCall: (record) => appendFile(opts.callLog, JSON.stringify(record) + "\n"),
  });
  const manifest = derivativeManifest(parsed, row.uri);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "units.jsonl"), parsed.units.map((u) => JSON.stringify(u)).join("\n") + "\n");
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
  const parsers: Record<string, number> = {};
  for (const u of parsed.units) parsers[u.parser] = (parsers[u.parser] ?? 0) + 1;
  return {
    uri: row.uri, objectId, kind: manifest.kind, units: parsed.units.length, empty: manifest.emptyUnits.length, figures: parsed.figures.length, parsers,
    ...(parsed.failures.length ? { failures: parsed.failures } : {}),
    ...(parsed.unresolvedEscalations.length ? { unresolvedEscalations: parsed.unresolvedEscalations } : {}),
    ...(parsed.undescribedFigurePages.length ? { undescribedFigurePages: parsed.undescribedFigurePages } : {}),
  };
}

async function commandParse(args: Args): Promise<void> {
  const out = resolve(need(args, "out"));
  const cache = resolve(typeof args.cache === "string" ? args.cache : join(out, ".cache"));
  const rows = (await loadSources(args)).slice(0, typeof args.limit === "string" ? Number(args.limit) : undefined);
  const usage = emptyParseUsage();
  const routerUrl = process.env.OCR_ROUTER_URL;
  const lanes: OcrLanes | undefined = routerUrl ? { routerUrl, deep: process.env.OCR_DEEP_LANE !== "off" } : undefined;
  if (!lanes && !args["no-ocr"]) throw new Error("OCR_ROUTER_URL is not set (the model router, …/v1); pass --no-ocr to use text layers only");
  await mkdir(out, { recursive: true });
  const opts: ParseOptions = {
    ocr: !args["no-ocr"], figures: !args["no-figures"], force: Boolean(args.force), ...(lanes ? { lanes } : {}),
    laneConcurrency: Number(args["lane-concurrency"] ?? 2), callLog: join(out, "lane-calls.jsonl"),
  };
  const results: Array<Record<string, unknown>> = [];
  let done = 0;
  await pool(rows, Number(args.concurrency ?? 2), async (row) => {
    try { results.push(await parseOne(row, out, cache, opts, usage)); }
    catch (error) { results.push({ uri: row.uri, error: (error as Error).message.slice(0, 200) }); }
    if (++done % 25 === 0) {
      console.error(`[parse] ${done}/${rows.length} ocr=${usage.ocrPages} vision=${usage.visionPages} figures=${usage.figures} refusals=${usage.refusals} failed=${usage.failed}`);
    }
  });
  results.sort((a, b) => String(a.uri).localeCompare(String(b.uri)));
  await writeFile(join(out, "sources.jsonl"), results.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(JSON.stringify({ sources: rows.length, errors: results.filter((r) => r.error).length, ...usage }));
}

// ---------- upload ----------

async function commandUpload(args: Args): Promise<void> {
  const out = resolve(need(args, "out"));
  const bucket = need(args, "bucket");
  const prefix = need(args, "prefix").replace(/\/+$/, "");
  const rows = (await readFile(join(out, "sources.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { objectId?: string });
  const ids = [...new Set(rows.map((r) => r.objectId).filter((x): x is string => Boolean(x)))];
  let n = 0;
  await pool(ids, 8, async (id) => {
    const rel = pageDerivativePrefix(id);
    for (const [file, type] of [["units.jsonl", "application/x-ndjson"], ["manifest.json", "application/json"]] as const) {
      await gcsUpload(bucket, `${prefix}/${rel}/${file}`, await readFile(join(out, rel, file), "utf8"), type);
    }
    if (++n % 100 === 0) console.error(`[upload] ${n}/${ids.length}`);
  });
  console.log(JSON.stringify({ uploaded: ids.length, to: `gs://${bucket}/${prefix}/derivatives/pages/v${PAGE_UNITS_SCHEMA_VERSION}/` }));
}

// ---------- assemble ----------

const ENTITIES: Record<string, string> = { amp: "&", mdash: "—", ndash: "–", quot: '"', apos: "'", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", nbsp: " " };
function decodeEntities(s: string): string {
  return s.replace(/&(#\d+|[a-z]+);/gi, (m, e: string) => e.startsWith("#") ? String.fromCodePoint(Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m);
}

interface Meta { title: string; creator: string }

function metaFromFilename(uri: string): Meta {
  const name = basename(uri).replace(/\.[a-z0-9]{1,5}$/i, "");
  const stem = partOf(name)?.base ?? name;
  const [creator, title] = stem.includes("---") ? stem.split("---", 2) as [string, string] : ["", stem];
  const words = (s: string) => s.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return { creator: words(creator), title: words(title).replace(/\s(19|20)\d\d$/, "") || words(stem) };
}

const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to", "vs", "via", "with"]);
// File names are lower case; a name that already has capitals is left alone.
function titleCase(s: string): string {
  if (s !== s.toLowerCase()) return s;
  return s.split(" ").map((w, i) => i > 0 && SMALL_WORDS.has(w) ? w : w.replace(/(^|[.(-])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase())).join(" ");
}

// Display names only: the book id keeps its own derivation so ids stay stable
// across metadata fixes. An arXiv-style file name ("1209.1179v1") titles the
// book by its first line instead.
function displayMeta(title: string, creator: string, fromManifest: boolean, firstText: string): Meta {
  if (fromManifest) return { title, creator };
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(title)) {
    const line = firstText.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find((l) => l.length >= 10);
    if (line && line.length <= 160) title = line;
  }
  return { title: titleCase(title), creator: titleCase(creator) };
}

async function commandAssemble(args: Args): Promise<void> {
  const out = resolve(need(args, "out"));
  const tree = resolve(need(args, "tree"));
  const master = typeof args.manifest === "string"
    ? new Map((JSON.parse(await readFile(args.manifest, "utf8")).objects as Array<{ id: string; title?: string; creator?: string }>).map((o) => [o.id, o]))
    : new Map<string, { title?: string; creator?: string }>();
  const rows = (await readFile(join(out, "sources.jsonl"), "utf8")).split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as { uri: string; objectId?: string }).filter((r) => r.objectId);
  // Group parts of one split PDF; everything else is its own book. One object served twice is one book.
  const groups = new Map<string, Array<{ uri: string; objectId: string; part: number }>>();
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.objectId!)) continue;
    seen.add(r.objectId!);
    const p = partOf(basename(r.uri));
    const key = p ? `${dirname(r.uri)}/${p.base}` : r.objectId!;
    groups.set(key, [...(groups.get(key) ?? []), { uri: r.uri, objectId: r.objectId!, part: p?.part ?? 1 }]);
  }
  await rm(join(tree, "books"), { recursive: true, force: true });
  const catalog: CatalogEntry[] = [];
  let unitCount = 0, figureCount = 0;
  for (const members of groups.values()) {
    members.sort((a, b) => a.part - b.part);
    const first = members[0]!;
    const m = master.get(first.objectId);
    const fallback = metaFromFilename(first.uri);
    const units: BookUnit[] = [];
    const figures: BookFigure[] = [];
    let offset = 0;
    let kind: "pages" | "sections" = "pages";
    let declared: PageDerivativeManifest["declared"];
    for (const member of members) {
      const dir = join(out, pageDerivativePrefix(member.objectId));
      const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as PageDerivativeManifest;
      kind = manifest.kind;
      declared ??= manifest.declared;
      const own = (await readFile(join(dir, "units.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as PageUnit);
      const moved = offsetUnits(own, offset);
      const rename = new Map(own.map((u, i) => [u.unit, moved[i]!]));
      for (const u of moved) units.push({ ...u, object: member.objectId, source: member.uri });
      for (const f of manifest.figures) {
        const u = rename.get(f.unit);
        if (u) figures.push({ ...f, unit: u.unit, object: member.objectId, source: member.uri, ...(u.sourcePage ? { sourcePage: u.sourcePage } : {}) });
      }
      offset += own.length;
    }
    let title = (m?.title ?? declared?.title ?? fallback.title).replace(/\s*[([]?part\s+\d+\s+of\s+\d+[)\]]?\s*$/i, "").trim() || fallback.title;
    let creator = m?.creator ?? declared?.creator ?? fallback.creator;
    if (!m?.title && !declared?.title && kind === "sections") {
      const h1 = /^#\s+(.{3,120})$/m.exec(units[0]?.text ?? "");
      if (h1 && !members[0]!.uri.includes("---")) title = h1[1]!.trim();
    }
    title = decodeEntities(title);
    const book = bookId(title, first.objectId);
    ({ title, creator } = displayMeta(title, creator, Boolean(m?.title ?? declared?.title), units[0]?.text ?? ""));
    catalog.push(await writeBook(tree, {
      book, title, creator, kind, units, figures,
      ...(declared?.sourceUrl ? { sourceUrl: declared.sourceUrl } : {}), ...(declared?.retrievedAt ? { retrievedAt: declared.retrievedAt } : {}),
      objects: members.map((x) => x.objectId), sources: members.map((x) => x.uri),
    }));
    unitCount += units.length; figureCount += figures.length;
  }
  catalog.sort((a, b) => String(a.book).localeCompare(String(b.book)));
  await writeFile(join(tree, "catalog.json"), JSON.stringify({ schemaVersion: PAGE_UNITS_SCHEMA_VERSION, books: catalog }, null, 1) + "\n");
  console.log(JSON.stringify({ books: catalog.length, units: unitCount, figures: figureCount, tree }));
}

// ---------- main ----------

const HELP = `usage:
  bun scripts/library-pages.ts parse    --sources <tsv|list of gs:// URIs> --originals <dir> --out <dir> [--cache <dir>] [--no-ocr] [--no-figures] [--concurrency 2] [--lane-concurrency 2] [--limit N] [--force]
  bun scripts/library-pages.ts upload   --out <dir> --bucket <bucket> --prefix <library prefix>
  bun scripts/library-pages.ts assemble --out <dir> --tree <dir> [--manifest master.json]
env: OCR_ROUTER_URL (the model router, …/v1: DeepSeek-OCR and the deep profile), OCR_DEEP_LANE=off (no escalation or figures),
     EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_ACCESS_TOKEN or gcloud ADC (GCS)`;

export async function main(argv: string[]): Promise<void> {
  const { command, args } = parseArgs(argv);
  if (command === "parse") return commandParse(args);
  if (command === "upload") return commandUpload(args);
  if (command === "assemble") return commandAssemble(args);
  console.log(HELP);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => { console.error((error as Error).message); process.exit(1); });
}

export { metaFromFilename, readdir };
