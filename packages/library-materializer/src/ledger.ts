import {
  MATERIALIZATION_LEDGER_SCHEMA_VERSION,
  canonicalJson,
  type MaterializationLedger,
  type Sha256Id,
} from "@expert-agents/library";

export const MATERIALIZER_LEDGER_SCHEMA_VERSION = MATERIALIZATION_LEDGER_SCHEMA_VERSION;

export interface MaterializerLedgerEntry {
  objectId: Sha256Id;
  ragFileId: string;
  targetCorpusDisplayName?: string;
  corpusResourceName: string;
  importedAtRevision: number;
}

export interface MaterializerLedger {
  schemaVersion: typeof MATERIALIZER_LEDGER_SCHEMA_VERSION;
  revision: number;
  entries: MaterializerLedgerEntry[];
}

export class MaterializerLedgerError extends Error {
  readonly code = "materializer_ledger_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "MaterializerLedgerError";
  }
}

export function emptyMaterializerLedger(): MaterializerLedger {
  return {
    schemaVersion: MATERIALIZER_LEDGER_SCHEMA_VERSION,
    revision: 0,
    entries: [],
  };
}

export function validateMaterializerLedger(value: unknown): MaterializerLedger {
  const record = requireRecord(value, "materialization ledger");
  requireExactKeys(record, ["schemaVersion", "revision", "entries"], "materialization ledger");
  if (record.schemaVersion !== MATERIALIZER_LEDGER_SCHEMA_VERSION) {
    throw new MaterializerLedgerError("materialization ledger schema version is unsupported");
  }
  const revision = requireNonNegativeInteger(record.revision, "materialization ledger revision");
  if (!Array.isArray(record.entries)) {
    throw new MaterializerLedgerError("materialization ledger entries must be an array");
  }
  const entries = record.entries.map(validateLedgerEntry);
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.objectId >= entries[index]!.objectId) {
      throw new MaterializerLedgerError("materialization ledger entries must be sorted and unique by object id");
    }
  }
  if (new Set(entries.map((entry) => entry.ragFileId)).size !== entries.length) {
    throw new MaterializerLedgerError("materialization ledger contains a duplicate RAG-file id");
  }
  return { schemaVersion: MATERIALIZER_LEDGER_SCHEMA_VERSION, revision, entries };
}

export function parseMaterializerLedger(text: string): MaterializerLedger {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MaterializerLedgerError("materialization ledger is not valid JSON");
  }
  const ledger = validateMaterializerLedger(parsed);
  if (serializeMaterializerLedger(ledger) !== text) {
    throw new MaterializerLedgerError("materialization ledger is not canonically serialized");
  }
  return ledger;
}

export function serializeMaterializerLedger(value: MaterializerLedger): string {
  return canonicalJson(validateMaterializerLedger(value));
}

export function plannerLedger(value: MaterializerLedger): MaterializationLedger {
  const ledger = validateMaterializerLedger(value);
  return {
    schemaVersion: MATERIALIZATION_LEDGER_SCHEMA_VERSION,
    entries: ledger.entries.map(({ objectId, ragFileId, targetCorpusDisplayName }) => ({
      objectId,
      ragFileId,
      ...(targetCorpusDisplayName === undefined ? {} : { targetCorpusDisplayName }),
    })),
  };
}

function validateLedgerEntry(value: unknown): MaterializerLedgerEntry {
  const record = requireRecord(value, "materialization ledger entry");
  requireKeysWithOptional(
    record,
    ["objectId", "ragFileId", "corpusResourceName", "importedAtRevision"],
    ["targetCorpusDisplayName"],
    "materialization ledger entry",
  );
  const targetCorpusDisplayName = record.targetCorpusDisplayName === undefined
    ? undefined
    : requireNonEmptyString(
      record.targetCorpusDisplayName,
      "materialization ledger target corpus display name",
    );
  return {
    objectId: requireSha256Id(record.objectId),
    ragFileId: requireNonEmptyString(record.ragFileId, "materialization ledger RAG-file id"),
    ...(targetCorpusDisplayName === undefined ? {} : { targetCorpusDisplayName }),
    corpusResourceName: requireNonEmptyString(
      record.corpusResourceName,
      "materialization ledger corpus resource name",
    ),
    importedAtRevision: requireNonNegativeInteger(
      record.importedAtRevision,
      "materialization ledger imported-at revision",
    ),
  };
}

function requireKeysWithOptional(
  record: Record<string, unknown>,
  required: string[],
  optional: string[],
  name: string,
): void {
  const expected = new Set([...required, ...optional]);
  if (required.some((key) => !(key in record)) || Object.keys(record).some((key) => !expected.has(key))) {
    throw new MaterializerLedgerError(`${name} fields are invalid`);
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MaterializerLedgerError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: string[], name: string): void {
  const expected = new Set(keys);
  if (keys.some((key) => !(key in record)) || Object.keys(record).some((key) => !expected.has(key))) {
    throw new MaterializerLedgerError(`${name} fields are invalid`);
  }
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new MaterializerLedgerError(`${name} must be a non-empty trimmed string`);
  }
  return value;
}

function requireSha256Id(value: unknown): Sha256Id {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new MaterializerLedgerError("materialization ledger object id is invalid");
  }
  return value as Sha256Id;
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new MaterializerLedgerError(`${name} must be a non-negative integer`);
  }
  return value as number;
}
