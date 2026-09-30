import {
  GcsCasConflictError,
  type ExpectedGcsGeneration,
  type GcsAdapter,
  type GcsGeneration,
  type GcsReadResult,
  type VertexAdapter,
  type VertexFile,
} from "./adapters.ts";

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

export interface FakeVertexCorpusSeed {
  displayName: string;
  resourceName: string;
  files?: VertexFile[];
}

export interface FakeVertexImport {
  corpusResourceName: string;
  gcsUri: string;
  ragFileId: string;
}

export class InMemoryVertexAdapter implements VertexAdapter {
  readonly ensureCorpusCalls: string[] = [];
  readonly importCalls: FakeVertexImport[] = [];
  readonly listFilesCalls: string[] = [];

  #corporaByDisplayName = new Map<string, string>();
  #filesByCorpus = new Map<string, VertexFile[]>();
  #nextCorpus = 1;
  #nextFile = 1;

  constructor(seeds: FakeVertexCorpusSeed[] = []) {
    for (const seed of seeds) {
      this.#corporaByDisplayName.set(seed.displayName, seed.resourceName);
      this.#filesByCorpus.set(seed.resourceName, cloneAndSortFiles(seed.files ?? []));
    }
  }

  async ensureCorpus(displayName: string): Promise<string> {
    this.ensureCorpusCalls.push(displayName);
    const existing = this.#corporaByDisplayName.get(displayName);
    if (existing !== undefined) return existing;

    const resourceName = `fake/corpora/${this.#nextCorpus}`;
    this.#nextCorpus += 1;
    this.#corporaByDisplayName.set(displayName, resourceName);
    this.#filesByCorpus.set(resourceName, []);
    return resourceName;
  }

  /** URIs the fake rejects with an import-rejected error, for tolerance tests. */
  readonly rejectUris = new Set<string>();
  /** URIs the fake fails with a poll-timeout error, for tolerance tests. */
  readonly timeoutUris = new Set<string>();

  async importFile(corpusResourceName: string, gcsUri: string): Promise<string> {
    const files = this.#filesByCorpus.get(corpusResourceName);
    if (files === undefined) {
      throw new Error(`unknown fake corpus ${corpusResourceName}`);
    }
    if (this.rejectUris.has(gcsUri)) {
      throw new Error(`Vertex RAG file import rejected: fake rejection for ${gcsUri}`);
    }
    if (this.timeoutUris.has(gcsUri)) {
      throw new Error("Vertex RAG file import timeout failed with HTTP 408");
    }
    const ragFileId = `fake-rag-file-${this.#nextFile}`;
    this.#nextFile += 1;
    files.push({ ragFileId, gcsUri });
    files.sort((left, right) => compareStrings(left.ragFileId, right.ragFileId));
    this.importCalls.push({ corpusResourceName, gcsUri, ragFileId });
    return ragFileId;
  }

  async listFiles(corpusResourceName: string): Promise<VertexFile[]> {
    this.listFilesCalls.push(corpusResourceName);
    const files = this.#filesByCorpus.get(corpusResourceName);
    if (files === undefined) {
      throw new Error(`unknown fake corpus ${corpusResourceName}`);
    }
    return cloneAndSortFiles(files);
  }
}

function cloneAndSortFiles(files: VertexFile[]): VertexFile[] {
  return files
    .map((file) => ({ ...file }))
    .sort((left, right) => compareStrings(left.ragFileId, right.ragFileId));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
