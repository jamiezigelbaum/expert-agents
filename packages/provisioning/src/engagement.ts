/**
 * Per-engagement storage and the engagement-learning gate.
 *
 * Three promises are made structural here rather than by instruction:
 *
 * 1. **Client content is held apart.** A store refuses to open unless its root
 *    is disjoint from both the agent repository and the shared library, and
 *    refuses to sit inside any git working tree, so client content has no path
 *    into an agent's source history.
 * 2. **Client content cannot leave.** Nothing exported from this module returns
 *    client content. The store writes it and deletes it; the only reader is
 *    private to this file and is used solely to refuse a draft that repeats it.
 *    A caller therefore has nothing to hand to a library object, and this module
 *    imports no library write path at all.
 * 3. **Learning returns only through the accepted derived-artifact contract.**
 *    `acceptEngagementLearning` writes a `doctrine` under `derived/<artifact-id>/`
 *    and nowhere else, and it only accepts a value minted by
 *    `extractEngagementLearning`, which is where the opt-out is enforced.
 *
 * Owner ruling 2026-07-28: **the opt-out is prospective only.** Opting out stops
 * extraction from that moment. There is deliberately no link from an accepted
 * generalization back to the engagement that produced it and no
 * rebuild-without-it path — `acceptEngagementLearning` takes no engagement
 * parameter, so the link cannot be recorded even by mistake. Reversing that
 * ruling is an architecture change, not a settings change.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";
import { containsHighConfidenceSecret } from "./secret-patterns.ts";
import {
  DERIVED_ARTIFACT_CONTENT_FILE,
  DERIVED_ARTIFACT_DIRECTORY,
  DERIVED_ARTIFACT_MANIFEST_FILE,
  DERIVED_ARTIFACT_SCHEMA_VERSION,
  type CreationReceiptFile,
} from "./types.ts";
import {
  lintDerivedArtifactContent,
  validateAgentManifest,
  validateDerivedArtifactManifest,
} from "./validation.ts";

export const ENGAGEMENT_SCHEMA_VERSION = 1 as const;
export const ENGAGEMENT_RECORD_FILE = "engagement.json";
export const ENGAGEMENT_RECORD_KIND = "expert_engagement_record";
export const ENGAGEMENT_CONTENT_DIRECTORY = "client-content";

/**
 * Engagement ids are opaque identifiers minted by the commercial layer. The
 * minimum length keeps the "a draft may not name its engagement" refusal from
 * degenerating into a substring match on a two-character token.
 */
export const ENGAGEMENT_ID_MIN_LENGTH = 8;

/**
 * Policy value: the longest run of characters a generalization may share
 * verbatim with client content before it stops being a generalization. It is
 * held here, not inline at the call site, because it is the kind of number a
 * legal opinion changes.
 */
export const LEARNING_VERBATIM_SPAN_LIMIT = 48;

/**
 * Engagement learning is always doctrine — how the agent works. It is never a
 * distillation, because a distillation stands in for held-back library sources
 * and client content is never a library source.
 */
export const LEARNING_ARTIFACT_KIND = "doctrine" as const;

const STABLE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const PRIVATE_DIRECTORY_MODE = 0o700;

export type EngagementErrorCode =
  | "invalid_engagement_input"
  | "storage_not_separate"
  | "storage_inside_git_repository"
  | "engagement_record_missing"
  | "engagement_record_invalid"
  | "engagement_identity_mismatch"
  | "engagement_closed"
  | "learning_opt_out"
  | "learning_draft_invalid"
  | "learning_draft_names_engagement"
  | "learning_draft_repeats_client_content"
  | "learning_not_sealed"
  | "store_not_authentic"
  | "agent_repository_invalid"
  | "learning_artifact_exists";

/** Typed and content-free: never echoes client content, an item id, or a path. */
export class EngagementError extends Error {
  readonly code: EngagementErrorCode;

  constructor(code: EngagementErrorCode, message: string) {
    super(message);
    this.name = "EngagementError";
    this.code = code;
  }
}

export interface EngagementRecord {
  schemaVersion: typeof ENGAGEMENT_SCHEMA_VERSION;
  kind: typeof ENGAGEMENT_RECORD_KIND;
  engagementId: string;
  agentId: string;
  /** Caller-supplied ISO-8601 UTC instant; this module never reads the clock. */
  openedAt: string;
  /** Learning is on by default; the commercial layer presents the choice. */
  learningOptOut: boolean;
  /** When the prospective opt-out was set. Recorded, never acted on backwards. */
  optOutAt?: string;
  closedAt?: string;
}

export interface EngagementContentReceipt {
  /** The caller's own opaque item id. Never a path and never content. */
  itemId: string;
  bytes: number;
}

export interface EngagementDeletionReceipt {
  schemaVersion: 1;
  kind: "expert_engagement_deletion_receipt";
  engagementId: string;
  closedAt: string;
  removedItemCount: number;
  removedByteCount: number;
  /** Zero on success: proof the store holds no client content afterwards. */
  contentRemaining: number;
}

export interface EngagementLearningDraft {
  /** The generalization, written by the extracting owner or agent session. */
  text: string;
  /** Optional provenance note. It may not name the engagement either. */
  note?: string;
}

/**
 * A draft that passed the extraction gate. Minted only by
 * `extractEngagementLearning` and carries no engagement identity, so accepted
 * learning has nothing pointing back at its source engagement.
 */
export interface SealedEngagementLearning {
  readonly text: string;
  readonly note?: string;
}

export interface EngagementLearningAcceptance {
  agentDirectory: string;
  learning: SealedEngagementLearning;
  artifactId: string;
  /** Caller-supplied ISO-8601 UTC instant; this module never reads the clock. */
  acceptedAt: string;
  acceptedBy: string;
}

export interface EngagementLearningReceipt {
  schemaVersion: 1;
  kind: "expert_learning_acceptance_receipt";
  artifactId: string;
  artifactKind: typeof LEARNING_ARTIFACT_KIND;
  acceptedAt: string;
  acceptedBy: string;
  /** Repo-relative paths only. */
  files: CreationReceiptFile[];
}

/**
 * Per-engagement storage. The surface is deliberately write-and-delete: there
 * is no operation that returns client content, so no caller can carry it into a
 * library object or a committed artifact.
 */
export interface EngagementStore {
  readonly engagementId: string;
  readonly agentId: string;
  writeClientContent(itemId: string, content: string | Uint8Array): Promise<EngagementContentReceipt>;
  /** Metadata only — ids, instants, and the opt-out flag. */
  readRecord(): Promise<EngagementRecord>;
  /** Prospective and one-way here: opting back in is a new engagement. */
  recordLearningOptOut(optOutAt: string): Promise<EngagementRecord>;
  /** Engagement end: deletes every stored item of client content. */
  closeEngagement(closedAt: string): Promise<EngagementDeletionReceipt>;
}

export interface OpenEngagementStoreOptions {
  /** Per-engagement storage root, disjoint from the repository and the library. */
  engagementRoot: string;
  agentDirectory: string;
  libraryDirectory: string;
  /** Required when no record exists yet; checked for agreement when one does. */
  engagementId?: string;
  agentId?: string;
  openedAt?: string;
  /** Learning is on by default (owner ruling); the mart presents the choice. */
  learningOptOut?: boolean;
}

interface EngagementStoreInternals {
  root: string;
  contentDirectory: string;
  recordPath: string;
}

/**
 * Authenticity registries. Membership cannot be forged from outside this module,
 * so a hand-rolled object shaped like a store, or a hand-rolled "sealed" draft,
 * is refused rather than trusted.
 */
const STORE_INTERNALS = new WeakMap<EngagementStore, EngagementStoreInternals>();
const SEALED_LEARNING = new WeakSet<SealedEngagementLearning>();

/**
 * Opens per-engagement storage, refusing any layout that would let client
 * content reach the agent repository, the shared library, or a git history.
 */
export async function openEngagementStore(
  options: OpenEngagementStoreOptions,
): Promise<EngagementStore> {
  const root = resolve(options.engagementRoot);
  const agentDirectory = resolve(options.agentDirectory);
  const libraryDirectory = resolve(options.libraryDirectory);
  assertDisjoint(root, agentDirectory, "the agent repository");
  assertDisjoint(root, libraryDirectory, "the shared library");
  await assertOutsideGitWorkingTree(root);

  const recordPath = join(root, ENGAGEMENT_RECORD_FILE);
  const contentDirectory = join(root, ENGAGEMENT_CONTENT_DIRECTORY);
  await mkdir(root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await mkdir(contentDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });

  const existing = await readRecordFile(recordPath);
  const record = existing === undefined
    ? await writeRecordFile(recordPath, openingRecord(options))
    : reconcileRecord(existing, options);

  const store: EngagementStore = {
    engagementId: record.engagementId,
    agentId: record.agentId,
    async writeClientContent(itemId, content) {
      await requireOpenRecord(recordPath);
      const path = resolveContentItem(contentDirectory, itemId);
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      await writeFile(path, bytes, { mode: 0o600 });
      // The receipt reports the caller's own id and a byte count. It never
      // carries the content, a digest of it, or the path it landed on.
      return { itemId, bytes: bytes.byteLength };
    },
    async readRecord() {
      return requireRecord(recordPath);
    },
    async recordLearningOptOut(optOutAt) {
      const current = await requireRecord(recordPath);
      const instant = requireUtcInstant(optOutAt, "the opt-out instant");
      if (current.learningOptOut) return current;
      return writeRecordFile(recordPath, { ...current, learningOptOut: true, optOutAt: instant });
    },
    async closeEngagement(closedAt) {
      const current = await requireOpenRecord(recordPath);
      const instant = requireUtcInstant(closedAt, "the closing instant");
      const removed = await measureContent(contentDirectory);
      await rm(contentDirectory, { recursive: true, force: true });
      const remaining = await measureContent(contentDirectory);
      await writeRecordFile(recordPath, { ...current, closedAt: instant });
      return {
        schemaVersion: 1,
        kind: "expert_engagement_deletion_receipt",
        engagementId: current.engagementId,
        closedAt: instant,
        removedItemCount: removed.itemCount,
        removedByteCount: removed.byteCount,
        contentRemaining: remaining.itemCount,
      };
    },
  };
  STORE_INTERNALS.set(store, { root, contentDirectory, recordPath });
  return store;
}

/**
 * The extraction point, and the only place the opt-out is enforced. A user
 * interface that presents the choice without this refusal is not an opt-out.
 *
 * Client content is read here and nowhere else: it is compared against the draft
 * and discarded. It is never returned, logged, or reported.
 */
export async function extractEngagementLearning(
  store: EngagementStore,
  draft: EngagementLearningDraft,
): Promise<SealedEngagementLearning> {
  const internals = STORE_INTERNALS.get(store);
  if (internals === undefined) {
    throw new EngagementError(
      "store_not_authentic",
      "extraction requires per-engagement storage opened by this machinery",
    );
  }
  const record = await requireRecord(internals.recordPath);
  if (record.learningOptOut) {
    throw new EngagementError(
      "learning_opt_out",
      "this engagement has opted out of learning; extraction is refused",
    );
  }
  if (record.closedAt !== undefined) {
    throw new EngagementError(
      "engagement_closed",
      "the engagement is closed; extraction is refused",
    );
  }

  const text = requireDraftText(draft.text, "the learning draft");
  const note = draft.note === undefined
    ? undefined
    : requireDraftText(draft.note, "the learning draft note");
  for (const field of [text, note]) {
    if (field !== undefined && field.toLowerCase().includes(record.engagementId.toLowerCase())) {
      throw new EngagementError(
        "learning_draft_names_engagement",
        "accepted learning carries no link back to an engagement; the draft names one",
      );
    }
  }
  await assertDraftRepeatsNoClientContent(internals.contentDirectory, [text, note]);

  const sealed: SealedEngagementLearning = Object.freeze({
    text,
    ...(note === undefined ? {} : { note }),
  });
  SEALED_LEARNING.add(sealed);
  return sealed;
}

/**
 * The acceptance gate, reusing the existing derived-artifact contract rather
 * than inventing a second one. Nothing here is automatic: the caller supplies
 * the acceptance instant and the accepting human, and the artifact lands as a
 * reviewed commit in the agent repository like any other derived artifact.
 *
 * Note what this signature does not take: an engagement, a store, or a source
 * identifier. Prospective-only opt-out means the link is not merely unwritten,
 * it is unavailable.
 */
export async function acceptEngagementLearning(
  acceptance: EngagementLearningAcceptance,
): Promise<EngagementLearningReceipt> {
  if (!SEALED_LEARNING.has(acceptance.learning)) {
    throw new EngagementError(
      "learning_not_sealed",
      "only learning sealed at the extraction gate may be accepted",
    );
  }
  const agentDirectory = resolve(acceptance.agentDirectory);
  await assertAgentRepository(agentDirectory);

  const artifactId = requireStableId(acceptance.artifactId, "the artifact id");
  const manifest = validateDerivedArtifactManifest({
    schemaVersion: DERIVED_ARTIFACT_SCHEMA_VERSION,
    kind: LEARNING_ARTIFACT_KIND,
    artifactId,
    acceptedAt: requireUtcInstant(acceptance.acceptedAt, "the acceptance instant"),
    acceptedBy: requireSingleLineString(acceptance.acceptedBy, "the accepting reviewer"),
    provenance: acceptance.learning.note === undefined ? {} : { note: acceptance.learning.note },
  });
  const content = `${acceptance.learning.text}\n`;
  if (!lintDerivedArtifactContent(content).valid) {
    throw new EngagementError(
      "learning_draft_invalid",
      "the sealed learning does not satisfy the derived-artifact content contract",
    );
  }

  const relativeDirectory = `${DERIVED_ARTIFACT_DIRECTORY}/${artifactId}`;
  const directory = join(agentDirectory, DERIVED_ARTIFACT_DIRECTORY, artifactId);
  await mkdir(join(agentDirectory, DERIVED_ARTIFACT_DIRECTORY), { recursive: true });
  try {
    await mkdir(directory);
  } catch {
    throw new EngagementError(
      "learning_artifact_exists",
      "an accepted artifact already occupies that artifact id",
    );
  }
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(directory, DERIVED_ARTIFACT_MANIFEST_FILE), manifestText, {
    encoding: "utf8",
    flag: "wx",
  });
  await writeFile(join(directory, DERIVED_ARTIFACT_CONTENT_FILE), content, {
    encoding: "utf8",
    flag: "wx",
  });

  return {
    schemaVersion: 1,
    kind: "expert_learning_acceptance_receipt",
    artifactId,
    artifactKind: LEARNING_ARTIFACT_KIND,
    acceptedAt: manifest.acceptedAt,
    acceptedBy: manifest.acceptedBy,
    files: [
      receiptEntry(`${relativeDirectory}/${DERIVED_ARTIFACT_MANIFEST_FILE}`, manifestText),
      receiptEntry(`${relativeDirectory}/${DERIVED_ARTIFACT_CONTENT_FILE}`, content),
    ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
  };
}

/**
 * True when a path is inside per-engagement storage. Callers that write into
 * the shared library use this to refuse a client-held source, which is the
 * library-side half of the same structural rule.
 */
export async function isEngagementHeldPath(path: string): Promise<boolean> {
  let directory = resolve(path);
  const stop = parse(directory).root;
  for (;;) {
    if (await holdsEngagementRecord(directory)) return true;
    if (directory === stop) return false;
    directory = resolve(directory, "..");
  }
}

/**
 * A lenient marker probe rather than a validation: this walks arbitrary
 * ancestor directories, so an unrelated file that happens to share the name
 * must answer "no" instead of failing a caller's unrelated command.
 */
async function holdsEngagementRecord(directory: string): Promise<boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(directory, ENGAGEMENT_RECORD_FILE), "utf8"));
  } catch {
    return false;
  }
  return typeof parsed === "object"
    && parsed !== null
    && (parsed as Record<string, unknown>).kind === ENGAGEMENT_RECORD_KIND;
}

function openingRecord(options: OpenEngagementStoreOptions): EngagementRecord {
  if (options.engagementId === undefined || options.agentId === undefined || options.openedAt === undefined) {
    throw new EngagementError(
      "engagement_record_missing",
      "opening new per-engagement storage requires an engagement id, an agent id, and an opening instant",
    );
  }
  return {
    schemaVersion: ENGAGEMENT_SCHEMA_VERSION,
    kind: ENGAGEMENT_RECORD_KIND,
    engagementId: requireEngagementId(options.engagementId),
    agentId: requireStableId(options.agentId, "the agent id"),
    openedAt: requireUtcInstant(options.openedAt, "the opening instant"),
    learningOptOut: options.learningOptOut === true,
  };
}

/**
 * One storage root serves exactly one engagement, so two clients hiring the same
 * expert can never be pointed at shared state by a caller's mistake.
 */
function reconcileRecord(
  record: EngagementRecord,
  options: OpenEngagementStoreOptions,
): EngagementRecord {
  const mismatched = (options.engagementId !== undefined && options.engagementId !== record.engagementId)
    || (options.agentId !== undefined && options.agentId !== record.agentId);
  if (mismatched) {
    throw new EngagementError(
      "engagement_identity_mismatch",
      "this storage root already belongs to a different engagement",
    );
  }
  return record;
}

/**
 * Refuses containment in either direction. Storage inside the repository or the
 * library would put client content one `git add` away from a commit; storage
 * that contains either would put the repository one deletion away from the
 * engagement-end wipe.
 */
function assertDisjoint(root: string, other: string, description: string): void {
  const contained = root === other
    || root.startsWith(`${other}${sep}`)
    || other.startsWith(`${root}${sep}`);
  if (contained) {
    throw new EngagementError(
      "storage_not_separate",
      `per-engagement storage must be separate from ${description}`,
    );
  }
}

/** Client content is never committed, so its storage may not sit in a work tree. */
async function assertOutsideGitWorkingTree(root: string): Promise<void> {
  let directory = root;
  const stop = parse(directory).root;
  for (;;) {
    if (await pathExists(join(directory, ".git"))) {
      throw new EngagementError(
        "storage_inside_git_repository",
        "per-engagement storage must not sit inside a git working tree",
      );
    }
    if (directory === stop) return;
    directory = resolve(directory, "..");
  }
}

async function assertAgentRepository(agentDirectory: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(join(agentDirectory, "agent.json"), "utf8");
  } catch {
    throw new EngagementError(
      "agent_repository_invalid",
      "accepted learning lands in an agent repository; none was found",
    );
  }
  try {
    validateAgentManifest(JSON.parse(text));
  } catch {
    throw new EngagementError(
      "agent_repository_invalid",
      "the target directory does not hold a valid agent manifest",
    );
  }
}

/**
 * Reads client content, compares it to the draft, and discards it. The only
 * value that escapes this function is the refusal.
 */
async function assertDraftRepeatsNoClientContent(
  contentDirectory: string,
  fields: Array<string | undefined>,
): Promise<void> {
  // Index the small side (the draft) and stream the large side (the content),
  // so the cost stays linear in the stored bytes however long an engagement ran.
  const windowsBySpan = new Map<number, Set<string>>();
  for (const field of fields) {
    if (field === undefined) continue;
    const normalized = normalizeForComparison(field);
    const span = Math.min(LEARNING_VERBATIM_SPAN_LIMIT, normalized.length);
    if (span === 0) continue;
    const windows = windowsBySpan.get(span) ?? new Set<string>();
    for (let index = 0; index + span <= normalized.length; index += 1) {
      windows.add(normalized.slice(index, index + span));
    }
    windowsBySpan.set(span, windows);
  }
  if (windowsBySpan.size === 0) return;

  for (const path of await listContentFiles(contentDirectory)) {
    const stored = normalizeForComparison(new TextDecoder().decode(await readFile(path)));
    for (const [span, windows] of windowsBySpan) {
      for (let index = 0; index + span <= stored.length; index += 1) {
        if (!windows.has(stored.slice(index, index + span))) continue;
        throw new EngagementError(
          "learning_draft_repeats_client_content",
          "the draft repeats client content verbatim; retained learning is generalization only",
        );
      }
    }
  }
}

function normalizeForComparison(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, " ").trim();
}

async function listContentFiles(contentDirectory: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(contentDirectory);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort()) {
    const path = join(contentDirectory, entry);
    const item = await stat(path);
    if (item.isFile()) files.push(path);
  }
  return files;
}

async function measureContent(
  contentDirectory: string,
): Promise<{ itemCount: number; byteCount: number }> {
  let itemCount = 0;
  let byteCount = 0;
  for (const path of await listContentFiles(contentDirectory)) {
    itemCount += 1;
    byteCount += (await stat(path)).size;
  }
  return { itemCount, byteCount };
}

function resolveContentItem(contentDirectory: string, itemId: string): string {
  const id = requireStableId(itemId, "the content item id");
  const path = resolve(contentDirectory, id);
  if (path !== join(contentDirectory, id)) {
    throw new EngagementError(
      "invalid_engagement_input",
      "a client content item must be a single opaque identifier",
    );
  }
  return path;
}

async function readRecordFile(recordPath: string): Promise<EngagementRecord | undefined> {
  let text: string;
  try {
    text = await readFile(recordPath, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EngagementError("engagement_record_invalid", "the engagement record is not valid JSON");
  }
  return validateEngagementRecord(parsed);
}

async function writeRecordFile(
  recordPath: string,
  record: EngagementRecord,
): Promise<EngagementRecord> {
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return record;
}

async function requireRecord(recordPath: string): Promise<EngagementRecord> {
  const record = await readRecordFile(recordPath);
  if (record === undefined) {
    throw new EngagementError("engagement_record_missing", "the engagement record is absent");
  }
  return record;
}

async function requireOpenRecord(recordPath: string): Promise<EngagementRecord> {
  const record = await requireRecord(recordPath);
  if (record.closedAt !== undefined) {
    throw new EngagementError("engagement_closed", "the engagement is closed");
  }
  return record;
}

export function validateEngagementRecord(value: unknown): EngagementRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngagementError("engagement_record_invalid", "the engagement record must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "kind",
    "engagementId",
    "agentId",
    "openedAt",
    "learningOptOut",
    "optOutAt",
    "closedAt",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new EngagementError("engagement_record_invalid", "the engagement record has an unknown field");
  }
  if (record.schemaVersion !== ENGAGEMENT_SCHEMA_VERSION || record.kind !== ENGAGEMENT_RECORD_KIND) {
    throw new EngagementError("engagement_record_invalid", "the engagement record is not a supported record");
  }
  if (typeof record.learningOptOut !== "boolean") {
    throw new EngagementError("engagement_record_invalid", "the learning opt-out flag must be a boolean");
  }
  return {
    schemaVersion: ENGAGEMENT_SCHEMA_VERSION,
    kind: ENGAGEMENT_RECORD_KIND,
    engagementId: requireEngagementId(record.engagementId),
    agentId: requireStableId(record.agentId, "the agent id"),
    openedAt: requireUtcInstant(record.openedAt, "the opening instant"),
    learningOptOut: record.learningOptOut,
    ...(record.optOutAt === undefined
      ? {}
      : { optOutAt: requireUtcInstant(record.optOutAt, "the opt-out instant") }),
    ...(record.closedAt === undefined
      ? {}
      : { closedAt: requireUtcInstant(record.closedAt, "the closing instant") }),
  };
}

function receiptEntry(path: string, text: string): CreationReceiptFile {
  const bytes = new TextEncoder().encode(text);
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

function requireDraftText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EngagementError("learning_draft_invalid", `${name} must be non-empty text`);
  }
  const text = value.trim();
  if (containsHighConfidenceSecret(text)) {
    throw new EngagementError(
      "learning_draft_invalid",
      `${name} contains a high-confidence secret pattern`,
    );
  }
  return text;
}

function requireEngagementId(value: unknown): string {
  const id = requireStableId(value, "the engagement id");
  if (id.length < ENGAGEMENT_ID_MIN_LENGTH) {
    throw new EngagementError(
      "invalid_engagement_input",
      `the engagement id must be at least ${ENGAGEMENT_ID_MIN_LENGTH} characters`,
    );
  }
  return id;
}

function requireStableId(value: unknown, name: string): string {
  const id = requireSingleLineString(value, name);
  if (!STABLE_ID_PATTERN.test(id)) {
    throw new EngagementError("invalid_engagement_input", `${name} is invalid`);
  }
  return id;
}

function requireUtcInstant(value: unknown, name: string): string {
  const instant = requireSingleLineString(value, name);
  if (!UTC_INSTANT_PATTERN.test(instant) || Number.isNaN(Date.parse(instant))) {
    throw new EngagementError("invalid_engagement_input", `${name} must be an ISO-8601 UTC instant`);
  }
  return instant;
}

function requireSingleLineString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /[\r\n]/.test(value)) {
    throw new EngagementError(
      "invalid_engagement_input",
      `${name} must be a non-empty trimmed single-line string`,
    );
  }
  return value;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
