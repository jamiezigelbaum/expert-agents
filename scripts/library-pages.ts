import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
 * PDF pages use the text layer (pdftotext). A page without one goes to
 * Gemini 3.5 Flash-Lite as an image; a page Gemini refuses (RECITATION) goes to
 * DeepSeek-OCR at OLLAMA_URL when set. Pages that look like they hold figures
 * get a Gemini figure description. Model results are cached per page, so a
 * rerun pays only for pages it has not seen.
 *
 * Secrets: GEMINI_API_KEY and the Google access token are read from the
 * environment only and never printed.
 */

const run = promisify(execFile);
const GEMINI_MODEL = process.env.PAGE_PARSE_MODEL ?? "gemini-3.5-flash-lite";
const RENDER_DPI = 150;

const PARSE_PROMPT = [
  "You are parsing one page of a book for a search index. Return JSON only:",
  '{"printed_page": "<page number printed on the page or empty>",',
  ' "markdown": "<faithful transcription of all running text in reading order as Markdown; keep headings, footnotes,',
  ' block quotes; tables as Markdown tables; equations as LaTeX; do not summarise>",',
  ' "figures": [{"label": "<e.g. Figure 3.2 or empty>", "caption": "<printed caption or empty>",',
  '   "box_2d": [ymin, xmin, ymax, xmax] (0-1000 normalised, tight around the figure),',
  '   "description": "<2-5 sentences: what it shows, its labels/axes/parts and relationships, and the point it makes>"}]}',
  "Figures are diagrams, charts, tables, maps, photos, illustrations. Omit decorative ornaments.",
].join("\n");

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

// ---------- page models ----------

class RecitationError extends Error {}

interface ModelPage { markdown: string; printed_page?: string; figures?: Array<{ label?: string; caption?: string; description?: string; box_2d?: number[] }> }

async function renderPage(pdf: string, page: number, dir: string): Promise<Uint8Array> {
  const out = join(dir, `p${page}`);
  await run("pdftoppm", ["-r", String(RENDER_DPI), "-jpeg", "-f", String(page), "-l", String(page), "-singlefile", pdf, out]);
  const jpg = await readFile(`${out}.jpg`);
  await rm(`${out}.jpg`, { force: true });
  return jpg;
}

async function geminiPage(img: Uint8Array): Promise<{ page: ModelPage; usage: { in: number; out: number } }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const body = {
    contents: [{ parts: [{ inline_data: { mime_type: "image/jpeg", data: Buffer.from(img).toString("base64") } }, { text: PARSE_PROMPT }] }],
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8192 },
  };
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) });
    if ((res.status === 429 || res.status >= 500) && attempt < 5) { await Bun.sleep(5000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const r = await res.json() as { candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
    const cand = r.candidates?.[0];
    if (!cand || cand.finishReason === "RECITATION" || !cand.content?.parts?.length) throw new RecitationError(cand?.finishReason ?? "no candidate");
    const text = cand.content.parts.map((p) => p.text ?? "").join("");
    let page: ModelPage;
    try {
      const v = JSON.parse(text);
      page = Array.isArray(v) ? v[0] : v;
    } catch {
      page = { markdown: text, figures: [] };
    }
    return { page, usage: { in: r.usageMetadata?.promptTokenCount ?? 0, out: r.usageMetadata?.candidatesTokenCount ?? 0 } };
  }
}

async function deepseekPage(img: Uint8Array): Promise<string> {
  const url = process.env.OLLAMA_URL;
  if (!url) throw new Error("OLLAMA_URL is not set");
  const res = await fetch(`${url}/api/generate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "deepseek-ocr:latest", prompt: "Convert the document to markdown.", images: [Buffer.from(img).toString("base64")], stream: false, options: { num_predict: 4096, temperature: 0 } }),
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) throw new Error(`DeepSeek-OCR ${res.status}`);
  const r = await res.json() as { response?: string };
  return (r.response ?? "").replace(/<\|ref\|>.*?<\|\/ref\|><\|det\|>.*?<\|\/det\|>/gs, "").trim();
}

/** Pages with an embedded image smaller than the page: likely figures. Whole-page scans are not. */
async function figureCandidatePages(pdf: string, pageCount: number): Promise<number[]> {
  let stdout = "";
  try { stdout = (await run("pdfimages", ["-list", pdf], { maxBuffer: 64 * 1024 * 1024 })).stdout; } catch { return []; }
  const images: Array<{ page: number; w: number; h: number }> = [];
  for (const line of stdout.split("\n").slice(2)) {
    const c = line.trim().split(/\s+/);
    if (c.length > 5 && /^\d+$/.test(c[0]!) && c[2] === "image") images.push({ page: Number(c[0]), w: Number(c[3]), h: Number(c[4]) });
  }
  if (!images.length) return [];
  const mx = Math.max(...images.map((i) => i.w)), my = Math.max(...images.map((i) => i.h));
  const pages = [...new Set(images.filter((i) => i.w > 150 && i.h > 150 && (i.w < 0.85 * mx || i.h < 0.85 * my)).map((i) => i.page))];
  // A document where most pages qualify is page art or a scan, not a figure-bearing book.
  return pages.length > pageCount * 0.5 ? [] : pages.sort((a, b) => a - b);
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

interface Usage { geminiPages: number; geminiIn: number; geminiOut: number; recitation: number; deepseekPages: number; failed: number }

async function cachedModelPage(cacheDir: string, hex: string, page: number, pdf: string, tmp: string, usage: Usage, allowDeepseek: boolean)
  : Promise<{ parser: UnitParser; page?: ModelPage; text?: string }> {
  const path = join(cacheDir, hex.slice(0, 2), hex, `${page}.json`);
  if (existsSync(path)) return JSON.parse(await readFile(path, "utf8"));
  const img = await renderPage(pdf, page, tmp);
  let result: { parser: UnitParser; page?: ModelPage; text?: string };
  try {
    const g = await geminiPage(img);
    usage.geminiPages++; usage.geminiIn += g.usage.in; usage.geminiOut += g.usage.out;
    result = { parser: "gemini", page: g.page };
  } catch (error) {
    if (!(error instanceof RecitationError)) { usage.failed++; throw error; }
    usage.recitation++;
    if (!allowDeepseek) return { parser: "none" };
    const text = await deepseekPage(img);
    usage.deepseekPages++;
    result = { parser: "deepseek-ocr", text };
  }
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

function figureRecord(unit: string, f: NonNullable<ModelPage["figures"]>[number]): FigureRecord | undefined {
  const description = (f.description ?? "").trim();
  if (!description) return undefined;
  const box = Array.isArray(f.box_2d) && f.box_2d.length === 4 && f.box_2d.every((x) => typeof x === "number")
    ? f.box_2d as [number, number, number, number] : undefined;
  return { unit, label: (f.label ?? "").trim(), caption: (f.caption ?? "").trim(), description, ...(box ? { box } : {}) };
}

async function parseOne(row: SourceRow, out: string, cache: string, opts: { ocr: boolean; figures: boolean; deepseek: boolean; force: boolean }, usage: Usage)
  : Promise<Record<string, unknown>> {
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
    const tmp = await mkdtemp(join(tmpdir(), "page-render-"));
    try {
      const ocrPages = opts.ocr ? units.filter((u) => u.parser === "none").map((u) => u.sourcePage!) : [];
      const figPages = opts.figures ? (await figureCandidatePages(row.file, pages.length)).filter((p) => !ocrPages.includes(p)) : [];
      await pool([...ocrPages.map((p) => ({ p, ocr: true })), ...figPages.map((p) => ({ p, ocr: false }))], 8, async ({ p, ocr }) => {
        const unit = units[p - 1];
        if (!unit) return;
        let r: Awaited<ReturnType<typeof cachedModelPage>>;
        try { r = await cachedModelPage(join(cache, "model-pages"), hex, p, row.file, tmp, usage, opts.deepseek && ocr); }
        catch { return; }
        if (ocr) {
          const text = (r.page?.markdown ?? r.text ?? "").trim();
          if (!pageNeedsOcr(text)) { unit.text = text; unit.parser = r.parser; }
        }
        for (const f of r.page?.figures ?? []) {
          const rec = figureRecord(unit.unit, f);
          if (rec) figures.push(rec);
        }
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
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
  const usage: Usage = { geminiPages: 0, geminiIn: 0, geminiOut: 0, recitation: 0, deepseekPages: 0, failed: 0 };
  const opts = { ocr: !args["no-ocr"], figures: !args["no-figures"], deepseek: Boolean(process.env.OLLAMA_URL), force: Boolean(args.force) };
  const results: Array<Record<string, unknown>> = [];
  let done = 0;
  await pool(rows, Number(args.concurrency ?? 4), async (row) => {
    try { results.push(await parseOne(row, out, cache, opts, usage)); }
    catch (error) { results.push({ uri: row.uri, error: (error as Error).message.slice(0, 200) }); }
    if (++done % 25 === 0) console.error(`[parse] ${done}/${rows.length} gemini=${usage.geminiPages} recitation=${usage.recitation} deepseek=${usage.deepseekPages}`);
  });
  results.sort((a, b) => String(a.uri).localeCompare(String(b.uri)));
  await writeFile(join(out, "sources.jsonl"), results.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const estUsd = usage.geminiIn / 1e6 * 0.10 + usage.geminiOut / 1e6 * 0.40;
  console.log(JSON.stringify({ sources: rows.length, errors: results.filter((r) => r.error).length, ...usage, geminiEstUsd: Math.round(estUsd * 100) / 100 }));
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
    const creator = m?.creator ?? fallback.creator;
    if (!m?.title && kind === "sections") {
      const h1 = /^#\s+(.{3,120})$/m.exec(units[0]?.text ?? "");
      if (h1 && !members[0]!.uri.includes("---")) title = h1[1]!.trim();
    }
    title = decodeEntities(title);
    const book = bookId(title, first.objectId);
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
  bun scripts/library-pages.ts parse    --sources <tsv|list of gs:// URIs> --originals <dir> --out <dir> [--cache <dir>] [--no-ocr] [--no-figures] [--concurrency 4] [--limit N] [--force]
  bun scripts/library-pages.ts upload   --out <dir> --bucket <bucket> --prefix <library prefix>
  bun scripts/library-pages.ts assemble --out <dir> --tree <dir> [--manifest master.json]
env: GEMINI_API_KEY (scan pages and figures), OLLAMA_URL (DeepSeek-OCR fallback), EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_ACCESS_TOKEN or gcloud ADC (GCS)`;

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
