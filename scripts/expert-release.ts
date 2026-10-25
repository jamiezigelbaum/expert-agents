import {
  SERVING_CHECKLIST_FILE,
  SERVING_MANIFEST_FILE,
  SERVING_MANUAL_PRECONDITIONS,
  SERVING_RECEIPT_FILE,
  SERVING_WORKSPACE_DIRECTORY,
  packageServingArtifact,
  type ServingManifest,
  type ServingPackageResult,
} from "../packages/provisioning/src/index.ts";

const USAGE = "Usage: bun run expert:release -- --dir <agent-repository> --tag <tag> --out <output-root>";

/**
 * Every corpus this artifact exposes, and at what posture.
 *
 * Copyright defaults are permissive: an undeclared corpus is `full`. That is
 * the owner's ruling and it is right for third-party sources, but it means a
 * corpus of the owner's own private holdings would ship unmarked. This summary
 * is the mitigation — visibility, never a gate. The release proceeds either
 * way; it just cannot happen silently.
 */
export function formatDisclosureSummary(manifest: ServingManifest): string[] {
  if (manifest.corpora.length === 0) {
    // What a page-library agent may disclose is set by the disclosure policy
    // on each deployment's worker route, not by this artifact.
    return [
      "This agent reads a page library and declares no corpus.",
      "Each deployment's worker route sets its disclosure: a route without a",
      "disclosure policy serves the library in full. Confirm the route this",
      "release will use before releasing it to anyone outside the owner.",
    ];
  }
  const lines = ["Corpora this artifact exposes:"];
  for (const corpus of manifest.corpora) {
    lines.push(`  ${corpus.disclosure.padEnd(8)} ${corpus.corpusId}`);
  }
  lines.push(
    "",
    "Any corpus not named above is exposed at the permissive default (full).",
    "Confirm none of them holds private material before releasing.",
  );
  return lines;
}

export interface ExpertReleaseCliArguments {
  directory: string;
  tag: string;
  outputRoot: string;
}

export function parseExpertReleaseArguments(argv: string[]): ExpertReleaseCliArguments {
  let directory: string | undefined;
  let tag: string | undefined;
  let outputRoot: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(USAGE);
    if (argument === "--dir" && directory === undefined) directory = value;
    else if (argument === "--tag" && tag === undefined) tag = value;
    else if (argument === "--out" && outputRoot === undefined) outputRoot = value;
    else throw new Error(USAGE);
    index += 1;
  }
  if (directory === undefined || tag === undefined || outputRoot === undefined) throw new Error(USAGE);
  return { directory, tag, outputRoot };
}

export async function runExpertReleaseCli(argv: string[]): Promise<ServingPackageResult> {
  const args = parseExpertReleaseArguments(argv);
  return packageServingArtifact({
    agentDirectory: args.directory,
    tag: args.tag,
    outputRoot: args.outputRoot,
  });
}

if (import.meta.main) {
  try {
    const result = await runExpertReleaseCli(process.argv.slice(2));
    console.log(`Serving workspace: ${result.outputRoot}/${SERVING_WORKSPACE_DIRECTORY}`);
    console.log(`Serving manifest: ${result.outputRoot}/${SERVING_MANIFEST_FILE}`);
    console.log(`Serving checklist: ${result.outputRoot}/${SERVING_CHECKLIST_FILE}`);
    console.log(`Serving receipt: ${result.outputRoot}/${SERVING_RECEIPT_FILE}`);
    console.log("");
    for (const line of formatDisclosureSummary(result.manifest)) {
      console.log(line);
    }
    console.log("");
    console.log("Preconditions this command did not run:");
    for (const precondition of SERVING_MANUAL_PRECONDITIONS) {
      console.log(`  [MANUAL] ${precondition}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Expert release failed.");
    process.exitCode = 1;
  }
}
