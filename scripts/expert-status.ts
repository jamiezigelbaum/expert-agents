import { canonicalJson } from "../packages/library/src/index.ts";
import { expertStatus, type ExpertStatusReport } from "../packages/provisioning/src/index.ts";

const USAGE = "Usage: bun run expert:status -- --dir <agent-repository> [--require-sync]";

export interface ExpertStatusCliArguments {
  directory: string;
  requireSync: boolean;
}

export function parseExpertStatusArguments(argv: string[]): ExpertStatusCliArguments {
  let directory: string | undefined;
  let requireSync = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--require-sync" && !requireSync) {
      requireSync = true;
      continue;
    }
    if (argument === "--dir" && directory === undefined) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(USAGE);
      directory = value;
      index += 1;
      continue;
    }
    throw new Error(USAGE);
  }
  if (directory === undefined) throw new Error(USAGE);
  return { directory, requireSync };
}

export async function runExpertStatusCli(argv: string[]): Promise<ExpertStatusReport> {
  const args = parseExpertStatusArguments(argv);
  return expertStatus(args.directory);
}

export function expertStatusExitCode(
  report: ExpertStatusReport,
  requireSync = false,
): 0 | 1 {
  if (!report.valid) return 1;
  if (!requireSync) return 0;
  if (report.git === null || !report.git.isRepo) return 1;
  return report.git.behindCount > 0
    || report.git.dirtyTrackedCount > 0
    || !report.git.hasUpstream
    ? 1
    : 0;
}

if (import.meta.main) {
  try {
    const args = parseExpertStatusArguments(process.argv.slice(2));
    const report = await expertStatus(args.directory);
    process.stdout.write(canonicalJson(report));
    process.exitCode = expertStatusExitCode(report, args.requireSync);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Expert status failed.");
    process.exitCode = 1;
  }
}
