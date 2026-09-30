import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import {
  EXTRACTION_ARGUMENTS,
  EXTRACTION_MAX_OUTPUT_BYTES,
  EXTRACTION_METHOD,
  EXTRACTION_TIMEOUT_MS,
  SUMMARIZE_BINARY,
  SUMMARIZE_INSTALL_COMMAND,
  allowlistedExtractionEnv,
  canonicalJson,
  canonicalObjectRelativePath,
  contentIdFromBytes,
  extractorEnvironment,
  firstDiagnosticLine,
  isolatedExtractorEnvironment,
  normalizeExtractedText,
  sourceLocatorCredential,
  validateLibraryObject,
  type ExtractionRequest,
  type ExtractionResult,
  type LibraryObject,
  type ReferenceExtractor,
  type Sha256Id,
} from "../packages/library/src/index.ts";
import type { CandidateObjectMetadata } from "../packages/library-materializer/src/index.ts";
import { isEngagementHeldPath } from "../packages/provisioning/src/index.ts";

const CANDIDATE_DESCRIPTOR = "candidates.json";
const CORPUS_INTENT_DOCUMENT = "corpus-intents.json";

// The extraction contract itself — binary, arguments, credential strip, and
// output normalization — is shared with the domain-expert worker's web_import
// path; see packages/library/src/extraction.ts. It is re-exported here because
// this module is the ingest lane's public surface.
export {
  EXTRACTION_ARGUMENTS,
  EXTRACTION_MAX_OUTPUT_BYTES,
  EXTRACTION_TIMEOUT_MS,
  SUMMARIZE_BINARY,
  SUMMARIZE_INSTALL_COMMAND,
  allowlistedExtractionEnv,
  extractorEnvironment,
  normalizeExtractedText,
  type ExtractionRequest,
  type ExtractionResult,
  type ReferenceExtractor,
};

/**
 * The extractor's environment is built the same way the worker builds it: the
 * positive allowlist first, so a variable that carries a credential without a
 * credential-shaped name — GITHUB_PAT, DATABASE_URL, KUBECONFIG, a proxy URL
 * with userinfo — is never inherited, and the shared credential strip on top.
 */
export function ingestExtractionEnv(
  env: Record<string, string | undefined>,
  directories?: Parameters<typeof isolatedExtractorEnvironment>[1],
): Record<string, string> {
  return directories
    ? isolatedExtractorEnvironment(env, directories)
    : extractorEnvironment(allowlistedExtractionEnv(env));
}

export const EXTRACTED_MEDIA_TYPE = "text/markdown";
export const EXTRACTED_DERIVATIVE_KIND = "extracted-text";
export const INGEST_ACQUIRED_BY = "expert:ingest";
export const INGEST_ACQUISITION_METHOD = EXTRACTION_METHOD;

// Owner ruling 2026-07-28: posture is taken as generously as possible, and a
// source belongs to the public corpus unless a copyright ruling has to be
// enforced. These are the permissive defaults applied when the operator
// declares nothing; --trust-tier and --copyright-posture override them.
export const PERMISSIVE_DEFAULT_TRUST_TIER = "public-unrestricted";
export const PERMISSIVE_DEFAULT_COPYRIGHT_POSTURE = "public-unrestricted";

export const PREPARED_MAX_BYTES = EXTRACTION_MAX_OUTPUT_BYTES;
export const PREPARED_ACQUISITION_METHOD = "prepared local file (exact bytes)";
export const PREPARED_DERIVATIVE_KIND = "prepared-text";

const USAGE = `Usage: bun run expert:ingest -- --source <url-or-path> --library <dir> [--trust-tier <tier>] [--copyright-posture <posture>] [--corpus <corpus-id>] [--title <title>] [--creator <creator>] [--prepared]

Runs ${SUMMARIZE_BINARY} in extraction-only mode (no summary, no model, no credential) and
stages the extracted text as a content-addressed library object under <dir>.
--prepared accepts reviewed local .txt/.md/.markdown UTF-8 files without extraction or normalization.
Trust tier and copyright posture default to the permissive public values.
--title and --creator are carried on the staged candidate so the object cites by name, never by hash.`;

export type ExpertIngestErrorCode =
  | "prepared_source_invalid"
  | "prepared_source_too_large"
  | "invalid_arguments"
  | "credential_bearing_source"
  | "engagement_held_path"
  | "summarize_not_installed"
  | "extraction_failed"
  | "extraction_timed_out"
  | "extraction_output_too_large"
  | "extraction_empty"
  | "library_state_invalid";

export class ExpertIngestError extends Error {
  readonly code: ExpertIngestErrorCode;

  constructor(code: ExpertIngestErrorCode, message: string) {
    super(message);
    this.name = "ExpertIngestError";
    this.code = code;
  }
}

export interface ExpertIngestCliArguments {
  source: string;
  prepared?: boolean;
  libraryDirectory: string;
  trustTier?: string;
  copyrightPosture?: string;
  corpusId?: string;
  title?: string;
  creator?: string;
}

export interface ExpertIngestCliDependencies {
  summarizePath?: string | null;
  extract?: ReferenceExtractor;
  /** Overrides the contract's wall-clock bound on the extractor; tests use it to keep the bound observable. */
  timeoutMs?: number;
  /** Overrides the contract's output bound on the extractor; tests use it to keep the bound observable. */
  maxOutputBytes?: number;
  /** Bounds the prepared local file read; defaults to PREPARED_MAX_BYTES. */
  maxPreparedBytes?: number;
  env?: Record<string, string | undefined>;
  now?: () => string;
  readFileImpl?: typeof readFile;
  mkdirImpl?: typeof mkdir;
  writeFileImpl?: typeof writeFile;
}

export interface ExpertIngestCliResult {
  objectId: Sha256Id;
  relativePath: string;
  byteSize: number;
  objectPath: string;
  descriptorPath: string;
  trustTier: string;
  copyrightPosture: string;
  corpusId?: string;
  title?: string;
  creator?: string;
  alreadyStaged: boolean;
}

interface CandidateEntry {
  path: string;
  metadata: CandidateObjectMetadata;
}

interface CandidateDescriptor {
  schemaVersion: 1;
  candidates: CandidateEntry[];
}

interface CorpusIntent {
  objectId: Sha256Id;
  corpusIds: string[];
}

interface CorpusIntentDocument {
  schemaVersion: 1;
  kind: "expert_ingest_corpus_intents";
  intents: CorpusIntent[];
}

export async function runExpertIngestCli(
  argv: string[],
  dependencies: ExpertIngestCliDependencies = {},
): Promise<ExpertIngestCliResult> {
  const args = parseExpertIngestArguments(argv);
  await assertNoEngagementHeldPath(args);
  const bytes = args.prepared
    ? await readPreparedBytes(args.source, dependencies.maxPreparedBytes ?? PREPARED_MAX_BYTES)
    : await extractSourceBytes(args.source, dependencies);
  const objectId = contentIdFromBytes(bytes);
  let mediaType = args.prepared && extname(args.source).toLowerCase() === ".txt" ? "text/plain" : EXTRACTED_MEDIA_TYPE;
  let relativePath = canonicalObjectRelativePath(objectId, mediaType);
  const root = resolve(args.libraryDirectory);
  const read = dependencies.readFileImpl ?? readFile;
  const timestamp = requireCanonicalTimestamp((dependencies.now ?? defaultNow)());

  const descriptor = await readCandidateDescriptor(root, read);
  const existing = descriptor.candidates.find((candidate) => candidate.path === relativePath
    || (args.prepared && candidate.path === canonicalObjectRelativePath(objectId, candidate.metadata.mediaType)));
  if (args.prepared && existing) {
    mediaType = existing.metadata.mediaType;
    relativePath = existing.path;
  }
  const governance = resolveGovernance(args, existing?.metadata);
  const metadata = buildCandidateMetadata({
    source: args.source,
    prepared: args.prepared ?? false,
    mediaType,
    timestamp,
    governance,
    existing: existing?.metadata,
    ...(args.title === undefined ? {} : { title: args.title }),
    ...(args.creator === undefined ? {} : { creator: args.creator }),
  });
  // Validating the full object keeps staged metadata inside the library
  // contract instead of deferring every rule to materialization.
  validateLibraryObject({
    id: objectId,
    ...metadata,
    byteSize: bytes.byteLength,
    relativePath,
  } satisfies LibraryObject);

  const nextDescriptor: CandidateDescriptor = {
    schemaVersion: 1,
    candidates: [
      ...descriptor.candidates.filter((candidate) => candidate.path !== relativePath),
      { path: relativePath, metadata },
    ].sort((left, right) => compareStrings(left.path, right.path)),
  };

  const objectPath = resolve(root, relativePath);
  const descriptorPath = resolve(root, CANDIDATE_DESCRIPTOR);
  await writeOutput(objectPath, bytes, dependencies);
  await writeOutput(descriptorPath, encode(canonicalJson(nextDescriptor)), dependencies);
  if (args.corpusId !== undefined) {
    const intents = await readCorpusIntents(root, read);
    await writeOutput(
      resolve(root, CORPUS_INTENT_DOCUMENT),
      encode(canonicalJson(withCorpusIntent(intents, objectId, args.corpusId))),
      dependencies,
    );
  }

  return {
    objectId,
    relativePath,
    byteSize: bytes.byteLength,
    objectPath,
    descriptorPath,
    trustTier: governance.trustTier,
    copyrightPosture: governance.copyrightPosture,
    ...(args.corpusId === undefined ? {} : { corpusId: args.corpusId }),
    ...(metadata.title === undefined ? {} : { title: metadata.title }),
    ...(metadata.creator === undefined ? {} : { creator: metadata.creator }),
    alreadyStaged: existing !== undefined,
  };
}

async function extractSourceBytes(source: string, dependencies: ExpertIngestCliDependencies): Promise<Uint8Array> {
  const binaryPath = dependencies.summarizePath === undefined
    ? Bun.which(SUMMARIZE_BINARY)
    : dependencies.summarizePath;
  if (binaryPath === null || binaryPath === undefined || binaryPath.length === 0) {
    throw new ExpertIngestError(
      "summarize_not_installed",
      `${SUMMARIZE_BINARY} is not installed; install it with \`${SUMMARIZE_INSTALL_COMMAND}\`.`,
    );
  }

  const extract = dependencies.extract ?? spawnExtraction;
  const extractionRoot = await mkdtemp(join(resolve(tmpdir()), "expert-agents-ingest-extraction-"));
  const directories = {
    home: join(extractionRoot, "home"),
    cache: join(extractionRoot, "cache"),
    config: join(extractionRoot, "config"),
    data: join(extractionRoot, "data"),
    temp: join(extractionRoot, "tmp"),
  };
  await Promise.all(Object.values(directories).map((path) => mkdir(path, { mode: 0o700 })));
  let extraction: ExtractionResult;
  try {
    extraction = await extract({
      binaryPath: extractionBinaryForPrivateCwd(binaryPath),
      source: isRemoteLocator(source) || isAbsolute(source) ? source : resolve(source),
      args: EXTRACTION_ARGUMENTS,
      env: ingestExtractionEnv(dependencies.env ?? process.env, directories),
      workingDirectory: extractionRoot,
      timeoutMs: dependencies.timeoutMs ?? EXTRACTION_TIMEOUT_MS,
      maxOutputBytes: dependencies.maxOutputBytes ?? EXTRACTION_MAX_OUTPUT_BYTES,
    });
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
  if (extraction.exitCode !== 0) {
    throw new ExpertIngestError(
      "extraction_failed",
      `${SUMMARIZE_BINARY} --extract exited with code ${extraction.exitCode}: ${firstDiagnosticLine(extraction.stderr)}`,
    );
  }
  const content = normalizeExtractedText(extraction.stdout);
  if (content.length === 0) {
    throw new ExpertIngestError(
      "extraction_empty",
      `${SUMMARIZE_BINARY} --extract produced no text for the requested source.`,
    );
  }

  return new TextEncoder().encode(content);
}

function extractionBinaryForPrivateCwd(binaryPath: string): string {
  return isAbsolute(binaryPath) || (!binaryPath.includes("/") && !binaryPath.includes("\\"))
    ? binaryPath
    : resolve(binaryPath);
}

async function readPreparedBytes(source: string, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > PREPARED_MAX_BYTES) {
    throw new ExpertIngestError("invalid_arguments", "prepared byte bound must be a positive integer within PREPARED_MAX_BYTES.");
  }
  // Open nonblocking so special files cannot stall before the regular-file check.
  const { constants } = await import("node:fs");
  const handle = await open(source, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => {
    throw new ExpertIngestError("prepared_source_invalid", "prepared source must be a readable regular local text file.");
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new ExpertIngestError("prepared_source_invalid", "prepared source must be a regular file.");
    if (stat.size > maxBytes) throw new ExpertIngestError("prepared_source_too_large", "prepared source exceeds the byte bound.");
    const buffer = new Uint8Array(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, null);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    if (size > maxBytes) throw new ExpertIngestError("prepared_source_too_large", "prepared source exceeds the byte bound.");
    const bytes = buffer.slice(0, size);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new ExpertIngestError("prepared_source_invalid", "prepared source must contain valid UTF-8 text."); }
    if (text.trim().length === 0 || /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u.test(text)) {
      throw new ExpertIngestError("prepared_source_invalid", "prepared source must contain nonempty text without binary control bytes.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

/**
 * The library-side half of the engagement rule: raw client content never enters
 * the shared library. Per-engagement storage identifies itself with an
 * engagement record, so a local source held inside it — or a library rooted
 * inside it — is refused before the extractor is even spawned.
 */
async function assertNoEngagementHeldPath(args: ExpertIngestCliArguments): Promise<void> {
  const candidates = [args.libraryDirectory, ...(isRemoteLocator(args.source) ? [] : [args.source])];
  for (const candidate of candidates) {
    if (await isEngagementHeldPath(resolve(candidate))) {
      throw new ExpertIngestError(
        "engagement_held_path",
        "the requested path is held in per-engagement storage; client content never enters the shared library.",
      );
    }
  }
}

function isRemoteLocator(source: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(source);
}

/**
 * The source is handed to the extractor as child argv and then recorded in the
 * candidate descriptor as a source locator, so a secret embedded in it would be
 * readable from the process table and persisted into the library. Refused here,
 * before either happens, and the refusal quotes nothing back.
 */
function requireCredentialFreeSource(source: string): string {
  const credential = sourceLocatorCredential(source);
  if (credential !== undefined) {
    throw new ExpertIngestError(
      "credential_bearing_source",
      `--source carries an embedded ${credential}; supply a source locator without credentials in it.`,
    );
  }
  return source;
}

export function parseExpertIngestArguments(argv: string[]): ExpertIngestCliArguments {
  const named = ["--source", "--library", "--trust-tier", "--copyright-posture", "--corpus", "--title", "--creator"];
  let prepared = false;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--prepared") {
      if (prepared) throw new ExpertIngestError("invalid_arguments", "Duplicate argument: --prepared");
      prepared = true;
      continue;
    }
    if (!named.includes(argument)) {
      throw new ExpertIngestError("invalid_arguments", `${USAGE}\n\nUnknown argument: ${argument}`);
    }
    if (values.has(argument)) {
      throw new ExpertIngestError("invalid_arguments", `${USAGE}\n\nDuplicate argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ExpertIngestError("invalid_arguments", `${USAGE}\n\nMissing value for ${argument}.`);
    }
    values.set(argument, value);
    index += 1;
  }
  const source = requireCredentialFreeSource(requiredArgument(values, "--source"));
  const libraryDirectory = requiredArgument(values, "--library");
  if (prepared && (/^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith("//") || source.includes("\\")
    || ![".txt", ".md", ".markdown"].includes(extname(source).toLowerCase()))) {
    throw new ExpertIngestError("prepared_source_invalid", "--prepared requires a local .txt, .md, or .markdown path, not a URL.");
  }
  return {
    source,
    libraryDirectory,
    ...(prepared ? { prepared: true } : {}),
    ...optionalArgument(values, "--trust-tier", "trustTier"),
    ...optionalArgument(values, "--copyright-posture", "copyrightPosture"),
    ...optionalArgument(values, "--corpus", "corpusId"),
    ...optionalArgument(values, "--title", "title"),
    ...optionalArgument(values, "--creator", "creator"),
  };
}

// A supplied flag always wins. An omitted flag inherits a posture already
// declared for these exact bytes, so a later undeclared run cannot silently
// relax a restriction; only a genuinely new object takes the permissive
// defaults.
export function resolveGovernance(
  supplied: { trustTier?: string; copyrightPosture?: string },
  existing?: { trustTier: string; copyrightPosture: string },
): { trustTier: string; copyrightPosture: string } {
  return {
    trustTier: supplied.trustTier ?? existing?.trustTier ?? PERMISSIVE_DEFAULT_TRUST_TIER,
    copyrightPosture: supplied.copyrightPosture
      ?? existing?.copyrightPosture
      ?? PERMISSIVE_DEFAULT_COPYRIGHT_POSTURE,
  };
}

/**
 * The subprocess is bounded in two directions because summarize reaches the
 * network for most sources: a stalled fetch would otherwise hold this CLI — and
 * anything that spawns it, including the test suite — open indefinitely, and an
 * extractor that streams without end would exhaust the memory this CLI buffers
 * the extraction into. The timeout does not cover the second case, because
 * output can arrive quickly and forever.
 *
 * Both kills are conditions this lane imposed, not the extractor's own answer
 * about the source, so each is raised as its own code instead of being folded
 * into the non-zero exit path. That distinction has to be made from flags we
 * set: a terminated child still resolves `exited` to a number (128 + signal),
 * so the exit code alone cannot tell either kill from a refusal the binary
 * chose, or one kill from the other.
 */
async function spawnExtraction(request: ExtractionRequest): Promise<ExtractionResult> {
  const child = Bun.spawn([request.binaryPath, request.source, ...request.args], {
    cwd: request.workingDirectory,
    env: request.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  let overflowed = false;
  const bound = request.timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    child.kill();
  }, request.timeoutMs);
  // The child is terminated the moment a stream crosses the bound, so the bytes
  // past it are never buffered. Reading an oversized extraction to completion
  // and complaining afterwards would have already paid the cost the bound
  // exists to refuse.
  const overflow = (): void => {
    overflowed = true;
    child.kill();
  };
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readBoundedStream(child.stdout, request.maxOutputBytes, overflow),
      readBoundedStream(child.stderr, request.maxOutputBytes, overflow),
    ]);
    // Checked before the timeout: a flood trips the bound the instant it
    // crosses, so when both flags are set the overflow is what happened first.
    if (overflowed) {
      throw new ExpertIngestError(
        "extraction_output_too_large",
        `${SUMMARIZE_BINARY} --extract produced more than ${request.maxOutputBytes} bytes on a single stream and was terminated.`,
      );
    }
    if (timedOut) {
      throw new ExpertIngestError(
        "extraction_timed_out",
        `${SUMMARIZE_BINARY} --extract did not finish within ${request.timeoutMs}ms and was terminated.`,
      );
    }
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(bound);
  }
}

/**
 * Reads a child stream chunk by chunk and stops at the bound rather than
 * buffering whatever the child chooses to send. The bound is applied per stream
 * the same way the worker's execFile maxBuffer applies it, so a diagnostic on
 * stderr cannot be used to get around the bound on stdout.
 */
async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  limit: number | undefined,
  onOverflow: () => void,
): Promise<string> {
  if (limit === undefined) return await new Response(stream).text();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || value === undefined) break;
      chunks.push(value);
      total += value.byteLength;
      if (total > limit) {
        onOverflow();
        break;
      }
    }
  } finally {
    // Closes the read end, so a child that outlived its kill signal cannot sit
    // blocked on a full pipe and hold this await open.
    await reader.cancel().catch(() => {});
  }
  // Decoded from the joined bytes rather than per chunk, so a multi-byte
  // character split across a chunk boundary survives.
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function buildCandidateMetadata(options: {
  source: string;
  prepared: boolean;
  mediaType: string;
  timestamp: string;
  governance: { trustTier: string; copyrightPosture: string };
  existing?: CandidateObjectMetadata;
  title?: string;
  creator?: string;
}): CandidateObjectMetadata {
  const sourceLocators = sortedUnique([...(options.existing?.sourceLocators ?? []), options.source]);
  const acquiredAt = options.existing?.provenance.acquiredAt ?? options.timestamp;
  // A supplied title or creator always wins; an omitted one keeps whatever the
  // staged candidate already carries, so re-staging never strips a name.
  const title = options.title ?? options.existing?.title;
  const creator = options.creator ?? options.existing?.creator;
  return {
    ...(options.prepared ? options.existing : {}),
    ...(title === undefined ? {} : { title }),
    ...(creator === undefined ? {} : { creator }),
    sourceLocators,
    mediaType: options.mediaType,
    derivativeKind: options.prepared ? (options.existing ? options.existing.derivativeKind : PREPARED_DERIVATIVE_KIND) : EXTRACTED_DERIVATIVE_KIND,
    provenance: options.prepared && options.existing ? options.existing.provenance : {
      acquiredBy: INGEST_ACQUIRED_BY,
      acquiredAt,
      acquisitionMethod: options.prepared ? PREPARED_ACQUISITION_METHOD : INGEST_ACQUISITION_METHOD,
    },
    trustTier: options.governance.trustTier,
    copyrightPosture: options.governance.copyrightPosture,
    lineage: options.prepared && options.existing ? options.existing.lineage : { supersedes: [], supersededBy: [] },
    createdAt: options.existing?.createdAt ?? options.timestamp,
    updatedAt: options.timestamp,
  };
}

async function readCandidateDescriptor(root: string, read: typeof readFile): Promise<CandidateDescriptor> {
  const text = await readOptional(resolve(root, CANDIDATE_DESCRIPTOR), read);
  if (text === undefined) return { schemaVersion: 1, candidates: [] };
  const record = parseJsonRecord(text, CANDIDATE_DESCRIPTOR);
  if (record.schemaVersion !== 1 || !Array.isArray(record.candidates)) {
    throw new ExpertIngestError("library_state_invalid", `${CANDIDATE_DESCRIPTOR} schema is invalid`);
  }
  const candidates = record.candidates.map((value) => {
    const entry = requireRecord(value, `${CANDIDATE_DESCRIPTOR} entry`);
    const path = entry.path;
    if (typeof path !== "string" || path.length === 0 || path.startsWith("/") || path.includes("\\")
      || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new ExpertIngestError("library_state_invalid", `${CANDIDATE_DESCRIPTOR} path is not a portable relative path`);
    }
    return {
      path,
      metadata: requireRecord(entry.metadata, `${CANDIDATE_DESCRIPTOR} metadata`) as unknown as CandidateObjectMetadata,
    };
  });
  return { schemaVersion: 1, candidates };
}

async function readCorpusIntents(root: string, read: typeof readFile): Promise<CorpusIntentDocument> {
  const empty: CorpusIntentDocument = {
    schemaVersion: 1,
    kind: "expert_ingest_corpus_intents",
    intents: [],
  };
  const text = await readOptional(resolve(root, CORPUS_INTENT_DOCUMENT), read);
  if (text === undefined) return empty;
  const record = parseJsonRecord(text, CORPUS_INTENT_DOCUMENT);
  if (record.schemaVersion !== 1 || record.kind !== empty.kind || !Array.isArray(record.intents)) {
    throw new ExpertIngestError("library_state_invalid", `${CORPUS_INTENT_DOCUMENT} schema is invalid`);
  }
  const intents = record.intents.map((value) => {
    const entry = requireRecord(value, `${CORPUS_INTENT_DOCUMENT} entry`);
    if (typeof entry.objectId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(entry.objectId)
      || !Array.isArray(entry.corpusIds)) {
      throw new ExpertIngestError("library_state_invalid", `${CORPUS_INTENT_DOCUMENT} entry is invalid`);
    }
    return {
      objectId: entry.objectId as Sha256Id,
      corpusIds: entry.corpusIds.map((corpusId) => requireCorpusId(corpusId)),
    };
  });
  return { ...empty, intents };
}

function withCorpusIntent(
  document: CorpusIntentDocument,
  objectId: Sha256Id,
  corpusId: string,
): CorpusIntentDocument {
  const existing = document.intents.find((intent) => intent.objectId === objectId);
  const intents = [
    ...document.intents.filter((intent) => intent.objectId !== objectId),
    { objectId, corpusIds: sortedUnique([...(existing?.corpusIds ?? []), corpusId]) },
  ].sort((left, right) => compareStrings(left.objectId, right.objectId));
  return { ...document, intents };
}

async function readOptional(path: string, read: typeof readFile): Promise<string | undefined> {
  try {
    return await read(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeOutput(
  path: string,
  bytes: Uint8Array,
  dependencies: ExpertIngestCliDependencies,
): Promise<void> {
  await (dependencies.mkdirImpl ?? mkdir)(dirname(path), { recursive: true });
  await (dependencies.writeFileImpl ?? writeFile)(path, bytes);
}

function parseJsonRecord(text: string, name: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ExpertIngestError("library_state_invalid", `${name} is not valid JSON`);
  }
  return requireRecord(value, name);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ExpertIngestError("library_state_invalid", `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredArgument(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined || value.trim() !== value || value.length === 0) {
    throw new ExpertIngestError("invalid_arguments", `${USAGE}\n\nMissing required argument: ${name}`);
  }
  return value;
}

function optionalArgument<K extends string>(
  values: Map<string, string>,
  name: string,
  key: K,
): Partial<Record<K, string>> {
  const value = values.get(name);
  if (value === undefined) return {};
  if (value.trim() !== value || value.length === 0 || /[\r\n]/.test(value)) {
    throw new ExpertIngestError("invalid_arguments", `${USAGE}\n\n${name} must be a single-line trimmed value.`);
  }
  return { [key]: value } as Record<K, string>;
}

function requireCorpusId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /[\r\n]/.test(value)) {
    throw new ExpertIngestError("library_state_invalid", "corpus id must be a single-line trimmed value");
  }
  return value;
}

function requireCanonicalTimestamp(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ExpertIngestError("invalid_arguments", "ingestion timestamp must be a canonical UTC instant");
  }
  return value;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => compareStrings(left, right));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

// The clock is read only here, at the process boundary, and the resulting
// instant is passed into the object as an input.
function defaultNow(): string {
  return new Date().toISOString();
}

if (import.meta.main) {
  try {
    const result = await runExpertIngestCli(process.argv.slice(2));
    console.log(
      `staged ${result.objectId} (${result.byteSize} bytes) at ${result.relativePath}`
      + ` with trust tier ${result.trustTier} and copyright posture ${result.copyrightPosture}`
      + `${result.corpusId === undefined ? "" : ` for corpus ${result.corpusId}`}`
      + `${result.title === undefined ? "" : ` titled ${JSON.stringify(result.title)}`}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "reference ingestion failed");
    process.exitCode = 1;
  }
}
