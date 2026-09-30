import { describe, expect, test } from "bun:test";
import {
  canonicalObjectRelativePath,
  libraryObjectUri,
  validateLibraryLocationConfig,
  validateLibraryObject,
  validateMasterManifest,
  validateScopeManifest,
} from "../src/index.ts";
import { OBJECT_ID_A, OBJECT_ID_B, libraryObject, masterManifest, scopeManifest } from "./fixtures.ts";

describe("library contract schema validation", () => {
  test("accepts a canonical library object and configured shared-library URI", () => {
    const object = libraryObject();
    expect(validateLibraryObject(object)).toEqual(object);
    expect(canonicalObjectRelativePath(OBJECT_ID_A, "text/plain")).toBe(`objects/sha256/aa/${"a".repeat(64)}.txt`);
    expect(canonicalObjectRelativePath(OBJECT_ID_A, "text/markdown")).toBe(`objects/sha256/aa/${"a".repeat(64)}.md`);
    expect(canonicalObjectRelativePath(OBJECT_ID_A, "application/x-unknown")).toBe(`objects/sha256/aa/${"a".repeat(64)}.bin`);
    expect(libraryObjectUri({ bucket: "example-shared-library", prefix: "master/v1" }, OBJECT_ID_A, "text/plain")).toBe(
      `gs://example-shared-library/master/v1/objects/sha256/aa/${"a".repeat(64)}.txt`,
    );
  });

  test("rejects object ids, paths, timestamps, and locator arrays that are not canonical", () => {
    expect(() => validateLibraryObject(libraryObject({ id: "sha256:ABC" as never }))).toThrow("lowercase sha256 id");
    expect(() => validateLibraryObject(libraryObject({ relativePath: "objects/not-derived" }))).toThrow("does not match its id");
    expect(() => validateLibraryObject(libraryObject({ updatedAt: "2026-01-02T03:04:05Z" }))).toThrow("canonical UTC timestamp");
    expect(() => validateLibraryObject(libraryObject({ sourceLocators: ["z", "a"] }))).toThrow("sorted and unique");
  });

  test("accepts a sorted master manifest and rejects order or tombstone conflicts", () => {
    const first = libraryObject();
    const second = libraryObject({
      id: OBJECT_ID_B,
      sourceLocators: ["https://example.invalid/library/object-b"],
      relativePath: canonicalObjectRelativePath(OBJECT_ID_B, "text/plain"),
    });
    expect(validateMasterManifest(masterManifest({ objects: [first, second] })).objects).toEqual([first, second]);
    expect(() => validateMasterManifest(masterManifest({ objects: [second, first] }))).toThrow("sorted and unique");
    expect(() => validateMasterManifest(masterManifest({
      revision: 1,
      objects: [first],
      tombstones: [{ objectId: OBJECT_ID_A, revision: 1, reason: "withdrawn" }],
    }))).toThrow("both a live object and tombstone");
  });

  test("accepts explicit and filter scope selection and rejects noncanonical scope input", () => {
    const scope = scopeManifest({
      selection: {
        objectIds: [OBJECT_ID_A],
        includeFilters: {
          kinds: ["text/plain"],
          locatorPrefixes: ["https://example.invalid/library/"],
          trustTiers: ["reviewed"],
        },
      },
    });
    expect(validateScopeManifest(scope)).toEqual(scope);
    expect(() => validateScopeManifest(scopeManifest({ agentId: "Example Agent" }))).toThrow("agent id is invalid");
    expect(() => validateScopeManifest(scopeManifest({ selection: { objectIds: [OBJECT_ID_B, OBJECT_ID_A] } }))).toThrow("sorted and unique");
    expect(() => validateScopeManifest(scopeManifest({ selection: { objectIds: [], includeFilters: {} } }))).toThrow("include filters are empty");
  });

  test("rejects storage configuration that is not a single explicit bucket and prefix", () => {
    expect(validateLibraryLocationConfig({ bucket: "example-shared-library", prefix: "library/v1" })).toEqual({
      bucket: "example-shared-library",
      prefix: "library/v1",
    });
    expect(() => validateLibraryLocationConfig({ bucket: "example-shared-library", prefix: "/library/v1" })).toThrow("prefix is invalid");
  });
});
