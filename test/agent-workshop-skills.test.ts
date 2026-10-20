import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { ownerWordsIn } from '../packages/provisioning/src/owner-names.ts';
import { FACTORY_FAILURE_CATEGORIES, FACTORY_PHASES } from '../packages/provisioning/src/factory.ts';

const WORKSHOP = "skills/expert-agent-workshop";
// The procedure plus the bundled references it points to.
async function workshopText(): Promise<string> {
  const parts = await Promise.all(["SKILL.md", "references/guided-workshop.md", "references/checkout-workflow.md"]
    .map((file) => readFile(`${WORKSHOP}/${file}`, "utf8")));
  return parts.join("\n");
}

describe("agent workshop skills", () => {
  test("packages the soul workshop in the skill manifest", async () => {
    const manifest = JSON.parse(await readFile("skills/manifest.json", "utf8")) as {
      skills: string[];
    };
    expect(manifest.skills).toContain("soul-workshop");
    expect(manifest.skills).toEqual([...manifest.skills].sort());
  });

  test("soul workshop requires preview, acceptance, agent-repo writes, and lint", async () => {
    const skill = await readFile("skills/soul-workshop/SKILL.md", "utf8");
    expect(skill).toContain("**PREVIEW**");
    expect(skill).toContain("explicit acceptance");
    expect(skill).toContain("<agent-repo>/SOUL.md");
    expect(skill).toContain("bun run expert:status");
    expect(skill).toContain("git -C <agent-repo> fetch");
    expect(skill).toContain("--require-sync");
    expect(skill).toContain("refuse to interview or draft");
    expect(skill).toContain("reach the live workspace by pull");
    expect(skill).toContain("next session start");
    expect(skill).toContain("20,000 characters");
    expect(skill).toContain("first person versus second person");
  });

  test("agent workshop uses the independent repository factory flow", async () => {
    const skill = await workshopText();
    for (const required of [
      "bun run expert:create",
      "soul-workshop",
      "library_ingest",
      "bun run library:pages",
      "bun run library:index",
      "action=catalog",
      "EXPERT_AGENTS_DOMAIN_EXPERT_AGENTS_JSON",
    ]) {
      expect(skill).toContain(required);
    }
    expect(skill).not.toContain("experts/<id>");
    // New agents read the page library; the workshop names no Vertex machinery.
    expect(skill).not.toMatch(/Vertex|rag_corpus|domain_ask|domain_read|scope-manifest|--target-corpus|library:materialize/);
  });

  test("agent workshop runs an identity ceremony before the scaffold", async () => {
    const skill = await workshopText();
    for (const heading of [
      "## Identity ceremony",
      "### 1. Brain dump",
      "### 2. Name suggestions",
      "### 3. Avatar suggestions",
      "### 4. Messaging identity",
      "## Assembly order",
      "## Ready-to-populate report",
    ]) {
      expect(skill).toContain(heading);
    }
    // The ceremony is the owner's; every step names its refusal to guess.
    expect(skill).toContain("**verbatim**");
    expect(skill).toContain("3-5 candidate names");
    expect(skill).toContain("valid agent id");
    expect(skill).toContain("AT LEAST THREE candidate avatar images per round");
    expect(skill).toContain("feedback starts a NEW round");
    expect(skill).toContain("--avatar");
    expect(skill).toContain("no image tool is available");
    expect(skill).toContain("accepted and written");
    expect(skill).toContain("never pasted into chat or logs");
    expect(skill).toContain("Report only what a tool result actually shows");
  });

  test("messaging identity is provisioned by owner confirmation, never by account automation", async () => {
    const skill = await workshopText();
    for (const required of [
      "bun run expert:telegram-provision",
      // Pinned across the line wrap so the whole sentence stays intact.
      "one tap creates the bot; this tap is the owner's deliberate\ngate — no agent ever operates the owner's Telegram account.",
      // The receipt is the source of truth for the recorded identity, because
      // the owner can edit the suggested username during the confirmation.
      "the username from that receipt",
      "binding.json",
      "--rotate",
      "bot-management mode enabled",
      "deployment's secret store",
      "never passed as a\ncommand-line argument",
      "No-automation fallback",
    ]) {
      expect(skill).toContain(required);
    }
    // The rejected posture must not creep back in.
    expect(skill).not.toContain("messaging-automation capability");
    expect(skill).not.toContain("drive the platform's bot-creation");
  });

  test("workshop skill text is tenant-neutral", async () => {
    const skills = await Promise.all([
      workshopText(),
      readFile("skills/soul-workshop/SKILL.md", "utf8"),
      readFile("skills/domain-research/SKILL.md", "utf8"),
    ]);
    expect(skills.flatMap((skill) => ownerWordsIn(skill))).toEqual([]);
  });

  test("the workshop procedure stays under 10,000 characters and links its references", async () => {
    const skill = await readFile(`${WORKSHOP}/SKILL.md`, "utf8");
    expect(skill.length).toBeLessThan(10_000);
    expect(skill).toContain("`references/guided-workshop.md`");
    expect(skill).toContain("`references/checkout-workflow.md`");
  });

  test("the workshop carries the launch procedure", async () => {
    const skill = (await readFile(`${WORKSHOP}/SKILL.md`, "utf8")).replace(/\s+/g, " ");
    for (const required of [
      "Pre-flight, before the first create",
      "the new bot stays silent until activation",
      "about five minutes",
      "Resume only in the owner's own turn",
      "do not resume from that completion turn",
      "ask them to say go",
      "never start a second agent, library or operation",
      "`operations/<agent_id>/state.json`",
      "read (never edit)",
      "a session that has that tool",
      "The real test is the owner messaging the bot",
    ]) {
      expect(skill).toContain(required);
    }
  });

  test("the workshop's phase table is exactly the phases the factory records, in order", async () => {
    const skill = await readFile(`${WORKSHOP}/SKILL.md`, "utf8");
    const rows = [...skill.matchAll(/^\s*\| `([a-z_]+)` \|/gm)].map((match) => match[1]);
    expect(rows).toEqual([...FACTORY_PHASES]);
  });

  test("the workshop names exactly the factory's failure categories", async () => {
    const skill = (await readFile(`${WORKSHOP}/SKILL.md`, "utf8")).replace(/\s+/g, " ");
    const listed = /`category` \(([^)]*)\)/.exec(skill)?.[1]?.match(/`([a-z_]+)`/g)?.map((name) => name.slice(1, -1));
    expect(listed).toEqual([...FACTORY_FAILURE_CATEGORIES]);
  });

  test("every factory error code the workshop names is one the code produces", async () => {
    const skill = await readFile(`${WORKSHOP}/SKILL.md`, "utf8");
    const sources = (await Promise.all(["packages/provisioning/src/factory.ts", "scripts/expert-factory.ts", "src/factory-tool.ts"]
      .map((file) => readFile(file, "utf8")))).join("\n");
    const named = [...new Set(skill.match(/\bfactory_[a-z_]+\b/g) ?? [])];
    expect(named.length).toBeGreaterThan(3);
    for (const code of named) expect(sources).toContain(`'${code}'`);
  });
});
