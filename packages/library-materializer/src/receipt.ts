import { canonicalJson, sha256, type Sha256Id, type UnresolvableSelection } from "@expert-agents/library";

export const MATERIALIZATION_RECEIPT_SCHEMA_VERSION = 1 as const;

export interface MaterializationReceipt {
  schemaVersion: typeof MATERIALIZATION_RECEIPT_SCHEMA_VERSION;
  mode: "execute" | "plan_only";
  agentId: string;
  targetCorpusDisplayName: string;
  corpusResourceName: string | null;
  masterRevision: { before: number; after: number };
  ledgerRevision: { before: number; after: number };
  candidates: {
    count: number;
    objectIds: Sha256Id[];
    addedObjectIds: Sha256Id[];
    dedupedObjectIds: Sha256Id[];
    plannedUploadObjectIds: Sha256Id[];
    uploadedObjectIds: Sha256Id[];
    existingObjectBytesIds: Sha256Id[];
  };
  materialization: {
    plannedImportObjectIds: Sha256Id[];
    importedObjectIds: Sha256Id[];
    recoveredObjectIds: Sha256Id[];
    rejectedImports: Array<{ objectId: Sha256Id; reason: string }>;
    alreadyMaterializedObjectIds: Sha256Id[];
    retractions: Array<{ objectId: Sha256Id; dry_run_only: true }>;
    unresolvableSelections: UnresolvableSelection[];
  };
  casConflicts: {
    manifest: number;
    ledger: number;
    object: number;
  };
  summary: {
    candidates: number;
    addedObjects: number;
    dedupedObjects: number;
    plannedUploads: number;
    uploadedObjects: number;
    plannedImports: number;
    importedObjects: number;
    recoveredImports: number;
    rejectedImports: number;
    alreadyMaterialized: number;
    retractionsDryRunOnly: number;
    unresolvableSelections: number;
  };
  noOp: boolean;
  receiptHash: Sha256Id;
}

type UnhashedReceipt = Omit<MaterializationReceipt, "receiptHash">;

export function finalizeMaterializationReceipt(receipt: UnhashedReceipt): MaterializationReceipt {
  return {
    ...receipt,
    receiptHash: sha256(canonicalJson(receipt)),
  };
}

export function serializeMaterializationReceipt(receipt: MaterializationReceipt): string {
  const { receiptHash, ...unhashed } = receipt;
  if (sha256(canonicalJson(unhashed)) !== receiptHash) {
    throw new Error("materialization receipt hash does not match its canonical content");
  }
  return canonicalJson(receipt);
}

export function assertMaterializationReceiptContainsNoSecrets(
  receiptBytes: Uint8Array,
  forbiddenValues: Array<string | undefined>,
): void {
  const serialized = new TextDecoder().decode(receiptBytes);
  if (forbiddenValues.some((value) => value !== undefined && value !== "" && serialized.includes(value))) {
    throw new Error("Refusing to write materialization receipt because it contains credential material.");
  }
}
