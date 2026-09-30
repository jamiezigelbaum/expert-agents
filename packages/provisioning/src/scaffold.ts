import { createHash } from "node:crypto";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SCOPE_SCHEMA_VERSION, canonicalJson, type ScopeManifest } from "../../library/src/index.ts";
import type { RetrievalEvalSet } from "../../../scripts/retrieval-eval.ts";
import agentsTemplate from "../templates/AGENTS.md" with { type: "text" };
import heartbeatTemplate from "../templates/HEARTBEAT.md" with { type: "text" };
import identityTemplate from "../templates/IDENTITY.md" with { type: "text" };
import soulTemplate from "../templates/SOUL.md" with { type: "text" };
import toolsTemplate from "../templates/TOOLS.md" with { type: "text" };
import userTemplate from "../templates/USER.md" with { type: "text" };
import { AGENT_REPO_GITIGNORE } from "./excluded-paths.ts";
import {
  AGENT_REPO_SCHEMA_VERSION,
  AVATAR_FILE_STEM,
  BINDING_SCHEMA_VERSION,
  ISSUE_TRACKER_PLACEHOLDER,
  type AgentBindingManifest,
  type AgentManifest,
  type ExpertCreationReceipt,
  type ExpertScaffoldOptions,
  type ExpertScaffoldResult,
} from "./types.ts";
import {
  assertAvatarByteLength,
  requireAvatarExtension,
  requireIssueTracker,
  requireScaffoldOptions,
  validateBindingManifest,
} from "./validation.ts";

export interface ScaffoldFileSystem {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  writeFile(path: string, data: string | Uint8Array): Promise<unknown>;
}

const nodeFileSystem: ScaffoldFileSystem = { mkdir, readdir, stat, writeFile };

const MARKDOWN_TEMPLATES: ReadonlyArray<[string, string]> = [
  ["AGENTS.md", agentsTemplate],
  ["HEARTBEAT.md", heartbeatTemplate],
  ["IDENTITY.md", identityTemplate],
  ["SOUL.md", soulTemplate],
  ["TOOLS.md", toolsTemplate],
  ["USER.md", userTemplate],
];

export async function scaffoldExpert(
  options: ExpertScaffoldOptions,
  dependencies: { fs?: ScaffoldFileSystem } = {},
): Promise<ExpertScaffoldResult> {
  const fs = dependencies.fs ?? nodeFileSystem;
  const targetDir = resolve(options.targetDir);
  // The factory chooses the avatar's path rather than accepting one, so the
  // image always lands beside the manifest that names it.
  const avatarPath = options.avatar === undefined
    ? undefined
    : `${AVATAR_FILE_STEM}.${requireAvatarExtension(options.avatar.extension)}`;
  if (options.avatar !== undefined) assertAvatarByteLength(options.avatar.bytes.byteLength);
  const validated = requireScaffoldOptions({
    ...options,
    ...(avatarPath === undefined ? {} : { avatar: avatarPath }),
  });
  await assertEmptyTarget(targetDir, fs);

  const manifest: AgentManifest = {
    schemaVersion: AGENT_REPO_SCHEMA_VERSION,
    ...validated,
  };
  const binding: AgentBindingManifest = validateBindingManifest({
    schemaVersion: BINDING_SCHEMA_VERSION,
    openclaw: { agentId: manifest.agentId },
    ...(options.telegramTokenFilePath === undefined
      ? {}
      : {
          telegram: {
            tokenFilePath: options.telegramTokenFilePath,
            dmPolicy: "owner-allowlist",
          },
        }),
  });
  const scopeManifest: ScopeManifest = {
    agentId: manifest.agentId,
    schemaVersion: SCOPE_SCHEMA_VERSION,
    selection: { objectIds: [] },
    targetCorpusDisplayName: manifest.targetCorpusDisplayName,
    masterRevision: 0,
  };
  const evalSet: RetrievalEvalSet = {
    schemaVersion: 1,
    domainId: manifest.domainId,
    thresholds: {
      minRecall: 0.8,
      maxInvalidCitationRate: 0.05,
      maxMissRate: 0.2,
    },
    questions: [{
      id: `${manifest.domainId}-replace-me`,
      question: "Replace this placeholder with an approved retrieval evaluation question.",
      expectedObjectIds: [`sha256:${"0".repeat(64)}`],
    }],
  };

  const substitutions = {
    agentId: manifest.agentId,
    displayName: manifest.displayName,
    domainId: manifest.domainId,
    targetCorpusDisplayName: manifest.targetCorpusDisplayName,
    emojiLine: manifest.emoji === undefined ? "" : `- Emoji: ${manifest.emoji}`,
    issueTracker: options.issueTracker === undefined
      ? ISSUE_TRACKER_PLACEHOLDER
      : requireIssueTracker(options.issueTracker),
  };
  const files = new Map<string, string | Uint8Array>([
    [".gitignore", AGENT_REPO_GITIGNORE],
    ["agent.json", canonicalJson(manifest)],
    ["binding.json", canonicalJson(binding)],
    ["library/eval-questions.json", canonicalJson(evalSet)],
    ["library/scope-manifest.json", canonicalJson(scopeManifest)],
    ["references/.gitkeep", ""],
    ...MARKDOWN_TEMPLATES.map(([path, template]) => [path, renderTemplate(template, substitutions)] as const),
  ]);
  if (avatarPath !== undefined && options.avatar !== undefined) {
    files.set(avatarPath, options.avatar.bytes);
  }

  await fs.mkdir(targetDir, { recursive: true });
  await fs.mkdir(join(targetDir, "library"), { recursive: true });
  await fs.mkdir(join(targetDir, "references"), { recursive: true });
  for (const [path, contents] of [...files].sort(([left], [right]) => compareStrings(left, right))) {
    await fs.writeFile(join(targetDir, path), contents);
  }

  const receipt: ExpertCreationReceipt = {
    schemaVersion: 1,
    kind: "expert_creation_receipt",
    directories: ["library", "references"],
    files: [...files]
      .map(([path, contents]) => ({
        path,
        sha256: createHash("sha256").update(contents).digest("hex"),
        bytes: typeof contents === "string" ? Buffer.byteLength(contents) : contents.byteLength,
      }))
      .sort((left, right) => compareStrings(left.path, right.path)),
  };
  return { targetDir, manifest, binding, scopeManifest, evalSet, receipt };
}

export function serializeCreationReceipt(receipt: ExpertCreationReceipt): string {
  return canonicalJson(receipt);
}

export function renderTemplate(template: string, substitutions: Record<string, string>): string {
  const rendered = template.replace(/{{([A-Za-z][A-Za-z0-9]*)}}/g, (_, key: string) => {
    if (!Object.hasOwn(substitutions, key)) {
      throw new Error("template contains an unknown placeholder");
    }
    return substitutions[key]!;
  });
  if (/{{[^{}]+}}/.test(rendered)) {
    throw new Error("template contains an unresolved placeholder");
  }
  return rendered;
}

async function assertEmptyTarget(targetDir: string, fs: ScaffoldFileSystem): Promise<void> {
  try {
    const target = await fs.stat(targetDir);
    if (!target.isDirectory()) throw new Error("target path exists and is not a directory");
    if ((await fs.readdir(targetDir)).length > 0) throw new Error("target directory must be empty");
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
