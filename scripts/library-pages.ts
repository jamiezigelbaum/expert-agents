import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  PAGE_UNITS_SCHEMA_VERSION,
  bookId,
  offsetUnits,
  pageDerivativePrefix,
  pageNeedsOcr,
  partOf,
  renderUnitMarkdown,
  sectionText,
  splitPdfText,
  unitName,
  type FigureRecord,
  type PageDerivativeManifest,
  type PageUnit,
  type UnitParser,
  describeFigures,
  figurePagesFromImageList,
  hasFigureCaption,
  ocrPage,
  type LaneCall,
  type OcrLanes,
} from "../packages/library/src/index.ts";

/**
 * The parse-once lane (docs/page-library.md). Three steps, each resumable:
 *
 *   parse     every served original → page-addressed units + figure
 *             descriptions, written as a derivative keyed by the original's
 *             SHA-256 (`derivatives/pages/v1/<xx>/<hex>/`), optionally uploaded
 *             beside the originals in the library bucket.
 *   assemble  derivatives → one Markdown file per unit under books/<book>/,
 *             parts of a split PDF merged back into original page numbers,
 *             plus catalog.json. This tree is what the worker's page tools
 *             read and what the search index imports (from a copy).
 *
 * PDF pages use the text layer (pdftotext). A page without one is rendered and
 * read locally: DeepSeek-OCR through Ollama (OLLAMA_URL), then the vision lane
 * (VISION_URL, an OpenAI-compatible endpoint such as `delphi/vision-deep`) for
 * pages DeepSeek reads badly. No cloud model is on this path, so no page can
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

// ---------- pages ----------

async function renderPage(pdf: string, page: number, dir: string): Promise<Uint8Array> {
  const out = join(dir, `p${page}`);
  await run("pdftoppm", ["-r", String(RENDER_DPI), "-jpeg", "-f", String(page), "-l", String(page), "-singlefile", pdf, out]);
  const jpg = await readFile(`${out}.jpg`);
  await rm(`${out}.jpg`, { force: true });
  return jpg;
}

/** Pages holding an embedded image that is not a whole-page scan (judged per page). */
async function figurePages(pdf: string, pageCount: number): Promise<number[]> {
  let list = "", info = "";
  try {
    list = (await run("pdfimages", ["-list", pdf], { maxBuffer: 64 * 1024 * 1024 })).stdout;
    info = (await run("pdfinfo", ["-f", "1", "-l", String(pageCount), pdf], { maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch { return []; }
  const sizes = new Map<number, { w: number; h: number }>();
  for (const m of info.matchAll(/^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+)/gm)) sizes.set(Number(m[1]), { w: Number(m[2]), h: Number(m[3]) });
  return figurePagesFromImageList(list, (p) => sizes.get(p));
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

interface Usage { ocrPages: number; deepseekPages: number; visionPages: number; escalated: Record<string, number>; figurePages: number; figures: number; refusals: number; failed: number }

interface PageCache { ocr?: { text: string; parser: UnitParser; escalated?: string }; figures?: FigureRecord[]; calls: LaneCall[] }

async function lanePage(cacheDir: string, hex: string, page: number, kind: "ocr" | "figures", read: () => Promise<PageCache>): Promise<PageCache> {
  const path = join(cacheDir, LANE_CACHE, hex.slice(0, 2), hex, `${page}-${kind}.json`);
  if (existsSync(path)) return JSON.parse(await readFile(path, "utf8"));
  const result = await read();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(result));
  return result;
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

interface ParseOptions { ocr: boolean; figures: boolean; force: boolean; lanes?: OcrLanes; laneConcurrency: number; callLog: string }

async function parseOne(row: SourceRow, out: string, cache: string, opts: ParseOptions, usage: Usage): Promise<Record<string, unknown>> {
  const bytes = await readFile(row.file);
  const hex = createHash("sha256").update(bytes).digest("hex");
  const objectId = `sha256:${hex}`;
  const dir = join(out, pageDerivativePrefix(objectId));
  if (!opts.force && existsSync(join(dir, "manifest.json"))) {
    const m = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as PageDerivativeManifest;
    return { uri: row.uri, objectId, kind: m.kind, units: m.units.length, empty: m.emptyUnits.length, figures: m.figures.length, cached: true };
  }
  const isPdf = bytes.subarray(0, 5).toString() === "%PDF-";
  const units: PageUnit[] = [];
  const figures: FigureRecord[] = [];
  if (isPdf) {
    const { stdout } = await run("pdftotext", ["-enc", "UTF-8", row.file, "-"], { maxBuffer: 512 * 1024 * 1024 });
    const pages = splitPdfText(stdout);
    pages.forEach((text, i) => units.push({ unit: unitName("p", i + 1), sourcePage: i + 1, parser: pageNeedsOcr(text) ? "none" : "pdftotext", text: text.trim() }));
    const lanes = opts.lanes;
    if (lanes) {
      const tmp = await mkdtemp(join(tmpdir(), "page-render-"));
      try {
        const ocrPages = opts.ocr ? units.filter((u) => u.parser === "none").map((u) => u.sourcePage!) : [];
        const figPages = opts.figures && lanes.visionUrl
          ? [...new Set([...await figurePages(row.file, pages.length),
            ...units.filter((u) => u.parser === "pdftotext" && hasFigureCaption(u.text)).map((u) => u.sourcePage!)])].sort((a, b) => a - b)
          : [];
        const jobs = [...ocrPages.map((p) => ({ p, kind: "ocr" as const })), ...figPages.map((p) => ({ p, kind: "figures" as const }))];
        await pool(jobs, opts.laneConcurrency, async ({ p, kind }) => {
          const unit = units[p - 1];
          if (!unit) return;
          let r: PageCache;
          try {
            r = await lanePage(join(cache, "lane-pages"), hex, p, kind, async () => {
              const img = await renderPage(row.file, p, tmp);
              const tag = `${hex.slice(0, 12)}:${p}:${kind}`;
              if (kind === "ocr") {
                const o = await ocrPage(img, tag, lanes);
                return { ocr: { text: o.text, parser: o.parser, ...(o.escalated ? { escalated: o.escalated } : {}) }, calls: o.calls };
              }
              const f = await describeFigures(img, unit.unit, tag, lanes);
              return { figures: f.figures, calls: [f.call] };
            });
          } catch (error) {
            usage.failed++;
            await appendFile(opts.callLog, JSON.stringify({ object: objectId, page: p, kind, error: (error as Error).message.slice(0, 160) }) + "\n");
            return;
          }
          await appendFile(opts.callLog, JSON.stringify({ object: objectId, page: p, kind, calls: r.calls }) + "\n");
          usage.refusals += r.calls.filter((c) => c.refusal).length;
          if (r.ocr) {
            usage.ocrPages++;
            if (r.ocr.parser === "deepseek-ocr") usage.deepseekPages++;
            if (r.ocr.parser === "vision") usage.visionPages++;
            if (r.ocr.escalated) usage.escalated[r.ocr.escalated] = (usage.escalated[r.ocr.escalated] ?? 0) + 1;
            if (r.ocr.text.trim()) { unit.text = r.ocr.text; unit.parser = r.ocr.parser; }
          }
          if (r.figures) { usage.figurePages++; usage.figures += r.figures.length; figures.push(...r.figures); }
        });
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    }
  } else {
    const text = new TextDecoder().decode(bytes);
    sectionText(text).forEach((s, i) => units.push({ unit: unitName("s", i + 1), ...(s.heading ? { heading: s.heading } : {}), parser: "text", text: s.text }));
  }
  figures.sort((a, b) => a.unit.localeCompare(b.unit) || a.label.localeCompare(b.label));
  const manifest: PageDerivativeManifest = {
    schemaVersion: PAGE_UNITS_SCHEMA_VERSION,
    objectId,
    sourceUri: row.uri,
    kind: isPdf ? "pages" : "sections",
    units: units.map(({ text, ...u }) => ({ ...u, chars: text.length })),
    figures,
    emptyUnits: units.filter((u) => pageNeedsOcr(u.text) && u.parser !== "text").map((u) => u.unit),
  };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "units.jsonl"), units.map((u) => JSON.stringify(u)).join("\n") + "\n");
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
  const parsers: Record<string, number> = {};
  for (const u of units) parsers[u.parser] = (parsers[u.parser] ?? 0) + 1;
  return { uri: row.uri, objectId, kind: manifest.kind, units: units.length, empty: manifest.emptyUnits.length, figures: figures.length, parsers };
}

async function commandParse(args: Args): Promise<void> {
  const out = resolve(need(args, "out"));
  const cache = resolve(typeof args.cache === "string" ? args.cache : join(out, ".cache"));
  const rows = (await loadSources(args)).slice(0, typeof args.limit === "string" ? Number(args.limit) : undefined);
  const usage: Usage = { ocrPages: 0, deepseekPages: 0, visionPages: 0, escalated: {}, figurePages: 0, figures: 0, refusals: 0, failed: 0 };
  const ollamaUrl = process.env.OLLAMA_URL;
  const visionUrl = process.env.VISION_URL;
  const visionModel = process.env.VISION_MODEL;
  const lanes: OcrLanes | undefined = ollamaUrl ? { ollamaUrl, ...(visionUrl ? { visionUrl } : {}), ...(visionModel ? { visionModel } : {}) } : undefined;
  if (!lanes && !args["no-ocr"]) throw new Error("OLLAMA_URL is not set (DeepSeek-OCR); pass --no-ocr to use text layers only");
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
  const catalog: Array<Record<string, unknown>> = [];
  let unitCount = 0, figureCount = 0;
  for (const members of groups.values()) {
    members.sort((a, b) => a.part - b.part);
    const first = members[0]!;
    const m = master.get(first.objectId);
    const fallback = metaFromFilename(first.uri);
    const units: Array<PageUnit & { object: string; source: string; sourceUnit: string }> = [];
    const figures: Array<FigureRecord & { object: string; source: string; sourcePage?: number }> = [];
    let offset = 0;
    let kind: "pages" | "sections" = "pages";
    for (const member of members) {
      const dir = join(out, pageDerivativePrefix(member.objectId));
      const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as PageDerivativeManifest;
      kind = manifest.kind;
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
    let title = (m?.title ?? fallback.title).replace(/\s*[([]?part\s+\d+\s+of\s+\d+[)\]]?\s*$/i, "").trim() || fallback.title;
    let creator = m?.creator ?? fallback.creator;
    if (!m?.title && kind === "sections") {
      const h1 = /^#\s+(.{3,120})$/m.exec(units[0]?.text ?? "");
      if (h1 && !members[0]!.uri.includes("---")) title = h1[1]!.trim();
    }
    title = decodeEntities(title);
    const book = bookId(title, first.objectId);
    ({ title, creator } = displayMeta(title, creator, Boolean(m?.title), units[0]?.text ?? ""));
    const bookDir = join(tree, "books", book);
    await mkdir(bookDir, { recursive: true });
    const label = creator ? `${creator}, ${title}` : title;
    for (const u of units) {
      const n = Number(u.unit.slice(1));
      const fm: Record<string, string | number> = {
        title: `${label} — ${kind === "pages" ? `p.${n}` : `§${n}`}${u.heading ? ` (${u.heading})` : ""}`,
        type: kind === "pages" ? "book-page" : "book-section", book, book_title: title, creator, unit: u.unit,
        object: u.object, source: u.source,
        ...(u.sourcePage ? { source_page: u.sourcePage } : { source_unit: u.sourceUnit }), ...(u.heading ? { heading: u.heading } : {}),
      };
      await writeFile(join(bookDir, `${u.unit}.md`), renderUnitMarkdown(fm, u.text || "(no text on this page)"));
    }
    const perPage = new Map<string, number>();
    for (const f of figures) {
      const k = (perPage.get(f.unit) ?? 0) + 1;
      perPage.set(f.unit, k);
      const body = [f.label && `**${f.label}**`, f.caption && `Caption: ${f.caption}`, f.description].filter(Boolean).join("\n\n");
      await writeFile(join(bookDir, `fig-${f.unit}-${k}.md`), renderUnitMarkdown({
        title: `${label} — figure on p.${Number(f.unit.slice(1))}${f.label ? ` (${f.label})` : ""}`, type: "figure", book, book_title: title,
        creator, unit: f.unit, object: f.object, source: f.source, ...(f.sourcePage ? { source_page: f.sourcePage } : {}),
      }, body));
    }
    unitCount += units.length; figureCount += figures.length;
    catalog.push({ book, title, creator, kind, units: units.length, first_unit: units[0]?.unit ?? "", last_unit: units.at(-1)?.unit ?? "",
      figures: figures.length, objects: members.map((x) => x.objectId), sources: members.map((x) => x.uri) });
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
env: OLLAMA_URL (DeepSeek-OCR), VISION_URL and VISION_MODEL (vision lane: escalation and figures),
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
