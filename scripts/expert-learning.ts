/**
 * Owner-side engagement-learning command.
 *
 * Extraction is machinery, not a customer capability: this command is run by the
 * owner beside the distillation workshop, never by a served deployment. It opens
 * per-engagement storage (which refuses any layout touching the agent repository
 * or the shared library), refuses extraction outright when the engagement has
 * opted out, and writes learning only as an accepted `doctrine` under
 * `derived/<artifact-id>/`.
 *
 * Acceptance is never implied: without `--artifact-id`, `--accepted-by`, and
 * `--accepted-at` the command seals a draft for review and writes nothing.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  LEARNING_ARTIFACT_KIND,
  acceptEngagementLearning,
  extractEngagementLearning,
  isEngagementHeldPath,
  openEngagementStore,
  type EngagementDeletionReceipt,
  type EngagementLearningReceipt,
  type EngagementRecord,
} from "../packages/provisioning/src/index.ts";

const USAGE = `Usage: bun run expert:learning -- --engagement <dir> --agent <agent-repo> --library <dir> <mode> [acceptance]

Modes (exactly one):
  --draft <file>              seal an authored generalization for review
  --opt-out-at <instant>      record the prospective learning opt-out
  --close-at <instant>        delete client content at engagement end

Acceptance (all three, only with --draft):
  --artifact-id <id> --accepted-by <name> --accepted-at <instant>

Identity (required the first time a storage root is used):
  --engagement-id <id> --agent-id <id> --opened-at <instant>`;

const NAMED_ARGUMENTS = [
  "--engagement",
  "--agent",
  "--library",
  "--draft",
  "--opt-out-at",
  "--close-at",
  "--artifact-id",
  "--accepted-by",
  "--accepted-at",
  "--engagement-id",
  "--agent-id",
  "--opened-at",
] as const;

export type ExpertLearningMode = "draft" | "opt-out" | "close";

export interface ExpertLearningCliArguments {
  engagementRoot: string;
  agentDirectory: string;
  libraryDirectory: string;
  mode: ExpertLearningMode;
  draftPath?: string;
  optOutAt?: string;
  closeAt?: string;
  acceptance?: { artifactId: string; acceptedBy: string; acceptedAt: string };
  engagementId?: string;
  agentId?: string;
  openedAt?: string;
}

export type ExpertLearningOutcome =
  | { kind: "sealed"; characters: number; lines: number }
  | { kind: "accepted"; receipt: EngagementLearningReceipt }
  | { kind: "opted-out"; record: EngagementRecord }
  | { kind: "closed"; receipt: EngagementDeletionReceipt };

export function parseExpertLearningArguments(argv: string[]): ExpertLearningCliArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!(NAMED_ARGUMENTS as readonly string[]).includes(argument)) {
      throw new Error(`${USAGE}\n\nUnknown argument: ${argument}`);
    }
    if (values.has(argument)) throw new Error(`${USAGE}\n\nDuplicate argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${USAGE}\n\nMissing value for ${argument}.`);
    }
    values.set(argument, value);
    index += 1;
  }
  const engagementRoot = required(values, "--engagement");
  const agentDirectory = required(values, "--agent");
  const libraryDirectory = required(values, "--library");

  const modes = (["--draft", "--opt-out-at", "--close-at"] as const).filter((flag) => values.has(flag));
  if (modes.length !== 1) {
    throw new Error(`${USAGE}\n\nExactly one of --draft, --opt-out-at, or --close-at is required.`);
  }
  const acceptanceFlags = (["--artifact-id", "--accepted-by", "--accepted-at"] as const)
    .filter((flag) => values.has(flag));
  if (acceptanceFlags.length !== 0 && acceptanceFlags.length !== 3) {
    throw new Error(`${USAGE}\n\nAcceptance requires --artifact-id, --accepted-by, and --accepted-at together.`);
  }
  if (acceptanceFlags.length === 3 && modes[0] !== "--draft") {
    throw new Error(`${USAGE}\n\nAcceptance applies only to --draft.`);
  }

  return {
    engagementRoot,
    agentDirectory,
    libraryDirectory,
    mode: modes[0] === "--draft" ? "draft" : modes[0] === "--opt-out-at" ? "opt-out" : "close",
    ...optional(values, "--draft", "draftPath"),
    ...optional(values, "--opt-out-at", "optOutAt"),
    ...optional(values, "--close-at", "closeAt"),
    ...(acceptanceFlags.length === 3
      ? {
          acceptance: {
            artifactId: values.get("--artifact-id")!,
            acceptedBy: values.get("--accepted-by")!,
            acceptedAt: values.get("--accepted-at")!,
          },
        }
      : {}),
    ...optional(values, "--engagement-id", "engagementId"),
    ...optional(values, "--agent-id", "agentId"),
    ...optional(values, "--opened-at", "openedAt"),
  };
}

export async function runExpertLearningCli(argv: string[]): Promise<ExpertLearningOutcome> {
  const args = parseExpertLearningArguments(argv);
  const store = await openEngagementStore({
    engagementRoot: args.engagementRoot,
    agentDirectory: args.agentDirectory,
    libraryDirectory: args.libraryDirectory,
    ...(args.engagementId === undefined ? {} : { engagementId: args.engagementId }),
    ...(args.agentId === undefined ? {} : { agentId: args.agentId }),
    ...(args.openedAt === undefined ? {} : { openedAt: args.openedAt }),
  });

  if (args.mode === "opt-out") {
    return { kind: "opted-out", record: await store.recordLearningOptOut(args.optOutAt!) };
  }
  if (args.mode === "close") {
    return { kind: "closed", receipt: await store.closeEngagement(args.closeAt!) };
  }

  const draftPath = resolve(args.draftPath!);
  // A draft written inside per-engagement storage would be client content
  // wearing a generalization's name, so it is refused before it is read.
  if (await isEngagementHeldPath(draftPath)) {
    throw new Error("the draft file is held in per-engagement storage; author it outside the engagement");
  }
  const text = await readFile(draftPath, "utf8");
  const sealed = await extractEngagementLearning(store, { text });
  if (args.acceptance === undefined) {
    return {
      kind: "sealed",
      characters: sealed.text.length,
      lines: sealed.text.split("\n").length,
    };
  }
  return {
    kind: "accepted",
    receipt: await acceptEngagementLearning({
      agentDirectory: args.agentDirectory,
      learning: sealed,
      artifactId: args.acceptance.artifactId,
      acceptedBy: args.acceptance.acceptedBy,
      acceptedAt: args.acceptance.acceptedAt,
    }),
  };
}

/** Reports counts and rule outcomes only: never draft text and never client content. */
export function describeExpertLearningOutcome(outcome: ExpertLearningOutcome): string[] {
  if (outcome.kind === "sealed") {
    return [
      `Sealed a learning draft: ${outcome.characters} characters, ${outcome.lines} lines.`,
      `Nothing was written. It would land as a ${LEARNING_ARTIFACT_KIND} derived artifact.`,
      "[MANUAL] Review the draft, then re-run with --artifact-id, --accepted-by, and --accepted-at to accept it.",
    ];
  }
  if (outcome.kind === "accepted") {
    return [
      `Accepted ${outcome.receipt.artifactKind} \`${outcome.receipt.artifactId}\` for ${outcome.receipt.acceptedBy}.`,
      ...outcome.receipt.files.map((file) => `  ${file.path} (${file.bytes} bytes)`),
      "[MANUAL] Commit the accepted artifact in the agent repository as a reviewed change.",
    ];
  }
  if (outcome.kind === "opted-out") {
    return [
      "Recorded the learning opt-out. Extraction is refused from this moment.",
      "It is prospective only: learning already accepted is not unwound.",
    ];
  }
  return [
    "Closed the engagement and deleted its client content.",
    `  items deleted: ${outcome.receipt.removedItemCount}`,
    `  bytes deleted: ${outcome.receipt.removedByteCount}`,
    `  items remaining in per-engagement storage: ${outcome.receipt.contentRemaining}`,
  ];
}

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined) throw new Error(`${USAGE}\n\nMissing required argument: ${flag}`);
  return value;
}

function optional<K extends string>(
  values: Map<string, string>,
  flag: string,
  key: K,
): Record<K, string> | Record<string, never> {
  const value = values.get(flag);
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

if (import.meta.main) {
  try {
    for (const line of describeExpertLearningOutcome(await runExpertLearningCli(process.argv.slice(2)))) {
      console.log(line);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Expert learning failed.");
    process.exitCode = 1;
  }
}
