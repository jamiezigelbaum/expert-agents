import { readFile, writeFile } from "node:fs/promises";

/**
 * One operator surface for library work from any shell harness: HTTP against
 * a running domain-expert worker (`library`, `library-ingest`, `search`,
 * `acquire`, `health`). This module only calls the worker and prints what
 * happened.
 *
 * Credential rule, same as retrieval-eval: the worker bearer token comes only
 * from EXPERT_AGENTS_WORKER_TOKEN or a --token-file path, never an argument
 * value; it is never printed and never written into a receipt. Every line this
 * CLI emits passes through a redaction step keyed on the secrets it holds.
 */

export const WORKER_URL_ENV = "EXPERT_AGENTS_WORKER_URL";
export const WORKER_TOKEN_ENV = "EXPERT_AGENTS_WORKER_TOKEN";

/** Quota responses are waited out, never treated as failures. */
export const ACQUIRE_RETRY_INITIAL_DELAY_MS = 30_000;
export const ACQUIRE_RETRY_SECOND_DELAY_MS = 90_000;
export const ACQUIRE_RETRY_MAX_DELAY_MS = 5 * 60_000;
export const ACQUIRE_RETRY_BUDGET_MS = 15 * 60_000;

export const EXPERT_LIBRARY_USAGE = `Usage: bun run expert:library -- <command> [options]

Worker lane (POST <worker>/v1/domain; --worker <url> or ${WORKER_URL_ENV};
bearer token from ${WORKER_TOKEN_ENV} or --token-file <path>, never an argument value):
  health
  library  --domain <id> --action <catalog|search|grep|read|read_range|view_page>
           [--query <q>] [--k <n>] [--book <id>] [--pattern <re>] [--max-hits <n>] [--slug <books/b/u>]
           [--from <unit>] [--to <unit>] [--session <id>] [--out <file.jpg>]   (view_page needs --out)
  library-ingest --domain <id> --action <start|status|list> [--gcs <gs://uri> | --path <workspace-relative>]
           [--title <t>] [--creator <c>] [--job <id>] [--approval-id <id>] [--apply]   (start is a dry run without --apply)
  search   --domain <id> --query "<q>" [--author <a>] [--title <t>] [--language <l>] [--top <n>] [--ingest-intent]
  acquire  --domain <id> --md5 <md5> --format <pdf|epub|mobi|azw3|djvu> --title <t> --author <a> [--year <y>]
           --copyright-posture <p> --approval-id <id> [--no-ingest] [--dry-run] [--no-wait]

Worker errors are printed verbatim (code + message) and exit 1. acquire retries a busy
quota (RESOURCE_EXHAUSTED) or HTTP 429 with backoff (30s, 90s, ... up to 15 minutes)
unless --no-wait is given.`;

export type ExpertLibraryErrorCode =
  | "invalid_arguments"
  | "worker_not_configured"
  | "worker_unreachable"
  | "worker_invalid_response"
  | "worker_error"
  | "worker_busy";

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
  | ({ command: "library"; domainId: string; params: Record<string, unknown>; out?: string } & WorkerCommandOptions)
  | ({ command: "library-ingest"; domainId: string; params: Record<string, unknown> } & WorkerCommandOptions)
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
    copyrightPosture: string;
    approvalId: string;
    ingest: boolean;
    dryRun: boolean;
    wait: boolean;
  } & WorkerCommandOptions)
  | { command: "help" };

export type ExpertLibraryFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ExpertLibraryCliDependencies {
  env?: Record<string, string | undefined>;
  fetchImpl?: ExpertLibraryFetch;
  sleep?: (ms: number) => Promise<void>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  readFileImpl?: typeof readFile;
  writeFileImpl?: typeof writeFile;
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
    case "library": {
      const flags = parseFlags(rest, { named: [...WORKER_FLAGS, "--domain", "--action", "--query", "--k", "--book", "--pattern", "--max-hits", "--slug", "--from", "--to", "--session", "--out"] });
      const action = requireFlag(flags, "--action");
      if (!["catalog", "search", "grep", "read", "read_range", "view_page"].includes(action)) throw usage("Invalid library action.");
      const params: Record<string, unknown> = { action };
      for (const [flag, key] of [["--query", "query"], ["--book", "book"], ["--pattern", "pattern"], ["--slug", "slug"], ["--from", "from_unit"], ["--to", "to_unit"], ["--session", "session_id"]] as const) {
        const value = flags.values.get(flag);
        if (value !== undefined) params[key] = requireNonEmpty(value, flag);
      }
      for (const [flag, key] of [["--k", "k"], ["--max-hits", "max_hits"]] as const) {
        const value = flags.values.get(flag);
        if (value === undefined) continue;
        if (!/^[1-9]\d*$/.test(value)) throw usage(`${flag} must be a positive integer.`);
        params[key] = Number(value);
      }
      if (action === "view_page" && !flags.values.has("--out")) throw usage("view_page writes the page image to --out <file.jpg>.");
      return { command: "library", domainId: requireFlag(flags, "--domain"), params, ...optionalFlag(flags, "--out", "out"), ...workerOptions(flags) };
    }
    case "library-ingest": {
      const flags = parseFlags(rest, { named: [...WORKER_FLAGS, "--domain", "--action", "--gcs", "--path", "--title", "--creator", "--job", "--approval-id"], boolean: ["--apply"] });
      const action = requireFlag(flags, "--action");
      if (!["start", "status", "list"].includes(action)) throw usage("Invalid library-ingest action.");
      const params: Record<string, unknown> = { action };
      for (const [flag, key] of [["--gcs", "gcs_uri"], ["--path", "workspace_relative_path"], ["--title", "title"], ["--creator", "creator"], ["--job", "job_id"], ["--approval-id", "approval_id"]] as const) {
        const value = flags.values.get(flag);
        if (value !== undefined) params[key] = requireNonEmpty(value, flag);
      }
      if (action === "start") {
        if (Boolean(params.gcs_uri) === Boolean(params.workspace_relative_path)) throw usage("start takes exactly one of --gcs or --path.");
        params.dry_run = !flags.booleans.has("--apply");
        if (!params.dry_run && !params.approval_id) throw usage("A live start (--apply) needs --approval-id.");
      }
      if (action === "status" && !params.job_id) throw usage("status needs --job.");
      return { command: "library-ingest", domainId: requireFlag(flags, "--domain"), params, ...workerOptions(flags) };
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
          "--copyright-posture", "--approval-id",
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
        copyrightPosture: requireFlag(flags, "--copyright-posture"),
        approvalId: requireFlag(flags, "--approval-id"),
        ingest: !flags.booleans.has("--no-ingest"),
        dryRun: flags.booleans.has("--dry-run"),
        wait: !flags.booleans.has("--no-wait"),
        ...workerOptions(flags),
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
    case "library": {
      const outcome = await workerPost(target, "domain_library", { domain_id: parsed.domainId, ...parsed.params }, fetchImpl);
      if (!outcome.ok) return failWorker(outcome, emitter);
      const body = asRecord(outcome.body);
      const image = asRecord(body?.image);
      if (parsed.out !== undefined && typeof image?.data === "string") {
        // The page image goes to a file; the transcript carries only its size.
        const bytes = Buffer.from(image.data, "base64");
        await (dependencies.writeFileImpl ?? writeFile)(parsed.out, bytes);
        emitter.out(prettyJson({ ...body, image: { mime_type: image.mime_type, bytes: bytes.byteLength, written_to: parsed.out } }));
        return 0;
      }
      emitter.out(prettyJson(outcome.body));
      return 0;
    }
    case "library-ingest": {
      const outcome = await workerPost(target, "library_ingest", { domain_id: parsed.domainId, ...parsed.params }, fetchImpl);
      if (!outcome.ok) return failWorker(outcome, emitter);
      emitter.out(prettyJson(outcome.body));
      const state = String(asRecord(asRecord(outcome.body)?.job)?.state ?? "");
      return state === "failed" ? 1 : 0;
    }
    case "health": {
      const outcome = await workerGet(target, "/v1/health", fetchImpl);
      emitter.out(prettyJson(outcome.body));
      if (!outcome.ok) return failWorker(outcome, emitter);
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
        copyright_posture: parsed.copyrightPosture,
        approval_id: parsed.approvalId,
        ingest: parsed.ingest,
        dry_run: parsed.dryRun,
      };
      const outcome = await acquireWithRetry(target, params, parsed.wait, dependencies, emitter);
      if (!outcome.ok) return failWorker(outcome, emitter);
      return printAcquire(outcome.body, emitter);
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
 * Anna Archive meters downloads per minute, which surfaces as "wait, then try
 * again": HTTP 429, an HTTP error whose text carries RESOURCE_EXHAUSTED, or a
 * 200 whose rag_ingest was blocked by that same condition (the download already
 * landed; the worker re-ingests the existing file on the retry).
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
  return texts.some((text) => /RESOURCE_EXHAUSTED/i.test(text));
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
      throw new ExpertLibraryError("worker_busy", `quota busy (HTTP ${outcome.status}); --no-wait given, not retrying.`);
    }
    if (waited + delay > ACQUIRE_RETRY_BUDGET_MS) {
      throw new ExpertLibraryError(
        "worker_busy",
        `quota still busy after ${Math.round(waited / 1000)}s across ${attempt} attempts; giving up.`,
      );
    }
    emitter.err(`quota busy (HTTP ${outcome.status}); attempt ${attempt}, retrying in ${Math.round(delay / 1000)}s`);
    await sleep(delay);
    waited += delay;
    delay = attempt === 1 ? ACQUIRE_RETRY_SECOND_DELAY_MS : Math.min(delay * 3, ACQUIRE_RETRY_MAX_DELAY_MS);
  }
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
  if (status === "blocked") {
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await runExpertLibraryCli(process.argv.slice(2));
}
