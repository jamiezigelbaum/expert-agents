import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, contentIdFromBytes, parseScopeManifest, type Sha256Id } from "../packages/library/src/index.ts";
import {
  ACQUIRE_RETRY_INITIAL_DELAY_MS,
  ACQUIRE_RETRY_SECOND_DELAY_MS,
  EXPERT_LIBRARY_USAGE,
  ExpertLibraryError,
  GCLOUD_ADC_ARGV,
  GOOGLE_ACCESS_TOKEN_ENV,
  isBusyWorkerOutcome,
  parseExpertLibraryArguments,
  resolveGoogleEnv,
  resolveWorkerTarget,
  runExpertLibraryCli,
  type ExpertLibraryCliDependencies,
  type ExpertLibraryFetch,
} from "../scripts/expert-library.ts";
import { runExpertIngestCli } from "../scripts/expert-ingest.ts";

const WORKER = "https://worker.test/runtime";
const TOKEN = "synthetic-worker-token-9f1c";
const GOOGLE_TOKEN = "ya29.synthetic-google-token";
const MD5 = "0123456789abcdef0123456789abcdef";
const OBJECT_A = `sha256:${"a".repeat(64)}` as Sha256Id;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Capture {
  out: string[];
  err: string[];
  calls: Array<{ url: string; method: string; authorization: string | null; body?: unknown }>;
}

function capture(): Capture {
  return { out: [], err: [], calls: [] };
}

function fetchStub(
  captured: Capture,
  respond: (call: { url: string; body?: Record<string, unknown> }, index: number) => Response,
): ExpertLibraryFetch {
  return async (url, init = {}) => {
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    captured.calls.push({ url, method: init.method ?? "GET", authorization: headers.get("Authorization"), ...(body ? { body } : {}) });
    return respond({ url, ...(body ? { body } : {}) }, captured.calls.length - 1);
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function workerDependencies(captured: Capture, fetchImpl: ExpertLibraryFetch, env: Record<string, string | undefined> = {}): ExpertLibraryCliDependencies {
  return {
    env: { EXPERT_AGENTS_WORKER_TOKEN: TOKEN, ...env },
    fetchImpl,
    stdout: (line) => captured.out.push(line),
    stderr: (line) => captured.err.push(line),
    sleep: async () => {},
  };
}

function allOutput(captured: Capture): string {
  return [...captured.out, ...captured.err].join("\n");
}

describe("expert:library argument parsing", () => {
  test("help and an empty invocation print usage", async () => {
    expect(parseExpertLibraryArguments([])).toEqual({ command: "help" });
    expect(parseExpertLibraryArguments(["--help"])).toEqual({ command: "help" });
    const captured = capture();
    expect(await runExpertLibraryCli([], workerDependencies(captured, async () => jsonResponse({})))).toBe(0);
    expect(captured.out[0]).toBe(EXPERT_LIBRARY_USAGE);
  });

  test("parses every worker command with its required and optional flags", () => {
    expect(parseExpertLibraryArguments(["ask", "--domain", "example", "What is dharma?", "--passages", "--corpus", "c1", "--worker", WORKER])).toEqual({
      command: "ask", domainId: "example", question: "What is dharma?", passages: true, corpusId: "c1", worker: WORKER,
    });
    expect(parseExpertLibraryArguments(["search", "--domain", "example", "--query", "yoga sutras", "--author", "Patanjali", "--top", "5", "--ingest-intent"])).toEqual({
      command: "search", domainId: "example", query: "yoga sutras", author: "Patanjali", top: 5, ingestIntent: true,
    });
    expect(parseExpertLibraryArguments([
      "acquire", "--domain", "example", "--md5", MD5.toUpperCase(), "--format", "pdf", "--title", "T", "--author", "A",
      "--corpus", "example-shared-library", "--copyright-posture", "owner-acquired", "--approval-id", "msg-1", "--no-ingest", "--dry-run", "--no-wait",
    ])).toEqual({
      command: "acquire", domainId: "example", md5: MD5, format: "pdf", title: "T", author: "A", corpusId: "example-shared-library",
      copyrightPosture: "owner-acquired", approvalId: "msg-1", ingest: false, dryRun: true, wait: false,
    });
    expect(parseExpertLibraryArguments([
      "source", "register", "--domain", "example", "--kind", "book", "--title", "T", "--author", "A", "--locator", "https://example.invalid/t",
      "--trust-tier", "reviewed", "--copyright-posture", "owner-acquired", "--corpus", "c1", "--token-file", "/run/token",
    ])).toEqual({
      command: "source-register", domainId: "example", kind: "book", title: "T", author: "A", locator: "https://example.invalid/t",
      trustTier: "reviewed", copyrightPosture: "owner-acquired", corpusId: "c1", tokenFile: "/run/token",
    });
    expect(parseExpertLibraryArguments(["status", "--domain", "example"])).toEqual({ command: "status", domainId: "example" });
    expect(parseExpertLibraryArguments(["health"])).toEqual({ command: "health" });
  });

  test("parses the owner lane ingest command with positional sources", () => {
    expect(parseExpertLibraryArguments([
      "ingest", "--scope", "/agent/library/scope-manifest.json", "--library", "/cand", "--bucket", "b", "--prefix", "v2",
      "--receipts", "/r", "--title", "T", "--creator", "C", "https://example.invalid/paper.pdf",
    ])).toEqual({
      command: "ingest", scopePath: "/agent/library/scope-manifest.json", libraryDirectory: "/cand", bucket: "b", prefix: "v2",
      receiptsDirectory: "/r", title: "T", creator: "C", sources: ["https://example.invalid/paper.pdf"],
    });
  });

  test("refuses usage errors with the usage text and exit code 2", async () => {
    const cases: string[][] = [
      ["bogus"],
      ["ask", "--domain", "example"],
      ["ask", "--domain", "example", "q1", "q2"],
      ["search", "--domain", "example"],
      ["search", "--domain", "example", "--query", "q", "--top", "0"],
      ["acquire", "--domain", "example", "--md5", "nothex", "--format", "pdf", "--title", "T", "--author", "A", "--corpus", "c", "--copyright-posture", "p", "--approval-id", "i"],
      ["source", "list"],
      ["status"],
      ["ingest", "--scope", "s", "--library", "l", "--bucket", "b", "--prefix", "p", "--receipts", "r"],
      ["ingest", "--scope", "s", "--library", "l", "--bucket", "b", "--prefix", "p", "--receipts", "r", "--title", "T", "a.pdf", "b.pdf"],
      ["ingest", "--scope", "s", "--library", "l", "--bucket", "b", "--prefix", "p", "--receipts", "r", "--title", "T", "--meta", "m.json", "a.pdf"],
      ["health", "--worker"],
      ["health", "--worker", WORKER, "--worker", WORKER],
      ["health", "--unknown"],
    ];
    for (const argv of cases) {
      expect(() => parseExpertLibraryArguments(argv)).toThrow(ExpertLibraryError);
      const captured = capture();
      expect(await runExpertLibraryCli(argv, workerDependencies(captured, async () => jsonResponse({})))).toBe(2);
      expect(captured.err[0]).toContain("Usage: bun run expert:library");
    }
  });
});

describe("expert:library worker target and token handling", () => {
  test("the token is read only from the environment or a token file, never an argument", async () => {
    const env = { EXPERT_AGENTS_WORKER_URL: `${WORKER}/`, EXPERT_AGENTS_WORKER_TOKEN: TOKEN };
    expect(await resolveWorkerTarget({}, env, readFile)).toEqual({ baseUrl: WORKER, token: TOKEN });

    const root = await temporaryRoot();
    const tokenFile = join(root, "token");
    await writeFile(tokenFile, `${TOKEN}\n`);
    expect(await resolveWorkerTarget({ worker: WORKER, tokenFile }, {}, readFile)).toEqual({ baseUrl: WORKER, token: TOKEN });
    expect(() => parseExpertLibraryArguments(["health", "--token", TOKEN])).toThrow("Unknown argument: --token");
  });

  test("refuses a missing, non-http, or credential-bearing worker URL without reflecting the token", async () => {
    await expect(resolveWorkerTarget({}, {}, readFile)).rejects.toThrow("worker URL is required");
    await expect(resolveWorkerTarget({ worker: "ftp://worker.test" }, {}, readFile)).rejects.toThrow("http or https");
    await expect(resolveWorkerTarget({ worker: `https://user:${TOKEN}@worker.test` }, {}, readFile)).rejects.toThrow("must not carry credentials");
    try {
      await resolveWorkerTarget({ worker: `https://user:${TOKEN}@worker.test` }, {}, readFile);
    } catch (error) {
      expect(String(error)).not.toContain(TOKEN);
    }
    await expect(resolveWorkerTarget({ worker: WORKER, tokenFile: "/nonexistent/token" }, {}, readFile)).rejects.toThrow("could not be read");
  });

  test("sends the bearer token on the wire but never to stdout, stderr, or a diagnostic", async () => {
    const captured = capture();
    const fetchImpl = fetchStub(captured, ({ url }) => (url.endsWith("/v1/health")
      ? jsonResponse({ kind: "domain_expert_health", reachable: true, echo: TOKEN })
      : jsonResponse({ error: { code: "unauthorized", message: `bad token ${TOKEN}` } }, 401)));
    const dependencies = workerDependencies(captured, fetchImpl, { EXPERT_AGENTS_WORKER_URL: WORKER });

    expect(await runExpertLibraryCli(["health"], dependencies)).toBe(0);
    expect(captured.calls[0]).toEqual({ url: `${WORKER}/v1/health`, method: "GET", authorization: `Bearer ${TOKEN}` });
    expect(await runExpertLibraryCli(["ask", "--domain", "example", "question"], dependencies)).toBe(1);
    expect(captured.calls[1]!.authorization).toBe(`Bearer ${TOKEN}`);
    // Even a worker that echoes the token back is redacted before it reaches a terminal.
    expect(allOutput(captured)).not.toContain(TOKEN);
    expect(allOutput(captured)).toContain("[redacted]");
  });
});

describe("expert:library worker commands", () => {
  test("read preserves source identity, revision and continuation fields", async () => {
    const captured = capture();
    const fetchImpl = fetchStub(captured, () => jsonResponse({ kind: "domain_read_result", text: "Reference", next_offset: 120, complete: false }));
    const id = "sha256:" + "a".repeat(64);
    const revision = "b".repeat(64);
    expect(await runExpertLibraryCli(["read", "--domain", "example", "--worker", WORKER, "--action", "read", "--object", id, "--revision", revision, "--section", "3", "--offset", "100", "--limit", "20"], workerDependencies(captured, fetchImpl))).toBe(0);
    expect(captured.calls[0]!.body).toEqual({ tool: "domain_read", params: { domain_id: "example", action: "read", object_id: id, text_revision: revision, section: 3, offset: 100, limit: 20 } });
    expect(JSON.parse(captured.out[0]!)).toMatchObject({ text: "Reference", next_offset: 120, complete: false });
  });
  test("ask sends domain_ask and prints the cited answer", async () => {
    const captured = capture();
    const fetchImpl = fetchStub(captured, () => jsonResponse({
      kind: "domain_answer",
      status: "answered",
      answer: "Neutral answer [n:1].",
      citations: [{ citation_id: "n:1", source_display_name: "Neutral Source", source_uri: "gs://neutral/objects/x.md" }],
      warnings: ["neutral warning"],
    }));
    expect(await runExpertLibraryCli(["ask", "--domain", "example", "--worker", WORKER, "What?", "--corpus", "c1"], workerDependencies(captured, fetchImpl))).toBe(0);
    expect(captured.calls[0]).toMatchObject({
      url: `${WORKER}/v1/domain`,
      method: "POST",
      body: { tool: "domain_ask", params: { domain_id: "example", question: "What?", corpus_id: "c1" } },
    });
    expect(captured.out).toEqual(["status: answered", "Neutral answer [n:1].", "", "citations:", "  [n:1] Neutral Source gs://neutral/objects/x.md"]);
    expect(captured.err).toEqual(["warning: neutral warning"]);
  });

  test("ask --passages requests passages output and prints each passage", async () => {
    const captured = capture();
    const fetchImpl = fetchStub(captured, () => jsonResponse({
      kind: "domain_passages",
      status: "retrieved",
      passages: [{ citation_id: "n:1", corpus_id: "c1", text: "Passage text.", source_display_name: "Neutral", source_uri: "gs://n/x.md", score: 0.5 }],
    }));
    expect(await runExpertLibraryCli(["ask", "--domain", "example", "--worker", WORKER, "What?", "--passages"], workerDependencies(captured, fetchImpl))).toBe(0);
    expect((captured.calls[0]!.body as { params: Record<string, unknown> }).params.output).toBe("passages");
    expect(captured.out).toContain("[n:1] Neutral (c1, score 0.5)");
    expect(captured.out).toContain("  Passage text.");
    expect(captured.out).toContain("1 passage(s)");
  });

  test("ask prints creator and title instead of the stored file name when the worker supplies them", async () => {
    const captured = capture();
    const fetchImpl = fetchStub(captured, () => jsonResponse({
      kind: "domain_passages",
      status: "retrieved",
      passages: [
        { citation_id: "n:1", corpus_id: "c1", text: "Titled.", title: "The Edge of Example", creator: "Casey Example", source_display_name: "a".repeat(64) + ".md", source_uri: "gs://n/a.md", score: 0.5 },
        { citation_id: "n:2", corpus_id: "c1", text: "Untitled.", source_display_name: "legacy-name.pdf", source_uri: "gs://n/b.pdf" },
      ],
    }));
    expect(await runExpertLibraryCli(["ask", "--domain", "example", "--worker", WORKER, "What?", "--passages"], workerDependencies(captured, fetchImpl))).toBe(0);
    expect(captured.out).toContain("[n:1] Casey Example — The Edge of Example (c1, score 0.5)");
    expect(captured.out).toContain("[n:2] legacy-name.pdf (c1)");
    const answer = capture();
    const answerFetch = fetchStub(answer, () => jsonResponse({
      kind: "domain_answer", status: "answered", answer: "A [n:1].",
      citations: [{ citation_id: "n:1", title: "A Title Alone", source_display_name: "b".repeat(64) + ".md", source_uri: "gs://n/c.md" }],
    }));
    expect(await runExpertLibraryCli(["ask", "--domain", "example", "--worker", WORKER, "What?"], workerDependencies(answer, answerFetch))).toBe(0);
    expect(answer.out).toContain("  [n:1] A Title Alone gs://n/c.md");
  });

  test("search sends annas_archive_search and prints a ranked table with warnings", async () => {
    const captured = capture();
    const fetchImpl = fetchStub(captured, () => jsonResponse({
      kind: "annas_archive_search_result",
      search: { backend: "libgen_fallback" },
      warnings: ["Anna Archive search failed (HTTP 403); candidates come from Library Genesis."],
      candidates: [
        { title: "Yoga Sutras", author: "Patanjali", year: "1990", format: "pdf", language: "en", file_size_bytes: 2_500_000, md5: MD5, rationale: ["format pdf preferred"] },
        { title: "Yoga Sutras", author: "Patanjali", format: "epub", file_size_bytes: 300, md5: "f".repeat(32), rationale: [] },
      ],
    }));
    expect(await runExpertLibraryCli([
      "search", "--domain", "example", "--worker", WORKER, "--query", "yoga sutras", "--author", "Patanjali", "--top", "2", "--ingest-intent",
    ], workerDependencies(captured, fetchImpl))).toBe(0);
    expect(captured.calls[0]!.body).toEqual({
      tool: "annas_archive_search",
      params: { domain_id: "example", query: "yoga sutras", author: "Patanjali", top_n: 2, format_preference: "text_rag" },
    });
    const text = captured.out.join("\n");
    expect(captured.out[0]).toBe("backend: libgen_fallback");
    expect(text).toMatch(/rank\s+format\s+size\s+title\s+author\s+year\s+language\s+md5/);
    expect(text).toMatch(new RegExp(`1\\s+pdf\\s+2\\.4 MiB\\s+Yoga Sutras\\s+Patanjali\\s+1990\\s+en\\s+${MD5}`));
    expect(text).toMatch(/2\s+epub\s+300 B\s+Yoga Sutras/);
    expect(text).toContain("#1: format pdf preferred");
    expect(captured.err).toEqual(["warning: Anna Archive search failed (HTTP 403); candidates come from Library Genesis."]);
  });

  test("worker errors are printed verbatim with code and message and exit 1", async () => {
    const captured = capture();
    const fetchImpl = fetchStub(captured, () => jsonResponse({
      error: { code: "annas_archive_not_configured", message: "Anna Archive API key is not configured.", suggestion: "Set the key on the worker host." },
      policy: {},
    }, 503));
    expect(await runExpertLibraryCli(["search", "--domain", "example", "--worker", WORKER, "--query", "q"], workerDependencies(captured, fetchImpl))).toBe(1);
    expect(captured.err[0]).toBe("worker error (HTTP 503) annas_archive_not_configured: Anna Archive API key is not configured.");
    expect(JSON.parse(captured.err.slice(1).join("\n"))).toEqual({
      code: "annas_archive_not_configured",
      message: "Anna Archive API key is not configured.",
      suggestion: "Set the key on the worker host.",
    });
  });

  test("an unreachable worker and a non-JSON body are typed errors", async () => {
    const captured = capture();
    const unreachable: ExpertLibraryFetch = async () => { throw new TypeError("connect ECONNREFUSED"); };
    expect(await runExpertLibraryCli(["health", "--worker", WORKER], workerDependencies(captured, unreachable))).toBe(1);
    expect(captured.err[0]).toBe("worker_unreachable: worker is unreachable at https://worker.test.");

    const html: ExpertLibraryFetch = async () => new Response("<html>gateway</html>", { status: 502 });
    expect(await runExpertLibraryCli(["health", "--worker", WORKER], workerDependencies(captured, html))).toBe(1);
    expect(captured.err[1]).toBe("worker_invalid_response: worker returned HTTP 502 without a JSON body.");
  });

  test("acquire sends annas_archive_import with dry_run false and prints the full rag_ingest status", async () => {
    const captured = capture();
    const fetchImpl = fetchStub(captured, () => jsonResponse({
      kind: "annas_archive_import_result",
      status: "downloaded",
      download: { status: "downloaded", path: "/books/a.pdf", bytes: 1024 },
      rag_ingest: { status: "import_requested", target_corpus_id: "example-shared-library", gcs_uri: "gs://b/p/x.pdf", rag_import: { operation: { name: "op/1" } } },
    }));
    expect(await runExpertLibraryCli([
      "acquire", "--domain", "example", "--worker", WORKER, "--md5", MD5, "--format", "pdf", "--title", "T", "--author", "A", "--year", "1990",
      "--corpus", "example-shared-library", "--copyright-posture", "owner-acquired", "--approval-id", "msg-1",
    ], workerDependencies(captured, fetchImpl))).toBe(0);
    expect(captured.calls[0]!.body).toEqual({
      tool: "annas_archive_import",
      params: {
        domain_id: "example", md5: MD5, annas_archive_id: MD5, format: "pdf", title: "T", author: "A", year: "1990",
        corpus_id: "example-shared-library", copyright_posture: "owner-acquired", approval_id: "msg-1", ingest: true, dry_run: false,
      },
    });
    expect(captured.out[0]).toBe("status: downloaded");
    expect(captured.out[1]).toBe("download: downloaded /books/a.pdf (1.0 KiB)");
    expect(captured.out.join("\n")).toContain('"status": "import_requested"');
    expect(captured.out.join("\n")).toContain('"gcs_uri": "gs://b/p/x.pdf"');
  });

  test("acquire surfaces a blocked rag_ingest error message and exits 1", async () => {
    const captured = capture();
    const fetchImpl = fetchStub(captured, () => jsonResponse({
      kind: "annas_archive_import_result",
      status: "downloaded_ingest_blocked",
      download: { status: "downloaded", path: "/books/a.pdf" },
      rag_ingest: { status: "blocked", error: { code: "annas_artifact_scale_implausible", message: "Measured 3 page(s).", suggestion: "Re-run with allow_short_artifact." } },
    }));
    expect(await runExpertLibraryCli([
      "acquire", "--domain", "example", "--worker", WORKER, "--md5", MD5, "--format", "pdf", "--title", "T", "--author", "A",
      "--corpus", "c", "--copyright-posture", "p", "--approval-id", "i", "--no-ingest", "--dry-run",
    ], workerDependencies(captured, fetchImpl))).toBe(1);
    const params = (captured.calls[0]!.body as { params: Record<string, unknown> }).params;
    expect(params.ingest).toBe(false);
    expect(params.dry_run).toBe(true);
    expect(captured.err).toEqual([
      "rag_ingest error annas_artifact_scale_implausible: Measured 3 page(s).",
      "  Re-run with allow_short_artifact.",
    ]);
  });

  test("acquire retries a busy corpus and a 429 with 30s then 90s backoff", async () => {
    const captured = capture();
    const sleeps: number[] = [];
    const responses = [
      () => jsonResponse({ error: { code: "rag_import_failed", message: "FAILED_PRECONDITION: other operations running on corpus" } }, 400),
      () => jsonResponse({ error: { code: "annas_archive_rate_limited", message: "slow down" } }, 429),
      () => jsonResponse({ kind: "annas_archive_import_result", status: "ingested_existing", rag_ingest: { status: "import_requested" } }),
    ];
    const fetchImpl = fetchStub(captured, (_call, index) => responses[index]!());
    const dependencies = { ...workerDependencies(captured, fetchImpl), sleep: async (ms: number) => { sleeps.push(ms); } };
    expect(await runExpertLibraryCli([
      "acquire", "--domain", "example", "--worker", WORKER, "--md5", MD5, "--format", "pdf", "--title", "T", "--author", "A",
      "--corpus", "c", "--copyright-posture", "p", "--approval-id", "i",
    ], dependencies)).toBe(0);
    expect(captured.calls).toHaveLength(3);
    expect(sleeps).toEqual([ACQUIRE_RETRY_INITIAL_DELAY_MS, ACQUIRE_RETRY_SECOND_DELAY_MS]);
    expect(captured.err[0]).toBe("corpus or quota busy (HTTP 400); attempt 1, retrying in 30s");
    expect(captured.err[1]).toBe("corpus or quota busy (HTTP 429); attempt 2, retrying in 90s");
    expect(captured.out[0]).toBe("status: ingested_existing");
  });

  test("acquire --no-wait refuses to retry a busy corpus, and a blocked-busy 200 counts as busy", async () => {
    const captured = capture();
    const fetchImpl = fetchStub(captured, () => jsonResponse({
      kind: "annas_archive_import_result",
      status: "downloaded_ingest_blocked",
      rag_ingest: { status: "blocked", error: { code: "rag_import_failed", message: "9 FAILED_PRECONDITION: There are other operations running on the corpus." } },
    }));
    expect(isBusyWorkerOutcome({ status: 429, ok: false, body: {} })).toBe(true);
    expect(isBusyWorkerOutcome({ status: 200, ok: true, body: { rag_ingest: { status: "import_requested" } } })).toBe(false);
    expect(await runExpertLibraryCli([
      "acquire", "--domain", "example", "--worker", WORKER, "--md5", MD5, "--format", "pdf", "--title", "T", "--author", "A",
      "--corpus", "c", "--copyright-posture", "p", "--approval-id", "i", "--no-wait",
    ], workerDependencies(captured, fetchImpl))).toBe(1);
    expect(captured.calls).toHaveLength(1);
    expect(captured.err[0]).toBe("worker_busy: corpus or quota busy (HTTP 200); --no-wait given, not retrying.");
  });

  test("acquire gives up once the 15 minute budget is spent", async () => {
    const captured = capture();
    const sleeps: number[] = [];
    const fetchImpl = fetchStub(captured, () => jsonResponse({ error: { code: "rate_limited", message: "429" } }, 429));
    const dependencies = { ...workerDependencies(captured, fetchImpl), sleep: async (ms: number) => { sleeps.push(ms); } };
    expect(await runExpertLibraryCli([
      "acquire", "--domain", "example", "--worker", WORKER, "--md5", MD5, "--format", "pdf", "--title", "T", "--author", "A",
      "--corpus", "c", "--copyright-posture", "p", "--approval-id", "i",
    ], dependencies)).toBe(1);
    expect(sleeps.reduce((total, value) => total + value, 0)).toBeLessThanOrEqual(15 * 60_000);
    expect(sleeps).toEqual([30_000, 90_000, 270_000, 300_000]);
    expect(captured.err.at(-1)).toMatch(/^worker_busy: corpus or quota still busy after 690s across 5 attempts; giving up\.$/);
  });

  test("source register sends a non-dry-run domain_source add with the registry fields", async () => {
    const captured = capture();
    const fetchImpl = fetchStub(captured, () => jsonResponse({
      kind: "domain_source_result", status: "registered", source_record: { source_id: "example:book:t", title: "T" },
    }));
    expect(await runExpertLibraryCli([
      "source", "register", "--domain", "example", "--worker", WORKER, "--kind", "book", "--title", "T", "--author", "A",
      "--locator", "https://example.invalid/t", "--trust-tier", "reviewed", "--copyright-posture", "owner-acquired", "--corpus", "c1",
    ], workerDependencies(captured, fetchImpl))).toBe(0);
    expect(captured.calls[0]!.body).toEqual({
      tool: "domain_source",
      params: {
        action: "add", domain_id: "example", kind: "book", title: "T", author: "A", url: "https://example.invalid/t",
        trust_posture: "reviewed", copyright_posture: "owner-acquired", corpus_id: "c1", dry_run: false,
      },
    });
    expect(captured.out.slice(0, 2)).toEqual(["status: registered", "source_id: example:book:t"]);
  });

  test("status sends rag_corpus status and prints the resolved corpus", async () => {
    const captured = capture();
    const fetchImpl = fetchStub(captured, () => jsonResponse({
      kind: "rag_corpus_status",
      resolved_corpus: { corpus_id: "c1", resource_name: "projects/p/locations/l/ragCorpora/1" },
      corpus: { displayName: "c1", state: "ACTIVE" },
    }));
    expect(await runExpertLibraryCli(["status", "--domain", "example", "--worker", WORKER, "--corpus", "c1"], workerDependencies(captured, fetchImpl))).toBe(0);
    expect(captured.calls[0]!.body).toEqual({ tool: "rag_corpus", params: { action: "status", domain_id: "example", corpus_id: "c1" } });
    expect(captured.out[0]).toBe("corpus: c1 (projects/p/locations/l/ragCorpora/1)");
    expect(JSON.parse(captured.out.slice(1).join("\n"))).toEqual({ displayName: "c1", state: "ACTIVE" });
  });
});

describe("expert:library owner lane", () => {
  test("mints the Google token with gcloud only when no runtime credential is set", async () => {
    const spawned: string[][] = [];
    const spawn = async (argv: string[]) => { spawned.push(argv); return { exitCode: 0, stdout: `${GOOGLE_TOKEN}\n`, stderr: "" }; };
    const minted = await resolveGoogleEnv({ EXPERT_AGENTS_GCP_PROJECT: "p" }, spawn);
    expect(minted[GOOGLE_ACCESS_TOKEN_ENV]).toBe(GOOGLE_TOKEN);
    expect(spawned).toEqual([[...GCLOUD_ADC_ARGV]]);

    const preset = { [GOOGLE_ACCESS_TOKEN_ENV]: "preset" };
    expect(await resolveGoogleEnv(preset, spawn)).toBe(preset);
    expect(spawned).toHaveLength(1);

    const failing = async () => ({ exitCode: 1, stdout: "", stderr: "Reauthentication required." });
    await expect(resolveGoogleEnv({}, failing)).rejects.toThrow("print-access-token failed (exit 1)");
  });

  test("ingest stages, extends the scope, plans then executes, annotates, and writes a receipt", async () => {
    const root = await temporaryRoot();
    const fixture = await ingestFixture(root);
    const captured = capture();
    const materializeCalls: string[][] = [];
    const annotateCalls: string[][] = [];
    const ingestCalls: string[][] = [];
    const seenEnv: Array<Record<string, string | undefined> | undefined> = [];
    const paperBytes = new TextEncoder().encode("# Paper\n\nExtracted paragraph.\n");
    const paperId = contentIdFromBytes(paperBytes);
    const dependencies: ExpertLibraryCliDependencies = {
      env: { EXPERT_AGENTS_GCP_PROJECT: "neutral-project" },
      stdout: (line) => captured.out.push(line),
      stderr: (line) => captured.err.push(line),
      now: () => "2026-01-02T03:04:05.000Z",
      spawn: async (argv) => (argv[0] === "gcloud"
        ? { exitCode: 0, stdout: `${GOOGLE_TOKEN}\n`, stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "unexpected spawn" }),
      which: () => null,
      ingest: async (argv, ingestDependencies) => {
        ingestCalls.push(argv);
        seenEnv.push(ingestDependencies?.env);
        // The prepared note is staged for real through expert:ingest so the
        // candidate carries title/creator via the validator; the URL is faked.
        if (argv.includes("--prepared")) return runExpertIngestCli(argv, { ...ingestDependencies, now: () => "2026-01-02T03:04:05.000Z" });
        return {
          objectId: paperId, relativePath: `objects/sha256/${paperId.slice(7, 9)}/${paperId.slice(7)}.md`, byteSize: paperBytes.byteLength,
          objectPath: "/x", descriptorPath: "/x/candidates.json", trustTier: "public-unrestricted", copyrightPosture: "public-unrestricted",
          title: "Paper Title", creator: "Paper Author", alreadyStaged: false,
        };
      },
      materialize: async (argv, materializeDependencies) => {
        materializeCalls.push(argv);
        seenEnv.push(materializeDependencies?.env);
        const execute = argv.includes("--execute");
        const receipt = {
          mode: execute ? "execute" : "plan_only",
          masterRevision: { before: 4, after: execute ? 5 : 5 },
          ledgerRevision: { before: 2, after: execute ? 3 : 2 },
          candidates: { dedupedObjectIds: [fixture.noteId] },
          materialization: { rejectedImports: [], unresolvableSelections: [] },
          summary: { candidates: 2, addedObjects: 1, dedupedObjects: 1, uploadedObjects: execute ? 1 : 0, plannedUploads: 1, importedObjects: execute ? 1 : 0, rejectedImports: 0, alreadyMaterialized: 0, unresolvableSelections: 0 },
        };
        const receiptBytes = new TextEncoder().encode(JSON.stringify(receipt));
        const receiptPath = argv[argv.indexOf("--receipt") + 1]!;
        await writeFile(receiptPath, receiptBytes);
        return { receiptPath, receiptBytes };
      },
      annotate: async (argv, annotateDependencies) => {
        annotateCalls.push(argv);
        seenEnv.push(annotateDependencies?.env);
        const receiptPath = argv[argv.indexOf("--receipt") + 1]!;
        return { mode: "execute" as const, outputPath: receiptPath, outputBytes: new Uint8Array() };
      },
    };

    const code = await runExpertLibraryCli([
      "ingest", "--scope", fixture.scopePath, "--library", fixture.library, "--bucket", "neutral-bucket", "--prefix", "v2",
      "--receipts", fixture.receipts, "--meta", fixture.metaPath, "https://example.invalid/paper.pdf", fixture.notePath,
    ], dependencies);

    expect(captured.err).toEqual([]);
    expect(code).toBe(0);
    expect(ingestCalls[0]).toEqual([
      "--source", "https://example.invalid/paper.pdf", "--library", fixture.library, "--title", "Paper Title", "--creator", "Paper Author",
    ]);
    expect(ingestCalls[1]).toEqual(["--source", fixture.notePath, "--library", fixture.library, "--prepared", "--title", "Note Title", "--creator", "Note Author"]);
    // The staged candidate carries title and creator (validated through the library object contract).
    const descriptor = JSON.parse(await readFile(join(fixture.library, "candidates.json"), "utf8")) as { candidates: Array<{ metadata: Record<string, unknown> }> };
    expect(descriptor.candidates[0]!.metadata.title).toBe("Note Title");
    expect(descriptor.candidates[0]!.metadata.creator).toBe("Note Author");

    const scope = parseScopeManifest(await readFile(fixture.scopePath, "utf8"));
    expect(scope.selection.objectIds).toEqual([OBJECT_A, fixture.noteId, paperId].sort());

    expect(materializeCalls).toHaveLength(2);
    expect(materializeCalls[0]!.slice(0, 8)).toEqual(["--bucket", "neutral-bucket", "--prefix", "v2", "--scope", fixture.scopePath, "--candidates", fixture.library]);
    expect(materializeCalls[0]).not.toContain("--execute");
    expect(materializeCalls[1]).toContain("--execute");
    for (const env of seenEnv.slice(2)) expect(env?.[GOOGLE_ACCESS_TOKEN_ENV]).toBe(GOOGLE_TOKEN);

    // Only the already-live note is annotated; the paper carried its title on the candidate.
    expect(annotateCalls).toHaveLength(1);
    const annotations = JSON.parse(await readFile(annotateCalls[0]![annotateCalls[0]!.indexOf("--annotations") + 1]!, "utf8")) as Record<string, unknown>;
    expect(annotations).toEqual({
      schemaVersion: 1,
      expectedRevision: 5,
      annotations: [{ objectId: fixture.noteId, title: "Note Title", creator: "Note Author", updatedAt: "2026-01-02T03:04:05.000Z" }],
    });

    expect(captured.out[0]).toBe(`staged ${paperId} ${paperBytes.byteLength} bytes Paper Title <- https://example.invalid/paper.pdf`);
    expect(captured.out[1]).toMatch(new RegExp(`^staged ${fixture.noteId} \\d+ bytes Note Title <- `));
    expect(captured.out[2]).toBe(`scope ${fixture.scopePath}: +2 object id(s), 3 total`);
    expect(captured.out[3]).toBe("plan: plan_only candidates=2 added=1 deduped=1 uploads=0 imports=0 rejected=0 alreadyMaterialized=0 unresolvable=0");
    expect(captured.out[4]).toBe("execute: execute candidates=2 added=1 deduped=1 uploads=1 imports=1 rejected=0 alreadyMaterialized=0 unresolvable=0");
    expect(captured.out[5]).toBe("master revision 4 -> 5; ledger 2 -> 3");
    expect(captured.out[6]).toBe("annotated 1 already-live object(s)");
    const receiptPath = captured.out[7]!.replace("receipt: ", "");
    const receiptText = await readFile(receiptPath, "utf8");
    expect(receiptText).not.toContain(GOOGLE_TOKEN);
    const receipt = JSON.parse(receiptText) as Record<string, unknown>;
    expect(receipt.kind).toBe("expert_library_ingest_receipt");
    expect((receipt.sources as unknown[]).length).toBe(2);
    expect(receipt.scope).toEqual({ path: fixture.scopePath, addedObjectIds: [fixture.noteId, paperId].sort(), totalObjectIds: 3 });
    expect(allOutput(captured)).not.toContain(GOOGLE_TOKEN);
  });

  test("ingest converts an ebook with ebook-convert before staging and refuses without a converter", async () => {
    const root = await temporaryRoot();
    const fixture = await ingestFixture(root);
    const epubPath = join(root, "book.epub");
    await writeFile(epubPath, "not really an epub");
    const spawned: string[][] = [];
    const ingestCalls: string[][] = [];
    const base: ExpertLibraryCliDependencies = {
      env: { EXPERT_AGENTS_GCP_PROJECT: "p", [GOOGLE_ACCESS_TOKEN_ENV]: GOOGLE_TOKEN },
      stdout: () => {},
      stderr: () => {},
      ingest: async (argv) => {
        ingestCalls.push(argv);
        return {
          objectId: OBJECT_A, relativePath: "objects/sha256/aa/a.txt", byteSize: 5, objectPath: "/x", descriptorPath: "/x/c.json",
          trustTier: "t", copyrightPosture: "p", alreadyStaged: true,
        };
      },
      materialize: async (argv) => {
        const receiptBytes = new TextEncoder().encode(JSON.stringify({ mode: "execute", masterRevision: { before: 1, after: 1 }, ledgerRevision: { before: 1, after: 1 }, candidates: { dedupedObjectIds: [] }, materialization: { rejectedImports: [], unresolvableSelections: [] }, summary: {} }));
        return { receiptPath: argv[argv.indexOf("--receipt") + 1]!, receiptBytes };
      },
      annotate: async () => { throw new Error("annotate must not run"); },
    };
    const argv = ["ingest", "--scope", fixture.scopePath, "--library", fixture.library, "--bucket", "b", "--prefix", "v2", "--receipts", fixture.receipts, epubPath];

    const captured = capture();
    expect(await runExpertLibraryCli(argv, { ...base, stderr: (line) => captured.err.push(line), which: () => null })).toBe(1);
    expect(captured.err[0]).toBe("ebook_conversion_unavailable: .epub sources need ebook-convert (calibre) or pandoc on PATH; neither was found.");
    expect(ingestCalls).toHaveLength(0);

    const which = (binary: string) => (binary === "ebook-convert" ? "/opt/calibre/ebook-convert" : null);
    const spawn = async (spawnArgv: string[]) => {
      spawned.push(spawnArgv);
      await writeFile(spawnArgv[2]!, "converted text\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    expect(await runExpertLibraryCli(argv, { ...base, which, spawn })).toBe(0);
    expect(spawned[0]![0]).toBe("/opt/calibre/ebook-convert");
    expect(spawned[0]![1]).toBe(epubPath);
    expect(spawned[0]![2]).toMatch(/book\.txt$/);
    expect(ingestCalls[0]!.slice(0, 5)).toEqual(["--source", spawned[0]![2]!, "--library", fixture.library, "--prepared"]);

    const failingSpawn = async () => ({ exitCode: 2, stdout: "", stderr: "Conversion error: bad container\nmore" });
    const failed = capture();
    expect(await runExpertLibraryCli(argv, { ...base, which, spawn: failingSpawn, stderr: (line) => failed.err.push(line) })).toBe(1);
    expect(failed.err[0]).toBe("ebook_conversion_failed: ebook-convert exited with code 2: Conversion error: bad container");
  });

  test("ingest fails fast without a project, and refuses a malformed --meta document", async () => {
    const root = await temporaryRoot();
    const fixture = await ingestFixture(root);
    const captured = capture();
    const argv = ["ingest", "--scope", fixture.scopePath, "--library", fixture.library, "--bucket", "b", "--prefix", "v2", "--receipts", fixture.receipts, fixture.notePath];
    expect(await runExpertLibraryCli(argv, { env: {}, stdout: () => {}, stderr: (line) => captured.err.push(line) })).toBe(1);
    expect(captured.err[0]).toBe("google_project_not_configured: EXPERT_AGENTS_GCP_PROJECT is required for the owner lane.");

    const badMeta = join(root, "bad-meta.json");
    await writeFile(badMeta, JSON.stringify({ "https://example.invalid/other.pdf": { title: "Other" } }));
    const metaCaptured = capture();
    expect(await runExpertLibraryCli([...argv, "--meta", badMeta], {
      env: { EXPERT_AGENTS_GCP_PROJECT: "p", [GOOGLE_ACCESS_TOKEN_ENV]: GOOGLE_TOKEN },
      stdout: () => {},
      stderr: (line) => metaCaptured.err.push(line),
      ingest: async () => { throw new Error("ingest must not run"); },
    })).toBe(1);
    expect(metaCaptured.err[0]).toBe("meta_invalid: --meta names a source that is not being ingested: https://example.invalid/other.pdf");
  });
});

interface IngestFixture {
  scopePath: string;
  library: string;
  receipts: string;
  notePath: string;
  noteId: Sha256Id;
  metaPath: string;
}

async function ingestFixture(root: string): Promise<IngestFixture> {
  const library = join(root, "candidates");
  const receipts = join(root, "receipts");
  await mkdir(library, { recursive: true });
  const notePath = join(root, "note.md");
  const noteText = "# Note\n\nReviewed prepared text.\n";
  await writeFile(notePath, noteText);
  const scopePath = join(root, "agent", "library", "scope-manifest.json");
  await mkdir(join(root, "agent", "library"), { recursive: true });
  await writeFile(scopePath, canonicalJson({
    agentId: "neutral-agent",
    schemaVersion: 1,
    selection: { objectIds: [OBJECT_A] },
    targetCorpusDisplayName: "neutral-corpus",
    masterRevision: 4,
  }));
  const metaPath = join(root, "meta.json");
  await writeFile(metaPath, JSON.stringify({
    "https://example.invalid/paper.pdf": { title: "Paper Title", creator: "Paper Author" },
    [notePath]: { title: "Note Title", creator: "Note Author" },
  }));
  return { scopePath, library, receipts, notePath, noteId: contentIdFromBytes(new TextEncoder().encode(noteText)), metaPath };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "expert-library-cli-test-"));
  temporaryRoots.push(root);
  return root;
}
