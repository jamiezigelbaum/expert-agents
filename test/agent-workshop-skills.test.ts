import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { ownerWordsIn } from '../packages/provisioning/src/owner-names.ts';

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
    const skill = await readFile("skills/expert-agent-workshop/SKILL.md", "utf8");
    for (const required of [
      "bun run expert:create",
      "soul-workshop",
      "scope-manifest.json",
      "bun run library:materialize",
      "bun run library:annotate",
      "bun run retrieval:eval",
      "action=catalog",
      "EXPERT_AGENTS_DOMAIN_EXPERT_AGENTS_JSON",
    ]) {
      expect(skill).toContain(required);
    }
    expect(skill).not.toContain("experts/<id>");
  });

  test("agent workshop runs an identity ceremony before the scaffold", async () => {
    const skill = await readFile("skills/expert-agent-workshop/SKILL.md", "utf8");
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
    const skill = await readFile("skills/expert-agent-workshop/SKILL.md", "utf8");
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
      readFile("skills/expert-agent-workshop/SKILL.md", "utf8"),
      readFile("skills/soul-workshop/SKILL.md", "utf8"),
    ]);
    expect(skills.flatMap((skill) => ownerWordsIn(skill))).toEqual([]);
  });
});
