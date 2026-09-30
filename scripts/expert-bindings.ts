import { canonicalJson } from "../packages/library/src/index.ts";
import {
  emitBindingArtifacts,
  verifyBindingConfig,
  type BindingEmitResult,
  type BindingVerificationReport,
} from "../packages/provisioning/src/index.ts";

const USAGE = `Usage:
  bun run expert:bindings -- --dir <agent-repository> --emit --out <output-directory>
  bun run expert:bindings -- --dir <agent-repository> --verify --gateway-config <path>`;

export interface ExpertBindingsEmitArguments {
  mode: "emit";
  directory: string;
  outputDirectory: string;
}

export interface ExpertBindingsVerifyArguments {
  mode: "verify";
  directory: string;
  gatewayConfigPath: string;
}

export type ExpertBindingsArguments = ExpertBindingsEmitArguments | ExpertBindingsVerifyArguments;

export function parseExpertBindingsArguments(argv: string[]): ExpertBindingsArguments {
  const validDirectory = argv.length === 5
    && argv[0] === "--dir"
    && argv[1] !== undefined
    && !argv[1].startsWith("--");
  if (!validDirectory) throw new Error(USAGE);
  if (
    argv.length !== 5
    || argv[2] !== "--emit"
    || argv[3] !== "--out"
    || argv[4] === undefined
    || argv[4].startsWith("--")
  ) {
    if (
      argv[2] === "--verify"
      && argv[3] === "--gateway-config"
      && argv[4] !== undefined
      && !argv[4].startsWith("--")
    ) {
      return { mode: "verify", directory: argv[1]!, gatewayConfigPath: argv[4] };
    }
    throw new Error(USAGE);
  }
  return { mode: "emit", directory: argv[1]!, outputDirectory: argv[4] };
}

export async function runExpertBindingsCli(
  argv: string[],
): Promise<BindingEmitResult | BindingVerificationReport> {
  const args = parseExpertBindingsArguments(argv);
  return args.mode === "emit"
    ? emitBindingArtifacts(args.directory, args.outputDirectory)
    : verifyBindingConfig(args.directory, args.gatewayConfigPath);
}

export function expertBindingsExitCode(result: BindingEmitResult | BindingVerificationReport): 0 | 1 {
  return isBindingVerification(result) && !result.valid ? 1 : 0;
}

if (import.meta.main) {
  try {
    const result = await runExpertBindingsCli(process.argv.slice(2));
    if (isBindingVerification(result)) {
      process.stdout.write(canonicalJson(result));
    } else {
      console.log(`Binding descriptor: ${result.outputDir}/binding-descriptor.json`);
      console.log(`Application checklist: ${result.outputDir}/APPLICATION_CHECKLIST.md`);
      console.log(`Binding receipt: ${result.outputDir}/BINDING_RECEIPT.json`);
    }
    process.exitCode = expertBindingsExitCode(result);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Expert bindings failed.");
    process.exitCode = 1;
  }
}

function isBindingVerification(
  result: BindingEmitResult | BindingVerificationReport,
): result is BindingVerificationReport {
  return "kind" in result && result.kind === "expert_binding_verification";
}
