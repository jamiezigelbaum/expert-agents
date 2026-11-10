// Google Cloud Storage client and credentials for library originals, and the GCS destination allowlist.
import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { LibraryObjectExistsError, LibraryReadError } from './library-objects.ts';
import type { DomainExpertGoogleConfig, GoogleConfigurationStatus, GoogleServiceAccountCredential } from './worker-config.ts';
import { isHttpsUrl, copyToArrayBuffer, asOptionalRecord, decodeUtf8Bytes, requireString } from './worker-util.ts';
import { responseTextOrJson, sanitizeUpstreamText, UPSTREAM_ERROR_TEXT_MAX_CHARACTERS } from './upstream.ts';
import { upstreamResponseContexts, DomainExpertWorkerError } from './worker-errors.ts';
import { readWebImportChunk } from './network-guard.ts';

const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/devstorage.read_write',
];

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Compute Engine instance metadata server. Only the attached identity can
// answer here, so the URL is fixed: it is never configuration.
const GOOGLE_METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const GOOGLE_METADATA_PROBE_TIMEOUT_MS = 3_000;
const GOOGLE_API_REQUEST_TIMEOUT_MS = 30_000;

export class GoogleRuntimeClient {
  private config: DomainExpertGoogleConfig;
  private tokenCache?: { token: string; expiresAtMs: number };

  constructor(config: DomainExpertGoogleConfig) {
    this.config = {
      ...config,
      scopes: config.scopes ?? DEFAULT_SCOPES,
    };
  }

  async configurationStatus(): Promise<GoogleConfigurationStatus> {
    if (this.config.accessToken?.trim()) return 'ready';
    const inlineJson = this.config.serviceAccountJson?.trim();
    const jsonPath = this.config.serviceAccountJsonPath?.trim();
    if (!inlineJson && !jsonPath) {
      if (!this.config.metadataServerToken) return 'not_configured';
      // Health is the deploy proof, so the flag alone must not read as ready:
      // an attached identity is only real when the metadata server answers.
      return await this.metadataServerAnswers() ? 'ready' : 'unreadable';
    }

    try {
      const raw = inlineJson ?? await readFile(jsonPath!, 'utf8');
      const credential = JSON.parse(raw) as Partial<GoogleServiceAccountCredential>;
      return typeof credential.client_email === 'string'
        && Boolean(credential.client_email.trim())
        && typeof credential.private_key === 'string'
        && Boolean(credential.private_key.trim())
        && (credential.token_uri === undefined || isHttpsUrl(credential.token_uri))
        ? 'ready'
        : 'unreadable';
    } catch {
      return 'unreadable';
    }
  }

  async uploadGcsObject(bucket: string, objectName: string, bytes: Uint8Array, options: { ifGenerationMatch?: string } = {}): Promise<unknown> {
    const precondition = options.ifGenerationMatch === undefined ? '' : `&ifGenerationMatch=${encodeURIComponent(options.ifGenerationMatch)}`;
    return this.googleBytes(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}${precondition}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Blob([copyToArrayBuffer(bytes)], { type: 'application/octet-stream' }),
    });
  }

  // The object's first bytes, by a ranged read; null when it does not exist.
  async readGcsObjectHead(bucket: string, objectName: string, length: number): Promise<Uint8Array | null> {
    const response = await this.authedFetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?alt=media`,
      { headers: { Range: `bytes=0-${length - 1}` } },
    );
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) throw googleError(response, await responseTextOrJson(response));
    return new Uint8Array(await response.arrayBuffer()).subarray(0, length);
  }

  async getGcsObjectMetadata(bucket: string, objectName: string): Promise<GcsObjectMetadata | null> {
    const response = await this.authedFetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?fields=generation,size,md5Hash,crc32c`,
    );
    const body = await responseTextOrJson(response);
    if (response.status === 404) return null;
    if (!response.ok) throw googleError(response, body);
    const record = asOptionalRecord(body) ?? {};
    const field = (key: string) => (typeof record[key] === 'string' ? { [key]: record[key] as string } : {});
    return { ...field('generation'), ...field('size'), ...field('md5Hash'), ...field('crc32c') };
  }

  async downloadGcsObject(bucket: string, objectName: string): Promise<Uint8Array | null> {
    const response = await this.authedFetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?alt=media`,
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      const body = await responseTextOrJson(response);
      throw googleError(response, body);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async listLibraryObjectNames(bucket: string, prefix: string, timeoutMs: number): Promise<string[]> {
    const names: string[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.authedFetch(
        `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o?prefix=${encodeURIComponent(prefix)}&fields=items(name),nextPageToken${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
        {}, timeoutMs,
      );
      const body = asOptionalRecord(await responseTextOrJson(response)) ?? {};
      if (!response.ok) throw new LibraryReadError('library_read_unavailable', 'The source or library state could not be read or validated.', 502);
      for (const item of Array.isArray(body.items) ? body.items : []) {
        const name = asOptionalRecord(item)?.name;
        if (typeof name === 'string') names.push(name);
      }
      pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : undefined;
    } while (pageToken && names.length < 10_000);
    return names;
  }

  async downloadLibraryObject(bucket: string, objectName: string, maxBytes: number, timeoutMs: number): Promise<Uint8Array | null> {
    const response = await this.authedFetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?alt=media`,
      {}, timeoutMs,
    );
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) {
      await response.body?.cancel();
      throw new LibraryReadError('library_read_unavailable', 'The source or library state could not be read or validated.', 502);
    }
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      throw new LibraryReadError('library_source_too_large', 'The source exceeds the worker read size limit.', 413);
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const signal = upstreamResponseContexts.get(response)!.signal;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await readWebImportChunk(reader, signal);
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new LibraryReadError('library_source_too_large', 'The source exceeds the worker read size limit.', 413);
        chunks.push(value);
      }
      return new Uint8Array(Buffer.concat(chunks, size));
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  // A bounded read for passage completion: a short timeout and a size cap, so
  // an optional extension never holds up or bloats an answer.
  async downloadGcsText(bucket: string, objectName: string, maxBytes: number, timeoutMs: number): Promise<string | null> {
    const response = await this.authedFetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?alt=media`,
      {},
      timeoutMs,
    );
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      const body = await responseTextOrJson(response);
      throw googleError(response, body);
    }
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > maxBytes) {
      await response.body?.cancel();
      throw new Error('source text exceeds the completion read limit');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('source text exceeds the completion read limit');
    return decodeUtf8Bytes(bytes);
  }

  private async googleBytes(url: string, init: RequestInit): Promise<unknown> {
    const response = await this.authedFetch(url, init);
    const body = await responseTextOrJson(response);
    if (!response.ok) throw googleError(response, body);
    return body;
  }

  private async authedFetch(
    url: string,
    init: RequestInit = {},
    timeoutMs: number = GOOGLE_API_REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const token = await this.accessToken();
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await (this.config.fetchImpl ?? fetch)(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
        signal,
      });
      upstreamResponseContexts.set(response, {
        signal,
        timeoutError: googleRequestTimeoutError,
        sensitiveValues: [token],
      });
      return response;
    } catch (error) {
      if (signal.aborted) throw googleRequestTimeoutError();
      throw error;
    }
  }

  private usesMetadataServer(): boolean {
    return Boolean(this.config.metadataServerToken)
      && !this.config.serviceAccountJson?.trim()
      && !this.config.serviceAccountJsonPath?.trim();
  }

  private async metadataServerAnswers(): Promise<boolean> {
    try {
      const response = await (this.config.fetchImpl ?? fetch)(GOOGLE_METADATA_TOKEN_URL, {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(GOOGLE_METADATA_PROBE_TIMEOUT_MS),
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  private async metadataServerAccessToken(): Promise<string> {
    const signal = AbortSignal.timeout(GOOGLE_API_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await (this.config.fetchImpl ?? fetch)(GOOGLE_METADATA_TOKEN_URL, {
        headers: { 'Metadata-Flavor': 'Google' },
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw googleRequestTimeoutError();
      throw new DomainExpertWorkerError(503, 'google_auth_not_configured', 'The instance metadata server is unreachable; attached-identity credentials are unavailable.');
    }
    upstreamResponseContexts.set(response, { signal, timeoutError: googleRequestTimeoutError, sensitiveValues: [] });
    const body = await responseTextOrJson(response);
    if (!response.ok) {
      throw new DomainExpertWorkerError(503, 'google_auth_not_configured', `The instance metadata server refused a token with HTTP ${response.status}.`);
    }
    const token = requireString((body as Record<string, unknown>).access_token, 'access_token');
    const expiresIn = Number((body as Record<string, unknown>).expires_in ?? 3600);
    this.tokenCache = { token, expiresAtMs: Date.now() + Math.max(300, expiresIn - 60) * 1000 };
    return token;
  }

  private async accessToken(): Promise<string> {
    if (this.config.accessToken) return this.config.accessToken;
    if (this.tokenCache && this.tokenCache.expiresAtMs > Date.now() + 60_000) return this.tokenCache.token;
    if (this.usesMetadataServer()) return this.metadataServerAccessToken();
    const credential = await this.serviceAccountCredential();
    const iat = Math.floor(Date.now() / 1000);
    const assertion = signJwt(
      { alg: 'RS256', typ: 'JWT' },
      {
        iss: credential.client_email,
        scope: (this.config.scopes ?? DEFAULT_SCOPES).join(' '),
        aud: credential.token_uri ?? GOOGLE_TOKEN_URL,
        iat,
        exp: iat + 3600,
      },
      credential.private_key,
    );
    const signal = AbortSignal.timeout(GOOGLE_API_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await (this.config.fetchImpl ?? fetch)(credential.token_uri ?? GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw googleRequestTimeoutError();
      throw error;
    }
    upstreamResponseContexts.set(response, {
      signal,
      timeoutError: googleRequestTimeoutError,
      sensitiveValues: [assertion],
    });
    const body = await responseTextOrJson(response);
    if (!response.ok) throw googleError(response, body);
    const token = requireString((body as Record<string, unknown>).access_token, 'access_token');
    const expiresIn = Number((body as Record<string, unknown>).expires_in ?? 3600);
    this.tokenCache = { token, expiresAtMs: Date.now() + Math.max(300, expiresIn - 60) * 1000 };
    return token;
  }

  private async serviceAccountCredential(): Promise<GoogleServiceAccountCredential> {
    const raw = this.config.serviceAccountJson
      ?? (this.config.serviceAccountJsonPath ? await readFile(this.config.serviceAccountJsonPath, 'utf8') : undefined);
    if (!raw) {
      throw new DomainExpertWorkerError(503, 'google_auth_not_configured', 'Google service account JSON or access token is not configured.');
    }
    const credential = JSON.parse(raw) as Partial<GoogleServiceAccountCredential>;
    if (!credential.client_email || !credential.private_key) {
      throw new DomainExpertWorkerError(503, 'google_auth_not_configured', 'Google service account JSON is missing client_email or private_key.');
    }
    // token_uri is both the JWT audience and the POST target, so an
    // unconstrained value would send a bearer-grade assertion for this
    // service account to an arbitrary host.
    if (credential.token_uri !== undefined && !isHttpsUrl(credential.token_uri)) {
      throw new DomainExpertWorkerError(503, 'google_auth_not_configured', 'Google service account token_uri must be an https URL.');
    }
    return {
      client_email: credential.client_email,
      private_key: credential.private_key,
      ...(credential.token_uri ? { token_uri: credential.token_uri } : {}),
      ...(credential.project_id ? { project_id: credential.project_id } : {}),
    };
  }
}

function signJwt(header: Record<string, unknown>, claim: Record<string, unknown>, privateKey: string): string {
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedClaim = base64Url(JSON.stringify(claim));
  const signingInput = `${encodedHeader}.${encodedClaim}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  return `${signingInput}.${base64Url(signature)}`;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function googleRequestTimeoutError(): DomainExpertWorkerError {
  return new DomainExpertWorkerError(504, 'google_api_error', 'Google API request timed out.');
}

// GCS answers 412 to a create-only write over an existing object; the local store throws its own error.
export function isCreateOnlyConflict(error: unknown): boolean {
  return error instanceof LibraryObjectExistsError || (error instanceof DomainExpertWorkerError && error.status === 412);
}

function googleError(response: Response, body: unknown): DomainExpertWorkerError {
  const upstreamMessage = typeof body === 'object' && body && 'error' in body
    ? JSON.stringify((body as Record<string, unknown>).error)
    : `Google API request failed with HTTP ${response.status}.`;
  const message = sanitizeUpstreamText(
    upstreamMessage,
    upstreamResponseContexts.get(response)?.sensitiveValues ?? [],
    UPSTREAM_ERROR_TEXT_MAX_CHARACTERS,
  );
  const error = new DomainExpertWorkerError(response.status, 'google_api_error', message);
  // The raw body feeds only googleNotFoundResourceKind; it never reaches a
  // response or journal line, so it stays unsanitized for classification.
  error.googleErrorBody = body;
  return error;
}

export function parseGcsPrefix(prefix: string): { bucket: string; prefix: string } {
  if (!prefix.startsWith('gs://')) throw new DomainExpertWorkerError(400, 'invalid_gcs_prefix', 'GCS prefix must start with gs://.');
  const withoutScheme = prefix.slice('gs://'.length);
  const slash = withoutScheme.indexOf('/');
  const bucket = slash === -1 ? withoutScheme : withoutScheme.slice(0, slash);
  const objectPrefix = slash === -1 ? '' : `${withoutScheme.slice(slash + 1).replace(/\/?$/, '/')}`;
  if (!bucket) throw new DomainExpertWorkerError(400, 'invalid_gcs_prefix', 'GCS prefix must include a bucket.');
  return { bucket, prefix: objectPrefix };
}

export function gcsPrefixesCover(prefixes: string[], uri: string): boolean {
  return prefixes.some((prefix) => {
    const normalized = prefix.replace(/\/+$/g, '');
    return uri === normalized || uri.startsWith(`${normalized}/`);
  });
}

export function assertAllowedGcsDestination(destinationUri: string, allowedPrefixes: string[]): void {
  if (!destinationUri.startsWith('gs://')) {
    throw new DomainExpertWorkerError(400, 'invalid_gcs_prefix', 'GCS destination must start with gs://.');
  }
  // Allowlist checks compare string prefixes; a dot segment must never reach one.
  if (destinationUri.slice('gs://'.length).split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new DomainExpertWorkerError(400, 'invalid_gcs_prefix', 'GCS destination must not contain . or .. path segments.');
  }
  const allowed = allowedPrefixes.some((prefix) => {
    const normalizedPrefix = prefix.replace(/\/+$/g, '');
    return destinationUri === normalizedPrefix || destinationUri.startsWith(`${normalizedPrefix}/`);
  });
  if (!allowed) {
    throw new DomainExpertWorkerError(
      403,
      'gcs_destination_not_allowed',
      `GCS destination must be inside one of the domain allowlisted prefixes: ${allowedPrefixes.join(', ')}.`,
    );
  }
}

interface GcsObjectMetadata {
  generation?: string;
  size?: string;
  md5Hash?: string;
  crc32c?: string;
}
