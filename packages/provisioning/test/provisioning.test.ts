import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerWordsIn } from "../src/owner-names.ts";
import {
  AGENT_REPO_GITIGNORE,
  AVATAR_MAX_BYTES,
  ISSUE_TRACKER_PLACEHOLDER,
  SOUL_CHARACTER_LIMIT,
  BINDING_CHECKLIST_FILE,
  BINDING_DESCRIPTOR_FILE,
  BINDING_RECEIPT_FILE,
  emitBindingArtifacts,
  expertStatus,
  lintSoul,
  scaffoldExpert,
  serializeCreationReceipt,
  validateAgentManifest,
  validateBindingManifest,
  verifyBindingConfig,
  type AgentBindingManifest,
  type ExpertScaffoldOptions,
} from "../src/index.ts";

const TINY_PNG_BASE64
  = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const temporaryRoots: string[] = [];

// The git-state test below builds three fixture repositories and reads each
// back through expertStatus, so it drives dozens of real git subprocesses. On a
// host already running other builds that multiplies well past bun's 5 s default
// and turns a passing suite red. The bound is deliberately generous: it is here
// to catch a hang, not to police duration.
const SUBPROCESS_TIMEOUT_MS = 60_000;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent repository contract", () => {
  test("accepts a complete scaffold fixture", async () => {
    const directory = await scaffoldFixture();
    const report = await expertStatus(directory);

    expect(report.valid).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.items).toHaveLength(11);
    expect(report.items.every((item) => item.present && item.valid)).toBe(true);
  });

  test("rejects a missing required workspace file", async () => {
    const directory = await scaffoldFixture();
    await unlink(join(directory, "TOOLS.md"));

    const report = await expertStatus(directory);
    expect(report.valid).toBe(false);
    expect(report.findings).toContainEqual({
      file: "TOOLS.md",
      ruleId: "contract.required",
      severity: "error",
    });
  });

  test("rejects agent and scope identity mismatches", async () => {
    const directory = await scaffoldFixture();
    const path = join(directory, "library/scope-manifest.json");
    const scope = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    scope.agentId = "other-agent";
    scope.targetCorpusDisplayName = "other-corpus";
    await writeFile(path, `${JSON.stringify(scope, null, 2)}\n`);

    const report = await expertStatus(directory);
    expect(report.valid).toBe(false);
    expect(report.findings).toContainEqual({
      file: "agent.json",
      ruleId: "consistency.agent_id",
      severity: "error",
    });
    expect(report.findings).toContainEqual({
      file: "agent.json",
      ruleId: "consistency.target_corpus",
      severity: "error",
    });
  });

  test("rejects invalid scope and retrieval eval documents", async () => {
    const scopeDirectory = await scaffoldFixture();
    await writeFile(
      join(scopeDirectory, "library/scope-manifest.json"),
      '{"schemaVersion":1,"invalid":true}\n',
    );
    const scopeReport = await expertStatus(scopeDirectory);
    expect(scopeReport.findings).toContainEqual({
      file: "library/scope-manifest.json",
      ruleId: "scope.schema",
      severity: "error",
    });

    const evalDirectory = await scaffoldFixture();
    await writeFile(
      join(evalDirectory, "library/eval-questions.json"),
      '{"schemaVersion":1,"domainId":"neutral-domain","thresholds":{},"questions":[]}\n',
    );
    const evalReport = await expertStatus(evalDirectory);
    expect(evalReport.findings).toContainEqual({
      file: "library/eval-questions.json",
      ruleId: "eval.schema",
      severity: "error",
    });
  });

  test("validates agent manifest fields strictly", () => {
    const value = {
      schemaVersion: 1,
      agentId: "neutral-agent",
      displayName: "Neutral Agent",
      domainId: "neutral-domain",
      targetCorpusDisplayName: "neutral-corpus",
    } as const;
    expect(validateAgentManifest(value)).toEqual(value);
    expect(() => validateAgentManifest({ ...value, unexpected: true })).toThrow("unknown field");
    expect(() => validateAgentManifest({ ...value, agentId: "Not Stable" })).toThrow("is invalid");
  });

  test("accepts an optional avatar and keeps a manifest without one unchanged", () => {
    const base = {
      schemaVersion: 1,
      agentId: "neutral-agent",
      displayName: "Neutral Agent",
      domainId: "neutral-domain",
      targetCorpusDisplayName: "neutral-corpus",
    } as const;
    expect(validateAgentManifest(base).avatar).toBeUndefined();
    for (const avatar of ["avatar.png", "references/avatar.webp", "avatar.JPEG"]) {
      expect(validateAgentManifest({ ...base, avatar }).avatar).toBe(avatar);
    }
  });

  test("refuses an avatar that is not a repo-relative file path", () => {
    const base = {
      schemaVersion: 1,
      agentId: "neutral-agent",
      displayName: "Neutral Agent",
      domainId: "neutral-domain",
      targetCorpusDisplayName: "neutral-corpus",
    } as const;
    for (const avatar of ["/etc/avatar.png", "~/avatar.png", "../avatar.png", "art/../avatar.png"]) {
      expect(() => validateAgentManifest({ ...base, avatar }))
        .toThrow("agent manifest avatar must be a repo-relative POSIX path");
    }
    expect(() => validateAgentManifest({ ...base, avatar: "art\\avatar.png" }))
      .toThrow("repo-relative POSIX path");
    expect(() => validateAgentManifest({ ...base, avatar: "art/" }))
      .toThrow("must name a file, not a directory");
    for (const avatar of ["", "  avatar.png", 42]) {
      expect(() => validateAgentManifest({ ...base, avatar })).toThrow("agent manifest avatar");
    }
  });

  test("refuses an avatar hidden in a path class that may never ship", () => {
    const base = {
      schemaVersion: 1,
      agentId: "neutral-agent",
      displayName: "Neutral Agent",
      domainId: "neutral-domain",
      targetCorpusDisplayName: "neutral-corpus",
    } as const;
    for (const avatar of [
      "memory/avatar.png",
      "media/avatar.png",
      "sessions/avatar.png",
      ".openclaw/avatar.png",
    ]) {
      expect(() => validateAgentManifest({ ...base, avatar }))
        .toThrow("may never reach a served deployment");
    }
  });
});

describe("binding manifest validation", () => {
  const binding: AgentBindingManifest = {
    schemaVersion: 1,
    openclaw: {
      agentId: "neutral-agent",
      workspacePath: "/srv/agents/neutral-agent",
    },
    telegram: {
      botUsername: "@neutral_bot",
      tokenFilePath: "/run/secrets/telegram-neutral-agent.token",
      dmPolicy: "owner-allowlist",
      groupTopics: [{ topicId: 42, note: "Operator-approved topic" }],
    },
  };

  test("accepts a valid optional binding manifest", async () => {
    expect(validateBindingManifest(binding)).toEqual(binding);
    const directory = await scaffoldFixture();
    await writeFile(join(directory, "binding.json"), `${JSON.stringify(binding, null, 2)}\n`);

    const report = await expertStatus(directory);
    expect(report.valid).toBe(true);
    expect(report.items).toContainEqual({
      path: "binding.json",
      kind: "file",
      present: true,
      parsed: true,
      valid: true,
    });
  });

  test("rejects a binding agent id mismatch", async () => {
    const directory = await scaffoldFixture();
    await writeFile(
      join(directory, "binding.json"),
      `${JSON.stringify({ ...binding, openclaw: { agentId: "other-agent" } }, null, 2)}\n`,
    );

    const report = await expertStatus(directory);
    expect(report.valid).toBe(false);
    expect(report.findings).toContainEqual({
      file: "binding.json",
      ruleId: "consistency.agent_id",
      severity: "error",
    });
  });

  test("rejects a bad Telegram bot username", () => {
    expect(() => validateBindingManifest({
      ...binding,
      telegram: { ...binding.telegram, botUsername: "neutral-agent" },
    })).toThrow("bot username is invalid");
  });

  test("accepts the same case-insensitive 5-32 character usernames as Telegram provisioning", () => {
    for (const botUsername of ["@AbBot", "@NeutralExpertBot", `@${"a".repeat(29)}BOT`]) {
      expect(validateBindingManifest({ ...binding, telegram: { ...binding.telegram, botUsername } }).telegram?.botUsername)
        .toBe(botUsername);
    }
    for (const botUsername of ["@abot", `@${"a".repeat(30)}bot`, "@1neutralbot"]) {
      expect(() => validateBindingManifest({ ...binding, telegram: { ...binding.telegram, botUsername } }))
        .toThrow("bot username is invalid");
    }
  });

  test("rejects a relative Telegram token file path", () => {
    expect(() => validateBindingManifest({
      ...binding,
      telegram: { ...binding.telegram, tokenFilePath: "secrets/token" },
    })).toThrow("token file path must be absolute or ~/-prefixed");
  });

  test("accepts a home-relative Telegram token file path", () => {
    expect(() => validateBindingManifest({
      ...binding,
      telegram: { ...binding.telegram, tokenFilePath: "~/.gateway/secrets/neutral-agent.token" },
    })).not.toThrow();
  });
});

describe("binding artifact emission", () => {
  test("emits deterministic descriptor, checklist, and content-free receipt", async () => {
    const firstAgent = await scaffoldFixture();
    const secondAgent = await scaffoldFixture();
    await writeBinding(firstAgent);
    await writeBinding(secondAgent);
    const firstOutput = join(await temporaryDirectory(), "bindings");
    const secondOutput = join(await temporaryDirectory(), "bindings");

    const first = await emitBindingArtifacts(firstAgent, firstOutput);
    const second = await emitBindingArtifacts(secondAgent, secondOutput);

    expect(first.descriptor).toEqual(second.descriptor);
    expect(first.checklist).toBe(second.checklist);
    expect(first.receipt).toEqual(second.receipt);
    expect(first.descriptor.routing).toEqual({
      domainId: "neutral-domain",
      targetCorpusDisplayName: "neutral-corpus",
    });
    expect(first.checklist).toContain("[MANUAL] Talk to @BotFather");
    expect(first.checklist).toContain("[MANUAL] Provision the Telegram token file");
    expect(first.checklist).toContain("agents.list[]");
    expect(first.checklist).toContain("bindings[]");
    expect(first.checklist).toContain("channels.telegram.accounts.<id>.botToken");
    expect(first.checklist).toContain("openclaw docs");
    expect(first.checklist).toContain("config.schema.lookup");
    expect(first.checklist).toContain("openclaw config set");
    expect(first.checklist).toContain("config.patch");
    expect(first.checklist).toContain("## ROLLBACK");
    expect((await readdir(firstOutput)).sort()).toEqual([
      BINDING_CHECKLIST_FILE,
      BINDING_RECEIPT_FILE,
      BINDING_DESCRIPTOR_FILE,
    ]);
    expect(JSON.parse(await readFile(join(firstOutput, BINDING_RECEIPT_FILE), "utf8")))
      .toEqual(first.receipt);
    expect(JSON.stringify(first.receipt)).not.toContain("Neutral Agent");
    expect(JSON.stringify(first.receipt)).not.toContain("neutral-domain");
  });

  test("never copies a fixture token value into descriptor checklist or receipt bytes", async () => {
    const directory = await scaffoldFixture();
    const tokenFilePath = join(directory, "fixture-telegram-token");
    const tokenValue = ["fixture", "telegram", "credential", "must", "not", "escape"].join("-");
    await writeFile(tokenFilePath, `${tokenValue}\n`);
    await writeFile(join(directory, "binding.json"), `${JSON.stringify({
      schemaVersion: 1,
      openclaw: { agentId: "neutral-agent" },
      telegram: {
        tokenFilePath,
        dmPolicy: "owner-allowlist",
      },
    })}\n`);
    const output = join(await temporaryDirectory(), "bindings");

    await emitBindingArtifacts(directory, output);
    for (const path of [BINDING_DESCRIPTOR_FILE, BINDING_CHECKLIST_FILE, BINDING_RECEIPT_FILE]) {
      expect(await readFile(join(output, path), "utf8")).not.toContain(tokenValue);
    }
  });
});

describe("binding config verification", () => {
  test("reports all declared identifiers present without returning their values", async () => {
    const directory = await scaffoldFixture();
    await writeBinding(directory, "@neutral_bot");
    const config = join(await temporaryDirectory(), "gateway-config.txt");
    await writeFile(
      config,
      "agent neutral-agent bot @neutral_bot token /run/secrets/telegram-neutral-agent.token\n",
    );

    const report = await verifyBindingConfig(directory, config);
    expect(report.valid).toBe(true);
    expect(report.identifiers).toEqual([
      { identifier: "agentId", found: true },
      { identifier: "botUsername", found: true },
      { identifier: "tokenFilePath", found: true },
    ]);
    const bytes = JSON.stringify(report);
    expect(bytes).not.toContain("neutral-agent");
    expect(bytes).not.toContain("@neutral_bot");
    expect(bytes).not.toContain("/run/secrets");
  });

  test("reports a declared bot username missing", async () => {
    const directory = await scaffoldFixture();
    await writeBinding(directory, "@neutral_bot");
    const config = join(await temporaryDirectory(), "gateway-config.txt");
    await writeFile(config, "agent neutral-agent token /run/secrets/telegram-neutral-agent.token\n");

    const report = await verifyBindingConfig(directory, config);
    expect(report.valid).toBe(false);
    expect(report.identifiers).toContainEqual({ identifier: "botUsername", found: false });
  });

  test("requires the agent id as a bounded identifier", async () => {
    const directory = await scaffoldFixture();
    await writeBinding(directory);
    const config = join(await temporaryDirectory(), "gateway-config.txt");
    await writeFile(config, "agent other-neutral-agent-extra token /run/secrets/telegram-neutral-agent.token\n");

    const report = await verifyBindingConfig(directory, config);
    expect(report.valid).toBe(false);
    expect(report.identifiers).toContainEqual({ identifier: "agentId", found: false });
  });

  test("fails clearly when binding.json is absent", async () => {
    const directory = await scaffoldFixture();
    await unlink(join(directory, "binding.json"));
    const config = join(await temporaryDirectory(), "gateway-config.txt");
    await writeFile(config, "operator supplied\n");

    await expect(verifyBindingConfig(directory, config)).rejects.toThrow("binding.json is required");
  });
});

describe("soul lint", () => {
  test("warns when the character cap is exceeded", () => {
    const result = lintSoul(`${"a".repeat(SOUL_CHARACTER_LIMIT + 1)}\n\n*Notify the owner on change.*\n`);
    expect(result.valid).toBe(true);
    expect(result.findings).toContainEqual({ ruleId: "soul.max_chars", severity: "warning" });
  });

  test("warns when the final non-empty line is not italic", () => {
    const result = lintSoul("A bounded draft.\nNo footer.\n");
    expect(result.valid).toBe(true);
    expect(result.findings).toContainEqual({ ruleId: "soul.notify_footer", severity: "warning" });
  });

  test("hard-fails on a high-confidence secret pattern", () => {
    const secret = `AKIA${"A".repeat(16)}`;
    const result = lintSoul(`Never include ${secret}.\n\n*Notify the owner on change.*\n`);
    expect(result.valid).toBe(false);
    expect(result.findings).toContainEqual({ ruleId: "soul.secret_pattern", severity: "error" });
  });
});

describe("expert scaffold", () => {
  test("is deterministic and emits a correct content-free receipt", async () => {
    const firstDirectory = await temporaryDirectory();
    const secondDirectory = await temporaryDirectory();
    const first = await scaffoldExpert(scaffoldOptions(firstDirectory));
    const second = await scaffoldExpert(scaffoldOptions(secondDirectory));

    expect(serializeCreationReceipt(first.receipt)).toBe(serializeCreationReceipt(second.receipt));
    expect(first.receipt.directories).toEqual(["library", "references"]);
    expect(await readFile(join(firstDirectory, ".gitignore"), "utf8")).toBe(
      AGENT_REPO_GITIGNORE,
    );
    expect(AGENT_REPO_GITIGNORE.split("\n").filter((line) => !line.startsWith("#") && line !== ""))
      .toEqual([
        "openclaw-workspace-state.json",
        "*.token",
        ".env",
        ".env.*",
        "*.sqlite",
        "sessions/",
        "transcripts/",
        "memory/archive/",
        ".secrets/",
        ".openclaw/",
        ".openclaw-cli-images/",
        "media/",
        ".cache/",
        "node_modules/",
      ]);
    expect(first.receipt.files.map((file) => file.path)).toContain(".gitignore");
    for (const file of first.receipt.files) {
      const bytes = await readFile(join(firstDirectory, file.path));
      expect(file.bytes).toBe(bytes.byteLength);
      expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
    const receiptBytes = serializeCreationReceipt(first.receipt);
    expect(receiptBytes).not.toContain("Neutral Agent");
    expect(receiptBytes).not.toContain("neutral-domain");
  });

  test("refuses a non-empty target directory", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "existing.txt"), "occupied\n");
    await expect(scaffoldExpert(scaffoldOptions(directory))).rejects.toThrow(
      "target directory must be empty",
    );
  });

  test("fills every template placeholder and keeps templates tenant-neutral", async () => {
    const directory = await scaffoldFixture();
    for (const path of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "TOOLS.md", "USER.md", "HEARTBEAT.md"]) {
      expect(await readFile(join(directory, path), "utf8")).not.toContain("{{");
    }

    const templatesDirectory = join(import.meta.dir, "../templates");
    for (const path of await readdir(templatesDirectory)) {
      expect(ownerWordsIn(await readFile(join(templatesDirectory, path), "utf8"))).toEqual([]);
    }
  });

  test("ignores runtime secret material and local caches from birth, and says why", async () => {
    const directory = await scaffoldFixture();
    const gitignore = await readFile(join(directory, ".gitignore"), "utf8");

    const why = gitignore.split("\n").filter((line) => line.startsWith("#"));
    expect(why).toHaveLength(1);
    expect(why[0]).toContain("secret material or local caches");
    for (const entry of [".secrets/", ".openclaw/", ".openclaw-cli-images/", "media/"]) {
      expect(gitignore.split("\n")).toContain(entry);
    }
    expect(gitignore.split("\n")).toContain("openclaw-workspace-state.json");
  });

  test("seeds the harness-discipline digest and the close-out section", async () => {
    const directory = await scaffoldFixture();
    const agents = await readFile(join(directory, "AGENTS.md"), "utf8");

    expect(agents).toContain("## Harness discipline");
    expect(agents).toContain("## Closing out");
    expect(agents).toContain("overrides any softer guidance");
    expect(agents).toContain("never an implementer");
    expect(agents).toContain("Never hand-patch a live system");
    expect(agents).toContain("Name the file and the commit id");
    expect(agents).toContain("When a commit was not possible");
    // The escalation target is deployment configuration; an unconfigured
    // scaffold must show the gap rather than inherit somebody's repository.
    expect(agents).toContain(ISSUE_TRACKER_PLACEHOLDER);
    expect(agents).not.toContain("github.com");
  });

  // An agent that cannot connect "get me this book" to the acquisition skill,
  // or does not know which corpus is its own, asks the owner for both. The
  // scaffold states them once, at birth.
  test("seeds the acquisition mechanics and names the agent's own library corpus", async () => {
    const directory = await scaffoldFixture();
    const agents = await readFile(join(directory, "AGENTS.md"), "utf8");

    expect(agents).toContain("## How acquisition works");
    expect(agents).toContain("expert-annas-archive-acquisition");
    expect(agents).toContain("annas_archive_search");
    expect(agents).toContain("annas_archive_import");
    expect(agents).toContain("Never substitute the open web");
    expect(agents).toContain("Your library corpus is `neutral-corpus`");
    expect(agents).toContain("no `corpus_id` lands there by default");
    // The pre-existing posture section stays, and stays free of the shell
    // escaping that once leaked into it.
    expect(agents).toContain("## Acquisition posture");
    expect(agents).toContain("acquisition skill's two-mode policy");
    expect(agents).not.toContain("'\\''");
  });

  test("renders the configured escalation channel and refuses unusable ones", async () => {
    const directory = await temporaryDirectory();
    await scaffoldExpert({
      ...scaffoldOptions(directory),
      issueTracker: "the neutral-domain issue tracker declared by this deployment",
    });

    const agents = await readFile(join(directory, "AGENTS.md"), "utf8");
    expect(agents).toContain("the neutral-domain issue tracker declared by this deployment");
    expect(agents).not.toContain(ISSUE_TRACKER_PLACEHOLDER);

    for (const issueTracker of ["", "  padded ", "two\nlines", "{{injected}}"]) {
      await expect(scaffoldExpert({
        ...scaffoldOptions(await temporaryDirectory()),
        issueTracker,
      })).rejects.toThrow();
    }
  });

  test("writes a starter Telegram binding only for an absolute token path reference", async () => {
    const directory = await temporaryDirectory();
    const result = await scaffoldExpert({
      ...scaffoldOptions(directory),
      telegramTokenFilePath: "/run/secrets/telegram-neutral-agent.token",
    });

    expect(result.binding).toEqual({
      schemaVersion: 1,
      openclaw: { agentId: "neutral-agent" },
      telegram: {
        tokenFilePath: "/run/secrets/telegram-neutral-agent.token",
        dmPolicy: "owner-allowlist",
      },
    });
    expect(JSON.parse(await readFile(join(directory, "binding.json"), "utf8")))
      .toEqual(result.binding);
    await expect(scaffoldExpert({
      ...scaffoldOptions(await temporaryDirectory()),
      telegramTokenFilePath: "relative/token-file",
    })).rejects.toThrow("token file path must be absolute");
  });

  test("copies a supplied avatar into the scaffold and names it in the manifest", async () => {
    const directory = await temporaryDirectory();
    const bytes = tinyPngBytes();
    const result = await scaffoldExpert({
      ...scaffoldOptions(directory),
      avatar: { extension: "png", bytes },
    });

    expect(result.manifest.avatar).toBe("avatar.png");
    expect(JSON.parse(await readFile(join(directory, "agent.json"), "utf8")).avatar)
      .toBe("avatar.png");
    expect(Uint8Array.from(await readFile(join(directory, "avatar.png")))).toEqual(bytes);
    expect(result.receipt.files).toContainEqual({
      path: "avatar.png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
    });
    expect((await expertStatus(directory, { gitPath: null })).valid).toBe(true);
  });

  test("scaffolds no avatar field at all when none is supplied", async () => {
    const directory = await scaffoldFixture();
    const manifest = JSON.parse(await readFile(join(directory, "agent.json"), "utf8"));
    expect(Object.hasOwn(manifest, "avatar")).toBe(false);
    await expect(readFile(join(directory, "avatar.png"))).rejects.toThrow();
  });

  test("refuses an unsupported avatar format and an oversized image", async () => {
    await expect(scaffoldExpert({
      ...scaffoldOptions(await temporaryDirectory()),
      avatar: { extension: "gif" as never, bytes: tinyPngBytes() },
    })).rejects.toThrow("avatar image format is unsupported");
    await expect(scaffoldExpert({
      ...scaffoldOptions(await temporaryDirectory()),
      avatar: { extension: "png", bytes: new Uint8Array(AVATAR_MAX_BYTES + 1) },
    })).rejects.toThrow("avatar image exceeds the avatar size limit");
    await expect(scaffoldExpert({
      ...scaffoldOptions(await temporaryDirectory()),
      avatar: { extension: "png", bytes: new Uint8Array(0) },
    })).rejects.toThrow("avatar image is empty");
  });
});

describe("expert status safety", () => {
  test("never includes soul content in report bytes", async () => {
    const directory = await scaffoldFixture();
    const sentinel = "sentinel-private-soul-fragment";
    await writeFile(join(directory, "SOUL.md"), `${sentinel}\n\n*Notify the owner on change.*\n`);

    const reportBytes = JSON.stringify(await expertStatus(directory));
    expect(reportBytes).not.toContain(sentinel);
  });

  test("treats a secret-pattern soul finding as a content-free hard error", async () => {
    const directory = await scaffoldFixture();
    const secret = `AKIA${"B".repeat(16)}`;
    await writeFile(join(directory, "SOUL.md"), `${secret}\n\n*Notify the owner on change.*\n`);

    const report = await expertStatus(directory);
    expect(report.valid).toBe(false);
    expect(report.findings).toContainEqual({
      file: "SOUL.md",
      ruleId: "soul.secret_pattern",
      severity: "error",
    });
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  test("returns a null git section when git is unavailable", async () => {
    const directory = await scaffoldFixture();
    const report = await expertStatus(directory, { gitPath: null });

    expect(report.valid).toBe(true);
    expect(report.git).toBeNull();
  });
});

describe("expert status git state", () => {
  test.skipIf(Bun.which("git") === null)(
    "reports local divergence and worktree counts without identifier values",
    async () => {
      const gitPath = Bun.which("git")!;
      const { directory, upstream } = await initializeSyncedGitFixture(gitPath);

      const clean = await expertStatus(directory);
      expect(clean.git).toEqual({
        isRepo: true,
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        dirtyTrackedCount: 0,
        untrackedCount: 0,
      });
      expect(Object.keys(clean.git!).sort()).toEqual([
        "aheadCount",
        "behindCount",
        "dirtyTrackedCount",
        "hasUpstream",
        "isRepo",
        "untrackedCount",
      ]);

      const untrackedPath = join(directory, "fixture-note.txt");
      await writeFile(untrackedPath, "neutral fixture\n");
      expect((await expertStatus(directory)).git?.untrackedCount).toBe(1);
      await unlink(untrackedPath);

      const identityPath = join(directory, "IDENTITY.md");
      const identity = await readFile(identityPath, "utf8");
      await writeFile(identityPath, `${identity}\nNeutral fixture revision.\n`);
      const dirty = await expertStatus(directory);
      expect(dirty.git?.dirtyTrackedCount).toBe(1);
      expect(dirty.findings).toContainEqual({
        file: "repository",
        ruleId: "repo.sync.dirty",
        severity: "warning",
      });

      await runFixtureGit(gitPath, directory, ["add", "--", "IDENTITY.md"]);
      await runFixtureGit(gitPath, directory, ["commit", "-m", "Add neutral fixture revision"]);
      const ahead = await expertStatus(directory);
      expect(ahead.git?.aheadCount).toBe(1);
      expect(ahead.git?.behindCount).toBe(0);
      await runFixtureGit(gitPath, directory, ["push", "origin", "main"]);

      const peerRoot = await temporaryDirectory();
      const peer = join(peerRoot, "peer");
      await runFixtureGit(gitPath, peerRoot, ["clone", upstream, peer]);
      await configureFixtureIdentity(gitPath, peer);
      await writeFile(identityPath.replace(directory, peer), `${identity}\nPeer fixture revision.\n`);
      await runFixtureGit(gitPath, peer, ["add", "--", "IDENTITY.md"]);
      await runFixtureGit(gitPath, peer, ["commit", "-m", "Add peer fixture revision"]);
      await runFixtureGit(gitPath, peer, ["push", "origin", "main"]);
      await runFixtureGit(gitPath, directory, ["fetch", "origin"]);

      const behind = await expertStatus(directory);
      expect(behind.git?.aheadCount).toBe(0);
      expect(behind.git?.behindCount).toBe(1);
      expect(behind.findings).toContainEqual({
        file: "repository",
        ruleId: "repo.sync.behind",
        severity: "warning",
      });
      expect(behind.valid).toBe(true);

      const noUpstreamDirectory = await initializeCommittedGitFixture(gitPath);
      const noUpstream = await expertStatus(noUpstreamDirectory);
      expect(noUpstream.git).toEqual({
        isRepo: true,
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        dirtyTrackedCount: 0,
        untrackedCount: 0,
      });
      expect(noUpstream.findings).toContainEqual({
        file: "repository",
        ruleId: "repo.sync.no-upstream",
        severity: "warning",
      });

      const nonRepo = await expertStatus(await scaffoldFixture());
      expect(nonRepo.git).toEqual({
        isRepo: false,
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        dirtyTrackedCount: 0,
        untrackedCount: 0,
      });
      expect(JSON.stringify(behind.git)).not.toContain(directory);
      expect(JSON.stringify(behind.git)).not.toContain(upstream);
    },
    SUBPROCESS_TIMEOUT_MS,
  );
});

async function scaffoldFixture(): Promise<string> {
  const directory = await temporaryDirectory();
  await scaffoldExpert(scaffoldOptions(directory));
  return directory;
}

async function initializeCommittedGitFixture(gitPath: string): Promise<string> {
  const directory = await temporaryDirectory();
  const scaffold = await scaffoldExpert(scaffoldOptions(directory));
  await runFixtureGit(gitPath, directory, ["init", "-b", "main"]);
  await configureFixtureIdentity(gitPath, directory);
  await runFixtureGit(
    gitPath,
    directory,
    ["add", "--", ...scaffold.receipt.files.map((file) => file.path)],
  );
  await runFixtureGit(gitPath, directory, ["commit", "-m", "Initialize neutral fixture"]);
  return directory;
}

async function initializeSyncedGitFixture(
  gitPath: string,
): Promise<{ directory: string; upstream: string }> {
  const directory = await initializeCommittedGitFixture(gitPath);
  const remoteRoot = await temporaryDirectory();
  const upstream = join(remoteRoot, "upstream.git");
  await runFixtureGit(gitPath, remoteRoot, ["init", "--bare", upstream]);
  await runFixtureGit(gitPath, remoteRoot, [
    "--git-dir",
    upstream,
    "symbolic-ref",
    "HEAD",
    "refs/heads/main",
  ]);
  await runFixtureGit(gitPath, directory, ["remote", "add", "origin", upstream]);
  await runFixtureGit(gitPath, directory, ["push", "--set-upstream", "origin", "main"]);
  return { directory, upstream };
}

async function configureFixtureIdentity(gitPath: string, directory: string): Promise<void> {
  await runFixtureGit(gitPath, directory, ["config", "user.name", "Neutral Fixture"]);
  await runFixtureGit(gitPath, directory, [
    "config",
    "user.email",
    "neutral-fixture@example.invalid",
  ]);
}

async function runFixtureGit(
  gitPath: string,
  directory: string,
  args: string[],
): Promise<string> {
  const process = Bun.spawn([gitPath, "-C", directory, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git fixture command failed: ${stderr}`);
  return stdout;
}

async function writeBinding(directory: string, botUsername?: string): Promise<void> {
  await writeFile(join(directory, "binding.json"), `${JSON.stringify({
    schemaVersion: 1,
    openclaw: { agentId: "neutral-agent", workspacePath: "/srv/agents/neutral-agent" },
    telegram: {
      ...(botUsername === undefined ? {} : { botUsername }),
      tokenFilePath: "/run/secrets/telegram-neutral-agent.token",
      dmPolicy: "owner-allowlist",
    },
  }, null, 2)}\n`);
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "expert-provisioning-"));
  temporaryRoots.push(directory);
  return directory;
}

/** A 1x1 PNG carried as text, so no binary fixture file enters this repository. */
function tinyPngBytes(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(TINY_PNG_BASE64, "base64"));
}

function scaffoldOptions(targetDir: string): ExpertScaffoldOptions {
  return {
    targetDir,
    agentId: "neutral-agent",
    displayName: "Neutral Agent",
    domainId: "neutral-domain",
    targetCorpusDisplayName: "neutral-corpus",
    emoji: "◉",
  };
}

describe("Telegram DM policy vocabulary", () => {
  const binding = (dmPolicy: string) => ({
    schemaVersion: 1,
    openclaw: { agentId: "neutral-agent" },
    telegram: {
      tokenFilePath: "~/.openclaw/secrets/telegram-neutral-agent.token",
      dmPolicy,
      groupTopics: [{ topicId: 42 }],
    },
  });

  test("accepts the native gateway value", () => {
    expect(validateBindingManifest(binding("allowlist")).telegram?.dmPolicy).toBe("allowlist");
  });

  test("still accepts the older private spelling so existing binding files stay valid", () => {
    expect(validateBindingManifest(binding("owner-allowlist")).telegram?.dmPolicy).toBe("owner-allowlist");
  });

  test("preserves the declared policy rather than rewriting it", () => {
    expect(validateBindingManifest(binding("allowlist")).telegram?.dmPolicy).not.toBe("owner-allowlist");
  });

  test("rejects an unknown policy", () => {
    expect(() => validateBindingManifest(binding("everyone"))).toThrow(/allowlist or owner-allowlist/);
  });
});
