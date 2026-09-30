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

export interface VertexFile {
  ragFileId: string;
  gcsUri: string;
}

export interface VertexAdapter {
  ensureCorpus(displayName: string): Promise<string>;
  importFile(corpusResourceName: string, gcsUri: string): Promise<string>;
  listFiles(corpusResourceName: string): Promise<VertexFile[]>;
}

export class GcsCasConflictError extends Error {
  readonly code = "gcs_cas_conflict" as const;

  constructor(public readonly path: string) {
    super(`GCS generation precondition failed for ${path}`);
    this.name = "GcsCasConflictError";
  }
}
