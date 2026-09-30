import { assertMasterManifestHash, finalizeMasterManifest } from "./serialization.ts";
import type { LibraryObject, MasterManifest, Sha256Id } from "./types.ts";
import { validateLibraryObject } from "./validation.ts";

export interface SupersedeOperation {
  objectId: Sha256Id;
  replacementObjectId: Sha256Id;
  updatedAt: string;
}

export interface TombstoneOperation {
  objectId: Sha256Id;
  reason: string;
}

export interface AnnotateOperation {
  objectId: Sha256Id;
  title?: string;
  creator?: string;
  updatedAt: string;
}

export interface CursorAdvance {
  from: string | null;
  to: string;
}

export interface ManifestUpdate {
  expectedRevision: number;
  addObjects?: LibraryObject[];
  supersede?: SupersedeOperation[];
  annotate?: AnnotateOperation[];
  tombstone?: TombstoneOperation[];
  advanceCursor?: CursorAdvance;
}

export class ManifestUpdateError extends Error {
  constructor(
    public readonly code:
      | "revision_conflict"
      | "cursor_conflict"
      | "invalid_update"
      | "duplicate_id"
      | "tombstone_conflict"
      | "supersede_conflict"
      | "supersede_cycle"
      | "annotation_conflict",
    message: string,
  ) {
    super(message);
    this.name = "ManifestUpdateError";
  }
}

export function applyManifestUpdate(current: MasterManifest, update: ManifestUpdate): MasterManifest {
  const manifest = assertMasterManifestHash(current);
  const parsedUpdate = validateUpdate(update);
  if (parsedUpdate.expectedRevision !== manifest.revision) {
    throw new ManifestUpdateError(
      "revision_conflict",
      `revision conflict: expected ${parsedUpdate.expectedRevision}, current ${manifest.revision}`,
    );
  }
  if (parsedUpdate.advanceCursor !== undefined && parsedUpdate.advanceCursor.from !== manifest.ingestionCursor) {
    throw new ManifestUpdateError("cursor_conflict", "ingestion cursor compare-and-set conflict");
  }

  const nextRevision = manifest.revision + 1;
  const objects = new Map(manifest.objects.map((object) => [object.id, cloneObject(object)]));
  const tombstones = new Map(manifest.tombstones.map((tombstone) => [tombstone.objectId, { ...tombstone }]));
  const addIds = new Set<Sha256Id>();
  const tombstoneIds = new Set(parsedUpdate.tombstone.map((operation) => operation.objectId));

  for (const object of parsedUpdate.addObjects) {
    if (addIds.has(object.id) || objects.has(object.id)) {
      throw new ManifestUpdateError("duplicate_id", `duplicate add for object id ${object.id}`);
    }
    if (tombstones.has(object.id) || tombstoneIds.has(object.id)) {
      throw new ManifestUpdateError("tombstone_conflict", `object id ${object.id} cannot be added after tombstoning`);
    }
    addIds.add(object.id);
    objects.set(object.id, cloneObject(object));
  }

  const supersedePairs = new Set<string>();
  for (const operation of parsedUpdate.supersede) {
    const pair = `${operation.objectId}->${operation.replacementObjectId}`;
    if (supersedePairs.has(pair)) {
      throw new ManifestUpdateError("supersede_conflict", `duplicate supersede pair ${pair}`);
    }
    supersedePairs.add(pair);
    if (operation.objectId === operation.replacementObjectId) {
      throw new ManifestUpdateError("supersede_cycle", `supersede cycle contains object id ${operation.objectId}`);
    }
    const prior = objects.get(operation.objectId);
    const replacement = objects.get(operation.replacementObjectId);
    if (prior === undefined || replacement === undefined) {
      throw new ManifestUpdateError(
        "supersede_conflict",
        `supersede pair references unavailable ids ${operation.objectId}, ${operation.replacementObjectId}`,
      );
    }
    if (tombstoneIds.has(operation.replacementObjectId)) {
      throw new ManifestUpdateError(
        "tombstone_conflict",
        `supersede replacement id ${operation.replacementObjectId} is tombstoned in the update`,
      );
    }
    prior.lineage.supersededBy = sortedUnique([...prior.lineage.supersededBy, replacement.id]);
    prior.updatedAt = operation.updatedAt;
    replacement.lineage.supersedes = sortedUnique([...replacement.lineage.supersedes, prior.id]);
    replacement.updatedAt = operation.updatedAt;
  }

  assertNoSupersedeCycles(objects);

  const annotatedIds = new Set<Sha256Id>();
  for (const operation of parsedUpdate.annotate) {
    if (annotatedIds.has(operation.objectId)) {
      throw new ManifestUpdateError("annotation_conflict", `duplicate annotation for object id ${operation.objectId}`);
    }
    annotatedIds.add(operation.objectId);
    if (tombstones.has(operation.objectId) || tombstoneIds.has(operation.objectId)) {
      throw new ManifestUpdateError("annotation_conflict", `annotation references tombstoned object id ${operation.objectId}`);
    }
    const object = objects.get(operation.objectId);
    if (object === undefined) {
      throw new ManifestUpdateError("annotation_conflict", `annotation references unknown object id ${operation.objectId}`);
    }
    if (operation.title !== undefined) object.title = operation.title;
    if (operation.creator !== undefined) object.creator = operation.creator;
    object.updatedAt = operation.updatedAt;
  }

  for (const object of objects.values()) validateLibraryObject(object);

  for (const operation of parsedUpdate.tombstone) {
    if (tombstones.has(operation.objectId)) {
      throw new ManifestUpdateError("tombstone_conflict", `object id ${operation.objectId} is already tombstoned`);
    }
    if (!objects.delete(operation.objectId)) {
      throw new ManifestUpdateError("tombstone_conflict", `object id ${operation.objectId} is not live`);
    }
    tombstones.set(operation.objectId, {
      objectId: operation.objectId,
      revision: nextRevision,
      reason: operation.reason,
    });
  }

  return finalizeMasterManifest({
    schemaVersion: manifest.schemaVersion,
    revision: nextRevision,
    ingestionCursor: parsedUpdate.advanceCursor?.to ?? manifest.ingestionCursor,
    objects: [...objects.values()].sort((left, right) => compareStrings(left.id, right.id)),
    tombstones: [...tombstones.values()].sort((left, right) => compareStrings(left.objectId, right.objectId)),
  });
}

function validateUpdate(value: unknown): Required<Pick<ManifestUpdate, "expectedRevision" | "addObjects" | "supersede" | "annotate" | "tombstone">> & Pick<ManifestUpdate, "advanceCursor"> {
  const record = asRecord(value, "manifest update");
  const allowed = new Set(["expectedRevision", "addObjects", "supersede", "annotate", "tombstone", "advanceCursor"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new ManifestUpdateError("invalid_update", "manifest update contains an unknown field");
  }
  if (!Number.isSafeInteger(record.expectedRevision) || (record.expectedRevision as number) < 0) {
    throw new ManifestUpdateError("invalid_update", "manifest update expected revision must be a non-negative integer");
  }
  const addObjects = optionalArray(record.addObjects, "add objects").map((object) => validateLibraryObject(object));
  const supersede = optionalArray(record.supersede, "supersede operations").map(validateSupersedeOperation);
  const annotate = optionalArray(record.annotate, "annotate operations").map(validateAnnotateOperation);
  const tombstone = optionalArray(record.tombstone, "tombstone operations").map(validateTombstoneOperation);
  const advanceCursor = record.advanceCursor === undefined ? undefined : validateCursorAdvance(record.advanceCursor);
  if (addObjects.length + supersede.length + annotate.length + tombstone.length === 0 && advanceCursor === undefined) {
    throw new ManifestUpdateError("invalid_update", "manifest update contains no operations");
  }
  return {
    expectedRevision: record.expectedRevision as number,
    addObjects,
    supersede,
    annotate,
    tombstone,
    ...(advanceCursor === undefined ? {} : { advanceCursor }),
  };
}

function validateAnnotateOperation(value: unknown): AnnotateOperation {
  const record = asRecord(value, "annotate operation");
  const allowed = new Set(["objectId", "title", "creator", "updatedAt"]);
  if (!("objectId" in record) || !("updatedAt" in record) || Object.keys(record).some((key) => !allowed.has(key))) {
    throw new ManifestUpdateError("invalid_update", "annotate operation fields are invalid");
  }
  const title = record.title === undefined ? undefined : requireString(record.title, "annotation title");
  const creator = record.creator === undefined ? undefined : requireString(record.creator, "annotation creator");
  if (title === undefined && creator === undefined) {
    throw new ManifestUpdateError("invalid_update", "annotate operation requires a title or creator");
  }
  return {
    objectId: requireSha256Id(record.objectId, "annotation object id"),
    ...(title === undefined ? {} : { title }),
    ...(creator === undefined ? {} : { creator }),
    updatedAt: requireString(record.updatedAt, "annotation updated timestamp"),
  };
}

function validateSupersedeOperation(value: unknown): SupersedeOperation {
  const record = asRecord(value, "supersede operation");
  requireKeys(record, ["objectId", "replacementObjectId", "updatedAt"], "supersede operation");
  const objectId = requireSha256Id(record.objectId, "supersede object id");
  const replacementObjectId = requireSha256Id(record.replacementObjectId, "supersede replacement id");
  const updatedAt = requireString(record.updatedAt, "supersede updated timestamp");
  return { objectId, replacementObjectId, updatedAt };
}

function validateTombstoneOperation(value: unknown): TombstoneOperation {
  const record = asRecord(value, "tombstone operation");
  requireKeys(record, ["objectId", "reason"], "tombstone operation");
  return {
    objectId: requireSha256Id(record.objectId, "tombstone object id"),
    reason: requireString(record.reason, "tombstone reason"),
  };
}

function validateCursorAdvance(value: unknown): CursorAdvance {
  const record = asRecord(value, "cursor advance");
  requireKeys(record, ["from", "to"], "cursor advance");
  if (record.from !== null && typeof record.from !== "string") {
    throw new ManifestUpdateError("invalid_update", "cursor advance source must be a string or null");
  }
  return {
    from: record.from as string | null,
    to: requireString(record.to, "cursor advance target"),
  };
}

function assertNoSupersedeCycles(objects: Map<Sha256Id, LibraryObject>): void {
  const visiting = new Set<Sha256Id>();
  const visited = new Set<Sha256Id>();
  const visit = (id: Sha256Id): void => {
    if (visiting.has(id)) {
      throw new ManifestUpdateError("supersede_cycle", `supersede cycle contains object id ${id}`);
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const object = objects.get(id);
    for (const priorId of object?.lineage.supersedes ?? []) {
      if (objects.has(priorId)) visit(priorId);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of [...objects.keys()].sort()) visit(id);
}

function cloneObject(object: LibraryObject): LibraryObject {
  return {
    ...object,
    sourceLocators: [...object.sourceLocators],
    provenance: { ...object.provenance },
    lineage: {
      supersedes: [...object.lineage.supersedes],
      supersededBy: [...object.lineage.supersededBy],
    },
  };
}

function sortedUnique(values: Sha256Id[]): Sha256Id[] {
  return [...new Set(values)].sort();
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManifestUpdateError("invalid_update", `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireKeys(record: Record<string, unknown>, keys: string[], name: string): void {
  const allowed = new Set(keys);
  if (keys.some((key) => !(key in record)) || Object.keys(record).some((key) => !allowed.has(key))) {
    throw new ManifestUpdateError("invalid_update", `${name} fields are invalid`);
  }
}

function optionalArray(value: unknown, name: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ManifestUpdateError("invalid_update", `${name} must be an array`);
  }
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new ManifestUpdateError("invalid_update", `${name} must be a non-empty trimmed string`);
  }
  return value;
}

function requireSha256Id(value: unknown, name: string): Sha256Id {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new ManifestUpdateError("invalid_update", `${name} must be a lowercase sha256 id`);
  }
  return value as Sha256Id;
}
