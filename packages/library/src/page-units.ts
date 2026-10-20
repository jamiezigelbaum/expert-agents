// Page-addressed units: the parse-once representation of a library object.
//
// Every canonical object is parsed once, outside any index, into units an
// agent can cite and read: one unit per PDF page (`p0001`), or sections of
// about 1,200 words for text and converted ebooks (`s0001`). The units are
// stored as a derivative beside the original, so any index (GBrain, Vertex,
// grep) is built from the same text and re-indexing never parses again.
// Design and measurements: docs/page-library.md.
//
// This module is pure: no I/O, no clock, no network. The operator lane in
// scripts/library-pages.ts does the parsing and storage around it.

/** Bumped when the unit format changes; part of the derivative path. */
export const PAGE_UNITS_SCHEMA_VERSION = 1;

/** Target section size for text sources, in words. */
export const SECTION_TARGET_WORDS = 1200;

/** A PDF page whose text layer has fewer characters than this needs OCR. */
export const OCR_MIN_CHARS = 80;

export type UnitParser = 'pdftotext' | 'gemini' | 'deepseek-ocr' | 'text' | 'none';

export interface PageUnit {
  /** `p0001` (PDF page, 1-based physical page) or `s0001` (text section). */
  unit: string;
  /** Physical page in the source object, for PDF units. */
  sourcePage?: number;
  /** Nearest heading, for text sections. */
  heading?: string;
  parser: UnitParser;
  text: string;
}

export interface FigureRecord {
  /** The unit (PDF page) the figure is on. */
  unit: string;
  label: string;
  caption: string;
  description: string;
  /** [ymin, xmin, ymax, xmax], 0-1000 normalised, when the parser returned one. */
  box?: [number, number, number, number];
}

/** The derivative manifest stored beside each object's units. */
export interface PageDerivativeManifest {
  schemaVersion: number;
  /** `sha256:<64 hex>` of the original bytes. */
  objectId: string;
  /** The URI the original was read from. */
  sourceUri: string;
  kind: 'pages' | 'sections';
  units: Array<Omit<PageUnit, 'text'> & { chars: number }>;
  figures: FigureRecord[];
  /** Units still empty after every parser; listed, never silently dropped. */
  emptyUnits: string[];
}

export function unitName(kind: 'p' | 's', n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 99999) throw new RangeError(`unit number out of range: ${n}`);
  return `${kind}${String(n).padStart(4, '0')}`;
}

export function unitNumber(unit: string): number {
  const m = /^[ps](\d{4,5})$/.exec(unit);
  if (!m) throw new RangeError(`not a unit name: ${unit}`);
  return Number(m[1]);
}

/** Split `pdftotext` output (form feeds between pages) into page texts. */
export function splitPdfText(text: string): string[] {
  const pages = text.split('\f');
  if (pages.length > 0 && pages[pages.length - 1]!.trim() === '') pages.pop();
  return pages;
}

export function pageNeedsOcr(text: string): boolean {
  return text.trim().length < OCR_MIN_CHARS;
}

const HEADING = /^(#{1,3}\s+\S.*|CHAPTER\s+[\dIVXLC]+.*|Chapter\s+[\dIVXLC]+.*|PART\s+[\dIVXLC]+.*)$/;

/**
 * Cut text into sections of about `target` words, starting a new section at a
 * heading once the current one holds 40% of the target. Paragraphs are never
 * split; each section carries the nearest heading above it.
 */
export function sectionText(text: string, target = SECTION_TARGET_WORDS): Array<{ heading: string; text: string }> {
  const out: Array<{ heading: string; text: string }> = [];
  let cur: string[] = [];
  let words = 0;
  let heading = '';
  const flush = () => {
    if (cur.length) out.push({ heading, text: cur.join('\n\n') });
    cur = [];
    words = 0;
  };
  for (const raw of text.split(/\n\s*\n/)) {
    const para = raw.trim();
    if (!para) continue;
    const first = para.split('\n')[0]!.trim();
    const isHeading = first.length < 120 && HEADING.test(first);
    if (isHeading && words > target * 0.4) flush();
    if (isHeading) heading = first.replace(/^#+\s*/, '').slice(0, 120);
    cur.push(para);
    words += para.split(/\s+/).length;
    if (words >= target) flush();
  }
  flush();
  return out;
}

const PART = /[-_ ]+part[-_ ]?(\d+)[-_ ]?of[-_ ]?(\d+)$/i;

/** `bailey---esoteric-healing-2009-part-2-of-4` → base and part number. */
export function partOf(name: string): { base: string; part: number; of: number } | undefined {
  const stem = name.replace(/\.[a-z0-9]{1,5}$/i, '');
  const m = PART.exec(stem);
  if (!m) return undefined;
  return { base: stem.slice(0, m.index), part: Number(m[1]), of: Number(m[2]) };
}

export function slugify(s: string, max = 48): string {
  const slug = s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.slice(0, max).replace(/-+$/, '');
}

/**
 * A readable, stable book id: the title slug plus the first six hex digits of
 * the first object's SHA-256, so two editions with one title never collide.
 */
export function bookId(title: string, firstObjectId: string): string {
  const hex = /^sha256:([0-9a-f]{64})$/.exec(firstObjectId)?.[1];
  if (!hex) throw new RangeError('bookId needs a sha256 object id');
  return `${slugify(title, 40) || 'untitled'}-${hex.slice(0, 6)}`;
}

/** A unit's index slug: `books/<book>/<unit>`. */
export function unitSlug(book: string, unit: string): string {
  return `books/${book}/${unit}`;
}

export function parseUnitSlug(slug: string): { book: string; unit: string } | undefined {
  const m = /^books\/([a-z0-9][a-z0-9-]{0,63})\/([ps]\d{4,5}|fig-p\d{4,5}-\d+)$/.exec(slug);
  return m ? { book: m[1]!, unit: m[2]! } : undefined;
}

/**
 * Renumber an object's PDF units into a book's continuous page numbering.
 * Parts of a split PDF are consecutive ranges of the original, so offsetting by
 * the earlier parts' page counts restores the original page numbers.
 */
export function offsetUnits(units: readonly PageUnit[], pageOffset: number): PageUnit[] {
  return units.map((u) => u.unit.startsWith('p')
    ? { ...u, unit: unitName('p', unitNumber(u.unit) + pageOffset) }
    : u);
}

/** Front matter values are JSON-quoted so any title or heading survives YAML. */
export function renderUnitMarkdown(frontmatter: Record<string, string | number>, body: string): string {
  const head = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === 'number' ? String(v) : JSON.stringify(v)}`)
    .join('\n');
  return `---\n${head}\n---\n\n${body.trim()}\n`;
}

/** The body of a unit Markdown file, without its front matter. */
export function unitBody(markdown: string): string {
  if (!markdown.startsWith('---\n')) return markdown.trim();
  const end = markdown.indexOf('\n---\n', 4);
  return end < 0 ? markdown.trim() : markdown.slice(end + 5).trim();
}

/** Path of an object's derivative directory under the library prefix. */
export function pageDerivativePrefix(objectId: string): string {
  const hex = /^sha256:([0-9a-f]{64})$/.exec(objectId)?.[1];
  if (!hex) throw new RangeError('derivative path needs a sha256 object id');
  return `derivatives/pages/v${PAGE_UNITS_SCHEMA_VERSION}/${hex.slice(0, 2)}/${hex}`;
}
