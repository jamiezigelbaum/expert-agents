// Book acquisition lane: Anna's Archive and Libgen search, ranking, download and audit.
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import {
  ANNAS_ARCHIVE_FORMATS, type AnnasArchiveFormat, type AnnasArchiveImportParams,
  type AnnasArchiveSearchParams,
} from '../../core/domain-expert.ts';
import {
  trimTrailingSlash, isRedirectStatus, stripHtmlTags, collapseWhitespace, decodeHtmlEntities, humanByteSize,
  extensionFormat, safeObjectName,
} from './worker-util.ts';
import type { DomainExpertAnnasConfig } from './worker-config.ts';
import { DomainExpertWorkerError, upstreamResponseContexts } from './worker-errors.ts';
import { type WebImportFetchImpl, type ResolveHostImpl, assertAnnasPartnerUrlAllowed, readWebImportChunk } from './network-guard.ts';
import { sanitizeUpstreamText, UPSTREAM_ERROR_TEXT_MAX_CHARACTERS, ANNAS_REDACTED } from './upstream.ts';
import { resolveWritePathInside, exists } from './workspace-seed.ts';

export const ANNAS_ARCHIVE_DOWNLOAD_TIMEOUT_MS = 15_000;
const ANNAS_ARCHIVE_REQUEST_TIMEOUT_MS = 15_000;
const ANNAS_ARCHIVE_MAX_REDIRECTS = 5;
const ANNAS_CANDIDATE_STRING_MAX_CHARACTERS = 1_000;
// Same-title size outliers: how many times smaller than the median edition a
// candidate has to be before the rationale says so.
const ANNAS_SIZE_OUTLIER_FACTOR = 5;
const ANNAS_AUDIT_FILE = '.expert-agents-annas-audit.jsonl';
export const ANNAS_FAST_DOWNLOAD_PATH = '/dyn/api/fast_download.json';
const ANNAS_SEARCH_RECORD_LIMIT = 100;
export const LIBGEN_SEARCH_PAGE_SIZE = 25;
export const LIBGEN_SEARCH_TIMEOUT_MS = 30_000;
const LIBGEN_ROW = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const LIBGEN_CELL = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
const LIBGEN_MD5 = /md5=([0-9a-f]{32})/i;
// The tooltip attribute before href can hold "<br>", so the attribute span is matched lazily across tags.
const LIBGEN_TITLE_ANCHOR = /<a\b[\s\S]*?href="edition\.php\?id=\d+"[^>]*>([\s\S]*?)<\/a>/i;
const LIBGEN_SIZE = /^([\d.]+)\s*(KB|MB|GB)$/i;
const ANNAS_MD5_VALUE = /^[0-9a-f]{32}$/;
const ANNAS_RECORD_MD5_PATH = /\/md5\/([0-9a-f]{32})/i;
const ANNAS_CREDENTIAL_QUERY_PARAMETER = /^(?:key|api[_-]?key|access[_-]?token|token|signature|x-amz-.+)$/i;
// Search-page shapes. The /md5/<hash> href is the stable anchor for a result; the cover
// link wraps markup while the title link wraps plain text, so requiring a text-only body
// selects the title link without depending on the presentational class names around it.
const ANNAS_PARTIAL_MATCHES_MARKER = 'js-partial-matches';
const ANNAS_MD5_HREF = /href="[^"]*\/md5\/[0-9a-f]{32}"/gi;
const ANNAS_TITLE_ANCHOR = /<a\s[^>]*href="[^"]*\/md5\/([0-9a-f]{32})"[^>]*>([^<]+)<\/a>/gi;
const ANNAS_AUTHOR_ANCHOR = /icon-\[mdi--user-edit\][^>]*>[^<]*<\/span>([^<]+)<\/a>/i;
const ANNAS_METADATA_SEPARATOR = '·';
const ANNAS_METADATA_TEXT = />([^<>]*·[^<>]*)</;
const ANNAS_SIZE_PIECE = /^([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB)$/i;
const ANNAS_YEAR_PIECE = /^(?:1[5-9][0-9]{2}|20[0-9]{2})$/;
const ANNAS_LANGUAGE_PIECE = /\[[a-z]{2,3}(?:-[a-z0-9]{2,4})?\]/i;
const ANNAS_SIZE_MULTIPLIER: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

export function annasUrl(template: string | undefined, baseUrl: string | undefined, path: string, params: Record<string, string | undefined>): string | undefined {
  if (template) {
    return Object.entries(params).reduce(
      (url, [key, value]) => url.replaceAll(`{${key}}`, encodeURIComponent(value ?? '')),
      template,
    );
  }
  if (!baseUrl) return undefined;
  const url = new URL(`${trimTrailingSlash(baseUrl)}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

function annasHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'X-API-Key': apiKey,
  };
}

export async function fetchAnnasDownload(
  fetchImpl: typeof fetch,
  downloadUrl: string,
  config: DomainExpertAnnasConfig,
  apiKey: string,
): Promise<{ response: Response; url: string }> {
  const result = await fetchAnnasCredentialed(fetchImpl, downloadUrl, {
    config,
    apiKey,
    purpose: 'download',
  });
  if (!result.response.ok) {
    await result.response.body?.cancel().catch(() => {});
    throw new DomainExpertWorkerError(result.response.status, 'annas_archive_error', 'Anna Archive download failed.');
  }
  return result;
}

export async function fetchAnnasCredentialed(
  fetchImpl: typeof fetch,
  rawUrl: string,
  options: {
    config: DomainExpertAnnasConfig;
    apiKey: string;
    purpose: 'download' | 'search';
    cookie?: string;
    sensitiveValues?: string[];
  },
): Promise<{ response: Response; url: string }> {
  let current = requireAllowedAnnasCredentialUrl(rawUrl, options.config, options.purpose);
  for (let redirects = 0; redirects <= ANNAS_ARCHIVE_MAX_REDIRECTS; redirects += 1) {
    const signal = AbortSignal.timeout(ANNAS_ARCHIVE_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(current.toString(), {
        headers: {
          ...annasHeaders(options.apiKey),
          ...(options.cookie ? { Cookie: options.cookie } : {}),
        },
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw annasRequestTimeoutError();
      throw error;
    }
    upstreamResponseContexts.set(response, {
      signal,
      timeoutError: annasRequestTimeoutError,
      sensitiveValues: [options.apiKey, ...(options.cookie ? [options.cookie] : []), ...(options.sensitiveValues ?? [])],
    });
    if (!isRedirectStatus(response.status)) {
      return { response, url: current.toString() };
    }
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (!location) {
      throw new DomainExpertWorkerError(400, 'annas_archive_redirect_without_location', 'Anna Archive request redirect did not include a Location header.');
    }
    current = requireAllowedAnnasCredentialUrl(new URL(location, current).toString(), options.config, options.purpose);
  }
  throw new DomainExpertWorkerError(400, 'annas_archive_redirect_limit_exceeded', 'Anna Archive request exceeded the maximum redirect count.');
}

const ANNAS_MEMBER_COOKIE = 'aa_account_id2';
const ANNAS_MEMBER_SESSION_DEFAULT_MS = 24 * 60 * 60 * 1000;
const ANNAS_MEMBER_SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000;
export const ANNAS_MEMBER_SIGN_IN_BACKOFF_MS = 10 * 60 * 1000;

export interface AnnasMemberSession {
  cookie: string;
  value: string;
  expiresAt: number;
}

/**
 * Signs in to the configured Anna Archive origin the way its account form does
 * (POST /account/ with the member key) and returns the session cookie. The key
 * goes only to an allowed credential origin; nothing here is ever surfaced.
 */
export async function annasMemberSignIn(
  fetchImpl: typeof fetch,
  origin: string,
  config: DomainExpertAnnasConfig,
  apiKey: string,
): Promise<AnnasMemberSession | undefined> {
  const url = requireAllowedAnnasCredentialUrl(`${origin}/account/`, config, 'search');
  const signal = AbortSignal.timeout(ANNAS_ARCHIVE_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key: apiKey }).toString(),
      redirect: 'manual',
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw annasRequestTimeoutError();
    throw error;
  }
  await response.body?.cancel().catch(() => {});
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = headers.getSetCookie?.() ?? (headers.get('set-cookie') ? [headers.get('set-cookie')!] : []);
  for (const line of setCookies) {
    const [pair, ...attributes] = line.split(';');
    const separator = pair?.indexOf('=') ?? -1;
    if (!pair || separator < 0 || pair.slice(0, separator).trim() !== ANNAS_MEMBER_COOKIE) continue;
    const value = pair.slice(separator + 1).trim();
    if (!value) return undefined;
    return { cookie: `${ANNAS_MEMBER_COOKIE}=${value}`, value, expiresAt: Date.now() + annasMemberSessionLifetimeMs(attributes) };
  }
  return undefined;
}

function annasMemberSessionLifetimeMs(attributes: string[]): number {
  let lifetime = ANNAS_MEMBER_SESSION_DEFAULT_MS;
  for (const attribute of attributes) {
    const separator = attribute.indexOf('=');
    if (separator < 0) continue;
    const name = attribute.slice(0, separator).trim().toLowerCase();
    const value = attribute.slice(separator + 1).trim();
    if (name === 'max-age' && /^\d+$/.test(value)) {
      lifetime = Number(value) * 1000;
      break;
    }
    if (name === 'expires') {
      const expires = Date.parse(value);
      if (Number.isFinite(expires)) lifetime = expires - Date.now();
    }
  }
  return Math.max(0, Math.min(lifetime, ANNAS_MEMBER_SESSION_MAX_MS));
}

function annasRequestTimeoutError(): DomainExpertWorkerError {
  return new DomainExpertWorkerError(408, 'annas_archive_error', 'Anna Archive request timed out.');
}

function requireAllowedAnnasCredentialUrl(rawUrl: string, config: DomainExpertAnnasConfig, purpose: 'download' | 'search'): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DomainExpertWorkerError(400, 'invalid_annas_archive_url', 'Anna Archive download URL must be absolute.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new DomainExpertWorkerError(403, 'annas_archive_url_not_allowed', 'Anna Archive credentials may only be sent to HTTPS Anna Archive endpoints without embedded credentials.');
  }
  const allowedOrigins = annasCredentialOrigins(config, purpose);
  if (allowedOrigins.size === 0) {
    throw new DomainExpertWorkerError(503, 'annas_archive_not_configured', `Anna Archive base URL or ${purpose} URL template is required for live ${purpose} requests.`);
  }
  if (!allowedOrigins.has(url.origin)) {
    throw new DomainExpertWorkerError(403, 'annas_archive_url_not_allowed', 'Anna Archive credentials may only be sent to the configured Anna Archive origin.');
  }
  return url;
}

function annasCredentialOrigins(config: DomainExpertAnnasConfig, purpose: 'download' | 'search'): Set<string> {
  const origins = new Set<string>();
  const template = purpose === 'download' ? config.downloadUrlTemplate : config.searchUrlTemplate;
  for (const candidate of [config.baseUrl, template]) {
    const origin = annasCredentialOrigin(candidate);
    if (origin) origins.add(origin);
  }
  return origins;
}

function annasCredentialOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export async function fetchAnnasPartnerDownload(input: {
  fetchImpl: WebImportFetchImpl;
  resolveHost: ResolveHostImpl;
  rawUrl: string;
  timeoutMs: number;
}): Promise<{ response: Response; url: string }> {
  // Partner hosts sit outside the credential allowlist. They receive the opaque URL the
  // member API just issued and nothing else: no Authorization, no X-API-Key, no secret.
  //
  // That URL is whatever the member API answered with, so a hostile or compromised
  // upstream picks the destination. Every hop therefore takes the same guarded
  // resolution web_import takes — resolve the name, refuse private and reserved space,
  // and connect only to an address that was validated — and a redirect is re-guarded
  // rather than trusted because it followed one that passed.
  let current = requireAnnasPartnerUrl(input.rawUrl);
  for (let redirects = 0; redirects <= ANNAS_ARCHIVE_MAX_REDIRECTS; redirects += 1) {
    const validatedAddresses = await assertAnnasPartnerUrlAllowed(current, input.resolveHost);
    const controller = new AbortController();
    // Bounds the connect and header exchange only. The body that follows is read by
    // readCappedAnnasDownloadBody under its own timeout, so this one is cleared as
    // soon as the response head is in rather than cutting the download short.
    const connect = setTimeout(() => controller.abort(), input.timeoutMs);
    let response: Response;
    try {
      response = await input.fetchImpl(current, { signal: controller.signal, validatedAddresses });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new DomainExpertWorkerError(408, 'annas_archive_download_timeout', 'Anna Archive partner download timed out.');
      }
      throw error;
    } finally {
      clearTimeout(connect);
    }
    if (!isRedirectStatus(response.status)) {
      return { response, url: current.toString() };
    }
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (!location) {
      throw new DomainExpertWorkerError(400, 'annas_archive_redirect_without_location', 'Anna Archive partner download redirect did not include a Location header.');
    }
    current = requireAnnasPartnerUrl(new URL(location, current).toString());
  }
  throw new DomainExpertWorkerError(400, 'annas_archive_redirect_limit_exceeded', 'Anna Archive partner download exceeded the maximum redirect count.');
}

function requireAnnasPartnerUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DomainExpertWorkerError(502, 'invalid_annas_archive_url', 'Anna Archive fast download returned a partner URL that is not absolute.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new DomainExpertWorkerError(403, 'annas_archive_url_not_allowed', 'Anna Archive partner downloads must use HTTPS without embedded credentials.');
  }
  return url;
}

export function annasFastDownloadMd5(params: AnnasArchiveImportParams): string | undefined {
  for (const candidate of [params.md5, params.annasArchiveId, ANNAS_RECORD_MD5_PATH.exec(params.url ?? '')?.[1]]) {
    const value = candidate?.trim().toLowerCase();
    if (value && ANNAS_MD5_VALUE.test(value)) return value;
  }
  return undefined;
}

export function annasFastDownloadUrl(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>).download_url;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function annasFastDownloadError(response: Response, body: unknown, apiKey: string): DomainExpertWorkerError {
  const reported = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).error
    : undefined;
  // The member API reports an exhausted fast-download quota or a bad key in this field.
  // Naming it keeps the failure honest instead of writing the envelope out as the book.
  const cause = sanitizeUpstreamText(
    typeof reported === 'string' && reported.trim() ? reported.trim() : `HTTP ${response.status}`,
    [apiKey],
    UPSTREAM_ERROR_TEXT_MAX_CHARACTERS,
  );
  return new DomainExpertWorkerError(
    response.status >= 400 && response.status < 500 ? response.status : 502,
    'annas_archive_fast_download_unavailable',
    `Anna Archive fast download returned no download URL: ${cause}`,
  );
}

function annasRedactedUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username) parsed.username = ANNAS_REDACTED;
    if (parsed.password) parsed.password = ANNAS_REDACTED;
    for (const key of [...parsed.searchParams.keys()]) {
      if (ANNAS_CREDENTIAL_QUERY_PARAMETER.test(key)) {
        parsed.searchParams.set(key, ANNAS_REDACTED);
      }
    }
    return parsed.toString();
  } catch {
    return url.replace(/([?&])([^=&#]+)=([^&#]*)/g, (match, separator: string, rawKey: string) => {
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey);
      } catch {}
      return ANNAS_CREDENTIAL_QUERY_PARAMETER.test(key)
        ? `${separator}${rawKey}=${ANNAS_REDACTED}`
        : match;
    });
  }
}

export async function readCappedAnnasDownloadBody(response: Response, url: string, timeoutMs: number, maxDownloadBytes: number): Promise<Uint8Array> {
  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
  if (contentLength !== undefined && Number.isFinite(contentLength) && contentLength > maxDownloadBytes) {
    await response.body?.cancel().catch(() => {});
    throw annasDownloadSizeError(url, maxDownloadBytes);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await readCappedAnnasDownloadBodyWithSignal(response, url, controller.signal, maxDownloadBytes);
  } finally {
    clearTimeout(timeout);
  }
}

async function readCappedAnnasDownloadBodyWithSignal(response: Response, url: string, signal: AbortSignal, maxDownloadBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxDownloadBytes) throw annasDownloadSizeError(url, maxDownloadBytes);
    return bytes;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        throw annasDownloadTimeoutError(url);
      }
      const { done, value } = await readWebImportChunk(reader, signal);
      if (done) break;
      if (!value) continue;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += chunk.byteLength;
      if (totalBytes > maxDownloadBytes) {
        await reader.cancel().catch(() => {});
        throw annasDownloadSizeError(url, maxDownloadBytes);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (signal.aborted || upstreamResponseContexts.get(response)?.signal.aborted) {
      await reader.cancel().catch(() => {});
      throw annasDownloadTimeoutError(url);
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function annasDownloadSizeError(url: string, maxDownloadBytes: number): DomainExpertWorkerError {
  return new DomainExpertWorkerError(
    413,
    'annas_archive_download_size_limit_exceeded',
    `Anna Archive download from ${annasRedactedUrl(url)} exceeded the ${maxDownloadBytes} byte download limit.`,
  );
}

function annasDownloadTimeoutError(url: string): DomainExpertWorkerError {
  return new DomainExpertWorkerError(
    408,
    'annas_archive_download_timeout',
    `Timed out downloading Anna Archive item from ${annasRedactedUrl(url)}.`,
  );
}

export function annasSearchCandidates(body: unknown): unknown[] {
  const structured = normalizeAnnasCandidates(body);
  if (structured.length) return structured;
  // responseTextOrJson wraps a non-JSON body as { text }; the live search endpoint is an
  // HTML page, so that wrapper is the normal path rather than an error path.
  const text = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).text
    : undefined;
  return typeof text === 'string' ? parseAnnasSearchHtml(text) : [];
}

function parseAnnasSearchHtml(html: string): Record<string, unknown>[] {
  // Anything from the partial-matches block onward is a fuzzy fallback the site shows
  // when the query itself found nothing; reporting it as a hit would be dishonest.
  const partialAt = html.indexOf(ANNAS_PARTIAL_MATCHES_MARKER);
  const exact = partialAt >= 0 ? html.slice(0, partialAt) : html;
  const hrefOffsets = [...exact.matchAll(ANNAS_MD5_HREF)].map((match) => match.index);
  const seen = new Set<string>();
  const records: Record<string, unknown>[] = [];
  for (const match of exact.matchAll(ANNAS_TITLE_ANCHOR)) {
    const md5 = (match[1] ?? '').toLowerCase();
    const title = annasHtmlText(match[2] ?? '');
    if (!title || seen.has(md5)) continue;
    seen.add(md5);
    // Each result carries a cover anchor and a title anchor to the same record, so the
    // next /md5/ href is the start of the following result and bounds this one.
    const blockStart = match.index + match[0].length;
    const blockEnd = hrefOffsets.find((offset) => offset >= blockStart) ?? exact.length;
    records.push({
      id: md5,
      md5,
      title,
      ...annasSearchRecordMetadata(exact.slice(blockStart, blockEnd)),
    });
    if (records.length >= ANNAS_SEARCH_RECORD_LIMIT) break;
  }
  return records;
}

/**
 * Library Genesis (libgen.li family) result table: one row per file with the
 * title cell first (an edition.php anchor plus badges), then authors, publisher,
 * year, language, pages, size, extension, and mirror links carrying the md5.
 * Rows without an md5 are headers or controls and are skipped; the md5 is the
 * identity the import path resolves, exactly as with an Anna Archive record.
 */
export function parseLibgenSearchHtml(html: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const row of html.matchAll(LIBGEN_ROW)) {
    const md5 = LIBGEN_MD5.exec(row[1] ?? '')?.[1]?.toLowerCase();
    if (!md5 || seen.has(md5)) continue;
    const cells = [...(row[1] ?? '').matchAll(LIBGEN_CELL)].map((cell) => cell[1] ?? '');
    if (cells.length < 8) continue;
    const title = annasHtmlText(stripHtmlTags(LIBGEN_TITLE_ANCHOR.exec(cells[0]!)?.[1] ?? ''));
    if (!title) continue;
    seen.add(md5);
    const text = (index: number) => annasHtmlText(stripHtmlTags(cells[index] ?? ''));
    const size = LIBGEN_SIZE.exec(text(6));
    const format = text(7).toLowerCase();
    const record: Record<string, unknown> = { id: md5, md5, title, source: 'libgen' };
    if (text(1)) record.author = text(1);
    if (text(2)) record.publisher = text(2);
    if (/^\d{4}$/.test(text(3))) record.year = text(3);
    if (text(4)) record.language = text(4);
    if (format && ANNAS_ARCHIVE_FORMATS.includes(format as AnnasArchiveFormat)) record.format = format;
    if (size) record.file_size_bytes = Math.round(Number(size[1]) * (ANNAS_SIZE_MULTIPLIER[(size[2] ?? '').toLowerCase()] ?? 1));
    records.push(record);
    if (records.length >= ANNAS_SEARCH_RECORD_LIMIT) break;
  }
  return records;
}

function annasSearchRecordMetadata(block: string): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  const author = annasHtmlText(ANNAS_AUTHOR_ANCHOR.exec(block)?.[1] ?? '');
  if (author) record.author = author;
  // The single interpunct-separated text node holds language, format, size, and year;
  // pieces that do not match a known shape are left out rather than guessed at.
  const pieces = annasHtmlText(ANNAS_METADATA_TEXT.exec(block)?.[1] ?? '')
    .split(ANNAS_METADATA_SEPARATOR)
    .map((piece) => piece.trim())
    .filter(Boolean);
  for (const piece of pieces) {
    const size = ANNAS_SIZE_PIECE.exec(piece);
    const format = piece.toLowerCase();
    if (!record.language && ANNAS_LANGUAGE_PIECE.test(piece)) record.language = piece;
    else if (!record.format && format !== 'unknown' && ANNAS_ARCHIVE_FORMATS.includes(format as AnnasArchiveFormat)) record.format = format;
    else if (!record.file_size_bytes && size) record.file_size_bytes = Math.round(Number(size[1]) * (ANNAS_SIZE_MULTIPLIER[(size[2] ?? '').toLowerCase()] ?? 1));
    else if (!record.year && ANNAS_YEAR_PIECE.test(piece)) record.year = piece;
  }
  return record;
}

function annasHtmlText(value: string): string {
  return collapseWhitespace(decodeHtmlEntities(value));
}

function normalizeAnnasCandidates(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    for (const key of ['results', 'items', 'candidates', 'data']) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return [];
}


interface NormalizedAnnasCandidate {
  annas_archive_id?: string;
  stable_locator?: string;
  title?: string;
  author?: string;
  year?: string;
  format?: string;
  language?: string;
  file_size_bytes?: number;
  md5?: string;
  url?: string;
  score: number;
  rationale: string[];
}

export function rankAnnasCandidates(items: unknown[], params: AnnasArchiveSearchParams): NormalizedAnnasCandidate[] {
  const limit = params.topN ?? params.maxResults ?? 10;
  const scored = items
    .map((item) => scoreAnnasCandidate(normalizeAnnasCandidate(item), params))
    .filter((candidate) => candidate.title || candidate.author || candidate.annas_archive_id || candidate.md5 || candidate.url);
  // Annotated across every candidate, not just the returned page, so a sibling
  // edition that falls outside top-N still informs the comparison.
  annotateAnnasSizeOutliers(scored);
  return scored
    .sort((left, right) => right.score - left.score || String(left.title ?? '').localeCompare(String(right.title ?? '')))
    .slice(0, limit);
}

// The 2026-07-29 impostor and the genuine edition came back from one search with
// identical titles, authors, years and scores. What actually separated them was
// being a small fraction of the size of the other edition of the same title —
// so that is what gets said out loud. Annotation only: no score change, no
// filtering, because size is not a quality signal on its own.
function annotateAnnasSizeOutliers(candidates: NormalizedAnnasCandidate[]): void {
  const groups = new Map<string, NormalizedAnnasCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.file_size_bytes || !candidate.title) continue;
    const key = normalizedAnnasTitleKey(candidate.title);
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const candidate of group) {
      const size = candidate.file_size_bytes ?? 0;
      // Median of the OTHER editions, never one that includes this candidate: a
      // group of two drags its own median halfway toward the outlier, so a
      // self-inclusive median would demand a 9x spread to fire at all and stay
      // silent on the 8x gap that produced the 2026-07-29 incident.
      const median = medianOfNumbers(
        group.filter((other) => other !== candidate).map((other) => other.file_size_bytes ?? 0),
      );
      if (size * ANNAS_SIZE_OUTLIER_FACTOR > median) continue;
      candidate.rationale.push(
        `unusually small vs other editions of this title (${humanByteSize(size)} vs ${humanByteSize(median)} median) — verify page count before ingest`,
      );
    }
  }
}

function normalizedAnnasTitleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function medianOfNumbers(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : sorted[middle] ?? 0;
}

function normalizeAnnasCandidate(item: unknown): Omit<NormalizedAnnasCandidate, 'score' | 'rationale'> {
  const record = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
  const md5 = annasCandidateString(record, ['md5', 'hash', 'file_md5']);
  const id = annasCandidateString(record, ['id', 'annas_archive_id', 'aacid', 'stable_id']);
  const url = annasCandidateString(record, ['url', 'download_url', 'href', 'link'], true);
  const stableLocator = md5 ? `md5:${md5}` : id ?? url;
  return {
    ...(id ? { annas_archive_id: id } : {}),
    ...(stableLocator ? { stable_locator: stableLocator } : {}),
    ...stringField('title', annasCandidateString(record, ['title', 'name', 'book_title'])),
    ...stringField('author', annasCandidateString(record, ['author', 'authors', 'creator'])),
    ...stringField('year', annasCandidateString(record, ['year', 'publication_year', 'published_year'])),
    ...stringField('format', normalizeAnnasFormat(annasCandidateString(record, ['format', 'extension', 'file_type', 'ext']))),
    ...stringField('language', annasCandidateString(record, ['language', 'lang', 'languages'])),
    ...numberField('file_size_bytes', firstCandidateNumber(record, ['file_size_bytes', 'filesize_bytes', 'size_bytes', 'filesize', 'size'])),
    ...(md5 ? { md5 } : {}),
    ...(url ? { url } : {}),
  };
}

function annasCandidateString(
  record: Record<string, unknown>,
  keys: string[],
  url = false,
): string | undefined {
  const value = firstCandidateString(record, keys);
  if (!value) return undefined;
  const sanitized = url ? annasRedactedUrl(value) : value;
  return sanitizeUpstreamText(sanitized, [], ANNAS_CANDIDATE_STRING_MAX_CHARACTERS);
}

function scoreAnnasCandidate(candidate: Omit<NormalizedAnnasCandidate, 'score' | 'rationale'>, params: AnnasArchiveSearchParams): NormalizedAnnasCandidate {
  let score = 0;
  const rationale: string[] = [];
  const topicTerms = tokenizeAnnasQuery([params.query, params.topic, params.title].filter(Boolean).join(' '));
  const haystack = [candidate.title, candidate.author].filter(Boolean).join(' ').toLowerCase();
  const matchedTerms = topicTerms.filter((term) => haystack.includes(term));
  if (matchedTerms.length) {
    score += matchedTerms.length * 5;
    rationale.push(`matched ${matchedTerms.length} query/topic term(s)`);
  }
  if (params.author && candidate.author?.toLowerCase().includes(params.author.toLowerCase())) {
    score += 8;
    rationale.push('author match');
  }
  if (params.language && candidate.language?.toLowerCase().includes(params.language.toLowerCase())) {
    score += 3;
    rationale.push('language match');
  }
  const format = candidate.format?.toLowerCase();
  const preference = params.formatPreference ?? 'auto';
  if (params.ingestIntent && format) {
    // Ranking for what the page library can actually read.
    const ingestibility = annasFormatIngestibility(format);
    score += ingestibility.score;
    rationale.push(ingestibility.rationale);
  } else if ((preference === 'text_rag' || preference === 'auto') && format === 'epub') {
    score += 6;
    rationale.push('EPUB preferred for text-first reading/RAG');
  } else if (preference === 'layout' && format === 'pdf') {
    score += 6;
    rationale.push('PDF preferred for layout-heavy/design material');
  } else if (format) {
    score += 1;
    rationale.push(`format metadata present (${format})`);
  }
  if (candidate.year) {
    score += 1;
    rationale.push('publication year present');
  }
  if (candidate.file_size_bytes) {
    // Presence earns the same flat point it always did. The size itself is
    // surfaced, not scored: a clean 4 MB text-layer PDF of a 500-page book beats
    // a 44 MB scan of the same book for retrieval, so a bigger-is-better bonus
    // would systematically prefer scans and degrade the library.
    score += 1;
    rationale.push(`file size ${humanByteSize(candidate.file_size_bytes)}`);
  }
  if (candidate.md5 || candidate.annas_archive_id) {
    score += 2;
    rationale.push('stable locator present');
  }
  return { ...candidate, score, rationale: rationale.length ? rationale : ['candidate metadata returned by Anna Archive'] };
}

// EPUB first, PDF when no EPUB is offered (owner ruling 2026-10-07): an EPUB
// carries clean text, while a PDF may be a scan or a mislabelled edition. The
// margin outweighs the flat metadata points so a same-work PDF never outranks
// its EPUB.
function annasFormatIngestibility(format: string): { score: number; rationale: string } {
  if (format === 'epub') return { score: 10, rationale: 'preferred: the page library reads EPUB text directly' };
  if (format === 'pdf') return { score: 6, rationale: 'ingestible: the page library reads PDF pages, with OCR for scans; use it when no EPUB is offered' };
  return { score: 0, rationale: `not ingestible: the page library does not read ${format.toUpperCase()}` };
}

function tokenizeAnnasQuery(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 4))].slice(0, 12);
}

function firstCandidateString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (Array.isArray(value)) {
      const pieces = value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean);
      if (pieces.length) return pieces.join(', ');
    }
  }
  return undefined;
}

function firstCandidateNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value.replace(/[^0-9.]/g, ''));
      if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
    }
  }
  return undefined;
}

function stringField<K extends string>(key: K, value: string | undefined): Record<K, string> | Record<string, never> {
  return value ? { [key]: value } as Record<K, string> : {};
}

function numberField<K extends string>(key: K, value: number | undefined): Record<K, number> | Record<string, never> {
  return value !== undefined ? { [key]: value } as Record<K, number> : {};
}

function normalizeAnnasFormat(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/^\./, '').toLowerCase();
  return ANNAS_ARCHIVE_FORMATS.includes(normalized as any) ? normalized : value;
}

export async function annasDownloadPlan(root: string, params: AnnasArchiveImportParams): Promise<{ root: string; relativePath: string; targetPath: string }> {
  const rootPath = resolve(root);
  const info = await stat(rootPath).catch(() => undefined);
  if (!info?.isDirectory()) throw new DomainExpertWorkerError(503, 'annas_books_root_not_configured', 'Anna Archive books root is not available on this host.');
  const topic = safeAnnasPathSegment(params.topic ?? 'General');
  const author = params.author?.trim() || 'Unknown Author';
  const title = params.title?.trim() || params.annasArchiveId || params.md5 || basename(params.url ?? 'Anna Archive Item');
  const year = params.year?.trim();
  const folder = safeAnnasPathSegment(`${author} - ${title}${year ? ` (${year})` : ''}`);
  const extension = params.format && params.format !== 'unknown' ? params.format : extensionFormat(params.url ?? 'download.pdf');
  const originalStem = params.fileName ? basename(params.fileName, extname(params.fileName)) : `${author} - ${title}${year ? ` (${year})` : ''}`;
  const locator = params.md5 ?? params.annasArchiveId;
  const suffix = locator ? `-${safeAnnasPathSegment(locator).slice(0, 16)}` : '';
  const filename = `${safeAnnasPathSegment(originalStem)}${suffix}.${extension}`;
  const relativePath = [topic, folder, filename].join('/');
  const targetPath = await resolveWritePathInside(
    rootPath,
    relativePath,
    'Anna Archive download path escaped the configured books root.',
  );
  return { root: rootPath, relativePath, targetPath };
}

export async function existingAnnasAcquisition(root: string, params: AnnasArchiveImportParams, targetPath: string): Promise<{ reason: string; targetPath: string } | undefined> {
  if (await exists(targetPath)) return { reason: 'target_path_exists', targetPath };
  const stable = [
    params.md5,
    params.annasArchiveId,
    params.url ? canonicalAnnasAuditUrl(params.url) : undefined,
  ].filter(Boolean).map(String);
  if (stable.length === 0) return undefined;
  const raw = await readFile(join(resolve(root), ANNAS_AUDIT_FILE), 'utf8').catch(() => '');
  for (const line of raw.split('\n').filter(Boolean).reverse()) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const selected = record.selected && typeof record.selected === 'object' ? record.selected as Record<string, unknown> : {};
    const download = record.download && typeof record.download === 'object' ? record.download as Record<string, unknown> : {};
    const selectedValues = Object.entries(selected).map(([key, candidate]) => (
      key === 'url' && typeof candidate === 'string' ? canonicalAnnasAuditUrl(candidate) : candidate
    ));
    const matches = stable.some((value) => selectedValues.some((candidate) => candidate === value));
    const path = typeof download.path === 'string' ? download.path : typeof record.target_path === 'string' ? record.target_path : undefined;
    if (matches && path && await exists(path)) return { reason: 'stable_locator_seen_in_audit', targetPath: path };
  }
  return undefined;
}

// Re-ingest holds the whole file in memory the way a fresh download does, so it answers to
// the same configured size limit rather than trusting whatever is sitting in the books root.
export async function readExistingAnnasBookFile(targetPath: string, maxDownloadBytes: number): Promise<Uint8Array> {
  const info = await stat(targetPath);
  if (info.size > maxDownloadBytes) {
    throw new DomainExpertWorkerError(
      413,
      'annas_archive_download_size_limit_exceeded',
      `The already-acquired Anna Archive file exceeds the ${maxDownloadBytes} byte download limit.`,
    );
  }
  return new Uint8Array(await readFile(targetPath));
}

export async function writeAnnasBookFile(rootPath: string, relativePath: string, bytes: Uint8Array): Promise<void> {
  const targetPath = await resolveWritePathInside(
    rootPath,
    relativePath,
    'Anna Archive download path escaped the configured books root.',
  );
  await mkdir(dirname(targetPath), { recursive: true });
  try {
    await writeFile(targetPath, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'EEXIST') {
      throw new DomainExpertWorkerError(409, 'annas_archive_duplicate_path', 'Anna Archive target file already exists; refusing to overwrite.');
    }
    throw error;
  }
}

export async function appendAnnasAudit(root: string, record: Record<string, unknown>): Promise<void> {
  const rootPath = resolve(root);
  await mkdir(rootPath, { recursive: true });
  const auditFile = await open(join(rootPath, ANNAS_AUDIT_FILE), 'a', 0o600);
  try {
    await auditFile.chmod(0o600);
    await auditFile.appendFile(`${JSON.stringify(record)}\n`, 'utf8');
  } finally {
    await auditFile.close();
  }
}

function safeAnnasPathSegment(value: string): string {
  return safeObjectName(value).replace(/-+/g, '-').replace(/^-+|-+$/g, '') || randomUUID();
}

export function annasSelectionAudit(params: AnnasArchiveImportParams): Record<string, unknown> {
  const url = params.url ? canonicalAnnasAuditUrl(params.url) : undefined;
  return {
    ...(params.annasArchiveId ? { annas_archive_id: params.annasArchiveId } : {}),
    ...(url ? { url } : {}),
    ...(params.md5 ? { md5: params.md5 } : {}),
    ...(params.title ? { title: params.title } : {}),
    ...(params.author ? { author: params.author } : {}),
    ...(params.year ? { year: params.year } : {}),
    ...(params.topic ? { topic: params.topic } : {}),
    ...(params.format ? { format: params.format } : {}),
    copyright_posture: params.copyrightPosture,
  };
}

function canonicalAnnasAuditUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

/** An ingest asked of a domain with no page library: the download is kept and nothing is ingested. */
export function annasNoPageLibrary(sourcePath: string): { ragIngest: Record<string, unknown>; registry: Record<string, unknown> } {
  return {
    ragIngest: { status: 'blocked', error: {
      code: 'page_library_not_configured',
      message: `This domain has no page library, so nothing was ingested. The download is on disk at ${sourcePath}.`,
      suggestion: 'Give the domain a page library, then re-run annas_archive_import with ingest: true.',
    } },
    registry: { status: 'skipped', reason: 'The ingest did not start.' },
  };
}

export function ingestErrorRecord(error: unknown): { code: string; message: string; suggestion?: string } {
  return error instanceof DomainExpertWorkerError
    ? { code: error.code, message: error.message, ...(error.suggestion ? { suggestion: error.suggestion } : {}) }
    : { code: 'rag_ingest_error', message: error instanceof Error ? error.message : String(error) };
}

// The acquisition's top-level status must not read as success when the
// ingest did not verify: a caller that only looks at the outer status saw
// 'downloaded' on 2026-09-20 for sixteen books that never entered the library.
export function annasAcquisitionStatus(base: 'downloaded' | 'ingested_existing', ingestStatus: string): string {
  const prefix = base === 'downloaded' ? 'downloaded' : 'skipped_duplicate';
  if (ingestStatus === 'blocked') return `${prefix}_ingest_blocked`;
  if (ingestStatus === 'page_ingest_queued') return `${prefix}_ingest_in_progress`;
  return base;
}

export function optionalAnnasFormat(value: unknown): { format: NonNullable<AnnasArchiveImportParams['format']> } | Record<string, never> {
  if (value === undefined || value === null || value === '') return {};
  const format = String(value) as NonNullable<AnnasArchiveImportParams['format']>;
  if (!ANNAS_ARCHIVE_FORMATS.includes(format)) {
    throw new DomainExpertWorkerError(400, 'invalid_params', 'format is not a supported Anna Archive format.');
  }
  return { format };
}

export function optionalAnnasFormatPreference(value: unknown): { formatPreference: NonNullable<AnnasArchiveSearchParams['formatPreference']> } | Record<string, never> {
  if (value === undefined || value === null || value === '') return {};
  const preference = String(value) as NonNullable<AnnasArchiveSearchParams['formatPreference']>;
  if (!['auto', 'text_rag', 'layout'].includes(preference)) {
    throw new DomainExpertWorkerError(400, 'invalid_params', 'format_preference must be auto, text_rag, or layout.');
  }
  return { formatPreference: preference };
}
