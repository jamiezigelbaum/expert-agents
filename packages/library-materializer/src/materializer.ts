import { readFile } from "node:fs/promises";
import {
  LIBRARY_SCHEMA_VERSION,
  applyManifestUpdate,
  canonicalObjectRelativePath,
  contentIdFromBytes,
  finalizeMasterManifest,
  parseMasterManifest,
  parseScopeManifest,
  planReconciliation,
  serializeMasterManifest,
  validateLibraryLocationConfig,
  validateLibraryObject,
  type LibraryObject,
  type MasterManifest,
  type ReconciliationPlan,
  type Sha256Id,
} from "@expert-agents/library";
import { GcsCasConflictError, type GcsAdapter, type GcsGeneration, type VertexAdapter } from "./adapters.ts";
import {
  emptyMaterializerLedger,
  parseMaterializerLedger,
  plannerLedger,
  serializeMaterializerLedger,
  type MaterializerLedger,
  type MaterializerLedgerEntry,
} from "./ledger.ts";
import {
  finalizeMaterializationReceipt,
  type MaterializationReceipt,
} from "./receipt.ts";

const MASTER_MANIFEST_PATH = "manifest/master.json";

export type CandidateObjectMetadata = Omit<LibraryObject, "id" | "byteSize" | "relativePath">;

export interface MaterializerCandidate {
  path: string;
  bytes: () => Promise<Uint8Array>;
  metadata: CandidateObjectMetadata;
}

export interface MaterializeScopeOptions {
  config: { bucket: string; prefix: string };
  scopeManifestPath: string;
  candidates: readonly MaterializerCandidate[];
  gcs: GcsAdapter;
  vertex: VertexAdapter;
  execute: boolean;
  readScopeManifest?: (path: string) => Promise<string>;
}

export class MaterializerCasConflictError extends Error {
  readonly code = "materializer_cas_conflict" as const;

  constructor(
    public readonly target: "manifest" | "ledger",
    public readonly attempts: number,
  ) {
    super(`${target} compare-and-set failed after ${attempts} attempts`);
    this.name = "MaterializerCasConflictError";
  }
}

interface PreparedCandidate {
  path: string;
  bytes: Uint8Array;
  object: LibraryObject;
}

interface ManifestState {
  manifest: MasterManifest;
  generation: GcsGeneration | 0;
  absent: boolean;
}

interface LedgerState {
  ledger: MaterializerLedger;
  generation: GcsGeneration | 0;
}

interface ConflictCounts {
  manifest: number;
  ledger: number;
  object: number;
}

export async function materializeScope(options: MaterializeScopeOptions): Promise<MaterializationReceipt> {
  const config = validateLibraryLocationConfig(options.config);
  const scopeText = options.readScopeManifest === undefined
    ? await readFile(options.scopeManifestPath, "utf8")
    : await options.readScopeManifest(options.scopeManifestPath);
  const scope = parseScopeManifest(scopeText);
  const prepared = await prepareCandidates(options.candidates);
  const candidateIds = sortedUnique(prepared.map((candidate) => candidate.object.id));
  const duplicateCandidateIds = duplicateIds(prepared.map((candidate) => candidate.object.id));
  const candidateById = new Map<Sha256Id, PreparedCandidate>();
  for (const candidate of prepared) {
    if (!candidateById.has(candidate.object.id)) candidateById.set(candidate.object.id, candidate);
  }

  const conflicts: ConflictCounts = { manifest: 0, ledger: 0, object: 0 };
  const initialManifest = await readManifest(options.gcs);
  const masterRevisionBefore = initialManifest.manifest.revision;
  const initiallyLive = new Set(initialManifest.manifest.objects.map((object) => object.id));
  const initiallyDeduped = candidateIds.filter((id) => initiallyLive.has(id));
  let manifest: MasterManifest;
  let addedObjectIds: Sha256Id[];
  const plannedUploadObjectIds: Sha256Id[] = [];
  const uploadedObjectIds: Sha256Id[] = [];
  const existingObjectBytesIds: Sha256Id[] = [];

  if (!options.execute) {
    addedObjectIds = candidateIds.filter((id) => !initiallyLive.has(id));
    for (const id of addedObjectIds) {
      const relativePath = candidateById.get(id)!.object.relativePath;
      if (await options.gcs.exists(relativePath)) existingObjectBytesIds.push(id);
      else plannedUploadObjectIds.push(id);
    }
    manifest = addedObjectIds.length === 0
      ? initialManifest.manifest
      : applyManifestUpdate(initialManifest.manifest, {
        expectedRevision: initialManifest.manifest.revision,
        addObjects: addedObjectIds.map((id) => candidateById.get(id)!.object),
      });
  } else {
    for (const id of candidateIds.filter((candidateId) => !initiallyLive.has(candidateId))) {
      const candidate = candidateById.get(id)!;
      if (await options.gcs.exists(candidate.object.relativePath)) {
        existingObjectBytesIds.push(id);
        continue;
      }
      plannedUploadObjectIds.push(id);
      try {
        await options.gcs.writeIfGeneration(candidate.object.relativePath, candidate.bytes, 0);
        uploadedObjectIds.push(id);
      } catch (error) {
        if (!(error instanceof GcsCasConflictError) || !(await options.gcs.exists(candidate.object.relativePath))) {
          throw error;
        }
        conflicts.object += 1;
        existingObjectBytesIds.push(id);
      }
    }

    const appended = await appendManifestWithSingleRetry(
      options.gcs,
      initialManifest,
      candidateIds.map((id) => candidateById.get(id)!.object),
      conflicts,
    );
    manifest = appended.manifest;
    addedObjectIds = appended.addedObjectIds;
  }

  const ledgerPath = `ledgers/${scope.agentId}.json`;
  const initialLedger = await readLedger(options.gcs, ledgerPath);
  const ledgerRevisionBefore = initialLedger.ledger.revision;
  let ledgerState = initialLedger;
  const plan = planReconciliation(manifest, scope, plannerLedger(ledgerState.ledger));
  let corpusResourceName: string | null = uniqueCorpusResourceName(ledgerState.ledger);
  const importedObjectIds: Sha256Id[] = [];
  const recoveredObjectIds: Sha256Id[] = [];
  const rejectedImports: Array<{ objectId: Sha256Id; reason: string }> = [];

  if (options.execute && plan.imports.length > 0) {
    corpusResourceName = await options.vertex.ensureCorpus(scope.targetCorpusDisplayName);
    const vertexFiles = await options.vertex.listFiles(corpusResourceName);
    const vertexFileByUri = new Map(
      [...vertexFiles]
        .sort((left, right) => compareStrings(left.ragFileId, right.ragFileId))
        .map((file) => [file.gcsUri, file.ragFileId]),
    );

    for (const plannedImport of plan.imports) {
      const gcsUri = `gs://${config.bucket}/${config.prefix}/${plannedImport.relativePath}`;
      const recoveredRagFileId = vertexFileByUri.get(gcsUri);
      let ragFileId: string;
      if (recoveredRagFileId === undefined) {
        try {
          ragFileId = await options.vertex.importFile(corpusResourceName, gcsUri);
        } catch (error) {
          // A per-file rejection or poll timeout must not block the rest of
          // the corpus: record it and continue. Reruns retry rejected objects
          // (transient failures heal, permanent ones stay visible), and an
          // import that completed after its poll timed out is recovered from
          // the corpus listing on the next run.
          if (error instanceof Error
            && (error.message.includes("import rejected") || error.message.includes("import timeout"))) {
            rejectedImports.push({ objectId: plannedImport.objectId, reason: error.message });
            continue;
          }
          throw error;
        }
        importedObjectIds.push(plannedImport.objectId);
      } else {
        ragFileId = recoveredRagFileId;
        recoveredObjectIds.push(plannedImport.objectId);
      }

      const update = await appendLedgerEntryWithSingleRetry(
        options.gcs,
        ledgerPath,
        ledgerState,
        {
          objectId: plannedImport.objectId,
          ragFileId,
          targetCorpusDisplayName: scope.targetCorpusDisplayName,
          corpusResourceName,
          importedAtRevision: manifest.revision,
        },
        conflicts,
      );
      ledgerState = update;
    }
  }

  const dedupedObjectIds = sortedUnique([...duplicateCandidateIds, ...initiallyDeduped]);
  const plannedImportObjectIds = options.execute
    ? sortedUnique([...importedObjectIds, ...recoveredObjectIds])
    : plan.imports.map((entry) => entry.objectId);
  const alreadyMaterializedObjectIds = plan.alreadyMaterialized.map((entry) => entry.objectId);
  const retractions = plan.retractions.map(({ objectId }) => ({ objectId, dry_run_only: true as const }));
  const noOp = options.execute
    && addedObjectIds.length === 0
    && uploadedObjectIds.length === 0
    && importedObjectIds.length === 0
    && recoveredObjectIds.length === 0
    && ledgerState.ledger.revision === ledgerRevisionBefore;

  return finalizeMaterializationReceipt({
    schemaVersion: 1,
    mode: options.execute ? "execute" : "plan_only",
    agentId: scope.agentId,
    targetCorpusDisplayName: scope.targetCorpusDisplayName,
    corpusResourceName,
    masterRevision: { before: masterRevisionBefore, after: manifest.revision },
    ledgerRevision: { before: ledgerRevisionBefore, after: ledgerState.ledger.revision },
    candidates: {
      count: options.candidates.length,
      objectIds: candidateIds,
      addedObjectIds,
      dedupedObjectIds,
      plannedUploadObjectIds: [...plannedUploadObjectIds].sort(compareStrings),
      uploadedObjectIds: [...uploadedObjectIds].sort(compareStrings),
      existingObjectBytesIds: [...existingObjectBytesIds].sort(compareStrings),
    },
    materialization: {
      plannedImportObjectIds,
      importedObjectIds: [...importedObjectIds].sort(compareStrings),
      recoveredObjectIds: [...recoveredObjectIds].sort(compareStrings),
      rejectedImports: [...rejectedImports].sort((left, right) => compareStrings(left.objectId, right.objectId)),
      alreadyMaterializedObjectIds,
      retractions,
      unresolvableSelections: plan.unresolvableSelections,
    },
    casConflicts: conflicts,
    summary: {
      candidates: options.candidates.length,
      addedObjects: addedObjectIds.length,
      dedupedObjects: dedupedObjectIds.length,
      plannedUploads: plannedUploadObjectIds.length,
      uploadedObjects: uploadedObjectIds.length,
      plannedImports: plannedImportObjectIds.length,
      importedObjects: importedObjectIds.length,
      recoveredImports: recoveredObjectIds.length,
      rejectedImports: rejectedImports.length,
      alreadyMaterialized: alreadyMaterializedObjectIds.length,
      retractionsDryRunOnly: retractions.length,
      unresolvableSelections: plan.unresolvableSelections.length,
    },
    noOp,
  });
}

async function prepareCandidates(candidates: readonly MaterializerCandidate[]): Promise<PreparedCandidate[]> {
  const paths = new Set<string>();
  const sorted = [...candidates].sort((left, right) => compareStrings(left.path, right.path));
  const prepared: PreparedCandidate[] = [];
  for (const candidate of sorted) {
    if (candidate.path.length === 0 || candidate.path.trim() !== candidate.path || paths.has(candidate.path)) {
      throw new Error("materializer candidate paths must be non-empty and unique");
    }
    paths.add(candidate.path);
    const bytes = (await candidate.bytes()).slice();
    const id = contentIdFromBytes(bytes);
    const object = validateLibraryObject({
      ...candidate.metadata,
      id,
      byteSize: bytes.byteLength,
      relativePath: canonicalObjectRelativePath(id, candidate.metadata.mediaType),
    });
    prepared.push({ path: candidate.path, bytes, object });
  }
  return prepared;
}

async function readManifest(gcs: GcsAdapter): Promise<ManifestState> {
  const read = await gcs.read(MASTER_MANIFEST_PATH);
  if (read === null) {
    return {
      manifest: finalizeMasterManifest({
        schemaVersion: LIBRARY_SCHEMA_VERSION,
        revision: 0,
        ingestionCursor: null,
        objects: [],
        tombstones: [],
      }),
      generation: 0,
      absent: true,
    };
  }
  return {
    manifest: parseMasterManifest(decodeUtf8(read.bytes, "master manifest")),
    generation: read.generation,
    absent: false,
  };
}

async function appendManifestWithSingleRetry(
  gcs: GcsAdapter,
  initial: ManifestState,
  candidates: LibraryObject[],
  conflicts: ConflictCounts,
): Promise<{ manifest: MasterManifest; addedObjectIds: Sha256Id[] }> {
  let state = initial;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const live = new Set(state.manifest.objects.map((object) => object.id));
    const additions = candidates.filter((object) => !live.has(object.id));
    const next = additions.length === 0
      ? state.manifest
      : applyManifestUpdate(state.manifest, {
        expectedRevision: state.manifest.revision,
        addObjects: additions,
      });
    if (additions.length === 0 && !state.absent) {
      return { manifest: state.manifest, addedObjectIds: [] };
    }
    try {
      await gcs.writeIfGeneration(
        MASTER_MANIFEST_PATH,
        encodeUtf8(serializeMasterManifest(next)),
        state.generation,
      );
      return { manifest: next, addedObjectIds: additions.map((object) => object.id).sort(compareStrings) };
    } catch (error) {
      if (!(error instanceof GcsCasConflictError)) throw error;
      conflicts.manifest += 1;
      if (attempt === 2) throw new MaterializerCasConflictError("manifest", 2);
      state = await readManifest(gcs);
    }
  }
  throw new MaterializerCasConflictError("manifest", 2);
}

async function readLedger(gcs: GcsAdapter, path: string): Promise<LedgerState> {
  const read = await gcs.read(path);
  if (read === null) return { ledger: emptyMaterializerLedger(), generation: 0 };
  return {
    ledger: parseMaterializerLedger(decodeUtf8(read.bytes, "materialization ledger")),
    generation: read.generation,
  };
}

async function appendLedgerEntryWithSingleRetry(
  gcs: GcsAdapter,
  path: string,
  initial: LedgerState,
  entry: MaterializerLedgerEntry,
  conflicts: ConflictCounts,
): Promise<LedgerState> {
  let state = initial;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const existing = state.ledger.entries.find((item) => item.objectId === entry.objectId);
    if (existing?.targetCorpusDisplayName === entry.targetCorpusDisplayName) return state;
    const next: MaterializerLedger = {
      schemaVersion: state.ledger.schemaVersion,
      revision: state.ledger.revision + 1,
      entries: [
        ...state.ledger.entries.filter((item) => item.objectId !== entry.objectId),
        entry,
      ].sort((left, right) => compareStrings(left.objectId, right.objectId)),
    };
    try {
      const generation = await gcs.writeIfGeneration(
        path,
        encodeUtf8(serializeMaterializerLedger(next)),
        state.generation,
      );
      return { ledger: next, generation };
    } catch (error) {
      if (!(error instanceof GcsCasConflictError)) throw error;
      conflicts.ledger += 1;
      if (attempt === 2) throw new MaterializerCasConflictError("ledger", 2);
      state = await readLedger(gcs, path);
    }
  }
  throw new MaterializerCasConflictError("ledger", 2);
}

function uniqueCorpusResourceName(ledger: MaterializerLedger): string | null {
  const names = sortedUnique(ledger.entries.map((entry) => entry.corpusResourceName));
  return names.length === 1 ? names[0]! : null;
}

function decodeUtf8(bytes: Uint8Array, name: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${name} is not valid UTF-8`);
  }
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function duplicateIds(ids: Sha256Id[]): Sha256Id[] {
  const seen = new Set<Sha256Id>();
  const duplicates = new Set<Sha256Id>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].sort(compareStrings);
}

function sortedUnique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
