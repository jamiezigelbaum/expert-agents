import {
  LIBRARY_SCHEMA_VERSION,
  SCOPE_SCHEMA_VERSION,
  type LibraryLocationConfig,
  type LibraryObject,
  type LibraryProvenance,
  type ManifestTombstone,
  type MasterManifest,
  type ScopeIncludeFilters,
  type ScopeManifest,
  type Sha256Id,
  type VersionLineage,
} from "./types.ts";

const SHA256_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const AGENT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9._-]{1,221}[a-z0-9]$/;

export class LibraryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryValidationError";
  }
}

// Vertex RAG refuses to import GCS objects whose names lack a file
// extension, so canonical paths carry one derived from the media type.
const MEDIA_TYPE_EXTENSIONS: Record<string, string> = {
  "application/epub+zip": "epub",
  "application/json": "json",
  "application/pdf": "pdf",
  "text/html": "html",
  "text/markdown": "md",
  "text/plain": "txt",
};

export function extensionForMediaType(mediaType: string): string {
  return MEDIA_TYPE_EXTENSIONS[mediaType] ?? "bin";
}

export function canonicalObjectRelativePath(id: Sha256Id, mediaType: string): string {
  const validatedId = requireSha256Id(id, "object id");
  const hex = validatedId.slice("sha256:".length);
  return `objects/sha256/${hex.slice(0, 2)}/${hex}.${extensionForMediaType(mediaType)}`;
}

export function validateLibraryLocationConfig(value: unknown): LibraryLocationConfig {
  const record = requireRecord(value, "library location config");
  requireExactKeys(record, ["bucket", "prefix"], "library location config");
  const bucket = requireNonEmptyString(record.bucket, "library location config bucket");
  const prefix = requireNonEmptyString(record.prefix, "library location config prefix");
  if (!BUCKET_PATTERN.test(bucket)) {
    throw new LibraryValidationError("library location config bucket is invalid");
  }
  if (prefix.startsWith("/") || prefix.endsWith("/") || prefix.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new LibraryValidationError("library location config prefix is invalid");
  }
  return { bucket, prefix };
}

export function libraryObjectUri(config: LibraryLocationConfig, id: Sha256Id, mediaType: string): string {
  const validated = validateLibraryLocationConfig(config);
  return `gs://${validated.bucket}/${validated.prefix}/${canonicalObjectRelativePath(id, mediaType)}`;
}

export function validateLibraryObject(value: unknown): LibraryObject {
  const record = requireRecord(value, "library object");
  requireExactKeysWithOptional(record, [
    "id",
    "sourceLocators",
    "mediaType",
    "derivativeKind",
    "byteSize",
    "provenance",
    "trustTier",
    "copyrightPosture",
    "lineage",
    "createdAt",
    "updatedAt",
    "relativePath",
  ], ["title", "creator"], "library object");

  const id = requireSha256Id(record.id, "library object id");
  const title = record.title === undefined
    ? undefined
    : requireNonEmptyString(record.title, "library object title");
  const creator = record.creator === undefined
    ? undefined
    : requireNonEmptyString(record.creator, "library object creator");
  const sourceLocators = requireSortedUniqueStrings(record.sourceLocators, "library object source locators", true);
  const mediaType = requireNonEmptyString(record.mediaType, "library object media type");
  const derivativeKind = record.derivativeKind === null
    ? null
    : requireNonEmptyString(record.derivativeKind, "library object derivative kind");
  const byteSize = requireNonNegativeInteger(record.byteSize, "library object byte size");
  const provenance = validateProvenance(record.provenance);
  const trustTier = requireNonEmptyString(record.trustTier, "library object trust tier");
  const copyrightPosture = requireNonEmptyString(record.copyrightPosture, "library object copyright posture");
  const lineage = validateLineage(record.lineage, id);
  const createdAt = requireCanonicalTimestamp(record.createdAt, "library object created timestamp");
  const updatedAt = requireCanonicalTimestamp(record.updatedAt, "library object updated timestamp");
  if (updatedAt < createdAt) {
    throw new LibraryValidationError("library object updated timestamp precedes created timestamp");
  }
  const relativePath = requireNonEmptyString(record.relativePath, "library object relative path");
  if (relativePath !== canonicalObjectRelativePath(id, mediaType)) {
    throw new LibraryValidationError("library object relative path does not match its id and media type");
  }

  return {
    id,
    ...(title === undefined ? {} : { title }),
    ...(creator === undefined ? {} : { creator }),
    sourceLocators,
    mediaType,
    derivativeKind,
    byteSize,
    provenance,
    trustTier,
    copyrightPosture,
    lineage,
    createdAt,
    updatedAt,
    relativePath,
  };
}

export function validateMasterManifest(value: unknown): MasterManifest {
  const record = requireRecord(value, "master manifest");
  requireExactKeys(record, [
    "schemaVersion",
    "revision",
    "ingestionCursor",
    "objects",
    "tombstones",
    "manifestHash",
  ], "master manifest");
  if (record.schemaVersion !== LIBRARY_SCHEMA_VERSION) {
    throw new LibraryValidationError("master manifest schema version is unsupported");
  }
  const revision = requireNonNegativeInteger(record.revision, "master manifest revision");
  const ingestionCursor = record.ingestionCursor === null
    ? null
    : requireNonEmptyString(record.ingestionCursor, "master manifest ingestion cursor");
  const objects = requireArray(record.objects, "master manifest objects").map(validateLibraryObject);
  requireSortedUniqueBy(objects, (object) => object.id, "master manifest objects");
  const tombstones = requireArray(record.tombstones, "master manifest tombstones").map((item) => validateTombstone(item, revision));
  requireSortedUniqueBy(tombstones, (tombstone) => tombstone.objectId, "master manifest tombstones");
  const liveIds = new Set(objects.map((object) => object.id));
  if (tombstones.some((tombstone) => liveIds.has(tombstone.objectId))) {
    throw new LibraryValidationError("master manifest contains both a live object and tombstone for an id");
  }
  const manifestHash = requireSha256Id(record.manifestHash, "master manifest hash");

  return {
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    revision,
    ingestionCursor,
    objects,
    tombstones,
    manifestHash,
  };
}

export function validateScopeManifest(value: unknown): ScopeManifest {
  const record = requireRecord(value, "scope manifest");
  requireExactKeys(record, ["agentId", "schemaVersion", "selection", "targetCorpusDisplayName", "masterRevision"], "scope manifest");
  const agentId = requireNonEmptyString(record.agentId, "scope manifest agent id");
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new LibraryValidationError("scope manifest agent id is invalid");
  }
  if (record.schemaVersion !== SCOPE_SCHEMA_VERSION) {
    throw new LibraryValidationError("scope manifest schema version is unsupported");
  }
  const selectionRecord = requireRecord(record.selection, "scope manifest selection");
  requireExactKeys(selectionRecord, ["objectIds", "includeFilters"], "scope manifest selection", true);
  const objectIds = requireSortedUniqueSha256Ids(selectionRecord.objectIds, "scope manifest object ids");
  const includeFilters = selectionRecord.includeFilters === undefined
    ? undefined
    : validateIncludeFilters(selectionRecord.includeFilters);
  const targetCorpusDisplayName = requireNonEmptyString(record.targetCorpusDisplayName, "scope manifest target corpus display name");
  const masterRevision = requireNonNegativeInteger(record.masterRevision, "scope manifest master revision");

  return {
    agentId,
    schemaVersion: SCOPE_SCHEMA_VERSION,
    selection: includeFilters === undefined ? { objectIds } : { objectIds, includeFilters },
    targetCorpusDisplayName,
    masterRevision,
  };
}

function validateProvenance(value: unknown): LibraryProvenance {
  const record = requireRecord(value, "library object provenance");
  requireExactKeys(record, ["acquiredBy", "acquiredAt", "acquisitionMethod"], "library object provenance");
  return {
    acquiredBy: requireNonEmptyString(record.acquiredBy, "library object provenance actor"),
    acquiredAt: requireCanonicalTimestamp(record.acquiredAt, "library object provenance timestamp"),
    acquisitionMethod: requireNonEmptyString(record.acquisitionMethod, "library object provenance method"),
  };
}

function validateLineage(value: unknown, id: Sha256Id): VersionLineage {
  const record = requireRecord(value, "library object lineage");
  requireExactKeys(record, ["supersedes", "supersededBy"], "library object lineage");
  const supersedes = requireSortedUniqueSha256Ids(record.supersedes, "library object supersedes ids");
  const supersededBy = requireSortedUniqueSha256Ids(record.supersededBy, "library object superseded-by ids");
  if (supersedes.includes(id) || supersededBy.includes(id)) {
    throw new LibraryValidationError("library object lineage contains its own id");
  }
  const supersededBySet = new Set(supersededBy);
  if (supersedes.some((candidate) => supersededBySet.has(candidate))) {
    throw new LibraryValidationError("library object lineage contains a contradictory id");
  }
  return { supersedes, supersededBy };
}

function validateTombstone(value: unknown, manifestRevision: number): ManifestTombstone {
  const record = requireRecord(value, "manifest tombstone");
  requireExactKeys(record, ["objectId", "revision", "reason"], "manifest tombstone");
  const revision = requirePositiveInteger(record.revision, "manifest tombstone revision");
  if (revision > manifestRevision) {
    throw new LibraryValidationError("manifest tombstone revision exceeds manifest revision");
  }
  return {
    objectId: requireSha256Id(record.objectId, "manifest tombstone object id"),
    revision,
    reason: requireNonEmptyString(record.reason, "manifest tombstone reason"),
  };
}

function validateIncludeFilters(value: unknown): ScopeIncludeFilters {
  const record = requireRecord(value, "scope manifest include filters");
  requireExactKeys(record, ["trustTiers", "kinds", "locatorPrefixes"], "scope manifest include filters", true);
  const filters: ScopeIncludeFilters = {};
  if (record.trustTiers !== undefined) {
    filters.trustTiers = requireSortedUniqueStrings(record.trustTiers, "scope manifest trust tiers", true);
  }
  if (record.kinds !== undefined) {
    filters.kinds = requireSortedUniqueStrings(record.kinds, "scope manifest kinds", true);
  }
  if (record.locatorPrefixes !== undefined) {
    filters.locatorPrefixes = requireSortedUniqueStrings(record.locatorPrefixes, "scope manifest locator prefixes", true);
  }
  if (Object.keys(filters).length === 0) {
    throw new LibraryValidationError("scope manifest include filters are empty");
  }
  return filters;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LibraryValidationError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, allowed: string[], name: string, optionalAllowed = false): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedSet.has(key))) {
    throw new LibraryValidationError(`${name} contains an unknown field`);
  }
  if (!optionalAllowed && allowed.some((key) => !(key in record))) {
    throw new LibraryValidationError(`${name} is missing a required field`);
  }
  if (optionalAllowed) {
    const required = name === "scope manifest selection" ? ["objectIds"] : [];
    if (required.some((key) => !(key in record))) {
      throw new LibraryValidationError(`${name} is missing a required field`);
    }
  }
}

function requireExactKeysWithOptional(
  record: Record<string, unknown>,
  required: string[],
  optional: string[],
  name: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new LibraryValidationError(`${name} contains an unknown field`);
  }
  if (required.some((key) => !(key in record))) {
    throw new LibraryValidationError(`${name} is missing a required field`);
  }
}

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new LibraryValidationError(`${name} must be an array`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new LibraryValidationError(`${name} must be a non-empty trimmed string`);
  }
  return value;
}

function requireSha256Id(value: unknown, name: string): Sha256Id {
  if (typeof value !== "string" || !SHA256_ID_PATTERN.test(value)) {
    throw new LibraryValidationError(`${name} must be a lowercase sha256 id`);
  }
  return value as Sha256Id;
}

function requireCanonicalTimestamp(value: unknown, name: string): string {
  const timestamp = requireNonEmptyString(value, name);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new LibraryValidationError(`${name} must be a canonical UTC timestamp`);
  }
  return timestamp;
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new LibraryValidationError(`${name} must be a non-negative integer`);
  }
  return value as number;
}

function requirePositiveInteger(value: unknown, name: string): number {
  const integer = requireNonNegativeInteger(value, name);
  if (integer === 0) {
    throw new LibraryValidationError(`${name} must be positive`);
  }
  return integer;
}

function requireSortedUniqueStrings(value: unknown, name: string, nonEmpty = false): string[] {
  const values = requireArray(value, name).map((item) => requireNonEmptyString(item, `${name} entry`));
  if (nonEmpty && values.length === 0) {
    throw new LibraryValidationError(`${name} must not be empty`);
  }
  requireSortedUniqueBy(values, (item) => item, name);
  return values;
}

function requireSortedUniqueSha256Ids(value: unknown, name: string): Sha256Id[] {
  const values = requireArray(value, name).map((item) => requireSha256Id(item, `${name} entry`));
  requireSortedUniqueBy(values, (item) => item, name);
  return values;
}

function requireSortedUniqueBy<T>(values: T[], key: (value: T) => string, name: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (key(values[index - 1]!) >= key(values[index]!)) {
      throw new LibraryValidationError(`${name} must be sorted and unique`);
    }
  }
}
