import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  GoogleGcsAdapter,
  GoogleVertexAdapter,
  accessTokenProviderFromEnv,
  assertMaterializationReceiptContainsNoSecrets,
  materializeScope,
  serializeMaterializationReceipt,
  type CandidateObjectMetadata,
  type GcsAdapter,
  type MaterializerCandidate,
  type VertexAdapter,
} from "../packages/library-materializer/src/index.ts";

const CANDIDATE_DESCRIPTOR = "candidates.json";
const VERTEX_LOCATION = "us-central1";
const USAGE = `Usage: bun run library:materialize -- --bucket <bucket> --prefix <prefix> --scope <path> --candidates <dir> --receipt <path> [--execute]

Without --execute, the command is plan-only and performs no cloud writes.
Candidate governance metadata is read from <dir>/candidates.json.`;

export interface MaterializeScopeCliDependencies {
  env?: Record<string, string | undefined>;
  gcs?: GcsAdapter;
  vertex?: VertexAdapter;
  readFileImpl?: typeof readFile;
  realpathImpl?: typeof realpath;
  mkdirImpl?: typeof mkdir;
  writeFileImpl?: typeof writeFile;
}

export interface MaterializeScopeCliResult {
  receiptPath: string;
  receiptBytes: Uint8Array;
}

interface CliArguments {
  bucket: string;
  prefix: string;
  scopePath: string;
  candidatesDirectory: string;
  receiptPath: string;
  execute: boolean;
}

interface CandidateDescriptor {
  schemaVersion: 1;
  candidates: Array<{ path: string; metadata: CandidateObjectMetadata }>;
}

export async function runMaterializeScopeCli(
  argv: string[],
  dependencies: MaterializeScopeCliDependencies = {},
): Promise<MaterializeScopeCliResult> {
  const args = parseArguments(argv);
  const env = dependencies.env ?? process.env;
  const read = dependencies.readFileImpl ?? readFile;
  const candidates = await loadCandidates(args.candidatesDirectory, read, dependencies.realpathImpl ?? realpath);
  const tokenProvider = dependencies.gcs === undefined || (args.execute && dependencies.vertex === undefined)
    ? accessTokenProviderFromEnv(env)
    : undefined;
  const gcs = dependencies.gcs ?? new GoogleGcsAdapter({
    bucket: args.bucket,
    prefix: args.prefix,
    tokenProvider: tokenProvider!,
  });
  const vertex = dependencies.vertex ?? (args.execute
    ? new GoogleVertexAdapter({
      project: await resolveGoogleProject(env, read),
      location: VERTEX_LOCATION,
      tokenProvider: tokenProvider!,
      // Per-file import results land as durable receipts under the library
      // location instead of surviving only in transient LRO metadata.
      importResultGcsPrefix: `gs://${args.bucket}/${args.prefix}/import-results/`,
      ...(env.EXPERT_AGENTS_DOMAIN_EXPERT_RAG_PARSER_MODEL === undefined
        ? {}
        : { parserModel: env.EXPERT_AGENTS_DOMAIN_EXPERT_RAG_PARSER_MODEL }),
    })
    : planOnlyVertexAdapter());

  const receipt = await materializeScope({
    config: { bucket: args.bucket, prefix: args.prefix },
    scopeManifestPath: args.scopePath,
    candidates,
    gcs,
    vertex,
    execute: args.execute,
    readScopeManifest: async (path) => read(path, "utf8"),
  });
  const receiptBytes = new TextEncoder().encode(serializeMaterializationReceipt(receipt));
  assertMaterializationReceiptContainsNoSecrets(
    receiptBytes,
    await credentialForbiddenValues(env, read),
  );
  const receiptPath = resolve(args.receiptPath);
  await (dependencies.mkdirImpl ?? mkdir)(dirname(receiptPath), { recursive: true });
  await (dependencies.writeFileImpl ?? writeFile)(receiptPath, receiptBytes);
  return { receiptPath, receiptBytes };
}

export function parseMaterializeScopeArguments(argv: string[]): CliArguments {
  return parseArguments(argv);
}

async function loadCandidates(
  directory: string,
  read: typeof readFile,
  resolveRealpath: typeof realpath,
): Promise<MaterializerCandidate[]> {
  const root = await resolveRealpath(resolve(directory));
  const descriptorPath = resolve(root, CANDIDATE_DESCRIPTOR);
  const descriptor = parseCandidateDescriptor(await read(descriptorPath, "utf8"));
  const candidates: MaterializerCandidate[] = [];
  for (const entry of descriptor.candidates) {
    const candidatePath = resolve(root, entry.path);
    assertPathWithin(root, candidatePath);
    const realCandidatePath = await resolveRealpath(candidatePath);
    assertPathWithin(root, realCandidatePath);
    candidates.push({
      path: entry.path,
      bytes: async () => new Uint8Array(await read(realCandidatePath)),
      metadata: entry.metadata,
    });
  }
  return candidates;
}

function parseCandidateDescriptor(text: string): CandidateDescriptor {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("candidate descriptor is not valid JSON");
  }
  const record = requireRecord(value, "candidate descriptor");
  requireExactKeys(record, ["schemaVersion", "candidates"], "candidate descriptor");
  if (record.schemaVersion !== 1 || !Array.isArray(record.candidates)) {
    throw new Error("candidate descriptor schema is invalid");
  }
  const paths = new Set<string>();
  const candidates = record.candidates.map((value) => {
    const candidate = requireRecord(value, "candidate descriptor entry");
    requireExactKeys(candidate, ["path", "metadata"], "candidate descriptor entry");
    const path = requirePortableRelativePath(candidate.path);
    if (path === CANDIDATE_DESCRIPTOR || paths.has(path)) {
      throw new Error("candidate descriptor paths must be unique data-file paths");
    }
    paths.add(path);
    return {
      path,
      metadata: requireRecord(candidate.metadata, "candidate descriptor metadata") as unknown as CandidateObjectMetadata,
    };
  }).sort((left, right) => compareStrings(left.path, right.path));
  return { schemaVersion: 1, candidates };
}

function parseArguments(argv: string[]): CliArguments {
  const values = new Map<string, string>();
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--execute") {
      if (execute) throw new Error(`${USAGE}\n\n--execute was provided more than once.`);
      execute = true;
      continue;
    }
    if (!["--bucket", "--prefix", "--scope", "--candidates", "--receipt"].includes(argument)) {
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
  const bucket = requireArgument(values, "--bucket");
  const prefix = requireArgument(values, "--prefix");
  if (prefix.length === 0 || prefix === "/") {
    throw new Error("--prefix must not be empty or /");
  }
  return {
    bucket,
    prefix,
    scopePath: requireArgument(values, "--scope"),
    candidatesDirectory: requireArgument(values, "--candidates"),
    receiptPath: requireArgument(values, "--receipt"),
    execute,
  };
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
      // Authentication reports malformed credential JSON without exposing it.
    }
  }
  return values.filter((value): value is string => value !== undefined && value !== "");
}

function planOnlyVertexAdapter(): VertexAdapter {
  const fail = async (): Promise<never> => {
    throw new Error("plan-only mode attempted a Vertex operation");
  };
  return {
    ensureCorpus: fail,
    importFile: fail,
    listFiles: fail,
  };
}

function requireArgument(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined || value.length === 0) throw new Error(`${USAGE}\n\nMissing required argument: ${name}`);
  return value;
}

function requirePortableRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.includes("\\")) {
    throw new Error("candidate descriptor path must be a portable relative path");
  }
  if (value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("candidate descriptor path must not traverse directories");
  }
  return value;
}

function assertPathWithin(root: string, path: string): void {
  const child = relative(root, path);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || child.startsWith(sep)) {
    throw new Error("candidate descriptor path resolves outside the candidate directory");
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: string[], name: string): void {
  const expected = new Set(keys);
  if (keys.some((key) => !(key in record)) || Object.keys(record).some((key) => !expected.has(key))) {
    throw new Error(`${name} fields are invalid`);
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

if (import.meta.main) {
  try {
    const result = await runMaterializeScopeCli(process.argv.slice(2));
    console.log(`wrote library materialization receipt to ${result.receiptPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "library materialization failed");
    process.exitCode = 1;
  }
}
