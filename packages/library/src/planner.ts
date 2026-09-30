import { canonicalJson, assertMasterManifestHash } from "./serialization.ts";
import type { LibraryObject, MasterManifest, ScopeIncludeFilters, ScopeManifest, Sha256Id } from "./types.ts";
import { validateScopeManifest } from "./validation.ts";

export const MATERIALIZATION_LEDGER_SCHEMA_VERSION = 1 as const;
export const RECONCILIATION_PLAN_SCHEMA_VERSION = 1 as const;

export interface MaterializationLedgerEntry {
  objectId: Sha256Id;
  ragFileId: string;
  targetCorpusDisplayName?: string;
}

export interface MaterializationLedger {
  schemaVersion: typeof MATERIALIZATION_LEDGER_SCHEMA_VERSION;
  entries: MaterializationLedgerEntry[];
}

export interface ReconciliationImport {
  objectId: Sha256Id;
  relativePath: string;
}

export interface ReconciliationNoOp {
  objectId: Sha256Id;
  ragFileId: string;
}

export interface ReconciliationRetraction {
  objectId: Sha256Id;
  ragFileId: string;
  dry_run_only: true;
}

export type UnresolvableSelection =
  | { reason: "missing_object_id"; objectId: Sha256Id }
  | { reason: "include_filters_matched_nothing"; filterKinds: ("kind" | "locator_prefix" | "trust_tier")[] };

export interface ReconciliationPlan {
  schemaVersion: typeof RECONCILIATION_PLAN_SCHEMA_VERSION;
  agentId: string;
  targetCorpusDisplayName: string;
  masterRevision: number;
  scopeMasterRevision: number;
  imports: ReconciliationImport[];
  alreadyMaterialized: ReconciliationNoOp[];
  retractions: ReconciliationRetraction[];
  unresolvableSelections: UnresolvableSelection[];
  summary: {
    selectedObjects: number;
    imports: number;
    alreadyMaterialized: number;
    retractions: number;
    unresolvableSelections: number;
  };
}

export class ReconciliationPlannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconciliationPlannerError";
  }
}

export function planReconciliation(
  masterInput: MasterManifest,
  scopeInput: ScopeManifest,
  ledgerInput: MaterializationLedger,
): ReconciliationPlan {
  const master = assertMasterManifestHash(masterInput);
  const scope = validateScopeManifest(scopeInput);
  const ledger = validateMaterializationLedger(ledgerInput);
  if (scope.masterRevision > master.revision) {
    throw new ReconciliationPlannerError("scope manifest references a future master revision");
  }

  const objects = new Map(master.objects.map((object) => [object.id, object]));
  const selected = new Set<Sha256Id>();
  const unresolvableSelections: UnresolvableSelection[] = [];

  for (const objectId of scope.selection.objectIds) {
    if (objects.has(objectId)) {
      selected.add(objectId);
    } else {
      unresolvableSelections.push({ reason: "missing_object_id", objectId });
    }
  }

  const filters = scope.selection.includeFilters;
  if (filters !== undefined) {
    const matches = master.objects.filter((object) => matchesFilters(object, filters));
    if (matches.length === 0) {
      unresolvableSelections.push({
        reason: "include_filters_matched_nothing",
        filterKinds: presentFilterKinds(filters),
      });
    } else {
      for (const object of matches) selected.add(object.id);
    }
  }

  const ledgerByObject = new Map(ledger.entries.map((entry) => [entry.objectId, entry]));
  const selectedObjects = [...selected]
    .map((objectId) => objects.get(objectId)!)
    .sort((left, right) => compareStrings(left.id, right.id));
  const imports: ReconciliationImport[] = [];
  const alreadyMaterialized: ReconciliationNoOp[] = [];
  for (const object of selectedObjects) {
    const entry = ledgerByObject.get(object.id);
    if (entry?.targetCorpusDisplayName !== scope.targetCorpusDisplayName) {
      imports.push({ objectId: object.id, relativePath: object.relativePath });
    } else {
      alreadyMaterialized.push({ objectId: object.id, ragFileId: entry.ragFileId });
    }
  }
  const retractions: ReconciliationRetraction[] = ledger.entries
    .filter((entry) => !selected.has(entry.objectId))
    .map((entry) => ({
      objectId: entry.objectId,
      ragFileId: entry.ragFileId,
      dry_run_only: true as const,
    }))
    .sort((left, right) => compareStrings(left.objectId, right.objectId));

  return {
    schemaVersion: RECONCILIATION_PLAN_SCHEMA_VERSION,
    agentId: scope.agentId,
    targetCorpusDisplayName: scope.targetCorpusDisplayName,
    masterRevision: master.revision,
    scopeMasterRevision: scope.masterRevision,
    imports,
    alreadyMaterialized,
    retractions,
    unresolvableSelections,
    summary: {
      selectedObjects: selectedObjects.length,
      imports: imports.length,
      alreadyMaterialized: alreadyMaterialized.length,
      retractions: retractions.length,
      unresolvableSelections: unresolvableSelections.length,
    },
  };
}

export function serializeReconciliationPlan(plan: ReconciliationPlan): string {
  return canonicalJson(plan);
}

export function validateMaterializationLedger(value: unknown): MaterializationLedger {
  const record = asRecord(value, "materialization ledger");
  requireExactKeys(record, ["schemaVersion", "entries"], "materialization ledger");
  if (record.schemaVersion !== MATERIALIZATION_LEDGER_SCHEMA_VERSION) {
    throw new ReconciliationPlannerError("materialization ledger schema version is unsupported");
  }
  if (!Array.isArray(record.entries)) {
    throw new ReconciliationPlannerError("materialization ledger entries must be an array");
  }
  const entries = record.entries.map((value) => {
    const entry = asRecord(value, "materialization ledger entry");
    requireKeysWithOptional(
      entry,
      ["objectId", "ragFileId"],
      ["targetCorpusDisplayName"],
      "materialization ledger entry",
    );
    const targetCorpusDisplayName = entry.targetCorpusDisplayName === undefined
      ? undefined
      : requireString(entry.targetCorpusDisplayName, "materialization ledger target corpus display name");
    return {
      objectId: requireSha256Id(entry.objectId),
      ragFileId: requireString(entry.ragFileId, "materialization ledger RAG-file id"),
      ...(targetCorpusDisplayName === undefined ? {} : { targetCorpusDisplayName }),
    };
  }).sort((left, right) => compareStrings(left.objectId, right.objectId));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.objectId === entries[index]!.objectId) {
      throw new ReconciliationPlannerError("materialization ledger contains a duplicate object id");
    }
  }
  if (new Set(entries.map((entry) => entry.ragFileId)).size !== entries.length) {
    throw new ReconciliationPlannerError("materialization ledger contains a duplicate RAG-file id");
  }
  return { schemaVersion: MATERIALIZATION_LEDGER_SCHEMA_VERSION, entries };
}

function requireKeysWithOptional(
  record: Record<string, unknown>,
  required: string[],
  optional: string[],
  name: string,
): void {
  const expected = new Set([...required, ...optional]);
  if (required.some((key) => !(key in record)) || Object.keys(record).some((key) => !expected.has(key))) {
    throw new ReconciliationPlannerError(`${name} fields are invalid`);
  }
}

function matchesFilters(object: LibraryObject, filters: ScopeIncludeFilters): boolean {
  if (filters.trustTiers !== undefined && !filters.trustTiers.includes(object.trustTier)) return false;
  if (filters.kinds !== undefined) {
    const kinds = object.derivativeKind === null
      ? [object.mediaType]
      : [object.mediaType, object.derivativeKind];
    if (!filters.kinds.some((kind) => kinds.includes(kind))) return false;
  }
  if (filters.locatorPrefixes !== undefined
    && !filters.locatorPrefixes.some((prefix) => object.sourceLocators.some((locator) => locator.startsWith(prefix)))) {
    return false;
  }
  return true;
}

function presentFilterKinds(filters: ScopeIncludeFilters): ("kind" | "locator_prefix" | "trust_tier")[] {
  const kinds: ("kind" | "locator_prefix" | "trust_tier")[] = [];
  if (filters.kinds !== undefined) kinds.push("kind");
  if (filters.locatorPrefixes !== undefined) kinds.push("locator_prefix");
  if (filters.trustTiers !== undefined) kinds.push("trust_tier");
  return kinds;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReconciliationPlannerError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: string[], name: string): void {
  const expected = new Set(keys);
  if (keys.some((key) => !(key in record)) || Object.keys(record).some((key) => !expected.has(key))) {
    throw new ReconciliationPlannerError(`${name} fields are invalid`);
  }
}

function requireSha256Id(value: unknown): Sha256Id {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new ReconciliationPlannerError("materialization ledger object id is invalid");
  }
  return value as Sha256Id;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new ReconciliationPlannerError(`${name} must be a non-empty trimmed string`);
  }
  return value;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
