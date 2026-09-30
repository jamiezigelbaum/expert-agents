import { createHash } from "node:crypto";
import type { LibraryObject, MasterManifest, ScopeManifest, Sha256Id } from "./types.ts";
import {
  LibraryValidationError,
  validateLibraryObject,
  validateMasterManifest,
  validateScopeManifest,
} from "./validation.ts";

type UnhashedMasterManifest = Omit<MasterManifest, "manifestHash">;
type JsonPrimitive = boolean | null | number | string;
type CanonicalJson = JsonPrimitive | CanonicalJson[] | { [key: string]: CanonicalJson };

const STRUCTURAL_HASH_PLACEHOLDER = `sha256:${"0".repeat(64)}` as Sha256Id;

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(toCanonicalJson(value), null, 2)}\n`;
}

export function sha256(bytes: string | Uint8Array): Sha256Id {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `sha256:${digest}`;
}

export function contentIdFromBytes(bytes: string | Uint8Array): Sha256Id {
  return sha256(bytes);
}

export function computeMasterManifestHash(manifest: MasterManifest): Sha256Id {
  const validated = validateMasterManifest(manifest);
  return sha256(canonicalJson(withoutManifestHash(validated)));
}

export function finalizeMasterManifest(manifest: UnhashedMasterManifest): MasterManifest {
  const structurallyValid = validateMasterManifest({
    ...manifest,
    manifestHash: STRUCTURAL_HASH_PLACEHOLDER,
  });
  const unhashed = withoutManifestHash(structurallyValid);
  return {
    ...unhashed,
    manifestHash: sha256(canonicalJson(unhashed)),
  };
}

export function assertMasterManifestHash(manifest: unknown): MasterManifest {
  const validated = validateMasterManifest(manifest);
  if (computeMasterManifestHash(validated) !== validated.manifestHash) {
    throw new LibraryValidationError("master manifest hash does not match its canonical content");
  }
  return validated;
}

export function serializeLibraryObject(value: LibraryObject): string {
  return canonicalJson(validateLibraryObject(value));
}

export function serializeMasterManifest(value: MasterManifest): string {
  return canonicalJson(assertMasterManifestHash(value));
}

export function serializeScopeManifest(value: ScopeManifest): string {
  return canonicalJson(validateScopeManifest(value));
}

export function parseLibraryObject(text: string): LibraryObject {
  return parseCanonicalDocument(text, validateLibraryObject, serializeLibraryObject);
}

export function parseMasterManifest(text: string): MasterManifest {
  return parseCanonicalDocument(text, assertMasterManifestHash, serializeMasterManifest);
}

export function parseScopeManifest(text: string): ScopeManifest {
  return parseCanonicalDocument(text, validateScopeManifest, serializeScopeManifest);
}

function withoutManifestHash(manifest: MasterManifest): UnhashedMasterManifest {
  const {
    schemaVersion,
    revision,
    ingestionCursor,
    objects,
    tombstones,
  } = manifest;
  return { schemaVersion, revision, ingestionCursor, objects, tombstones };
}

function parseCanonicalDocument<T>(
  text: string,
  validate: (value: unknown) => T,
  serialize: (value: T) => string,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LibraryValidationError("document is not valid JSON");
  }
  const validated = validate(parsed);
  if (serialize(validated) !== text) {
    throw new LibraryValidationError("document is not canonically serialized");
  }
  return validated;
}

function toCanonicalJson(value: unknown): CanonicalJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new LibraryValidationError("canonical JSON cannot contain a non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).some((key) => !/^\d+$/.test(key))) {
      throw new LibraryValidationError("canonical JSON arrays cannot contain named properties");
    }
    return value.map((item) => toCanonicalJson(item));
  }
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new LibraryValidationError("canonical JSON requires plain objects");
    }
    const result: { [key: string]: CanonicalJson } = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) {
        throw new LibraryValidationError("canonical JSON cannot contain undefined values");
      }
      result[key] = toCanonicalJson(item);
    }
    return result;
  }
  throw new LibraryValidationError("value cannot be represented as canonical JSON");
}
