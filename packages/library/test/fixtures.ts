import {
  LIBRARY_SCHEMA_VERSION,
  canonicalObjectRelativePath,
  type LibraryObject,
  type MasterManifest,
  type Sha256Id,
} from "../src/index.ts";

export const OBJECT_ID_A = `sha256:${"a".repeat(64)}` as Sha256Id;
export const OBJECT_ID_B = `sha256:${"b".repeat(64)}` as Sha256Id;
export const OBJECT_ID_C = `sha256:${"c".repeat(64)}` as Sha256Id;

export function libraryObject(overrides: Partial<LibraryObject> = {}): LibraryObject {
  const id = overrides.id ?? OBJECT_ID_A;
  const mediaType = overrides.mediaType ?? "text/plain";
  return {
    id,
    sourceLocators: ["https://example.invalid/library/object-a"],
    mediaType,
    derivativeKind: null,
    byteSize: 12,
    provenance: {
      acquiredBy: "example-operator",
      acquiredAt: "2026-01-02T03:04:05.000Z",
      acquisitionMethod: "fixture-import",
    },
    trustTier: "reviewed",
    copyrightPosture: "licensed",
    lineage: { supersedes: [], supersededBy: [] },
    createdAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-01-02T03:04:05.000Z",
    relativePath: canonicalObjectRelativePath(id, mediaType),
    ...overrides,
  };
}

export function masterManifest(overrides: Partial<MasterManifest> = {}): MasterManifest {
  return {
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    revision: 0,
    ingestionCursor: null,
    objects: [],
    tombstones: [],
    manifestHash: `sha256:${"0".repeat(64)}`,
    ...overrides,
  };
}
