// Content-free scale measurement (page and chapter counts) of acquired PDFs and EPUBs.
import { constants as zlibConstants, inflateSync } from 'node:zlib';

// Every bound below exists because the measured bytes are attacker-supplied: the
// measurement may give up, but it must never hang, allocate without bound, or
// throw out of the ingest gate.
const ANNAS_PDF_HEADER_WINDOW_BYTES = 1024;
const ANNAS_PDF_MAX_PAGE_HITS = 250_000;
const ANNAS_PDF_MAX_COUNT_PROBES = 512;
const ANNAS_PDF_PAGE_TREE_WINDOW_BYTES = 16 * 1024;
const ANNAS_PDF_STREAM_HEADER_WINDOW_BYTES = 4 * 1024;
const ANNAS_PDF_MAX_INFLATE_STREAMS = 48;
const ANNAS_PDF_MAX_STREAM_INPUT_BYTES = 2 * 1024 * 1024;
const ANNAS_PDF_MAX_STREAM_OUTPUT_BYTES = 2 * 1024 * 1024;
const ANNAS_PDF_MAX_TOTAL_INFLATED_BYTES = 4 * 1024 * 1024;
const ANNAS_ZIP_EOCD_SIGNATURE = 0x06054b50;
const ANNAS_ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ANNAS_ZIP_CENTRAL_HEADER_BYTES = 46;
const ANNAS_ZIP_EOCD_MIN_BYTES = 22;
const ANNAS_ZIP_EOCD_SEARCH_BYTES = 64 * 1024;
const ANNAS_ZIP_MAX_ENTRIES = 4096;
const ANNAS_EPUB_TEXT_DOCUMENT = /\.(?:x?html?|xml)$/;

// Measured scale of an acquired artifact. Content-free by construction: page and
// byte counts, a signal name and a short reason string, never a line of the
// document itself.
export interface AnnasArtifactScale {
  measured: boolean;
  format: string;
  bytes: number;
  pages?: number;
  page_signal?: 'page_tree_count' | 'page_objects';
  // Pages both signals report. Without qpdf's count, only this may refuse a PDF as too long.
  corroborated_pages?: number;
  // Byte-based proxy, deliberately not named for extracted text: no text
  // extractor runs here, so this is total artifact bytes divided by pages.
  content_bytes_per_page?: number;
  text_documents?: number;
  text_bytes?: number;
  reason?: string;
  min_pdf_pages?: number;
  below_min_pdf_pages?: boolean;
  short_artifact_override?: boolean;
}

type AnnasArtifactMeasurement = Omit<AnnasArtifactScale, 'format' | 'bytes' | 'min_pdf_pages' | 'below_min_pdf_pages' | 'short_artifact_override'>;

// Source metadata is advertising, not evidence. On 2026-07-29 an acquisition
// arrived carrying a 512-page monograph's title, author, year and advertised
// byte size and contained a 36-page pamphlet; bytes and sha256 were both
// perfectly consistent with the lie because nothing measured what was inside the
// file. This measures the artifact itself, then annotates it with the floor in
// effect so the audit record and the ingest gate read the same facts.
export function annasArtifactScale(
  format: string,
  bytes: Uint8Array,
  policy: { minPdfPages: number; allowShortArtifact: boolean },
): AnnasArtifactScale {
  const scale: AnnasArtifactScale = {
    ...measureAnnasArtifact(format, bytes),
    format,
    bytes: bytes.byteLength,
  };
  if (policy.allowShortArtifact) scale.short_artifact_override = true;
  if (format === 'pdf' && policy.minPdfPages > 0) {
    scale.min_pdf_pages = policy.minPdfPages;
    if (scale.pages !== undefined && scale.pages < policy.minPdfPages) scale.below_min_pdf_pages = true;
  }
  return scale;
}

// Fail open, and say so. The gate exists to catch a measurably short monograph,
// so an unparseable, truncated or unsupported artifact is recorded as unmeasured
// and ingests normally — turning every parser gap into a refused ingest would be
// a far larger policy change than the incident warrants.
function measureAnnasArtifact(format: string, bytes: Uint8Array): AnnasArtifactMeasurement {
  try {
    if (format === 'pdf') return measurePdfArtifactScale(bytes);
    if (format === 'epub') return measureEpubArtifactScale(bytes);
    return { measured: false, reason: 'format_not_measurable' };
  } catch {
    return { measured: false, reason: 'measurement_failed' };
  }
}

// No subprocess and no PDF library: shelling out to a C parser on an
// attacker-supplied file from inside a credentialed worker would add a remote
// code-execution surface, and a host binary is not portable to CI. This scans
// the bytes for the two page signals every writer leaves behind.
function measurePdfArtifactScale(bytes: Uint8Array): AnnasArtifactMeasurement {
  const buffer = asByteBuffer(bytes);
  const header = buffer.indexOf('%PDF-', 0, 'latin1');
  if (header < 0 || header > ANNAS_PDF_HEADER_WINDOW_BYTES) return { measured: false, reason: 'pdf_header_not_found' };
  const plain = pdfPageSignals(buffer);
  // Modern writers pack the page tree into compressed object streams, so the
  // plain scan alone reports nothing for a perfectly ordinary book.
  const compressed = pdfObjectStreamPageSignals(buffer);
  const pageTreeCount = Math.max(plain.pageTreeCount, compressed.pageTreeCount);
  const pageObjects = plain.pageObjects + compressed.pageObjects;
  const pages = Math.max(pageTreeCount, pageObjects);
  if (pages <= 0) return { measured: false, reason: 'pdf_page_signal_not_found' };
  return {
    measured: true,
    pages,
    page_signal: pageTreeCount >= pageObjects ? 'page_tree_count' : 'page_objects',
    // The smaller signal. Each can over-count: the page tree scan takes the largest nearby
    // /Count (an outline's count qualifies), and loose page objects include superseded ones in
    // an incrementally updated file. Only pages both report may refuse a PDF as too long.
    corroborated_pages: Math.min(pageTreeCount, pageObjects),
    content_bytes_per_page: Math.round(bytes.byteLength / pages),
  };
}

function pdfPageSignals(buffer: Buffer): { pageObjects: number; pageTreeCount: number } {
  return { pageObjects: countPdfPageObjects(buffer), pageTreeCount: pdfPageTreeCount(buffer) };
}

// Tolerates arbitrary whitespace between /Type and /Page, and refuses to let a
// page-tree node (/Type /Pages) inflate the tally.
function countPdfPageObjects(buffer: Buffer): number {
  let count = 0;
  let cursor = 0;
  while (count < ANNAS_PDF_MAX_PAGE_HITS) {
    const hit = buffer.indexOf('/Type', cursor, 'latin1');
    if (hit < 0) break;
    cursor = hit + '/Type'.length;
    const at = skipPdfWhitespace(buffer, cursor);
    if (!matchesAscii(buffer, at, '/Page')) continue;
    const after = at + '/Page'.length;
    const next = after < buffer.length ? buffer[after]! : 0x20;
    if (next === 0x73) continue;
    if (!isPdfWhitespace(next) && !isPdfDelimiter(next)) continue;
    count += 1;
  }
  return count;
}

// /Count is also an outline-dictionary key, so a value only counts when a
// page-tree marker sits in the same neighbourhood. The bias is deliberately
// toward the larger plausible reading: an over-count fails open and blocks
// nothing, while an under-count would refuse a real book.
function pdfPageTreeCount(buffer: Buffer): number {
  let best = 0;
  let cursor = 0;
  for (let probe = 0; probe < ANNAS_PDF_MAX_COUNT_PROBES; probe += 1) {
    const hit = buffer.indexOf('/Count', cursor, 'latin1');
    if (hit < 0) break;
    cursor = hit + '/Count'.length;
    const value = readPdfInteger(buffer, skipPdfWhitespace(buffer, cursor));
    if (value === undefined || value <= best) continue;
    if (!hasPdfPageTreeMarkerNear(buffer, hit)) continue;
    best = value;
  }
  return best;
}

function hasPdfPageTreeMarkerNear(buffer: Buffer, at: number): boolean {
  const start = Math.max(0, at - ANNAS_PDF_PAGE_TREE_WINDOW_BYTES);
  const end = Math.min(buffer.length, at + ANNAS_PDF_PAGE_TREE_WINDOW_BYTES);
  const found = buffer.indexOf('/Pages', start, 'latin1');
  return found >= 0 && found < end;
}

// Only object streams can carry page objects, so content streams and image data
// are never inflated. Every bound is enforced here: compressed input per stream,
// inflated output per stream, total inflated output, and stream count.
function pdfObjectStreamPageSignals(buffer: Buffer): { pageObjects: number; pageTreeCount: number } {
  let pageObjects = 0;
  let pageTreeCount = 0;
  let budget = ANNAS_PDF_MAX_TOTAL_INFLATED_BYTES;
  let cursor = 0;
  for (let stream = 0; stream < ANNAS_PDF_MAX_INFLATE_STREAMS && budget > 0; stream += 1) {
    const marker = buffer.indexOf('/ObjStm', cursor, 'latin1');
    if (marker < 0) break;
    cursor = marker + '/ObjStm'.length;
    const start = pdfStreamDataStart(buffer, cursor);
    if (start === undefined) continue;
    const decoded = inflatePdfStream(
      buffer.subarray(start, Math.min(buffer.length, start + ANNAS_PDF_MAX_STREAM_INPUT_BYTES)),
      Math.min(budget, ANNAS_PDF_MAX_STREAM_OUTPUT_BYTES),
    );
    if (!decoded) continue;
    budget -= decoded.length;
    pageObjects += countPdfPageObjects(decoded);
    pageTreeCount = Math.max(pageTreeCount, pdfPageTreeCount(decoded));
  }
  return { pageObjects, pageTreeCount };
}

function pdfStreamDataStart(buffer: Buffer, from: number): number | undefined {
  const keyword = buffer.indexOf('stream', from, 'latin1');
  if (keyword < 0 || keyword > from + ANNAS_PDF_STREAM_HEADER_WINDOW_BYTES) return undefined;
  let at = keyword + 'stream'.length;
  if (buffer[at] === 0x0d) at += 1;
  if (buffer[at] === 0x0a) at += 1;
  return at < buffer.length ? at : undefined;
}

// Z_SYNC_FLUSH so a truncated stream yields what it has instead of throwing, and
// maxOutputLength so a compression bomb costs a bounded allocation. A stream that
// fails either way costs only itself.
function inflatePdfStream(input: Buffer, maxOutputLength: number): Buffer | undefined {
  if (maxOutputLength <= 0 || input.length === 0) return undefined;
  try {
    return inflateSync(input, { finishFlush: zlibConstants.Z_SYNC_FLUSH, maxOutputLength });
  } catch {
    return undefined;
  }
}

// EPUB text scale from the ZIP central directory alone: it records uncompressed
// sizes, so nothing has to be inflated. Informational only — there is no EPUB
// floor, and an archive this cannot read is simply unmeasured.
function measureEpubArtifactScale(bytes: Uint8Array): AnnasArtifactMeasurement {
  const buffer = asByteBuffer(bytes);
  const directory = zipCentralDirectory(buffer);
  if (!directory) return { measured: false, reason: 'epub_central_directory_not_found' };
  let documents = 0;
  let textBytes = 0;
  let cursor = directory.offset;
  for (let entry = 0; entry < Math.min(directory.entries, ANNAS_ZIP_MAX_ENTRIES); entry += 1) {
    if (cursor + ANNAS_ZIP_CENTRAL_HEADER_BYTES > buffer.length) break;
    if (buffer.readUInt32LE(cursor) !== ANNAS_ZIP_CENTRAL_SIGNATURE) break;
    const uncompressed = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const nameStart = cursor + ANNAS_ZIP_CENTRAL_HEADER_BYTES;
    const nameEnd = Math.min(buffer.length, nameStart + nameLength);
    const name = buffer.toString('latin1', nameStart, nameEnd).toLowerCase();
    if (ANNAS_EPUB_TEXT_DOCUMENT.test(name) && !name.endsWith('container.xml')) {
      documents += 1;
      textBytes += uncompressed;
    }
    cursor = nameEnd + extraLength + commentLength;
  }
  if (documents === 0) return { measured: false, reason: 'epub_text_documents_not_found' };
  return { measured: true, text_documents: documents, text_bytes: textBytes };
}

// Zip64 archives park sentinels in these fields; that reads as an unusable
// directory here, which is the fail-open answer.
function zipCentralDirectory(buffer: Buffer): { offset: number; entries: number } | undefined {
  const floor = Math.max(0, buffer.length - ANNAS_ZIP_EOCD_SEARCH_BYTES);
  for (let at = buffer.length - ANNAS_ZIP_EOCD_MIN_BYTES; at >= floor; at -= 1) {
    if (buffer.readUInt32LE(at) !== ANNAS_ZIP_EOCD_SIGNATURE) continue;
    const entries = buffer.readUInt16LE(at + 10);
    const offset = buffer.readUInt32LE(at + 16);
    return entries > 0 && offset > 0 && offset < buffer.length ? { offset, entries } : undefined;
  }
  return undefined;
}

function asByteBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function skipPdfWhitespace(buffer: Buffer, from: number): number {
  let at = from;
  while (at < buffer.length && isPdfWhitespace(buffer[at]!)) at += 1;
  return at;
}

export function isPdfWhitespace(byte: number): boolean {
  return byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

function isPdfDelimiter(byte: number): boolean {
  return byte === 0x28 || byte === 0x29 || byte === 0x3c || byte === 0x3e || byte === 0x5b
    || byte === 0x5d || byte === 0x7b || byte === 0x7d || byte === 0x2f || byte === 0x25;
}

function matchesAscii(buffer: Buffer, at: number, text: string): boolean {
  if (at + text.length > buffer.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (buffer[at + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function readPdfInteger(buffer: Buffer, from: number): number | undefined {
  let at = from;
  let digits = 0;
  let value = 0;
  while (at < buffer.length && digits < 9) {
    const byte = buffer[at]!;
    if (byte < 0x30 || byte > 0x39) break;
    value = value * 10 + (byte - 0x30);
    digits += 1;
    at += 1;
  }
  return digits > 0 ? value : undefined;
}
