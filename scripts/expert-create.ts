import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import {
  AVATAR_EXTENSIONS,
  AVATAR_MAX_BYTES,
  requireAvatarExtension,
  scaffoldExpert,
  serializeCreationReceipt,
  type ExpertCreationReceipt,
  type ExpertScaffoldAvatar,
  type ExpertScaffoldOptions,
} from "../packages/provisioning/src/index.ts";

const USAGE = `Usage: bun run expert:create -- --target <directory> --agent-id <id> --display-name <name> --domain-id <id> --target-corpus <display-name> --receipt <path> [--emoji <emoji>] [--avatar <image-path>] [--telegram-token-path <absolute-path>] [--issue-tracker <channel>] [--remote <url>] [--no-git]

Creates a tenant-neutral agent repository scaffold. Git initialization and the first commit run by default and stage only the scaffold files; --no-git opts out. --remote wires an origin remote locally and never pushes. --avatar copies one ${AVATAR_EXTENSIONS.join("/")} image of at most ${AVATAR_MAX_BYTES} bytes into the scaffold.`;

export interface ExpertCreateCliArguments extends Omit<ExpertScaffoldOptions, "avatar"> {
  receiptPath: string;
  initializeGit: boolean;
  remoteUrl?: string;
  /** Source image on the operator's disk, not a path inside the scaffold. */
  avatarPath?: string;
}

export interface ExpertCreateCliResult {
  targetDir: string;
  receiptPath: string;
  receipt: ExpertCreationReceipt;
  routingSnippet: string;
  githubCommand: string;
  remoteWiringSteps: string;
  avatarSteps: string;
  workspaceHydrationSteps: string;
  gitInitialized: boolean;
  remoteConfigured: boolean;
  /** Repo-relative path of the committed avatar, absent when none was given. */
  avatarFile?: string;
}

export type ExpertCreateCommandRunner = (command: string[], cwd: string) => Promise<void>;

export interface ExpertCreateCliDependencies {
  mkdirImpl?: typeof mkdir;
  writeFileImpl?: typeof writeFile;
  runCommand?: ExpertCreateCommandRunner;
}

export function parseExpertCreateArguments(argv: string[]): ExpertCreateCliArguments {
  const values = new Map<string, string>();
  const valueFlags = new Set([
    "--target",
    "--agent-id",
    "--display-name",
    "--domain-id",
    "--target-corpus",
    "--receipt",
    "--emoji",
    "--avatar",
    "--telegram-token-path",
    "--issue-tracker",
    "--remote",
  ]);
  // Version control is the default, not an opt-in: a zero-commit agent
  // repository is the state this factory exists to make impossible. --git stays
  // accepted as an explicit affirmation of the default.
  let initializeGit = true;
  let gitFlagSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--git" || argument === "--no-git") {
      if (gitFlagSeen) throw new Error(USAGE);
      gitFlagSeen = true;
      initializeGit = argument === "--git";
      continue;
    }
    if (!valueFlags.has(argument) || values.has(argument)) throw new Error(USAGE);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(USAGE);
    values.set(argument, value);
    index += 1;
  }
  const required = [
    "--target",
    "--agent-id",
    "--display-name",
    "--domain-id",
    "--target-corpus",
    "--receipt",
  ];
  if (required.some((flag) => !values.has(flag))) throw new Error(USAGE);
  return {
    targetDir: values.get("--target")!,
    agentId: values.get("--agent-id")!,
    displayName: values.get("--display-name")!,
    domainId: values.get("--domain-id")!,
    targetCorpusDisplayName: values.get("--target-corpus")!,
    ...(values.has("--emoji") ? { emoji: values.get("--emoji")! } : {}),
    ...(values.has("--avatar") ? { avatarPath: values.get("--avatar")! } : {}),
    ...(values.has("--telegram-token-path")
      ? { telegramTokenFilePath: values.get("--telegram-token-path")! }
      : {}),
    ...(values.has("--issue-tracker") ? { issueTracker: values.get("--issue-tracker")! } : {}),
    ...(values.has("--remote") ? { remoteUrl: values.get("--remote")! } : {}),
    receiptPath: values.get("--receipt")!,
    initializeGit,
  };
}

export async function runExpertCreateCli(
  argv: string[],
  dependencies: ExpertCreateCliDependencies = {},
): Promise<ExpertCreateCliResult> {
  const args = parseExpertCreateArguments(argv);
  const avatar = args.avatarPath === undefined ? undefined : await readAvatarImage(args.avatarPath);
  const scaffold = await scaffoldExpert({
    ...args,
    ...(avatar === undefined ? {} : { avatar }),
  });
  const avatarFile = scaffold.manifest.avatar;
  const receiptPath = resolve(args.receiptPath);
  await (dependencies.mkdirImpl ?? mkdir)(dirname(receiptPath), { recursive: true });
  await (dependencies.writeFileImpl ?? writeFile)(
    receiptPath,
    serializeCreationReceipt(scaffold.receipt),
    { encoding: "utf8", flag: "wx" },
  );

  const scaffoldPaths = scaffold.receipt.files.map((file) => file.path);
  // Remote wiring is local only. The factory has never pushed, and it must not
  // start assuming a hosting credential exists wherever it runs.
  const remoteConfigured = args.initializeGit && args.remoteUrl !== undefined;
  if (args.initializeGit) {
    const runCommand = dependencies.runCommand ?? runLocalCommand;
    await runCommand(["git", "init"], scaffold.targetDir);
    await runCommand(["git", "add", "--", ...scaffoldPaths], scaffold.targetDir);
    // The scaffold commit carries an explicit factory identity: this runs on
    // fresh hosts where no git identity exists, and git either refuses to
    // commit or silently guesses one from the system username — both wrong.
    await runCommand(
      [
        "git",
        "-c", "user.name=Expert Agent Factory",
        "-c", "user.email=factory@expert-agent.invalid",
        "commit", "-m", "Initialize expert agent repository",
      ],
      scaffold.targetDir,
    );
    if (args.remoteUrl !== undefined) {
      await runCommand(["git", "remote", "add", "origin", args.remoteUrl], scaffold.targetDir);
    }
  }

  return {
    targetDir: scaffold.targetDir,
    receiptPath,
    receipt: scaffold.receipt,
    routingSnippet: createRoutingSnippet(scaffold.manifest, scaffold.targetDir),
    githubCommand: createGithubCommand(scaffold.manifest.agentId, scaffold.targetDir),
    remoteWiringSteps: createRemoteWiringSteps({
      agentId: scaffold.manifest.agentId,
      targetDir: scaffold.targetDir,
      scaffoldPaths,
      gitInitialized: args.initializeGit,
      ...(args.remoteUrl === undefined ? {} : { remoteUrl: args.remoteUrl }),
    }),
    avatarSteps: createAvatarSteps(avatarFile),
    workspaceHydrationSteps: createWorkspaceHydrationSteps(),
    gitInitialized: args.initializeGit,
    remoteConfigured,
    ...(avatarFile === undefined ? {} : { avatarFile }),
  };
}

/**
 * An expert with no face is a scaffold, not a character, so the absent case is
 * a named next step rather than silence.
 */
export function createAvatarSteps(avatarFile?: string): string {
  if (avatarFile !== undefined) {
    return `Avatar: committed at \`${avatarFile}\` and named by \`agent.json\`.`;
  }
  return [
    "[MANUAL] No avatar was supplied. Give the agent a face before it meets anyone:",
    `re-run creation with --avatar <image-path>, or copy one ${AVATAR_EXTENSIONS.join("/")} image`,
    `of at most ${AVATAR_MAX_BYTES} bytes into the repository, set \`agent.json\`'s \`avatar\` to`,
    "its repo-relative path, and commit both.",
  ].join("\n");
}

/** Format is decided by the source extension, before any bytes are read. */
async function readAvatarImage(sourcePath: string): Promise<ExpertScaffoldAvatar> {
  const extension = requireAvatarExtension(extname(sourcePath));
  return { extension, bytes: await readFile(resolve(sourcePath)) };
}

export function createRoutingSnippet(
  manifest: {
    domainId: string;
    displayName: string;
    targetCorpusDisplayName: string;
  },
  targetDir: string,
): string {
  const value = JSON.stringify({
    [manifest.domainId]: {
      displayName: manifest.displayName,
      library: {
        bucket: "<configured-bucket>",
        prefix: "<configured-prefix>",
      },
      targetCorpusDisplayName: manifest.targetCorpusDisplayName,
      scopeManifestPath: join(resolve(targetDir), "library/scope-manifest.json"),
    },
  });
  return `EXPERT_AGENTS_DOMAIN_EXPERT_AGENTS_JSON=${shellQuote(value)}`;
}

export function createGithubCommand(agentId: string, targetDir: string): string {
  return [
    "gh",
    "repo",
    "create",
    shellQuote(agentId),
    "--private",
    "--source",
    shellQuote(resolve(targetDir)),
    "--remote",
    "origin",
  ].join(" ");
}

/**
 * Working memory that lives on exactly one host is one disk failure from being
 * gone, so every scaffold leaves with the remote-wiring commands attached —
 * spelled out for the operator when the factory could not run them itself.
 */
export function createRemoteWiringSteps(options: {
  agentId: string;
  targetDir: string;
  scaffoldPaths: string[];
  gitInitialized: boolean;
  remoteUrl?: string;
}): string {
  const directory = shellQuote(resolve(options.targetDir));
  const steps: string[] = [];
  if (!options.gitInitialized) {
    steps.push(
      "[MANUAL] Version control was skipped; initialize it before anything else is written:",
      `git -C ${directory} init`,
      `git -C ${directory} add -- ${options.scaffoldPaths.map(shellQuote).join(" ")}`,
      `git -C ${directory} commit -m 'Initialize expert agent repository'`,
    );
  }
  if (options.remoteUrl === undefined) {
    steps.push(
      "[MANUAL] Create a PRIVATE remote repository, or wire one that already exists:",
      createGithubCommand(options.agentId, options.targetDir),
      `git -C ${directory} remote add origin '<private-repository-url>'`,
    );
  } else if (options.gitInitialized) {
    steps.push("Remote `origin` was wired locally from --remote; nothing was pushed.");
  } else {
    steps.push(
      "[MANUAL] Wire the supplied remote once the repository exists:",
      `git -C ${directory} remote add origin ${shellQuote(options.remoteUrl)}`,
    );
  }
  steps.push(
    "[MANUAL] Publish the first commit so the workspace survives this host:",
    `git -C ${directory} push -u origin HEAD`,
  );
  return steps.join("\n");
}

export function createWorkspaceHydrationSteps(): string {
  return [
    "[MANUAL] Clone the agent repository into the declared workspace path:",
    "git clone <agent-repository-url> <workspace-path>",
    "[MANUAL] Backfill any missing native workspace template files:",
    "openclaw setup --workspace <workspace-path>",
    "[MANUAL] Start a new agent session after hydration; workspace files load at session start.",
  ].join("\n");
}

async function runLocalCommand(command: string[], cwd: string): Promise<void> {
  const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, , stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).arrayBuffer(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command[0]} command failed with exit code ${exitCode}: ${stderr.trim().slice(0, 400)}`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

if (import.meta.main) {
  try {
    const result = await runExpertCreateCli(process.argv.slice(2));
    console.log(`Created agent repository at ${result.targetDir}`);
    console.log(`Creation receipt: ${result.receiptPath}`);
    console.log(
      result.gitInitialized
        ? "Version control: initialized with the scaffold commit."
        : "Version control: SKIPPED; this repository has no commit yet.",
    );
    console.log(`\n${result.avatarSteps}`);
    console.log("\nROUTING-SNIPPET");
    console.log(result.routingSnippet);
    console.log("\nRemote wiring");
    console.log(result.remoteWiringSteps);
    console.log("\n[MANUAL] Workspace hydration");
    console.log(result.workspaceHydrationSteps);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Expert creation failed.");
    process.exitCode = 1;
  }
}
