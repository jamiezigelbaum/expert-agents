import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffoldExpert,
  type AgentServingSet,
  type DerivedArtifactManifest,
  type ExpertScaffoldOptions,
} from "../src/index.ts";

export const BASE_MANIFEST = {
  schemaVersion: 1,
  agentId: "neutral-agent",
  displayName: "Neutral Agent",
  domainId: "neutral-domain",
  targetCorpusDisplayName: "neutral-corpus",
} as const;

export const SERVING_INCLUDE = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "TOOLS.md", "HEARTBEAT.md"];
export const NEUTRAL_SECRET = `AKIA${"C".repeat(16)}`;
/** Split so the repository boundary scan does not read an assertion as a real reference. */
export const FORBIDDEN_SOURCE_TERMS = ["oly" + "mpus", "open" + "shell"];
export const gitPath = Bun.which("git");

export type DerivedArtifactFixtureKind = "doctrine" | "distillation";

export interface DerivedArtifactFixture {
  artifactId: string;
  kind: DerivedArtifactFixtureKind;
  corpusId?: string;
  sourceObjectIds?: string[];
}

export interface TaggedFixtureOptions {
  /** `null` commits a manifest with no serving block at all. */
  serving?: AgentServingSet | null;
  derived?: DerivedArtifactFixture[];
  extraFiles?: Record<string, string>;
}

export interface TaggedFixture {
  directory: string;
  outputRoot: string;
}

const temporaryRoots: string[] = [];

export async function cleanupTemporaryRoots(): Promise<void> {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "expert-serving-"));
  temporaryRoots.push(directory);
  return directory;
}

export function scaffoldOptions(targetDir: string): ExpertScaffoldOptions {
  return {
    targetDir,
    agentId: "neutral-agent",
    displayName: "Neutral Agent",
    domainId: "neutral-domain",
    targetCorpusDisplayName: "neutral-corpus",
    emoji: "◉",
  };
}

export async function scaffoldFixture(): Promise<string> {
  const directory = await temporaryDirectory();
  await scaffoldExpert(scaffoldOptions(directory));
  return directory;
}

export function derivedManifest(
  artifactId: string,
  kind: DerivedArtifactFixtureKind,
  corpusId?: string,
  sourceObjectIds?: string[],
): DerivedArtifactManifest {
  return {
    schemaVersion: 1,
    kind,
    artifactId,
    ...(corpusId === undefined ? {} : { corpusId }),
    acceptedAt: "2026-07-28T00:00:00Z",
    acceptedBy: "neutral-owner",
    provenance: {
      ...(corpusId === undefined ? {} : { sourceCorpusId: corpusId }),
      ...(sourceObjectIds === undefined ? {} : { sourceObjectIds }),
      note: "Accepted for the neutral fixture.",
    },
  };
}

export async function writeDerivedArtifact(
  directory: string,
  artifactId: string,
  kind: DerivedArtifactFixtureKind,
  corpusId?: string,
  sourceObjectIds?: string[],
): Promise<void> {
  const artifactDirectory = join(directory, "derived", artifactId);
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(
    join(artifactDirectory, "artifact.json"),
    `${JSON.stringify(derivedManifest(artifactId, kind, corpusId, sourceObjectIds), null, 2)}\n`,
  );
  await writeFile(
    join(artifactDirectory, "content.md"),
    "A bounded neutral synthesis that stands in for held-back sources.\n",
  );
}

export async function writeServingManifest(
  directory: string,
  serving: AgentServingSet,
): Promise<void> {
  const path = join(directory, "agent.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  await writeFile(path, `${JSON.stringify({ ...manifest, serving }, null, 2)}\n`);
}

/** A scaffolded agent repository committed and tagged `v0.1.0` in a temp directory. */
export async function taggedFixture(options: TaggedFixtureOptions = {}): Promise<TaggedFixture> {
  const root = await temporaryDirectory();
  const directory = join(root, "agent-repository");
  await scaffoldExpert(scaffoldOptions(directory));
  const derived = options.derived ?? [{
    artifactId: "neutral-distillation",
    kind: "distillation" as const,
    corpusId: "neutral-private",
  }];
  for (const artifact of derived) {
    await writeDerivedArtifact(
      directory,
      artifact.artifactId,
      artifact.kind,
      artifact.corpusId,
      artifact.sourceObjectIds,
    );
  }
  for (const [path, contents] of Object.entries(options.extraFiles ?? {})) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), contents);
  }
  const serving = options.serving === undefined
    ? {
        include: [...SERVING_INCLUDE, "derived/"],
        corpora: [
          { corpusId: "neutral-public", disclosure: "full" as const },
          { corpusId: "neutral-private", disclosure: "derived" as const },
        ],
      }
    : options.serving;
  if (serving !== null) await writeServingManifest(directory, serving);

  const git = gitPath!;
  await runFixtureGit(git, directory, ["init", "-b", "main"]);
  await runFixtureGit(git, directory, ["config", "user.name", "Neutral Fixture"]);
  await runFixtureGit(git, directory, ["config", "user.email", "neutral-fixture@example.invalid"]);
  await runFixtureGit(git, directory, ["config", "commit.gpgsign", "false"]);
  await runFixtureGit(git, directory, ["config", "tag.gpgsign", "false"]);
  await runFixtureGit(git, directory, ["config", "tag.forcesignannotated", "false"]);
  await runFixtureGit(git, directory, ["add", "--all", "--force"]);
  await runFixtureGit(git, directory, ["commit", "-m", "Initialize neutral fixture"]);
  await runFixtureGit(git, directory, ["tag", "v0.1.0"]);
  return { directory, outputRoot: join(root, "artifact") };
}

async function runFixtureGit(git: string, directory: string, args: string[]): Promise<void> {
  const child = Bun.spawn([git, "-C", directory, ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`git fixture command failed: ${stderr}`);
}
