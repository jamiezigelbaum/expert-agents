import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SERVING_CHECKLIST_FILE,
  SERVING_MANIFEST_FILE,
  SERVING_RECEIPT_FILE,
  ServingPackagingError,
  packageServingArtifact,
} from "../src/index.ts";
import {
  FORBIDDEN_SOURCE_TERMS,
  NEUTRAL_SECRET,
  SERVING_INCLUDE,
  cleanupTemporaryRoots,
  gitPath,
  taggedFixture,
  temporaryDirectory,
  type TaggedFixture,
} from "./serving-fixtures.ts";

afterEach(cleanupTemporaryRoots);

// Every test here builds a tagged fixture repository and then reads it back
// through git, so each one pays a dozen real subprocesses. On a host already
// running other builds that multiplies well past bun's 5 s default and turns a
// passing suite red. The bound is deliberately generous: it is here to catch a
// hang, not to police duration.
const SUBPROCESS_TIMEOUT_MS = 60_000;

describe("serving artifact packaging", () => {
  test("reports a typed error when the git binary is unavailable", async () => {
    const root = await temporaryDirectory();
    await expect(packageServingArtifact({
      agentDirectory: root,
      tag: "v0.0.1",
      outputRoot: join(root, "artifact"),
      gitPath: null,
    })).rejects.toThrow(ServingPackagingError);
  });

  test.skipIf(gitPath === null)("packages a tagged serving set deterministically", async () => {
    const first = await taggedFixture();
    const second = await taggedFixture();

    const firstResult = await packageServingArtifact(packagingOptions(first));
    const secondResult = await packageServingArtifact(packagingOptions(second));

    expect(firstResult.manifest).toEqual({
      schemaVersion: 1,
      kind: "expert_serving_manifest",
      tag: "v0.1.0",
      agentId: "neutral-agent",
      displayName: "Neutral Agent",
      domainId: "neutral-domain",
      targetCorpusDisplayName: "neutral-corpus",
      emoji: "◉",
      corpora: [
        { corpusId: "neutral-public", disclosure: "full" },
        { corpusId: "neutral-private", disclosure: "derived" },
      ],
      files: [
        "AGENTS.md",
        "HEARTBEAT.md",
        "IDENTITY.md",
        "SOUL.md",
        "TOOLS.md",
        "derived/neutral-distillation/artifact.json",
        "derived/neutral-distillation/content.md",
      ],
    });
    expect(firstResult.receipt).toEqual(secondResult.receipt);
    expect(firstResult.checklist).toBe(secondResult.checklist);
    expect(await readFile(join(first.outputRoot, SERVING_RECEIPT_FILE), "utf8"))
      .toBe(await readFile(join(second.outputRoot, SERVING_RECEIPT_FILE), "utf8"));
    expect(await readFile(join(first.outputRoot, SERVING_MANIFEST_FILE), "utf8"))
      .toBe(await readFile(join(second.outputRoot, SERVING_MANIFEST_FILE), "utf8"));

    expect((await readdir(first.outputRoot)).sort()).toEqual([
      SERVING_CHECKLIST_FILE,
      SERVING_MANIFEST_FILE,
      SERVING_RECEIPT_FILE,
      "workspace",
    ].sort());
    const workspace = await readdir(join(first.outputRoot, "workspace"));
    expect(workspace).not.toContain("USER.md");
    expect(workspace).not.toContain(SERVING_MANIFEST_FILE);
    expect(workspace).not.toContain(SERVING_RECEIPT_FILE);
    expect(firstResult.receipt.files.map((file) => file.path)).toEqual([
      SERVING_CHECKLIST_FILE,
      SERVING_MANIFEST_FILE,
      "workspace/AGENTS.md",
      "workspace/HEARTBEAT.md",
      "workspace/IDENTITY.md",
      "workspace/SOUL.md",
      "workspace/TOOLS.md",
      "workspace/derived/neutral-distillation/artifact.json",
      "workspace/derived/neutral-distillation/content.md",
    ]);
    expect(JSON.stringify(firstResult.receipt)).not.toContain(first.directory);
  }, SUBPROCESS_TIMEOUT_MS);

  test.skipIf(gitPath === null)("refuses a repository whose tagged manifest declares no serving set", async () => {
    const fixture = await taggedFixture({ serving: null });
    await expectPackagingRefusal(fixture, "declares no serving set");
  }, SUBPROCESS_TIMEOUT_MS);

  test.skipIf(gitPath === null)("refuses a tag that does not exist", async () => {
    const fixture = await taggedFixture();
    await expect(packageServingArtifact({ ...packagingOptions(fixture), tag: "v9.9.9" }))
      .rejects.toThrow("release tag does not exist");
  }, SUBPROCESS_TIMEOUT_MS);

  test.skipIf(gitPath === null)("refuses a declared path that resolves to no file at the tag", async () => {
    const fixture = await taggedFixture({
      serving: { include: [...SERVING_INCLUDE, "references/absent.md"] },
    });
    await expectPackagingRefusal(fixture, "resolves to no file at the tag");
  }, SUBPROCESS_TIMEOUT_MS);

  test.skipIf(gitPath === null)(
    "refuses a directory prefix that expands onto a structurally excluded path",
    async () => {
      const fixture = await taggedFixture({
        serving: { include: ["notes/"] },
        extraFiles: { "notes/MEMORY.md": "Neutral fixture memory.\n" },
      });
      await expectPackagingRefusal(fixture, "never reaches a served deployment");
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  test.skipIf(gitPath === null)("refuses a derived-posture corpus with no accepted distillation", async () => {
    const fixture = await taggedFixture({
      serving: {
        include: SERVING_INCLUDE,
        corpora: [{ corpusId: "neutral-private", disclosure: "derived" }],
      },
      derived: [],
    });
    await expectPackagingRefusal(fixture, "no accepted distillation");
  }, SUBPROCESS_TIMEOUT_MS);

  test.skipIf(gitPath === null)("refuses a file carrying a high-confidence secret pattern", async () => {
    const fixture = await taggedFixture({
      serving: { include: [...SERVING_INCLUDE, "notes/"] },
      extraFiles: { "notes/holdings.md": `Neutral fixture ${NEUTRAL_SECRET} holdings.\n` },
    });
    await expectPackagingRefusal(fixture, "high-confidence secret pattern");
  }, SUBPROCESS_TIMEOUT_MS);

  test.skipIf(gitPath === null)(
    "refuses a source object of a derived-posture corpus reaching the artifact",
    async () => {
      const sourceText = "Neutral fixture source object body.\n";
      const sourceId = `sha256:${new Bun.CryptoHasher("sha256").update(sourceText).digest("hex")}`;
      const fixture = await taggedFixture({
        serving: {
          include: [...SERVING_INCLUDE, "derived/", "notes/"],
          corpora: [{ corpusId: "neutral-private", disclosure: "derived" }],
        },
        derived: [{
          artifactId: "neutral-distillation",
          kind: "distillation",
          corpusId: "neutral-private",
          sourceObjectIds: [sourceId],
        }],
        extraFiles: { "notes/source.md": sourceText },
      });
      await expectPackagingRefusal(fixture, "reaches the serving artifact");
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  test.skipIf(gitPath === null)("refuses a non-empty output root and leaves it untouched", async () => {
    const fixture = await taggedFixture();
    await mkdir(fixture.outputRoot, { recursive: true });
    await writeFile(join(fixture.outputRoot, "occupied.txt"), "occupied\n");

    await expect(packageServingArtifact(packagingOptions(fixture)))
      .rejects.toThrow("output root must be empty");
    expect(await readdir(fixture.outputRoot)).toEqual(["occupied.txt"]);
  }, SUBPROCESS_TIMEOUT_MS);
});

describe("serving posture checklist", () => {
  test.skipIf(gitPath === null)("emits the four offline posture steps and no network path", async () => {
    const fixture = await taggedFixture();
    const { checklist } = await packageServingArtifact(packagingOptions(fixture));

    expect(checklist).toContain("[MANUAL] Mount `workspace/` read-only");
    expect(checklist).toContain("[MANUAL] Confirm the sandbox has no git remote and no push credential");
    expect(checklist).toContain("[MANUAL] Apply deny-by-default egress");
    expect(checklist).toContain("[MANUAL] Keep per-hire state outside the artifact and never commit it back");
    expect(checklist).toContain("[MANUAL] Run soul lint");
    expect(checklist).toContain("[MANUAL] Run the retrieval evaluation");
    expect(checklist).toContain("[MANUAL] Run the parity battery");
    expect(checklist).toContain("## ROLLBACK");
    for (const term of FORBIDDEN_SOURCE_TERMS) expect(checklist.toLowerCase()).not.toContain(term);
    expect(checklist).not.toContain("http");
    expect(checklist).not.toContain(fixture.directory);
  }, SUBPROCESS_TIMEOUT_MS);

  test("keeps the packaging module free of network and cross-repository references", async () => {
    const source = (await readFile(join(import.meta.dir, "../src/serving.ts"), "utf8")).toLowerCase();
    for (const term of ["fetch(", "http://", "https://", ...FORBIDDEN_SOURCE_TERMS]) {
      expect(source).not.toContain(term);
    }
  });
});

function packagingOptions(fixture: TaggedFixture) {
  return { agentDirectory: fixture.directory, tag: "v0.1.0", outputRoot: fixture.outputRoot };
}

async function expectPackagingRefusal(fixture: TaggedFixture, message: string): Promise<void> {
  await expect(packageServingArtifact(packagingOptions(fixture))).rejects.toThrow(message);
  await expect(stat(fixture.outputRoot)).rejects.toThrow();
}
