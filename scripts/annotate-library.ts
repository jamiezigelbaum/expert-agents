import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import {
  applyManifestUpdate,
  canonicalJson,
  parseMasterManifest,
  serializeMasterManifest,
  type AnnotateOperation,
  type MasterManifest,
  type Sha256Id,
} from "../packages/library/src/index.ts";
import {
  GcsCasConflictError,
  GoogleGcsAdapter,
  accessTokenProviderFromEnv,
  type GcsAdapter,
  type GcsGeneration,
} from "../packages/library-materializer/src/index.ts";

const MASTER_MANIFEST_PATH = "manifest/master.json";
const USAGE = `Usage:
  bun run library:annotate -- --bucket <bucket> --prefix <prefix> --propose --out <file>
  bun run library:annotate -- --bucket <bucket> --prefix <prefix> --execute --annotations <file> --receipt <file>

Proposal mode reads the master manifest and performs no cloud writes.
Execute mode requires a reviewed annotations document and updates the manifest with generation CAS.`;

export interface AnnotateLibraryCliDependencies {
  env?: Record<string, string | undefined>;
  gcs?: GcsAdapter;
  readFileImpl?: typeof readFile;
  mkdirImpl?: typeof mkdir;
  writeFileImpl?: typeof writeFile;
}

export interface AnnotateLibraryCliResult {
  mode: "propose" | "execute";
  outputPath: string;
  outputBytes: Uint8Array;
}

export interface AnnotationProposal {
  objectId: Sha256Id;
  title: string;
  creator?: string;
}

export interface AnnotationReceipt {
  schemaVersion: 1;
  kind: "library_annotation_receipt";
  masterRevision: { before: number; after: number };
  applied: Array<{ objectId: Sha256Id; fields: Array<"creator" | "title"> }>;
  objectIds: Sha256Id[];
  casConflicts: number;
  summary: {
    annotations: number;
    titleFields: number;
    creatorFields: number;
  };
}

type CliArguments =
  | { mode: "propose"; bucket: string; prefix: string; outputPath: string }
  | { mode: "execute"; bucket: string; prefix: string; annotationsPath: string; receiptPath: string };

interface AnnotationDocument {
  schemaVersion: 1;
  expectedRevision: number;
  annotations: AnnotateOperation[];
}

interface ManifestState {
  manifest: MasterManifest;
  generation: GcsGeneration;
}

export async function runAnnotateLibraryCli(
  argv: string[],
  dependencies: AnnotateLibraryCliDependencies = {},
): Promise<AnnotateLibraryCliResult> {
  const args = parseAnnotateLibraryArguments(argv);
  const env = dependencies.env ?? process.env;
  const read = dependencies.readFileImpl ?? readFile;
  const gcs = dependencies.gcs ?? new GoogleGcsAdapter({
    bucket: args.bucket,
    prefix: args.prefix,
    tokenProvider: accessTokenProviderFromEnv(env),
  });
  const state = await readManifest(gcs);

  if (args.mode === "propose") {
    const proposals = state.manifest.objects
      .filter((object) => object.title === undefined && object.creator === undefined)
      .map((object) => ({
        objectId: object.id,
        ...deriveAnnotationFromLocator(object.sourceLocators[0]!),
      }))
      .sort((left, right) => compareStrings(left.objectId, right.objectId));
    const outputBytes = encode(canonicalJson({
      schemaVersion: 1,
      masterRevision: state.manifest.revision,
      proposals,
    }));
    const outputPath = resolve(args.outputPath);
    await writeOutput(outputPath, outputBytes, dependencies);
    return { mode: "propose", outputPath, outputBytes };
  }

  const document = parseAnnotationDocument(await read(args.annotationsPath, "utf8"));
  const updated = await applyAnnotationsWithSingleRetry(gcs, state, document);
  const receipt = annotationReceipt(
    document,
    state.manifest.revision,
    updated.manifest.revision,
    updated.casConflicts,
  );
  const outputBytes = encode(canonicalJson(receipt));
  assertAnnotationReceiptContainsNoSecrets(
    outputBytes,
    await credentialForbiddenValues(env, read),
  );
  const outputPath = resolve(args.receiptPath);
  await writeOutput(outputPath, outputBytes, dependencies);
  return { mode: "execute", outputPath, outputBytes };
}

export function parseAnnotateLibraryArguments(argv: string[]): CliArguments {
  const values = new Map<string, string>();
  let propose = false;
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--propose" || argument === "--execute") {
      if (argument === "--propose") {
        if (propose) throw new Error(`${USAGE}\n\n--propose was provided more than once.`);
        propose = true;
      } else {
        if (execute) throw new Error(`${USAGE}\n\n--execute was provided more than once.`);
        execute = true;
      }
      continue;
    }
    if (!["--bucket", "--prefix", "--out", "--annotations", "--receipt"].includes(argument)) {
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
  if (propose === execute) throw new Error(`${USAGE}\n\nChoose exactly one of --propose or --execute.`);
  const bucket = requireArgument(values, "--bucket");
  const prefix = requireArgument(values, "--prefix");
  if (prefix === "/") throw new Error("--prefix must not be /");
  if (propose) {
    rejectPresent(values, ["--annotations", "--receipt"], "proposal mode");
    return { mode: "propose", bucket, prefix, outputPath: requireArgument(values, "--out") };
  }
  rejectPresent(values, ["--out"], "execute mode");
  return {
    mode: "execute",
    bucket,
    prefix,
    annotationsPath: requireArgument(values, "--annotations"),
    receiptPath: requireArgument(values, "--receipt"),
  };
}

export function deriveAnnotationFromLocator(locator: string): { title: string; creator?: string } {
  let path = locator.split(/[?#]/, 1)[0] ?? locator;
  try {
    path = new URL(locator).pathname;
  } catch {
    // Non-URL locators still have slash-delimited basenames.
  }
  let slug = basename(path) || path;
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // Preserve malformed percent encodings as literal slug text.
  }
  const extension = extname(slug);
  if (extension) slug = slug.slice(0, -extension.length);
  const tokens = slug.split(/[-_\s]+/).filter(Boolean);
  if (tokens.length === 0) throw new Error("source locator basename cannot produce an annotation title");
  // Three tokens provide one leading creator token; four or more provide two.
  // One/two-token slugs do not provide enough evidence for a creator split.
  const creatorTokenCount = tokens.length >= 4 ? 2 : tokens.length === 3 ? 1 : 0;
  if (creatorTokenCount === 0) return { title: titleCaseTokens(tokens) };
  return {
    title: titleCaseTokens(tokens.slice(creatorTokenCount)),
    creator: titleCaseTokens(tokens.slice(0, creatorTokenCount)),
  };
}

export function serializeAnnotationReceipt(receipt: AnnotationReceipt): string {
  return canonicalJson(receipt);
}

export function assertAnnotationReceiptContainsNoSecrets(
  receiptBytes: Uint8Array,
  forbiddenValues: readonly string[],
): void {
  const receipt = new TextDecoder("utf-8", { fatal: true }).decode(receiptBytes);
  if (forbiddenValues.some((value) => value.length > 0 && receipt.includes(value))) {
    throw new Error("Refusing to write annotation receipt because it contains credential material.");
  }
}

async function readManifest(gcs: GcsAdapter): Promise<ManifestState> {
  const read = await gcs.read(MASTER_MANIFEST_PATH);
  if (read === null) throw new Error("master manifest does not exist");
  return {
    manifest: parseMasterManifest(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)),
    generation: read.generation,
  };
}

async function applyAnnotationsWithSingleRetry(
  gcs: GcsAdapter,
  initial: ManifestState,
  document: AnnotationDocument,
): Promise<ManifestState & { casConflicts: number }> {
  let state = initial;
  let casConflicts = 0;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const next = applyManifestUpdate(state.manifest, {
      expectedRevision: document.expectedRevision,
      annotate: document.annotations,
    });
    try {
      const generation = await gcs.writeIfGeneration(
        MASTER_MANIFEST_PATH,
        encode(serializeMasterManifest(next)),
        state.generation,
      );
      return { manifest: next, generation, casConflicts };
    } catch (error) {
      if (!(error instanceof GcsCasConflictError)) throw error;
      casConflicts += 1;
      if (attempt === 2) throw new Error("master manifest compare-and-set failed after 2 attempts");
      state = await readManifest(gcs);
    }
  }
  throw new Error("master manifest compare-and-set failed after 2 attempts");
}

function parseAnnotationDocument(text: string): AnnotationDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("annotations document is not valid JSON");
  }
  const record = requireRecord(value, "annotations document");
  requireExactKeys(record, ["schemaVersion", "expectedRevision", "annotations"], "annotations document");
  if (record.schemaVersion !== 1
    || !Number.isSafeInteger(record.expectedRevision)
    || (record.expectedRevision as number) < 0
    || !Array.isArray(record.annotations)
    || record.annotations.length === 0) {
    throw new Error("annotations document schema is invalid");
  }
  const annotations = record.annotations.map((value) => {
    const annotation = requireRecord(value, "annotation");
    const allowed = new Set(["objectId", "title", "creator", "updatedAt"]);
    if (!("objectId" in annotation)
      || !("updatedAt" in annotation)
      || Object.keys(annotation).some((key) => !allowed.has(key))) {
      throw new Error("annotation fields are invalid");
    }
    const objectId = requireObjectId(annotation.objectId);
    const title = annotation.title === undefined ? undefined : requireTrimmedString(annotation.title, "annotation title");
    const creator = annotation.creator === undefined ? undefined : requireTrimmedString(annotation.creator, "annotation creator");
    if (title === undefined && creator === undefined) throw new Error("annotation requires a title or creator");
    const updatedAt = requireCanonicalTimestamp(annotation.updatedAt);
    return {
      objectId,
      ...(title === undefined ? {} : { title }),
      ...(creator === undefined ? {} : { creator }),
      updatedAt,
    };
  });
  return {
    schemaVersion: 1,
    expectedRevision: record.expectedRevision as number,
    annotations,
  };
}

function annotationReceipt(
  document: AnnotationDocument,
  before: number,
  after: number,
  casConflicts: number,
): AnnotationReceipt {
  const applied = document.annotations
    .map((annotation) => ({
      objectId: annotation.objectId,
      fields: [
        ...(annotation.creator === undefined ? [] : ["creator" as const]),
        ...(annotation.title === undefined ? [] : ["title" as const]),
      ],
    }))
    .sort((left, right) => compareStrings(left.objectId, right.objectId));
  return {
    schemaVersion: 1,
    kind: "library_annotation_receipt",
    masterRevision: { before, after },
    applied,
    objectIds: applied.map((entry) => entry.objectId),
    casConflicts,
    summary: {
      annotations: applied.length,
      titleFields: applied.filter((entry) => entry.fields.includes("title")).length,
      creatorFields: applied.filter((entry) => entry.fields.includes("creator")).length,
    },
  };
}

async function writeOutput(
  path: string,
  bytes: Uint8Array,
  dependencies: AnnotateLibraryCliDependencies,
): Promise<void> {
  await (dependencies.mkdirImpl ?? mkdir)(dirname(path), { recursive: true });
  await (dependencies.writeFileImpl ?? writeFile)(path, bytes);
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

function rejectPresent(values: Map<string, string>, names: string[], mode: string): void {
  const present = names.find((name) => values.has(name));
  if (present !== undefined) throw new Error(`${present} is not valid in ${mode}`);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: string[], name: string): void {
  const expected = new Set(keys);
  if (keys.some((key) => !(key in record)) || Object.keys(record).some((key) => !expected.has(key))) {
    throw new Error(`${name} fields are invalid`);
  }
}

function requireObjectId(value: unknown): Sha256Id {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error("annotation object id is invalid");
  return value as Sha256Id;
}

function requireTrimmedString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) throw new Error(`${name} is invalid`);
  return value;
}

function requireCanonicalTimestamp(value: unknown): string {
  const timestamp = requireTrimmedString(value, "annotation updated timestamp");
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new Error("annotation updated timestamp is invalid");
  }
  return timestamp;
}

function titleCaseTokens(tokens: string[]): string {
  return tokens.map((token) => `${token.charAt(0).toUpperCase()}${token.slice(1).toLowerCase()}`).join(" ");
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

if (import.meta.main) {
  try {
    const result = await runAnnotateLibraryCli(process.argv.slice(2));
    console.log(`wrote library annotation ${result.mode === "propose" ? "proposals" : "receipt"} to ${result.outputPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "library annotation failed");
    process.exitCode = 1;
  }
}
