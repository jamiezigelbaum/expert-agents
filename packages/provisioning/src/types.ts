import type { RetrievalEvalSet } from "../../../scripts/retrieval-eval.ts";
import type { ScopeManifest } from "../../library/src/index.ts";

// The gateway's native value is "allowlist" (channels.telegram.dmPolicy).
// "owner-allowlist" is this repository's older private spelling of the same
// intent, kept valid so binding files written before 2026-07-28 still parse.
export const TELEGRAM_DM_POLICIES = ["allowlist", "owner-allowlist"] as const;
export type TelegramDmPolicy = (typeof TELEGRAM_DM_POLICIES)[number];

export const AGENT_REPO_SCHEMA_VERSION = 1 as const;
export const BINDING_SCHEMA_VERSION = 1 as const;
export const DERIVED_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const SOUL_CHARACTER_LIMIT = 20_000;

/** Raster formats an avatar may use. Anything else is refused at creation. */
export const AVATAR_EXTENSIONS = ["png", "jpg", "jpeg", "webp"] as const;
export type AvatarExtension = (typeof AVATAR_EXTENSIONS)[number];
/** An avatar is presentation, not payload, so a generous cap is still small. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** The factory always writes the avatar at the repository root under this stem. */
export const AVATAR_FILE_STEM = "avatar";

export const DERIVED_ARTIFACT_DIRECTORY = "derived";
export const DERIVED_ARTIFACT_MANIFEST_FILE = "artifact.json";
export const DERIVED_ARTIFACT_CONTENT_FILE = "content.md";

/** What a served deployment may retrieve from one library corpus. */
export type ServingDisclosure = "full" | "derived" | "excluded";

export interface AgentServingCorpus {
  corpusId: string;
  disclosure: ServingDisclosure;
}

export interface AgentServingSet {
  /**
   * Default-deny allowlist of repo-relative POSIX paths. An entry ending in
   * `/` is a directory prefix; any other entry is an exact file path.
   */
  include: string[];
  corpora?: AgentServingCorpus[];
}

export interface AgentManifest {
  schemaVersion: typeof AGENT_REPO_SCHEMA_VERSION;
  agentId: string;
  displayName: string;
  domainId: string;
  targetCorpusDisplayName: string;
  emoji?: string;
  /**
   * Optional repo-relative path to the agent's avatar image. Contract-file
   * class and public-safe: an avatar is presentation the agent shows to
   * whoever it talks to, so it is the one identity file expected to ship in a
   * serving artifact rather than to be held back.
   */
  avatar?: string;
  /**
   * Optional. Absence means the agent is not packageable, which keeps every
   * repository created before serving machinery valid and untouched.
   */
  serving?: AgentServingSet;
}

export type DerivedArtifactKind = "doctrine" | "distillation";

export interface DerivedArtifactProvenance {
  sourceCorpusId?: string;
  sourceObjectIds?: string[];
  note?: string;
}

export interface DerivedArtifactManifest {
  schemaVersion: typeof DERIVED_ARTIFACT_SCHEMA_VERSION;
  kind: DerivedArtifactKind;
  artifactId: string;
  /** Required for a distillation: the corpus it stands in for. */
  corpusId?: string;
  /** ISO-8601 UTC instant supplied by the caller; never read from the clock. */
  acceptedAt: string;
  acceptedBy: string;
  provenance: DerivedArtifactProvenance;
}

export interface DerivedArtifactLintFinding {
  ruleId: "derived.content_non_empty" | "derived.content_secret_pattern";
  severity: FindingSeverity;
}

export interface DerivedArtifactLintResult {
  valid: boolean;
  findings: DerivedArtifactLintFinding[];
}

export interface OpenClawBinding {
  agentId: string;
  workspacePath?: string;
}

export interface TelegramGroupTopic {
  topicId: number;
  note?: string;
}

export interface TelegramBinding {
  botUsername?: string;
  tokenFilePath: string;
  dmPolicy: TelegramDmPolicy;
  groupTopics?: TelegramGroupTopic[];
}

export interface AgentBindingManifest {
  schemaVersion: typeof BINDING_SCHEMA_VERSION;
  openclaw: OpenClawBinding;
  telegram?: TelegramBinding;
}

export interface BindingDescriptor {
  schemaVersion: 1;
  kind: "expert_binding_descriptor";
  agent: {
    agentId: string;
    displayName: string;
  };
  openclaw: OpenClawBinding;
  telegram?: TelegramBinding;
  routing: {
    domainId: string;
    targetCorpusDisplayName: string;
  };
}

export interface BindingArtifactReceipt {
  schemaVersion: 1;
  kind: "expert_binding_receipt";
  files: CreationReceiptFile[];
}

export interface BindingEmitResult {
  outputDir: string;
  descriptor: BindingDescriptor;
  checklist: string;
  receipt: BindingArtifactReceipt;
}

export type BindingIdentifier = "agentId" | "botUsername" | "tokenFilePath";

export interface BindingIdentifierStatus {
  identifier: BindingIdentifier;
  found: boolean;
}

export interface BindingVerificationReport {
  schemaVersion: 1;
  kind: "expert_binding_verification";
  method: "identifier_presence";
  networkAccess: false;
  valid: boolean;
  identifiers: BindingIdentifierStatus[];
}

/** Image bytes the caller already holds; the factory decides where they land. */
export interface ExpertScaffoldAvatar {
  extension: AvatarExtension;
  bytes: Uint8Array;
}

export interface ExpertScaffoldOptions {
  targetDir: string;
  agentId: string;
  displayName: string;
  domainId: string;
  targetCorpusDisplayName: string;
  emoji?: string;
  avatar?: ExpertScaffoldAvatar;
  telegramTokenFilePath?: string;
  /**
   * Where this deployment's agent escalates. Deployment configuration, not
   * agent identity, so it renders into `AGENTS.md` and never into `agent.json`
   * — no repository path is ever baked into the manifest schema.
   */
  issueTracker?: string;
}

/** Rendered when no escalation channel is supplied, so the gap stays visible. */
export const ISSUE_TRACKER_PLACEHOLDER = "<configure this deployment's escalation channel>";

export interface CreationReceiptFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface ExpertCreationReceipt {
  schemaVersion: 1;
  kind: "expert_creation_receipt";
  directories: string[];
  files: CreationReceiptFile[];
}

export interface ExpertScaffoldResult {
  targetDir: string;
  manifest: AgentManifest;
  binding: AgentBindingManifest;
  scopeManifest: ScopeManifest;
  evalSet: RetrievalEvalSet;
  receipt: ExpertCreationReceipt;
}

export type FindingSeverity = "warning" | "error";

export interface ContractFinding {
  file: string;
  ruleId: string;
  severity: FindingSeverity;
}

export interface ContractItemStatus {
  path: string;
  kind: "file" | "directory";
  present: boolean;
  parsed: boolean | null;
  valid: boolean;
}

export interface SoulLintFinding {
  ruleId: "soul.non_empty" | "soul.max_chars" | "soul.notify_footer" | "soul.secret_pattern";
  severity: FindingSeverity;
}

export interface SoulLintResult {
  valid: boolean;
  findings: SoulLintFinding[];
}

export interface ExpertStatusReport {
  schemaVersion: 1;
  kind: "expert_status";
  valid: boolean;
  git: ExpertGitStatus | null;
  items: ContractItemStatus[];
  findings: ContractFinding[];
}

export interface ExpertGitStatus {
  isRepo: boolean;
  hasUpstream: boolean;
  aheadCount: number;
  behindCount: number;
  dirtyTrackedCount: number;
  untrackedCount: number;
}

/**
 * Generated, never a copy of `agent.json`, so a future manifest field cannot
 * reach a customer by default.
 */
export interface ServingManifest {
  schemaVersion: 1;
  kind: "expert_serving_manifest";
  tag: string;
  agentId: string;
  displayName: string;
  domainId: string;
  targetCorpusDisplayName: string;
  emoji?: string;
  /** Named only when the serving set actually materialized the image. */
  avatar?: string;
  corpora: AgentServingCorpus[];
  /** Materialized repo-relative serving paths, sorted. */
  files: string[];
}

export interface ServingArtifactReceipt {
  schemaVersion: 1;
  kind: "expert_serving_receipt";
  files: CreationReceiptFile[];
}

export interface ServingPackageResult {
  outputRoot: string;
  manifest: ServingManifest;
  checklist: string;
  receipt: ServingArtifactReceipt;
}
