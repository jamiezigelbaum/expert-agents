import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACQUIRE_RETRY_INITIAL_DELAY_MS,
  ACQUIRE_RETRY_SECOND_DELAY_MS,
  EXPERT_LIBRARY_USAGE,
  ExpertLibraryError,
  isBusyWorkerOutcome,
  parseExpertLibraryArguments,
  resolveWorkerTarget,
  runExpertLibraryCli,
  type ExpertLibraryCliDependencies,
  type ExpertLibraryFetch,
} from "../scripts/expert-library.ts";

const WORKER = "https://worker.test/runtime";
const TOKEN = "synthetic-worker-token-9f1c";
const MD5 = "0123456789abcdef0123456789abcdef";
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
    expect(parseExpertLibraryArguments(["search", "--domain", "example", "--query", "yoga sutras", "--author", "Patanjali", "--top", "5", "--ingest-intent"])).toEqual({
      command: "search", domainId: "example", query: "yoga sutras", author: "Patanjali", top: 5, ingestIntent: true,
    });
    expect(parseExpertLibraryArguments([
      "acquire", "--domain", "example", "--md5", MD5.toUpperCase(), "--format", "pdf", "--title", "T", "--author", "A",
      "--copyright-posture", "owner-acquired", "--approval-id", "msg-1", "--no-ingest", "--dry-run", "--no-wait",
    ])).toEqual({
      command: "acquire", domainId: "example", md5: MD5, format: "pdf", title: "T", author: "A",
      copyrightPosture: "owner-acquired", approvalId: "msg-1", ingest: false, dryRun: true, wait: false,
    });
    expect(parseExpertLibraryArguments(["health"])).toEqual({ command: "health" });
  });

  test("refuses usage errors with the usage text and exit code 2", async () => {
    const cases: string[][] = [
      ["bogus"],
      ["search", "--domain", "example"],
      ["search", "--domain", "example", "--query", "q", "--top", "0"],
      ["acquire", "--domain", "example", "--md5", "nothex", "--format", "pdf", "--title", "T", "--author", "A", "--copyright-posture", "p", "--approval-id", "i"],
      // Commands of the removed Vertex answer and import lanes are now unknown commands.
      ["ask", "--domain", "example", "question"],
      ["read", "--domain", "example"],
      ["source", "register"],
      ["status", "--domain", "example"],
      ["acquire", "--domain", "example", "--md5", "0123456789abcdef0123456789abcdef", "--format", "pdf", "--title", "T", "--author", "A", "--corpus", "c", "--copyright-posture", "p", "--approval-id", "i"],
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
    expect(await runExpertLibraryCli(["search", "--domain", "example", "--query", "question"], dependencies)).toBe(1);
    expect(captured.calls[1]!.authorization).toBe(`Bearer ${TOKEN}`);
    // Even a worker that echoes the token back is redacted before it reaches a terminal.
    expect(allOutput(captured)).not.toContain(TOKEN);
    expect(allOutput(captured)).toContain("[redacted]");
  });
});

describe("expert:library worker commands", () => {
  test("library sends domain_library and writes a viewed page to --out, not the transcript", async () => {
    const captured = capture();
    const fetchImpl = fetchStub(captured, (call) => (call.body?.params as Record<string, unknown>).action === "view_page"
      ? jsonResponse({ kind: "domain_library_result", slug: "books/b/p0001", cite: "A, B, p.1", image: { mime_type: "image/jpeg", data: Buffer.from([0xff, 0xd8, 1]).toString("base64") } })
      : jsonResponse({ kind: "domain_library_result", results: [{ slug: "books/b/p0001", cite: "A, B, p.1", text: "Evidence." }] }));
    expect(await runExpertLibraryCli(["library", "--domain", "example", "--worker", WORKER, "--action", "search", "--query", "evidence", "--k", "5", "--book", "b", "--session", "s1"], workerDependencies(captured, fetchImpl))).toBe(0);
    expect(captured.calls[0]!.body).toEqual({ tool: "domain_library", params: { domain_id: "example", action: "search", query: "evidence", book: "b", session_id: "s1", k: 5 } });
    const dir = await mkdtemp(join(tmpdir(), "expert-library-view-"));
    temporaryRoots.push(dir);
    const out = join(dir, "page.jpg");
    expect(await runExpertLibraryCli(["library", "--domain", "example", "--worker", WORKER, "--action", "view_page", "--slug", "books/b/p0001", "--out", out], workerDependencies(captured, fetchImpl))).toBe(0);
    expect([...await readFile(out)]).toEqual([0xff, 0xd8, 1]);
    expect(JSON.parse(captured.out.at(-1)!).image).toEqual({ mime_type: "image/jpeg", bytes: 3, written_to: out });
    expect(() => parseExpertLibraryArguments(["library", "--domain", "example", "--action", "view_page", "--slug", "books/b/p0001"])).toThrow("--out");
  });

  test("library-ingest starts as a dry run unless --apply, and a live start needs an approval id", async () => {
    expect(parseExpertLibraryArguments(["library-ingest", "--domain", "example", "--action", "start", "--gcs", "gs://lib/x.pdf"])).toEqual({
      command: "library-ingest", domainId: "example", params: { action: "start", gcs_uri: "gs://lib/x.pdf", dry_run: true },
    });
    expect(() => parseExpertLibraryArguments(["library-ingest", "--domain", "example", "--action", "start", "--gcs", "gs://lib/x.pdf", "--apply"])).toThrow("--approval-id");
    expect(() => parseExpertLibraryArguments(["library-ingest", "--domain", "example", "--action", "start"])).toThrow("exactly one of");
    const captured = capture();
    const fetchImpl = fetchStub(captured, () => jsonResponse({ kind: "library_ingest_result", job: { job_id: "j1", state: "failed", error: "x" } }));
    expect(await runExpertLibraryCli(["library-ingest", "--domain", "example", "--worker", WORKER, "--action", "status", "--job", "j1"], workerDependencies(captured, fetchImpl))).toBe(1);
    expect(captured.calls[0]!.body).toEqual({ tool: "library_ingest", params: { domain_id: "example", action: "status", job_id: "j1" } });
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
      params: { domain_id: "example", query: "yoga sutras", author: "Patanjali", top_n: 2, format_preference: "text_rag", ingest_intent: true },
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

  test("acquire sends annas_archive_import with dry_run false and prints the full ingest status", async () => {
    const captured = capture();
    const fetchImpl = fetchStub(captured, () => jsonResponse({
      kind: "annas_archive_import_result",
      status: "downloaded",
      download: { status: "downloaded", path: "/books/a.pdf", bytes: 1024 },
      rag_ingest: { status: "import_requested", job_id: "job-1", pages: 120 },
    }));
    expect(await runExpertLibraryCli([
      "acquire", "--domain", "example", "--worker", WORKER, "--md5", MD5, "--format", "pdf", "--title", "T", "--author", "A", "--year", "1990",
      "--copyright-posture", "owner-acquired", "--approval-id", "msg-1",
    ], workerDependencies(captured, fetchImpl))).toBe(0);
    expect(captured.calls[0]!.body).toEqual({
      tool: "annas_archive_import",
      params: {
        domain_id: "example", md5: MD5, annas_archive_id: MD5, format: "pdf", title: "T", author: "A", year: "1990",
        copyright_posture: "owner-acquired", approval_id: "msg-1", ingest: true, dry_run: false,
      },
    });
    expect(captured.out[0]).toBe("status: downloaded");
    expect(captured.out[1]).toBe("download: downloaded /books/a.pdf (1.0 KiB)");
    expect(captured.out.join("\n")).toContain('"status": "import_requested"');
    expect(captured.out.join("\n")).toContain('"job_id": "job-1"');
  });

  test("acquire surfaces a blocked ingest error message and exits 1", async () => {
    const captured = capture();
    const fetchImpl = fetchStub(captured, () => jsonResponse({
      kind: "annas_archive_import_result",
      status: "downloaded_ingest_blocked",
      download: { status: "downloaded", path: "/books/a.pdf" },
      rag_ingest: { status: "blocked", error: { code: "annas_artifact_scale_implausible", message: "Measured 3 page(s).", suggestion: "Re-run with allow_short_artifact." } },
    }));
    expect(await runExpertLibraryCli([
      "acquire", "--domain", "example", "--worker", WORKER, "--md5", MD5, "--format", "pdf", "--title", "T", "--author", "A",
      "--copyright-posture", "p", "--approval-id", "i", "--no-ingest", "--dry-run",
    ], workerDependencies(captured, fetchImpl))).toBe(1);
    const params = (captured.calls[0]!.body as { params: Record<string, unknown> }).params;
    expect(params.ingest).toBe(false);
    expect(params.dry_run).toBe(true);
    expect(captured.err).toEqual([
      "rag_ingest error annas_artifact_scale_implausible: Measured 3 page(s).",
      "  Re-run with allow_short_artifact.",
    ]);
  });

  test("acquire retries a busy quota and a 429 with 30s then 90s backoff", async () => {
    const captured = capture();
    const sleeps: number[] = [];
    const responses = [
      () => jsonResponse({ error: { code: "rate_limited", message: "RESOURCE_EXHAUSTED: quota exceeded" } }, 400),
      () => jsonResponse({ error: { code: "annas_archive_rate_limited", message: "slow down" } }, 429),
      () => jsonResponse({ kind: "annas_archive_import_result", status: "ingested_existing", rag_ingest: { status: "import_requested" } }),
    ];
    const fetchImpl = fetchStub(captured, (_call, index) => responses[index]!());
    const dependencies = { ...workerDependencies(captured, fetchImpl), sleep: async (ms: number) => { sleeps.push(ms); } };
    expect(await runExpertLibraryCli([
      "acquire", "--domain", "example", "--worker", WORKER, "--md5", MD5, "--format", "pdf", "--title", "T", "--author", "A",
      "--copyright-posture", "p", "--approval-id", "i",
    ], dependencies)).toBe(0);
    expect(captured.calls).toHaveLength(3);
    expect(sleeps).toEqual([ACQUIRE_RETRY_INITIAL_DELAY_MS, ACQUIRE_RETRY_SECOND_DELAY_MS]);
    expect(captured.err[0]).toBe("quota busy (HTTP 400); attempt 1, retrying in 30s");
    expect(captured.err[1]).toBe("quota busy (HTTP 429); attempt 2, retrying in 90s");
    expect(captured.out[0]).toBe("status: ingested_existing");
  });

  test("acquire --no-wait refuses to retry a busy quota, and a blocked-busy 200 counts as busy", async () => {
    const captured = capture();
    const fetchImpl = fetchStub(captured, () => jsonResponse({
      kind: "annas_archive_import_result",
      status: "downloaded_ingest_blocked",
      rag_ingest: { status: "blocked", error: { code: "rag_import_failed", message: "8 RESOURCE_EXHAUSTED: Quota exceeded." } },
    }));
    expect(isBusyWorkerOutcome({ status: 429, ok: false, body: {} })).toBe(true);
    // Only a quota signal is busy; a corpus-busy precondition error is an ordinary failure now.
    expect(isBusyWorkerOutcome({ status: 400, ok: false, body: { error: { code: "rag_import_failed", message: "FAILED_PRECONDITION: other operations running" } } })).toBe(false);
    expect(isBusyWorkerOutcome({ status: 200, ok: true, body: { rag_ingest: { status: "import_requested" } } })).toBe(false);
    expect(await runExpertLibraryCli([
      "acquire", "--domain", "example", "--worker", WORKER, "--md5", MD5, "--format", "pdf", "--title", "T", "--author", "A",
      "--copyright-posture", "p", "--approval-id", "i", "--no-wait",
    ], workerDependencies(captured, fetchImpl))).toBe(1);
    expect(captured.calls).toHaveLength(1);
    expect(captured.err[0]).toBe("worker_busy: quota busy (HTTP 200); --no-wait given, not retrying.");
  });

  test("acquire gives up once the 15 minute budget is spent", async () => {
    const captured = capture();
    const sleeps: number[] = [];
    const fetchImpl = fetchStub(captured, () => jsonResponse({ error: { code: "rate_limited", message: "429" } }, 429));
    const dependencies = { ...workerDependencies(captured, fetchImpl), sleep: async (ms: number) => { sleeps.push(ms); } };
    expect(await runExpertLibraryCli([
      "acquire", "--domain", "example", "--worker", WORKER, "--md5", MD5, "--format", "pdf", "--title", "T", "--author", "A",
      "--copyright-posture", "p", "--approval-id", "i",
    ], dependencies)).toBe(1);
    expect(sleeps.reduce((total, value) => total + value, 0)).toBeLessThanOrEqual(15 * 60_000);
    expect(sleeps).toEqual([30_000, 90_000, 270_000, 300_000]);
    expect(captured.err.at(-1)).toMatch(/^worker_busy: quota still busy after 690s across 5 attempts; giving up\.$/);
  });

});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "expert-library-cli-test-"));
  temporaryRoots.push(root);
  return root;
}
