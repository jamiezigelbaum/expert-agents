// Web import fetches: DNS-pinned HTTPS with public-address checks and byte budgets.
import { lookup } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { PDF_PROCESSING_MAX_BYTES } from './worker-config.ts';
import { DomainExpertWorkerError } from './worker-errors.ts';

export type ResolveHostImpl = (hostname: string) => Promise<string[]>;
export type WebImportFetchImpl = (url: URL, options: {
  signal: AbortSignal;
  validatedAddresses: readonly string[];
}) => Promise<Response>;

export interface WebImportFetchResult {
  url: string;
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}
// An ambiguous octet-stream has to be read before PDF magic can resolve its
// format, so the guarded fetch admits one complete immediately-processable PDF.
// Non-PDF processing remains subject to the smaller format-aware limit below.
const WEB_IMPORT_MAX_FETCH_BYTES = PDF_PROCESSING_MAX_BYTES;
const WEB_IMPORT_MAX_BATCH_BYTES = 100 * 1024 * 1024;
const WEB_IMPORT_MAX_FETCHES = 250;
const WEB_IMPORT_MAX_REDIRECTS = 10;
export const WEB_IMPORT_FETCH_TIMEOUT_MS = 15_000;

export function sanitizeWebImportProvenanceText(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/g, (match) => webImportProvenanceUrl(match));
}

export function webImportProvenanceUrl(value: string): string {
  try {
    const url = new URL(value);
    const allowed = allowedWebImportProvenanceParams(url);
    const params = new URLSearchParams();
    for (const [key, item] of url.searchParams.entries()) {
      if (allowed.has(key.toLowerCase())) params.append(key, item);
    }
    url.username = '';
    url.password = '';
    url.search = params.toString();
    url.hash = '';
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

function allowedWebImportProvenanceParams(url: URL): Set<string> {
  const hostname = normalizedUrlHostname(url);
  if ((hostname === 'youtube.com' || hostname === 'www.youtube.com' || hostname === 'm.youtube.com')
    && url.pathname === '/watch') {
    return new Set(['v']);
  }
  return new Set();
}

export function webImportFetchFromFetchImpl(_fetchImpl: typeof fetch): WebImportFetchImpl {
  return (_url, _options) => {
    return Promise.reject(new DomainExpertWorkerError(
      500,
      'web_import_unpinned_fetch_impl',
      'Guarded outbound fetches cannot use a generic fetchImpl because it cannot enforce the prevalidated destination address. Provide webImportFetchImpl or use the default pinned HTTPS transport.',
    ));
  };
}

// The runtime's socket layer may call this with {all: true} (happy-eyeballs
// family selection sorts the result array), or without it for a single
// address — both shapes must be served or the request dies inside net.
export function pinnedWebImportLookup(validatedAddresses: readonly string[]): (
  hostname: string,
  lookupOptions: unknown,
  callback: (err: Error | null, address?: unknown, family?: number) => void,
) => void {
  const entries = validatedAddresses
    .map((address) => ({ address, family: isIP(address) }))
    .filter((entry) => entry.family !== 0 && !isPrivateOrReservedAddress(entry.address));
  return (_hostname, lookupOptions, callback) => {
    const first = entries[0];
    if (!first) {
      callback(new Error('web_import pinned lookup has no validated public addresses.'));
      return;
    }
    if ((lookupOptions as { all?: boolean } | undefined)?.all) {
      callback(null, entries);
      return;
    }
    callback(null, first.address, first.family);
  };
}

export function defaultWebImportFetch(url: URL, options: {
  signal: AbortSignal;
  validatedAddresses: readonly string[];
}): Promise<Response> {
  const publicAddresses = options.validatedAddresses
    .filter((address) => isIP(address) !== 0 && !isPrivateOrReservedAddress(address));
  if (publicAddresses.length === 0) {
    return Promise.reject(new DomainExpertWorkerError(
      400,
      'web_import_private_address_denied',
      `web_import denied non-public address ${options.validatedAddresses[0] ?? 'unresolved'} for ${normalizedUrlHostname(url)}.`,
    ));
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpsRequest(url, {
      method: 'GET',
      lookup: pinnedWebImportLookup(publicAddresses) as never,
      signal: options.signal,
    }, (message) => {
      resolvePromise(responseFromIncomingMessage(message));
    });
    request.on('error', rejectPromise);
    request.end();
  });
}

function responseFromIncomingMessage(message: IncomingMessage): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, String(value));
    }
  }
  const status = message.statusCode && message.statusCode >= 100 && message.statusCode <= 599
    ? message.statusCode
    : 502;
  const body = status === 204 || status === 304 ? null : readableStreamFromIncomingMessage(message);
  return new Response(body, {
    status,
    headers,
    ...(message.statusMessage ? { statusText: message.statusMessage } : {}),
  });
}

function readableStreamFromIncomingMessage(message: IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      message.on('data', (chunk: Buffer | Uint8Array | string) => {
        if (typeof chunk === 'string') {
          controller.enqueue(new TextEncoder().encode(chunk));
          return;
        }
        controller.enqueue(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
      });
      message.on('end', () => controller.close());
      message.on('error', (error) => controller.error(error));
    },
    cancel() {
      message.destroy();
    },
  });
}

export async function guardedWebImportFetch(input: {
  url: string;
  fetchImpl: WebImportFetchImpl;
  resolveHost: ResolveHostImpl;
  budget: WebImportBudget;
  timeoutMs: number;
}): Promise<WebImportFetchResult> {
  let current = new URL(input.url);
  for (let redirects = 0; redirects <= WEB_IMPORT_MAX_REDIRECTS; redirects += 1) {
    const validatedAddresses = await assertWebImportUrlAllowed(current, input.resolveHost);
    if (input.budget.fetches >= WEB_IMPORT_MAX_FETCHES) {
      throw new DomainExpertWorkerError(400, 'web_import_fetch_limit_exceeded', 'web_import exceeded the maximum number of outbound fetches.');
    }
    input.budget.fetches += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    let response: Response;
    try {
      response = await input.fetchImpl(current, {
        validatedAddresses,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (controller.signal.aborted) {
        throw new DomainExpertWorkerError(408, 'web_import_fetch_timeout', `Timed out fetching ${webImportProvenanceUrl(current.toString())}.`);
      }
      throw error;
    }
    try {
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new DomainExpertWorkerError(400, 'web_import_redirect_without_location', `Redirect from ${webImportProvenanceUrl(current.toString())} did not include a Location header.`);
        }
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        throw new DomainExpertWorkerError(response.status, 'web_import_fetch_failed', `Fetch failed for ${webImportProvenanceUrl(current.toString())} with HTTP ${response.status}.`);
      }
      const bytes = await readCappedWebImportBody(response, input.budget, webImportProvenanceUrl(current.toString()), controller.signal);
      return {
        url: current.toString(),
        status: response.status,
        headers: response.headers,
        bytes,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new DomainExpertWorkerError(408, 'web_import_fetch_timeout', `Timed out fetching ${webImportProvenanceUrl(current.toString())}.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new DomainExpertWorkerError(400, 'web_import_redirect_limit_exceeded', 'web_import exceeded the maximum redirect count.');
}

interface WebImportBudget {
  fetches: number;
  totalBytes: number;
}

export function webImportBudget(): WebImportBudget {
  return { fetches: 0, totalBytes: 0 };
}

async function readCappedWebImportBody(response: Response, budget: WebImportBudget, url: string, signal: AbortSignal): Promise<Uint8Array> {
  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
  if (contentLength !== undefined && Number.isFinite(contentLength)) {
    if (contentLength > WEB_IMPORT_MAX_FETCH_BYTES) {
      throw new DomainExpertWorkerError(413, 'web_import_fetch_size_limit_exceeded', `Fetch for ${url} exceeded the ${WEB_IMPORT_MAX_FETCH_BYTES} byte per-fetch limit.`);
    }
    if (budget.totalBytes + contentLength > WEB_IMPORT_MAX_BATCH_BYTES) {
      throw new DomainExpertWorkerError(413, 'web_import_batch_size_limit_exceeded', 'web_import exceeded the 100 MB batch fetch limit.');
    }
  }
  const startingBudgetBytes = budget.totalBytes;
  const chunks: Uint8Array[] = [];
  let fetchBytes = 0;
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    fetchBytes = bytes.byteLength;
    enforceWebImportBodyBudget(fetchBytes, { ...budget, totalBytes: startingBudgetBytes }, url);
    budget.totalBytes += chargedWebImportBytes(contentLength, fetchBytes);
    return bytes;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        throw new DomainExpertWorkerError(408, 'web_import_fetch_timeout', `Timed out fetching ${url}.`);
      }
      const { done, value } = await readWebImportChunk(reader, signal);
      if (done) break;
      if (!value) continue;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      fetchBytes += chunk.byteLength;
      try {
        enforceWebImportBodyBudget(fetchBytes, { ...budget, totalBytes: startingBudgetBytes }, url);
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (signal.aborted) {
      await reader.cancel().catch(() => {});
      throw new DomainExpertWorkerError(408, 'web_import_fetch_timeout', `Timed out fetching ${url}.`);
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  budget.totalBytes += chargedWebImportBytes(contentLength, fetchBytes);
  const bytes = new Uint8Array(fetchBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function chargedWebImportBytes(contentLength: number | undefined, actualBytes: number): number {
  return contentLength !== undefined && Number.isFinite(contentLength)
    ? Math.max(contentLength, actualBytes)
    : actualBytes;
}

export function readWebImportChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> {
  if (signal.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(new DOMException('The operation was aborted.', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolvePromise(result);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        rejectPromise(error);
      },
    );
  });
}

function enforceWebImportBodyBudget(fetchBytes: number, budget: WebImportBudget, url: string): void {
  if (fetchBytes > WEB_IMPORT_MAX_FETCH_BYTES) {
    throw new DomainExpertWorkerError(413, 'web_import_fetch_size_limit_exceeded', `Fetch for ${url} exceeded the ${WEB_IMPORT_MAX_FETCH_BYTES} byte per-fetch limit.`);
  }
  if (budget.totalBytes + fetchBytes > WEB_IMPORT_MAX_BATCH_BYTES) {
    throw new DomainExpertWorkerError(413, 'web_import_batch_size_limit_exceeded', 'web_import exceeded the 100 MB batch fetch limit.');
  }
}

/**
 * The one destination guard both outbound lanes share: resolve the host, then
 * refuse the whole answer unless every address is public. Callers connect to
 * the addresses returned here and to nothing else, so a name that resolves
 * differently on a second lookup cannot move the connection into private space.
 * The reason is returned rather than thrown so each lane names the refusal in
 * its own error vocabulary.
 */
type PublicAddressResolution =
  | { ok: true; addresses: string[] }
  | { ok: false; reason: 'unresolved'; hostname: string }
  | { ok: false; reason: 'private_address'; hostname: string; address: string };

async function resolvePublicAddresses(url: URL, resolveHost: ResolveHostImpl): Promise<PublicAddressResolution> {
  const hostname = normalizedUrlHostname(url);
  const addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname);
  if (addresses.length === 0) return { ok: false, reason: 'unresolved', hostname };
  for (const address of addresses) {
    if (isPrivateOrReservedAddress(address)) {
      return { ok: false, reason: 'private_address', hostname, address };
    }
  }
  return { ok: true, addresses };
}

async function assertWebImportUrlAllowed(url: URL, resolveHost: ResolveHostImpl): Promise<string[]> {
  if (url.protocol !== 'https:') {
    throw new DomainExpertWorkerError(400, 'web_import_https_required', 'web_import only allows https URLs.');
  }
  // The URL is handed to summarize as child argv, so userinfo in it would be
  // readable from the process table — and it would be sent to the host as an
  // Authorization header besides.
  if (url.username || url.password) {
    throw new DomainExpertWorkerError(400, 'web_import_url_credentials_denied', 'web_import URLs may not carry embedded credentials.');
  }
  const resolution = await resolvePublicAddresses(url, resolveHost);
  if (resolution.ok) return resolution.addresses;
  throw resolution.reason === 'unresolved'
    ? new DomainExpertWorkerError(400, 'web_import_hostname_unresolved', `Could not resolve hostname ${resolution.hostname}.`)
    : new DomainExpertWorkerError(400, 'web_import_private_address_denied', `web_import denied non-public address ${resolution.address} for ${resolution.hostname}.`);
}

export async function assertAnnasPartnerUrlAllowed(url: URL, resolveHost: ResolveHostImpl): Promise<string[]> {
  const resolution = await resolvePublicAddresses(url, resolveHost);
  if (resolution.ok) return resolution.addresses;
  throw resolution.reason === 'unresolved'
    ? new DomainExpertWorkerError(502, 'annas_archive_partner_host_unresolved', `Could not resolve Anna Archive partner host ${resolution.hostname}.`)
    : new DomainExpertWorkerError(403, 'annas_archive_partner_address_denied', `Anna Archive partner download denied non-public address ${resolution.address} for ${resolution.hostname}.`);
}

export async function defaultResolveHost(hostname: string): Promise<string[]> {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(normalized)) return [normalized];
  const records = await lookup(normalized, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

export function normalizedUrlHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function isPrivateOrReservedAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  const mapped = ipv4FromMappedIpv6(normalized) ?? normalized;
  const family = isIP(mapped);
  if (family === 4) return isPrivateOrReservedIpv4(mapped);
  if (family === 6) return isPrivateOrReservedIpv6(mapped);
  return true;
}

function isPrivateOrReservedIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a = -1, b = -1] = parts;
  return a === 0
    || a === 10
    || a === 127
    || a >= 224
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19));
}

function isPrivateOrReservedIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb')
    || normalized.startsWith('ff');
}

function ipv4FromMappedIpv6(address: string): string | undefined {
  const words = expandIpv6Words(address);
  if (!words || words.length !== 8) return undefined;
  if (
    words.slice(0, 5).some((word) => word !== 0)
    || words[5] !== 0xffff
  ) {
    return undefined;
  }
  const [high = 0, low = 0] = words.slice(6);
  return [
    (high >> 8) & 0xff,
    high & 0xff,
    (low >> 8) & 0xff,
    low & 0xff,
  ].join('.');
}

function expandIpv6Words(address: string): number[] | undefined {
  const normalized = replaceDottedIpv4Tail(address);
  if (!normalized) return undefined;
  const parts = normalized.split('::');
  if (parts.length > 2) return undefined;
  const left = ipv6WordsFromPart(parts[0] ?? '');
  const right = parts.length === 2 ? ipv6WordsFromPart(parts[1] ?? '') : [];
  if (!left || !right) return undefined;
  if (parts.length === 1) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [
    ...left,
    ...Array.from({ length: missing }, () => 0),
    ...right,
  ];
}

function replaceDottedIpv4Tail(address: string): string | undefined {
  const dotted = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address)?.[1];
  if (!dotted) return address;
  const parts = dotted.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  const high = ((parts[0] ?? 0) << 8) | (parts[1] ?? 0);
  const low = ((parts[2] ?? 0) << 8) | (parts[3] ?? 0);
  return `${address.slice(0, -dotted.length)}${high.toString(16)}:${low.toString(16)}`;
}

function ipv6WordsFromPart(part: string): number[] | undefined {
  if (!part) return [];
  const words = part.split(':').map((segment) => {
    if (!/^[0-9a-f]{1,4}$/i.test(segment)) return Number.NaN;
    return Number.parseInt(segment, 16);
  });
  return words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : undefined;
}
