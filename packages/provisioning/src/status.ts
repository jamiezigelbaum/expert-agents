import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateScopeManifest, type ScopeManifest } from "../../library/src/index.ts";
import { parseRetrievalEvalSet, type RetrievalEvalSet } from "../../../scripts/retrieval-eval.ts";
import {
  DERIVED_ARTIFACT_CONTENT_FILE,
  DERIVED_ARTIFACT_DIRECTORY,
  DERIVED_ARTIFACT_MANIFEST_FILE,
  type AgentManifest,
  type AgentServingSet,
  type ContractFinding,
  type ContractItemStatus,
  type DerivedArtifactManifest,
  type ExpertGitStatus,
  type ExpertStatusReport,
  type FindingSeverity,
} from "./types.ts";
import {
  lintDerivedArtifactContent,
  lintSoul,
  validateAgentManifest,
  validateBindingManifest,
  validateDerivedArtifactManifest,
} from "./validation.ts";

export interface StatusFileSystem {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
}

const nodeFileSystem: StatusFileSystem = { readdir, readFile, stat };
const WORKSPACE_FILES = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "TOOLS.md", "USER.md", "HEARTBEAT.md"];

export interface ExpertStatusDependencies {
  fs?: StatusFileSystem;
  gitPath?: string | null;
}

export async function expertStatus(
  directory: string,
  dependencies: ExpertStatusDependencies = {},
): Promise<ExpertStatusReport> {
  const fs = dependencies.fs ?? nodeFileSystem;
  const root = resolve(directory);
  const items: ContractItemStatus[] = [];
  const findings: ContractFinding[] = [];

  const agentText = await inspectFile(root, "agent.json", fs, items, findings, true);
  const scopeText = await inspectFile(
    root,
    "library/scope-manifest.json",
    fs,
    items,
    findings,
    true,
  );
  const evalText = await inspectFile(
    root,
    "library/eval-questions.json",
    fs,
    items,
    findings,
    true,
  );
  const bindingText = await inspectOptionalFile(root, "binding.json", fs, items, findings);
  for (const path of WORKSPACE_FILES) {
    const text = await inspectFile(root, path, fs, items, findings, false);
    if (path === "SOUL.md" && text !== undefined) {
      for (const finding of lintSoul(text).findings) {
        findings.push({ file: path, ruleId: finding.ruleId, severity: finding.severity });
      }
    }
  }
  await inspectDirectory(root, "references", fs, items, findings);

  const agent = parseValidated(
    agentText,
    "agent.json",
    "agent_json",
    validateAgentManifest,
    items,
    findings,
  );
  const scope = parseValidated(
    scopeText,
    "library/scope-manifest.json",
    "scope",
    validateScopeManifest,
    items,
    findings,
  );
  const evalSet = parseEval(evalText, items, findings);
  const binding = parseValidated(
    bindingText,
    "binding.json",
    "binding",
    validateBindingManifest,
    items,
    findings,
  );
  if (agent !== undefined && scope !== undefined) {
    addConsistencyFinding(
      agent.agentId === scope.agentId,
      "agent.json",
      "consistency.agent_id",
      findings,
    );
    addConsistencyFinding(
      agent.targetCorpusDisplayName === scope.targetCorpusDisplayName,
      "agent.json",
      "consistency.target_corpus",
      findings,
    );
  }
  if (agent !== undefined && evalSet !== undefined) {
    addConsistencyFinding(
      agent.domainId === evalSet.domainId,
      "agent.json",
      "consistency.domain_id",
      findings,
    );
  }
  if (agent !== undefined && binding !== undefined) {
    addConsistencyFinding(
      agent.agentId === binding.openclaw.agentId,
      "binding.json",
      "consistency.agent_id",
      findings,
    );
  }

  const derivedArtifacts = await inspectDerivedArtifacts(root, fs, findings);
  if (agent?.serving !== undefined) {
    await inspectServingSet(root, agent.serving, derivedArtifacts, fs, findings);
  }

  const gitPath = dependencies.gitPath === undefined ? Bun.which("git") : dependencies.gitPath;
  const git = gitPath === null ? null : await inspectGit(root, gitPath);
  if (git !== null) {
    if (git.behindCount > 0) {
      findings.push({ file: "repository", ruleId: "repo.sync.behind", severity: "warning" });
    }
    if (git.dirtyTrackedCount > 0) {
      findings.push({ file: "repository", ruleId: "repo.sync.dirty", severity: "warning" });
    }
    if (git.isRepo && !git.hasUpstream) {
      findings.push({ file: "repository", ruleId: "repo.sync.no-upstream", severity: "warning" });
    }
  }

  items.sort((left, right) => compareStrings(left.path, right.path));
  findings.sort((left, right) => compareStrings(
    `${left.file}\0${left.ruleId}\0${left.severity}`,
    `${right.file}\0${right.ruleId}\0${right.severity}`,
  ));
  return {
    schemaVersion: 1,
    kind: "expert_status",
    valid: !findings.some((finding) => finding.severity === "error"),
    git,
    items,
    findings,
  };
}

/**
 * Serving findings are warnings and stay content-free: they name `agent.json`
 * and a rule id, never the absent path or the corpus that lacks an artifact.
 */
async function inspectServingSet(
  root: string,
  serving: AgentServingSet,
  derivedArtifacts: DerivedArtifactManifest[],
  fs: StatusFileSystem,
  findings: ContractFinding[],
): Promise<void> {
  for (const entry of serving.include) {
    const isDirectoryPrefix = entry.endsWith("/");
    const path = isDirectoryPrefix ? entry.slice(0, -1) : entry;
    let present = false;
    try {
      const target = await fs.stat(join(root, path));
      present = isDirectoryPrefix ? target.isDirectory() : target.isFile();
    } catch {
      present = false;
    }
    if (!present) {
      addFindingOnce(findings, "agent.json", "agent.serving.missing_path", "warning");
      break;
    }
  }
  const distilled = new Set(
    derivedArtifacts
      .filter((artifact) => artifact.kind === "distillation")
      .map((artifact) => artifact.corpusId),
  );
  const missing = (serving.corpora ?? []).some(
    (corpus) => corpus.disclosure === "derived" && !distilled.has(corpus.corpusId),
  );
  if (missing) {
    addFindingOnce(findings, "agent.json", "agent.serving.derived_without_artifact", "warning");
  }
}

/**
 * Reads `derived/<artifact-id>/` from the working tree. Findings name the
 * `derived` directory and a rule id only, never an artifact or corpus id.
 */
async function inspectDerivedArtifacts(
  root: string,
  fs: StatusFileSystem,
  findings: ContractFinding[],
): Promise<DerivedArtifactManifest[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(join(root, DERIVED_ARTIFACT_DIRECTORY));
  } catch {
    return [];
  }
  const artifacts: DerivedArtifactManifest[] = [];
  for (const artifactId of [...entries].sort(compareStrings)) {
    const directory = join(root, DERIVED_ARTIFACT_DIRECTORY, artifactId);
    let manifestText: string;
    let contentText: string;
    try {
      if (!(await fs.stat(directory)).isDirectory()) continue;
      manifestText = await fs.readFile(join(directory, DERIVED_ARTIFACT_MANIFEST_FILE), "utf8");
      contentText = await fs.readFile(join(directory, DERIVED_ARTIFACT_CONTENT_FILE), "utf8");
    } catch {
      addFindingOnce(findings, DERIVED_ARTIFACT_DIRECTORY, "derived.artifact.required", "error");
      continue;
    }
    let manifest: DerivedArtifactManifest;
    try {
      manifest = validateDerivedArtifactManifest(JSON.parse(manifestText));
      if (manifest.artifactId !== artifactId) throw new Error("artifact id must equal its directory");
    } catch {
      addFindingOnce(findings, DERIVED_ARTIFACT_DIRECTORY, "derived.artifact.schema", "error");
      continue;
    }
    const lint = lintDerivedArtifactContent(contentText);
    for (const finding of lint.findings) {
      addFindingOnce(findings, DERIVED_ARTIFACT_DIRECTORY, finding.ruleId, finding.severity);
    }
    if (lint.valid) artifacts.push(manifest);
  }
  return artifacts;
}

function addFindingOnce(
  findings: ContractFinding[],
  file: string,
  ruleId: string,
  severity: FindingSeverity,
): void {
  const present = findings.some(
    (finding) => finding.file === file && finding.ruleId === ruleId && finding.severity === severity,
  );
  if (!present) findings.push({ file, ruleId, severity });
}

async function inspectGit(root: string, gitPath: string): Promise<ExpertGitStatus> {
  const notRepo: ExpertGitStatus = {
    isRepo: false,
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    dirtyTrackedCount: 0,
    untrackedCount: 0,
  };
  const repository = await runGit(gitPath, root, ["rev-parse", "--is-inside-work-tree"]);
  if (repository.exitCode !== 0 || repository.stdout.trim() !== "true") return notRepo;

  const upstream = await runGit(gitPath, root, ["rev-parse", "--verify", "--quiet", "@{upstream}"]);
  const hasUpstream = upstream.exitCode === 0;
  let aheadCount = 0;
  let behindCount = 0;
  if (hasUpstream) {
    const divergence = await runGit(gitPath, root, [
      "rev-list",
      "--left-right",
      "--count",
      "HEAD...@{upstream}",
    ]);
    const counts = divergence.stdout.trim().match(/^(\d+)\s+(\d+)$/);
    if (divergence.exitCode === 0 && counts !== null) {
      aheadCount = Number.parseInt(counts[1]!, 10);
      behindCount = Number.parseInt(counts[2]!, 10);
    }
  }

  const worktree = await runGit(gitPath, root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  let dirtyTrackedCount = 0;
  let untrackedCount = 0;
  if (worktree.exitCode === 0) {
    for (const line of worktree.stdout.split("\n")) {
      if (line.length === 0) continue;
      if (line.startsWith("??")) untrackedCount += 1;
      else dirtyTrackedCount += 1;
    }
  }

  return {
    isRepo: true,
    hasUpstream,
    aheadCount,
    behindCount,
    dirtyTrackedCount,
    untrackedCount,
  };
}

async function runGit(
  gitPath: string,
  root: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string }> {
  const process = Bun.spawn([gitPath, "-C", root, ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [exitCode, stdout] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
  ]);
  return { exitCode, stdout };
}

async function inspectOptionalFile(
  root: string,
  path: string,
  fs: StatusFileSystem,
  items: ContractItemStatus[],
  findings: ContractFinding[],
): Promise<string | undefined> {
  try {
    await fs.stat(join(root, path));
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
  }
  return inspectFile(root, path, fs, items, findings, true);
}

async function inspectFile(
  root: string,
  path: string,
  fs: StatusFileSystem,
  items: ContractItemStatus[],
  findings: ContractFinding[],
  parsed: boolean,
): Promise<string | undefined> {
  try {
    const file = await fs.stat(join(root, path));
    if (!file.isFile()) {
      items.push({ path, kind: "file", present: true, parsed: parsed ? false : null, valid: false });
      findings.push({ file: path, ruleId: "contract.file_type", severity: "error" });
      return undefined;
    }
    const text = await fs.readFile(join(root, path), "utf8");
    if (text.trim().length === 0) {
      items.push({ path, kind: "file", present: true, parsed: parsed ? false : null, valid: false });
      findings.push({ file: path, ruleId: "contract.non_empty", severity: "error" });
      return text;
    }
    items.push({ path, kind: "file", present: true, parsed: parsed ? false : null, valid: !parsed });
    return text;
  } catch {
    items.push({ path, kind: "file", present: false, parsed: parsed ? false : null, valid: false });
    findings.push({ file: path, ruleId: "contract.required", severity: "error" });
    return undefined;
  }
}

async function inspectDirectory(
  root: string,
  path: string,
  fs: StatusFileSystem,
  items: ContractItemStatus[],
  findings: ContractFinding[],
): Promise<void> {
  try {
    const directory = await fs.stat(join(root, path));
    const valid = directory.isDirectory();
    items.push({ path, kind: "directory", present: true, parsed: null, valid });
    if (!valid) findings.push({ file: path, ruleId: "contract.directory_type", severity: "error" });
  } catch {
    items.push({ path, kind: "directory", present: false, parsed: null, valid: false });
    findings.push({ file: path, ruleId: "contract.required", severity: "error" });
  }
}

function parseValidated<T>(
  text: string | undefined,
  path: string,
  rulePrefix: string,
  validate: (value: unknown) => T,
  items: ContractItemStatus[],
  findings: ContractFinding[],
): T | undefined {
  if (text === undefined || text.trim().length === 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    markParsedItem(path, false, items);
    findings.push({ file: path, ruleId: `${rulePrefix}.parse`, severity: "error" });
    return undefined;
  }
  try {
    const result = validate(value);
    markParsedItem(path, true, items);
    return result;
  } catch {
    markParsedItem(path, false, items);
    findings.push({ file: path, ruleId: `${rulePrefix}.schema`, severity: "error" });
    return undefined;
  }
}

function parseEval(
  text: string | undefined,
  items: ContractItemStatus[],
  findings: ContractFinding[],
): RetrievalEvalSet | undefined {
  if (text === undefined || text.trim().length === 0) return undefined;
  try {
    const evalSet = parseRetrievalEvalSet(text);
    markParsedItem("library/eval-questions.json", true, items);
    return evalSet;
  } catch {
    markParsedItem("library/eval-questions.json", false, items);
    findings.push({
      file: "library/eval-questions.json",
      ruleId: "eval.schema",
      severity: "error",
    });
    return undefined;
  }
}

function markParsedItem(path: string, valid: boolean, items: ContractItemStatus[]): void {
  const item = items.find((candidate) => candidate.path === path);
  if (item !== undefined) {
    item.parsed = valid;
    item.valid = valid;
  }
}

function addConsistencyFinding(
  consistent: boolean,
  file: string,
  ruleId: string,
  findings: ContractFinding[],
): void {
  if (!consistent) findings.push({ file, ruleId, severity: "error" });
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
