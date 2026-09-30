import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEngagementStore, scaffoldExpert } from "../packages/provisioning/src/index.ts";
import {
  describeExpertLearningOutcome,
  parseExpertLearningArguments,
  runExpertLearningCli,
} from "../scripts/expert-learning.ts";
import { runExpertIngestCli, type ExtractionRequest, type ExtractionResult } from "../scripts/expert-ingest.ts";

const ENGAGEMENT_ID = "engagement-neutral-0001";
const AGENT_ID = "neutral-agent";
const OPENED_AT = "2026-07-28T00:00:00Z";
const ACCEPTED_AT = "2026-07-28T12:00:00Z";
const CLOSED_AT = "2026-07-29T00:00:00Z";
const CLIENT_CONTENT =
  "The neutral client owes 412905 units under the fixture supply agreement dated the third of March.";
const GENERALIZATION =
  "Ask how the parties agreed to true up before asking what the balance is; a supply dispute usually turns on the settlement mechanism rather than the size of the number.\n";
const ARTIFACT_ID = "neutral-practice-doctrine";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface LearningFixture {
  engagementRoot: string;
  agentDirectory: string;
  libraryDirectory: string;
  draftPath: string;
  baseArgv: string[];
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function learningFixture(): Promise<LearningFixture> {
  const workspace = await temporaryRoot("expert-learning-");
  const agentDirectory = join(workspace, "agent-repository");
  await scaffoldExpert({
    targetDir: agentDirectory,
    agentId: AGENT_ID,
    displayName: "Neutral Agent",
    domainId: "neutral-domain",
    targetCorpusDisplayName: "neutral-corpus",
  });
  const libraryDirectory = join(workspace, "library");
  const engagementRoot = join(await temporaryRoot("expert-engagement-"), "engagements", ENGAGEMENT_ID);
  const store = await openEngagementStore({
    engagementRoot,
    agentDirectory,
    libraryDirectory,
    engagementId: ENGAGEMENT_ID,
    agentId: AGENT_ID,
    openedAt: OPENED_AT,
  });
  await store.writeClientContent("client-item-0001", CLIENT_CONTENT);

  const draftPath = join(workspace, "learning-draft.md");
  await writeFile(draftPath, GENERALIZATION);
  return {
    engagementRoot,
    agentDirectory,
    libraryDirectory,
    draftPath,
    baseArgv: [
      "--engagement", engagementRoot,
      "--agent", agentDirectory,
      "--library", libraryDirectory,
    ],
  };
}

describe("expert:learning argument parsing", () => {
  test("requires exactly one mode and a complete acceptance triple", () => {
    const base = ["--engagement", "/e", "--agent", "/a", "--library", "/l"];
    expect(() => parseExpertLearningArguments(base)).toThrow("Exactly one of");
    expect(() => parseExpertLearningArguments([...base, "--draft", "/d", "--close-at", CLOSED_AT]))
      .toThrow("Exactly one of");
    expect(() => parseExpertLearningArguments([...base, "--draft", "/d", "--artifact-id", ARTIFACT_ID]))
      .toThrow("Acceptance requires");
    expect(() => parseExpertLearningArguments([
      ...base,
      "--close-at", CLOSED_AT,
      "--artifact-id", ARTIFACT_ID,
      "--accepted-by", "neutral-owner",
      "--accepted-at", ACCEPTED_AT,
    ])).toThrow("Acceptance applies only to --draft");
    expect(parseExpertLearningArguments([...base, "--draft", "/d"]).mode).toBe("draft");
  });
});

describe("expert:learning extraction", () => {
  test("seals a draft for review and writes nothing without an acceptance", async () => {
    const fixture = await learningFixture();
    const outcome = await runExpertLearningCli([...fixture.baseArgv, "--draft", fixture.draftPath]);

    expect(outcome.kind).toBe("sealed");
    await expect(readdir(join(fixture.agentDirectory, "derived"))).rejects.toThrow();
    const lines = describeExpertLearningOutcome(outcome).join("\n");
    expect(lines).toContain("[MANUAL]");
    expect(lines).not.toContain(CLIENT_CONTENT);
    expect(lines).not.toContain(GENERALIZATION.trim());
  });

  test("writes the doctrine artifact only when an acceptance is supplied", async () => {
    const fixture = await learningFixture();
    const outcome = await runExpertLearningCli([
      ...fixture.baseArgv,
      "--draft", fixture.draftPath,
      "--artifact-id", ARTIFACT_ID,
      "--accepted-by", "neutral-owner",
      "--accepted-at", ACCEPTED_AT,
    ]);

    expect(outcome).toMatchObject({ kind: "accepted" });
    const artifact = JSON.parse(
      await readFile(join(fixture.agentDirectory, "derived", ARTIFACT_ID, "artifact.json"), "utf8"),
    );
    expect(artifact).toMatchObject({ kind: "doctrine", artifactId: ARTIFACT_ID, acceptedBy: "neutral-owner" });
    expect(JSON.stringify(artifact)).not.toContain(ENGAGEMENT_ID);
    expect(await readFile(join(fixture.agentDirectory, "derived", ARTIFACT_ID, "content.md"), "utf8"))
      .toBe(GENERALIZATION);
    const lines = describeExpertLearningOutcome(outcome).join("\n");
    expect(lines).toContain(`derived/${ARTIFACT_ID}/content.md`);
    expect(lines).not.toContain(fixture.engagementRoot);
  });

  test("refuses extraction once the engagement has opted out", async () => {
    const fixture = await learningFixture();
    const optedOut = await runExpertLearningCli([...fixture.baseArgv, "--opt-out-at", ACCEPTED_AT]);
    expect(optedOut).toMatchObject({ kind: "opted-out" });

    await expect(runExpertLearningCli([
      ...fixture.baseArgv,
      "--draft", fixture.draftPath,
      "--artifact-id", ARTIFACT_ID,
      "--accepted-by", "neutral-owner",
      "--accepted-at", ACCEPTED_AT,
    ])).rejects.toMatchObject({ code: "learning_opt_out" });
    await expect(readdir(join(fixture.agentDirectory, "derived"))).rejects.toThrow();
    expect(describeExpertLearningOutcome(optedOut).join("\n")).toContain("prospective");
  });

  test("refuses a draft authored inside per-engagement storage", async () => {
    const fixture = await learningFixture();
    const heldDraft = join(fixture.engagementRoot, "learning-draft.md");
    await writeFile(heldDraft, GENERALIZATION);

    await expect(runExpertLearningCli([...fixture.baseArgv, "--draft", heldDraft]))
      .rejects.toThrow("held in per-engagement storage");
  });

  test("reports engagement-end deletion with counts only", async () => {
    const fixture = await learningFixture();
    const outcome = await runExpertLearningCli([...fixture.baseArgv, "--close-at", CLOSED_AT]);

    expect(outcome).toMatchObject({ kind: "closed" });
    const lines = describeExpertLearningOutcome(outcome).join("\n");
    expect(lines).toContain("items deleted: 1");
    expect(lines).toContain("items remaining in per-engagement storage: 0");
    expect(lines).not.toContain(CLIENT_CONTENT);
    expect(lines).not.toContain(fixture.engagementRoot);
  });
});

describe("library ingestion refuses engagement-held paths", () => {
  test("refuses a source held in per-engagement storage before extraction runs", async () => {
    const fixture = await learningFixture();
    const held = join(fixture.engagementRoot, "client-content", "client-item-0001");
    const attempts: ExtractionRequest[] = [];

    const promise = runExpertIngestCli(["--source", held, "--library", fixture.libraryDirectory], {
      summarizePath: "/neutral/bin/summarize",
      extract: async (request: ExtractionRequest): Promise<ExtractionResult> => {
        attempts.push(request);
        return { exitCode: 0, stdout: CLIENT_CONTENT, stderr: "" };
      },
      env: {},
      now: () => ACCEPTED_AT,
    });

    await expect(promise).rejects.toMatchObject({ code: "engagement_held_path" });
    expect(attempts).toHaveLength(0);
  });

  test("refuses a library rooted inside per-engagement storage", async () => {
    const fixture = await learningFixture();
    const attempts: ExtractionRequest[] = [];

    const promise = runExpertIngestCli([
      "--source", "https://example.invalid/reference/neutral-talk",
      "--library", join(fixture.engagementRoot, "library"),
    ], {
      summarizePath: "/neutral/bin/summarize",
      extract: async (request: ExtractionRequest): Promise<ExtractionResult> => {
        attempts.push(request);
        return { exitCode: 0, stdout: "# Neutral\n", stderr: "" };
      },
      env: {},
      now: () => ACCEPTED_AT,
    });

    await expect(promise).rejects.toMatchObject({ code: "engagement_held_path" });
    expect(attempts).toHaveLength(0);
  });
});
