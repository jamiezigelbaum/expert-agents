import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import {
  canonicalJson,
  sha256,
  validateLibraryLocationConfig,
  type Sha256Id,
} from "../packages/library/src/index.ts";
import {
  GcsCasConflictError,
  GoogleGcsAdapter,
  GoogleVertexAdapter,
  accessTokenProviderFromEnv,
  discoverImportPartition,
  isVertexImportRejection,
  type GcsAdapter,
  type ImportPartitionAttempt,
  type VertexAdapter,
} from "../packages/library-materializer/src/index.ts";

const VERTEX_LOCATION = "us-central1";
const PROBE_PATH_SEGMENT = "scratch-probe";
const USAGE = `Usage: bun run library:partition -- --bucket <bucket> --prefix <prefix> --file <path> --scratch-corpus <displayName> --out <dir> --receipt <path>

Discovers an importable partition by uploading probes to <prefix>-probe/${PROBE_PATH_SEGMENT}/.
The scratch corpus display name must start with scratch-.`;

export interface PartitionForImportCliDependencies {
  env?: Record<string, string | undefined>;
  gcs?: GcsAdapter;
  vertex?: VertexAdapter;
  readFileImpl?: typeof readFile;
  mkdirImpl?: typeof mkdir;
  writeFileImpl?: typeof writeFile;
}

export interface PartitionForImportCliResult {
  partPaths: string[];
  receiptPath: string;
  receiptBytes: Uint8Array;
}

export interface ImportPartitionDiscoveryReceipt {
  schemaVersion: 1;
  kind: "import_partition_discovery_receipt";
  sourceSha256: Sha256Id;
  scratchCorpusDisplayName: string;
  partCount: number;
  parts: Array<{
    index: number;
    byteSize: number;
    sha256: Sha256Id;
    startOffset: number;
    endOffset: number;
  }>;
  probeAttempts: {
    total: number;
    accepted: number;
    rejected: number;
    tree: ImportPartitionAttempt;
  };
  probeObjectPaths: string[];
  receiptHash: Sha256Id;
}

interface CliArguments {
  bucket: string;
  prefix: string;
  probePrefix: string;
  filePath: string;
  scratchCorpusDisplayName: string;
  outputDirectory: string;
  receiptPath: string;
}

type UnhashedReceipt = Omit<ImportPartitionDiscoveryReceipt, "receiptHash">;

export async function runPartitionForImportCli(
  argv: string[],
  dependencies: PartitionForImportCliDependencies = {},
): Promise<PartitionForImportCliResult> {
  const args = parsePartitionForImportArguments(argv);
  const env = dependencies.env ?? process.env;
  const read = dependencies.readFileImpl ?? readFile;
  const source = new Uint8Array(await read(args.filePath));
  const sourceSha256 = sha256(source);
  const tokenProvider = dependencies.gcs === undefined || dependencies.vertex === undefined
    ? accessTokenProviderFromEnv(env)
    : undefined;
  const gcs = dependencies.gcs ?? new GoogleGcsAdapter({
    bucket: args.bucket,
    prefix: args.probePrefix,
    tokenProvider: tokenProvider!,
  });
  // The probe must import exactly the way materialization does, or the
  // partition it discovers does not transfer to the real import.
  const vertex = dependencies.vertex ?? new GoogleVertexAdapter({
    project: await resolveGoogleProject(env, read),
    location: VERTEX_LOCATION,
    tokenProvider: tokenProvider!,
    importResultGcsPrefix: `gs://${args.bucket}/${args.probePrefix}/import-results/`,
    ...(env.EXPERT_AGENTS_DOMAIN_EXPERT_RAG_PARSER_MODEL === undefined
      ? {}
      : { parserModel: env.EXPERT_AGENTS_DOMAIN_EXPERT_RAG_PARSER_MODEL }),
  });
  const corpusResourceName = await vertex.ensureCorpus(args.scratchCorpusDisplayName);
  const probeObjectPaths: string[] = [];
  let attemptNumber = 0;

  const partition = await discoverImportPartition(source, async (piece) => {
    attemptNumber += 1;
    const relativeProbePath = probePath(sourceSha256, attemptNumber, sha256(piece));
    const gcsUri = `gs://${args.bucket}/${args.probePrefix}/${relativeProbePath}`;
    probeObjectPaths.push(gcsUri);
    await createProbeObject(gcs, relativeProbePath, piece);
    try {
      await vertex.importFile(corpusResourceName, gcsUri);
      return true;
    } catch (error) {
      if (isVertexImportRejection(error)) return false;
      throw error;
    }
  });

  const attemptSummary = summarizeAttemptTree(partition.attemptTree);
  const receipt = finalizeReceipt({
    schemaVersion: 1,
    kind: "import_partition_discovery_receipt",
    sourceSha256,
    scratchCorpusDisplayName: args.scratchCorpusDisplayName,
    partCount: partition.parts.length,
    parts: partition.parts.map((part, index) => ({
      index: index + 1,
      byteSize: part.bytes.byteLength,
      sha256: sha256(part.bytes),
      startOffset: part.startOffset,
      endOffset: part.endOffset,
    })),
    probeAttempts: {
      ...attemptSummary,
      tree: partition.attemptTree,
    },
    probeObjectPaths,
  });
  const receiptBytes = new TextEncoder().encode(serializeImportPartitionDiscoveryReceipt(receipt));
  assertImportPartitionReceiptContainsNoSecrets(
    receiptBytes,
    await credentialForbiddenValues(env, read),
  );

  const outputDirectory = resolve(args.outputDirectory);
  await (dependencies.mkdirImpl ?? mkdir)(outputDirectory, { recursive: true });
  const partPaths: string[] = [];
  const stem = sourceStem(args.filePath);
  const indexWidth = Math.max(2, String(partition.parts.length).length);
  for (let index = 0; index < partition.parts.length; index += 1) {
    const partPath = resolve(outputDirectory, `${stem}.part${String(index + 1).padStart(indexWidth, "0")}.md`);
    await (dependencies.writeFileImpl ?? writeFile)(partPath, partition.parts[index]!.bytes);
    partPaths.push(partPath);
  }
  const receiptPath = resolve(args.receiptPath);
  await (dependencies.mkdirImpl ?? mkdir)(dirname(receiptPath), { recursive: true });
  await (dependencies.writeFileImpl ?? writeFile)(receiptPath, receiptBytes);
  return { partPaths, receiptPath, receiptBytes };
}

export function parsePartitionForImportArguments(argv: string[]): CliArguments {
  const allowed = new Set(["--bucket", "--prefix", "--file", "--scratch-corpus", "--out", "--receipt"]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!allowed.has(argument)) throw new Error(`${USAGE}\n\nUnknown argument: ${argument}`);
    if (values.has(argument)) throw new Error(`${USAGE}\n\nDuplicate argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${USAGE}\n\nMissing value for ${argument}.`);
    }
    values.set(argument, value);
    index += 1;
  }

  const location = validateLibraryLocationConfig({
    bucket: requireArgument(values, "--bucket"),
    prefix: requireArgument(values, "--prefix"),
  });
  const scratchCorpusDisplayName = requireArgument(values, "--scratch-corpus");
  if (!scratchCorpusDisplayName.startsWith("scratch-")) {
    throw new Error("--scratch-corpus must start with scratch-");
  }
  const probePrefix = `${location.prefix}-probe`;
  validateLibraryLocationConfig({ bucket: location.bucket, prefix: probePrefix });
  return {
    bucket: location.bucket,
    prefix: location.prefix,
    probePrefix,
    filePath: requireArgument(values, "--file"),
    scratchCorpusDisplayName,
    outputDirectory: requireArgument(values, "--out"),
    receiptPath: requireArgument(values, "--receipt"),
  };
}

export function serializeImportPartitionDiscoveryReceipt(
  receipt: ImportPartitionDiscoveryReceipt,
): string {
  const { receiptHash, ...unhashed } = receipt;
  if (sha256(canonicalJson(unhashed)) !== receiptHash) {
    throw new Error("import partition receipt hash does not match its canonical content");
  }
  return canonicalJson(receipt);
}

export function assertImportPartitionReceiptContainsNoSecrets(
  receiptBytes: Uint8Array,
  forbiddenValues: readonly string[],
): void {
  const receipt = new TextDecoder("utf-8", { fatal: true }).decode(receiptBytes);
  if (forbiddenValues.some((value) => value.length > 0 && receipt.includes(value))) {
    throw new Error("Refusing to write import partition receipt because it contains credential material.");
  }
}

async function createProbeObject(gcs: GcsAdapter, path: string, bytes: Uint8Array): Promise<void> {
  try {
    await gcs.writeIfGeneration(path, bytes, 0);
  } catch (error) {
    if (!(error instanceof GcsCasConflictError)) throw error;
    const existing = await gcs.read(path);
    if (existing === null || !bytesEqual(existing.bytes, bytes)) {
      throw new Error(`probe object creation conflict for ${path}`);
    }
  }
}

function probePath(
  sourceSha256: Sha256Id,
  attemptNumber: number,
  pieceSha256: Sha256Id,
): string {
  const sourceDigest = sourceSha256.slice("sha256:".length);
  const pieceDigest = pieceSha256.slice("sha256:".length);
  return `${PROBE_PATH_SEGMENT}/${sourceDigest}/attempt-${String(attemptNumber).padStart(4, "0")}-${pieceDigest}.md`;
}

function summarizeAttemptTree(tree: ImportPartitionAttempt): {
  total: number;
  accepted: number;
  rejected: number;
} {
  let total = 1;
  let accepted = tree.outcome === "accepted" ? 1 : 0;
  let rejected = tree.outcome === "rejected" ? 1 : 0;
  for (const child of tree.children ?? []) {
    const summary = summarizeAttemptTree(child);
    total += summary.total;
    accepted += summary.accepted;
    rejected += summary.rejected;
  }
  return { total, accepted, rejected };
}

function finalizeReceipt(receipt: UnhashedReceipt): ImportPartitionDiscoveryReceipt {
  return {
    ...receipt,
    receiptHash: sha256(canonicalJson(receipt)),
  };
}

function sourceStem(path: string): string {
  const filename = basename(path);
  const extension = extname(filename);
  return extension.length === 0 ? filename : filename.slice(0, -extension.length);
}

async function resolveGoogleProject(
  env: Record<string, string | undefined>,
  read: typeof readFile,
): Promise<string> {
  const configured = env.EXPERT_AGENTS_GCP_PROJECT?.trim();
  if (configured) return configured;
  const raw = env.EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_JSON
    ?? (env.EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_JSON_FILE === undefined
      ? undefined
      : await read(env.EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_JSON_FILE, "utf8"));
  if (raw !== undefined) {
    try {
      const value = JSON.parse(raw) as { project_id?: unknown };
      if (typeof value.project_id === "string" && value.project_id.trim() === value.project_id && value.project_id.length > 0) {
        return value.project_id;
      }
    } catch {
      // Authentication reports malformed credential JSON without exposing it.
    }
  }
  throw new Error("Vertex project is not configured; set EXPERT_AGENTS_GCP_PROJECT or service-account project_id");
}

async function credentialForbiddenValues(
  env: Record<string, string | undefined>,
  read: typeof readFile,
): Promise<string[]> {
  const values = [env.EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_ACCESS_TOKEN];
  const raw = env.EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_JSON
    ?? (env.EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_JSON_FILE === undefined
      ? undefined
      : await read(env.EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_JSON_FILE, "utf8").catch(() => undefined));
  if (raw !== undefined) {
    values.push(raw);
    try {
      const parsed = JSON.parse(raw) as { private_key?: unknown };
      if (typeof parsed.private_key === "string") values.push(parsed.private_key);
    } catch {
      // Google authentication reports malformed JSON without exposing it.
    }
  }
  return values.filter((value): value is string => value !== undefined && value !== "");
}

function requireArgument(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined || value.length === 0) throw new Error(`${USAGE}\n\nMissing required argument: ${name}`);
  return value;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

if (import.meta.main) {
  try {
    const result = await runPartitionForImportCli(process.argv.slice(2));
    console.log(`wrote ${result.partPaths.length} import partition parts and receipt to ${result.receiptPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "import partition discovery failed");
    process.exitCode = 1;
  }
}
