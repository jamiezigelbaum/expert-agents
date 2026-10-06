import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allowlistedExtractionEnv, parseMasterManifest, parseScopeManifest, planReconciliation,
  xhtmlToMarkdown, type LibraryLocationConfig, type LibraryObject, type Sha256Id,
} from '@expert-agents/library';
import { navigateText, TextNavigationError } from './text-navigation.ts';

export const LIBRARY_READ_MAX_BYTES = 100_000_000;
export const LIBRARY_TEXT_MAX_BYTES = 32_000_000;
const MANIFEST_MAX_BYTES = 16_000_000;
const READ_TIMEOUT_MS = 60_000;

export class LibraryReadError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

export interface LibraryReadRoute {
  library: LibraryLocationConfig;
  scopeManifestPath?: string;
  targetCorpusDisplayName: string;
  disclosure?: unknown;
}

export interface LibraryReadDependencies {
  download(bucket: string, name: string, maxBytes: number, timeoutMs: number): Promise<Uint8Array | null>;
  extractPdf?: (bytes: Uint8Array) => Promise<string>;
}

export interface LibraryReadParams {
  action: 'catalog' | 'open' | 'find' | 'read';
  object_id?: string;
  rag_file_name?: string;
  text_revision?: string;
  offset?: number;
  end?: number;
  section?: number;
  query?: string;
  limit?: number;
}

export function parseLibraryReadParams(value: Record<string, unknown>): LibraryReadParams {
  const allowed = ['domain_id', 'action', 'object_id', 'rag_file_name', 'text_revision', 'offset', 'end', 'section', 'query', 'limit'];
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
  if (typeof value.action !== 'string' || !['catalog', 'open', 'find', 'read'].includes(value.action)) invalid();
  const actionFields: Record<string, string[]> = {
    catalog: ['query', 'offset', 'limit'], open: ['object_id', 'rag_file_name', 'text_revision', 'offset', 'limit'],
    find: ['object_id', 'rag_file_name', 'text_revision', 'query', 'offset', 'limit'],
    read: ['object_id', 'rag_file_name', 'text_revision', 'offset', 'end', 'section', 'limit'],
  };
  if (Object.keys(value).some(key => !['action', 'domain_id', ...actionFields[String(value.action)]!].includes(key))) invalid();
  if (value.section !== undefined && value.end !== undefined) invalid();
  if (value.action !== 'catalog') {
    if ((value.object_id === undefined) === (value.rag_file_name === undefined)) invalid();
    if (value.object_id !== undefined && (typeof value.object_id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.object_id))) invalid();
    if (value.rag_file_name !== undefined && (typeof value.rag_file_name !== 'string' || !/^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/ragCorpora\/[0-9]+\/ragFiles\/[a-zA-Z0-9_-]+$/.test(value.rag_file_name))) invalid();
  }
  for (const key of ['offset', 'end', 'section', 'limit']) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)) invalid();
  }
  if (value.query !== undefined && (typeof value.query !== 'string' || !value.query.length || value.query.length > 200)) invalid();
  if (value.text_revision !== undefined && (typeof value.text_revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.text_revision))) invalid();
  if ((value.section !== undefined || value.end !== undefined || (typeof value.offset === 'number' && value.offset > 0 && value.action !== 'catalog')) && !value.text_revision) {
    throw new LibraryReadError('library_text_revision_required', 'Use the text_revision from open when selecting or continuing a text range.');
  }
  return value as unknown as LibraryReadParams;
}

/** Scope is re-read on every call, including continuations; no cursor grants access. */
export class LibraryReader {
  private active = 0;

  constructor(private readonly dependencies: LibraryReadDependencies) {}

  async run(route: LibraryReadRoute, params: LibraryReadParams,
    resolveFile?: (name: string) => Promise<{ uri: string; title?: string }>): Promise<Record<string, unknown>> {
    // A bounded public-serving route must never gain a reconstruction surface.
    if (route.disclosure !== undefined) {
      throw new LibraryReadError('library_read_disclosure_restricted', 'Direct reading is unavailable on a disclosure-bounded deployment. Use domain_ask.', 403);
    }
    if (!route.scopeManifestPath) {
      throw new LibraryReadError('library_read_not_configured', 'Direct reading requires an operator-configured library scope manifest.', 503);
    }
    if (this.active >= 2) throw new LibraryReadError('library_read_busy', 'Direct reading is busy. Retry shortly.', 429);
    this.active++;
    try {
      return await this.read(route, params, resolveFile);
    } catch (error) {
      if (error instanceof LibraryReadError) throw error;
      if (error instanceof TextNavigationError) throw new LibraryReadError('invalid_params', error.message);
      throw new LibraryReadError('library_read_unavailable', 'The source or library state could not be read or validated.', 502);
    } finally { this.active--; }
  }

  private async read(route: LibraryReadRoute, params: LibraryReadParams,
    resolveFile?: (name: string) => Promise<{ uri: string; title?: string }>): Promise<Record<string, unknown>> {
    const scope = parseScopeManifest(await readFile(route.scopeManifestPath!, 'utf8'));
    if (scope.targetCorpusDisplayName !== route.targetCorpusDisplayName) {
      throw new LibraryReadError('library_read_scope_mismatch', 'The library scope does not match the configured corpus.', 403);
    }
    const { bucket, prefix } = route.library;
    const manifestBytes = await this.dependencies.download(bucket, `${prefix}/manifest/master.json`, MANIFEST_MAX_BYTES, READ_TIMEOUT_MS);
    if (!manifestBytes) throw new Error('missing manifest');
    const master = parseMasterManifest(decode(manifestBytes));
    const plan = planReconciliation(master, scope, { schemaVersion: 1, entries: [] });
    const selected = new Set(plan.imports.map(entry => entry.objectId));
    const objects = master.objects.filter(object => selected.has(object.id));
    if (params.action === 'catalog') {
      if (params.object_id !== undefined || params.section !== undefined || params.end !== undefined || params.text_revision !== undefined) invalid();
      const query = params.query?.toLocaleLowerCase();
      const matches = objects.filter(object => !query || `${object.title ?? ''} ${object.creator ?? ''}`.toLocaleLowerCase().includes(query))
        .sort((a, b) => a.id.localeCompare(b.id));
      const offset = params.offset ?? 0;
      const limit = params.limit ?? 100;
      if (offset > matches.length || limit < 1 || limit > 200) invalid();
      const end = Math.min(matches.length, offset + limit);
      return { action: 'catalog', catalog_scope: 'canonical_scope',
        other_holdings: 'Older imports may only appear in rag_corpus list_files. Enumerate all configured shelves before concluding a title is missing; use their name as rag_file_name to read them.',
        library_revision: master.revision, total_objects: matches.length,
        objects: matches.slice(offset, end).map(object => ({ object_id: object.id, title: boundedMetadata(object.title),
          creator: boundedMetadata(object.creator), media_type: object.mediaType, byte_size: object.byteSize, derivative_kind: object.derivativeKind })),
        complete: end === matches.length, next_offset: end === matches.length ? null : end };
    }
    let object: (Pick<LibraryObject, 'title' | 'creator' | 'mediaType' | 'byteSize' | 'relativePath' | 'derivativeKind'> & { id?: Sha256Id }) | undefined = objects.find(object => object.id === params.object_id);
    let legacy: { uri: string; title?: string } | undefined;
    let objectName: string | undefined;
    if (params.rag_file_name) {
      if (!resolveFile) throw new LibraryReadError('library_source_not_available', 'The source is not available in this library scope.', 404);
      legacy = await resolveFile(params.rag_file_name);
      const root = `gs://${bucket}/${prefix}/`;
      if (!legacy.uri.startsWith(root)) throw new LibraryReadError('library_source_not_available', 'The source is not available in this library scope.', 404);
      const relativePath = legacy.uri.slice(root.length);
      if (!relativePath || relativePath.split('/').some(part => !part || part === '.' || part === '..') || /[\u0000-\u001f\\]/.test(relativePath)) invalid();
      // A RAG-file spelling is not a bypass around canonical selection/tombstones.
      const canonical = master.objects.find(entry => entry.relativePath === relativePath);
      if (canonical && selected.has(canonical.id)) object = canonical;
      else if (canonical || relativePath.startsWith('objects/')) throw new LibraryReadError('library_source_not_available', 'The source is not available in this library scope.', 404);
      else {
        const extension = relativePath.split('.').at(-1)?.toLowerCase() ?? '';
        const mediaType = ({ pdf: 'application/pdf', md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', html: 'text/html', htm: 'text/html' } as Record<string, string>)[extension];
        if (!mediaType) throw new LibraryReadError('library_source_format_unsupported', 'The source needs a text, Markdown, HTML, or PDF representation before direct reading.', 422);
        object = { title: legacy.title, mediaType, byteSize: 0, relativePath, derivativeKind: null };
      }
      objectName = `${prefix}/${relativePath}`;
    }
    if (!object) throw new LibraryReadError('library_source_not_available', 'The source is not available in this library scope.', 404);
    if (object.byteSize > LIBRARY_READ_MAX_BYTES) throw new LibraryReadError('library_source_too_large', 'The source exceeds the direct-reading size limit.', 413);
    const mediaType = object.mediaType.split(';')[0]!.trim().toLowerCase();
    if (!['text/plain', 'text/markdown', 'text/html', 'application/xhtml+xml', 'application/pdf'].includes(mediaType)) {
      throw new LibraryReadError('library_source_format_unsupported', 'The source needs a text, Markdown, HTML, or PDF representation before direct reading.', 422);
    }
    const bytes = await this.dependencies.download(bucket, objectName ?? `${prefix}/${object.relativePath}`, LIBRARY_READ_MAX_BYTES, READ_TIMEOUT_MS);
    const sourceId = bytes ? `sha256:${hash(bytes)}` as Sha256Id : undefined;
    if (!bytes || (object.id && (bytes.byteLength !== object.byteSize || sourceId !== object.id))) {
      throw new LibraryReadError('library_source_integrity_failed', 'The stored source does not match its library identity.', 502);
    }
    if (!object.id && (master.tombstones.some(entry => entry.objectId === sourceId)
      || (master.objects.some(entry => entry.id === sourceId) && !selected.has(sourceId!)))) {
      throw new LibraryReadError('library_source_not_available', 'The source is not available in this library scope.', 404);
    }
    let text: string;
    let method: string;
    if (mediaType === 'application/pdf') {
      text = await (this.dependencies.extractPdf ?? extractPdfText)(bytes);
      method = 'pdf_text_layer';
    } else {
      if (bytes.byteLength > LIBRARY_TEXT_MAX_BYTES) tooLarge();
      text = decode(bytes);
      method = mediaType === 'text/html' || mediaType === 'application/xhtml+xml' ? 'html_to_markdown' : 'stored_text';
      if (method === 'html_to_markdown') text = xhtmlToMarkdown(text).markdown;
    }
    if (Buffer.byteLength(text, 'utf8') > LIBRARY_TEXT_MAX_BYTES) tooLarge();
    if (!text.trim()) throw new LibraryReadError('library_source_text_unavailable', 'The source has no readable text. Scanned PDFs require a separately prepared OCR text representation.', 422);
    const revision = hash(text);
    if (params.text_revision && params.text_revision !== revision) {
      throw new LibraryReadError('library_text_revision_changed', 'The text representation changed. Open the source again before continuing.', 409);
    }
    const navigation = navigateText(text, params);
    const identity = params.rag_file_name ? { rag_file_name: params.rag_file_name } : { object_id: object.id };
    return { ...navigation, action: params.action, ...identity, source_sha256: sourceId, title: boundedMetadata(object.title), creator: boundedMetadata(object.creator),
      library_revision: master.revision, text_revision: revision, derivative_kind: object.derivativeKind,
      citation: { ...identity, text_revision: revision, offset_unit: 'utf16' },
      extraction: { method, original_completeness: 'unverified',
        coverage_basis: 'stored_representation', ...(method === 'pdf_text_layer' ? pdfCoverage(text, navigation) : {}) } };
  }
}

function pdfCoverage(text: string, navigation: Record<string, unknown>): Record<string, unknown> {
  const pages = text.split('\f');
  if (pages.at(-1) === '') pages.pop();
  const range = navigation.range as { start: number; end: number } | undefined;
  let offset = 0;
  let first: number | undefined;
  let last: number | undefined;
  let blank = 0;
  pages.forEach((page, index) => {
    if (!page.trim()) blank++;
    if (range && offset < range.end && offset + page.length + 1 > range.start) { first ??= index + 1; last = index + 1; }
    offset += page.length + 1;
  });
  return { page_count: pages.length, pages_without_text: blank,
    ...(first === undefined ? {} : { physical_page_start: first, physical_page_end: last }) };
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const binary = Bun.which('pdftotext');
  if (!binary) throw new LibraryReadError('library_pdf_reader_unavailable', 'PDF reading requires Poppler pdftotext on the worker host.', 503);
  const directory = await mkdtemp(join(tmpdir(), 'expert-library-read-'));
  try {
    const path = join(directory, 'source.pdf');
    await writeFile(path, bytes, { mode: 0o600 });
    return await new Promise<string>((resolve, reject) => {
      execFile(binary, ['-layout', '-enc', 'UTF-8', path, '-'], {
        timeout: READ_TIMEOUT_MS, maxBuffer: LIBRARY_TEXT_MAX_BYTES, encoding: 'utf8',
        env: allowlistedExtractionEnv(process.env),
      }, (error, stdout) => error
        ? reject(new LibraryReadError('library_pdf_extraction_failed', 'PDF text extraction failed or exceeded its size or time limit.', 422))
        : resolve(stdout));
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function decode(bytes: Uint8Array): string { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function boundedMetadata(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const part = value.slice(0, 500);
  return /[\uD800-\uDBFF]$/.test(part) ? part.slice(0, -1) : part;
}
function invalid(): never { throw new LibraryReadError('invalid_params', 'Invalid direct-reading parameters.'); }
function tooLarge(): never { throw new LibraryReadError('library_text_too_large', 'The text exceeds the direct-reading size limit.', 413); }
