import { describe, expect, test } from "bun:test";
import {
  applyManifestUpdate,
  canonicalObjectRelativePath,
  finalizeMasterManifest,
  type MasterManifest,
} from "../src/index.ts";
import { OBJECT_ID_A, OBJECT_ID_B, libraryObject, masterManifest } from "./fixtures.ts";

function validManifest(overrides: Partial<MasterManifest> = {}): MasterManifest {
  const { manifestHash: _ignored, ...unhashed } = masterManifest(overrides);
  return finalizeMasterManifest(unhashed);
}

describe("atomic manifest updates", () => {
  test("increments exactly one revision for an atomic add, supersede, tombstone, and cursor advance", () => {
    const current = validManifest({ objects: [libraryObject()] });
    const replacement = libraryObject({
      id: OBJECT_ID_B,
      sourceLocators: ["https://example.invalid/library/object-b"],
      relativePath: canonicalObjectRelativePath(OBJECT_ID_B, "text/plain"),
    });
    const next = applyManifestUpdate(current, {
      expectedRevision: 0,
      addObjects: [replacement],
      supersede: [{
        objectId: OBJECT_ID_A,
        replacementObjectId: OBJECT_ID_B,
        updatedAt: "2026-01-03T03:04:05.000Z",
      }],
      tombstone: [{ objectId: OBJECT_ID_A, reason: "replaced" }],
      advanceCursor: { from: null, to: "cursor-0001" },
    });

    expect(next.revision).toBe(1);
    expect(next.ingestionCursor).toBe("cursor-0001");
    expect(next.objects).toHaveLength(1);
    expect(next.objects[0]?.lineage.supersedes).toEqual([OBJECT_ID_A]);
    expect(next.tombstones).toEqual([{ objectId: OBJECT_ID_A, revision: 1, reason: "replaced" }]);
    expect(next.manifestHash).not.toBe(current.manifestHash);
    expect(current.objects[0]?.lineage.supersededBy).toEqual([]);
  });

  test("rejects a revision race and cursor compare-and-set conflict", () => {
    const current = validManifest();
    expect(() => applyManifestUpdate(current, {
      expectedRevision: 2,
      advanceCursor: { from: null, to: "cursor-0001" },
    })).toThrow("revision conflict");
    expect(() => applyManifestUpdate(current, {
      expectedRevision: 0,
      advanceCursor: { from: "stale-cursor", to: "cursor-0001" },
    })).toThrow("cursor compare-and-set conflict");
  });

  test("annotates a live object and advances the manifest with compare-and-set semantics", () => {
    const current = validManifest({ objects: [libraryObject()] });
    const next = applyManifestUpdate(current, {
      expectedRevision: 0,
      annotate: [{
        objectId: OBJECT_ID_A,
        title: "A Neutral Work",
        creator: "Example Creator",
        updatedAt: "2026-01-03T03:04:05.000Z",
      }],
    });

    expect(next.revision).toBe(1);
    expect(next.objects[0]).toMatchObject({
      title: "A Neutral Work",
      creator: "Example Creator",
      updatedAt: "2026-01-03T03:04:05.000Z",
    });
    expect(next.manifestHash).not.toBe(current.manifestHash);
    expect(current.objects[0]).not.toHaveProperty("title");
    expect(() => applyManifestUpdate(current, {
      expectedRevision: 1,
      annotate: [{ objectId: OBJECT_ID_A, title: "Stale", updatedAt: "2026-01-03T03:04:05.000Z" }],
    })).toThrow("revision conflict");
  });

  test("rejects invalid annotations and annotations of unknown or tombstoned ids", () => {
    const current = validManifest({ objects: [libraryObject()] });
    expect(() => applyManifestUpdate(current, {
      expectedRevision: 0,
      annotate: [{ objectId: OBJECT_ID_A, updatedAt: "2026-01-03T03:04:05.000Z" }],
    })).toThrow("requires a title or creator");
    expect(() => applyManifestUpdate(current, {
      expectedRevision: 0,
      annotate: [{ objectId: OBJECT_ID_B, title: "Unknown", updatedAt: "2026-01-03T03:04:05.000Z" }],
    })).toThrow(`unknown object id ${OBJECT_ID_B}`);
    expect(() => applyManifestUpdate(validManifest({
      revision: 1,
      tombstones: [{ objectId: OBJECT_ID_A, revision: 1, reason: "withdrawn" }],
    }), {
      expectedRevision: 1,
      annotate: [{ objectId: OBJECT_ID_A, title: "Gone", updatedAt: "2026-01-03T03:04:05.000Z" }],
    })).toThrow(`tombstoned object id ${OBJECT_ID_A}`);
    expect(() => applyManifestUpdate(current, {
      expectedRevision: 0,
      annotate: [{ objectId: OBJECT_ID_A, title: "Removed", updatedAt: "2026-01-03T03:04:05.000Z" }],
      tombstone: [{ objectId: OBJECT_ID_A, reason: "withdrawn" }],
    })).toThrow(`tombstoned object id ${OBJECT_ID_A}`);
  });

  test("rejects duplicate adds and all tombstone-then-add interactions", () => {
    const object = libraryObject();
    expect(() => applyManifestUpdate(validManifest(), {
      expectedRevision: 0,
      addObjects: [object, object],
    })).toThrow(`duplicate add for object id ${OBJECT_ID_A}`);
    expect(() => applyManifestUpdate(validManifest({ objects: [object] }), {
      expectedRevision: 0,
      addObjects: [object],
    })).toThrow(`duplicate add for object id ${OBJECT_ID_A}`);
    expect(() => applyManifestUpdate(validManifest(), {
      expectedRevision: 0,
      addObjects: [object],
      tombstone: [{ objectId: OBJECT_ID_A, reason: "same-update conflict" }],
    })).toThrow("cannot be added after tombstoning");
    expect(() => applyManifestUpdate(validManifest({
      revision: 1,
      tombstones: [{ objectId: OBJECT_ID_A, revision: 1, reason: "withdrawn" }],
    }), {
      expectedRevision: 1,
      addObjects: [object],
    })).toThrow("cannot be added after tombstoning");
  });

  test("rejects supersede cycles without exposing object content or locators", () => {
    const first = libraryObject();
    const second = libraryObject({
      id: OBJECT_ID_B,
      sourceLocators: ["https://private.example.invalid/secret-source"],
      relativePath: canonicalObjectRelativePath(OBJECT_ID_B, "text/plain"),
    });
    let message = "";
    try {
      applyManifestUpdate(validManifest({ objects: [first, second] }), {
        expectedRevision: 0,
        supersede: [
          { objectId: OBJECT_ID_A, replacementObjectId: OBJECT_ID_B, updatedAt: "2026-01-03T03:04:05.000Z" },
          { objectId: OBJECT_ID_B, replacementObjectId: OBJECT_ID_A, updatedAt: "2026-01-03T03:04:05.000Z" },
        ],
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("supersede cycle");
    expect(message).not.toContain("secret-source");
    expect(message).not.toContain("private.example.invalid");
  });
});
