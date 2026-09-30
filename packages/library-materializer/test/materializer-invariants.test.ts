import { describe, expect, test } from "bun:test";
import {
  LIBRARY_SCHEMA_VERSION,
  canonicalObjectRelativePath,
  contentIdFromBytes,
  finalizeMasterManifest,
  parseMasterManifest,
  serializeMasterManifest,
  validateLibraryObject,
  type Sha256Id,
} from "@expert-agents/library";
import {
  GcsCasConflictError,
  InMemoryGcsAdapter,
  InMemoryVertexAdapter,
  MaterializerCasConflictError,
  assertMaterializationReceiptContainsNoSecrets,
  materializeScope,
  parseMaterializerLedger,
  serializeMaterializationReceipt,
  serializeMaterializerLedger,
  type ExpectedGcsGeneration,
  type GcsAdapter,
  type GcsGeneration,
  type GcsReadResult,
} from "../src/index.ts";
import { candidate, candidateMetadata, scopeText } from "./materializer-fixtures.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const config = { bucket: "neutral-library-bucket", prefix: "shared/library" };

describe("append-only materializer invariants", () => {
  test("deduplicates identical candidate bytes into one object and manifest record", async () => {
    const bytes = encoder.encode("same canonical bytes");
    const objectId = contentIdFromBytes(bytes);
    const gcs = new InMemoryGcsAdapter();
    const vertex = new InMemoryVertexAdapter();

    const receipt = await materializeScope({
      config,
      scopeManifestPath: "/virtual/neutral-scope.json",
      readScopeManifest: async () => scopeText([objectId]),
      candidates: [candidate("zeta.txt", bytes), candidate("alpha.txt", bytes)],
      gcs,
      vertex,
      execute: true,
    });

    const manifest = await readStoredManifest(gcs);
    expect(manifest.objects).toHaveLength(1);
    expect(manifest.objects[0]!.id).toBe(objectId);
    expect(gcs.writes.filter((write) => write.path === canonicalObjectRelativePath(objectId, "text/plain"))).toHaveLength(1);
    expect(receipt.candidates.dedupedObjectIds).toEqual([objectId]);
    expect(vertex.importCalls).toHaveLength(1);
  });

  test("returns a no-op receipt on an idempotent rerun", async () => {
    const bytes = encoder.encode("idempotent canonical bytes");
    const objectId = contentIdFromBytes(bytes);
    const gcs = new InMemoryGcsAdapter();
    const vertex = new InMemoryVertexAdapter();
    const options = {
      config,
      scopeManifestPath: "/virtual/neutral-scope.json",
      readScopeManifest: async () => scopeText([objectId]),
      candidates: [candidate("idempotent.txt", bytes)],
      gcs,
      vertex,
      execute: true,
    } as const;

    await materializeScope(options);
    const writesAfterFirstRun = gcs.writes.length;
    const secondReceipt = await materializeScope(options);

    expect(secondReceipt.noOp).toBeTrue();
    expect(secondReceipt.candidates.addedObjectIds).toEqual([]);
    expect(secondReceipt.candidates.dedupedObjectIds).toEqual([objectId]);
    expect(secondReceipt.materialization.alreadyMaterializedObjectIds).toEqual([objectId]);
    expect(gcs.writes).toHaveLength(writesAfterFirstRun);
    expect(vertex.importCalls).toHaveLength(1);
  });

  test("rematerializes into a retargeted corpus and converges on the rewritten ledger key", async () => {
    const bytes = encoder.encode("retargeted canonical bytes");
    const objectId = contentIdFromBytes(bytes);
    const gcs = new InMemoryGcsAdapter();
    const vertex = new InMemoryVertexAdapter();
    const run = (targetCorpusDisplayName: string) => materializeScope({
      config,
      scopeManifestPath: "/virtual/neutral-scope.json",
      readScopeManifest: async () => scopeText([objectId], 0, targetCorpusDisplayName),
      candidates: [candidate("retargeted.txt", bytes)],
      gcs,
      vertex,
      execute: true,
    });

    await run("neutral-library-old");
    const retargeted = await run("neutral-library-new");
    expect(retargeted.materialization.importedObjectIds).toEqual([objectId]);
    expect(vertex.ensureCorpusCalls).toEqual(["neutral-library-old", "neutral-library-new"]);
    expect(vertex.importCalls).toHaveLength(2);

    const ledgerRead = await gcs.read("ledgers/neutral-agent.json");
    expect(parseMaterializerLedger(decoder.decode(ledgerRead!.bytes)).entries).toEqual([{
      objectId,
      ragFileId: "fake-rag-file-2",
      targetCorpusDisplayName: "neutral-library-new",
      corpusResourceName: "fake/corpora/2",
      importedAtRevision: 1,
    }]);

    const converged = await run("neutral-library-new");
    expect(converged.noOp).toBeTrue();
    expect(converged.materialization.alreadyMaterializedObjectIds).toEqual([objectId]);
    expect(vertex.importCalls).toHaveLength(2);
  });

  test("migrates a legacy ledger entry by recovering the existing target-corpus file", async () => {
    const bytes = encoder.encode("legacy ledger canonical bytes");
    const objectId = contentIdFromBytes(bytes);
    const object = objectFromBytes("legacy.txt", bytes);
    const manifest = finalizeMasterManifest({
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      revision: 1,
      ingestionCursor: null,
      objects: [object],
      tombstones: [],
    });
    const legacyLedger = serializeMaterializerLedger({
      schemaVersion: 1,
      revision: 1,
      entries: [{
        objectId,
        ragFileId: "legacy-rag-file",
        corpusResourceName: "fake/corpora/current",
        importedAtRevision: 1,
      }],
    });
    const gcsUri = `gs://${config.bucket}/${config.prefix}/${object.relativePath}`;
    const gcs = new InMemoryGcsAdapter([
      { path: "manifest/master.json", bytes: encoder.encode(serializeMasterManifest(manifest)), generation: "10" },
      { path: "ledgers/neutral-agent.json", bytes: encoder.encode(legacyLedger), generation: "11" },
    ]);
    const vertex = new InMemoryVertexAdapter([{
      displayName: "neutral-agent-library",
      resourceName: "fake/corpora/current",
      files: [{ ragFileId: "current-rag-file", gcsUri }],
    }]);
    const options = {
      config,
      scopeManifestPath: "/virtual/neutral-scope.json",
      readScopeManifest: async () => scopeText([objectId], 1),
      candidates: [],
      gcs,
      vertex,
      execute: true,
    } as const;

    const migrated = await materializeScope(options);
    expect(migrated.materialization.importedObjectIds).toEqual([]);
    expect(migrated.materialization.recoveredObjectIds).toEqual([objectId]);
    expect(vertex.importCalls).toEqual([]);
    const ledgerRead = await gcs.read("ledgers/neutral-agent.json");
    expect(parseMaterializerLedger(decoder.decode(ledgerRead!.bytes)).entries[0]).toMatchObject({
      objectId,
      ragFileId: "current-rag-file",
      targetCorpusDisplayName: "neutral-agent-library",
    });

    const converged = await materializeScope(options);
    expect(converged.noOp).toBeTrue();
    expect(converged.materialization.alreadyMaterializedObjectIds).toEqual([objectId]);
  });

  test("surfaces a typed manifest CAS conflict after one re-read attempt", async () => {
    const bytes = encoder.encode("manifest conflict bytes");
    const gcs = new InMemoryGcsAdapter();
    const conflicting = new ManifestConflictAdapter(gcs, 2);

    await expect(materializeScope({
      config,
      scopeManifestPath: "/virtual/neutral-scope.json",
      readScopeManifest: async () => scopeText([contentIdFromBytes(bytes)]),
      candidates: [candidate("conflict.txt", bytes)],
      gcs: conflicting,
      vertex: new InMemoryVertexAdapter(),
      execute: true,
    })).rejects.toMatchObject({
      name: "MaterializerCasConflictError",
      code: "materializer_cas_conflict",
      target: "manifest",
      attempts: 2,
    } satisfies Partial<MaterializerCasConflictError>);
    expect(conflicting.manifestWriteAttempts).toBe(2);
  });

  test("never sends planned retractions to Vertex or GCS writes", async () => {
    const bytes = encoder.encode("retained ledger bytes");
    const objectId = contentIdFromBytes(bytes);
    const object = objectFromBytes("retained.txt", bytes);
    const manifest = finalizeMasterManifest({
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      revision: 1,
      ingestionCursor: null,
      objects: [object],
      tombstones: [],
    });
    const ledger = serializeMaterializerLedger({
      schemaVersion: 1,
      revision: 1,
      entries: [{
        objectId,
        ragFileId: "fake-rag-file-retained",
        corpusResourceName: "fake/corpora/retained",
        importedAtRevision: 1,
      }],
    });
    const gcs = new InMemoryGcsAdapter([
      { path: "manifest/master.json", bytes: encoder.encode(serializeMasterManifest(manifest)), generation: "10" },
      { path: "ledgers/neutral-agent.json", bytes: encoder.encode(ledger), generation: "11" },
    ]);
    const vertex = new InMemoryVertexAdapter();

    const receipt = await materializeScope({
      config,
      scopeManifestPath: "/virtual/neutral-scope.json",
      readScopeManifest: async () => scopeText([], 1),
      candidates: [],
      gcs,
      vertex,
      execute: true,
    });

    expect(receipt.materialization.retractions).toEqual([{ objectId, dry_run_only: true }]);
    expect(gcs.writes).toEqual([]);
    expect(vertex.ensureCorpusCalls).toEqual([]);
    expect(vertex.listFilesCalls).toEqual([]);
    expect(vertex.importCalls).toEqual([]);
  });

  test("converges after an object upload succeeds and manifest CAS append fails", async () => {
    const bytes = encoder.encode("partial failure canonical bytes");
    const objectId = contentIdFromBytes(bytes);
    const objectPath = canonicalObjectRelativePath(objectId, "text/plain");
    const gcs = new InMemoryGcsAdapter();
    const conflicting = new ManifestConflictAdapter(gcs, 2);
    const common = {
      config,
      scopeManifestPath: "/virtual/neutral-scope.json",
      readScopeManifest: async () => scopeText([objectId]),
      candidates: [candidate("partial.txt", bytes)],
      vertex: new InMemoryVertexAdapter(),
      execute: true,
    } as const;

    await expect(materializeScope({ ...common, gcs: conflicting }))
      .rejects.toBeInstanceOf(MaterializerCasConflictError);
    expect(await gcs.exists(objectPath)).toBeTrue();
    expect(gcs.writes.filter((write) => write.path === objectPath)).toHaveLength(1);

    const receipt = await materializeScope({ ...common, gcs });
    expect(receipt.candidates.existingObjectBytesIds).toEqual([objectId]);
    expect(receipt.candidates.uploadedObjectIds).toEqual([]);
    expect((await readStoredManifest(gcs)).objects.map((object) => object.id)).toEqual([objectId]);
    const ledgerRead = await gcs.read("ledgers/neutral-agent.json");
    expect(parseMaterializerLedger(decoder.decode(ledgerRead!.bytes)).entries.map((entry) => entry.objectId))
      .toEqual([objectId]);
    expect(gcs.writes.filter((write) => write.path === objectPath)).toHaveLength(1);
  });

  test("performs zero adapter writes in plan-only mode", async () => {
    const bytes = encoder.encode("plan-only canonical bytes");
    const objectId = contentIdFromBytes(bytes);
    const gcs = new InMemoryGcsAdapter();
    const vertex = new InMemoryVertexAdapter();

    const receipt = await materializeScope({
      config,
      scopeManifestPath: "/virtual/neutral-scope.json",
      readScopeManifest: async () => scopeText([objectId]),
      candidates: [candidate("plan-only.txt", bytes)],
      gcs,
      vertex,
      execute: false,
    });

    expect(receipt.mode).toBe("plan_only");
    expect(receipt.candidates.plannedUploadObjectIds).toEqual([objectId]);
    expect(receipt.materialization.plannedImportObjectIds).toEqual([objectId]);
    expect(gcs.writes).toEqual([]);
    expect(vertex.ensureCorpusCalls).toEqual([]);
    expect(vertex.listFilesCalls).toEqual([]);
    expect(vertex.importCalls).toEqual([]);
  });

  test("serializes byte-identical receipts for identical inputs and state", async () => {
    const bytes = encoder.encode("deterministic receipt bytes");
    const objectId = contentIdFromBytes(bytes);
    const run = async (): Promise<string> => serializeMaterializationReceipt(await materializeScope({
      config,
      scopeManifestPath: "/virtual/neutral-scope.json",
      readScopeManifest: async () => scopeText([objectId]),
      candidates: [candidate("deterministic.txt", bytes)],
      gcs: new InMemoryGcsAdapter(),
      vertex: new InMemoryVertexAdapter(),
      execute: true,
    }));

    expect(await run()).toBe(await run());
  });

  test("fails closed when receipt bytes contain credential material", async () => {
    const sentinel = "credential-sentinel-must-not-appear";
    const bytes = encoder.encode(sentinel);
    const objectId = contentIdFromBytes(bytes);
    const candidateWithSensitiveInputs = candidate(`${sentinel}.txt`, bytes);
    candidateWithSensitiveInputs.metadata.sourceLocators = [`candidate://${sentinel}`];
    const receipt = await materializeScope({
      config,
      scopeManifestPath: "/virtual/neutral-scope.json",
      readScopeManifest: async () => scopeText([objectId]),
      candidates: [candidateWithSensitiveInputs],
      gcs: new InMemoryGcsAdapter(),
      vertex: new InMemoryVertexAdapter(),
      execute: false,
    });
    const receiptBytes = encoder.encode(serializeMaterializationReceipt(receipt));

    expect(decoder.decode(receiptBytes)).not.toContain(sentinel);
    expect(() => assertMaterializationReceiptContainsNoSecrets(receiptBytes, [sentinel])).not.toThrow();
    expect(() => assertMaterializationReceiptContainsNoSecrets(encoder.encode(`{"leak":"${sentinel}"}`), [sentinel]))
      .toThrow("Refusing to write materialization receipt because it contains credential material.");
  });

  test("records per-file import rejections and continues, then heals on rerun", async () => {
    const goodBytes = encoder.encode("importable text");
    const badBytes = encoder.encode("rejected by the backend");
    const goodId = contentIdFromBytes(goodBytes);
    const badId = contentIdFromBytes(badBytes);
    const badUri = `gs://${config.bucket}/${config.prefix}/${canonicalObjectRelativePath(badId, "text/plain")}`;
    const gcs = new InMemoryGcsAdapter();
    const vertex = new InMemoryVertexAdapter();
    vertex.rejectUris.add(badUri);
    const run = () => materializeScope({
      config,
      scopeManifestPath: "/virtual/neutral-scope.json",
      readScopeManifest: async () => scopeText([badId, goodId].sort()),
      candidates: [candidate("good.txt", goodBytes), candidate("bad.txt", badBytes)],
      gcs,
      vertex,
      execute: true,
    });

    const first = await run();
    expect(first.materialization.importedObjectIds).toEqual([goodId]);
    expect(first.materialization.rejectedImports).toEqual([
      { objectId: badId, reason: `Vertex RAG file import rejected: fake rejection for ${badUri}` },
    ]);
    expect(first.summary.rejectedImports).toBe(1);
    expect(first.noOp).toBeFalse();

    vertex.rejectUris.clear();
    const second = await run();
    expect(second.materialization.importedObjectIds).toEqual([badId]);
    expect(second.materialization.rejectedImports).toEqual([]);

    const third = await run();
    expect(third.noOp).toBeTrue();
  });

  test("tolerates import poll timeouts per file and recovers via listing on rerun", async () => {
    const bytes = encoder.encode("slow import bytes");
    const objectId = contentIdFromBytes(bytes);
    const uri = `gs://${config.bucket}/${config.prefix}/${canonicalObjectRelativePath(objectId, "text/plain")}`;
    const gcs = new InMemoryGcsAdapter();
    const vertex = new InMemoryVertexAdapter();
    vertex.timeoutUris.add(uri);
    const run = () => materializeScope({
      config,
      scopeManifestPath: "/virtual/neutral-scope.json",
      readScopeManifest: async () => scopeText([objectId]),
      candidates: [candidate("slow.txt", bytes)],
      gcs,
      vertex,
      execute: true,
    });

    const first = await run();
    expect(first.materialization.rejectedImports).toEqual([
      { objectId, reason: "Vertex RAG file import timeout failed with HTTP 408" },
    ]);
    expect(first.materialization.importedObjectIds).toEqual([]);

    vertex.timeoutUris.clear();
    const second = await run();
    expect(second.materialization.importedObjectIds).toEqual([objectId]);

    const third = await run();
    expect(third.noOp).toBeTrue();
  });
});

class ManifestConflictAdapter implements GcsAdapter {
  manifestWriteAttempts = 0;

  constructor(
    private readonly delegate: InMemoryGcsAdapter,
    private remainingConflicts: number,
  ) {}

  read(path: string): Promise<GcsReadResult | null> {
    return this.delegate.read(path);
  }

  async writeIfGeneration(
    path: string,
    bytes: Uint8Array,
    expectedGeneration: ExpectedGcsGeneration,
  ): Promise<GcsGeneration> {
    if (path === "manifest/master.json") {
      this.manifestWriteAttempts += 1;
      if (this.remainingConflicts > 0) {
        this.remainingConflicts -= 1;
        throw new GcsCasConflictError(path);
      }
    }
    return this.delegate.writeIfGeneration(path, bytes, expectedGeneration);
  }

  exists(path: string): Promise<boolean> {
    return this.delegate.exists(path);
  }
}

function objectFromBytes(path: string, bytes: Uint8Array) {
  const id = contentIdFromBytes(bytes);
  return validateLibraryObject({
    ...candidateMetadata(path),
    id,
    byteSize: bytes.byteLength,
    relativePath: canonicalObjectRelativePath(id, "text/plain"),
  });
}

async function readStoredManifest(gcs: GcsAdapter) {
  const stored = await gcs.read("manifest/master.json");
  if (stored === null) throw new Error("expected stored manifest fixture");
  return parseMasterManifest(decoder.decode(stored.bytes));
}
