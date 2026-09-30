import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { contentIdFromBytes } from "../packages/library/src/index.ts";
import {
  EXTRACTION_ARGUMENTS,
  EXTRACTION_MAX_OUTPUT_BYTES,
  EXTRACTION_TIMEOUT_MS,
  ExpertIngestError,
  PERMISSIVE_DEFAULT_COPYRIGHT_POSTURE,
  PERMISSIVE_DEFAULT_TRUST_TIER,
  SUMMARIZE_INSTALL_COMMAND,
  extractorEnvironment,
  ingestExtractionEnv,
  normalizeExtractedText,
  parseExpertIngestArguments,
  resolveGovernance,
  runExpertIngestCli,
  type ExtractionRequest,
  type ExtractionResult,
  type ReferenceExtractor,
} from "../scripts/expert-ingest.ts";

const NEUTRAL_SOURCE = "https://example.invalid/reference/neutral-talk";
const NEUTRAL_BINARY = "/neutral/bin/summarize";
const NEUTRAL_EXTRACTION = "# Neutral Reference\n\nFirst extracted paragraph.\n";
const FIXED_INSTANT = "2026-01-02T03:04:05.000Z";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("expert:ingest argument parsing", () => {
  test("accepts a source and library directory without any declared posture", () => {
    expect(parseExpertIngestArguments(["--source", NEUTRAL_SOURCE, "--library", "/neutral/library"])).toEqual({
      source: NEUTRAL_SOURCE,
      libraryDirectory: "/neutral/library",
    });
  });

  test("carries a declared trust tier, copyright posture, and corpus", () => {
    expect(parseExpertIngestArguments([
      "--source", NEUTRAL_SOURCE,
      "--library", "/neutral/library",
      "--trust-tier", "neutral-reviewed",
      "--copyright-posture", "neutral-restricted",
      "--corpus", "neutral-corpus",
    ])).toEqual({
      source: NEUTRAL_SOURCE,
      libraryDirectory: "/neutral/library",
      trustTier: "neutral-reviewed",
      copyrightPosture: "neutral-restricted",
      corpusId: "neutral-corpus",
    });
  });

  test("refuses a missing source, a missing library, an unknown flag, and a duplicate flag", () => {
    expect(() => parseExpertIngestArguments(["--library", "/neutral/library"])).toThrow("Missing required argument: --source");
    expect(() => parseExpertIngestArguments(["--source", NEUTRAL_SOURCE])).toThrow("Missing required argument: --library");
    expect(() => parseExpertIngestArguments(["--source", NEUTRAL_SOURCE, "--library", "/l", "--summarize"]))
      .toThrow("Unknown argument: --summarize");
    expect(() => parseExpertIngestArguments(["--source", NEUTRAL_SOURCE, "--source", NEUTRAL_SOURCE, "--library", "/l"]))
      .toThrow("Duplicate argument: --source");
    expect(() => parseExpertIngestArguments(["--source", "--library"])).toThrow("Missing value for --source");
  });
});

describe("expert:ingest extraction boundary", () => {
  test("names the install command when the summarize binary is absent", async () => {
    const attempts: ExtractionRequest[] = [];
    const promise = runExpertIngestCli(
      ["--source", NEUTRAL_SOURCE, "--library", "/neutral/library"],
      { summarizePath: null, extract: recordingExtractor(attempts), env: {}, now: () => FIXED_INSTANT },
    );

    await expect(promise).rejects.toThrow(SUMMARIZE_INSTALL_COMMAND);
    await expect(promise).rejects.toMatchObject({ code: "summarize_not_installed" });
    expect(attempts).toHaveLength(0);
  });

  test("invokes summarize in extraction-only mode with no summarizing flag", async () => {
    const fixture = await createFixture();
    const attempts: ExtractionRequest[] = [];

    await runExpertIngestCli(fixture.argv, {
      summarizePath: NEUTRAL_BINARY,
      extract: recordingExtractor(attempts),
      env: {},
      now: () => FIXED_INSTANT,
    });

    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.binaryPath).toBe(NEUTRAL_BINARY);
    expect(attempts[0]!.source).toBe(NEUTRAL_SOURCE);
    expect([...attempts[0]!.args]).toEqual(["--extract", "--format", "md", "--plain", "--no-color"]);
    expect(attempts[0]!.timeoutMs).toBe(EXTRACTION_TIMEOUT_MS);
    expect(attempts[0]!.maxOutputBytes).toBe(EXTRACTION_MAX_OUTPUT_BYTES);
    for (const summarizingFlag of ["--model", "--cli", "--json", "--force-summary", "--diarize", "--transcriber", "--length"]) {
      expect([...EXTRACTION_ARGUMENTS]).not.toContain(summarizingFlag);
    }
  });

  test("hands the extractor an environment stripped of every credential-shaped variable", () => {
    const filtered = extractorEnvironment({
      PATH: "/neutral/bin",
      HOME: "/neutral/home",
      ANTHROPIC_API_KEY: "placeholder-not-a-credential",
      OPENAI_API_KEY: "placeholder-not-a-credential",
      GROQ_API_KEY: "placeholder-not-a-credential",
      ELEVENLABS_API_KEY: "placeholder-not-a-credential",
      FIRECRAWL_API_KEY: "placeholder-not-a-credential",
      APIFY_API_TOKEN: "placeholder-not-a-credential",
      FAL_KEY: "placeholder-not-a-credential",
      GOOGLE_APPLICATION_CREDENTIALS: "/neutral/path.json",
      NEUTRAL_UNSET: undefined,
    });

    expect(filtered).toEqual({ PATH: "/neutral/bin", HOME: "/neutral/home" });
  });

  test("passes the filtered environment through to the extraction request", async () => {
    const fixture = await createFixture();
    const attempts: ExtractionRequest[] = [];

    await runExpertIngestCli(fixture.argv, {
      summarizePath: NEUTRAL_BINARY,
      extract: recordingExtractor(attempts),
      env: { PATH: "/neutral/bin", OPENAI_API_KEY: "placeholder-not-a-credential" },
      now: () => FIXED_INSTANT,
    });

    expect(attempts[0]!.env.PATH).toBe("/neutral/bin");
    expectIsolatedExtractionEnv(attempts[0]!.env);
  });

  test("fails closed with a typed error and no staged files when extraction fails", async () => {
    const fixture = await createFixture();

    const promise = runExpertIngestCli(fixture.argv, {
      summarizePath: NEUTRAL_BINARY,
      extract: async () => ({ exitCode: 1, stdout: "", stderr: "no published transcript is available\n" }),
      env: {},
      now: () => FIXED_INSTANT,
    });

    await expect(promise).rejects.toMatchObject({ code: "extraction_failed" });
    await expect(promise).rejects.toThrow("no published transcript is available");
    expect(await pathExists(join(fixture.library, "candidates.json"))).toBe(false);
  });

  // The real spawn path, not a stubbed extractor: an extractor that never
  // returns has to be terminated by this lane rather than waited on. Without
  // the bound this test hangs until the runner's own timeout, which is exactly
  // the failure the bound exists to prevent.
  test("terminates an extractor that outlives the bound and stages nothing", async () => {
    const fixture = await createFixture();
    const stalling = join(fixture.library, "neutral-stalling-summarize");
    await writeFile(stalling, "#!/bin/sh\nexec sleep 10\n", { mode: 0o755 });

    const promise = runExpertIngestCli(fixture.argv, {
      summarizePath: stalling,
      timeoutMs: 250,
      env: {},
      now: () => FIXED_INSTANT,
    });

    await expect(promise).rejects.toBeInstanceOf(ExpertIngestError);
    await expect(promise).rejects.toMatchObject({ code: "extraction_timed_out" });
    expect(await pathExists(join(fixture.library, "candidates.json"))).toBe(false);
  });

  // The real spawn path again, and the case the timeout cannot catch: this
  // extractor never stalls, it just never stops. The bound is injected small so
  // the cut-off is observable without moving 25 MB. With the enforcement removed
  // this test fails rather than passing slowly: the CLI buffers until something
  // else puts the child down and then misreports the flood as an ordinary
  // non-zero exit, which is the outcome the typed code exists to prevent.
  test("terminates an extractor that exceeds the output bound and stages nothing", async () => {
    const fixture = await createFixture();
    const flooding = join(fixture.library, "neutral-flooding-summarize");
    await writeFile(
      flooding,
      "#!/bin/sh\nwhile :; do printf 'neutral extracted filler line for the output bound fixture\\n'; done\n",
      { mode: 0o755 },
    );

    const promise = runExpertIngestCli(fixture.argv, {
      summarizePath: flooding,
      maxOutputBytes: 64 * 1024,
      env: {},
      now: () => FIXED_INSTANT,
    });

    await expect(promise).rejects.toBeInstanceOf(ExpertIngestError);
    await expect(promise).rejects.toMatchObject({ code: "extraction_output_too_large" });
    expect(await pathExists(join(fixture.library, "candidates.json"))).toBe(false);
  });

  test("uses a private writable home when the inherited service home is read-only", async () => {
    const fixture = await createFixture();
    const inheritedHome = join(fixture.library, "read-only-service-home");
    const extractor = join(fixture.library, "neutral-home-writing-summarize");
    await mkdir(inheritedHome, { mode: 0o700 });
    await chmod(inheritedHome, 0o500);
    await writeFile(
      extractor,
      "#!/bin/sh\nmkdir -p \"$HOME/.summarize\" || exit 41\nprintf '# Isolated extraction\\n\\nWritable private home.\\n'\n",
      { mode: 0o755 },
    );

    const result = await runExpertIngestCli(fixture.argv, {
      summarizePath: extractor,
      env: { PATH: process.env.PATH ?? "", HOME: inheritedHome },
      now: () => FIXED_INSTANT,
    });

    expect(result.byteSize).toBeGreaterThan(0);
    expect(await pathExists(join(inheritedHome, ".summarize"))).toBe(false);
  });

  test("runs the real extractor spawn outside a caller project that contains provider dotenv keys", async () => {
    const fixture = await createFixture();
    const priorCwd = process.cwd();
    const source = join(fixture.library, "relative-source.html");
    const extractor = join(fixture.library, "relative-summarize");
    await writeFile(join(fixture.library, ".env"), "OPENAI_API_KEY=sentinel-must-not-load\n");
    await writeFile(source, "<html><body>local fixture</body></html>\n");
    await writeFile(
      extractor,
      "#!/bin/sh\nif [ -f .env ]; then echo loaded-caller-dotenv >&2; exit 91; fi\ncase \"$1\" in /*) ;; *) echo source-was-not-resolved >&2; exit 92;; esac\n[ -r \"$1\" ] || exit 93\nprintf '# Private cwd extraction\\n\\nNo caller dotenv loaded.\\n'\n",
      { mode: 0o755 },
    );
    try {
      process.chdir(fixture.library);
      const result = await runExpertIngestCli([
        "--source", "./relative-source.html",
        "--library", "./library-output",
      ], {
        summarizePath: "./relative-summarize",
        env: { PATH: process.env.PATH ?? "" },
        now: () => FIXED_INSTANT,
      });

      expect(result.byteSize).toBeGreaterThan(0);
      expect(await readFile(result.objectPath, "utf8")).toContain("No caller dotenv loaded.");
    } finally {
      process.chdir(priorCwd);
    }
  });

  test("refuses an empty extraction rather than staging an empty object", async () => {
    const fixture = await createFixture();

    const promise = runExpertIngestCli(fixture.argv, {
      summarizePath: NEUTRAL_BINARY,
      extract: async () => ({ exitCode: 0, stdout: "   \n\n", stderr: "" }),
      env: {},
      now: () => FIXED_INSTANT,
    });

    await expect(promise).rejects.toMatchObject({ code: "extraction_empty" });
    expect(await pathExists(join(fixture.library, "candidates.json"))).toBe(false);
  });

  test("normalizes extracted text to a single trailing newline", () => {
    expect(normalizeExtractedText("body\n\n\n")).toBe("body\n");
    expect(normalizeExtractedText("body")).toBe("body\n");
    expect(normalizeExtractedText(" \n ")).toBe("");
  });
});

describe("expert:ingest credential isolation", () => {
  // Each of these carries a credential under a name the credential-shaped
  // denylist does not match, which is why the positive allowlist has to run
  // first. The values are placeholders, not real secrets.
  const PLANTED_CREDENTIALS = {
    GITHUB_PAT: "placeholder-not-a-credential",
    DATABASE_URL: "postgres://placeholder:placeholder@db.invalid/neutral",
    REDIS_URL: "redis://placeholder:placeholder@cache.invalid:6379",
    KUBECONFIG: "/neutral/home/.kube/config",
    NETRC: "/neutral/home/.netrc",
    HTTPS_PROXY: "https://placeholder:placeholder@proxy.invalid:8443",
  };

  test("the allowlist runs before the credential strip, so unnamed credentials never survive", () => {
    const built = ingestExtractionEnv({
      PATH: "/neutral/bin",
      HOME: "/neutral/home",
      ...PLANTED_CREDENTIALS,
      OPENAI_API_KEY: "placeholder-not-a-credential",
    });

    expect(built).toEqual({ PATH: "/neutral/bin", HOME: "/neutral/home" });
  });

  test("none of the planted variables reach the extractor's environment", async () => {
    const fixture = await createFixture();
    const attempts: ExtractionRequest[] = [];

    await runExpertIngestCli(fixture.argv, {
      summarizePath: NEUTRAL_BINARY,
      extract: recordingExtractor(attempts),
      env: { PATH: "/neutral/bin", ...PLANTED_CREDENTIALS },
      now: () => FIXED_INSTANT,
    });

    expect(attempts[0]!.env.PATH).toBe("/neutral/bin");
    expectIsolatedExtractionEnv(attempts[0]!.env);
    for (const name of Object.keys(PLANTED_CREDENTIALS)) {
      expect(attempts[0]!.env).not.toHaveProperty(name);
    }
    expect(JSON.stringify(attempts[0]!.env)).not.toContain("placeholder");
  });

  test("a source locator carrying userinfo never reaches argv, candidates.json, or a diagnostic", async () => {
    const fixture = await createFixture();
    const attempts: ExtractionRequest[] = [];
    const secret = "placeholder-not-a-credential";
    const source = `https://neutral-user:${secret}@example.invalid/reference/neutral-talk`;

    const promise = runExpertIngestCli(["--source", source, "--library", fixture.library], {
      summarizePath: NEUTRAL_BINARY,
      extract: recordingExtractor(attempts),
      env: {},
      now: () => FIXED_INSTANT,
    });

    await expect(promise).rejects.toBeInstanceOf(ExpertIngestError);
    await expect(promise).rejects.toMatchObject({ code: "credential_bearing_source" });
    const message = await promise.then(() => "", (error: Error) => error.message);
    expect(message).not.toContain(secret);
    expect(message).not.toContain("neutral-user");
    expect(attempts).toHaveLength(0);
    expect(await pathExists(join(fixture.library, "candidates.json"))).toBe(false);
  });

  test("the refusal covers a bare username and survives parsing on its own", () => {
    expect(() => parseExpertIngestArguments([
      "--source", "https://neutral-user@example.invalid/reference",
      "--library", "/neutral/library",
    ])).toThrow("embedded username");
    expect(() => parseExpertIngestArguments([
      "--source", "https://:placeholder-not-a-credential@example.invalid/reference",
      "--library", "/neutral/library",
    ])).toThrow("embedded password");
    // A local path is not a URL and is left alone.
    expect(parseExpertIngestArguments(["--source", "/neutral/local/file.md", "--library", "/l"]).source)
      .toBe("/neutral/local/file.md");
  });
});

describe("expert:ingest library staging", () => {
  test("stages the extracted text as a content-addressed object with provenance", async () => {
    const fixture = await createFixture();

    const result = await runExpertIngestCli(fixture.argv, stubbedDependencies());

    const expectedId = contentIdFromBytes(new TextEncoder().encode(NEUTRAL_EXTRACTION));
    expect(result.objectId).toBe(expectedId);
    expect(result.relativePath).toBe(`objects/sha256/${expectedId.slice(7, 9)}/${expectedId.slice(7)}.md`);
    expect(await readFile(join(fixture.library, result.relativePath), "utf8")).toBe(NEUTRAL_EXTRACTION);

    const entry = await readCandidate(fixture.library, result.relativePath);
    expect(entry.metadata.sourceLocators).toEqual([NEUTRAL_SOURCE]);
    expect(entry.metadata.mediaType).toBe("text/markdown");
    expect(entry.metadata.provenance).toEqual({
      acquiredBy: "expert:ingest",
      acquiredAt: FIXED_INSTANT,
      acquisitionMethod: "summarize --extract --format md",
    });
  });

  test("defaults to the permissive posture when neither posture flag is declared", async () => {
    const fixture = await createFixture();

    const result = await runExpertIngestCli(fixture.argv, stubbedDependencies());

    expect(result.trustTier).toBe(PERMISSIVE_DEFAULT_TRUST_TIER);
    expect(result.copyrightPosture).toBe(PERMISSIVE_DEFAULT_COPYRIGHT_POSTURE);
    const entry = await readCandidate(fixture.library, result.relativePath);
    expect(entry.metadata.trustTier).toBe(PERMISSIVE_DEFAULT_TRUST_TIER);
    expect(entry.metadata.copyrightPosture).toBe(PERMISSIVE_DEFAULT_COPYRIGHT_POSTURE);
  });

  test("lets a declared trust tier and copyright posture override the permissive defaults", async () => {
    const fixture = await createFixture([
      "--trust-tier", "neutral-reviewed",
      "--copyright-posture", "neutral-restricted",
    ]);

    const result = await runExpertIngestCli(fixture.argv, stubbedDependencies());

    const entry = await readCandidate(fixture.library, result.relativePath);
    expect(entry.metadata.trustTier).toBe("neutral-reviewed");
    expect(entry.metadata.copyrightPosture).toBe("neutral-restricted");
  });

  test("keeps a previously declared posture when a later run declares nothing", async () => {
    const declared = await createFixture([
      "--trust-tier", "neutral-reviewed",
      "--copyright-posture", "neutral-restricted",
    ]);
    await runExpertIngestCli(declared.argv, stubbedDependencies());

    const result = await runExpertIngestCli(
      ["--source", NEUTRAL_SOURCE, "--library", declared.library],
      stubbedDependencies(),
    );

    expect(result.alreadyStaged).toBe(true);
    const entry = await readCandidate(declared.library, result.relativePath);
    expect(entry.metadata.trustTier).toBe("neutral-reviewed");
    expect(entry.metadata.copyrightPosture).toBe("neutral-restricted");
  });

  test("resolves governance from the supplied flag, then the staged posture, then the permissive default", () => {
    expect(resolveGovernance({})).toEqual({
      trustTier: PERMISSIVE_DEFAULT_TRUST_TIER,
      copyrightPosture: PERMISSIVE_DEFAULT_COPYRIGHT_POSTURE,
    });
    expect(resolveGovernance({}, { trustTier: "neutral-reviewed", copyrightPosture: "neutral-restricted" }))
      .toEqual({ trustTier: "neutral-reviewed", copyrightPosture: "neutral-restricted" });
    expect(resolveGovernance(
      { trustTier: "neutral-declared", copyrightPosture: "neutral-declared" },
      { trustTier: "neutral-reviewed", copyrightPosture: "neutral-restricted" },
    )).toEqual({ trustTier: "neutral-declared", copyrightPosture: "neutral-declared" });
  });

  test("re-ingesting identical bytes stays a single deterministic descriptor entry", async () => {
    const fixture = await createFixture();

    await runExpertIngestCli(fixture.argv, stubbedDependencies());
    const first = await readFile(join(fixture.library, "candidates.json"), "utf8");
    await runExpertIngestCli(fixture.argv, stubbedDependencies());
    const second = await readFile(join(fixture.library, "candidates.json"), "utf8");

    expect(second).toBe(first);
    expect(JSON.parse(second).candidates).toHaveLength(1);
  });

  test("unions source locators when the same extracted bytes arrive from a second locator", async () => {
    const fixture = await createFixture();
    await runExpertIngestCli(fixture.argv, stubbedDependencies());

    const second = "https://example.invalid/reference/neutral-mirror";
    const result = await runExpertIngestCli(
      ["--source", second, "--library", fixture.library],
      stubbedDependencies(),
    );

    const entry = await readCandidate(fixture.library, result.relativePath);
    expect(entry.metadata.sourceLocators).toEqual([second, NEUTRAL_SOURCE].sort());
  });

  test("records the intended corpus only when --corpus is supplied", async () => {
    const withoutCorpus = await createFixture();
    await runExpertIngestCli(withoutCorpus.argv, stubbedDependencies());
    expect(await pathExists(join(withoutCorpus.library, "corpus-intents.json"))).toBe(false);

    const withCorpus = await createFixture(["--corpus", "neutral-corpus"]);
    const result = await runExpertIngestCli(withCorpus.argv, stubbedDependencies());
    const intents = JSON.parse(await readFile(join(withCorpus.library, "corpus-intents.json"), "utf8"));

    expect(result.corpusId).toBe("neutral-corpus");
    expect(intents).toEqual({
      schemaVersion: 1,
      kind: "expert_ingest_corpus_intents",
      intents: [{ objectId: result.objectId, corpusIds: ["neutral-corpus"] }],
    });
  });

  test("rejects a library directory whose descriptor is not valid staging state", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.library, "candidates.json"), "{\"schemaVersion\":2}\n");

    await expect(runExpertIngestCli(fixture.argv, stubbedDependencies()))
      .rejects.toMatchObject({ code: "library_state_invalid" });
  });
});

const REAL_BINARY_TIMEOUT_MS = 30_000;

describe("expert:ingest against an installed summarize binary", () => {
  test.skipIf(Bun.which("summarize") === null)(
    "surfaces a typed failure from the real binary without any network access",
    async () => {
      const fixture = await createFixture();
      const unsupported = join(fixture.library, "unsupported-local-input.md");
      await writeFile(unsupported, "# Neutral local fixture\n");

      // --extract on a local text file is unsupported by the real CLI, which
      // exercises the live subprocess wiring while staying entirely local.
      const promise = runExpertIngestCli(["--source", unsupported, "--library", fixture.library], {
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        now: () => FIXED_INSTANT,
      });

      await expect(promise).rejects.toBeInstanceOf(ExpertIngestError);
      await expect(promise).rejects.toMatchObject({ code: "extraction_failed" });
      expect(await pathExists(join(fixture.library, "candidates.json"))).toBe(false);
    },
    // Spawning the real CLI means this test waits on a third-party binary's
    // cold start, which lands either side of the 5s default depending on
    // machine load. The bound is generous because a slow machine is not a
    // failing assertion; it only has to be finite.
    REAL_BINARY_TIMEOUT_MS,
  );
});

function stubbedDependencies() {
  return {
    summarizePath: NEUTRAL_BINARY,
    extract: (async () => ({ exitCode: 0, stdout: NEUTRAL_EXTRACTION, stderr: "3s - markdown\n" })) as ReferenceExtractor,
    env: {},
    now: () => FIXED_INSTANT,
  };
}

function recordingExtractor(attempts: ExtractionRequest[]): ReferenceExtractor {
  return async (request: ExtractionRequest): Promise<ExtractionResult> => {
    attempts.push(request);
    return { exitCode: 0, stdout: NEUTRAL_EXTRACTION, stderr: "" };
  };
}

async function createFixture(extraArguments: string[] = []): Promise<{ library: string; argv: string[] }> {
  const library = await mkdtemp(join(tmpdir(), "expert-ingest-"));
  temporaryDirectories.push(library);
  return {
    library,
    argv: ["--source", NEUTRAL_SOURCE, "--library", library, ...extraArguments],
  };
}

async function readCandidate(
  library: string,
  relativePath: string,
): Promise<{ path: string; metadata: Record<string, any> }> {
  const descriptor = JSON.parse(await readFile(join(library, "candidates.json"), "utf8"));
  const entry = descriptor.candidates.find((candidate: { path: string }) => candidate.path === relativePath);
  expect(entry).toBeDefined();
  return entry;
}

async function pathExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

function expectIsolatedExtractionEnv(env: Record<string, string>): void {
  const root = resolve(env.HOME!, "..");
  expect(env.HOME).toBe(join(root, "home"));
  expect(env.XDG_CACHE_HOME).toBe(join(root, "cache"));
  expect(env.XDG_CONFIG_HOME).toBe(join(root, "config"));
  expect(env.XDG_DATA_HOME).toBe(join(root, "data"));
  expect(env.TMPDIR).toBe(join(root, "tmp"));
  expect(env.TMP).toBe(env.TMPDIR);
  expect(env.TEMP).toBe(env.TMPDIR);
}


describe("expert:ingest prepared text", () => {
  test("preserves exact reviewed bytes without an installed extractor and records honest custody", async () => {
    const fixture = await createFixture();
    const source = join(fixture.library, "reviewed.md");
    const bytes = new TextEncoder().encode("\uFEFF# Synthetic reviewed source\r\n\r\nCafé.  \r\n\r\n");
    await writeFile(source, bytes);
    const attempts: ExtractionRequest[] = [];
    const result = await runExpertIngestCli(["--prepared", "--source", source, "--library", fixture.library], {
      summarizePath: null, extract: recordingExtractor(attempts), now: () => FIXED_INSTANT,
    });
    expect(attempts).toHaveLength(0);
    expect(result.objectId).toBe(contentIdFromBytes(bytes));
    expect(new Uint8Array(await readFile(result.objectPath))).toEqual(bytes);
    const entry = await readCandidate(fixture.library, result.relativePath);
    expect(entry.metadata.derivativeKind).toBe("prepared-text");
    expect(entry.metadata.provenance.acquisitionMethod).toBe("prepared local file (exact bytes)");
    expect(await pathExists(join(fixture.library, "corpus-intents.json"))).toBe(false);
  });

  test("inherits posture, provenance and lineage across extracted Markdown and prepared plain text", async () => {
    const fixture = await createFixture(["--trust-tier", "neutral-reviewed", "--copyright-posture", "neutral-restricted"]);
    const first = await runExpertIngestCli(fixture.argv, stubbedDependencies());
    const descriptorPath = join(fixture.library, "candidates.json");
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    descriptor.candidates[0].metadata.title = "Synthetic reviewed title";
    descriptor.candidates[0].metadata.creator = "Synthetic author";
    descriptor.candidates[0].metadata.lineage.supersedes = [contentIdFromBytes(new TextEncoder().encode("prior synthetic source"))];
    await writeFile(descriptorPath, JSON.stringify(descriptor));
    const source = join(fixture.library, "reviewed.txt");
    await writeFile(source, NEUTRAL_EXTRACTION);
    const result = await runExpertIngestCli(["--prepared", "--source", source, "--library", fixture.library, "--corpus", "neutral-corpus"], { summarizePath: null, now: () => FIXED_INSTANT });
    expect(result.relativePath).toBe(first.relativePath);
    expect(result.alreadyStaged).toBe(true);
    const entry = await readCandidate(fixture.library, result.relativePath);
    expect(entry.metadata.trustTier).toBe("neutral-reviewed");
    expect(entry.metadata.copyrightPosture).toBe("neutral-restricted");
    expect(entry.metadata.title).toBe("Synthetic reviewed title");
    expect(entry.metadata.creator).toBe("Synthetic author");
    expect(entry.metadata.lineage).toEqual(descriptor.candidates[0].metadata.lineage);
    expect(entry.metadata.provenance).toEqual(descriptor.candidates[0].metadata.provenance);
    expect(entry.metadata.derivativeKind).toBe("extracted-text");
    expect(entry.metadata.sourceLocators).toEqual([source, NEUTRAL_SOURCE].sort());
    const intents = JSON.parse(await readFile(join(fixture.library, "corpus-intents.json"), "utf8"));
    expect(intents.intents).toEqual([{ objectId: first.objectId, corpusIds: ["neutral-corpus"] }]);
  });

  test("rejects binary, malformed UTF-8, empty and oversized files before staging", async () => {
    for (const bytes of [new Uint8Array([65, 0, 66]), new Uint8Array([0xc3, 0x28]), new Uint8Array(), new Uint8Array(33).fill(65)]) {
      const fixture = await createFixture();
      const source = join(fixture.library, "reviewed.txt");
      await writeFile(source, bytes);
      const attempts: ExtractionRequest[] = [];
      await expect(runExpertIngestCli(["--prepared", "--source", source, "--library", fixture.library], {
        summarizePath: null, extract: recordingExtractor(attempts), maxPreparedBytes: 32,
      })).rejects.toMatchObject({ code: bytes.length > 32 ? "prepared_source_too_large" : "prepared_source_invalid" });
      expect(attempts).toHaveLength(0);
      expect(await pathExists(join(fixture.library, "candidates.json"))).toBe(false);
    }
  });

  test("rejects remote, non-text, and credential-bearing locators", () => {
    for (const source of ["https://example.invalid/reviewed.md", "file:///neutral/reviewed.md", "//server/reviewed.md", "/neutral/source.pdf", "data:text/plain,source.md"]) {
      expect(() => parseExpertIngestArguments(["--prepared", "--source", source, "--library", "/neutral/library"])).toThrow("--prepared requires a local");
    }
    expect(() => parseExpertIngestArguments(["--prepared", "--source", "https://neutral:placeholder@example.invalid/reviewed.md", "--library", "/neutral/library"])).toThrow("embedded");
    expect(() => parseExpertIngestArguments(["--prepared", "--prepared", "--source", "/neutral/reviewed.md", "--library", "/neutral/library"])).toThrow("Duplicate argument: --prepared");
  });
});
