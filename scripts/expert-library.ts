import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import {
  canonicalJson,
  parseScopeManifest,
  serializeScopeManifest,
  type Sha256Id,
} from "../packages/library/src/index.ts";
import { runAnnotateLibraryCli } from "./annotate-library.ts";
import { runExpertIngestCli, type ExpertIngestCliResult } from "./expert-ingest.ts";
import { runMaterializeScopeCli } from "./materialize-scope.ts";

/**
 * One operator surface for library work from any shell harness. Two lanes,
 * both already machinery elsewhere in this repository; this module only
 * orchestrates them and prints what happened.
 *
 * Worker lane: HTTP against a running domain-expert worker (`ask`, `search`,
 * `acquire`, `source register`, `status`, `health`). Owner lane: local Google
 * ADC (`ingest`: extract → stage → scope → materialize → annotate).
 *
 * Credential rule, same as retrieval-eval: the worker bearer token comes only
 * from EXPERT_AGENTS_WORKER_TOKEN or a --token-file path, never an argument
 * value; it is never printed and never written into a receipt. Every line this
 * CLI emits passes through a redaction step keyed on the secrets it holds.
 */

export const WORKER_URL_ENV = "EXPERT_AGENTS_WORKER_URL";
export const WORKER_TOKEN_ENV = "EXPERT_AGENTS_WORKER_TOKEN";
export const GOOGLE_ACCESS_TOKEN_ENV = "EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_ACCESS_TOKEN";
export const GCP_PROJECT_ENV = "EXPERT_AGENTS_GCP_PROJECT";
export const GCLOUD_ADC_ARGV = ["gcloud", "auth", "application-default", "print-access-token"] as const;

/** Busy-corpus and quota responses are waited out, never treated as failures. */
export const ACQUIRE_RETRY_INITIAL_DELAY_MS = 30_000;
export const ACQUIRE_RETRY_SECOND_DELAY_MS = 90_000;
export const ACQUIRE_RETRY_MAX_DELAY_MS = 5 * 60_000;
export const ACQUIRE_RETRY_BUDGET_MS = 15 * 60_000;

export const PREPARED_EXTENSIONS = [".txt", ".md", ".markdown"] as const;
export const EBOOK_EXTENSIONS = [".epub", ".mobi", ".azw3", ".djvu"] as const;
export const EBOOK_CONVERT_BINARY = "ebook-convert";
export const PANDOC_BINARY = "pandoc";

export const EXPERT_LIBRARY_USAGE = `Usage: bun run expert:library -- <command> [options]

Worker lane (POST <worker>/v1/domain; --worker <url> or ${WORKER_URL_ENV};
bearer token from ${WORKER_TOKEN_ENV} or --token-file <path>, never an argument value):
  health
  ask      --domain <id> "<question>" [--passages] [--corpus <id>]
  read     --domain <id> --action <catalog|open|find|read> [--object <sha256:id> | --rag-file <resource>]
           [--revision <text-hash>] [--query <text>] [--offset <n>] [--end <n>] [--section <n>] [--limit <n>]
  search   --domain <id> --query "<q>" [--author <a>] [--title <t>] [--language <l>] [--top <n>] [--ingest-intent]
  acquire  --domain <id> --md5 <md5> --format <pdf|epub|mobi|azw3|djvu> --title <t> --author <a> [--year <y>]
           --corpus <id> --copyright-posture <p> --approval-id <id> [--no-ingest] [--dry-run] [--no-wait]
  source register --domain <id> --kind <book|pdf|epub|google_doc|blog_post|transcript|note|dataset|web_page>
           --title <t> --author <a> --locator <url> [--trust-tier <t>] [--copyright-posture <p>] [--corpus <id>]
  status   --domain <id> [--corpus <id>]

Owner lane (local Google ADC; ${GCP_PROJECT_ENV} required; token from
${GOOGLE_ACCESS_TOKEN_ENV} or \`gcloud auth application-default print-access-token\`):
  ingest   --scope <agent-repo>/library/scope-manifest.json --library <candidates-dir>
           --bucket <b> --prefix <p> --receipts <dir> [--title <t> --creator <c> | --meta <json-file>]
           [--trust-tier <t>] [--copyright-posture <p>] (<url>|<path>)...

Worker errors are printed verbatim (code + message) and exit 1. acquire retries a busy
corpus (FAILED_PRECONDITION) or HTTP 429 with backoff (30s, 90s, ... up to 15 minutes)
unless --no-wait is given.`;

export type ExpertLibraryErrorCode =
  | "invalid_arguments"
  | "worker_not_configured"
  | "worker_unreachable"
  | "worker_invalid_response"
  | "worker_error"
  | "worker_busy"
  | "google_project_not_configured"
  | "google_auth_unavailable"
  | "ebook_conversion_unavailable"
  | "ebook_conversion_failed"
  | "meta_invalid"
  | "receipt_contains_secret";

export class ExpertLibraryError extends Error {
  readonly code: ExpertLibraryErrorCode;

  constructor(code: ExpertLibraryErrorCode, message: string) {
    super(message);
    this.name = "ExpertLibraryError";
    this.code = code;
  }
}

export interface WorkerCommandOptions {
  worker?: string;
  tokenFile?: string;
}

export type ExpertLibraryCommand =
  | ({ command: "health" } & WorkerCommandOptions)
  | ({ command: "read"; domainId: string; params: Record<string, unknown> } & WorkerCommandOptions)
  | ({
    command: "ask";
    domainId: string;
    question: string;
    passages: boolean;
    corpusId?: string;
  } & WorkerCommandOptions)
  | ({
    command: "search";
    domainId: string;
    query: string;
    author?: string;
    title?: string;
    language?: string;
    top?: number;
    ingestIntent: boolean;
  } & WorkerCommandOptions)
  | ({
    command: "acquire";
    domainId: string;
    md5: string;
    format: string;
    title: string;
    author: string;
    year?: string;
    corpusId: string;
    copyrightPosture: string;
    approvalId: string;
    ingest: boolean;
    dryRun: boolean;
    wait: boolean;
  } & WorkerCommandOptions)
  | ({
    command: "source-register";
    domainId: string;
    kind: string;
    title: string;
    author: string;
    locator: string;
    trustTier?: string;
    copyrightPosture?: string;
    corpusId?: string;
  } & WorkerCommandOptions)
  | ({ command: "status"; domainId: string; corpusId?: string } & WorkerCommandOptions)
  | {
    command: "ingest";
    scopePath: string;
    libraryDirectory: string;
    bucket: string;
    prefix: string;
    receiptsDirectory: string;
    sources: string[];
    title?: string;
    creator?: string;
    metaPath?: string;
    trustTier?: string;
    copyrightPosture?: string;
  }
  | { command: "help" };

export type ExpertLibraryFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ExpertLibrarySpawn = (
  argv: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> },
) => Promise<SpawnResult>;

export interface ExpertLibraryCliDependencies {
  env?: Record<string, string | undefined>;
  fetchImpl?: ExpertLibraryFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  readFileImpl?: typeof readFile;
  writeFileImpl?: typeof writeFile;
  mkdirImpl?: typeof mkdir;
  which?: (binary: string) => string | null;
  spawn?: ExpertLibrarySpawn;
  ingest?: typeof runExpertIngestCli;
  materialize?: typeof runMaterializeScopeCli;
  annotate?: typeof runAnnotateLibraryCli;
}

interface WorkerTarget {
  baseUrl: string;
  token?: string;
}

interface WorkerOutcome {
  status: number;
  ok: boolean;
  body: unknown;
}

interface Emitter {
  out: (line: string) => void;
  err: (line: string) => void;
  addSecret: (value: string | undefined) => void;
}

export interface IngestSourceReceipt {
  source: string;
  objectId: Sha256Id;
  byteSize: number;
  relativePath: string;
  prepared: boolean;
  converted?: string;
  title?: string;
  creator?: string;
  alreadyStaged: boolean;
}

export interface ExpertLibraryIngestReceipt {
  schemaVersion: 1;
  kind: "expert_library_ingest_receipt";
  createdAt: string;
  sources: IngestSourceReceipt[];
  scope: { path: string; addedObjectIds: Sha256Id[]; totalObjectIds: number };
  materialize: {
    planReceiptPath: string;
    executeReceiptPath: string;
    masterRevision: { before: number; after: number };
    ledgerRevision: { before: number; after: number };
    summary: Record<string, unknown>;
    rejectedImports: Array<{ objectId: Sha256Id; reason: string }>;
    unresolvableSelections: number;
  };
  annotation?: { receiptPath: string; objectIds: Sha256Id[] } | { skipped: string };
}

export async function runExpertLibraryCli(
  argv: string[],
  dependencies: ExpertLibraryCliDependencies = {},
): Promise<number> {
  const emitter = createEmitter(dependencies);
  let parsed: ExpertLibraryCommand;
  try {
    parsed = parseExpertLibraryArguments(argv);
  } catch (error) {
    emitter.err(error instanceof Error ? error.message : EXPERT_LIBRARY_USAGE);
    return 2;
  }
  if (parsed.command === "help") {
    emitter.out(EXPERT_LIBRARY_USAGE);
    return 0;
  }
  try {
    if (parsed.command === "ingest") return await runIngest(parsed, dependencies, emitter);
    return await runWorkerCommand(parsed, dependencies, emitter);
  } catch (error) {
    if (error instanceof ExpertLibraryError) {
      emitter.err(`${error.code}: ${error.message}`);
      return 1;
    }
    emitter.err(error instanceof Error ? error.message : "expert library command failed");
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const WORKER_FLAGS = ["--worker", "--token-file"];

export function parseExpertLibraryArguments(argv: string[]): ExpertLibraryCommand {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    return { command: "help" };
  }
  switch (command) {
    case "health": {
      const flags = parseFlags(rest, { named: WORKER_FLAGS });
      return { command: "health", ...workerOptions(flags) };
    }
    case "ask": {
      const flags = parseFlags(rest, {
        named: [...WORKER_FLAGS, "--domain", "--corpus"],
        boolean: ["--passages"],
        positional: true,
      });
      if (flags.positional.length !== 1) throw usage("ask takes exactly one quoted question.");
      return {
        command: "ask",
        domainId: requireFlag(flags, "--domain"),
        question: requireNonEmpty(flags.positional[0]!, "question"),
        passages: flags.booleans.has("--passages"),
        ...optionalFlag(flags, "--corpus", "corpusId"),
        ...workerOptions(flags),
      };
    }
    case "read": {
      const flags = parseFlags(rest, { named: [...WORKER_FLAGS, "--domain", "--action", "--object", "--rag-file", "--revision", "--query", "--offset", "--end", "--section", "--limit"] });
      const action = requireFlag(flags, "--action");
      if (!["catalog", "open", "find", "read"].includes(action)) throw usage("Invalid read action.");
      const params: Record<string, unknown> = { action };
      for (const [flag, key] of [["--object", "object_id"], ["--rag-file", "rag_file_name"], ["--revision", "text_revision"], ["--query", "query"]]) {
        const value = flags.values.get(flag!);
        if (value !== undefined) params[key!] = value;
      }
      for (const key of ["offset", "end", "section", "limit"]) {
        const value = flags.values.get(`--${key}`);
        if (value === undefined) continue;
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw usage(`--${key} must be a non-negative integer.`);
        params[key] = Number(value);
      }
      if (action !== "catalog" && Boolean(params.object_id) === Boolean(params.rag_file_name)) throw usage("Exactly one of --object or --rag-file is required for this read action.");
      return { command: "read", domainId: requireFlag(flags, "--domain"), params, ...workerOptions(flags) };
    }
    case "search": {
      const flags = parseFlags(rest, {
        named: [...WORKER_FLAGS, "--domain", "--query", "--author", "--title", "--language", "--top"],
        boolean: ["--ingest-intent"],
      });
      const top = flags.values.get("--top");
      if (top !== undefined && !/^[1-9]\d*$/.test(top)) throw usage("--top must be a positive integer.");
      return {
        command: "search",
        domainId: requireFlag(flags, "--domain"),
        query: requireFlag(flags, "--query"),
        ...optionalFlag(flags, "--author", "author"),
        ...optionalFlag(flags, "--title", "title"),
        ...optionalFlag(flags, "--language", "language"),
        ...(top === undefined ? {} : { top: Number(top) }),
        ingestIntent: flags.booleans.has("--ingest-intent"),
        ...workerOptions(flags),
      };
    }
    case "acquire": {
      const flags = parseFlags(rest, {
        named: [
          ...WORKER_FLAGS, "--domain", "--md5", "--format", "--title", "--author", "--year",
          "--corpus", "--copyright-posture", "--approval-id",
        ],
        boolean: ["--no-ingest", "--dry-run", "--no-wait"],
      });
      const md5 = requireFlag(flags, "--md5");
      if (!/^[a-f0-9]{32}$/i.test(md5)) throw usage("--md5 must be a 32-hex-character digest.");
      return {
        command: "acquire",
        domainId: requireFlag(flags, "--domain"),
        md5: md5.toLowerCase(),
        format: requireFlag(flags, "--format"),
        title: requireFlag(flags, "--title"),
        author: requireFlag(flags, "--author"),
        ...optionalFlag(flags, "--year", "year"),
        corpusId: requireFlag(flags, "--corpus"),
        copyrightPosture: requireFlag(flags, "--copyright-posture"),
        approvalId: requireFlag(flags, "--approval-id"),
        ingest: !flags.booleans.has("--no-ingest"),
        dryRun: flags.booleans.has("--dry-run"),
        wait: !flags.booleans.has("--no-wait"),
        ...workerOptions(flags),
      };
    }
    case "source": {
      const [subcommand, ...sourceRest] = rest;
      if (subcommand !== "register") throw usage("source supports only: source register ...");
      const flags = parseFlags(sourceRest, {
        named: [
          ...WORKER_FLAGS, "--domain", "--kind", "--title", "--author", "--locator",
          "--trust-tier", "--copyright-posture", "--corpus",
        ],
      });
      return {
        command: "source-register",
        domainId: requireFlag(flags, "--domain"),
        kind: requireFlag(flags, "--kind"),
        title: requireFlag(flags, "--title"),
        author: requireFlag(flags, "--author"),
        locator: requireFlag(flags, "--locator"),
        ...optionalFlag(flags, "--trust-tier", "trustTier"),
        ...optionalFlag(flags, "--copyright-posture", "copyrightPosture"),
        ...optionalFlag(flags, "--corpus", "corpusId"),
        ...workerOptions(flags),
      };
    }
    case "status": {
      const flags = parseFlags(rest, { named: [...WORKER_FLAGS, "--domain", "--corpus"] });
      return {
        command: "status",
        domainId: requireFlag(flags, "--domain"),
        ...optionalFlag(flags, "--corpus", "corpusId"),
        ...workerOptions(flags),
      };
    }
    case "ingest": {
      const flags = parseFlags(rest, {
        named: [
          "--scope", "--library", "--bucket", "--prefix", "--receipts", "--title", "--creator", "--meta",
          "--trust-tier", "--copyright-posture",
        ],
        positional: true,
      });
      if (flags.positional.length === 0) throw usage("ingest requires at least one source URL or path.");
      const title = flags.values.get("--title");
      const creator = flags.values.get("--creator");
      const metaPath = flags.values.get("--meta");
      if ((title !== undefined || creator !== undefined) && metaPath !== undefined) {
        throw usage("use either --title/--creator or --meta, not both.");
      }
      if ((title !== undefined || creator !== undefined) && flags.positional.length > 1) {
        throw usage("--title/--creator apply to a single source; use --meta <json-file> for several.");
      }
      const prefix = requireFlag(flags, "--prefix");
      if (prefix === "/") throw usage("--prefix must not be /");
      return {
        command: "ingest",
        scopePath: requireFlag(flags, "--scope"),
        libraryDirectory: requireFlag(flags, "--library"),
        bucket: requireFlag(flags, "--bucket"),
        prefix,
        receiptsDirectory: requireFlag(flags, "--receipts"),
        sources: flags.positional.map((source) => requireNonEmpty(source, "source")),
        ...(title === undefined ? {} : { title: requireNonEmpty(title, "--title") }),
        ...(creator === undefined ? {} : { creator: requireNonEmpty(creator, "--creator") }),
        ...(metaPath === undefined ? {} : { metaPath }),
        ...optionalFlag(flags, "--trust-tier", "trustTier"),
        ...optionalFlag(flags, "--copyright-posture", "copyrightPosture"),
      };
    }
    default:
      throw usage(`Unknown command: ${command}`);
  }
}

interface ParsedFlags {
  values: Map<string, string>;
  booleans: Set<string>;
  positional: string[];
}

function parseFlags(
  argv: string[],
  spec: { named: string[]; boolean?: string[]; positional?: boolean },
): ParsedFlags {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (spec.boolean?.includes(argument)) {
      if (booleans.has(argument)) throw usage(`Duplicate argument: ${argument}`);
      booleans.add(argument);
      continue;
    }
    if (spec.named.includes(argument)) {
      if (values.has(argument)) throw usage(`Duplicate argument: ${argument}`);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw usage(`Missing value for ${argument}.`);
      values.set(argument, value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) throw usage(`Unknown argument: ${argument}`);
    if (!spec.positional) throw usage(`Unexpected argument: ${argument}`);
    positional.push(argument);
  }
  return { values, booleans, positional };
}

function workerOptions(flags: ParsedFlags): WorkerCommandOptions {
  return {
    ...optionalFlag(flags, "--worker", "worker"),
    ...optionalFlag(flags, "--token-file", "tokenFile"),
  };
}

function requireFlag(flags: ParsedFlags, name: string): string {
  const value = flags.values.get(name);
  if (value === undefined) throw usage(`Missing required argument: ${name}`);
  return requireNonEmpty(value, name);
}

function optionalFlag<K extends string>(flags: ParsedFlags, name: string, key: K): Partial<Record<K, string>> {
  const value = flags.values.get(name);
  if (value === undefined) return {};
  return { [key]: requireNonEmpty(value, name) } as Record<K, string>;
}

function requireNonEmpty(value: string, name: string): string {
  if (value.trim().length === 0 || value.trim() !== value || /[\r\n]/.test(value)) {
    throw usage(`${name} must be a single-line trimmed non-empty value.`);
  }
  return value;
}

function usage(detail: string): ExpertLibraryError {
  return new ExpertLibraryError("invalid_arguments", `${EXPERT_LIBRARY_USAGE}\n\n${detail}`);
}

// ---------------------------------------------------------------------------
// Worker lane
// ---------------------------------------------------------------------------

async function runWorkerCommand(
  parsed: Exclude<ExpertLibraryCommand, { command: "ingest" | "help" }>,
  dependencies: ExpertLibraryCliDependencies,
  emitter: Emitter,
): Promise<number> {
  const env = dependencies.env ?? process.env;
  const target = await resolveWorkerTarget(parsed, env, dependencies.readFileImpl ?? readFile);
  emitter.addSecret(target.token);
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  switch (parsed.command) {
    case "read": {
      const outcome = await workerPost(target, "domain_read", { domain_id: parsed.domainId, ...parsed.params }, fetchImpl);
      if (!outcome.ok) return failWorker(outcome, emitter);
      emitter.out(prettyJson(outcome.body));
      return 0;
    }
    case "health": {
      const outcome = await workerGet(target, "/v1/health", fetchImpl);
      emitter.out(prettyJson(outcome.body));
      if (!outcome.ok) return failWorker(outcome, emitter);
      return 0;
    }
    case "ask": {
      const outcome = await workerPost(target, "domain_ask", {
        domain_id: parsed.domainId,
        question: parsed.question,
        ...(parsed.passages ? { output: "passages" } : {}),
        ...(parsed.corpusId === undefined ? {} : { corpus_id: parsed.corpusId }),
      }, fetchImpl);
      if (!outcome.ok) return failWorker(outcome, emitter);
      printAsk(outcome.body, emitter);
      return 0;
    }
    case "search": {
      const outcome = await workerPost(target, "annas_archive_search", {
        domain_id: parsed.domainId,
        query: parsed.query,
        ...(parsed.author === undefined ? {} : { author: parsed.author }),
        ...(parsed.title === undefined ? {} : { title: parsed.title }),
        ...(parsed.language === undefined ? {} : { language: parsed.language }),
        ...(parsed.top === undefined ? {} : { top_n: parsed.top }),
        ...(parsed.ingestIntent ? { format_preference: "text_rag", ingest_intent: true } : {}),
      }, fetchImpl);
      if (!outcome.ok) return failWorker(outcome, emitter);
      printSearch(outcome.body, emitter);
      return 0;
    }
    case "acquire": {
      const params = {
        domain_id: parsed.domainId,
        md5: parsed.md5,
        annas_archive_id: parsed.md5,
        format: parsed.format,
        title: parsed.title,
        author: parsed.author,
        ...(parsed.year === undefined ? {} : { year: parsed.year }),
        corpus_id: parsed.corpusId,
        copyright_posture: parsed.copyrightPosture,
        approval_id: parsed.approvalId,
        ingest: parsed.ingest,
        dry_run: parsed.dryRun,
      };
      const outcome = await acquireWithRetry(target, params, parsed.wait, dependencies, emitter);
      if (!outcome.ok) return failWorker(outcome, emitter);
      return printAcquire(outcome.body, emitter);
    }
    case "source-register": {
      const outcome = await workerPost(target, "domain_source", {
        action: "add",
        domain_id: parsed.domainId,
        kind: parsed.kind,
        title: parsed.title,
        author: parsed.author,
        url: parsed.locator,
        ...(parsed.trustTier === undefined ? {} : { trust_posture: parsed.trustTier }),
        ...(parsed.copyrightPosture === undefined ? {} : { copyright_posture: parsed.copyrightPosture }),
        ...(parsed.corpusId === undefined ? {} : { corpus_id: parsed.corpusId }),
        dry_run: false,
      }, fetchImpl);
      if (!outcome.ok) return failWorker(outcome, emitter);
      const body = asRecord(outcome.body);
      const record = asRecord(body?.source_record);
      emitter.out(`status: ${String(body?.status ?? "unknown")}`);
      if (record) emitter.out(`source_id: ${String(record.source_id ?? "")}`);
      emitter.out(prettyJson(record ?? outcome.body));
      return 0;
    }
    case "status": {
      const outcome = await workerPost(target, "rag_corpus", {
        action: "status",
        domain_id: parsed.domainId,
        ...(parsed.corpusId === undefined ? {} : { corpus_id: parsed.corpusId }),
      }, fetchImpl);
      if (!outcome.ok) return failWorker(outcome, emitter);
      const body = asRecord(outcome.body);
      const resolved = asRecord(body?.resolved_corpus);
      if (resolved) {
        emitter.out(`corpus: ${String(resolved.corpus_id ?? "")} (${String(resolved.resource_name ?? "")})`);
      }
      emitter.out(prettyJson(body?.corpus ?? outcome.body));
      printWarnings(body?.warnings, emitter);
      return 0;
    }
  }
}

export async function resolveWorkerTarget(
  options: WorkerCommandOptions,
  env: Record<string, string | undefined>,
  read: typeof readFile,
): Promise<WorkerTarget> {
  const raw = options.worker ?? env[WORKER_URL_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    throw new ExpertLibraryError(
      "worker_not_configured",
      `worker URL is required: pass --worker <url> or set ${WORKER_URL_ENV}.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ExpertLibraryError("worker_not_configured", "worker URL must be an absolute HTTP(S) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ExpertLibraryError("worker_not_configured", "worker URL must use http or https.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ExpertLibraryError(
      "worker_not_configured",
      "worker URL must not carry credentials, a query string, or a fragment.",
    );
  }
  let token: string | undefined = env[WORKER_TOKEN_ENV];
  if (options.tokenFile !== undefined) {
    let text: string;
    try {
      text = await read(options.tokenFile, "utf8");
    } catch {
      throw new ExpertLibraryError("worker_not_configured", "--token-file could not be read.");
    }
    token = text.trim();
    if (token.length === 0) throw new ExpertLibraryError("worker_not_configured", "--token-file is empty.");
  }
  return {
    baseUrl: raw.replace(/\/+$/, ""),
    ...(token ? { token } : {}),
  };
}

async function workerGet(target: WorkerTarget, path: string, fetchImpl: ExpertLibraryFetch): Promise<WorkerOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(`${target.baseUrl}${path}`, { method: "GET", headers: requestHeaders(target.token) });
  } catch {
    throw new ExpertLibraryError("worker_unreachable", `worker is unreachable at ${new URL(target.baseUrl).origin}.`);
  }
  return readOutcome(response);
}

async function workerPost(
  target: WorkerTarget,
  tool: string,
  params: Record<string, unknown>,
  fetchImpl: ExpertLibraryFetch,
): Promise<WorkerOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(`${target.baseUrl}/v1/domain`, {
      method: "POST",
      headers: requestHeaders(target.token, true),
      body: JSON.stringify({ tool, params }),
    });
  } catch {
    throw new ExpertLibraryError("worker_unreachable", `worker is unreachable at ${new URL(target.baseUrl).origin}.`);
  }
  return readOutcome(response);
}

async function readOutcome(response: Response): Promise<WorkerOutcome> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ExpertLibraryError(
      "worker_invalid_response",
      `worker returned HTTP ${response.status} without a JSON body.`,
    );
  }
  return { status: response.status, ok: response.ok, body };
}

function requestHeaders(token: string | undefined, json = false): HeadersInit {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function failWorker(outcome: WorkerOutcome, emitter: Emitter): number {
  const error = asRecord(asRecord(outcome.body)?.error);
  const code = typeof error?.code === "string" ? error.code : "unknown_error";
  const message = typeof error?.message === "string" ? error.message : "";
  emitter.err(`worker error (HTTP ${outcome.status}) ${code}: ${message}`);
  emitter.err(prettyJson(error ?? outcome.body));
  return 1;
}

/**
 * The worker serializes Vertex imports per corpus and Anna Archive meters per
 * minute. Both surface as "wait, then try again": HTTP 429, an HTTP error whose
 * text carries FAILED_PRECONDITION / "other operations running", or a 200 whose
 * rag_ingest was blocked by that same condition (the download already landed;
 * the worker re-ingests the existing file on the retry).
 */
export function isBusyWorkerOutcome(outcome: WorkerOutcome): boolean {
  if (outcome.status === 429) return true;
  const body = asRecord(outcome.body);
  const texts: string[] = [];
  const collect = (error: unknown): void => {
    const record = asRecord(error);
    if (!record) return;
    for (const key of ["code", "message", "suggestion"]) {
      if (typeof record[key] === "string") texts.push(record[key] as string);
    }
  };
  collect(body?.error);
  const ragIngest = asRecord(body?.rag_ingest);
  if (ragIngest?.status === "blocked") collect(ragIngest.error);
  return texts.some((text) => /FAILED_PRECONDITION|other operations? (?:are )?running|RESOURCE_EXHAUSTED/i.test(text));
}

async function acquireWithRetry(
  target: WorkerTarget,
  params: Record<string, unknown>,
  wait: boolean,
  dependencies: ExpertLibraryCliDependencies,
  emitter: Emitter,
): Promise<WorkerOutcome> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let waited = 0;
  let delay = ACQUIRE_RETRY_INITIAL_DELAY_MS;
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await workerPost(target, "annas_archive_import", params, fetchImpl);
    if (!isBusyWorkerOutcome(outcome)) return outcome;
    if (!wait) {
      throw new ExpertLibraryError("worker_busy", `corpus or quota busy (HTTP ${outcome.status}); --no-wait given, not retrying.`);
    }
    if (waited + delay > ACQUIRE_RETRY_BUDGET_MS) {
      throw new ExpertLibraryError(
        "worker_busy",
        `corpus or quota still busy after ${Math.round(waited / 1000)}s across ${attempt} attempts; giving up.`,
      );
    }
    emitter.err(`corpus or quota busy (HTTP ${outcome.status}); attempt ${attempt}, retrying in ${Math.round(delay / 1000)}s`);
    await sleep(delay);
    waited += delay;
    delay = attempt === 1 ? ACQUIRE_RETRY_SECOND_DELAY_MS : Math.min(delay * 3, ACQUIRE_RETRY_MAX_DELAY_MS);
  }
}

// Matches the worker's citation header: "<creator> — <title>" when the source
// is titled, else the stored display name.
function sourceLabel(source: Record<string, unknown>): string {
  const title = typeof source.title === "string" && source.title.trim() ? source.title.trim() : "";
  const creator = typeof source.creator === "string" && source.creator.trim() ? source.creator.trim() : "";
  if (!title) return String(source.source_display_name ?? "");
  return creator ? `${creator} — ${title}` : title;
}

function printAsk(body: unknown, emitter: Emitter): void {
  const record = asRecord(body);
  if (record?.kind === "domain_passages" && Array.isArray(record.passages)) {
    for (const value of record.passages) {
      const passage = asRecord(value);
      if (!passage) continue;
      emitter.out(`[${String(passage.citation_id ?? "")}] ${sourceLabel(passage)}`
        + ` (${String(passage.corpus_id ?? "")}${passage.score === undefined ? "" : `, score ${String(passage.score)}`})`);
      emitter.out(`  ${String(passage.source_uri ?? "")}`);
      emitter.out(indent(String(passage.text ?? "")));
      emitter.out("");
    }
    emitter.out(`${record.passages.length} passage(s)`);
  } else if (record?.kind === "domain_answer") {
    emitter.out(`status: ${String(record.status ?? "")}`);
    emitter.out(String(record.answer ?? ""));
    if (Array.isArray(record.citations) && record.citations.length > 0) {
      emitter.out("");
      emitter.out("citations:");
      for (const value of record.citations) {
        const citation = asRecord(value);
        if (!citation) continue;
        emitter.out(`  [${String(citation.citation_id ?? "")}] ${sourceLabel(citation)} ${String(citation.source_uri ?? "")}`);
      }
    }
  } else {
    emitter.out(prettyJson(body));
  }
  printWarnings(record?.warnings, emitter);
}

function printSearch(body: unknown, emitter: Emitter): void {
  const record = asRecord(body);
  const search = asRecord(record?.search);
  if (search) emitter.out(`backend: ${String(search.backend ?? "")}`);
  const candidates = Array.isArray(record?.candidates) ? record.candidates : [];
  const rows = candidates.map((value, index) => {
    const candidate = asRecord(value) ?? {};
    return [
      String(index + 1),
      String(candidate.format ?? ""),
      typeof candidate.file_size_bytes === "number" ? humanBytes(candidate.file_size_bytes) : "",
      String(candidate.title ?? ""),
      String(candidate.author ?? ""),
      String(candidate.year ?? ""),
      String(candidate.language ?? ""),
      String(candidate.md5 ?? ""),
    ];
  });
  emitter.out(table(["rank", "format", "size", "title", "author", "year", "language", "md5"], rows));
  candidates.forEach((value, index) => {
    const candidate = asRecord(value);
    const rationale = Array.isArray(candidate?.rationale) ? candidate.rationale : [];
    for (const note of rationale) emitter.out(`  #${index + 1}: ${String(note)}`);
  });
  if (rows.length === 0) emitter.out("no candidates");
  printWarnings(record?.warnings, emitter);
}

function printAcquire(body: unknown, emitter: Emitter): number {
  const record = asRecord(body);
  emitter.out(`status: ${String(record?.status ?? "unknown")}`);
  const download = asRecord(record?.download);
  if (download) {
    emitter.out(`download: ${String(download.status ?? "")}${download.path === undefined ? "" : ` ${String(download.path)}`}`
      + `${typeof download.bytes === "number" ? ` (${humanBytes(download.bytes)})` : ""}`);
  }
  const ragIngest = asRecord(record?.rag_ingest);
  emitter.out("rag_ingest:");
  emitter.out(indent(prettyJson(ragIngest ?? record?.rag_ingest ?? null)));
  const error = asRecord(ragIngest?.error);
  if (error) {
    emitter.err(`rag_ingest error ${String(error.code ?? "")}: ${String(error.message ?? "")}`);
    if (typeof error.suggestion === "string") emitter.err(`  ${error.suggestion}`);
  }
  printWarnings(record?.warnings, emitter);
  const status = String(ragIngest?.status ?? "");
  if (status === "blocked" || status === "needs_corpus_decision" || status === "import_failed" || status === "import_empty") {
    return 1;
  }
  if (record?.kind === "annas_archive_import_result" || record?.kind === "annas_archive_import_plan") return 0;
  return record === undefined ? 1 : 0;
}

function printWarnings(warnings: unknown, emitter: Emitter): void {
  if (!Array.isArray(warnings) || warnings.length === 0) return;
  for (const warning of warnings) {
    emitter.err(`warning: ${typeof warning === "string" ? warning : JSON.stringify(warning)}`);
  }
}

// ---------------------------------------------------------------------------
// Owner lane
// ---------------------------------------------------------------------------

async function runIngest(
  parsed: Extract<ExpertLibraryCommand, { command: "ingest" }>,
  dependencies: ExpertLibraryCliDependencies,
  emitter: Emitter,
): Promise<number> {
  const env = dependencies.env ?? process.env;
  const read = dependencies.readFileImpl ?? readFile;
  const write = dependencies.writeFileImpl ?? writeFile;
  const makeDirectory = dependencies.mkdirImpl ?? mkdir;
  const which = dependencies.which ?? ((binary: string) => Bun.which(binary));
  const spawn = dependencies.spawn ?? defaultSpawn;
  const ingest = dependencies.ingest ?? runExpertIngestCli;
  const materialize = dependencies.materialize ?? runMaterializeScopeCli;
  const annotate = dependencies.annotate ?? runAnnotateLibraryCli;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const stamp = startedAt.replace(/[:.]/g, "-");
  const receiptsDirectory = resolve(parsed.receiptsDirectory);

  // Auth is resolved before any extraction so a missing project or expired
  // ADC fails in seconds, not after a long download.
  const project = env[GCP_PROJECT_ENV]?.trim();
  if (!project) {
    throw new ExpertLibraryError("google_project_not_configured", `${GCP_PROJECT_ENV} is required for the owner lane.`);
  }
  const authEnv = await resolveGoogleEnv(env, spawn);
  emitter.addSecret(authEnv[GOOGLE_ACCESS_TOKEN_ENV]);

  const meta = await loadMeta(parsed, read);

  // 1. Extract and stage every source as a content-addressed candidate.
  const sources: IngestSourceReceipt[] = [];
  for (const source of parsed.sources) {
    const annotation = meta.get(source) ?? {};
    const staged = await stageSource(source, parsed, annotation, { ingest, which, spawn, env });
    sources.push(staged);
    emitter.out(`staged ${staged.objectId} ${staged.byteSize} bytes ${staged.title ?? "(untitled)"}`
      + `${staged.alreadyStaged ? " (already staged)" : ""} <- ${source}`);
  }

  // 2. Add the ids to the agent's scope manifest (sorted, unique, canonical).
  const scopePath = resolve(parsed.scopePath);
  const scope = parseScopeManifest(await read(scopePath, "utf8"));
  const before = new Set(scope.selection.objectIds);
  const addedObjectIds = sortedUnique(sources.map((entry) => entry.objectId).filter((id) => !before.has(id)));
  const objectIds = sortedUnique([...scope.selection.objectIds, ...addedObjectIds]);
  if (addedObjectIds.length > 0) {
    await write(scopePath, serializeScopeManifest({
      ...scope,
      selection: { ...scope.selection, objectIds },
    }));
  }
  emitter.out(`scope ${scopePath}: +${addedObjectIds.length} object id(s), ${objectIds.length} total`);

  // 3. Plan, then execute, the materialization. The plan receipt is kept so a
  //    refused execute still leaves the would-be receipt on disk.
  await makeDirectory(receiptsDirectory, { recursive: true });
  const planReceiptPath = join(receiptsDirectory, `materialize-plan-${stamp}.json`);
  const executeReceiptPath = join(receiptsDirectory, `materialize-execute-${stamp}.json`);
  const materializeArgv = [
    "--bucket", parsed.bucket,
    "--prefix", parsed.prefix,
    "--scope", scopePath,
    "--candidates", resolve(parsed.libraryDirectory),
  ];
  const plan = parseReceipt((await materialize([...materializeArgv, "--receipt", planReceiptPath], { env: authEnv })).receiptBytes);
  emitter.out(`plan: ${summaryLine(plan)}`);
  const executed = parseReceipt((await materialize([...materializeArgv, "--receipt", executeReceiptPath, "--execute"], { env: authEnv })).receiptBytes);
  emitter.out(`execute: ${summaryLine(executed)}`);
  emitter.out(`master revision ${executed.masterRevision.before} -> ${executed.masterRevision.after};`
    + ` ledger ${executed.ledgerRevision.before} -> ${executed.ledgerRevision.after}`);
  for (const rejected of executed.rejectedImports) {
    emitter.err(`rejected import ${rejected.objectId}: ${rejected.reason}`);
  }

  // 4. Objects that were already live carry whatever the manifest had; the new
  //    ones took title/creator from the candidate. Annotate the former.
  let annotation: ExpertLibraryIngestReceipt["annotation"];
  const deduped = new Set(executed.dedupedObjectIds);
  const toAnnotate = sources.filter((entry) => deduped.has(entry.objectId) && (entry.title !== undefined || entry.creator !== undefined));
  if (toAnnotate.length === 0) {
    annotation = { skipped: "every named object was added with its title and creator on the candidate" };
  } else {
    const annotationsPath = join(receiptsDirectory, `annotations-${stamp}.json`);
    const annotationReceiptPath = join(receiptsDirectory, `annotation-receipt-${stamp}.json`);
    const updatedAt = now();
    await write(annotationsPath, canonicalJson({
      schemaVersion: 1,
      expectedRevision: executed.masterRevision.after,
      annotations: dedupeByObjectId(toAnnotate).map((entry) => ({
        objectId: entry.objectId,
        ...(entry.title === undefined ? {} : { title: entry.title }),
        ...(entry.creator === undefined ? {} : { creator: entry.creator }),
        updatedAt,
      })),
    }));
    await annotate([
      "--bucket", parsed.bucket,
      "--prefix", parsed.prefix,
      "--execute",
      "--annotations", annotationsPath,
      "--receipt", annotationReceiptPath,
    ], { env: authEnv });
    annotation = { receiptPath: annotationReceiptPath, objectIds: sortedUnique(toAnnotate.map((entry) => entry.objectId)) };
    emitter.out(`annotated ${annotation.objectIds.length} already-live object(s)`);
  }

  // 5. One receipt for the whole run, checked for credential material.
  const receipt: ExpertLibraryIngestReceipt = {
    schemaVersion: 1,
    kind: "expert_library_ingest_receipt",
    createdAt: startedAt,
    sources,
    scope: { path: scopePath, addedObjectIds, totalObjectIds: objectIds.length },
    materialize: {
      planReceiptPath,
      executeReceiptPath,
      masterRevision: executed.masterRevision,
      ledgerRevision: executed.ledgerRevision,
      summary: executed.summary,
      rejectedImports: executed.rejectedImports,
      unresolvableSelections: executed.unresolvableSelections,
    },
    annotation,
  };
  const receiptBytes = new TextEncoder().encode(canonicalJson(receipt));
  const receiptText = new TextDecoder().decode(receiptBytes);
  for (const secret of [authEnv[GOOGLE_ACCESS_TOKEN_ENV], env[WORKER_TOKEN_ENV]]) {
    if (secret && receiptText.includes(secret)) {
      throw new ExpertLibraryError("receipt_contains_secret", "refusing to write an ingest receipt that contains credential material.");
    }
  }
  const receiptPath = join(receiptsDirectory, `expert-library-ingest-${stamp}.json`);
  await write(receiptPath, receiptBytes);
  emitter.out(`receipt: ${receiptPath}`);
  return executed.rejectedImports.length > 0 ? 1 : 0;
}

interface StageDependencies {
  ingest: typeof runExpertIngestCli;
  which: (binary: string) => string | null;
  spawn: ExpertLibrarySpawn;
  env: Record<string, string | undefined>;
}

async function stageSource(
  source: string,
  parsed: Extract<ExpertLibraryCommand, { command: "ingest" }>,
  annotation: { title?: string; creator?: string },
  dependencies: StageDependencies,
): Promise<IngestSourceReceipt> {
  const remote = isRemoteLocator(source);
  const extension = remote ? "" : extname(source).toLowerCase();
  let ingestSource = source;
  let prepared = false;
  let converted: string | undefined;
  let scratch: string | undefined;
  if (!remote && (PREPARED_EXTENSIONS as readonly string[]).includes(extension)) {
    prepared = true;
  } else if (!remote && (EBOOK_EXTENSIONS as readonly string[]).includes(extension)) {
    scratch = await mkdtemp(join(resolve(tmpdir()), "expert-library-convert-"));
    converted = await convertEbook(source, extension, scratch, dependencies);
    ingestSource = converted;
    prepared = true;
  }
  try {
    const result = await dependencies.ingest([
      "--source", ingestSource,
      "--library", parsed.libraryDirectory,
      ...(prepared ? ["--prepared"] : []),
      ...(parsed.trustTier === undefined ? [] : ["--trust-tier", parsed.trustTier]),
      ...(parsed.copyrightPosture === undefined ? [] : ["--copyright-posture", parsed.copyrightPosture]),
      ...(annotation.title === undefined ? [] : ["--title", annotation.title]),
      ...(annotation.creator === undefined ? [] : ["--creator", annotation.creator]),
    ], { env: dependencies.env });
    return sourceReceipt(source, result, prepared, converted);
  } finally {
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  }
}

function sourceReceipt(
  source: string,
  result: ExpertIngestCliResult,
  prepared: boolean,
  converted: string | undefined,
): IngestSourceReceipt {
  return {
    source,
    objectId: result.objectId,
    byteSize: result.byteSize,
    relativePath: result.relativePath,
    prepared,
    ...(converted === undefined ? {} : { converted: basename(converted) }),
    ...(result.title === undefined ? {} : { title: result.title }),
    ...(result.creator === undefined ? {} : { creator: result.creator }),
    alreadyStaged: result.alreadyStaged,
  };
}

/**
 * Vertex parses PDF, text, Markdown and HTML; ebooks have to become text
 * first. Calibre's ebook-convert handles every ebook format; pandoc reads only
 * epub. Neither present is a typed refusal naming what to install, never a
 * silent skip.
 */
async function convertEbook(
  source: string,
  extension: string,
  scratch: string,
  dependencies: StageDependencies,
): Promise<string> {
  const output = join(scratch, `${basename(source, extname(source))}.txt`);
  const calibre = dependencies.which(EBOOK_CONVERT_BINARY);
  const pandoc = extension === ".epub" ? dependencies.which(PANDOC_BINARY) : null;
  let argv: string[];
  if (calibre) argv = [calibre, resolve(source), output];
  else if (pandoc) argv = [pandoc, resolve(source), "-t", "plain", "--wrap=none", "-o", output];
  else {
    throw new ExpertLibraryError(
      "ebook_conversion_unavailable",
      `${extension} sources need ${EBOOK_CONVERT_BINARY} (calibre)${extension === ".epub" ? ` or ${PANDOC_BINARY}` : ""} on PATH; neither was found.`,
    );
  }
  const result = await dependencies.spawn(argv, { cwd: scratch, env: dependencies.env });
  if (result.exitCode !== 0) {
    throw new ExpertLibraryError(
      "ebook_conversion_failed",
      `${basename(argv[0]!)} exited with code ${result.exitCode}: ${firstLine(result.stderr)}`,
    );
  }
  return output;
}

async function loadMeta(
  parsed: Extract<ExpertLibraryCommand, { command: "ingest" }>,
  read: typeof readFile,
): Promise<Map<string, { title?: string; creator?: string }>> {
  const meta = new Map<string, { title?: string; creator?: string }>();
  if (parsed.metaPath === undefined) {
    if (parsed.title !== undefined || parsed.creator !== undefined) {
      meta.set(parsed.sources[0]!, {
        ...(parsed.title === undefined ? {} : { title: parsed.title }),
        ...(parsed.creator === undefined ? {} : { creator: parsed.creator }),
      });
    }
    return meta;
  }
  let value: unknown;
  try {
    value = JSON.parse(await read(parsed.metaPath, "utf8"));
  } catch {
    throw new ExpertLibraryError("meta_invalid", "--meta must be a readable JSON object mapping source -> {title, creator}.");
  }
  const record = asRecord(value);
  if (!record) throw new ExpertLibraryError("meta_invalid", "--meta must be a JSON object mapping source -> {title, creator}.");
  for (const [source, entryValue] of Object.entries(record)) {
    const entry = asRecord(entryValue);
    if (!entry) throw new ExpertLibraryError("meta_invalid", `--meta entry for ${source} must be an object.`);
    const title = entry.title;
    const creator = entry.creator;
    if ((title !== undefined && (typeof title !== "string" || title.trim() !== title || title.length === 0))
      || (creator !== undefined && (typeof creator !== "string" || creator.trim() !== creator || creator.length === 0))) {
      throw new ExpertLibraryError("meta_invalid", `--meta entry for ${source} must carry trimmed non-empty title/creator strings.`);
    }
    meta.set(source, {
      ...(title === undefined ? {} : { title: title as string }),
      ...(creator === undefined ? {} : { creator: creator as string }),
    });
  }
  for (const source of meta.keys()) {
    if (!parsed.sources.includes(source)) {
      throw new ExpertLibraryError("meta_invalid", `--meta names a source that is not being ingested: ${source}`);
    }
  }
  return meta;
}

/**
 * Google credentials are taken from the runtime's existing variables when
 * present; otherwise the local ADC token is minted with gcloud via a direct
 * spawn (no shell) and placed into a copied environment that only the
 * materializer and annotator see. It is never echoed.
 */
export async function resolveGoogleEnv(
  env: Record<string, string | undefined>,
  spawn: ExpertLibrarySpawn,
): Promise<Record<string, string | undefined>> {
  if (env[GOOGLE_ACCESS_TOKEN_ENV]
    || env.EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_JSON
    || env.EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_JSON_FILE) {
    return env;
  }
  let result: SpawnResult;
  try {
    result = await spawn([...GCLOUD_ADC_ARGV], { env });
  } catch {
    throw new ExpertLibraryError("google_auth_unavailable", "gcloud is not available; set "
      + `${GOOGLE_ACCESS_TOKEN_ENV} or install the Google Cloud SDK and run \`gcloud auth application-default login\`.`);
  }
  const token = result.stdout.trim();
  if (result.exitCode !== 0 || token.length === 0) {
    throw new ExpertLibraryError(
      "google_auth_unavailable",
      `gcloud auth application-default print-access-token failed (exit ${result.exitCode}); `
        + "run `gcloud auth application-default login` or set the access-token variable.",
    );
  }
  return { ...env, [GOOGLE_ACCESS_TOKEN_ENV]: token };
}

interface ParsedMaterializationReceipt {
  mode: string;
  masterRevision: { before: number; after: number };
  ledgerRevision: { before: number; after: number };
  summary: Record<string, unknown>;
  dedupedObjectIds: Sha256Id[];
  rejectedImports: Array<{ objectId: Sha256Id; reason: string }>;
  unresolvableSelections: number;
}

function parseReceipt(bytes: Uint8Array): ParsedMaterializationReceipt {
  const record = asRecord(JSON.parse(new TextDecoder().decode(bytes)));
  if (!record) throw new Error("materialization receipt is not an object");
  const candidates = asRecord(record.candidates) ?? {};
  const materialization = asRecord(record.materialization) ?? {};
  return {
    mode: String(record.mode ?? ""),
    masterRevision: asRevision(record.masterRevision),
    ledgerRevision: asRevision(record.ledgerRevision),
    summary: asRecord(record.summary) ?? {},
    dedupedObjectIds: (Array.isArray(candidates.dedupedObjectIds) ? candidates.dedupedObjectIds : []) as Sha256Id[],
    rejectedImports: (Array.isArray(materialization.rejectedImports) ? materialization.rejectedImports : [])
      .map((value) => {
        const entry = asRecord(value) ?? {};
        return { objectId: String(entry.objectId ?? "") as Sha256Id, reason: String(entry.reason ?? "") };
      }),
    unresolvableSelections: Array.isArray(materialization.unresolvableSelections) ? materialization.unresolvableSelections.length : 0,
  };
}

function asRevision(value: unknown): { before: number; after: number } {
  const record = asRecord(value) ?? {};
  return { before: Number(record.before ?? 0), after: Number(record.after ?? 0) };
}

function summaryLine(receipt: ParsedMaterializationReceipt): string {
  const summary = receipt.summary;
  return `${receipt.mode} candidates=${String(summary.candidates ?? 0)} added=${String(summary.addedObjects ?? 0)}`
    + ` deduped=${String(summary.dedupedObjects ?? 0)} uploads=${String(summary.uploadedObjects ?? summary.plannedUploads ?? 0)}`
    + ` imports=${String(summary.importedObjects ?? summary.plannedImports ?? 0)} rejected=${String(summary.rejectedImports ?? 0)}`
    + ` alreadyMaterialized=${String(summary.alreadyMaterialized ?? 0)} unresolvable=${String(summary.unresolvableSelections ?? 0)}`;
}

async function defaultSpawn(
  argv: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> },
): Promise<SpawnResult> {
  const child = Bun.spawn(argv, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env ?? process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function createEmitter(dependencies: ExpertLibraryCliDependencies): Emitter {
  const secrets: string[] = [];
  const redact = (line: string): string => secrets.reduce(
    (text, secret) => (secret.length > 0 ? text.split(secret).join("[redacted]") : text),
    line,
  );
  const out = dependencies.stdout ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const err = dependencies.stderr ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  return {
    out: (line) => out(redact(line)),
    err: (line) => err(redact(line)),
    addSecret: (value) => { if (value) secrets.push(value); },
  };
}

function dedupeByObjectId(entries: IngestSourceReceipt[]): IngestSourceReceipt[] {
  const seen = new Map<Sha256Id, IngestSourceReceipt>();
  for (const entry of entries) if (!seen.has(entry.objectId)) seen.set(entry.objectId, entry);
  return [...seen.values()].sort((left, right) => compareStrings(left.objectId, right.objectId));
}

function isRemoteLocator(source: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(source);
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)));
  const line = (cells: string[]): string => cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd();
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n");
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function indent(text: string): string {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => compareStrings(left, right));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await runExpertLibraryCli(process.argv.slice(2));
}
