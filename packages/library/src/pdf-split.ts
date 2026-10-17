// Splits a long PDF into page-range parts for Vertex RAG import (#33).
//
// The Gemini LLM parser fails PDFs of about 300 pages and more inside Vertex
// with an internal error; the measurements and the 200-page split size are in
// docs/vertex-rag-limits.md. This module holds the host-tool mechanics; the
// worker decides when to split.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowlistedExtractionEnv } from './extraction.ts';

/**
 * The most pages one PDF may hold in an import with the LLM parser; a longer
 * PDF is split into parts of at most this many pages, or refused before upload
 * when it cannot be split. Measurements and the choice: docs/vertex-rag-limits.md.
 */
export const LLM_PARSER_MAX_PDF_PAGES = 200;

const QPDF_TIMEOUT_MS = 120_000;
const QPDF_MAX_OUTPUT_BYTES = 1024 * 1024;
const PDFTOTEXT_TIMEOUT_MS = 120_000;
const PDFTOTEXT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
// qpdf exits 3 when it succeeded with warnings, for example after rebuilding a
// damaged cross-reference table. The output is usable; 2 is a real failure.
const QPDF_SUCCESS_CODES = new Set([0, 3]);

export class PdfSplitError extends Error {
  constructor(readonly code: 'pdf_page_count_failed' | 'pdf_split_failed', message: string) { super(message); }
}

export interface PdfPartPlan {
  index: number;
  of: number;
  firstPage: number;
  lastPage: number;
  pages: number;
}

export interface PdfPart extends PdfPartPlan {
  bytes: Uint8Array;
}

/**
 * Balanced contiguous ranges of at most maxPartPages pages that cover every
 * page exactly once: 508 pages at 200 become 170 + 169 + 169, not 200 + 200 + 108.
 */
export function planPdfParts(pages: number, maxPartPages: number): PdfPartPlan[] {
  if (!Number.isInteger(pages) || pages < 1) throw new RangeError('pages must be a positive integer');
  if (!Number.isInteger(maxPartPages) || maxPartPages < 1) throw new RangeError('maxPartPages must be a positive integer');
  const of = Math.ceil(pages / maxPartPages);
  const base = Math.floor(pages / of);
  const larger = pages % of;
  const parts: PdfPartPlan[] = [];
  let firstPage = 1;
  for (let index = 1; index <= of; index += 1) {
    const count = base + (index <= larger ? 1 : 0);
    parts.push({ index, of, firstPage, lastPage: firstPage + count - 1, pages: count });
    firstPage += count;
  }
  return parts;
}

/** `<stem>--partNofM`, the naming the manual workaround used. */
export function pdfPartStem(stem: string, part: Pick<PdfPartPlan, 'index' | 'of'>): string {
  return `${stem}--part${part.index}of${part.of}`;
}

/** The whole-book stem behind a part stem, so a prior part name maps to the same part. */
export function stripPdfPartSuffix(stem: string): string {
  return stem.replace(/--part\d+of\d+$/, '');
}

/** The page count qpdf reads from the document's page tree. */
export async function qpdfPageCount(qpdf: string, bytes: Uint8Array): Promise<number> {
  return withScratch(async (directory) => {
    const source = join(directory, 'source.pdf');
    await writeFile(source, bytes, { mode: 0o600 });
    return countPages(qpdf, source);
  });
}

/**
 * Writes each planned range to its own PDF with qpdf and reads every part's
 * page count back, so the parts are proven to cover the book page for page
 * before anything is uploaded. The same qpdf version splits the same bytes
 * identically.
 */
// Every part is returned in memory, so an ingest holds about twice the
// download (bounded by the worker's download cap) until its parts are uploaded.
export async function splitPdf(qpdf: string, bytes: Uint8Array, plan: PdfPartPlan[]): Promise<PdfPart[]> {
  return withScratch(async (directory) => {
    const source = join(directory, 'source.pdf');
    await writeFile(source, bytes, { mode: 0o600 });
    const parts: PdfPart[] = [];
    for (const part of plan) {
      const output = join(directory, `part-${part.index}.pdf`);
      try {
        // A deterministic /ID makes the same book split to the same bytes every
        // time, so a retried ingest finds its parts already uploaded instead of
        // writing content-hash variants that Vertex would import twice.
        await runQpdf(qpdf, ['--deterministic-id', '--empty', '--pages', source, `${part.firstPage}-${part.lastPage}`, '--', output]);
      } catch (error) {
        throw new PdfSplitError('pdf_split_failed', `qpdf could not write part ${part.index} of ${part.of} (pages ${part.firstPage}-${part.lastPage}): ${messageOf(error)}`);
      }
      const written = await countPages(qpdf, output).catch((error: unknown) => {
        throw new PdfSplitError('pdf_split_failed', `qpdf could not read back part ${part.index} of ${part.of}: ${messageOf(error)}`);
      });
      if (written !== part.pages) {
        throw new PdfSplitError('pdf_split_failed', `Part ${part.index} of ${part.of} holds ${written} pages; pages ${part.firstPage}-${part.lastPage} are ${part.pages}.`);
      }
      parts.push({ ...part, bytes: new Uint8Array(await readFile(output)) });
    }
    return parts;
  });
}

export interface PdfTextLayer {
  pages: number;
  characters: number;
  pagesWithoutText: number;
}

/**
 * The part's text layer as Poppler reads it, the same extraction direct
 * library reading uses: pages are separated by form feeds. A scan with no text
 * layer reads as zero characters, which Vertex's parser may still OCR.
 */
export async function pdfTextLayer(pdftotext: string, bytes: Uint8Array): Promise<PdfTextLayer> {
  return withScratch(async (directory) => {
    const source = join(directory, 'part.pdf');
    await writeFile(source, bytes, { mode: 0o600 });
    const text = await new Promise<string>((resolve, reject) => {
      execFile(pdftotext, ['-layout', '-enc', 'UTF-8', source, '-'], {
        timeout: PDFTOTEXT_TIMEOUT_MS,
        maxBuffer: PDFTOTEXT_MAX_OUTPUT_BYTES,
        encoding: 'utf8',
        env: allowlistedExtractionEnv(process.env),
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    const pages = text.split('\f');
    if (pages.at(-1) === '') pages.pop();
    return {
      pages: pages.length,
      characters: pages.reduce((total, page) => total + page.trim().length, 0),
      pagesWithoutText: pages.filter((page) => !page.trim()).length,
    };
  });
}

async function countPages(qpdf: string, path: string): Promise<number> {
  let stdout: string;
  try {
    stdout = await runQpdf(qpdf, ['--show-npages', path]);
  } catch (error) {
    throw new PdfSplitError('pdf_page_count_failed', `qpdf could not count the PDF's pages: ${messageOf(error)}`);
  }
  const pages = Number(stdout.trim());
  if (!Number.isInteger(pages) || pages < 1) throw new PdfSplitError('pdf_page_count_failed', `qpdf reported an unusable page count (${stdout.trim().slice(0, 40) || 'empty'}).`);
  return pages;
}

// qpdf runs with a bare environment, like djvutxt, so no worker credential
// reaches a host binary.
function runQpdf(qpdf: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(qpdf, args, {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      timeout: QPDF_TIMEOUT_MS,
      maxBuffer: QPDF_MAX_OUTPUT_BYTES,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      const code = error ? (error as { code?: unknown }).code : 0;
      if (!error || (typeof code === 'number' && QPDF_SUCCESS_CODES.has(code))) {
        resolve(stdout);
        return;
      }
      reject(new Error(firstLine(stderr) || error.message));
    });
  });
}

async function withScratch<T>(work: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'expert-pdf-split-'));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).filter((line) => !/^WARNING:/.test(line))[0]?.slice(0, 300) ?? '';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
