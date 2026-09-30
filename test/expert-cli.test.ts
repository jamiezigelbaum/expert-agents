import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseExpertBindingsArguments,
  expertBindingsExitCode,
  runExpertBindingsCli,
} from "../scripts/expert-bindings.ts";
import {
  parseExpertCreateArguments,
  runExpertCreateCli,
  type ExpertCreateCommandRunner,
} from "../scripts/expert-create.ts";
import {
  formatDisclosureSummary,
  parseExpertReleaseArguments,
  runExpertReleaseCli,
} from "../scripts/expert-release.ts";
import {
  expertStatusExitCode,
  parseExpertStatusArguments,
  runExpertStatusCli,
} from "../scripts/expert-status.ts";
import {
  AVATAR_MAX_BYTES,
  SERVING_MANUAL_PRECONDITIONS,
  type ExpertGitStatus,
  type ExpertStatusReport,
} from "../packages/provisioning/src/index.ts";

/** A 1x1 PNG carried as text, so no binary fixture file enters this repository. */
const TINY_PNG_BASE64
  = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const temporaryRoots: string[] = [];

// The one test below that lets the CLI run real git pays several process
// startups. On a host already running other builds that multiplies well past
// bun's 5 s default and turns a passing suite red. The bound is deliberately
// generous: it is here to catch a hang, not to police duration.
const SUBPROCESS_TIMEOUT_MS = 60_000;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("expert create CLI", () => {
  test("parses strict create arguments", () => {
    expect(parseExpertCreateArguments([
      "--target", "/tmp/neutral-agent",
      "--agent-id", "neutral-agent",
      "--display-name", "Neutral Agent",
      "--domain-id", "neutral-domain",
      "--target-corpus", "neutral-corpus",
      "--receipt", "/tmp/creation-receipt.json",
      "--emoji", "◉",
      "--telegram-token-path", "/run/secrets/telegram-neutral-agent.token",
      "--issue-tracker", "the escalation tracker declared by this deployment",
      "--remote", "ssh://git@example.invalid/neutral-agent.git",
      "--avatar", "/tmp/candidate-avatar.png",
      "--git",
    ])).toEqual({
      targetDir: "/tmp/neutral-agent",
      agentId: "neutral-agent",
      displayName: "Neutral Agent",
      domainId: "neutral-domain",
      targetCorpusDisplayName: "neutral-corpus",
      receiptPath: "/tmp/creation-receipt.json",
      emoji: "◉",
      telegramTokenFilePath: "/run/secrets/telegram-neutral-agent.token",
      issueTracker: "the escalation tracker declared by this deployment",
      remoteUrl: "ssh://git@example.invalid/neutral-agent.git",
      avatarPath: "/tmp/candidate-avatar.png",
      initializeGit: true,
    });
  });

  test("initializes version control by default and only --no-git opts out", () => {
    expect(parseExpertCreateArguments(createArgs("/tmp/a", "/tmp/r")).initializeGit).toBe(true);
    expect(parseExpertCreateArguments(createArgs("/tmp/a", "/tmp/r").concat("--no-git")).initializeGit)
      .toBe(false);
    expect(() => parseExpertCreateArguments(createArgs("/tmp/a", "/tmp/r").concat("--git", "--no-git")))
      .toThrow("Usage:");
  });

  test("rejects missing, duplicate, and unknown create arguments", () => {
    expect(() => parseExpertCreateArguments([])).toThrow("Usage:");
    expect(() => parseExpertCreateArguments(createArgs("/tmp/a", "/tmp/r").concat("--agent-id", "again")))
      .toThrow("Usage:");
    expect(() => parseExpertCreateArguments(createArgs("/tmp/a", "/tmp/r").concat("--unknown")))
      .toThrow("Usage:");
    expect(() => parseExpertCreateArguments(createArgs("/tmp/a", "/tmp/r").concat("--git", "--git")))
      .toThrow("Usage:");
  });

  test("writes the receipt, prints configuration helpers, and commits the scaffold", async () => {
    const root = await temporaryDirectory();
    const target = join(root, "agent-repository");
    const receipt = join(root, "receipts", "creation.json");
    const commands: Array<{ command: string[]; cwd: string }> = [];
    const runCommand: ExpertCreateCommandRunner = async (command, cwd) => {
      commands.push({ command, cwd });
    };

    const result = await runExpertCreateCli(createArgs(target, receipt), { runCommand });

    expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual(result.receipt);
    expect(result.routingSnippet).toContain("EXPERT_AGENTS_DOMAIN_EXPERT_AGENTS_JSON=");
    expect(result.routingSnippet).toContain("<configured-bucket>");
    expect(result.routingSnippet).toContain(resolve(target));
    expect(result.githubCommand).toContain("gh repo create");
    expect(result.workspaceHydrationSteps).toContain(
      "git clone <agent-repository-url> <workspace-path>",
    );
    expect(result.workspaceHydrationSteps).toContain(
      "openclaw setup --workspace <workspace-path>",
    );
    expect(result.workspaceHydrationSteps).toContain("load at session start");
    expect(result.gitInitialized).toBe(true);
    expect(commands.map(({ command }) => [command[0], command.find((part) => !part.startsWith("-") && part !== "git" && !part.includes("="))])).toEqual([
      ["git", "init"],
      ["git", "add"],
      ["git", "commit"],
    ]);
    expect(commands[1]!.command).not.toContain(".");
    expect(commands.every(({ cwd }) => cwd === resolve(target))).toBe(true);
  });

  test("wires an origin remote from --remote and never pushes", async () => {
    const root = await temporaryDirectory();
    const target = join(root, "agent-repository");
    const remote = "ssh://git@example.invalid/neutral-agent.git";
    const commands: Array<{ command: string[]; cwd: string }> = [];
    const runCommand: ExpertCreateCommandRunner = async (command, cwd) => {
      commands.push({ command, cwd });
    };

    const result = await runExpertCreateCli(
      [...createArgs(target, join(root, "creation.json")), "--remote", remote],
      { runCommand },
    );

    expect(result.remoteConfigured).toBe(true);
    expect(commands.map(({ command }) => [command[0], command.find((part) => !part.startsWith("-") && part !== "git" && !part.includes("="))])).toEqual([
      ["git", "init"],
      ["git", "add"],
      ["git", "commit"],
      ["git", "remote"],
    ]);
    expect(commands[3]!.command).toEqual(["git", "remote", "add", "origin", remote]);
    expect(commands.some(({ command }) => command.includes("push"))).toBe(false);
    expect(result.remoteWiringSteps).toContain("nothing was pushed");
    expect(result.remoteWiringSteps).toContain("push -u origin HEAD");
  });

  test("hands over the exact remote and version-control commands it did not run", async () => {
    const root = await temporaryDirectory();
    const target = join(root, "agent-repository");
    const commands: Array<{ command: string[]; cwd: string }> = [];
    const runCommand: ExpertCreateCommandRunner = async (command, cwd) => {
      commands.push({ command, cwd });
    };

    const withoutRemote = await runExpertCreateCli(
      createArgs(target, join(root, "creation.json")),
      { runCommand },
    );
    expect(withoutRemote.remoteConfigured).toBe(false);
    expect(withoutRemote.remoteWiringSteps).toContain("PRIVATE remote repository");
    expect(withoutRemote.remoteWiringSteps).toContain("gh repo create");
    expect(withoutRemote.remoteWiringSteps).toContain("remote add origin '<private-repository-url>'");
    expect(withoutRemote.remoteWiringSteps).toContain("push -u origin HEAD");

    const skipped = await runExpertCreateCli(
      [...createArgs(join(root, "second-repository"), join(root, "second.json")), "--no-git"],
      { runCommand },
    );
    expect(skipped.gitInitialized).toBe(false);
    expect(commands.every(({ cwd }) => cwd === resolve(target))).toBe(true);
    expect(skipped.remoteWiringSteps).toContain("Version control was skipped");
    expect(skipped.remoteWiringSteps).toContain("git -C");
    expect(skipped.remoteWiringSteps).toContain("init");
    expect(skipped.remoteWiringSteps).toContain("commit -m 'Initialize expert agent repository'");
    expect(skipped.remoteWiringSteps).toContain("'.gitignore'");

    // A supplied remote that could not be wired is still handed over verbatim,
    // never downgraded to a placeholder the operator has to reconstruct.
    const skippedWithRemote = await runExpertCreateCli([
      ...createArgs(join(root, "third-repository"), join(root, "third.json")),
      "--remote", "ssh://git@example.invalid/neutral-agent.git",
      "--no-git",
    ], { runCommand });
    expect(skippedWithRemote.remoteConfigured).toBe(false);
    expect(skippedWithRemote.remoteWiringSteps)
      .toContain("remote add origin 'ssh://git@example.invalid/neutral-agent.git'");
  });

  test("copies a chosen avatar into the scaffold and stages it for the first commit", async () => {
    const root = await temporaryDirectory();
    const target = join(root, "agent-repository");
    const source = join(root, "candidate-avatar.png");
    const bytes = tinyPngBytes();
    await writeFile(source, bytes);
    const commands: Array<{ command: string[]; cwd: string }> = [];
    const runCommand: ExpertCreateCommandRunner = async (command, cwd) => {
      commands.push({ command, cwd });
    };

    const result = await runExpertCreateCli(
      [...createArgs(target, join(root, "creation.json")), "--avatar", source],
      { runCommand },
    );

    expect(result.avatarFile).toBe("avatar.png");
    expect(Uint8Array.from(await readFile(join(target, "avatar.png")))).toEqual(bytes);
    expect(JSON.parse(await readFile(join(target, "agent.json"), "utf8")).avatar).toBe("avatar.png");
    expect(result.receipt.files.map((file) => file.path)).toContain("avatar.png");
    expect(commands[1]!.command).toContain("avatar.png");
    expect(result.avatarSteps).toContain("avatar.png");
    expect(result.avatarSteps).not.toContain("[MANUAL]");
  });

  test("names adding an avatar as a next step when none was supplied", async () => {
    const root = await temporaryDirectory();
    const target = join(root, "agent-repository");

    const result = await runExpertCreateCli(
      [...createArgs(target, join(root, "creation.json")), "--no-git"],
      {},
    );

    expect(result.avatarFile).toBeUndefined();
    expect(Object.hasOwn(
      JSON.parse(await readFile(join(target, "agent.json"), "utf8")),
      "avatar",
    )).toBe(false);
    expect(result.avatarSteps).toContain("[MANUAL]");
    expect(result.avatarSteps).toContain("--avatar <image-path>");
  });

  test("refuses an unsupported avatar format and an oversized image", async () => {
    const root = await temporaryDirectory();
    const animated = join(root, "candidate-avatar.gif");
    await writeFile(animated, tinyPngBytes());
    await expect(runExpertCreateCli([
      ...createArgs(join(root, "gif-repository"), join(root, "gif.json")),
      "--avatar", animated,
      "--no-git",
    ])).rejects.toThrow("avatar image format is unsupported");

    const oversized = join(root, "oversized-avatar.png");
    await writeFile(oversized, new Uint8Array(AVATAR_MAX_BYTES + 1));
    await expect(runExpertCreateCli([
      ...createArgs(join(root, "oversized-repository"), join(root, "oversized.json")),
      "--avatar", oversized,
      "--no-git",
    ])).rejects.toThrow("avatar image exceeds the avatar size limit");
  });

  test.skipIf(Bun.which("git") === null)(
    "leaves a real repository holding at least one commit",
    async () => {
      const root = await temporaryDirectory();
      const target = join(root, "agent-repository");
      await withFixtureGitEnvironment(() => runExpertCreateCli([
        ...createArgs(target, join(root, "creation.json")),
        "--issue-tracker", "the escalation tracker declared by this deployment",
      ]));

      expect(await gitOutput(target, ["rev-list", "--count", "HEAD"])).toBe("1");
      // The factory identity is explicit, so scaffolding works on hosts with
      // no git identity configured at all.
      expect(await gitOutput(target, ["log", "-1", "--format=%an"])).toBe("Expert Agent Factory");
      const tracked = (await gitOutput(target, ["ls-files"])).split("\n");
      expect(tracked).toContain(".gitignore");
      expect(tracked).toContain("AGENTS.md");
      const agents = await readFile(join(target, "AGENTS.md"), "utf8");
      expect(agents).toContain("## Harness discipline");
      expect(agents).toContain("## Closing out");
      expect(agents).toContain("## How acquisition works");
      expect(agents).toContain("Your library corpus is `neutral-corpus`");
      expect(agents).toContain("the escalation tracker declared by this deployment");
    },
    SUBPROCESS_TIMEOUT_MS,
  );
});

describe("expert status CLI", () => {
  test("parses strict status arguments", () => {
    expect(parseExpertStatusArguments(["--dir", "/tmp/neutral-agent"]))
      .toEqual({ directory: "/tmp/neutral-agent", requireSync: false });
    expect(parseExpertStatusArguments(["--dir", "/tmp/neutral-agent", "--require-sync"]))
      .toEqual({ directory: "/tmp/neutral-agent", requireSync: true });
    expect(() => parseExpertStatusArguments([])).toThrow("Usage:");
    expect(() => parseExpertStatusArguments(["--dir", "/tmp/a", "--extra", "value"]))
      .toThrow("Usage:");
  });

  test("returns validity as the status exit code", async () => {
    const missing = await temporaryDirectory();
    const report = await runExpertStatusCli(["--dir", missing]);
    expect(report.valid).toBe(false);
    expect(expertStatusExitCode(report)).toBe(1);
    expect(JSON.stringify(report)).not.toContain(missing);
  });

  test("returns exit code zero for a newly created scaffold", async () => {
    const root = await temporaryDirectory();
    const target = join(root, "agent-repository");
    await runExpertCreateCli([...createArgs(target, join(root, "creation.json")), "--no-git"]);

    const report = await runExpertStatusCli(["--dir", target]);
    expect(report.valid).toBe(true);
    expect(expertStatusExitCode(report)).toBe(0);
  });

  test("--require-sync rejects behind, dirty, no-upstream, and non-repo states", () => {
    const clean = gitStatus();
    expect(expertStatusExitCode(statusReport(clean), true)).toBe(0);
    expect(expertStatusExitCode(statusReport({ ...clean, behindCount: 1 }), true)).toBe(1);
    expect(expertStatusExitCode(statusReport({ ...clean, dirtyTrackedCount: 1 }), true)).toBe(1);
    expect(expertStatusExitCode(statusReport({ ...clean, hasUpstream: false }), true)).toBe(1);
    expect(expertStatusExitCode(statusReport({
      ...clean,
      isRepo: false,
      hasUpstream: false,
    }), true)).toBe(1);
    expect(expertStatusExitCode(statusReport(null), true)).toBe(1);
    expect(expertStatusExitCode(statusReport({ ...clean, untrackedCount: 1 }), true)).toBe(0);
    expect(expertStatusExitCode(statusReport({ ...clean, aheadCount: 1 }), true)).toBe(0);
  });
});

describe("expert bindings CLI emit mode", () => {
  test("parses strict emit arguments", () => {
    expect(parseExpertBindingsArguments([
      "--dir", "/tmp/neutral-agent",
      "--emit",
      "--out", "/tmp/binding-output",
    ])).toEqual({
      mode: "emit",
      directory: "/tmp/neutral-agent",
      outputDirectory: "/tmp/binding-output",
    });
    expect(() => parseExpertBindingsArguments([])).toThrow("Usage:");
  });

  test("round-trips create with Telegram path through status and binding emit", async () => {
    const root = await temporaryDirectory();
    const target = join(root, "agent-repository");
    await runExpertCreateCli([
      ...createArgs(target, join(root, "creation.json")),
      "--telegram-token-path", "/run/secrets/telegram-neutral-agent.token",
      "--no-git",
    ]);
    expect((await runExpertStatusCli(["--dir", target])).valid).toBe(true);

    const result = await runExpertBindingsCli([
      "--dir", target,
      "--emit",
      "--out", join(root, "binding-output"),
    ]);
    expect("descriptor" in result && result.descriptor.agent.agentId).toBe("neutral-agent");
    expect("checklist" in result && result.checklist.includes("[MANUAL]")).toBe(true);
  });
});

describe("expert bindings CLI verify mode", () => {
  test("parses verify arguments and maps validity to the exit code", async () => {
    expect(parseExpertBindingsArguments([
      "--dir", "/tmp/neutral-agent",
      "--verify",
      "--gateway-config", "/tmp/gateway-config",
    ])).toEqual({
      mode: "verify",
      directory: "/tmp/neutral-agent",
      gatewayConfigPath: "/tmp/gateway-config",
    });

    const root = await temporaryDirectory();
    const target = join(root, "agent-repository");
    await runExpertCreateCli([...createArgs(target, join(root, "creation.json")), "--no-git"]);
    await writeFile(join(target, "binding.json"), `${JSON.stringify({
      schemaVersion: 1,
      openclaw: { agentId: "neutral-agent" },
    })}\n`);
    const config = join(root, "gateway-config.txt");
    await writeFile(config, "no declared agent here\n");

    const result = await runExpertBindingsCli([
      "--dir", target,
      "--verify",
      "--gateway-config", config,
    ]);
    expect("valid" in result && result.valid).toBe(false);
    expect(expertBindingsExitCode(result)).toBe(1);
  });
});

describe("expert release CLI", () => {
  test("parses strict release arguments", () => {
    expect(parseExpertReleaseArguments([
      "--dir", "/tmp/neutral-agent",
      "--tag", "v0.1.0",
      "--out", "/tmp/serving-artifact",
    ])).toEqual({
      directory: "/tmp/neutral-agent",
      tag: "v0.1.0",
      outputRoot: "/tmp/serving-artifact",
    });
  });

  test("rejects missing, duplicate, and unknown release arguments", () => {
    expect(() => parseExpertReleaseArguments([])).toThrow("Usage:");
    expect(() => parseExpertReleaseArguments(["--dir", "/tmp/neutral-agent", "--tag", "v0.1.0"]))
      .toThrow("Usage:");
    expect(() => parseExpertReleaseArguments([
      "--dir", "/tmp/neutral-agent",
      "--tag", "v0.1.0",
      "--tag", "v0.2.0",
      "--out", "/tmp/serving-artifact",
    ])).toThrow("Usage:");
    expect(() => parseExpertReleaseArguments([
      "--dir", "/tmp/neutral-agent",
      "--tag", "v0.1.0",
      "--out", "/tmp/serving-artifact",
      "--unknown", "value",
    ])).toThrow("Usage:");
  });

  test("names every manual precondition it did not run", () => {
    expect(SERVING_MANUAL_PRECONDITIONS).toHaveLength(3);
    expect(SERVING_MANUAL_PRECONDITIONS.join("\n")).toContain("soul lint");
    expect(SERVING_MANUAL_PRECONDITIONS.join("\n")).toContain("retrieval evaluation");
    expect(SERVING_MANUAL_PRECONDITIONS.join("\n")).toContain("parity battery");
  });

  test("refuses a repository whose manifest declares no serving set", async () => {
    const root = await temporaryDirectory();
    const target = join(root, "agent-repository");
    await runExpertCreateCli([...createArgs(target, join(root, "creation.json")), "--no-git"]);

    await expect(runExpertReleaseCli([
      "--dir", target,
      "--tag", "v0.1.0",
      "--out", join(root, "serving-artifact"),
    ])).rejects.toThrow();
  });
});

function createArgs(target: string, receipt: string): string[] {
  return [
    "--target", target,
    "--agent-id", "neutral-agent",
    "--display-name", "Neutral Agent",
    "--domain-id", "neutral-domain",
    "--target-corpus", "neutral-corpus",
    "--receipt", receipt,
  ];
}

function gitStatus(): ExpertGitStatus {
  return {
    isRepo: true,
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    dirtyTrackedCount: 0,
    untrackedCount: 0,
  };
}

function statusReport(git: ExpertGitStatus | null): ExpertStatusReport {
  return {
    schemaVersion: 1,
    kind: "expert_status",
    valid: true,
    git,
    items: [],
    findings: [],
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "expert-cli-"));
  temporaryRoots.push(directory);
  return directory;
}

function tinyPngBytes(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(TINY_PNG_BASE64, "base64"));
}

/**
 * The factory commits with whatever git identity the host provides. Pin a
 * neutral one for the fixture so the assertion neither depends on nor inherits
 * the operator's global git configuration.
 */
async function withFixtureGitEnvironment<T>(body: () => Promise<T>): Promise<T> {
  const overrides: Record<string, string> = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Neutral Fixture",
    GIT_AUTHOR_EMAIL: "neutral-fixture@example.invalid",
    GIT_COMMITTER_NAME: "Neutral Fixture",
    GIT_COMMITTER_EMAIL: "neutral-fixture@example.invalid",
  };
  const previous = Object.keys(overrides).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, overrides);
  try {
    return await body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function gitOutput(directory: string, args: string[]): Promise<string> {
  const process = Bun.spawn([Bun.which("git")!, "-C", directory, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git fixture command failed: ${stderr}`);
  return stdout.trim();
}

describe("expert:release disclosure summary", () => {
  const manifest = (corpora: Array<{ corpusId: string; disclosure: "full" | "derived" | "excluded" }>) => ({
    schemaVersion: 1 as const,
    kind: "expert_serving_manifest" as const,
    tag: "v0.0.1",
    agentId: "neutral-agent",
    displayName: "Neutral Agent",
    domainId: "neutral-domain",
    targetCorpusDisplayName: "neutral-corpus",
    corpora,
    files: ["SOUL.md"],
  });

  test("names every declared corpus and its posture", () => {
    const lines = formatDisclosureSummary(manifest([
      { corpusId: "neutral-public", disclosure: "full" },
      { corpusId: "neutral-private", disclosure: "derived" },
    ])).join("\n");
    expect(lines).toContain("neutral-public");
    expect(lines).toContain("neutral-private");
    expect(lines).toMatch(/full\s+neutral-public/);
    expect(lines).toMatch(/derived\s+neutral-private/);
  });

  test("warns loudly when no disclosure is declared at all", () => {
    const lines = formatDisclosureSummary(manifest([])).join("\n");
    expect(lines).toContain("WARNING");
    expect(lines).toContain("permissive default posture (full)");
  });

  test("always states the target corpus and the permissive default", () => {
    for (const corpora of [[], [{ corpusId: "neutral-public", disclosure: "full" as const }]]) {
      const lines = formatDisclosureSummary(manifest(corpora)).join("\n");
      expect(lines).toContain("neutral-corpus");
      expect(lines).toContain("exposed at the permissive default");
    }
  });

  test("carries no absolute path or file content", () => {
    const lines = formatDisclosureSummary(manifest([{ corpusId: "neutral-public", disclosure: "full" }])).join("\n");
    expect(lines).not.toMatch(/\//);
  });
});
