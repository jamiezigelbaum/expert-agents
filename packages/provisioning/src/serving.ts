import { createHash } from "node:crypto";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { canonicalJson } from "../../library/src/index.ts";
import { servingExclusionReason } from "./excluded-paths.ts";
import { containsHighConfidenceSecret } from "./secret-patterns.ts";
import {
  DERIVED_ARTIFACT_CONTENT_FILE,
  DERIVED_ARTIFACT_DIRECTORY,
  DERIVED_ARTIFACT_MANIFEST_FILE,
  type AgentManifest,
  type AgentServingCorpus,
  type CreationReceiptFile,
  type DerivedArtifactManifest,
  type ServingArtifactReceipt,
  type ServingManifest,
  type ServingPackageResult,
} from "./types.ts";
import {
  lintDerivedArtifactContent,
  validateAgentManifest,
  validateDerivedArtifactManifest,
} from "./validation.ts";

export const SERVING_WORKSPACE_DIRECTORY = "workspace";
export const SERVING_MANIFEST_FILE = "SERVING_MANIFEST.json";
export const SERVING_CHECKLIST_FILE = "SERVING_CHECKLIST.md";
export const SERVING_RECEIPT_FILE = "SERVING_RECEIPT.json";

/**
 * Preconditions packaging deliberately does not attempt, because each one needs
 * a network the machinery never touches. They stay operator-run.
 */
export const SERVING_MANUAL_PRECONDITIONS: readonly string[] = [
  "Run soul lint against the tagged repository and record an owner-approved result.",
  "Run the retrieval evaluation for this tag and confirm it clears its declared thresholds.",
  "Run the parity battery against the tagged configuration and confirm no regression.",
];

export class ServingPackagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServingPackagingError";
  }
}

export interface PackageServingArtifactOptions {
  /** Agent repository working directory; content is read at the tag, never from it. */
  agentDirectory: string;
  tag: string;
  outputRoot: string;
  /** Injected in tests; `undefined` resolves the git binary through `Bun.which`. */
  gitPath?: string | null;
}

interface TagDerivedArtifact {
  manifest: DerivedArtifactManifest;
  content: string;
}

/**
 * Builds a pinned-deployment artifact from a release tag. Everything is
 * validated and read into memory before any output is written, so a refused
 * packaging attempt leaves no output directory behind.
 */
export async function packageServingArtifact(
  options: PackageServingArtifactOptions,
): Promise<ServingPackageResult> {
  const agentDirectory = resolve(options.agentDirectory);
  const outputRoot = resolve(options.outputRoot);
  const tag = options.tag.trim();
  if (tag.length === 0 || tag !== options.tag) {
    throw new ServingPackagingError("a release tag is required");
  }
  const gitPath = options.gitPath === undefined ? Bun.which("git") : options.gitPath;
  if (gitPath === null) {
    throw new ServingPackagingError("git is required to read an agent repository at a tag");
  }
  await assertEmptyOutputRoot(outputRoot);

  const commit = await resolveTagCommit(gitPath, agentDirectory, tag);
  const treePaths = await listTreePaths(gitPath, agentDirectory, commit);
  const manifest = readAgentManifest(await readTagBytes(gitPath, agentDirectory, commit, "agent.json"));
  const serving = manifest.serving;
  if (serving === undefined) {
    throw new ServingPackagingError("the manifest at the tag declares no serving set");
  }

  const files = materializeServingSet(serving.include, treePaths);
  for (const path of files) {
    if (servingExclusionReason(path) !== null) {
      throw new ServingPackagingError(
        "a materialized serving path belongs to a class that never reaches a served deployment",
      );
    }
  }

  const contents = new Map<string, Uint8Array>();
  for (const path of files) {
    const bytes = await readTagBytes(gitPath, agentDirectory, commit, path);
    if (containsHighConfidenceSecret(decodeText(bytes))) {
      throw new ServingPackagingError(
        "a file entering the serving artifact contains a high-confidence secret pattern",
      );
    }
    contents.set(path, bytes);
  }

  const artifacts = await readDerivedArtifactsAtTag(gitPath, agentDirectory, commit, treePaths);
  assertDerivedCorporaAreRepresented(serving.corpora ?? [], artifacts, files, contents);

  const servingManifest = createServingManifest(manifest, tag, serving.corpora ?? [], files);
  const checklist = createServingChecklist(servingManifest);
  const operatorFiles = new Map<string, string>([
    [SERVING_MANIFEST_FILE, canonicalJson(servingManifest)],
    [SERVING_CHECKLIST_FILE, checklist],
  ]);
  const receipt: ServingArtifactReceipt = {
    schemaVersion: 1,
    kind: "expert_serving_receipt",
    files: [
      ...[...contents].map(([path, bytes]) => receiptEntry(workspacePath(path), bytes)),
      ...[...operatorFiles].map(([path, text]) => receiptEntry(path, Buffer.from(text, "utf8"))),
    ].sort((left, right) => compareStrings(left.path, right.path)),
  };

  await mkdir(outputRoot, { recursive: true });
  for (const [path, bytes] of [...contents].sort(([left], [right]) => compareStrings(left, right))) {
    const destination = resolveWorkspaceDestination(outputRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx" });
  }
  for (const [path, text] of [...operatorFiles].sort(([left], [right]) => compareStrings(left, right))) {
    await writeFile(join(outputRoot, path), text, { encoding: "utf8", flag: "wx" });
  }
  await writeFile(join(outputRoot, SERVING_RECEIPT_FILE), canonicalJson(receipt), {
    encoding: "utf8",
    flag: "wx",
  });

  return { outputRoot, manifest: servingManifest, checklist, receipt };
}

export function createServingManifest(
  manifest: AgentManifest,
  tag: string,
  corpora: AgentServingCorpus[],
  files: string[],
): ServingManifest {
  return {
    schemaVersion: 1,
    kind: "expert_serving_manifest",
    tag,
    agentId: manifest.agentId,
    displayName: manifest.displayName,
    domainId: manifest.domainId,
    targetCorpusDisplayName: manifest.targetCorpusDisplayName,
    ...(manifest.emoji === undefined ? {} : { emoji: manifest.emoji }),
    // The avatar is public-safe, so it may ship — but it is named only when the
    // serving set actually materialized it, so the manifest never points a
    // served deployment at a file its artifact does not contain. The allowlist
    // stays the only thing that decides what ships.
    ...(manifest.avatar !== undefined && files.includes(manifest.avatar)
      ? { avatar: manifest.avatar }
      : {}),
    corpora,
    files: [...files].sort(compareStrings),
  };
}

/**
 * Offline, declarative posture steps for a pinned deployment. This function
 * builds strings and nothing else: it contacts no gateway and invents no
 * configuration key.
 */
export function createServingChecklist(manifest: ServingManifest): string {
  const lines = [
    "# Serving posture checklist",
    "",
    `Pinned deployment of \`${manifest.agentId}\` at tag \`${manifest.tag}\`.`,
    "",
    "This checklist is declarative and offline. Packaging contacted no gateway,",
    "registry, or network service, and it changed no deployment.",
    "",
    "## Preconditions packaging did not run",
    "",
  ];
  SERVING_MANUAL_PRECONDITIONS.forEach((precondition, index) => {
    lines.push(`${index + 1}. [MANUAL] ${precondition}`);
  });
  lines.push(
    "",
    "## Pinned deployment posture",
    "",
    "1. [MANUAL] Mount `workspace/` read-only. Only `workspace/` is ever mounted;"
      + " this checklist, the serving manifest, and the receipt are operator material"
      + " and stay outside the mount.",
    "2. [MANUAL] Confirm the sandbox has no git remote and no push credential. A"
      + " pinned deployment has no write path back to the agent repository, so an"
      + " instruction to rewrite the agent fails because the capability is absent.",
    "3. [MANUAL] Apply deny-by-default egress. Allow only the endpoints the"
      + " deployment provably needs, and confirm no ingestion or fetch path is"
      + " reachable from a served session.",
    "4. [MANUAL] Keep per-hire state outside the artifact and never commit it back."
      + " Raw client content is deleted at engagement end and never enters the agent"
      + " repository or the shared library.",
    "",
    "## Disclosure postures carried by this tag",
    "",
  );
  if (manifest.corpora.length === 0) {
    lines.push("No corpus disclosure posture is declared at this tag.");
  } else {
    for (const corpus of manifest.corpora) {
      lines.push(`- \`${corpus.corpusId}\`: ${describeDisclosure(corpus.disclosure)}`);
    }
  }
  lines.push(
    "",
    "## ROLLBACK",
    "",
    "Perform these inverse steps in reverse application order:",
    "",
    "1. [MANUAL] Stop the pinned deployment and unmount `workspace/`.",
    "2. [MANUAL] Remove the materialized artifact and any per-hire state created"
      + " beside it, using the operator-approved deletion process.",
  );
  return `${lines.join("\n")}\n`;
}

function describeDisclosure(disclosure: AgentServingCorpus["disclosure"]): string {
  if (disclosure === "full") {
    return "retrievable under bounded excerpting with mandatory citation.";
  }
  if (disclosure === "derived") {
    return "sources never reach this deployment; only the accepted distillation does.";
  }
  return "absent from this deployment entirely.";
}

function readAgentManifest(bytes: Uint8Array): AgentManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeText(bytes));
  } catch {
    throw new ServingPackagingError("agent.json at the tag is not valid JSON");
  }
  try {
    return validateAgentManifest(parsed);
  } catch {
    throw new ServingPackagingError("agent.json at the tag is not a valid agent manifest");
  }
}

function materializeServingSet(include: string[], treePaths: string[]): string[] {
  const tracked = new Set(treePaths);
  const materialized = new Set<string>();
  for (const entry of include) {
    if (entry.endsWith("/")) {
      const matches = treePaths.filter((path) => path.startsWith(entry));
      if (matches.length === 0) {
        throw new ServingPackagingError("a declared serving path resolves to no file at the tag");
      }
      for (const match of matches) materialized.add(match);
      continue;
    }
    if (!tracked.has(entry)) {
      throw new ServingPackagingError("a declared serving path resolves to no file at the tag");
    }
    materialized.add(entry);
  }
  return [...materialized].sort(compareStrings);
}

/**
 * Reads every accepted derived artifact at the tag. Derived artifacts are
 * contract-file class, so a malformed one at a release tag fails packaging
 * rather than shipping.
 */
async function readDerivedArtifactsAtTag(
  gitPath: string,
  agentDirectory: string,
  commit: string,
  treePaths: string[],
): Promise<TagDerivedArtifact[]> {
  const pattern = new RegExp(`^${DERIVED_ARTIFACT_DIRECTORY}/([^/]+)/${DERIVED_ARTIFACT_MANIFEST_FILE}$`);
  const artifacts: TagDerivedArtifact[] = [];
  for (const path of [...treePaths].sort(compareStrings)) {
    const artifactId = pattern.exec(path)?.[1];
    if (artifactId === undefined) continue;
    const contentPath = `${DERIVED_ARTIFACT_DIRECTORY}/${artifactId}/${DERIVED_ARTIFACT_CONTENT_FILE}`;
    if (!treePaths.includes(contentPath)) {
      throw new ServingPackagingError("a derived artifact at the tag has no content file");
    }
    let manifest: DerivedArtifactManifest;
    try {
      manifest = validateDerivedArtifactManifest(
        JSON.parse(decodeText(await readTagBytes(gitPath, agentDirectory, commit, path))),
      );
    } catch {
      throw new ServingPackagingError("a derived artifact at the tag is not valid");
    }
    if (manifest.artifactId !== artifactId) {
      throw new ServingPackagingError("a derived artifact id does not match its directory");
    }
    const content = decodeText(await readTagBytes(gitPath, agentDirectory, commit, contentPath));
    if (!lintDerivedArtifactContent(content).valid) {
      throw new ServingPackagingError("a derived artifact at the tag has invalid content");
    }
    artifacts.push({ manifest, content });
  }
  return artifacts;
}

/**
 * The copyright and privacy gate. A `derived`-posture corpus must be
 * represented by an accepted distillation, and none of that corpus's declared
 * source objects may reach the artifact — checked by content address, so a
 * source object cannot ship under a renamed path.
 */
function assertDerivedCorporaAreRepresented(
  corpora: AgentServingCorpus[],
  artifacts: TagDerivedArtifact[],
  files: string[],
  contents: Map<string, Uint8Array>,
): void {
  const contentIds = new Map<string, string>();
  for (const [path, bytes] of contents) contentIds.set(path, contentId(bytes));
  for (const corpus of corpora) {
    if (corpus.disclosure !== "derived") continue;
    const distillation = artifacts.find(
      (artifact) => artifact.manifest.kind === "distillation"
        && artifact.manifest.corpusId === corpus.corpusId,
    );
    if (distillation === undefined) {
      throw new ServingPackagingError(
        "a derived-posture corpus has no accepted distillation at the tag",
      );
    }
    const sourceObjectIds = new Set(distillation.manifest.provenance.sourceObjectIds ?? []);
    if (sourceObjectIds.size === 0) continue;
    for (const path of files) {
      const shipsSourceBytes = sourceObjectIds.has(contentIds.get(path)!);
      const shipsSourcePath = [...sourceObjectIds].some((id) => path.includes(id));
      if (shipsSourceBytes || shipsSourcePath) {
        throw new ServingPackagingError(
          "a source object of a derived-posture corpus reaches the serving artifact",
        );
      }
    }
  }
}

function receiptEntry(path: string, bytes: Uint8Array): CreationReceiptFile {
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

function contentId(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function workspacePath(path: string): string {
  return `${SERVING_WORKSPACE_DIRECTORY}/${path}`;
}

function resolveWorkspaceDestination(outputRoot: string, path: string): string {
  const workspaceRoot = join(outputRoot, SERVING_WORKSPACE_DIRECTORY);
  const destination = resolve(workspaceRoot, path);
  if (!destination.startsWith(`${workspaceRoot}${sep}`)) {
    throw new ServingPackagingError("a materialized serving path escapes the workspace directory");
  }
  return destination;
}

async function resolveTagCommit(
  gitPath: string,
  agentDirectory: string,
  tag: string,
): Promise<string> {
  const result = await runGit(gitPath, agentDirectory, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/tags/${tag}^{commit}`,
  ]);
  const commit = decodeText(result.stdout).trim();
  if (result.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) {
    throw new ServingPackagingError("the requested release tag does not exist in the agent repository");
  }
  return commit;
}

async function listTreePaths(
  gitPath: string,
  agentDirectory: string,
  commit: string,
): Promise<string[]> {
  const result = await runGit(gitPath, agentDirectory, ["ls-tree", "-r", "--name-only", "-z", commit]);
  if (result.exitCode !== 0) {
    throw new ServingPackagingError("the tagged tree could not be listed");
  }
  return decodeText(result.stdout).split("\0").filter((path) => path.length > 0);
}

async function readTagBytes(
  gitPath: string,
  agentDirectory: string,
  commit: string,
  path: string,
): Promise<Uint8Array> {
  const result = await runGit(gitPath, agentDirectory, ["show", `${commit}:${path}`]);
  if (result.exitCode !== 0) {
    throw new ServingPackagingError("a declared serving path could not be read at the tag");
  }
  return result.stdout;
}

/** Offline git access only: read local objects, never fetch. */
async function runGit(
  gitPath: string,
  agentDirectory: string,
  args: string[],
): Promise<{ exitCode: number; stdout: Uint8Array }> {
  const child = Bun.spawn([gitPath, "-C", agentDirectory, ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
  ]);
  return { exitCode, stdout: new Uint8Array(stdout) };
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function assertEmptyOutputRoot(outputRoot: string): Promise<void> {
  try {
    const output = await stat(outputRoot);
    if (!output.isDirectory()) {
      throw new ServingPackagingError("the serving output path exists and is not a directory");
    }
    if ((await readdir(outputRoot)).length > 0) {
      throw new ServingPackagingError("the serving output root must be empty");
    }
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
