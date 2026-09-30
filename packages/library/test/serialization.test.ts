import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  computeMasterManifestHash,
  contentIdFromBytes,
  finalizeMasterManifest,
  parseLibraryObject,
  parseMasterManifest,
  parseScopeManifest,
  serializeLibraryObject,
  serializeMasterManifest,
  serializeScopeManifest,
} from "../src/index.ts";
import { libraryObject, masterManifest, scopeManifest } from "./fixtures.ts";

describe("canonical serialization and hashing", () => {
  test("sorts JSON keys recursively with fixed spacing and a trailing newline", () => {
    expect(canonicalJson({ z: 1, a: { c: true, b: [2, 1] } })).toBe(
      '{\n  "a": {\n    "b": [\n      2,\n      1\n    ],\n    "c": true\n  },\n  "z": 1\n}\n',
    );
  });

  test("matches the fixed SHA-256 vector for canonical bytes", () => {
    expect(contentIdFromBytes("abc")).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("computes a stable manifest hash that excludes its own hash field", () => {
    const { manifestHash: _ignored, ...unhashed } = masterManifest();
    const manifest = finalizeMasterManifest(unhashed);
    expect(manifest.manifestHash).toBe("sha256:7d0e4e316581c76fc82da0fe3abdfdd92db6edeb72a97083c25eb9a8739a1c3f");
    expect(serializeMasterManifest(manifest)).toBe(
      '{\n'
      + '  "ingestionCursor": null,\n'
      + '  "manifestHash": "sha256:7d0e4e316581c76fc82da0fe3abdfdd92db6edeb72a97083c25eb9a8739a1c3f",\n'
      + '  "objects": [],\n'
      + '  "revision": 0,\n'
      + '  "schemaVersion": 1,\n'
      + '  "tombstones": []\n'
      + '}\n',
    );
    expect(computeMasterManifestHash({
      ...manifest,
      manifestHash: `sha256:${"f".repeat(64)}`,
    })).toBe(manifest.manifestHash);
  });

  test("round-trips every canonical contract document byte-identically", () => {
    const objectText = serializeLibraryObject(libraryObject({
      title: "A Neutral Work",
      creator: "Example Creator",
    }));
    const scopeText = serializeScopeManifest(scopeManifest());
    const { manifestHash: _ignored, ...unhashed } = masterManifest();
    const manifestText = serializeMasterManifest(finalizeMasterManifest(unhashed));

    expect(serializeLibraryObject(parseLibraryObject(objectText))).toBe(objectText);
    expect(serializeScopeManifest(parseScopeManifest(scopeText))).toBe(scopeText);
    expect(serializeMasterManifest(parseMasterManifest(manifestText))).toBe(manifestText);
  });

  test("round-trips a manifest hash with object annotations", () => {
    const annotated = libraryObject({ title: "A Neutral Work", creator: "Example Creator" });
    const { manifestHash: _ignored, ...unhashed } = masterManifest({ objects: [annotated] });
    const manifest = finalizeMasterManifest(unhashed);
    const serialized = serializeMasterManifest(manifest);

    expect(parseMasterManifest(serialized).objects[0]).toMatchObject({
      title: "A Neutral Work",
      creator: "Example Creator",
    });
    expect(serializeMasterManifest(parseMasterManifest(serialized))).toBe(serialized);
  });

  test("rejects noncanonical document bytes and a mismatched manifest hash", () => {
    expect(() => parseScopeManifest(`${JSON.stringify(scopeManifest())}\n`)).toThrow("not canonically serialized");
    expect(() => serializeMasterManifest(masterManifest())).toThrow("hash does not match");
  });
});
