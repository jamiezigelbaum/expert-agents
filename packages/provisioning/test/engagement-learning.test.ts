import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ENGAGEMENT_CONTENT_DIRECTORY,
  ENGAGEMENT_RECORD_FILE,
  LEARNING_ARTIFACT_KIND,
  acceptEngagementLearning,
  expertStatus,
  extractEngagementLearning,
  isEngagementHeldPath,
  openEngagementStore,
  validateDerivedArtifactManifest,
  type EngagementStore,
  type SealedEngagementLearning,
} from "../src/index.ts";
import { NEUTRAL_SECRET, cleanupTemporaryRoots, scaffoldFixture, temporaryDirectory } from "./serving-fixtures.ts";

const ENGAGEMENT_ID = "engagement-neutral-0001";
const OTHER_ENGAGEMENT_ID = "engagement-neutral-0002";
const AGENT_ID = "neutral-agent";
const OPENED_AT = "2026-07-28T00:00:00Z";
const ACCEPTED_AT = "2026-07-28T12:00:00Z";
const CLOSED_AT = "2026-07-29T00:00:00Z";
const CLIENT_CONTENT =
  "The neutral client owes 412905 units under the fixture supply agreement dated the third of March.";
const GENERALIZATION =
  "Ask how the parties agreed to true up before asking what the balance is; a supply dispute usually turns on the settlement mechanism rather than the size of the number.";

interface EngagementFixture {
  store: EngagementStore;
  engagementRoot: string;
  agentDirectory: string;
  libraryDirectory: string;
}

afterEach(cleanupTemporaryRoots);

async function engagementFixture(
  options: { learningOptOut?: boolean } = {},
): Promise<EngagementFixture> {
  const agentDirectory = await scaffoldFixture();
  const libraryDirectory = await temporaryDirectory();
  const engagementRoot = join(await temporaryDirectory(), "engagements", ENGAGEMENT_ID);
  const store = await openEngagementStore({
    engagementRoot,
    agentDirectory,
    libraryDirectory,
    engagementId: ENGAGEMENT_ID,
    agentId: AGENT_ID,
    openedAt: OPENED_AT,
    ...(options.learningOptOut === undefined ? {} : { learningOptOut: options.learningOptOut }),
  });
  return { store, engagementRoot, agentDirectory, libraryDirectory };
}

async function sealedFixture(): Promise<EngagementFixture & { sealed: SealedEngagementLearning }> {
  const fixture = await engagementFixture();
  await fixture.store.writeClientContent("client-item-0001", CLIENT_CONTENT);
  const sealed = await extractEngagementLearning(fixture.store, { text: GENERALIZATION });
  return { ...fixture, sealed };
}

async function everyFileText(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true });
  const texts: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry);
    if (!(await stat(path)).isFile()) continue;
    texts.push(await readFile(path, "utf8"));
  }
  return texts;
}

describe("per-engagement storage separation", () => {
  test("refuses storage that overlaps the agent repository or the shared library", async () => {
    const agentDirectory = await scaffoldFixture();
    const libraryDirectory = await temporaryDirectory();
    const identity = {
      agentDirectory,
      libraryDirectory,
      engagementId: ENGAGEMENT_ID,
      agentId: AGENT_ID,
      openedAt: OPENED_AT,
    };
    for (const engagementRoot of [
      agentDirectory,
      join(agentDirectory, "engagements", ENGAGEMENT_ID),
      libraryDirectory,
      join(libraryDirectory, "engagements"),
      join(agentDirectory, ".."),
    ]) {
      await expect(openEngagementStore({ ...identity, engagementRoot }))
        .rejects.toMatchObject({ code: "storage_not_separate" });
    }
  });

  test("refuses storage inside a git working tree", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"), { recursive: true });
    await expect(openEngagementStore({
      engagementRoot: join(root, "engagements", ENGAGEMENT_ID),
      agentDirectory: await scaffoldFixture(),
      libraryDirectory: await temporaryDirectory(),
      engagementId: ENGAGEMENT_ID,
      agentId: AGENT_ID,
      openedAt: OPENED_AT,
    })).rejects.toMatchObject({ code: "storage_inside_git_repository" });
  });

  test("keeps client content out of the agent repository and the shared library", async () => {
    const fixture = await engagementFixture();
    await fixture.store.writeClientContent("client-item-0001", CLIENT_CONTENT);

    for (const root of [fixture.agentDirectory, fixture.libraryDirectory]) {
      for (const text of await everyFileText(root)) {
        expect(text).not.toContain(CLIENT_CONTENT);
      }
    }
    const held = join(fixture.engagementRoot, ENGAGEMENT_CONTENT_DIRECTORY, "client-item-0001");
    expect(await readFile(held, "utf8")).toBe(CLIENT_CONTENT);
    expect(await isEngagementHeldPath(held)).toBe(true);
    expect(await isEngagementHeldPath(fixture.agentDirectory)).toBe(false);
    expect(await isEngagementHeldPath(fixture.libraryDirectory)).toBe(false);
  });

  test("refuses to reuse one storage root for a second engagement", async () => {
    const fixture = await engagementFixture();
    await expect(openEngagementStore({
      engagementRoot: fixture.engagementRoot,
      agentDirectory: fixture.agentDirectory,
      libraryDirectory: fixture.libraryDirectory,
      engagementId: OTHER_ENGAGEMENT_ID,
      agentId: AGENT_ID,
      openedAt: OPENED_AT,
    })).rejects.toMatchObject({ code: "engagement_identity_mismatch" });
  });

  test("refuses a content item id that is not a single opaque identifier", async () => {
    const fixture = await engagementFixture();
    for (const itemId of ["../escape", "nested/item", "/absolute", "", "."]) {
      await expect(fixture.store.writeClientContent(itemId, CLIENT_CONTENT))
        .rejects.toMatchObject({ code: "invalid_engagement_input" });
    }
  });
});

describe("client content cannot leave per-engagement storage", () => {
  test("exposes no store operation that returns client content", async () => {
    const fixture = await engagementFixture();
    expect(Object.keys(fixture.store).sort()).toEqual([
      "agentId",
      "closeEngagement",
      "engagementId",
      "readRecord",
      "recordLearningOptOut",
      "writeClientContent",
    ]);

    const results: unknown[] = [
      fixture.store,
      await fixture.store.writeClientContent("client-item-0001", CLIENT_CONTENT),
      await fixture.store.readRecord(),
      await extractEngagementLearning(fixture.store, { text: GENERALIZATION }),
      await fixture.store.closeEngagement(CLOSED_AT),
    ];
    for (const result of results) {
      expect(JSON.stringify(result) ?? "").not.toContain(CLIENT_CONTENT);
      expect(JSON.stringify(result) ?? "").not.toContain("neutral client owes");
    }
  });

  test("leaves the shared library untouched across an engagement's whole life", async () => {
    const fixture = await engagementFixture();
    await fixture.store.writeClientContent("client-item-0001", CLIENT_CONTENT);
    const sealed = await extractEngagementLearning(fixture.store, { text: GENERALIZATION });
    await acceptEngagementLearning({
      agentDirectory: fixture.agentDirectory,
      learning: sealed,
      artifactId: "neutral-practice-doctrine",
      acceptedAt: ACCEPTED_AT,
      acceptedBy: "neutral-owner",
    });
    await fixture.store.closeEngagement(CLOSED_AT);

    expect(await readdir(fixture.libraryDirectory)).toEqual([]);
  });

  test("keeps the extraction module free of every library and network path", async () => {
    const source = await readFile(join(import.meta.dir, "../src/engagement.ts"), "utf8");
    const specifiers = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier.startsWith("node:") || specifier.startsWith("./")).toBe(true);
    }
    expect(specifiers.some((specifier) => specifier.includes("library"))).toBe(false);
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("the learning opt-out", () => {
  test("refuses extraction at the extraction point when the flag is set at open time", async () => {
    const fixture = await engagementFixture({ learningOptOut: true });
    await fixture.store.writeClientContent("client-item-0001", CLIENT_CONTENT);
    await expect(extractEngagementLearning(fixture.store, { text: GENERALIZATION }))
      .rejects.toMatchObject({ code: "learning_opt_out" });
  });

  test("refuses extraction from the moment the opt-out is recorded", async () => {
    const fixture = await engagementFixture();
    const before = await extractEngagementLearning(fixture.store, { text: GENERALIZATION });
    expect(before.text).toBe(GENERALIZATION);

    const record = await fixture.store.recordLearningOptOut(ACCEPTED_AT);
    expect(record).toMatchObject({ learningOptOut: true, optOutAt: ACCEPTED_AT });
    await expect(extractEngagementLearning(fixture.store, { text: GENERALIZATION }))
      .rejects.toMatchObject({ code: "learning_opt_out" });
  });

  test("stays prospective: accepted learning carries no link back to its engagement", async () => {
    const fixture = await sealedFixture();
    await acceptEngagementLearning({
      agentDirectory: fixture.agentDirectory,
      learning: fixture.sealed,
      artifactId: "neutral-practice-doctrine",
      acceptedAt: ACCEPTED_AT,
      acceptedBy: "neutral-owner",
    });
    await fixture.store.recordLearningOptOut(ACCEPTED_AT);

    const artifactText = await readFile(
      join(fixture.agentDirectory, "derived", "neutral-practice-doctrine", "artifact.json"),
      "utf8",
    );
    expect(artifactText).not.toContain(ENGAGEMENT_ID);
    const manifest = validateDerivedArtifactManifest(JSON.parse(artifactText));
    expect(manifest.provenance.sourceCorpusId).toBeUndefined();
    expect(manifest.provenance.sourceObjectIds).toBeUndefined();
  });

  test("refuses a draft that names its engagement", async () => {
    const fixture = await engagementFixture();
    await expect(extractEngagementLearning(fixture.store, {
      text: `${GENERALIZATION} Learned during ${ENGAGEMENT_ID}.`,
    })).rejects.toMatchObject({ code: "learning_draft_names_engagement" });
    await expect(extractEngagementLearning(fixture.store, {
      text: GENERALIZATION,
      note: `Accepted from ${ENGAGEMENT_ID}.`,
    })).rejects.toMatchObject({ code: "learning_draft_names_engagement" });
  });
});

describe("learning returns only as an accepted derived artifact", () => {
  test("refuses a draft that repeats client content verbatim", async () => {
    const fixture = await engagementFixture();
    await fixture.store.writeClientContent("client-item-0001", CLIENT_CONTENT);
    await expect(extractEngagementLearning(fixture.store, {
      text: `A durable lesson: ${CLIENT_CONTENT} That is the pattern to watch for.`,
    })).rejects.toMatchObject({ code: "learning_draft_repeats_client_content" });
  });

  test("refuses an empty draft and a draft carrying a high-confidence secret pattern", async () => {
    const fixture = await engagementFixture();
    for (const text of ["", "   ", `${GENERALIZATION} ${NEUTRAL_SECRET}`]) {
      await expect(extractEngagementLearning(fixture.store, { text }))
        .rejects.toMatchObject({ code: "learning_draft_invalid" });
    }
  });

  test("lands sealed learning as a doctrine artifact the existing contract accepts", async () => {
    const fixture = await sealedFixture();
    const receipt = await acceptEngagementLearning({
      agentDirectory: fixture.agentDirectory,
      learning: fixture.sealed,
      artifactId: "neutral-practice-doctrine",
      acceptedAt: ACCEPTED_AT,
      acceptedBy: "neutral-owner",
    });

    expect(receipt.artifactKind).toBe(LEARNING_ARTIFACT_KIND);
    const directory = join(fixture.agentDirectory, "derived", "neutral-practice-doctrine");
    const manifest = validateDerivedArtifactManifest(
      JSON.parse(await readFile(join(directory, "artifact.json"), "utf8")),
    );
    expect(manifest).toMatchObject({
      kind: "doctrine",
      artifactId: "neutral-practice-doctrine",
      acceptedAt: ACCEPTED_AT,
      acceptedBy: "neutral-owner",
    });
    expect(await readFile(join(directory, "content.md"), "utf8")).toBe(`${GENERALIZATION}\n`);

    const report = await expertStatus(fixture.agentDirectory);
    expect(report.findings.filter((finding) => finding.severity === "error")).toEqual([]);
  });

  test("refuses learning that was not sealed at the extraction gate", async () => {
    const fixture = await engagementFixture();
    await expect(acceptEngagementLearning({
      agentDirectory: fixture.agentDirectory,
      learning: { text: GENERALIZATION } as SealedEngagementLearning,
      artifactId: "neutral-practice-doctrine",
      acceptedAt: ACCEPTED_AT,
      acceptedBy: "neutral-owner",
    })).rejects.toMatchObject({ code: "learning_not_sealed" });
    await expect(readdir(join(fixture.agentDirectory, "derived"))).rejects.toThrow();
  });

  test("refuses extraction through storage this machinery did not open", async () => {
    const impostor = {
      engagementId: ENGAGEMENT_ID,
      agentId: AGENT_ID,
      writeClientContent: async () => ({ itemId: "client-item-0001", bytes: 0 }),
      readRecord: async () => ({
        schemaVersion: 1 as const,
        kind: "expert_engagement_record" as const,
        engagementId: ENGAGEMENT_ID,
        agentId: AGENT_ID,
        openedAt: OPENED_AT,
        learningOptOut: false,
      }),
      recordLearningOptOut: async () => {
        throw new Error("unreachable");
      },
      closeEngagement: async () => {
        throw new Error("unreachable");
      },
    } as unknown as EngagementStore;

    await expect(extractEngagementLearning(impostor, { text: GENERALIZATION }))
      .rejects.toMatchObject({ code: "store_not_authentic" });
  });

  test("refuses to overwrite an accepted artifact", async () => {
    const fixture = await sealedFixture();
    const acceptance = {
      agentDirectory: fixture.agentDirectory,
      learning: fixture.sealed,
      artifactId: "neutral-practice-doctrine",
      acceptedAt: ACCEPTED_AT,
      acceptedBy: "neutral-owner",
    };
    await acceptEngagementLearning(acceptance);
    await expect(acceptEngagementLearning(acceptance))
      .rejects.toMatchObject({ code: "learning_artifact_exists" });
  });

  test("refuses acceptance into a directory that is not an agent repository", async () => {
    const fixture = await sealedFixture();
    await expect(acceptEngagementLearning({
      agentDirectory: fixture.libraryDirectory,
      learning: fixture.sealed,
      artifactId: "neutral-practice-doctrine",
      acceptedAt: ACCEPTED_AT,
      acceptedBy: "neutral-owner",
    })).rejects.toMatchObject({ code: "agent_repository_invalid" });
  });

  test("reports a content-free acceptance receipt with repo-relative paths", async () => {
    const fixture = await sealedFixture();
    const receipt = await acceptEngagementLearning({
      agentDirectory: fixture.agentDirectory,
      learning: fixture.sealed,
      artifactId: "neutral-practice-doctrine",
      acceptedAt: ACCEPTED_AT,
      acceptedBy: "neutral-owner",
    });

    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(CLIENT_CONTENT);
    expect(serialized).not.toContain(ENGAGEMENT_ID);
    expect(serialized).not.toContain(fixture.agentDirectory);
    expect(receipt.files.map((file) => file.path)).toEqual([
      "derived/neutral-practice-doctrine/artifact.json",
      "derived/neutral-practice-doctrine/content.md",
    ]);
  });
});

describe("engagement end", () => {
  test("deletes client content at engagement end and reports counts only", async () => {
    const fixture = await engagementFixture();
    await fixture.store.writeClientContent("client-item-0001", CLIENT_CONTENT);
    await fixture.store.writeClientContent("client-item-0002", CLIENT_CONTENT);

    const receipt = await fixture.store.closeEngagement(CLOSED_AT);
    expect(receipt).toMatchObject({
      kind: "expert_engagement_deletion_receipt",
      engagementId: ENGAGEMENT_ID,
      closedAt: CLOSED_AT,
      removedItemCount: 2,
      contentRemaining: 0,
    });
    expect(receipt.removedByteCount).toBe(2 * new TextEncoder().encode(CLIENT_CONTENT).byteLength);
    expect(JSON.stringify(receipt)).not.toContain(CLIENT_CONTENT);
    expect(JSON.stringify(receipt)).not.toContain(fixture.engagementRoot);

    for (const text of await everyFileText(fixture.engagementRoot)) {
      expect(text).not.toContain(CLIENT_CONTENT);
    }
    expect(await readdir(fixture.engagementRoot)).toEqual([ENGAGEMENT_RECORD_FILE]);
  });

  test("refuses writes and extraction once the engagement is closed", async () => {
    const fixture = await engagementFixture();
    await fixture.store.closeEngagement(CLOSED_AT);
    await expect(fixture.store.writeClientContent("client-item-0001", CLIENT_CONTENT))
      .rejects.toMatchObject({ code: "engagement_closed" });
    await expect(extractEngagementLearning(fixture.store, { text: GENERALIZATION }))
      .rejects.toMatchObject({ code: "engagement_closed" });
    await expect(fixture.store.closeEngagement(CLOSED_AT))
      .rejects.toMatchObject({ code: "engagement_closed" });
  });
});

describe("the engagement record", () => {
  test("requires an identity the first time a storage root is used", async () => {
    await expect(openEngagementStore({
      engagementRoot: join(await temporaryDirectory(), "engagements", ENGAGEMENT_ID),
      agentDirectory: await scaffoldFixture(),
      libraryDirectory: await temporaryDirectory(),
    })).rejects.toMatchObject({ code: "engagement_record_missing" });
  });

  test("reopens existing storage from its own record", async () => {
    const fixture = await engagementFixture();
    const reopened = await openEngagementStore({
      engagementRoot: fixture.engagementRoot,
      agentDirectory: fixture.agentDirectory,
      libraryDirectory: fixture.libraryDirectory,
    });
    expect(reopened.engagementId).toBe(ENGAGEMENT_ID);
    expect(reopened.agentId).toBe(AGENT_ID);
  });

  test("refuses a malformed engagement record", async () => {
    const fixture = await engagementFixture();
    await writeFile(
      join(fixture.engagementRoot, ENGAGEMENT_RECORD_FILE),
      JSON.stringify({ schemaVersion: 1, kind: "expert_engagement_record" }),
    );
    await expect(fixture.store.readRecord()).rejects.toMatchObject({ code: "engagement_record_invalid" });
  });
});
