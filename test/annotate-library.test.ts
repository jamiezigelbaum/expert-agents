import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIBRARY_SCHEMA_VERSION,
  canonicalObjectRelativePath,
  finalizeMasterManifest,
  parseMasterManifest,
  serializeMasterManifest,
  type LibraryObject,
  type MasterManifest,
  type Sha256Id,
} from "../packages/library/src/index.ts";
import { InMemoryGcsAdapter } from "../packages/library-materializer/src/index.ts";
import {
  assertAnnotationReceiptContainsNoSecrets,
  deriveAnnotationFromLocator,
  runAnnotateLibraryCli,
} from "../scripts/annotate-library.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const OBJECT_ID_A = `sha256:${"a".repeat(64)}` as Sha256Id;
const OBJECT_ID_B = `sha256:${"b".repeat(64)}` as Sha256Id;
const OBJECT_ID_C = `sha256:${"c".repeat(64)}` as Sha256Id;

describe("library annotation CLI", () => {
  test("proposes one-token, two-token, and ambiguous slug annotations without cloud writes", async () => {
    expect(deriveAnnotationFromLocator("https://example.invalid/ada-lovelace-analytical-engine-notes.txt"))
      .toEqual({ creator: "Ada Lovelace", title: "Analytical Engine Notes" });
    expect(deriveAnnotationFromLocator("candidate://fixtures/plato-the-republic.txt"))
      .toEqual({ creator: "Plato", title: "The Republic" });
    expect(deriveAnnotationFromLocator("candidate://fixtures/field-notes.txt"))
      .toEqual({ title: "Field Notes" });

    const manifest = validManifest({
      objects: [
        libraryObject(OBJECT_ID_A, "https://example.invalid/ada-lovelace-analytical-engine-notes.txt"),
        libraryObject(OBJECT_ID_B, "candidate://fixtures/plato-the-republic.txt"),
        libraryObject(OBJECT_ID_C, "candidate://fixtures/field-notes.txt"),
      ],
    });
    const gcs = seededGcs(manifest);
    const fixture = temporaryFixture();
    try {
      const outputPath = join(fixture.path, "proposals.json");
      const result = await runAnnotateLibraryCli([
        "--bucket", "neutral-bucket",
        "--prefix", "shared/library",
        "--propose",
        "--out", outputPath,
      ], { gcs });
      const output = JSON.parse(decoder.decode(result.outputBytes)) as Record<string, any>;
      expect(output).toEqual({
        schemaVersion: 1,
        masterRevision: 0,
        proposals: [
          { objectId: OBJECT_ID_A, creator: "Ada Lovelace", title: "Analytical Engine Notes" },
          { objectId: OBJECT_ID_B, creator: "Plato", title: "The Republic" },
          { objectId: OBJECT_ID_C, title: "Field Notes" },
        ],
      });
      expect(readFileSync(outputPath, "utf8")).toBe(decoder.decode(result.outputBytes));
      expect(gcs.writes).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  test("execute applies reviewed annotations with manifest generation CAS", async () => {
    const manifest = validManifest({ objects: [libraryObject(OBJECT_ID_A, "candidate://fixtures/neutral-work.txt")] });
    const gcs = seededGcs(manifest);
    const fixture = temporaryFixture();
    try {
      const annotationsPath = join(fixture.path, "annotations.json");
      const receiptPath = join(fixture.path, "receipt.json");
      writeFileSync(annotationsPath, JSON.stringify({
        schemaVersion: 1,
        expectedRevision: 0,
        annotations: [{
          objectId: OBJECT_ID_A,
          title: "Reviewed Work",
          creator: "Neutral Creator",
          updatedAt: "2026-01-03T03:04:05.000Z",
        }],
      }));

      const result = await runAnnotateLibraryCli([
        "--bucket", "neutral-bucket",
        "--prefix", "shared/library",
        "--execute",
        "--annotations", annotationsPath,
        "--receipt", receiptPath,
      ], { gcs, env: { EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_ACCESS_TOKEN: "fixture-token" } });

      const stored = await gcs.read("manifest/master.json");
      const updated = parseMasterManifest(decoder.decode(stored!.bytes));
      expect(updated.revision).toBe(1);
      expect(updated.objects[0]).toMatchObject({ title: "Reviewed Work", creator: "Neutral Creator" });
      expect(gcs.writes).toHaveLength(1);
      expect(gcs.writes[0]!.expectedGeneration).toBe("10");
      const receipt = JSON.parse(decoder.decode(result.outputBytes)) as Record<string, any>;
      expect(receipt).toEqual({
        schemaVersion: 1,
        kind: "library_annotation_receipt",
        masterRevision: { before: 0, after: 1 },
        applied: [{ objectId: OBJECT_ID_A, fields: ["creator", "title"] }],
        objectIds: [OBJECT_ID_A],
        casConflicts: 0,
        summary: { annotations: 1, titleFields: 1, creatorFields: 1 },
      });
      expect(decoder.decode(result.outputBytes)).not.toContain("Reviewed Work");
      expect(readFileSync(receiptPath, "utf8")).toBe(decoder.decode(result.outputBytes));
    } finally {
      fixture.cleanup();
    }
  });

  test("serializes byte-identical receipts for identical annotation inputs and state", async () => {
    const run = async (): Promise<string> => {
      const fixture = temporaryFixture();
      try {
        const annotationsPath = join(fixture.path, "annotations.json");
        writeFileSync(annotationsPath, JSON.stringify({
          schemaVersion: 1,
          expectedRevision: 0,
          annotations: [{
            objectId: OBJECT_ID_A,
            title: "Deterministic Work",
            updatedAt: "2026-01-03T03:04:05.000Z",
          }],
        }));
        const result = await runAnnotateLibraryCli([
          "--bucket", "neutral-bucket",
          "--prefix", "shared/library",
          "--execute",
          "--annotations", annotationsPath,
          "--receipt", join(fixture.path, "receipt.json"),
        ], {
          gcs: seededGcs(validManifest({
            objects: [libraryObject(OBJECT_ID_A, "candidate://fixtures/deterministic-work.txt")],
          })),
        });
        return decoder.decode(result.outputBytes);
      } finally {
        fixture.cleanup();
      }
    };

    expect(await run()).toBe(await run());
  });

  test("fails closed when annotation receipt bytes contain credential material", () => {
    const sentinel = "credential-sentinel-must-not-appear";
    expect(() => assertAnnotationReceiptContainsNoSecrets(
      encoder.encode(`{"leak":"${sentinel}"}`),
      [sentinel],
    )).toThrow("Refusing to write annotation receipt because it contains credential material.");
    expect(() => assertAnnotationReceiptContainsNoSecrets(encoder.encode("{}\n"), [sentinel])).not.toThrow();
  });
});

function libraryObject(id: Sha256Id, locator: string): LibraryObject {
  return {
    id,
    sourceLocators: [locator],
    mediaType: "text/plain",
    derivativeKind: null,
    byteSize: 10,
    provenance: {
      acquiredBy: "neutral-fixture",
      acquiredAt: "2026-01-02T03:04:05.000Z",
      acquisitionMethod: "offline-fixture",
    },
    trustTier: "reviewed",
    copyrightPosture: "fixture-only",
    lineage: { supersedes: [], supersededBy: [] },
    createdAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-01-02T03:04:05.000Z",
    relativePath: canonicalObjectRelativePath(id, "text/plain"),
  };
}

function validManifest(overrides: Partial<MasterManifest> = {}): MasterManifest {
  return finalizeMasterManifest({
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    revision: 0,
    ingestionCursor: null,
    objects: [],
    tombstones: [],
    ...overrides,
  });
}

function seededGcs(manifest: MasterManifest): InMemoryGcsAdapter {
  return new InMemoryGcsAdapter([{
    path: "manifest/master.json",
    bytes: encoder.encode(serializeMasterManifest(manifest)),
    generation: "10",
  }]);
}

function temporaryFixture(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "expert-agents-annotate-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
