// Web import: turning URLs into library files through the ruled extraction engine.
import { execFile } from 'node:child_process';
import { lstatSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { WEB_IMPORT_TRANSCRIPT_MODE_EFFECT } from '../../core/domain-expert.ts';
import {
  EXTRACTION_MAX_OUTPUT_BYTES, EXTRACTION_METHOD, EXTRACTION_TIMEOUT_MS, SUMMARIZE_BINARY,
  SUMMARIZE_INSTALL_COMMAND, allowlistedExtractionEnv, firstDiagnosticLine, isolatedExtractorEnvironment,
  normalizeExtractedText, parseYoutubeTranscriptExtraction, YOUTUBE_EXTRACTION_ARGUMENTS,
  type ExtractionRequest, type ExtractionResult, type ReferenceExtractor, MEDIA_EXTENSIONS,
} from '@expert-agents/library';
import { extractWebMainText } from '@expert-agents/library/web-text';
import {
  type WebImportFetchResult, webImportProvenanceUrl, sanitizeWebImportProvenanceText, normalizedUrlHostname,
} from './network-guard.ts';
import {
  currentUid, safeObjectName, utf8, frontmatter, safeDecodeURIComponent, collapseWhitespace,
  decodeHtmlEntities,
} from './worker-util.ts';
import { DomainExpertWorkerError } from './worker-errors.ts';
import {
  PDF_PROCESSING_MAX_BYTES, MEDIA_TRANSCRIBE_MAX_BYTES, STAGE_IMPORT_MAX_FILE_BYTES,
  STAGE_IMPORT_TRANSCRIBABLE_MEDIA_EXTENSIONS, STAGE_IMPORT_MEDIA_EXTENSIONS, STAGE_IMPORT_ALLOWED_EXTENSIONS,
} from './worker-config.ts';
import { isNotionImportUrl } from './notion-client.ts';
import { isPdfWhitespace } from './artifact-scale.ts';

interface WebImportHandlerContext {
  sourceUrl: string;
  finalUrl: string;
  sourceProvenanceUrl: string;
  finalProvenanceUrl: string;
  response: WebImportFetchResult;
  includeMedia: boolean;
  transcriptMode: 'auto' | 'captions' | 'asr';
  dryRun: boolean;
  fetchedAt: string;
  fetch: (url: string) => Promise<WebImportFetchResult>;
  extraction: ExtractionRuntimeContext;
}

interface WebImportDerivedFile {
  sourceUrl: string;
  finalUrl: string;
  kind: string;
  fileName: string;
  bytes: Uint8Array;
  warnings?: string[];
}

interface WebImportUrlError {
  source_url: string;
  final_url?: string;
  handler?: string;
  code: string;
  message: string;
  suggestion?: string;
  stderr_tail?: string;
}

interface WebImportHandlerResult {
  files: WebImportDerivedFile[];
  errors?: WebImportUrlError[];
  plan?: Record<string, unknown>;
}

export interface WebImportHandler {
  id: string;
  detect(context: WebImportHandlerContext): boolean;
  derive(context: WebImportHandlerContext): Promise<WebImportHandlerResult>;
}

/** Everything web_import needs to reach the owner's ruled extraction engine. */
export interface ExtractionRuntimeContext {
  binaryPath: string;
  dataDir: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  extract: ReferenceExtractor;
}
// The bound is the extraction contract's, shared with the ingest CLI so neither
// lane can drift into waiting on the same binary for a different length of time.
export const SUMMARIZE_EXTRACT_TIMEOUT_MS = EXTRACTION_TIMEOUT_MS;
// Likewise the output bound: shared with the ingest CLI so neither lane can
// drift into buffering more of the same binary's output than the other.
const SUMMARIZE_EXTRACT_MAX_OUTPUT_BYTES = EXTRACTION_MAX_OUTPUT_BYTES;
const WEB_IMPORT_SHORT_EXTRACTION_CHARACTERS = 200;
const WEB_IMPORT_WORKER_FETCHER = 'domain-expert-worker';
// Pages are converted in-process from the bytes the worker already fetched, so
// their provenance names the local converter instead of the summarize
// subprocess that only YouTube URLs reach.
const WEB_IMPORT_LOCAL_HTML_EXTRACTOR = 'html-to-markdown';

function ensurePrivateExtractionDirectories(root: string): {
  home: string;
  cache: string;
  config: string;
  data: string;
  temp: string;
} {
  const directories = {
    home: join(root, 'home'),
    cache: join(root, 'cache'),
    config: join(root, 'config'),
    data: join(root, 'data'),
    temp: join(root, 'tmp'),
  };
  for (const path of [root, ...Object.values(directories)]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== currentUid() || (info.mode & 0o077) !== 0) {
      throw new DomainExpertWorkerError(
        500,
        'insecure_extraction_directory',
        'Domain expert extraction directories must be private, worker-owned directories without symlinks.',
      );
    }
  }
  return directories;
}

function maxStageFileBytes(path: string): number {
  if (extname(path).toLowerCase() === '.pdf') return PDF_PROCESSING_MAX_BYTES;
  return isTranscribableMediaPath(path) ? MEDIA_TRANSCRIBE_MAX_BYTES : STAGE_IMPORT_MAX_FILE_BYTES;
}

function isTranscribableMediaPath(path: string): boolean {
  return STAGE_IMPORT_TRANSCRIBABLE_MEDIA_EXTENSIONS.has(extname(path).toLowerCase());
}

export const WEB_IMPORT_HANDLERS: readonly WebImportHandler[] = [
  {
    id: 'direct-file',
    detect: (context) => directFileExtension(context.finalUrl, context.response.headers, context.response.bytes) !== undefined,
    derive: deriveDirectFile,
  },
  {
    id: 'notion',
    detect: (context) => isNotionImportUrl(context.sourceUrl) || isNotionImportUrl(context.finalUrl),
    derive: deriveNotionRequiresApiImport,
  },
  // Terminal handler: web pages and YouTube alike are extracted by the owner's
  // ruled engine, not by page parsing or a yt-dlp call of this worker's own.
  {
    id: 'summarize-extract',
    detect: () => true,
    derive: deriveSummarizeExtraction,
  },
];

export function selectWebImportHandler(context: WebImportHandlerContext, handlers: readonly WebImportHandler[] = WEB_IMPORT_HANDLERS): WebImportHandler {
  const handler = handlers.find((candidate) => candidate.detect(context));
  if (!handler) throw new DomainExpertWorkerError(500, 'web_import_handler_missing', 'No web import handler matched the URL.');
  return handler;
}

export async function deriveWebImportFiles(input: {
  urls: string[];
  includeMedia: boolean;
  transcriptMode: 'auto' | 'captions' | 'asr';
  dryRun: boolean;
  fetchedAt: string;
  fetch: (url: string) => Promise<WebImportFetchResult>;
  extraction: ExtractionRuntimeContext;
}): Promise<{
  files: WebImportDerivedFile[];
  errors: WebImportUrlError[];
  urlResults: Array<Record<string, unknown>>;
}> {
  const files: WebImportDerivedFile[] = [];
  const errors: WebImportUrlError[] = [];
  const urlResults: Array<Record<string, unknown>> = [];
  const usedFileNames = new Set<string>();
  for (const sourceUrl of input.urls) {
    const sourceProvenanceUrl = webImportProvenanceUrl(sourceUrl);
    let response: WebImportFetchResult | undefined;
    let handler: WebImportHandler | undefined;
    try {
      if (isNotionImportUrl(sourceUrl)) {
        const error = notionRequiresApiImportError(sourceProvenanceUrl);
        errors.push(error);
        urlResults.push({
          source_url: sourceProvenanceUrl,
          final_url: sourceProvenanceUrl,
          handler: 'notion',
          file_count: 0,
          error_count: 1,
          suggestion: error.suggestion,
        });
        continue;
      }
      response = await input.fetch(sourceUrl);
      const finalProvenanceUrl = webImportProvenanceUrl(response.url);
      const context: WebImportHandlerContext = {
        sourceUrl,
        finalUrl: response.url,
        sourceProvenanceUrl,
        finalProvenanceUrl,
        response,
        includeMedia: input.includeMedia,
        transcriptMode: input.transcriptMode,
        dryRun: input.dryRun,
        fetchedAt: input.fetchedAt,
        fetch: input.fetch,
        extraction: input.extraction,
      };
      handler = selectWebImportHandler(context);
      const activeHandler = handler;
      assertWebImportProcessingLimit(context, activeHandler);
      const result = await activeHandler.derive(context);
      for (const file of result.files) {
        const fileName = uniqueWebImportFileName(file.fileName, usedFileNames);
        files.push({ ...file, fileName });
      }
      if (result.errors?.length) {
        errors.push(...result.errors.map((error) => sanitizeWebImportUrlError({
          ...error,
          handler: error.handler ?? activeHandler.id,
        })));
      }
      urlResults.push({
        source_url: sourceProvenanceUrl,
        final_url: finalProvenanceUrl,
        handler: activeHandler.id,
        file_count: result.files.length,
        error_count: result.errors?.length ?? 0,
        ...(result.plan ?? {}),
      });
    } catch (error) {
      if (error instanceof DomainExpertWorkerError && WEB_IMPORT_FAIL_CLOSED_CODES.has(error.code)) {
        throw error;
      }
      const normalized = webImportErrorForUrl(error, sourceProvenanceUrl, response?.url, handler?.id);
      errors.push(normalized);
      // Name the engine this URL would actually have used: the summarize
      // subprocess for YouTube, the in-process converter for a page.
      const extractor = isAllowedYoutubeUrl(sourceUrl) || (response !== undefined && isAllowedYoutubeUrl(response.url))
        ? EXTRACTION_METHOD
        : WEB_IMPORT_LOCAL_HTML_EXTRACTOR;
      urlResults.push({
        source_url: sourceProvenanceUrl,
        ...(response?.url ? { final_url: webImportProvenanceUrl(response.url) } : {}),
        ...(handler?.id ? { handler: handler.id } : {}),
        file_count: 0,
        error_count: 1,
        ...(handler?.id === 'summarize-extract' ? { extractor } : {}),
      });
    }
  }
  return { files, errors, urlResults };
}

const WEB_IMPORT_FAIL_CLOSED_CODES = new Set([
  'web_import_https_required',
  'web_import_url_credentials_denied',
  'web_import_hostname_unresolved',
  'web_import_private_address_denied',
  'web_import_redirect_without_location',
  'web_import_redirect_limit_exceeded',
  'web_import_fetch_size_limit_exceeded',
  'web_import_processing_size_limit_exceeded',
  'web_import_batch_size_limit_exceeded',
  'web_import_fetch_limit_exceeded',
  'web_import_unpinned_fetch_impl',
  // A missing extractor is not a property of any one URL.
  'summarize_not_installed',
]);

function webImportErrorForUrl(error: unknown, sourceUrl: string, finalUrl: string | undefined, handler: string | undefined): WebImportUrlError {
  if (error instanceof DomainExpertWorkerError) {
    return sanitizeWebImportUrlError({
      source_url: sourceUrl,
      ...(finalUrl ? { final_url: finalUrl } : {}),
      ...(handler ? { handler } : {}),
      code: error.code,
      message: error.message,
      ...(error.suggestion ? { suggestion: error.suggestion } : {}),
      ...(error.stderrTail ? { stderr_tail: error.stderrTail } : {}),
    });
  }
  return sanitizeWebImportUrlError({
    source_url: sourceUrl,
    ...(finalUrl ? { final_url: finalUrl } : {}),
    ...(handler ? { handler } : {}),
    code: 'web_import_url_failed',
    message: error instanceof Error ? error.message : 'web_import failed for this URL.',
  });
}

async function deriveNotionRequiresApiImport(context: WebImportHandlerContext): Promise<WebImportHandlerResult> {
  return {
    files: [],
    errors: [notionRequiresApiImportError(context.sourceProvenanceUrl, context.finalProvenanceUrl)],
  };
}

function notionRequiresApiImportError(sourceUrl: string, finalUrl?: string): WebImportUrlError {
  return {
    source_url: sourceUrl,
    ...(finalUrl ? { final_url: finalUrl } : {}),
    handler: 'notion',
    code: 'notion_requires_api_import',
    message: 'Notion pages require the official Notion API because public Notion pages are client-rendered.',
    suggestion: 'Use library_ingest start with notion: [<page or database URL or id>] after sharing the target pages with the integration.',
  };
}

function sanitizeWebImportUrlError(error: WebImportUrlError): WebImportUrlError {
  return {
    ...error,
    source_url: webImportProvenanceUrl(error.source_url),
    ...(error.final_url ? { final_url: webImportProvenanceUrl(error.final_url) } : {}),
    message: sanitizeWebImportProvenanceText(error.message),
    ...(error.suggestion ? { suggestion: sanitizeWebImportProvenanceText(error.suggestion) } : {}),
    ...(error.stderr_tail ? { stderr_tail: sanitizeWebImportProvenanceText(error.stderr_tail) } : {}),
  };
}

function uniqueWebImportFileName(fileName: string, used: Set<string>): string {
  const safe = safeRelativeFileName(fileName);
  if (!used.has(safe)) {
    used.add(safe);
    return safe;
  }
  const extension = extname(safe);
  const stem = extension ? safe.slice(0, -extension.length) : safe;
  for (let index = 2; ; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

function safeRelativeFileName(value: string): string {
  const extension = extname(value).toLowerCase();
  const stem = extension ? value.slice(0, -extension.length) : value;
  return `${safeObjectName(stem)}${extension || '.md'}`;
}

type SummarizeExtractionInput =
  | { mode: 'local_input'; source: Uint8Array; fetchPerformedBy: typeof WEB_IMPORT_WORKER_FETCHER }
  | { mode: 'youtube_url'; source: string; fetchPerformedBy: typeof SUMMARIZE_BINARY };

/**
 * The single extraction path for web_import. YouTube must stay in URL mode so
 * summarize can use its transcript machinery; every other page is converted in
 * process from the bytes already fetched through the worker's DNS-pinned
 * transport, so a page import never spawns a second, unpinned fetch.
 */
async function deriveSummarizeExtraction(context: WebImportHandlerContext): Promise<WebImportHandlerResult> {
  const youtube = isAllowedYoutubeUrl(context.sourceUrl) || isAllowedYoutubeUrl(context.finalUrl);
  const kind = youtube ? 'youtube' : 'html';
  const extractionInput: SummarizeExtractionInput = youtube
    ? { mode: 'youtube_url', source: context.finalUrl, fetchPerformedBy: SUMMARIZE_BINARY }
    : { mode: 'local_input', source: context.response.bytes, fetchPerformedBy: WEB_IMPORT_WORKER_FETCHER };
  const page: { text: string; title?: string; author?: string; transcriptSource?: string } = extractionInput.mode === 'youtube_url'
    ? await youtubeTranscriptExtraction(context.extraction, extractionInput.source)
    : localHtmlExtraction(extractionInput.source);
  const extracted = page.text;
  const extractor = extractionInput.mode === 'youtube_url' ? EXTRACTION_METHOD : WEB_IMPORT_LOCAL_HTML_EXTRACTOR;
  const html = utf8(context.response.bytes);
  const title = page.title
    || extractHtmlTitle(html)
    || firstMarkdownHeading(extracted)
    || new URL(context.finalUrl).hostname;
  // The extractor usually emits its own leading heading; a second one would
  // just be noise in the retrieved chunk.
  const heading = extracted.startsWith('#') ? '' : `# ${title}\n\n`;
  const markdown = `${frontmatter({
    source_url: context.sourceProvenanceUrl,
    retrieved_at: context.fetchedAt,
    kind,
    title,
    ...(page.author ? { author: page.author } : {}),
    extractor,
    ...(page.transcriptSource ? { transcript_source: page.transcriptSource } : {}),
  })}${heading}${extracted}`;
  return {
    files: [{
      sourceUrl: context.sourceProvenanceUrl,
      finalUrl: context.finalProvenanceUrl,
      kind,
      fileName: `${safeObjectName(title)}.md`,
      bytes: new TextEncoder().encode(markdown),
      ...(extracted.length < WEB_IMPORT_SHORT_EXTRACTION_CHARACTERS ? { warnings: ['short_extraction'] } : {}),
    }],
    plan: {
      extractor,
      extracted_characters: extracted.length,
      extraction_input_mode: extractionInput.mode,
      extraction_fetch_performed_by: extractionInput.fetchPerformedBy,
      // transcript_mode is reported on every YouTube URL precisely because it
      // no longer chooses anything; see WEB_IMPORT_TRANSCRIPT_MODE_NOTE.
      ...(youtube
        ? {
          transcript_mode: context.transcriptMode,
          transcript_mode_effect: WEB_IMPORT_TRANSCRIPT_MODE_EFFECT,
        }
        : {}),
    },
  };
}

/**
 * A page's bytes are already in this process: Readability picks the article
 * (navigation, menus and footers dropped) and the library's own converter turns
 * it into Markdown without a subprocess, a temp file, or a second fetch. An
 * empty result is refused with the same code the extractor's own empty answer
 * uses, and the message carries no page content.
 */
function localHtmlExtraction(bytes: Uint8Array): { text: string; title?: string; author?: string } {
  const page = extractWebMainText(utf8(bytes));
  const extracted = normalizeExtractedText(page.markdown);
  if (extracted.length === 0) {
    throw new DomainExpertWorkerError(
      422,
      'summarize_extraction_empty',
      `${WEB_IMPORT_LOCAL_HTML_EXTRACTOR} produced no text for this page.`,
    );
  }
  return { text: extracted, ...(page.title ? { title: page.title } : {}), ...(page.author ? { author: page.author } : {}) };
}

/**
 * A YouTube URL is imported only as a transcript. When the extractor obtained
 * none (it then exits 0 with the video's description) or what it calls a
 * transcript is the watch page's own script, the URL fails with a reason
 * instead of being indexed.
 */
async function youtubeTranscriptExtraction(
  extraction: ExtractionRuntimeContext,
  source: string,
): Promise<{ text: string; title?: string; transcriptSource: string }> {
  const parsed = parseYoutubeTranscriptExtraction(
    await runSummarizeExtraction(extraction, source, YOUTUBE_EXTRACTION_ARGUMENTS),
  );
  if (!parsed.ok) {
    throw new DomainExpertWorkerError(
      parsed.code === 'youtube_extraction_unreadable' ? 502 : 422,
      parsed.code,
      `${EXTRACTION_METHOD}: ${parsed.reason}; nothing was indexed for this URL.`,
    );
  }
  return { text: parsed.text, transcriptSource: parsed.transcriptSource, ...(parsed.title ? { title: parsed.title } : {}) };
}

async function runSummarizeExtraction(
  extraction: ExtractionRuntimeContext,
  source: string,
  args: readonly string[],
): Promise<string> {
  const extractionRoot = await mkdtemp(join(resolve(extraction.dataDir), '.extraction-runtime-'));
  const directories = ensurePrivateExtractionDirectories(extractionRoot);
  const request: ExtractionRequest = {
    binaryPath: extractionBinaryForPrivateCwd(extraction.binaryPath),
    source: extractionSourceForPrivateCwd(source),
    args,
    env: isolatedExtractorEnvironment(extraction.env, directories),
    workingDirectory: extractionRoot,
    timeoutMs: extraction.timeoutMs,
  };
  let result: ExtractionResult;
  try {
    result = await extraction.extract(request);
  } catch (error) {
    // A missing extractor is a host misconfiguration, not a bad URL: it fails
    // the whole request rather than reporting every URL as its own failure.
    if (isMissingExecutableError(error)) {
      throw new DomainExpertWorkerError(
        503,
        'summarize_not_installed',
        `${SUMMARIZE_BINARY} is required for web_import extraction. Install it with \`${SUMMARIZE_INSTALL_COMMAND}\`, or set EXPERT_AGENTS_DOMAIN_EXPERT_SUMMARIZE_BIN.`,
        `Run ${SUMMARIZE_INSTALL_COMMAND} on the worker host.`,
      );
    }
    if (isKilledSubprocessError(error)) {
      throw withStderrTail(
        new DomainExpertWorkerError(
          408,
          'summarize_extraction_timeout',
          `${EXTRACTION_METHOD} exceeded the ${extraction.timeoutMs} ms extraction timeout.`,
        ),
        execErrorText(error, 'stderr'),
      );
    }
    // The thrown message carries the spawned command line, and a diagnostic can
    // carry a signed media URL, so both are stripped of query material before
    // they reach a result.
    const message = error instanceof Error ? error.message : `${SUMMARIZE_BINARY} failed.`;
    throw withStderrTail(
      new DomainExpertWorkerError(502, 'summarize_extraction_failed', sanitizeWebImportProvenanceText(message)),
      execErrorText(error, 'stderr'),
    );
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
  if (result.exitCode !== 0) {
    throw withStderrTail(
      new DomainExpertWorkerError(
        502,
        'summarize_extraction_failed',
        `${EXTRACTION_METHOD} exited with code ${result.exitCode}: ${sanitizeWebImportProvenanceText(firstDiagnosticLine(result.stderr))}`,
      ),
      result.stderr,
    );
  }
  const extracted = normalizeExtractedText(result.stdout);
  if (extracted.length === 0) {
    throw withStderrTail(
      new DomainExpertWorkerError(
        422,
        'summarize_extraction_empty',
        `${EXTRACTION_METHOD} produced no text for this URL: ${sanitizeWebImportProvenanceText(firstDiagnosticLine(result.stderr))}`,
      ),
      result.stderr,
    );
  }
  return extracted;
}

function extractionBinaryForPrivateCwd(binaryPath: string): string {
  return isAbsolute(binaryPath) || (!binaryPath.includes('/') && !binaryPath.includes('\\'))
    ? binaryPath
    : resolve(binaryPath);
}

function extractionSourceForPrivateCwd(source: string): string {
  try {
    new URL(source);
    return source;
  } catch {
    return isAbsolute(source) ? source : resolve(source);
  }
}

function firstMarkdownHeading(markdown: string): string | undefined {
  const heading = markdown.split('\n').find((line) => /^#{1,6}\s+\S/.test(line));
  return heading ? heading.replace(/^#{1,6}\s+/, '').trim() : undefined;
}

export const defaultSummarizeExtract: ReferenceExtractor = (request) => new Promise((resolvePromise, rejectPromise) => {
  execFile(request.binaryPath, [request.source, ...request.args], {
    cwd: request.workingDirectory,
    env: request.env,
    ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }),
    maxBuffer: SUMMARIZE_EXTRACT_MAX_OUTPUT_BYTES,
  }, (error, stdout, stderr) => {
    if (!error) {
      resolvePromise({ exitCode: 0, stdout, stderr });
      return;
    }
    // A refused spawn and a killed subprocess are conditions of the host, so
    // they are thrown; a non-zero exit is the extractor's own answer about the
    // source, so it is returned with the diagnostics it printed.
    if (isMissingExecutableError(error) || isKilledSubprocessError(error)) {
      Object.assign(error, { stdout, stderr });
      rejectPromise(error);
      return;
    }
    resolvePromise({
      exitCode: typeof error.code === 'number' ? error.code : 1,
      stdout,
      stderr,
    });
  });
});

function isMissingExecutableError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT');
}

function isKilledSubprocessError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { killed?: unknown }).killed === true);
}

function execErrorText(error: unknown, key: 'stdout' | 'stderr'): string {
  if (!error || typeof error !== 'object' || !(key in error)) return '';
  return String((error as Record<string, unknown>)[key] ?? '');
}

function withStderrTail<T extends DomainExpertWorkerError>(error: T, stderr: string): T {
  const tail = stderrTail(stderr);
  if (tail) error.stderrTail = tail;
  return error;
}

function stderrTail(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(-500) : undefined;
}

async function deriveDirectFile(context: WebImportHandlerContext): Promise<WebImportHandlerResult> {
  const extension = directFileExtension(context.finalUrl, context.response.headers, context.response.bytes);
  if (!extension) {
    return { files: [] };
  }
  const isMedia = STAGE_IMPORT_MEDIA_EXTENSIONS.has(extension) || MEDIA_EXTENSIONS.has(extension);
  if (isMedia && !context.includeMedia) {
    return {
      files: [],
      errors: [{
        source_url: context.sourceProvenanceUrl,
        final_url: context.finalProvenanceUrl,
        code: 'media_requires_include_media',
        message: `${extension.slice(1)} media files are skipped unless include_media=true.`,
      }],
    };
  }
  const urlPathName = directFileMetadataName(context.finalUrl, context.response.headers);
  const fallbackName = `${new URL(context.finalUrl).hostname}${extension}`;
  const fileName = urlPathName
    ? `${urlPathName.slice(0, Math.max(0, urlPathName.length - extname(urlPathName).length)) || 'download'}${extension}`
    : fallbackName;
  const bytes = extension !== '.pdf' && !isMedia
    ? new TextEncoder().encode(`${frontmatter({
        source_url: context.sourceProvenanceUrl,
        retrieved_at: context.fetchedAt,
        kind: 'file',
      })}${utf8(context.response.bytes)}`)
    : context.response.bytes;
  return {
    files: [{
      sourceUrl: context.sourceProvenanceUrl,
      finalUrl: context.finalProvenanceUrl,
      kind: 'file',
      fileName,
      bytes,
    }],
  };
}

function directFileExtension(url: string, headers: Headers, bytes: Uint8Array): string | undefined {
  const pathExtension = extname(new URL(url).pathname).toLowerCase();
  const dispositionExtension = extname(directFileMetadataName(url, headers) ?? '').toLowerCase();
  // A PDF extension or MIME type is only a hint. Direct-file treatment requires
  // the PDF header in the fetched bytes, which also recognizes download hashes
  // that arrive as application/octet-stream with a disposition filename.
  if (hasPdfHeader(bytes)) return '.pdf';
  if (pathExtension === '.pdf' || dispositionExtension === '.pdf') return undefined;
  if (STAGE_IMPORT_ALLOWED_EXTENSIONS.has(pathExtension) || STAGE_IMPORT_MEDIA_EXTENSIONS.has(pathExtension) || MEDIA_EXTENSIONS.has(pathExtension)) {
    return pathExtension;
  }
  const contentType = headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const byContentType: Record<string, string> = {
    'text/markdown': '.md',
    'text/plain': '.txt',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/aac': '.aac',
    'audio/ogg': '.ogg',
    'audio/wav': '.wav',
    'audio/wave': '.wav',
    'audio/x-wav': '.wav',
    'audio/flac': '.flac',
    'audio/x-flac': '.flac',
    'audio/opus': '.opus',
    'video/x-matroska': '.mkv',
    'video/x-m4v': '.m4v',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
  };
  return contentType ? byContentType[contentType] : undefined;
}

// Whether the bytes open with a PDF header (%PDF-1.x or %PDF-2.x), after nothing but
// whitespace, within the first PDF_SNIFF_BYTES. The one test of "is this a PDF" by content.
function hasPdfHeader(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, Math.min(bytes.byteLength, 1024));
  for (let at = 0; at <= window.byteLength - 8; at += 1) {
    if (window[at] === 0x25 && window[at + 1] === 0x50 && window[at + 2] === 0x44
      && window[at + 3] === 0x46 && window[at + 4] === 0x2d
      && (window[at + 5] === 0x31 || window[at + 5] === 0x32)
      && window[at + 6] === 0x2e
      && window[at + 7]! >= 0x30 && window[at + 7]! <= 0x39
      && window.subarray(0, at).every((byte) => isPdfWhitespace(byte))) return true;
  }
  return false;
}

function directFileMetadataName(url: string, headers: Headers): string | undefined {
  const disposition = headers.get('content-disposition');
  const encoded = disposition?.match(/(?:^|;)\s*filename\*=UTF-8''([^;]+)/i)?.[1];
  const quoted = disposition?.match(/(?:^|;)\s*filename="([^"]+)"/i)?.[1];
  const bare = disposition?.match(/(?:^|;)\s*filename=([^;]+)/i)?.[1]?.trim();
  let candidate = encoded ? safeDecodeURIComponent(encoded.trim()) : (quoted ?? bare);
  if (!candidate) candidate = basename(new URL(url).pathname);
  candidate = candidate.replaceAll('\\', '/').split('/').pop()?.trim();
  return candidate || undefined;
}

function assertWebImportProcessingLimit(context: WebImportHandlerContext, handler: WebImportHandler): void {
  const extension = handler.id === 'direct-file'
    ? directFileExtension(context.finalUrl, context.response.headers, context.response.bytes)
    : undefined;
  const limit = extension === '.pdf' ? PDF_PROCESSING_MAX_BYTES : maxStageFileBytes(`source${extension ?? '.html'}`);
  if (context.response.bytes.byteLength > limit) {
    throw new DomainExpertWorkerError(
      413,
      'web_import_processing_size_limit_exceeded',
      `web_import ${extension === '.pdf' ? 'PDF' : 'text/default'} processing is limited to ${limit} bytes per file.`,
    );
  }
}

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

function isAllowedYoutubeUrl(value: string): boolean {
  try {
    return YOUTUBE_HOSTS.has(normalizedUrlHostname(new URL(value)));
  } catch {
    return false;
  }
}

function extractHtmlTitle(html: string): string | undefined {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? collapseWhitespace(decodeHtmlEntities((match[1] ?? '').replace(/<[^>]+>/g, ' '))) : undefined;
}

// The allowlist itself lives in the shared extraction contract, so the ingest
// CLI and this worker cannot drift into two different ideas of what an
// extractor is allowed to inherit.
export function scrubbedExtractionEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  return allowlistedExtractionEnv(env);
}
