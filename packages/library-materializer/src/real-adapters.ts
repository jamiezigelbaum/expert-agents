import {
  llmParserEligibleUris,
  ragIngestionConfig,
  resolveRagParserModel,
  validateLibraryLocationConfig,
  validatedVertexOperationName,
} from "@expert-agents/library";
import {
  GcsCasConflictError,
  type ExpectedGcsGeneration,
  type GcsAdapter,
  type GcsGeneration,
  type GcsReadResult,
  type VertexAdapter,
  type VertexFile,
} from "./adapters.ts";
import type { AccessTokenProvider, FetchLike } from "./google-auth.ts";

export interface GoogleGcsAdapterOptions {
  bucket: string;
  prefix: string;
  tokenProvider: AccessTokenProvider;
  fetchImpl?: FetchLike;
  writeRetries?: number;
  writeRetryDelayMs?: number;
}

export class GoogleApiError extends Error {
  readonly code = "google_api_error" as const;

  constructor(
    public readonly operation: string,
    public readonly status: number,
  ) {
    super(`${operation} failed with HTTP ${status}`);
    this.name = "GoogleApiError";
  }
}

// Only validated provider resource references are retained; provider error text
// may include private source paths or credentials and is never copied here.
export class VertexOperationError extends GoogleApiError {
  constructor(operation: string, status: number, public readonly operationName: string) {
    super(operation, status);
    this.name = "VertexOperationError";
  }
}

const VERTEX_MAX_PAGES = 100;

export class VertexPaginationError extends GoogleApiError {
  readonly maxPages = VERTEX_MAX_PAGES;

  constructor(operation: string, reason: "page cap reached" | "repeated nextPageToken") {
    super(`${operation} pagination violated the ${VERTEX_MAX_PAGES}-page cap (${reason})`, 502);
    this.name = "VertexPaginationError";
  }
}

export function isVertexImportRejection(error: unknown): error is GoogleApiError {
  return error instanceof GoogleApiError
    && (error.status === 400 || error.status === 422)
    && error.operation.startsWith("Vertex RAG file import rejected:");
}

export class GoogleGcsAdapter implements GcsAdapter {
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #tokenProvider: AccessTokenProvider;
  readonly #fetch: FetchLike;
  readonly #writeRetries: number;
  readonly #writeRetryDelayMs: number;

  constructor(options: GoogleGcsAdapterOptions) {
    const location = validateLibraryLocationConfig({ bucket: options.bucket, prefix: options.prefix });
    this.#bucket = location.bucket;
    this.#prefix = location.prefix;
    this.#tokenProvider = options.tokenProvider;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#writeRetries = options.writeRetries ?? 5;
    this.#writeRetryDelayMs = options.writeRetryDelayMs ?? 1_500;
  }

  async read(path: string): Promise<GcsReadResult | null> {
    const objectName = this.#objectName(path);
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.#bucket)}/o/${encodeURIComponent(objectName)}`);
    url.searchParams.set("alt", "media");
    const response = await this.#authedFetch(url, { method: "GET" });
    if (response.status === 404) return null;
    if (!response.ok) throw new GoogleApiError("GCS read", response.status);
    const generation = response.headers.get("x-goog-generation");
    if (generation === null || !/^\d+$/.test(generation)) {
      throw new GoogleApiError("GCS read generation", response.status);
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      generation,
    };
  }

  async writeIfGeneration(
    path: string,
    bytes: Uint8Array,
    expectedGeneration: ExpectedGcsGeneration,
  ): Promise<GcsGeneration> {
    const objectName = this.#objectName(path);
    const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.#bucket)}/o`);
    url.searchParams.set("uploadType", "media");
    url.searchParams.set("name", objectName);
    url.searchParams.set("ifGenerationMatch", String(expectedGeneration));
    // GCS allows roughly one write per second per object; rapid successive
    // conditional writes (e.g. per-entry ledger updates) draw 429s that are
    // safe to retry with the same precondition.
    let response: Response;
    for (let attempt = 0; ; attempt += 1) {
      response = await this.#authedFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: copyToArrayBuffer(bytes),
      });
      if ((response.status !== 429 && response.status !== 503) || attempt >= this.#writeRetries) break;
      if (this.#writeRetryDelayMs > 0) await Bun.sleep(this.#writeRetryDelayMs);
    }
    if (response.status === 412) throw new GcsCasConflictError(path);
    const body = await responseRecord(response, "GCS conditional write");
    const generation = body.generation;
    if (typeof generation !== "string" || !/^\d+$/.test(generation)) {
      throw new GoogleApiError("GCS write generation", response.status);
    }
    return generation;
  }

  async exists(path: string): Promise<boolean> {
    const objectName = this.#objectName(path);
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.#bucket)}/o/${encodeURIComponent(objectName)}`);
    url.searchParams.set("fields", "name");
    const response = await this.#authedFetch(url, { method: "GET" });
    if (response.status === 404) return false;
    if (!response.ok) throw new GoogleApiError("GCS existence check", response.status);
    return true;
  }

  async #authedFetch(url: URL, init: RequestInit): Promise<Response> {
    const token = await this.#tokenProvider.getAccessToken();
    return this.#fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });
  }

  #objectName(path: string): string {
    if (path.length === 0 || path.startsWith("/") || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new GoogleApiError("GCS path validation", 0);
    }
    return `${this.#prefix}/${path}`;
  }
}

export interface GoogleVertexAdapterOptions {
  project: string;
  location: string;
  tokenProvider: AccessTokenProvider;
  fetchImpl?: FetchLike;
  pollIntervalMs?: number;
  maxPolls?: number;
  quotaRetries?: number;
  quotaRetryDelayMs?: number;
  // Parser model for imported files: unset selects the default LLM parser
  // model, the literal "default" disables the parser. See resolveRagParserModel.
  parserModel?: string;
  // Receipts prefix (a gs:// directory URI) that receives Vertex's per-file
  // import results via importResultGcsSink. Unset sends no sink, leaving
  // per-file failures only in transient LRO metadata.
  importResultGcsPrefix?: string;
}

export class GoogleVertexAdapter implements VertexAdapter {
  readonly #project: string;
  readonly #location: string;
  readonly #tokenProvider: AccessTokenProvider;
  readonly #fetch: FetchLike;
  readonly #pollIntervalMs: number;
  readonly #maxPolls: number;
  readonly #quotaRetries: number;
  readonly #quotaRetryDelayMs: number;
  readonly #parserModel: string | undefined;
  readonly #importResultGcsPrefix: string | undefined;
  #verifiedProjectNumber: string | undefined;

  constructor(options: GoogleVertexAdapterOptions) {
    this.#project = requirePathSegment(options.project, "Vertex project");
    this.#location = requirePathSegment(options.location, "Vertex location");
    this.#tokenProvider = options.tokenProvider;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    // Quota-throttled bulk imports can legitimately run long; a poll timeout
    // is tolerated per-file upstream and recovered by listing on rerun.
    this.#maxPolls = options.maxPolls ?? 900;
    this.#quotaRetries = options.quotaRetries ?? 4;
    this.#quotaRetryDelayMs = options.quotaRetryDelayMs ?? 30_000;
    this.#parserModel = resolveRagParserModel(options.parserModel);
    this.#importResultGcsPrefix = options.importResultGcsPrefix === undefined
      ? undefined
      : `${requireGcsUri(options.importResultGcsPrefix).replace(/\/+$/, "")}/`;
  }

  async ensureCorpus(displayName: string): Promise<string> {
    const name = requireNonEmptyString(displayName, "Vertex corpus display name");
    const seenPageTokens = new Set<string>();
    let pageCount = 0;
    let pageToken: string | undefined;
    do {
      const url = new URL(`${this.#base()}/v1/projects/${encodeURIComponent(this.#project)}/locations/${encodeURIComponent(this.#location)}/ragCorpora`);
      if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
      const response = await this.#json(url, { method: "GET" }, "Vertex corpus list");
      const corpora = Array.isArray(response.ragCorpora) ? response.ragCorpora : [];
      for (const corpus of corpora) {
        if (isRecord(corpus) && corpus.displayName === name && typeof corpus.name === "string") {
          return this.#ownedCorpusResourceName(corpus.name);
        }
      }
      pageCount += 1;
      pageToken = typeof response.nextPageToken === "string" && response.nextPageToken.length > 0
        ? response.nextPageToken
        : undefined;
      assertVertexPagination(pageToken, pageCount, seenPageTokens, "Vertex corpus list");
    } while (pageToken !== undefined);

    // Establish canonical project custody before the non-idempotent create.
    // Resource Manager v1 explicitly accepts a project ID and returns its number.
    const createProjects = await this.#createProjectAliases();
    const createUrl = new URL(`${this.#base()}/v1/projects/${encodeURIComponent(this.#project)}/locations/${encodeURIComponent(this.#location)}/ragCorpora`);
    const operation = await this.#json(createUrl, {
      method: "POST",
      body: JSON.stringify({ displayName: name }),
    }, "Vertex corpus create");
    const result = await this.#waitForOperation(operation, "Vertex corpus create", createProjects.map((project) => `projects/${project}/locations/${this.#location}`));
    const resourceName = nestedString(result, ["response", "name"])
      ?? nestedString(result, ["metadata", "ragCorpus", "name"]);
    if (resourceName === undefined) throw new GoogleApiError("Vertex corpus create response", 200);
    const corpus = await this.#ownedCorpusResourceName(resourceName);
    if (!createProjects.includes(corpus.split("/")[1]!)) {
      throw new VertexOperationError("Vertex corpus create resource scope validation", 0, result.name as string);
    }
    return corpus;
  }

  async #createProjectAliases(): Promise<string[]> {
    if (/^[0-9]+$/.test(this.#project)) return [this.#project];
    if (this.#verifiedProjectNumber === undefined) {
      let project: Record<string, unknown>;
      try {
        project = await this.#json(
          new URL(`https://cloudresourcemanager.googleapis.com/v1/projects/${this.#project}`),
          { method: "GET" }, "Vertex project identity lookup",
        );
      } catch (error) {
        throw error instanceof GoogleApiError ? error : new GoogleApiError("Vertex project identity lookup", 0);
      }
      if (project.projectId !== this.#project || typeof project.projectNumber !== "string"
        || !/^[1-9][0-9]*$/.test(project.projectNumber)) {
        throw new GoogleApiError("Vertex project identity validation", 0);
      }
      this.#verifiedProjectNumber = project.projectNumber;
    }
    return [this.#project, this.#verifiedProjectNumber];
  }

  async importFile(corpusResourceName: string, gcsUri: string): Promise<string> {
    const corpus = await this.#ownedCorpusResourceName(corpusResourceName);
    const uri = requireGcsUri(gcsUri);
    const url = new URL(`${this.#base()}/v1/${corpus}/ragFiles:import`);
    // Bulk imports routinely trip the embedding backend's quota; those
    // rejections are transient, so retry them with a delay before failing.
    for (let attempt = 0; ; attempt += 1) {
      let operation: Record<string, unknown>;
      try {
        operation = await this.#json(url, {
          method: "POST",
          body: JSON.stringify({
            importRagFilesConfig: {
              gcsSource: { uris: [uri] },
              // Per-request unique sink directory: Vertex's result-file naming
              // under a shared prefix is undocumented, so each attempt writes
              // its receipts into its own directory rather than risking
              // overwrites. Field shape verified 2026-07-30 against the live
              // v1 discovery document (GcsDestination.outputUriPrefix).
              ...(this.#importResultGcsPrefix === undefined ? {} : {
                importResultGcsSink: { outputUriPrefix: `${this.#importResultGcsPrefix}${crypto.randomUUID()}/` },
              }),
              ...ragIngestionConfig({
                project: this.#project,
                location: this.#location,
                parserModel: this.#parserModel,
                llmParserEligible: llmParserEligibleUris([uri]),
              }),
            },
          }),
        }, "Vertex RAG file import");
      } catch (error) {
        // A 400/422 on the import request itself is this file's problem, not
        // the run's: surface it as a per-file rejection so the materializer
        // records it and continues. Auth/quota/server errors stay fatal here
        // (quota is handled at the operation level, auth is systemic).
        if (error instanceof GoogleApiError && (error.status === 400 || error.status === 422)) {
          throw new GoogleApiError("Vertex RAG file import rejected: request", error.status);
        }
        throw error instanceof GoogleApiError ? error : new GoogleApiError("Vertex RAG file import submission", 0);
      }
      // Vertex names the import operation under the project NUMBER even when
      // the corpus reference carries the project ID (live 2026-09-20: every
      // import failed operation scope validation with a project-ID corpus).
      // Both verified aliases of the same corpus are trusted parents; the
      // identity lookup runs only when the plain corpus form does not match.
      const parents = validatedVertexOperationName(operation.name, [corpus]) === undefined
        && this.#looksLikeNumericProjectAlias(operation.name, corpus)
        ? await this.#corpusAliases(corpus)
        : [corpus];
      const result = await this.#waitForOperation(operation, "Vertex RAG file import", parents);
      const rejection = importRejectionMessage(result);
      if (rejection === undefined) {
        // The v1 ImportRagFilesResponse reports only imported counts, so the
        // new file must be resolved by matching its URI in the corpus listing.
        try {
          const match = (await this.listFiles(corpus)).find((file) => file.gcsUri === uri);
          if (match === undefined) throw new GoogleApiError("Vertex RAG file import ACTIVE file proof", 409);
          return match.ragFileId;
        } catch (error) {
          throw new VertexOperationError("Vertex RAG file import ACTIVE file proof", error instanceof GoogleApiError ? error.status : 0, result.name as string);
        }
      }
      if (!isKnownQuotaRejection(result) || attempt >= this.#quotaRetries) {
        throw new VertexOperationError(`Vertex RAG file import rejected: ${rejection}`, 422, result.name as string);
      }
      if (this.#quotaRetryDelayMs > 0) await Bun.sleep(this.#quotaRetryDelayMs);
    }
  }

  async listFiles(corpusResourceName: string): Promise<VertexFile[]> {
    const corpus = await this.#ownedCorpusResourceName(corpusResourceName);
    const files: VertexFile[] = [];
    const seenPageTokens = new Set<string>();
    let pageCount = 0;
    let pageToken: string | undefined;
    do {
      const url = new URL(`${this.#base()}/v1/${corpus}/ragFiles`);
      if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
      const response = await this.#json(url, { method: "GET" }, "Vertex RAG file list");
      for (const value of Array.isArray(response.ragFiles) ? response.ragFiles : []) {
        if (!isRecord(value) || typeof value.name !== "string") continue;
        if (!isScopedResource(value.name, `${corpus}/ragFiles/`)) {
          // Vertex lists rag files under the project NUMBER even when the
          // corpus was addressed by project ID; accept a verified alias only.
          if (!this.#looksLikeNumericProjectAlias(value.name, corpus)) continue;
          const aliasPrefixes = (await this.#corpusAliases(corpus)).map((alias) => `${alias}/ragFiles/`);
          if (!aliasPrefixes.some((prefix) => isScopedResource(value.name as string, prefix))) continue;
        }
        if (nestedString(value, ["fileStatus", "state"]) !== "ACTIVE") continue;
        const gcsUri = typeof value.sourceUri === "string"
          ? value.sourceUri
          : nestedString(value, ["ragFileSource", "gcsSource", "uris", "0"])
            ?? nestedString(value, ["gcsSource", "uris", "0"]);
        if (gcsUri !== undefined && gcsUri.startsWith("gs://")) {
          files.push({ ragFileId: value.name, gcsUri });
        }
      }
      pageCount += 1;
      pageToken = typeof response.nextPageToken === "string" && response.nextPageToken.length > 0
        ? response.nextPageToken
        : undefined;
      assertVertexPagination(pageToken, pageCount, seenPageTokens, "Vertex RAG file list");
    } while (pageToken !== undefined);
    return files.sort((left, right) => compareStrings(left.ragFileId, right.ragFileId));
  }

  /**
   * True when `name` is scoped under the same location and corpus id as
   * `corpus` but with a numeric project segment, so a verified project-number
   * alias could make it trusted. Anything else is rejected without a lookup.
   */
  #looksLikeNumericProjectAlias(name: unknown, corpus: string): boolean {
    if (typeof name !== "string") return false;
    const [, , , location, , corpusId] = corpus.split("/");
    return /^projects\/[1-9][0-9]*\//.test(name)
      && name.startsWith(`projects/${name.split("/")[1]}/locations/${location}/ragCorpora/${corpusId}/`);
  }

  /** The same corpus under every verified project alias (ID and number). */
  async #corpusAliases(corpus: string): Promise<string[]> {
    const segments = corpus.split("/");
    const aliases = await this.#createProjectAliases();
    return aliases.map((project) => [segments[0], project, ...segments.slice(2)].join("/"));
  }

  async #ownedCorpusResourceName(value: string): Promise<string> {
    const corpus = requireCorpusResourceName(value, this.#location);
    const project = corpus.split("/")[1]!;
    if (project === this.#project) return corpus;
    // Vertex returns project numbers even when callers configure a project ID.
    // Verify that alias; syntax and location alone do not establish custody.
    if (!/^[0-9]+$/.test(project) || !(await this.#createProjectAliases()).includes(project)) {
      throw new GoogleApiError("Vertex corpus resource scope validation", 0);
    }
    return corpus;
  }

  async #waitForOperation(
    initial: Record<string, unknown>, operationName: string, parents: readonly string[],
  ): Promise<Record<string, unknown>> {
    const name = validatedVertexOperationName(initial.name, parents);
    if (name === undefined) {
      throw new GoogleApiError(`${operationName} operation scope validation`, 0);
    }
    let operation = initial;
    for (let poll = 0; poll <= this.#maxPolls; poll += 1) {
      // Pin the original reference even if a later response tries to redirect
      // the poll into another corpus/project or a URL query/path suffix.
      if (operation.name !== name) {
        throw new VertexOperationError(`${operationName} operation scope validation`, 0, name);
      }
      if (operation.done === true) {
        if (operation.error !== undefined) throw new VertexOperationError(operationName, 409, name);
        return operation;
      }
      if (poll === this.#maxPolls) throw new VertexOperationError(`${operationName} timeout`, 408, name);
      if (this.#pollIntervalMs > 0) await Bun.sleep(this.#pollIntervalMs);
      try {
        operation = await this.#json(new URL(`${this.#base()}/v1/${name}`), { method: "GET" }, `${operationName} poll`);
      } catch (error) {
        throw new VertexOperationError(`${operationName} poll`, error instanceof GoogleApiError ? error.status : 0, name);
      }
    }
    throw new VertexOperationError(`${operationName} timeout`, 408, name);
  }

  async #json(url: URL, init: RequestInit, operation: string): Promise<Record<string, unknown>> {
    // Explicit quota rejections can be retried. A write's 503 response may
    // follow acceptance, so retry server failures only for read requests.
    let response: Response;
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.#tokenProvider.getAccessToken();
      response = await this.#fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
      if ((response.status !== 429 && !(init.method === "GET" && response.status === 503)) || attempt >= this.#quotaRetries) break;
      if (this.#quotaRetryDelayMs > 0) await Bun.sleep(this.#quotaRetryDelayMs);
    }
    return responseRecord(response, operation);
  }

  #base(): string {
    return `https://${this.#location}-aiplatform.googleapis.com`;
  }
}

function assertVertexPagination(
  nextPageToken: string | undefined,
  pageCount: number,
  seenPageTokens: Set<string>,
  operation: string,
): void {
  if (nextPageToken === undefined) return;
  if (seenPageTokens.has(nextPageToken)) throw new VertexPaginationError(operation, "repeated nextPageToken");
  if (pageCount >= VERTEX_MAX_PAGES) throw new VertexPaginationError(operation, "page cap reached");
  seenPageTokens.add(nextPageToken);
}

async function responseRecord(response: Response, operation: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new GoogleApiError(operation, response.status);
  try {
    const value = await response.json();
    return isRecord(value) ? value : {};
  } catch {
    throw new GoogleApiError(`${operation} response`, response.status);
  }
}

function requirePathSegment(value: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) throw new GoogleApiError(`${name} validation`, 0);
  return value;
}

function requireNonEmptyString(value: string, name: string): string {
  if (value.length === 0 || value.trim() !== value) throw new GoogleApiError(`${name} validation`, 0);
  return value;
}

function isScopedResource(value: string, prefix: string): boolean {
  return value.startsWith(prefix) && /^[A-Za-z0-9_-]+$/.test(value.slice(prefix.length));
}

function requireCorpusResourceName(value: string, location: string): string {
  const match = /^projects\/([a-z0-9-]+)\/locations\/([a-z0-9-]+)\/ragCorpora\/[A-Za-z0-9_-]+$/.exec(value);
  if (match === null || match[2] !== location || match[1]?.length === 0) {
    throw new GoogleApiError("Vertex corpus resource validation", 0);
  }
  return value;
}

function requireGcsUri(value: string): string {
  if (!/^gs:\/\/[^/]+\/.+/.test(value)) throw new GoogleApiError("GCS URI validation", 0);
  return value;
}

function isQuotaRejection(rejection: string): boolean {
  return rejection.includes("RESOURCE_EXHAUSTED")
    || rejection.includes("Resource has been exhausted")
    || /\b429\b/.test(rejection);
}

function isKnownQuotaRejection(operation: Record<string, unknown>): boolean {
  const response = isRecord(operation.response) ? operation.response : {};
  const generic = isRecord(operation.metadata) && isRecord(operation.metadata.genericMetadata)
    ? operation.metadata.genericMetadata : {};
  const failures = generic.partialFailures;
  return Number(response.failedRagFilesCount) === 1
    && Number(response.importedRagFilesCount ?? 0) === 0
    && Number(response.skippedRagFilesCount ?? 0) === 0
    && Array.isArray(failures) && failures.length > 0
    && failures.every((failure) => isRecord(failure) && failure.code === 8);
}

function importRejectionMessage(operation: Record<string, unknown>): string | undefined {
  const response = isRecord(operation.response) ? operation.response : {};
  const failed = Number(response.failedRagFilesCount ?? 0);
  const skipped = Number(response.skippedRagFilesCount ?? 0);
  if (failed <= 0 && skipped <= 0) return undefined;
  const partialFailure = nestedString(operation, ["metadata", "genericMetadata", "partialFailures", "0", "message"]);
  // Classify known quota failures without retaining arbitrary provider text.
  return partialFailure !== undefined && isQuotaRejection(partialFailure)
    ? "RESOURCE_EXHAUSTED" : `failed ${failed}, skipped ${skipped}`;
}

function nestedString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const segment of path) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return typeof current === "string" ? current : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
