import { isAbsolute } from "node:path";
import { servingExclusionReason } from "./excluded-paths.ts";
import { containsHighConfidenceSecret } from "./secret-patterns.ts";
import {
  AGENT_REPO_SCHEMA_VERSION,
  AVATAR_EXTENSIONS,
  AVATAR_MAX_BYTES,
  BINDING_SCHEMA_VERSION,
  DERIVED_ARTIFACT_SCHEMA_VERSION,
  SOUL_CHARACTER_LIMIT,
  TELEGRAM_DM_POLICIES,
  type AgentBindingManifest,
  type AgentManifest,
  type AgentServingCorpus,
  type AgentServingSet,
  type AvatarExtension,
  type DerivedArtifactLintFinding,
  type DerivedArtifactLintResult,
  type DerivedArtifactManifest,
  type DerivedArtifactProvenance,
  type ServingDisclosure,
  type SoulLintFinding,
  type SoulLintResult,
  type TelegramDmPolicy,
  type TelegramGroupTopic,
} from "./types.ts";

const STABLE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const TELEGRAM_BOT_USERNAME_PATTERN = /^@[A-Za-z][A-Za-z0-9_]{1,28}bot$/i;
const UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SERVING_DISCLOSURES: readonly ServingDisclosure[] = ["full", "derived", "excluded"];
const ESCAPING_PATH_REFERENCE = /\.\.\/|\/\.\.(?:\/|$)|^[/~]|\\/;

export class AgentRepoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRepoValidationError";
  }
}

export function validateAgentManifest(value: unknown): AgentManifest {
  const record = requireRecord(value, "agent manifest");
  const required = [
    "schemaVersion",
    "agentId",
    "displayName",
    "domainId",
    "targetCorpusDisplayName",
  ];
  const allowed = new Set([...required, "emoji", "avatar", "serving"]);
  if (required.some((key) => !Object.hasOwn(record, key))) {
    throw new AgentRepoValidationError("agent manifest is missing a required field");
  }
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new AgentRepoValidationError("agent manifest contains an unknown field");
  }
  if (record.schemaVersion !== AGENT_REPO_SCHEMA_VERSION) {
    throw new AgentRepoValidationError("agent manifest schema version is unsupported");
  }

  const agentId = requireStableId(record.agentId, "agent manifest agent id");
  const domainId = requireStableId(record.domainId, "agent manifest domain id");
  const displayName = requireSingleLineString(record.displayName, "agent manifest display name");
  const targetCorpusDisplayName = requireSingleLineString(
    record.targetCorpusDisplayName,
    "agent manifest target corpus display name",
  );
  const emoji = record.emoji === undefined
    ? undefined
    : requireSingleLineString(record.emoji, "agent manifest emoji");
  const avatar = record.avatar === undefined ? undefined : requireAvatarPath(record.avatar);
  const serving = record.serving === undefined
    ? undefined
    : validateAgentServingSet(record.serving);

  return {
    schemaVersion: AGENT_REPO_SCHEMA_VERSION,
    agentId,
    displayName,
    domainId,
    targetCorpusDisplayName,
    ...(emoji === undefined ? {} : { emoji }),
    ...(avatar === undefined ? {} : { avatar }),
    ...(serving === undefined ? {} : { serving }),
  };
}

/**
 * An avatar is contract-file class and public-safe, so the only open question
 * is where it lives: inside the repository, naming a file rather than a
 * directory, and never in a path class that may not reach a served deployment.
 * The format and size gates belong to creation, not to the manifest, so a
 * repository whose avatar predates those rules stays valid.
 */
export function requireAvatarPath(value: unknown, name = "agent manifest avatar"): string {
  const path = requireSingleLineString(value, name);
  requireRelativePathShape(path, name);
  if (path.endsWith("/")) {
    throw new AgentRepoValidationError(`${name} must name a file, not a directory`);
  }
  if (servingExclusionReason(path) !== null) {
    throw new AgentRepoValidationError(
      `${name} names a path that may never reach a served deployment`,
    );
  }
  return path;
}

/** Accepts a bare extension or a leading-dot one, so `extname` output fits. */
export function requireAvatarExtension(value: unknown): AvatarExtension {
  const candidate = requireSingleLineString(value, "avatar image extension");
  const normalized = (candidate.startsWith(".") ? candidate.slice(1) : candidate).toLowerCase();
  const extension = AVATAR_EXTENSIONS.find((supported) => supported === normalized);
  if (extension === undefined) {
    throw new AgentRepoValidationError("avatar image format is unsupported");
  }
  return extension;
}

export function assertAvatarByteLength(byteLength: number): void {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new AgentRepoValidationError("avatar image is empty");
  }
  if (byteLength > AVATAR_MAX_BYTES) {
    throw new AgentRepoValidationError("avatar image exceeds the avatar size limit");
  }
}

/**
 * The declaration-time half of the structural gate. Packaging repeats the same
 * refusal after directory prefixes expand, which is where the real enforcement
 * happens.
 */
export function validateAgentServingSet(value: unknown): AgentServingSet {
  const record = requireRecord(value, "agent serving set");
  requireExactFields(record, ["include"], ["corpora"], "agent serving set");
  const include = validateServingInclude(record.include);
  if (record.corpora === undefined) return { include };
  return { include, corpora: validateServingCorpora(record.corpora) };
}

export function validateDerivedArtifactManifest(value: unknown): DerivedArtifactManifest {
  const record = requireRecord(value, "derived artifact manifest");
  requireExactFields(
    record,
    ["schemaVersion", "kind", "artifactId", "acceptedAt", "acceptedBy", "provenance"],
    ["corpusId"],
    "derived artifact manifest",
  );
  if (record.schemaVersion !== DERIVED_ARTIFACT_SCHEMA_VERSION) {
    throw new AgentRepoValidationError("derived artifact schema version is unsupported");
  }
  if (record.kind !== "doctrine" && record.kind !== "distillation") {
    throw new AgentRepoValidationError("derived artifact kind is invalid");
  }
  const artifactId = requireStableId(record.artifactId, "derived artifact id");
  const corpusId = record.corpusId === undefined
    ? undefined
    : requireStableId(record.corpusId, "derived artifact corpus id");
  if (record.kind === "distillation" && corpusId === undefined) {
    throw new AgentRepoValidationError("a distillation must name the corpus it stands in for");
  }
  const acceptedAt = requireUtcInstant(record.acceptedAt, "derived artifact acceptance instant");
  const acceptedBy = requireSingleLineString(record.acceptedBy, "derived artifact acceptor");
  const provenance = validateDerivedArtifactProvenance(record.provenance);
  assertNoEscapingPathReference(record);

  return {
    schemaVersion: DERIVED_ARTIFACT_SCHEMA_VERSION,
    kind: record.kind,
    artifactId,
    ...(corpusId === undefined ? {} : { corpusId }),
    acceptedAt,
    acceptedBy,
    provenance,
  };
}

export function lintDerivedArtifactContent(text: string): DerivedArtifactLintResult {
  const findings: DerivedArtifactLintFinding[] = [];
  if (text.trim().length === 0) {
    findings.push({ ruleId: "derived.content_non_empty", severity: "error" });
  }
  if (containsHighConfidenceSecret(text)) {
    findings.push({ ruleId: "derived.content_secret_pattern", severity: "error" });
  }
  return { valid: findings.length === 0, findings };
}

export function validateBindingManifest(value: unknown): AgentBindingManifest {
  const record = requireRecord(value, "binding manifest");
  requireExactFields(record, ["schemaVersion", "openclaw"], ["telegram"], "binding manifest");
  if (record.schemaVersion !== BINDING_SCHEMA_VERSION) {
    throw new AgentRepoValidationError("binding manifest schema version is unsupported");
  }

  const openclawRecord = requireRecord(record.openclaw, "OpenClaw binding");
  requireExactFields(openclawRecord, ["agentId"], ["workspacePath"], "OpenClaw binding");
  const openclaw = {
    agentId: requireStableId(openclawRecord.agentId, "OpenClaw binding agent id"),
    ...(openclawRecord.workspacePath === undefined
      ? {}
      : { workspacePath: requireSingleLineString(openclawRecord.workspacePath, "OpenClaw workspace path") }),
  };

  if (record.telegram === undefined) {
    return { schemaVersion: BINDING_SCHEMA_VERSION, openclaw };
  }
  const telegramRecord = requireRecord(record.telegram, "Telegram binding");
  requireExactFields(
    telegramRecord,
    ["tokenFilePath", "dmPolicy"],
    ["botUsername", "groupTopics"],
    "Telegram binding",
  );
  const tokenFilePath = requireSingleLineString(
    telegramRecord.tokenFilePath,
    "Telegram token file path",
  );
  // Live gateway convention uses home-relative references
  // (~/.openclaw/secrets/...), which are unambiguous for the applying
  // operator; accept those alongside absolute paths.
  if (!isAbsolute(tokenFilePath) && !tokenFilePath.startsWith("~/")) {
    throw new AgentRepoValidationError("Telegram token file path must be absolute or ~/-prefixed");
  }
  // "allowlist" is the native gateway value (channels.telegram.dmPolicy).
  // "owner-allowlist" is this repository's older private spelling of the same
  // intent, retained so binding files written before 2026-07-28 stay valid.
  if (!TELEGRAM_DM_POLICIES.includes(telegramRecord.dmPolicy as TelegramDmPolicy)) {
    throw new AgentRepoValidationError("Telegram DM policy must be allowlist or owner-allowlist");
  }
  const botUsername = telegramRecord.botUsername === undefined
    ? undefined
    : requireSingleLineString(telegramRecord.botUsername, "Telegram bot username");
  if (botUsername !== undefined && !TELEGRAM_BOT_USERNAME_PATTERN.test(botUsername)) {
    throw new AgentRepoValidationError("Telegram bot username is invalid");
  }
  const groupTopics = telegramRecord.groupTopics === undefined
    ? undefined
    : validateGroupTopics(telegramRecord.groupTopics);

  return {
    schemaVersion: BINDING_SCHEMA_VERSION,
    openclaw,
    telegram: {
      ...(botUsername === undefined ? {} : { botUsername }),
      tokenFilePath,
      dmPolicy: telegramRecord.dmPolicy as TelegramDmPolicy,
      ...(groupTopics === undefined ? {} : { groupTopics }),
    },
  };
}

export function lintSoul(text: string): SoulLintResult {
  const findings: SoulLintFinding[] = [];
  if (text.trim().length === 0) {
    findings.push({ ruleId: "soul.non_empty", severity: "warning" });
  }
  if (text.length > SOUL_CHARACTER_LIMIT) {
    findings.push({ ruleId: "soul.max_chars", severity: "warning" });
  }
  const lastNonEmptyLine = text.split(/\r?\n/).reverse().find((line) => line.trim().length > 0)?.trim();
  if (lastNonEmptyLine === undefined || !/^\*[^*\r\n]+\*$/.test(lastNonEmptyLine)) {
    findings.push({ ruleId: "soul.notify_footer", severity: "warning" });
  }
  if (containsHighConfidenceSecret(text)) {
    findings.push({ ruleId: "soul.secret_pattern", severity: "error" });
  }
  return {
    valid: !findings.some((finding) => finding.severity === "error"),
    findings,
  };
}

export function requireScaffoldOptions(value: {
  agentId: unknown;
  displayName: unknown;
  domainId: unknown;
  targetCorpusDisplayName: unknown;
  emoji?: unknown;
  avatar?: unknown;
}): Omit<AgentManifest, "schemaVersion"> {
  const manifest = validateAgentManifest({
    schemaVersion: AGENT_REPO_SCHEMA_VERSION,
    agentId: value.agentId,
    displayName: value.displayName,
    domainId: value.domainId,
    targetCorpusDisplayName: value.targetCorpusDisplayName,
    ...(value.emoji === undefined ? {} : { emoji: value.emoji }),
    ...(value.avatar === undefined ? {} : { avatar: value.avatar }),
  });
  for (const field of [manifest.displayName, manifest.targetCorpusDisplayName, manifest.emoji]) {
    if (field?.includes("{{") || field?.includes("}}")) {
      throw new AgentRepoValidationError("scaffold input contains template syntax");
    }
  }
  const { schemaVersion: _, ...options } = manifest;
  return options;
}

/** The escalation channel is free-form deployment text, but still one line. */
export function requireIssueTracker(value: unknown): string {
  const issueTracker = requireSingleLineString(value, "issue tracker");
  if (issueTracker.includes("{{") || issueTracker.includes("}}")) {
    throw new AgentRepoValidationError("scaffold input contains template syntax");
  }
  return issueTracker;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentRepoValidationError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactFields(
  record: Record<string, unknown>,
  required: string[],
  optional: string[],
  name: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(record, key))) {
    throw new AgentRepoValidationError(`${name} is missing a required field`);
  }
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new AgentRepoValidationError(`${name} contains an unknown field`);
  }
}

function validateGroupTopics(value: unknown): TelegramGroupTopic[] {
  if (!Array.isArray(value)) {
    throw new AgentRepoValidationError("Telegram group topics must be an array");
  }
  return value.map((item) => {
    const record = requireRecord(item, "Telegram group topic");
    requireExactFields(record, ["topicId"], ["note"], "Telegram group topic");
    if (typeof record.topicId !== "number" || !Number.isFinite(record.topicId)) {
      throw new AgentRepoValidationError("Telegram group topic id must be a number");
    }
    const note = record.note === undefined
      ? undefined
      : requireSingleLineString(record.note, "Telegram group topic note");
    return { topicId: record.topicId, ...(note === undefined ? {} : { note }) };
  });
}

function validateServingInclude(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AgentRepoValidationError("agent serving set include must be a non-empty array");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    const entry = requireSingleLineString(item, "agent serving set include entry");
    requireServingPathShape(entry);
    if (seen.has(entry)) {
      throw new AgentRepoValidationError("agent serving set include contains a duplicate entry");
    }
    seen.add(entry);
    const reason = servingExclusionReason(entry);
    if (reason === "structural") {
      throw new AgentRepoValidationError("agent serving set include names a structurally excluded path");
    }
    if (reason === "excluded_class") {
      throw new AgentRepoValidationError("agent serving set include names an excluded-class path");
    }
    return entry;
  });
}

function validateServingCorpora(value: unknown): AgentServingCorpus[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AgentRepoValidationError("agent serving set corpora must be a non-empty array");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    const record = requireRecord(item, "agent serving corpus");
    requireExactFields(record, ["corpusId", "disclosure"], [], "agent serving corpus");
    const corpusId = requireStableId(record.corpusId, "agent serving corpus id");
    if (seen.has(corpusId)) {
      throw new AgentRepoValidationError("agent serving set corpora contains a duplicate corpus id");
    }
    seen.add(corpusId);
    const disclosure = SERVING_DISCLOSURES.find((candidate) => candidate === record.disclosure);
    if (disclosure === undefined) {
      throw new AgentRepoValidationError("agent serving corpus disclosure is invalid");
    }
    return { corpusId, disclosure };
  });
}

function requireServingPathShape(entry: string): void {
  requireRelativePathShape(entry, "agent serving set include entry");
}

/** Repo-relative POSIX path, optionally `/`-terminated to mean a directory prefix. */
function requireRelativePathShape(entry: string, name: string): void {
  if (
    entry === "."
    || entry === "/"
    || entry.includes("\\")
    || isAbsolute(entry)
    || entry.startsWith("/")
    || entry.startsWith("~")
  ) {
    throw new AgentRepoValidationError(`${name} must be a repo-relative POSIX path`);
  }
  const body = entry.endsWith("/") ? entry.slice(0, -1) : entry;
  const segments = body.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new AgentRepoValidationError(`${name} must be a repo-relative POSIX path`);
  }
}

function validateDerivedArtifactProvenance(value: unknown): DerivedArtifactProvenance {
  const record = requireRecord(value, "derived artifact provenance");
  requireExactFields(
    record,
    [],
    ["sourceCorpusId", "sourceObjectIds", "note"],
    "derived artifact provenance",
  );
  const sourceCorpusId = record.sourceCorpusId === undefined
    ? undefined
    : requireStableId(record.sourceCorpusId, "derived artifact source corpus id");
  const sourceObjectIds = record.sourceObjectIds === undefined
    ? undefined
    : validateSourceObjectIds(record.sourceObjectIds);
  const note = record.note === undefined
    ? undefined
    : requireSingleLineString(record.note, "derived artifact provenance note");
  return {
    ...(sourceCorpusId === undefined ? {} : { sourceCorpusId }),
    ...(sourceObjectIds === undefined ? {} : { sourceObjectIds }),
    ...(note === undefined ? {} : { note }),
  };
}

function validateSourceObjectIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AgentRepoValidationError(
      "derived artifact source object ids must be a non-empty array",
    );
  }
  const seen = new Set<string>();
  return value.map((item) => {
    const id = requireSingleLineString(item, "derived artifact source object id");
    if (seen.has(id)) {
      throw new AgentRepoValidationError("derived artifact source object ids must be unique");
    }
    seen.add(id);
    return id;
  });
}

/**
 * A derived artifact describes itself and nothing outside its own directory, so
 * no string in its manifest may read as an escaping or absolute path reference.
 */
function assertNoEscapingPathReference(value: unknown): void {
  if (typeof value === "string") {
    if (ESCAPING_PATH_REFERENCE.test(value)) {
      throw new AgentRepoValidationError(
        "derived artifact manifest references a path outside its own directory",
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoEscapingPathReference(item);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) assertNoEscapingPathReference(item);
  }
}

function requireUtcInstant(value: unknown, name: string): string {
  const instant = requireSingleLineString(value, name);
  if (!UTC_INSTANT_PATTERN.test(instant) || Number.isNaN(Date.parse(instant))) {
    throw new AgentRepoValidationError(`${name} must be an ISO-8601 UTC instant`);
  }
  return instant;
}

function requireSingleLineString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /[\r\n]/.test(value)) {
    throw new AgentRepoValidationError(`${name} must be a non-empty trimmed single-line string`);
  }
  return value;
}

function requireStableId(value: unknown, name: string): string {
  const id = requireSingleLineString(value, name);
  if (!STABLE_ID_PATTERN.test(id)) {
    throw new AgentRepoValidationError(`${name} is invalid`);
  }
  return id;
}
