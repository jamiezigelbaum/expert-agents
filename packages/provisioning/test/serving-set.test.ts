import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createServingManifest,
  expertStatus,
  lintDerivedArtifactContent,
  validateAgentManifest,
  validateDerivedArtifactManifest,
  type AgentServingSet,
} from "../src/index.ts";
import {
  BASE_MANIFEST,
  NEUTRAL_SECRET,
  cleanupTemporaryRoots,
  derivedManifest,
  scaffoldFixture,
  writeDerivedArtifact,
  writeServingManifest,
} from "./serving-fixtures.ts";

afterEach(cleanupTemporaryRoots);

describe("serving set declaration", () => {
  test("keeps a manifest without a serving block valid and unchanged", () => {
    expect(validateAgentManifest(BASE_MANIFEST)).toEqual(BASE_MANIFEST);
    expect(validateAgentManifest(BASE_MANIFEST).serving).toBeUndefined();
  });

  test("accepts a well-formed allowlist with file paths and directory prefixes", () => {
    const serving: AgentServingSet = {
      include: ["AGENTS.md", "derived/", "references/notes/reading.md"],
      corpora: [
        { corpusId: "neutral-public", disclosure: "full" },
        { corpusId: "neutral-private", disclosure: "derived" },
        { corpusId: "neutral-retired", disclosure: "excluded" },
      ],
    };
    expect(validateAgentManifest({ ...BASE_MANIFEST, serving }).serving).toEqual(serving);
  });

  test("refuses every malformed include-entry class", () => {
    for (const include of [
      [],
      ["/absolute/path.md"],
      ["../escape.md"],
      ["notes/../escape.md"],
      ["notes\\windows.md"],
      ["AGENTS.md", "AGENTS.md"],
      [""],
      ["."],
      ["/"],
      ["./AGENTS.md"],
      ["notes//double.md"],
      [42],
    ]) {
      expect(() => validateAgentManifest({ ...BASE_MANIFEST, serving: { include } }))
        .toThrow("agent serving set");
    }
  });

  test("refuses each structurally excluded path at declaration time", () => {
    for (const include of [
      ["USER.md"],
      ["MEMORY.md"],
      ["memory/"],
      ["memory/daily/2026.md"],
      ["notes/MEMORY.md"],
      ["notes/USER.md"],
      ["notes/memory/"],
    ]) {
      expect(() => validateAgentManifest({ ...BASE_MANIFEST, serving: { include } }))
        .toThrow("structurally excluded path");
    }
  });

  test("refuses every excluded-class pattern from the scaffolded gitignore", () => {
    for (const include of [
      ["openclaw-workspace-state.json"],
      ["notes/openclaw-workspace-state.json"],
      ["telegram.token"],
      [".env"],
      [".env.production"],
      ["state/notes.sqlite"],
      ["sessions/"],
      ["sessions/latest.json"],
      ["transcripts/"],
      ["transcripts/2026/call.md"],
      ["memory/archive/"],
    ]) {
      expect(() => validateAgentManifest({ ...BASE_MANIFEST, serving: { include } }))
        .toThrow(/structurally excluded path|excluded-class path/);
    }
  });

  test("refuses malformed corpora declarations", () => {
    const include = ["AGENTS.md"];
    expect(() => validateAgentManifest({ ...BASE_MANIFEST, serving: { include, corpora: [] } }))
      .toThrow("non-empty array");
    expect(() => validateAgentManifest({
      ...BASE_MANIFEST,
      serving: {
        include,
        corpora: [
          { corpusId: "neutral-public", disclosure: "full" },
          { corpusId: "neutral-public", disclosure: "derived" },
        ],
      },
    })).toThrow("duplicate corpus id");
    expect(() => validateAgentManifest({
      ...BASE_MANIFEST,
      serving: { include, corpora: [{ corpusId: "neutral-public", disclosure: "partial" }] },
    })).toThrow("disclosure is invalid");
    expect(() => validateAgentManifest({
      ...BASE_MANIFEST,
      serving: { include, corpora: [{ corpusId: "Neutral Public", disclosure: "full" }] },
    })).toThrow("corpus id is invalid");
  });

  test("still refuses an unknown manifest field", () => {
    expect(() => validateAgentManifest({ ...BASE_MANIFEST, exposure: "external" }))
      .toThrow("unknown field");
  });

  test("lets a serving set carry the avatar, which no exclusion class covers", () => {
    const serving: AgentServingSet = { include: ["AGENTS.md", "avatar.png"] };
    expect(validateAgentManifest({ ...BASE_MANIFEST, avatar: "avatar.png", serving }).serving)
      .toEqual(serving);
  });
});

describe("serving manifest identity", () => {
  const manifest = validateAgentManifest({ ...BASE_MANIFEST, avatar: "avatar.png" });

  test("names the avatar once the serving set materialized it", () => {
    expect(createServingManifest(manifest, "v0.1.0", [], ["AGENTS.md", "avatar.png"]).avatar)
      .toBe("avatar.png");
  });

  test("omits an avatar the artifact does not contain", () => {
    expect(createServingManifest(manifest, "v0.1.0", [], ["AGENTS.md"]).avatar).toBeUndefined();
    expect(createServingManifest(
      validateAgentManifest(BASE_MANIFEST),
      "v0.1.0",
      [],
      ["AGENTS.md", "avatar.png"],
    ).avatar).toBeUndefined();
  });
});

describe("derived artifact contract", () => {
  test("accepts a doctrine without a corpus and a distillation naming one", () => {
    const doctrine = derivedManifest("neutral-doctrine", "doctrine");
    expect(validateDerivedArtifactManifest(doctrine)).toEqual(doctrine);
    const distillation = derivedManifest("neutral-distillation", "distillation", "neutral-private");
    expect(validateDerivedArtifactManifest(distillation)).toEqual(distillation);
  });

  test("refuses a distillation that names no corpus", () => {
    expect(() => validateDerivedArtifactManifest(derivedManifest("neutral-distillation", "distillation")))
      .toThrow("must name the corpus");
  });

  test("refuses a manifest that references a path outside its own directory", () => {
    expect(() => validateDerivedArtifactManifest({
      ...derivedManifest("neutral-doctrine", "doctrine"),
      provenance: { note: "derived from ../neutral-other/content.md" },
    })).toThrow("outside its own directory");
  });

  test("refuses an unsupported acceptance instant and an unknown field", () => {
    expect(() => validateDerivedArtifactManifest({
      ...derivedManifest("neutral-doctrine", "doctrine"),
      acceptedAt: "2026-07-28",
    })).toThrow("ISO-8601 UTC instant");
    expect(() => validateDerivedArtifactManifest({
      ...derivedManifest("neutral-doctrine", "doctrine"),
      acceptedFrom: "somewhere",
    })).toThrow("unknown field");
  });

  test("refuses empty content and content carrying a secret pattern", () => {
    expect(lintDerivedArtifactContent("A bounded neutral doctrine.\n").valid).toBe(true);
    expect(lintDerivedArtifactContent("   \n").findings).toContainEqual({
      ruleId: "derived.content_non_empty",
      severity: "error",
    });
    expect(lintDerivedArtifactContent(`Never include ${NEUTRAL_SECRET}.\n`).findings).toContainEqual({
      ruleId: "derived.content_secret_pattern",
      severity: "error",
    });
  });
});

describe("serving status findings", () => {
  test("warns on a missing path and an unrepresented derived corpus without failing status", async () => {
    const directory = await scaffoldFixture();
    await writeServingManifest(directory, {
      include: ["AGENTS.md", "references/sentinel-serving-path.md"],
      corpora: [{ corpusId: "neutral-private", disclosure: "derived" }],
    });

    const report = await expertStatus(directory, { gitPath: null });
    expect(report.valid).toBe(true);
    expect(report.findings).toContainEqual({
      file: "agent.json",
      ruleId: "agent.serving.missing_path",
      severity: "warning",
    });
    expect(report.findings).toContainEqual({
      file: "agent.json",
      ruleId: "agent.serving.derived_without_artifact",
      severity: "warning",
    });
    const bytes = JSON.stringify(report);
    expect(bytes).not.toContain("sentinel-serving-path");
    expect(bytes).not.toContain("neutral-private");
  });

  test("clears both warnings once the path exists and the distillation is accepted", async () => {
    const directory = await scaffoldFixture();
    await writeDerivedArtifact(directory, "neutral-distillation", "distillation", "neutral-private");
    await writeServingManifest(directory, {
      include: ["AGENTS.md", "derived/"],
      corpora: [{ corpusId: "neutral-private", disclosure: "derived" }],
    });

    const report = await expertStatus(directory, { gitPath: null });
    expect(report.valid).toBe(true);
    expect(report.findings).toEqual([]);
  });

  test("treats an invalid derived artifact as a content-free hard error", async () => {
    const directory = await scaffoldFixture();
    await writeDerivedArtifact(directory, "neutral-distillation", "distillation", "neutral-private");
    await writeFile(
      join(directory, "derived/neutral-distillation/content.md"),
      `Sentinel ${NEUTRAL_SECRET} content.\n`,
    );

    const report = await expertStatus(directory, { gitPath: null });
    expect(report.valid).toBe(false);
    expect(report.findings).toContainEqual({
      file: "derived",
      ruleId: "derived.content_secret_pattern",
      severity: "error",
    });
    const bytes = JSON.stringify(report);
    expect(bytes).not.toContain(NEUTRAL_SECRET);
    expect(bytes).not.toContain("neutral-distillation");
  });
});
