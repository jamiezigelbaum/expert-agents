/**
 * The ruled extraction engine, shared by every caller that turns a source
 * locator into text. The domain-expert worker's web import path (used by
 * `library_ingest` for URLs) spawns this binary with these extraction-only
 * arguments and this credential-stripped environment, so no caller can drift
 * into a second acquisition engine or into a paid extraction fallback.
 */

export const SUMMARIZE_BINARY = "summarize";
export const SUMMARIZE_INSTALL_COMMAND = "npm i -g @steipete/summarize";

// Extraction-only invocation: --extract prints the extracted content and exits,
// so no model is called and no provider credential is required. --plain and
// --no-color keep the captured bytes free of terminal rendering escapes.
export const EXTRACTION_ARGUMENTS: readonly string[] = ["--extract", "--format", "md", "--plain", "--no-color"];

/** How the extraction is named in provenance records and tool results. */
export const EXTRACTION_METHOD = "summarize --extract --format md";

// Credential-shaped variables never reach the extractor. The extraction path
// must not be able to reach a model, a transcription service, or a paid
// extraction fallback even when the operator's shell exports keys for them.
const CREDENTIAL_VARIABLE_PATTERN = /(?:^|_)(?:API_KEY|KEY|TOKEN|SECRET|SECRETS|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS)$/i;

// What a content extractor legitimately needs from a caller's environment: a
// search path, a home for its own config and caches, temporary space, locale,
// and trust roots. Nothing else is inherited.
//
// The name-shaped denylist above cannot be the only gate, because plenty of
// variables carry a credential without a credential-shaped name — GITHUB_PAT,
// DATABASE_URL, REDIS_URL, KUBECONFIG, NETRC, and any proxy URL with userinfo
// in it. Both extraction callers therefore start from this allowlist and apply
// the denylist on top of it.
export const EXTRACTION_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "NO_COLOR",
  "FORCE_COLOR",
  "YT_DLP_PATH",
];

// A page extraction is a fetch; a YouTube extraction may pull captions or media
// through summarize's own tooling. The bound is generous but finite, because an
// unbounded subprocess holds its caller open forever: the worker's batch in one
// lane, an operator's terminal — or a test run — in the other. Both lanes spawn
// the same binary, so both wait on it for the same length of time.
export const EXTRACTION_TIMEOUT_MS = 300_000;

// The extracted text is held in memory before it is hashed and staged, so an
// extractor that streams without end exhausts its caller instead of failing it.
// A timeout does not cover this: output can arrive fast and forever. The bound
// is generous — far larger than any single reference either lane stages — but
// finite, and it is one number because both lanes buffer the same binary's
// output. Only the enforcement mechanism differs (execFile's maxBuffer in the
// worker, an explicit read bound in the ingest CLI); the number does not.
export const EXTRACTION_MAX_OUTPUT_BYTES = 25 * 1024 * 1024;

export interface ExtractionRequest {
  binaryPath: string;
  source: string;
  args: readonly string[];
  env: Record<string, string>;
  /** Private cwd so extractor-local dotenv discovery cannot reload caller credentials. */
  workingDirectory: string;
  /** Wall-clock bound on the subprocess. Both live callers impose EXTRACTION_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Per-stream bound on captured output. Both live callers impose EXTRACTION_MAX_OUTPUT_BYTES. */
  maxOutputBytes?: number;
}

export interface ExtractionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ReferenceExtractor = (request: ExtractionRequest) => Promise<ExtractionResult>;

export interface ExtractionPrivateDirectories {
  home: string;
  cache: string;
  config: string;
  data: string;
  temp: string;
}

/** Keeps only the allowlisted names. Apply extractorEnvironment on top of it. */
export function allowlistedExtractionEnv(env: Record<string, string | undefined>): Record<string, string> {
  const allowed: Record<string, string> = {};
  for (const name of EXTRACTION_ENV_ALLOWLIST) {
    const value = env[name];
    if (value !== undefined) allowed[name] = value;
  }
  return allowed;
}

export function extractorEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || CREDENTIAL_VARIABLE_PATTERN.test(name)) continue;
    filtered[name] = value;
  }
  return filtered;
}

/**
 * Builds the extractor environment around caller-owned private directories.
 * Inherited HOME and XDG paths may be read-only service homes and may also
 * expose unrelated user configuration. Callers create and verify these paths
 * before spawning the extractor, then this function replaces every writable
 * or configuration-bearing inherited path while retaining the narrow shared
 * allowlist and credential-name strip.
 */
export function isolatedExtractorEnvironment(
  env: Record<string, string | undefined>,
  directories: ExtractionPrivateDirectories,
): Record<string, string> {
  return extractorEnvironment({
    ...allowlistedExtractionEnv(env),
    HOME: directories.home,
    XDG_CACHE_HOME: directories.cache,
    XDG_CONFIG_HOME: directories.config,
    XDG_DATA_HOME: directories.data,
    TMPDIR: directories.temp,
    TMP: directories.temp,
    TEMP: directories.temp,
  });
}

/**
 * A source locator that carries userinfo would be handed to the extractor in
 * child argv — world-readable on Linux through /proc — and then written into
 * the candidate descriptor as provenance. Callers refuse such a locator rather
 * than carrying the secret into either place.
 */
export function sourceLocatorCredential(source: string): string | undefined {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  if (url.username.length > 0) return "username";
  if (url.password.length > 0) return "password";
  return undefined;
}

export function normalizeExtractedText(stdout: string): string {
  const byteOrderMark = String.fromCharCode(0xfeff);
  const withoutByteOrderMark = stdout.startsWith(byteOrderMark) ? stdout.slice(1) : stdout;
  const trimmed = withoutByteOrderMark.replace(/\s+$/u, "");
  return trimmed.length === 0 ? "" : `${trimmed}\n`;
}

/** The extractor's own first word on a failure, so the caller never invents one. */
export function firstDiagnosticLine(stderr: string): string {
  const line = stderr.split("\n").map((value) => value.trim()).find((value) => value.length > 0);
  return line === undefined ? "no diagnostic output" : line.slice(0, 200);
}

// A YouTube URL is extracted with --json so the caller can see where the text
// came from. In plain mode the extractor exits 0 and prints the video's
// description when no transcript exists, which reads like a transcript; the
// JSON record names its transcript source instead (`captionTracks`,
// `youtubei`, `yt-dlp`, ... or `unavailable`). Checked against summarize 0.21.7.
export const YOUTUBE_EXTRACTION_ARGUMENTS: readonly string[] = [...EXTRACTION_ARGUMENTS, "--json"];

// Markers of a YouTube watch page's own script and player bootstrap. None of
// them occurs in spoken captions, so text carrying one is page code, not a
// transcript, whatever the extractor reported about it.
const WATCH_PAGE_SCRIPT_MARKERS: readonly RegExp[] = [
  /\bytcfg\.set\s*\(/,
  /\bytInitialPlayerResponse\s*=/,
  /\bytInitialData\s*=/,
  /\bwindow\.ytplayer\b/,
  /\bytplayer\.(?:config|web_player_context_config)\b/,
  /\byt\.setConfig\s*\(/,
];

export function looksLikeWatchPageScript(text: string): boolean {
  return WATCH_PAGE_SCRIPT_MARKERS.some((marker) => marker.test(text));
}

export type YoutubeTranscriptExtraction =
  | { ok: true; text: string; transcriptSource: string; title?: string }
  | {
    ok: false;
    code: "youtube_extraction_unreadable" | "youtube_transcript_unavailable" | "youtube_transcript_page_script";
    reason: string;
  };

/**
 * Reads the extractor's --json record for a YouTube URL and keeps the text only
 * when it is a transcript: a named transcript source, transcript characters,
 * and none of the watch page's script. Reasons carry no extracted content.
 */
export function parseYoutubeTranscriptExtraction(stdout: string): YoutubeTranscriptExtraction {
  let record: unknown;
  try {
    record = JSON.parse(stdout);
  } catch {
    return { ok: false, code: "youtube_extraction_unreadable", reason: "the extractor did not return its JSON record" };
  }
  const extracted = isPlainRecord(record) && isPlainRecord(record.extracted) ? record.extracted : undefined;
  if (!extracted) {
    return { ok: false, code: "youtube_extraction_unreadable", reason: "the extractor's JSON record has no extracted content" };
  }
  const source = typeof extracted.transcriptSource === "string" ? extracted.transcriptSource.trim() : "";
  const transcriptCharacters = typeof extracted.transcriptCharacters === "number" ? extracted.transcriptCharacters : 0;
  if (source === "" || source === "unavailable" || transcriptCharacters <= 0) {
    const metadata = isPlainRecord(extracted.transcriptMetadata) ? extracted.transcriptMetadata : undefined;
    const why = typeof metadata?.reason === "string" && /^[a-z0-9_]{1,64}$/i.test(metadata.reason)
      ? metadata.reason
      : "no transcript source";
    return { ok: false, code: "youtube_transcript_unavailable", reason: `no transcript was obtained (${why})` };
  }
  const text = normalizeExtractedText(typeof extracted.content === "string" ? extracted.content : "");
  if (text.length === 0) {
    return { ok: false, code: "youtube_transcript_unavailable", reason: `the ${source} transcript was empty` };
  }
  if (looksLikeWatchPageScript(text)) {
    return {
      ok: false,
      code: "youtube_transcript_page_script",
      reason: `the text reported as a ${source} transcript is YouTube watch-page script`,
    };
  }
  const title = typeof extracted.title === "string" && extracted.title.trim() !== "" ? extracted.title.trim() : undefined;
  return { ok: true, text, transcriptSource: source, ...(title ? { title } : {}) };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
