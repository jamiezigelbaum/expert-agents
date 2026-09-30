import { inflateRawSync } from "node:zlib";

/**
 * Dependency-free EPUB → Markdown conversion for RAG ingestion.
 *
 * Vertex RAG Engine parses PDF, text, Markdown and HTML; it completes an
 * import of an EPUB with importedRagFilesCount=0 and no error (observed live
 * 2026-09-20 on 16 ebooks). An EPUB is a ZIP of XHTML documents, so the text
 * is recoverable without a library: read the central directory, inflate the
 * entries, follow META-INF/container.xml to the OPF, and walk the spine in
 * reading order. Each spine document becomes a section under its own heading
 * so chapter boundaries survive chunking.
 */

export type EbookConversionErrorCode =
  | "epub_not_zip"
  | "epub_container_missing"
  | "epub_opf_missing"
  | "epub_spine_empty"
  | "epub_no_text"
  | "epub_too_large";

export class EbookConversionError extends Error {
  readonly code: EbookConversionErrorCode;

  constructor(code: EbookConversionErrorCode, message: string) {
    super(message);
    this.name = "EbookConversionError";
    this.code = code;
  }
}

export interface EbookTextResult {
  markdown: string;
  title?: string;
  creator?: string;
  /** Spine documents that contributed text. */
  sections: number;
  /** Spine documents skipped (missing from the archive or empty after stripping). */
  skipped: number;
  warnings: string[];
}

export interface EpubConversionOptions {
  /** Cap on total inflated bytes across all entries read (compression-bomb guard). */
  maxInflatedBytes?: number;
}

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_HEADER_BYTES = 46;
const ZIP_LOCAL_HEADER_BYTES = 30;
const ZIP_EOCD_MIN_BYTES = 22;
const ZIP_EOCD_SEARCH_BYTES = 64 * 1024;
const ZIP_MAX_ENTRIES = 8192;
const ZIP_METHOD_STORED = 0;
const ZIP_METHOD_DEFLATE = 8;
const DEFAULT_MAX_INFLATED_BYTES = 256 * 1024 * 1024;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

class ZipReader {
  private readonly entries = new Map<string, ZipEntry>();
  private inflatedBudget: number;

  constructor(private readonly buffer: Buffer, maxInflatedBytes: number) {
    this.inflatedBudget = maxInflatedBytes;
    const directory = findCentralDirectory(buffer);
    if (!directory) throw new EbookConversionError("epub_not_zip", "The EPUB has no readable ZIP central directory.");
    let cursor = directory.offset;
    for (let index = 0; index < Math.min(directory.entries, ZIP_MAX_ENTRIES); index += 1) {
      if (cursor + ZIP_CENTRAL_HEADER_BYTES > buffer.length) break;
      if (buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) break;
      const method = buffer.readUInt16LE(cursor + 10);
      const compressedSize = buffer.readUInt32LE(cursor + 20);
      const uncompressedSize = buffer.readUInt32LE(cursor + 24);
      const nameLength = buffer.readUInt16LE(cursor + 28);
      const extraLength = buffer.readUInt16LE(cursor + 30);
      const commentLength = buffer.readUInt16LE(cursor + 32);
      const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
      const nameStart = cursor + ZIP_CENTRAL_HEADER_BYTES;
      const nameEnd = Math.min(buffer.length, nameStart + nameLength);
      const name = buffer.toString("utf8", nameStart, nameEnd);
      this.entries.set(name, { name, method, compressedSize, uncompressedSize, localHeaderOffset });
      cursor = nameEnd + extraLength + commentLength;
    }
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  /** Returns the entry's bytes, or undefined when the entry is absent or unreadable. */
  read(name: string): Buffer | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    const at = entry.localHeaderOffset;
    if (at + ZIP_LOCAL_HEADER_BYTES > this.buffer.length) return undefined;
    if (this.buffer.readUInt32LE(at) !== ZIP_LOCAL_SIGNATURE) return undefined;
    // The local header repeats the name and extra lengths; the central
    // directory's sizes are the trustworthy ones (local sizes may be zero
    // when a data descriptor follows the payload).
    const nameLength = this.buffer.readUInt16LE(at + 26);
    const extraLength = this.buffer.readUInt16LE(at + 28);
    const dataStart = at + ZIP_LOCAL_HEADER_BYTES + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataStart > this.buffer.length || dataEnd > this.buffer.length) return undefined;
    const payload = this.buffer.subarray(dataStart, dataEnd);
    const allowance = Math.min(this.inflatedBudget, Math.max(entry.uncompressedSize, 1));
    if (allowance <= 0) throw new EbookConversionError("epub_too_large", "The EPUB exceeds the inflated-size budget.");
    let bytes: Buffer;
    if (entry.method === ZIP_METHOD_STORED) {
      bytes = payload;
    } else if (entry.method === ZIP_METHOD_DEFLATE) {
      try {
        bytes = inflateRawSync(payload, { maxOutputLength: allowance });
      } catch {
        return undefined;
      }
    } else {
      return undefined;
    }
    this.inflatedBudget -= bytes.length;
    return bytes;
  }

  readText(name: string): string | undefined {
    const bytes = this.read(name);
    return bytes === undefined ? undefined : decodeUtf8(bytes);
  }
}

function findCentralDirectory(buffer: Buffer): { offset: number; entries: number } | undefined {
  const floor = Math.max(0, buffer.length - ZIP_EOCD_SEARCH_BYTES);
  for (let at = buffer.length - ZIP_EOCD_MIN_BYTES; at >= floor; at -= 1) {
    if (buffer.readUInt32LE(at) !== ZIP_EOCD_SIGNATURE) continue;
    const entries = buffer.readUInt16LE(at + 10);
    const offset = buffer.readUInt32LE(at + 16);
    return entries > 0 && offset < buffer.length ? { offset, entries } : undefined;
  }
  return undefined;
}

function decodeUtf8(bytes: Buffer): string {
  const text = bytes.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Resolve a relative href against the directory of a base path inside the archive. */
export function resolveArchivePath(basePath: string, href: string): string {
  const cleanHref = href.split("#")[0]!.split("?")[0]!;
  let decoded = cleanHref;
  try {
    decoded = decodeURIComponent(cleanHref);
  } catch {
    // A malformed percent-escape stays literal; the archive lookup simply misses.
  }
  const baseDirectory = basePath.includes("/") ? basePath.slice(0, basePath.lastIndexOf("/") + 1) : "";
  const pieces: string[] = [];
  for (const piece of `${decoded.startsWith("/") ? "" : baseDirectory}${decoded}`.split("/")) {
    if (piece === "" || piece === ".") continue;
    if (piece === "..") {
      pieces.pop();
      continue;
    }
    pieces.push(piece);
  }
  return pieces.join("/");
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ensp: " ", emsp: " ",
  thinsp: " ", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", sbquo: "‚",
  ldquo: "“", rdquo: "”", bdquo: "„", hellip: "…", copy: "©", reg: "®",
  trade: "™", deg: "°", middot: "·", bull: "•", sect: "§", para: "¶",
  laquo: "«", raquo: "»", shy: "", eacute: "é", egrave: "è", ecirc: "ê",
  agrave: "à", aacute: "á", acirc: "â", auml: "ä", ouml: "ö", uuml: "ü",
  szlig: "ß", ccedil: "ç", ntilde: "ñ", oacute: "ó", iacute: "í", uacute: "ú",
  times: "×", divide: "÷", frac12: "½", frac14: "¼", frac34: "¾",
};

/** Decode numeric and common named XML/HTML entities. */
export function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeCodePoint(code, whole) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeCodePoint(code, whole) : whole;
    }
    const named = NAMED_ENTITIES[body];
    return named === undefined ? whole : named;
  });
}

function safeCodePoint(code: number, fallback: string): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

const BLOCK_TAGS = /^(?:p|div|section|article|aside|header|footer|main|nav|blockquote|pre|ul|ol|dl|dt|dd|table|tbody|thead|tfoot|tr|figure|figcaption|address|hr|form|fieldset)$/i;

/**
 * Convert one XHTML document to Markdown-ish text: headings keep their level,
 * list items keep a marker, block boundaries become blank lines, everything
 * else is plain text. Scripts, styles, and the head are dropped.
 */
export function xhtmlToMarkdown(xhtml: string): { markdown: string; firstHeading?: string; title?: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(xhtml)?.[1];
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(xhtml);
  let body = bodyMatch ? bodyMatch[1]! : xhtml.replace(/<head[\s\S]*?<\/head>/i, "");
  body = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|svg|math)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");

  let firstHeading: string | undefined;
  let out = "";
  const tag = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)\b[^>]*?\/?>/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(body)) !== null) {
    out += body.slice(last, match.index);
    last = tag.lastIndex;
    const raw = match[0];
    const name = match[1]!.toLowerCase();
    const closing = raw.startsWith("</");
    const heading = /^h([1-6])$/.exec(name);
    if (heading) {
      out += closing ? "\n\n" : `\n\n${"#".repeat(Number(heading[1]))} `;
    } else if (name === "br") {
      out += "\n";
    } else if (name === "li") {
      out += closing ? "" : "\n- ";
    } else if (name === "hr") {
      out += "\n\n---\n\n";
    } else if (name === "td" || name === "th") {
      out += closing ? " " : "";
    } else if (BLOCK_TAGS.test(name)) {
      out += "\n\n";
    }
  }
  out += body.slice(last);

  const decoded = decodeXmlEntities(out)
    .replace(/ /g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const headingLine = decoded.split("\n").find((line) => /^#{1,6} \S/.test(line));
  if (headingLine) firstHeading = headingLine.replace(/^#{1,6} /, "").trim();
  const cleanTitle = title ? decodeXmlEntities(title).replace(/\s+/g, " ").trim() : undefined;
  return { markdown: decoded, ...(firstHeading ? { firstHeading } : {}), ...(cleanTitle ? { title: cleanTitle } : {}) };
}

function attribute(tagText: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const found = pattern.exec(tagText);
  if (!found) return undefined;
  return decodeXmlEntities(found[1] ?? found[2] ?? "");
}

function elementText(xml: string, localName: string): string | undefined {
  const pattern = new RegExp(`<(?:[a-zA-Z0-9_-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[a-zA-Z0-9_-]+:)?${localName}\\s*>`, "i");
  const found = pattern.exec(xml)?.[1];
  if (found === undefined) return undefined;
  const text = decodeXmlEntities(found.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
  return text || undefined;
}

interface OpfDocument {
  path: string;
  title?: string;
  creator?: string;
  /** Spine document archive paths in reading order. */
  spine: string[];
}

function parseOpf(reader: ZipReader, opfPath: string): OpfDocument {
  const opf = reader.readText(opfPath);
  if (opf === undefined) throw new EbookConversionError("epub_opf_missing", `The EPUB package document ${opfPath} is missing or unreadable.`);
  const manifest = new Map<string, { href: string; mediaType: string }>();
  for (const item of opf.matchAll(/<(?:[a-zA-Z0-9_-]+:)?item\b[^>]*\/?>/gi)) {
    const id = attribute(item[0], "id");
    const href = attribute(item[0], "href");
    if (!id || !href) continue;
    manifest.set(id, { href, mediaType: attribute(item[0], "media-type") ?? "" });
  }
  const spine: string[] = [];
  for (const itemref of opf.matchAll(/<(?:[a-zA-Z0-9_-]+:)?itemref\b[^>]*\/?>/gi)) {
    const idref = attribute(itemref[0], "idref");
    if (!idref) continue;
    const item = manifest.get(idref);
    if (!item) continue;
    if (item.mediaType && !/xhtml|html|xml/i.test(item.mediaType)) continue;
    spine.push(resolveArchivePath(opfPath, item.href));
  }
  const metadata = /<(?:[a-zA-Z0-9_-]+:)?metadata\b[\s\S]*?<\/(?:[a-zA-Z0-9_-]+:)?metadata\s*>/i.exec(opf)?.[0] ?? opf;
  return {
    path: opfPath,
    ...(elementText(metadata, "title") ? { title: elementText(metadata, "title") } : {}),
    ...(elementText(metadata, "creator") ? { creator: elementText(metadata, "creator") } : {}),
    spine,
  };
}

function findOpfPath(reader: ZipReader): string {
  const container = reader.readText("META-INF/container.xml");
  if (container !== undefined) {
    const rootfile = /<rootfile\b[^>]*\/?>/i.exec(container)?.[0];
    const fullPath = rootfile ? attribute(rootfile, "full-path") : undefined;
    if (fullPath && reader.has(fullPath)) return fullPath;
    if (fullPath) throw new EbookConversionError("epub_opf_missing", `container.xml names ${fullPath}, which is not in the archive.`);
  }
  // Tolerate a missing container by locating a lone .opf, which some
  // converters emit; anything more ambiguous is a refusal.
  const candidates = reader.names().filter((name) => name.toLowerCase().endsWith(".opf"));
  if (candidates.length === 1) return candidates[0]!;
  throw new EbookConversionError("epub_container_missing", "META-INF/container.xml is missing and no single .opf identifies the package.");
}

/**
 * Convert EPUB bytes into a single UTF-8 Markdown document: a title heading,
 * an author line, then one `##` section per spine document in reading order.
 */
export function convertEpubToMarkdown(bytes: Uint8Array, options: EpubConversionOptions = {}): EbookTextResult {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const reader = new ZipReader(buffer, options.maxInflatedBytes ?? DEFAULT_MAX_INFLATED_BYTES);
  const opf = parseOpf(reader, findOpfPath(reader));
  if (opf.spine.length === 0) throw new EbookConversionError("epub_spine_empty", "The EPUB spine names no readable documents.");

  const warnings: string[] = [];
  const parts: string[] = [];
  let sections = 0;
  let skipped = 0;
  for (const [index, path] of opf.spine.entries()) {
    const xhtml = reader.readText(path);
    if (xhtml === undefined) {
      skipped += 1;
      warnings.push(`spine document ${path} is missing or unreadable`);
      continue;
    }
    const converted = xhtmlToMarkdown(xhtml);
    if (!converted.markdown) {
      skipped += 1;
      continue;
    }
    sections += 1;
    const heading = converted.firstHeading ?? converted.title ?? `Section ${index + 1}`;
    // A document that opens with its own heading keeps it as the section
    // heading rather than repeating it; every other document gets one.
    const body = converted.firstHeading && converted.markdown.startsWith("#")
      ? converted.markdown.replace(/^#{1,6} /, "## ")
      : `## ${heading}\n\n${converted.markdown}`;
    parts.push(body);
  }
  if (sections === 0) throw new EbookConversionError("epub_no_text", "No spine document yielded text after stripping markup.");

  const front = [
    opf.title ? `# ${opf.title}` : undefined,
    opf.creator ? `*${opf.creator}*` : undefined,
  ].filter(Boolean).join("\n\n");
  const markdown = `${front ? `${front}\n\n` : ""}${parts.join("\n\n")}\n`;
  return {
    markdown,
    ...(opf.title ? { title: opf.title } : {}),
    ...(opf.creator ? { creator: opf.creator } : {}),
    sections,
    skipped,
    warnings,
  };
}

/**
 * Wrap plain extracted text (djvutxt output) as Markdown with a title heading.
 * Form-feed page separators become horizontal rules so page boundaries stay
 * visible to chunking without pretending to be chapters.
 */
export function plainTextToMarkdown(text: string, front: { title?: string; creator?: string } = {}): string {
  const body = text
    .replace(/\r\n?/g, "\n")
    .replace(/\f/g, "\n\n---\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const head = [
    front.title ? `# ${front.title}` : undefined,
    front.creator ? `*${front.creator}*` : undefined,
  ].filter(Boolean).join("\n\n");
  return `${head ? `${head}\n\n` : ""}${body}\n`;
}
