import { describe, expect, test } from "bun:test";
import {
  MATERIALIZATION_LEDGER_SCHEMA_VERSION,
  canonicalObjectRelativePath,
  finalizeMasterManifest,
  planReconciliation,
  serializeReconciliationPlan,
  type MasterManifest,
  type MaterializationLedger,
} from "../src/index.ts";
import { OBJECT_ID_A, OBJECT_ID_B, OBJECT_ID_C, libraryObject, masterManifest, scopeManifest } from "./fixtures.ts";

function libraryWithTwoObjects(): MasterManifest {
  const second = libraryObject({
    id: OBJECT_ID_B,
    sourceLocators: ["https://example.invalid/library/object-b"],
    mediaType: "application/pdf",
    trustTier: "unreviewed",
    relativePath: canonicalObjectRelativePath(OBJECT_ID_B, "application/pdf"),
  });
  const { manifestHash: _ignored, ...unhashed } = masterManifest({ objects: [libraryObject(), second] });
  return finalizeMasterManifest(unhashed);
}

function ledger(entries: MaterializationLedger["entries"] = []): MaterializationLedger {
  return { schemaVersion: MATERIALIZATION_LEDGER_SCHEMA_VERSION, entries };
}

describe("deterministic reconciliation planner", () => {
  test("plans a fresh materialization as sorted imports", () => {
    const plan = planReconciliation(libraryWithTwoObjects(), scopeManifest(), ledger());
    expect(plan.imports).toEqual([{
      objectId: OBJECT_ID_A,
      relativePath: canonicalObjectRelativePath(OBJECT_ID_A, "text/plain"),
    }]);
    expect(plan.alreadyMaterialized).toEqual([]);
    expect(plan.summary).toEqual({
      selectedObjects: 1,
      imports: 1,
      alreadyMaterialized: 0,
      retractions: 0,
      unresolvableSelections: 0,
    });
  });

  test("produces a no-op on an idempotent rerun", () => {
    const plan = planReconciliation(
      libraryWithTwoObjects(),
      scopeManifest(),
      ledger([{
        objectId: OBJECT_ID_A,
        ragFileId: "ragFiles/example-a",
        targetCorpusDisplayName: "example-agent-library",
      }]),
    );
    expect(plan.imports).toEqual([]);
    expect(plan.alreadyMaterialized).toEqual([{ objectId: OBJECT_ID_A, ragFileId: "ragFiles/example-a" }]);
    expect(plan.retractions).toEqual([]);
  });

  test("reimports for a corpus retarget and converges after the corpus-keyed ledger migration", () => {
    const master = libraryWithTwoObjects();
    const retargetedScope = scopeManifest({ targetCorpusDisplayName: "retargeted-library" });
    const oldCorpus = ledger([{
      objectId: OBJECT_ID_A,
      ragFileId: "ragFiles/example-a-old",
      targetCorpusDisplayName: "old-library",
    }]);
    const legacy = ledger([{ objectId: OBJECT_ID_A, ragFileId: "ragFiles/example-a-legacy" }]);

    expect(planReconciliation(master, retargetedScope, oldCorpus).imports.map((entry) => entry.objectId))
      .toEqual([OBJECT_ID_A]);
    expect(planReconciliation(master, retargetedScope, legacy).imports.map((entry) => entry.objectId))
      .toEqual([OBJECT_ID_A]);

    const migrated = ledger([{
      objectId: OBJECT_ID_A,
      ragFileId: "ragFiles/example-a-retargeted",
      targetCorpusDisplayName: "retargeted-library",
    }]);
    const converged = planReconciliation(master, retargetedScope, migrated);
    expect(converged.imports).toEqual([]);
    expect(converged.alreadyMaterialized).toEqual([{
      objectId: OBJECT_ID_A,
      ragFileId: "ragFiles/example-a-retargeted",
    }]);
  });

  test("marks every out-of-scope retraction dry-run-only", () => {
    const plan = planReconciliation(
      libraryWithTwoObjects(),
      scopeManifest(),
      ledger([
        { objectId: OBJECT_ID_B, ragFileId: "ragFiles/example-b" },
        { objectId: OBJECT_ID_A, ragFileId: "ragFiles/example-a" },
      ]),
    );
    expect(plan.retractions).toEqual([{
      objectId: OBJECT_ID_B,
      ragFileId: "ragFiles/example-b",
      dry_run_only: true,
    }]);
    expect(plan.retractions.every((entry) => entry.dry_run_only)).toBe(true);
  });

  test("reports missing ids and include filters that match nothing without locator values", () => {
    const plan = planReconciliation(libraryWithTwoObjects(), scopeManifest({
      selection: {
        objectIds: [OBJECT_ID_C],
        includeFilters: {
          kinds: ["audio/example"],
          locatorPrefixes: ["https://private.example.invalid/"],
          trustTiers: ["restricted"],
        },
      },
    }), ledger());
    expect(plan.unresolvableSelections).toEqual([
      { reason: "missing_object_id", objectId: OBJECT_ID_C },
      {
        reason: "include_filters_matched_nothing",
        filterKinds: ["kind", "locator_prefix", "trust_tier"],
      },
    ]);
    expect(JSON.stringify(plan)).not.toContain("private.example.invalid");
  });

  test("ANDs filter dimensions, ORs their values, and sorts multi-object imports", () => {
    const master = libraryWithTwoObjects();
    const multiMatch = planReconciliation(master, scopeManifest({
      selection: {
        objectIds: [],
        includeFilters: {
          kinds: ["application/pdf", "text/plain"],
          trustTiers: ["reviewed", "unreviewed"],
        },
      },
    }), ledger());
    expect(multiMatch.imports.map((entry) => entry.objectId)).toEqual([OBJECT_ID_A, OBJECT_ID_B]);

    const noConjunctiveMatch = planReconciliation(master, scopeManifest({
      selection: {
        objectIds: [],
        includeFilters: {
          kinds: ["application/pdf"],
          trustTiers: ["reviewed"],
        },
      },
    }), ledger());
    expect(noConjunctiveMatch.imports).toEqual([]);
    expect(noConjunctiveMatch.unresolvableSelections).toEqual([{
      reason: "include_filters_matched_nothing",
      filterKinds: ["kind", "trust_tier"],
    }]);
  });

  test("serializes byte-identically for the same inputs", () => {
    const master = libraryWithTwoObjects();
    const scope = scopeManifest({
      selection: { objectIds: [], includeFilters: { trustTiers: ["reviewed"] } },
    });
    const current = ledger([{ objectId: OBJECT_ID_B, ragFileId: "ragFiles/example-b" }]);
    const first = serializeReconciliationPlan(planReconciliation(master, scope, current));
    const second = serializeReconciliationPlan(planReconciliation(master, scope, current));
    expect(second).toBe(first);
    expect(first.endsWith("\n")).toBe(true);
  });
});
