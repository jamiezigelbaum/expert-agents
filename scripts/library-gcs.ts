import { validateLibraryLocationConfig } from "../packages/library/src/index.ts";
import type { AccessTokenProvider, FetchLike } from "./google-auth.ts";

// Generation-checked reads and writes of library objects in Google Cloud
// Storage, for operator commands that edit the master manifest
// (library:annotate). The in-memory adapter is the test double.

export type GcsGeneration = string;
export type ExpectedGcsGeneration = GcsGeneration | 0;

export interface GcsReadResult {
  bytes: Uint8Array;
  generation: GcsGeneration;
}

export interface GcsAdapter {
  read(path: string): Promise<GcsReadResult | null>;
  writeIfGeneration(
    path: string,
    bytes: Uint8Array,
    expectedGeneration: ExpectedGcsGeneration,
  ): Promise<GcsGeneration>;
  exists(path: string): Promise<boolean>;
}

export class GcsCasConflictError extends Error {
  readonly code = "gcs_cas_conflict" as const;

  constructor(public readonly path: string) {
    super(`GCS generation precondition failed for ${path}`);
    this.name = "GcsCasConflictError";
  }
}

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

interface FakeGcsObject {
  bytes: Uint8Array;
  generation: GcsGeneration;
}

export interface FakeGcsSeed {
  path: string;
  bytes: Uint8Array;
  generation?: GcsGeneration;
}

export interface FakeGcsWrite {
  path: string;
  bytes: Uint8Array;
  expectedGeneration: ExpectedGcsGeneration;
  generation: GcsGeneration;
}

export class InMemoryGcsAdapter implements GcsAdapter {
  readonly reads: string[] = [];
  readonly existenceChecks: string[] = [];
  readonly writes: FakeGcsWrite[] = [];

  #objects = new Map<string, FakeGcsObject>();
  #nextGeneration = 1;

  constructor(seeds: FakeGcsSeed[] = []) {
    for (const seed of seeds) {
      const generation = seed.generation ?? String(this.#nextGeneration);
      this.#objects.set(seed.path, { bytes: seed.bytes.slice(), generation });
      this.#nextGeneration = Math.max(this.#nextGeneration, Number(generation) + 1);
    }
  }

  async read(path: string): Promise<GcsReadResult | null> {
    this.reads.push(path);
    const object = this.#objects.get(path);
    return object === undefined
      ? null
      : { bytes: object.bytes.slice(), generation: object.generation };
  }

  async writeIfGeneration(
    path: string,
    bytes: Uint8Array,
    expectedGeneration: ExpectedGcsGeneration,
  ): Promise<GcsGeneration> {
    const current = this.#objects.get(path);
    const matches = expectedGeneration === 0
      ? current === undefined
      : current?.generation === expectedGeneration;
    if (!matches) {
      throw new GcsCasConflictError(path);
    }

    const generation = String(this.#nextGeneration);
    this.#nextGeneration += 1;
    const storedBytes = bytes.slice();
    this.#objects.set(path, { bytes: storedBytes, generation });
    this.writes.push({
      path,
      bytes: storedBytes.slice(),
      expectedGeneration,
      generation,
    });
    return generation;
  }

  async exists(path: string): Promise<boolean> {
    this.existenceChecks.push(path);
    return this.#objects.has(path);
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
