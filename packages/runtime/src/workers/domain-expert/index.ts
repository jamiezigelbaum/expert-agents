import { execFile } from 'node:child_process';
import { createHash, createSign, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { lstatSync, mkdirSync, statSync } from 'node:fs';
import { appendFile, chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { constants as zlibConstants, inflateSync } from 'node:zlib';
import {
  ANNAS_ARCHIVE_FORMATS,
  DOMAIN_ASK_RETRIEVAL_DEFAULTS,
  DOMAIN_DOC_ACTIONS,
  DOMAIN_SOURCE_ACTIONS,
  DOMAIN_SOURCE_KINDS,
  NO_TARGET_CORPUS_REASON,
  RAG_CORPUS_ACTIONS,
  WEB_IMPORT_TRANSCRIPT_MODE_EFFECT,
  WEB_IMPORT_TRANSCRIPT_MODE_NOTE,
  optionalWebImportTranscriptMode,
  domainManifest,
  domainPolicy,
  domainWorkspaceSeedFiles,
  parseDomainAgentAction,
  parseDomainDocAction,
  parseDomainSourceAction,
  parseRagCorpusAction,
  planAnnasArchiveImport,
  planAnnasArchiveSearch,
  planDomainAgent,
  planDomainAsk,
  planDomainDoc,
  planDomainSource,
  planRagCorpus,
  configuredCorpusId,
  requireConfiguredAgent,
  resolveTargetCorpus,
} from '../../core/domain-expert.ts';
import type {
  AnnasArchiveFormat,
  AnnasArchiveImportParams,
  AnnasArchiveSearchParams,
  DomainAgentParams,
  DomainDocParams,
  DomainSourceParams,
  DomainAskReranker,
  RagCorpusParams,
} from '../../core/domain-expert.ts';
import { vertexImportOperationCandidate, vertexImportSubmissionReceipt } from '../../core/vertex-import-submission.ts';
import { AgentRegistrationStore, registrationLibraryFromEnv } from '../../core/agent-registration.ts';
import { replaceDurably, writeExclusiveDurably } from '../../core/durable-file.ts';
import { loadRetrievalPreferenceFile } from '../../core/retrieval-preference-file.ts';
import { OperationError } from '../../core/operation-error.ts';
import { DOMAIN_EXPERT_ENV_EXAMPLE } from '../../core/connect-gcp.ts';
import {
  applyRetrievalPreferences,
  type RetrievalPreferenceMode,
  AGENT_REPO_GITIGNORE,
  EXTRACTION_ARGUMENTS,
  EXTRACTION_MAX_OUTPUT_BYTES,
  EXTRACTION_METHOD,
  EXTRACTION_TIMEOUT_MS,
  MATERIALIZATION_LEDGER_SCHEMA_VERSION,
  SUMMARIZE_BINARY,
  SUMMARIZE_INSTALL_COMMAND,
  allowlistedExtractionEnv,
  canonicalJson,
  firstDiagnosticLine,
  isolatedExtractorEnvironment,
  llmParserEligibleUris,
  EbookConversionError,
  convertEpubToMarkdown,
  plainTextToMarkdown,
  xhtmlToMarkdown,
  normalizeExtractedText,
  parseMasterManifest,
  parseScopeManifest,
  planReconciliation,
  ragIngestionConfig,
  resolveRagParserModel,
  validatedVertexOperationName,
  type ExtractionRequest,
  type ExtractionResult,
  type MaterializationLedger,
  type ReferenceExtractor,
  type Sha256Id,
  type LibraryLocationConfig,
} from '@expert-agents/library';
import {
  agentRoutingConfigFromEnv,
  type AgentRoutingConfig,
} from '../../core/agent-routing.ts';
import {
  DISCLOSURE_REFUSAL_CODES,
  DisclosureSessionStore,
  discloseExcerpts,
  disclosureRefusal,
  partitionCorporaByDisclosure,
  resolveDisclosurePolicy,
  type DisclosureExcerptCandidate,
  type DisclosurePolicy,
  type DisclosureRefusal,
  type DisclosureRefusalCode,
  type DisclosureSessionLedger,
  type DisclosureSummary,
} from '../../core/disclosure.ts';
import { completePassageSentences, completionSourceObject, SourceTextCache } from './passage-completion.ts';

export const DOMAIN_EXPERT_NOTION_CREDENTIAL_GUIDANCE = `notion_import requires EXPERT_AGENTS_DOMAIN_EXPERT_NOTION_TOKEN. Configure it as documented in ${DOMAIN_EXPERT_ENV_EXAMPLE}.`;

export interface DomainExpertWorkspaceRootPolicy {
  rootId: string;
  path: string;
  maxWriteBytes: number;
  auditPath?: string;
  allowOverwrite: boolean;
}

export interface GoogleServiceAccountCredential {
  client_email: string;
  private_key: string;
  token_uri?: string;
  project_id?: string;
}

export interface DomainExpertGoogleConfig {
  accessToken?: string;
  serviceAccountJson?: string;
  serviceAccountJsonPath?: string;
  // Attached-identity mode for a Google Compute Engine VM or a container on
  // one: tokens come from the instance metadata server, so no key material is
  // ever provisioned. Consulted only when no explicit token or service-account
  // JSON is configured.
  metadataServerToken?: boolean;
  scopes?: string[];
  model?: string;
  // Location that serves generateContent. Current Gemini models are served
  // from `global` only, so generation no longer follows the corpus location.
  generateLocation?: string;
  transcribeModel?: string;
  retrievalTopK?: number;
  answerContextLimit?: number;
  reranker?: DomainExpertReranker;
  rerankerModel?: string;
  // Parser model for RAG imports: unset selects the default LLM parser model,
  // the literal 'default' disables the parser. See resolveRagParserModel.
  ragParserModel?: string;
  multiQuery?: boolean;
  fetchImpl?: typeof fetch;
}

export type DomainExpertReranker = DomainAskReranker;
export type DomainAskOutput = 'answer' | 'passages';

type GoogleConfigurationStatus = 'ready' | 'unreadable' | 'not_configured';

export interface DomainExpertAnnasConfig {
  apiKey?: string;
  baseUrl?: string;
  searchUrlTemplate?: string;
  /** Library Genesis (libgen.li family) origin used for search only when Anna Archive search fails. */
  libgenBaseUrl?: string;
  downloadUrlTemplate?: string;
  importGcsPrefix?: string;
  booksRoot?: string;
  maxDownloadBytes?: number;
  // Page floor a measured PDF has to clear before it may be ingested. 0 disables
  // the gate; artifacts whose scale cannot be measured are never blocked by it.
  minPdfPages?: number;
  // Opt-in: resolve downloads through the member fast-download API on baseUrl instead of
  // the download URL template. Only correct when baseUrl is a real Anna Archive origin.
  fastDownload?: boolean;
  // djvulibre's text extractor, looked up on PATH; a DJVU ingest is refused when absent.
  djvutxtBin?: string;
  // How often the worker re-reads a submitted import operation, and how long it
  // waits in total (submission backoff plus polling) before reporting
  // import_requested with the operation name instead of a verified outcome.
  importPollIntervalMs?: number;
  importPollTimeoutMs?: number;
}

export interface DomainExpertNotionConfig {
  token?: string;
  notionVersion?: string;
  maxObjects?: number;
  fetchImpl?: typeof fetch;
}

export interface DomainExpertWorkerOptions {
  registrationLibrary?: LibraryLocationConfig;
  roots?: DomainExpertWorkspaceRootPolicy[];
  agentRouting?: AgentRoutingConfig;
  gcpProject?: string;
  google?: DomainExpertGoogleConfig;
  annas?: DomainExpertAnnasConfig;
  notion?: DomainExpertNotionConfig;
  dataDir?: string;
  fetchImpl?: typeof fetch;
  webImportFetchImpl?: WebImportFetchImpl;
  webImportFetchTimeoutMs?: number;
  annasDownloadTimeoutMs?: number;
  resolveHostImpl?: ResolveHostImpl;
  /**
   * Path handed to summarize as YT_DLP_PATH. The worker no longer drives
   * yt-dlp itself; it stays configurable because yt-dlp remains summarize's
   * media dependency and deployments pin it outside PATH.
   */
  ytDlpBin?: string;
  summarizeBin?: string;
  summarizeExtract?: ReferenceExtractor;
  basePath?: string;
}

type ResolveHostImpl = (hostname: string) => Promise<string[]>;
type WebImportFetchImpl = (url: URL, options: {
  signal: AbortSignal;
  validatedAddresses: readonly string[];
}) => Promise<Response>;

type DomainExpertTool =
  | 'domain_agent'
  | 'domain_ask'
  | 'domain_source'
  | 'rag_corpus'
  | 'domain_doc'
  | 'annas_archive_search'
  | 'annas_archive_import';

interface DomainExpertRequest {
  tool: DomainExpertTool;
  params: Record<string, unknown>;
}

interface DomainAskRequestParams {
  retrievalMode?: RetrievalPreferenceMode;
  /**
   * `answer` (default) synthesizes a cited answer with the configured Google
   * model. `passages` stops after retrieval, reranking and fusion and returns
   * the named passages so the caller's own model writes from them — the mode
   * public expert providers use so the library is read exactly once.
   * A passage the chunker cut mid-sentence is completed to whole sentences
   * from its source text when the worker can read it (`completed: true`;
   * at most 600 characters per end, never past 6,000 UTF-8 bytes).
   */
  output?: DomainAskOutput;
  domainId?: string;
  question: string;
  corpusId?: string;
  corpora?: string[];
  maxResults?: number;
  /**
   * Session identity is an input. It is only consulted when the agent
   * declares a disclosure posture, and it is what makes the cumulative
   * per-source bound meaningful across a hire.
   */
  sessionId?: string;
}

/** Per-request disclosure state. Only built when a posture is declared. */
interface DomainAskDisclosure {
  policy: DisclosurePolicy;
  ledger: DisclosureSessionLedger;
  corpora: string[];
  withheldCorpusCount: number;
  summary: DisclosureSummary;
}

interface VisualEditLedgerRecord {
  kind: 'domain_doc_visual_edit';
  edit_batch_id: string;
  domain_id: string;
  document_id: string;
  action: 'visual_insert' | 'visual_replace';
  inserted_text: string;
  inserted_start_index: number;
  inserted_end_index: number;
  prior_text?: string;
  created_at: string;
  approval_id?: string;
}

interface RagCorpusMappingRecord {
  display_name: string;
  corpus_id: string;
  resource_name: string;
  project: string;
  location: string;
  updated_at: string;
}

interface RagCorpusMappingFile {
  version: 1;
  corpora: Record<string, RagCorpusMappingRecord>;
}

interface DomainSourceRegistryRecord {
  record: Record<string, unknown>;
  sourceId: string;
  registeredAt?: string;
  fileOrder: number;
  removed: boolean;
}

interface DomainSourceRegistryRead {
  records: DomainSourceRegistryRecord[];
  totalRecords: number;
  malformedLines: number;
  missing: boolean;
}

interface ResolvedRagCorpus {
  requested: string;
  corpusId: string;
  resourceName: string;
  displayName?: string;
  warnings?: RagCorpusWarning[];
}

interface ParsedRagCorpusResourceName {
  project: string;
  location: string;
  corpusId: string;
}

interface ParsedRagFileResourceName extends ParsedRagCorpusResourceName {
  fileId: string;
}

interface RagCorpusNotFoundWarning {
  corpus_id: string;
  code: 'rag_corpus_not_found';
  message: string;
  suggestion: string;
}

interface RagCorpusDuplicateDisplayNameWarning {
  corpus_id: string;
  code: 'rag_corpus_duplicate_display_name';
  message: string;
  display_name: string;
  selected_resource_name: string;
  duplicate_resource_names: string[];
  selection_order: string;
}

interface RagCorpusMappingFileWarning {
  code: 'rag_corpus_mapping_file_unreadable';
  message: string;
  mapping_file: string;
}

interface RagRetrievalQueryFailedWarning {
  kind: 'rag_retrieval_query_failed';
  corpus_id: string;
}

type RagCorpusWarning = RagCorpusNotFoundWarning
  | RagCorpusDuplicateDisplayNameWarning
  | RagCorpusMappingFileWarning
  | RagRetrievalQueryFailedWarning;

interface StageImportEligibleFile {
  workspaceRelativePath: string;
  uploadRelativePath: string;
  absolutePath: string;
  bytes: number;
  objectName: string;
  gcsUri: string;
}

interface StageImportSkippedFile {
  workspace_relative_path: string;
  reason: string;
  bytes?: number;
}

interface WebImportFetchResult {
  url: string;
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

interface WebImportHandlerContext {
  sourceUrl: string;
  finalUrl: string;
  sourceProvenanceUrl: string;
  finalProvenanceUrl: string;
  response: WebImportFetchResult;
  includeMedia: boolean;
  transcriptMode: 'auto' | 'captions' | 'asr';
  dryRun: boolean;
  fetchedAt: string;
  fetch: (url: string) => Promise<WebImportFetchResult>;
  extraction: ExtractionRuntimeContext;
}

interface WebImportDerivedFile {
  sourceUrl: string;
  finalUrl: string;
  kind: string;
  fileName: string;
  bytes: Uint8Array;
  warnings?: string[];
}

interface WebImportUrlError {
  source_url: string;
  final_url?: string;
  handler?: string;
  code: string;
  message: string;
  suggestion?: string;
  stderr_tail?: string;
}

interface WebImportHandlerResult {
  files: WebImportDerivedFile[];
  errors?: WebImportUrlError[];
  plan?: Record<string, unknown>;
}

export interface WebImportHandler {
  id: string;
  detect(context: WebImportHandlerContext): boolean;
  derive(context: WebImportHandlerContext): Promise<WebImportHandlerResult>;
}

/** Everything web_import needs to reach the owner's ruled extraction engine. */
interface ExtractionRuntimeContext {
  binaryPath: string;
  dataDir: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  extract: ReferenceExtractor;
}

interface NotionImportObjectPlan {
  object_id: string;
  object_type: 'page' | 'database';
  title: string;
  source_url?: string;
  child_block_count?: number;
  row_page_count?: number;
  workspace_relative_path?: string;
  warnings?: string[];
}

const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/devstorage.read_write',
];

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Compute Engine instance metadata server. Only the attached identity can
// answer here, so the URL is fixed: it is never configuration.
const GOOGLE_METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const GOOGLE_METADATA_PROBE_TIMEOUT_MS = 3_000;

function isHttpsUrl(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('https://');
}
const STAGE_IMPORT_ALLOWED_EXTENSIONS = new Set(['.md', '.txt', '.pdf', '.html']);
const STAGE_IMPORT_MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.mp4', '.mov', '.webm']);
const STAGE_IMPORT_TRANSCRIBABLE_MEDIA_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.mp4', '.mov', '.webm']);
const STAGE_IMPORT_MAX_FILE_BYTES = 10_000_000;
const PDF_PROCESSING_MAX_BYTES = 100_000_000;
const STAGE_IMPORT_MAX_BATCH_BYTES = 100 * 1024 * 1024;
const MEDIA_TRANSCRIBE_MAX_BYTES = 200 * 1024 * 1024;
// An ambiguous octet-stream has to be read before PDF magic can resolve its
// format, so the guarded fetch admits one complete immediately-processable PDF.
// Non-PDF processing remains subject to the smaller format-aware limit below.
const WEB_IMPORT_MAX_FETCH_BYTES = PDF_PROCESSING_MAX_BYTES;
const WEB_IMPORT_MAX_BATCH_BYTES = 100 * 1024 * 1024;
const WEB_IMPORT_MAX_FETCHES = 250;
const WEB_IMPORT_MAX_REDIRECTS = 10;
const WEB_IMPORT_FETCH_TIMEOUT_MS = 15_000;
// The bound is the extraction contract's, shared with the ingest CLI so neither
// lane can drift into waiting on the same binary for a different length of time.
const SUMMARIZE_EXTRACT_TIMEOUT_MS = EXTRACTION_TIMEOUT_MS;
// Likewise the output bound: shared with the ingest CLI so neither lane can
// drift into buffering more of the same binary's output than the other.
const SUMMARIZE_EXTRACT_MAX_OUTPUT_BYTES = EXTRACTION_MAX_OUTPUT_BYTES;
const WEB_IMPORT_SHORT_EXTRACTION_CHARACTERS = 200;
const WEB_IMPORT_WORKER_FETCHER = 'domain-expert-worker';
// Pages are converted in-process from the bytes the worker already fetched, so
// their provenance names the local converter instead of the summarize
// subprocess that only YouTube URLs reach.
const WEB_IMPORT_LOCAL_HTML_EXTRACTOR = 'html-to-markdown';
const ANNAS_ARCHIVE_DOWNLOAD_TIMEOUT_MS = 15_000;
const ANNAS_ARCHIVE_REQUEST_TIMEOUT_MS = 15_000;
const ANNAS_ARCHIVE_MAX_REDIRECTS = 5;
const GOOGLE_API_REQUEST_TIMEOUT_MS = 30_000;
// Answer synthesis and media transcription are long generateContent calls: a
// thinking model routinely runs past the metadata deadline (live 504 on
// 2026-07-31 minutes after the 30s cap shipped), and the gateway allows 300s
// per tool call — 180s leaves headroom for the retrieval time already spent.
const GOOGLE_LONG_GENERATION_TIMEOUT_MS = 180_000;
const UPSTREAM_JSON_MAX_BYTES = 8 * 1024 * 1024;
const UPSTREAM_HTML_MAX_BYTES = 4 * 1024 * 1024;
const UPSTREAM_ERROR_TEXT_MAX_CHARACTERS = 2_000;
const ANNAS_CANDIDATE_STRING_MAX_CHARACTERS = 1_000;
const VERTEX_MAX_PAGES = 100;
const DEFAULT_ANNAS_ARCHIVE_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const DEFAULT_ANNAS_BOOKS_ROOT = join(homedir(), 'ExpertAgents', 'Books');
// Book-scale floor. The 2026-07-29 impostor was a 36-page pamphlet wearing a
// 512-page monograph's metadata; genuine monographs run well past 200 pages, so
// 60 catches the pamphlet class with margin while clearing legitimately short
// books. A configured 0 disables the gate.
const DEFAULT_ANNAS_MIN_PDF_PAGES = 60;
const DEFAULT_ANNAS_DJVUTXT_BIN = 'djvutxt';
const ANNAS_DJVUTXT_TIMEOUT_MS = 120_000;
const ANNAS_DJVUTXT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
// Vertex import operations on a single book finish in well under a minute when
// the corpus is idle; the 2026-09-20 batch queued behind each other for several
// minutes. Ten minutes covers a queued single-file import without letting a
// tool call hang indefinitely.
const DEFAULT_ANNAS_IMPORT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_ANNAS_IMPORT_POLL_TIMEOUT_MS = 600_000;
const ANNAS_IMPORT_BACKOFF_MAX_MS = 60_000;
// Formats Vertex RAG Engine parses natively (as uploaded), and the ebook
// formats the worker converts to Markdown before upload. Anything else is a
// typed refusal that leaves the download on disk.
const ANNAS_NATIVE_INGEST_FORMATS = new Set(['pdf']);
const ANNAS_CONVERTIBLE_INGEST_FORMATS = new Set(['epub', 'djvu']);
// Every bound below exists because the measured bytes are attacker-supplied: the
// measurement may give up, but it must never hang, allocate without bound, or
// throw out of the ingest gate.
const ANNAS_PDF_HEADER_WINDOW_BYTES = 1024;
const ANNAS_PDF_MAX_PAGE_HITS = 250_000;
const ANNAS_PDF_MAX_COUNT_PROBES = 512;
const ANNAS_PDF_PAGE_TREE_WINDOW_BYTES = 16 * 1024;
const ANNAS_PDF_STREAM_HEADER_WINDOW_BYTES = 4 * 1024;
const ANNAS_PDF_MAX_INFLATE_STREAMS = 48;
const ANNAS_PDF_MAX_STREAM_INPUT_BYTES = 2 * 1024 * 1024;
const ANNAS_PDF_MAX_STREAM_OUTPUT_BYTES = 2 * 1024 * 1024;
const ANNAS_PDF_MAX_TOTAL_INFLATED_BYTES = 4 * 1024 * 1024;
const ANNAS_ZIP_EOCD_SIGNATURE = 0x06054b50;
const ANNAS_ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ANNAS_ZIP_CENTRAL_HEADER_BYTES = 46;
const ANNAS_ZIP_EOCD_MIN_BYTES = 22;
const ANNAS_ZIP_EOCD_SEARCH_BYTES = 64 * 1024;
const ANNAS_ZIP_MAX_ENTRIES = 4096;
const ANNAS_EPUB_TEXT_DOCUMENT = /\.(?:x?html?|xml)$/;
// Same-title size outliers: how many times smaller than the median edition a
// candidate has to be before the rationale says so.
const ANNAS_SIZE_OUTLIER_FACTOR = 5;
const ANNAS_AUDIT_FILE = '.expert-agents-annas-audit.jsonl';
const ANNAS_FAST_DOWNLOAD_PATH = '/dyn/api/fast_download.json';
const ANNAS_REDACTED = 'redacted';
const ANNAS_SEARCH_RECORD_LIMIT = 100;
const LIBGEN_SEARCH_PAGE_SIZE = 25;
const LIBGEN_SEARCH_TIMEOUT_MS = 30_000;
const LIBGEN_ROW = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const LIBGEN_CELL = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
const LIBGEN_MD5 = /md5=([0-9a-f]{32})/i;
// The tooltip attribute before href can hold "<br>", so the attribute span is matched lazily across tags.
const LIBGEN_TITLE_ANCHOR = /<a\b[\s\S]*?href="edition\.php\?id=\d+"[^>]*>([\s\S]*?)<\/a>/i;
const LIBGEN_SIZE = /^([\d.]+)\s*(KB|MB|GB)$/i;
const ANNAS_MD5_VALUE = /^[0-9a-f]{32}$/;
const ANNAS_RECORD_MD5_PATH = /\/md5\/([0-9a-f]{32})/i;
const ANNAS_CREDENTIAL_QUERY_PARAMETER = /^(?:key|api[_-]?key|access[_-]?token|token|signature|x-amz-.+)$/i;
// Search-page shapes. The /md5/<hash> href is the stable anchor for a result; the cover
// link wraps markup while the title link wraps plain text, so requiring a text-only body
// selects the title link without depending on the presentational class names around it.
const ANNAS_PARTIAL_MATCHES_MARKER = 'js-partial-matches';
const ANNAS_MD5_HREF = /href="[^"]*\/md5\/[0-9a-f]{32}"/gi;
const ANNAS_TITLE_ANCHOR = /<a\s[^>]*href="[^"]*\/md5\/([0-9a-f]{32})"[^>]*>([^<]+)<\/a>/gi;
const ANNAS_AUTHOR_ANCHOR = /icon-\[mdi--user-edit\][^>]*>[^<]*<\/span>([^<]+)<\/a>/i;
const ANNAS_METADATA_SEPARATOR = '·';
const ANNAS_METADATA_TEXT = />([^<>]*·[^<>]*)</;
const ANNAS_SIZE_PIECE = /^([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB)$/i;
const ANNAS_YEAR_PIECE = /^(?:1[5-9][0-9]{2}|20[0-9]{2})$/;
const ANNAS_LANGUAGE_PIECE = /\[[a-z]{2,3}(?:-[a-z0-9]{2,4})?\]/i;
const ANNAS_SIZE_MULTIPLIER: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
const NOTION_BASE_URL = 'https://api.notion.com/v1';
const NOTION_DEFAULT_VERSION = '2022-06-28';
const NOTION_DEFAULT_MAX_OBJECTS = 200;
const NOTION_DEFAULT_DEPTH = 6;
const NOTION_MAX_RETRIES = 3;
const DOMAIN_RRF_K = 60;
// Answer synthesis can carry at most 24 bounded context excerpts in one prompt.
const DOMAIN_ANSWER_SYNTHESIS_CONTEXT_CAP = 24;
// Memory bound on retained session ledgers, not a policy value. Eviction is
// least-recently-used; the disclosure bounds themselves live in configuration.
const DISCLOSURE_SESSION_CACHE_LIMIT = 1_000;
const DISCLOSURE_SESSION_ID_MAX_LENGTH = 200;

export class DomainExpertWorkerError extends Error {
  status: number;
  code: string;
  suggestion?: string;
  stderrTail?: string;
  googleErrorBody?: unknown;

  constructor(status: number, code: string, message: string, suggestion?: string) {
    super(message);
    this.status = status;
    this.code = code;
    if (suggestion !== undefined) this.suggestion = suggestion;
  }
}

function currentUid(): number {
  return process.getuid?.() ?? userInfo().uid;
}

function ensurePrivateDataDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  const uid = currentUid();
  if (!info.isDirectory()) {
    throw new DomainExpertWorkerError(500, 'insecure_data_dir', `Domain expert dataDir is not a directory: ${path}`);
  }
  if (info.uid !== uid) {
    throw new DomainExpertWorkerError(500, 'insecure_data_dir', `Domain expert dataDir must be owned by uid ${uid}: ${path}`);
  }
  if ((info.mode & 0o022) !== 0) {
    throw new DomainExpertWorkerError(500, 'insecure_data_dir', `Domain expert dataDir must not be group- or world-writable: ${path}`);
  }
}

function ensurePrivateExtractionDirectories(root: string): {
  home: string;
  cache: string;
  config: string;
  data: string;
  temp: string;
} {
  const directories = {
    home: join(root, 'home'),
    cache: join(root, 'cache'),
    config: join(root, 'config'),
    data: join(root, 'data'),
    temp: join(root, 'tmp'),
  };
  for (const path of [root, ...Object.values(directories)]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== currentUid() || (info.mode & 0o077) !== 0) {
      throw new DomainExpertWorkerError(
        500,
        'insecure_extraction_directory',
        'Domain expert extraction directories must be private, worker-owned directories without symlinks.',
      );
    }
  }
  return directories;
}

class UpstreamResponseSizeLimitError extends DomainExpertWorkerError {
  constructor(contentKind: 'JSON' | 'HTML', maxBytes: number) {
    super(
      502,
      'upstream_response_size_limit_exceeded',
      `Upstream ${contentKind} response exceeded the ${maxBytes} byte limit.`,
    );
    this.name = 'UpstreamResponseSizeLimitError';
  }
}

class VertexPaginationError extends DomainExpertWorkerError {
  constructor(reason: 'page cap reached' | 'repeated nextPageToken') {
    super(
      502,
      'google_api_error',
      `Vertex pagination violated the ${VERTEX_MAX_PAGES}-page cap (${reason}).`,
    );
    this.name = 'VertexPaginationError';
  }
}

interface UpstreamResponseContext {
  signal: AbortSignal;
  timeoutError: () => DomainExpertWorkerError;
  sensitiveValues: string[];
}

const upstreamResponseContexts = new WeakMap<Response, UpstreamResponseContext>();

export class DomainExpertService {
  private roots: Map<string, DomainExpertWorkspaceRootPolicy>;
  private agentRouting: AgentRoutingConfig;
  private registrations: AgentRegistrationStore;
  private corpusEnsureQueue: Promise<unknown> = Promise.resolve();
  private gcpProject: string;
  private google: GoogleRuntimeClient;
  private annas: DomainExpertAnnasConfig;
  private annasBooksRoot: string;
  private annasMaxDownloadBytes: number;
  private annasMinPdfPages: number;
  private annasDjvutxtBin: string;
  private annasImportPollIntervalMs: number;
  private annasImportPollTimeoutMs: number;
  private notion: NotionRuntimeClient;
  private dataDir: string;
  private fetchImpl: typeof fetch;
  private webImportFetchImpl: WebImportFetchImpl;
  private webImportFetchTimeoutMs: number;
  private annasDownloadTimeoutMs: number;
  private resolveHostImpl: ResolveHostImpl;
  private ytDlpBin?: string;
  private summarizeBin: string;
  private summarizeExtract: ReferenceExtractor;
  private ragCorpusCache = new Map<string, ResolvedRagCorpus>();
  private ragCorpusListCache = new Map<string, Array<{ name: string; displayName?: string }>>();
  private ragCorpusMapping?: RagCorpusMappingFile;
  private ragCorpusMappingQueue: Promise<unknown> = Promise.resolve();
  private ragCorpusMappingWarnings: RagCorpusMappingFileWarning[] = [];
  private ragCorpusProjectAliases = new Map<string, Set<string>>();
  private registryAppendQueue: Promise<unknown> = Promise.resolve();
  private libraryManifestCache = new Map<string, LibraryManifestIndex>();
  private sourceTexts = new SourceTextCache(PASSAGE_SOURCE_CACHE_MAX_CHARS, PASSAGE_SOURCE_MISS_TTL_MS);
  private disclosureSessions = new DisclosureSessionStore(DISCLOSURE_SESSION_CACHE_LIMIT);

  constructor(options: DomainExpertWorkerOptions = {}) {
    this.roots = new Map((options.roots ?? []).map((root) => [root.rootId, normalizeRoot(root)]));
    this.agentRouting = options.agentRouting ?? agentRoutingConfigFromEnv();
    this.gcpProject = options.gcpProject?.trim()
      || process.env.EXPERT_AGENTS_GCP_PROJECT?.trim()
      || '';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webImportFetchImpl = options.webImportFetchImpl
      ?? (options.fetchImpl ? webImportFetchFromFetchImpl(options.fetchImpl) : defaultWebImportFetch);
    this.webImportFetchTimeoutMs = normalizePositiveInteger(options.webImportFetchTimeoutMs, WEB_IMPORT_FETCH_TIMEOUT_MS);
    this.annasDownloadTimeoutMs = normalizePositiveInteger(options.annasDownloadTimeoutMs, ANNAS_ARCHIVE_DOWNLOAD_TIMEOUT_MS);
    this.google = new GoogleRuntimeClient({
      ...(options.google ?? {}),
      fetchImpl: options.google?.fetchImpl ?? options.fetchImpl ?? fetch,
    });
    this.annas = options.annas ?? {};
    this.annasBooksRoot = options.annas?.booksRoot ?? DEFAULT_ANNAS_BOOKS_ROOT;
    this.annasMaxDownloadBytes = normalizePositiveInteger(options.annas?.maxDownloadBytes, DEFAULT_ANNAS_ARCHIVE_MAX_DOWNLOAD_BYTES);
    this.annasMinPdfPages = normalizeNonNegativeInteger(options.annas?.minPdfPages, DEFAULT_ANNAS_MIN_PDF_PAGES);
    this.annasDjvutxtBin = options.annas?.djvutxtBin?.trim() || DEFAULT_ANNAS_DJVUTXT_BIN;
    this.annasImportPollIntervalMs = normalizePositiveInteger(options.annas?.importPollIntervalMs, DEFAULT_ANNAS_IMPORT_POLL_INTERVAL_MS);
    this.annasImportPollTimeoutMs = normalizeNonNegativeInteger(options.annas?.importPollTimeoutMs, DEFAULT_ANNAS_IMPORT_POLL_TIMEOUT_MS);
    this.notion = new NotionRuntimeClient({
      ...(options.notion ?? {}),
      fetchImpl: options.notion?.fetchImpl ?? options.fetchImpl ?? fetch,
    });
    this.dataDir = options.dataDir ?? join(tmpdir(), `expert-agents-domain-expert-${currentUid()}`);
    ensurePrivateDataDirectory(this.dataDir);
    this.registrations = new AgentRegistrationStore(this.dataDir, this.agentRouting, options.registrationLibrary ?? registrationLibraryFromEnv());
    this.agentRouting = this.registrations.routes();
    this.resolveHostImpl = options.resolveHostImpl ?? defaultResolveHost;
    // Only a configured path is forwarded: an unset value leaves summarize to
    // resolve yt-dlp the way it normally does.
    this.ytDlpBin = options.ytDlpBin?.trim() || process.env.EXPERT_AGENTS_DOMAIN_EXPERT_YTDLP_BIN?.trim() || undefined;
    this.summarizeBin = options.summarizeBin?.trim()
      || process.env.EXPERT_AGENTS_DOMAIN_EXPERT_SUMMARIZE_BIN?.trim()
      || SUMMARIZE_BINARY;
    this.summarizeExtract = options.summarizeExtract ?? defaultSummarizeExtract;
  }

  async health(): Promise<Record<string, unknown>> {
    const credentialStatus = await this.google.configurationStatus();
    const projectReady = isConfiguredGoogleProject(this.gcpProject);
    const googleStatus = credentialStatus === 'ready' && !projectReady ? 'project_not_configured' : credentialStatus;
    // Same predicate as the import path's runtime gate (annasDownloadPlan):
    // config presence alone once reported true while every import 503'd on a
    // directory that sat outside the unit's writable sandbox.
    const booksRootInfo = this.annasBooksRoot ? await stat(resolve(this.annasBooksRoot)).catch(() => undefined) : undefined;
    return {
      kind: 'domain_expert_health',
      reachable: true,
      configured: {
        workspace_roots: this.roots.size,
        agent_routes: Object.keys(this.agentRouting).length,
        google: googleStatus === 'ready',
        annas_archive: Boolean(this.annas.apiKey && (this.annas.searchUrlTemplate || this.annas.baseUrl)),
        libgen_fallback: Boolean(this.annas.libgenBaseUrl),
        annas_archive_fast_download: Boolean(this.annas.apiKey && this.annas.baseUrl && this.annas.fastDownload),
        annas_books_root: Boolean(booksRootInfo?.isDirectory()),
        notion: this.notion.configured(),
        // YouTube transcript extraction still requires this binary; HTML
        // pages use the in-process converter.
        summarize: Bun.which(this.summarizeBin) !== null,
      },
      configuration_status: {
        google: googleStatus,
        google_credentials: credentialStatus,
        google_project: projectReady ? 'ready' : 'not_configured',
      },
      roots: [...this.roots.values()].map((root) => ({
        root_id: root.rootId,
        max_write_bytes: root.maxWriteBytes,
        allow_overwrite: root.allowOverwrite,
      })),
      policy: domainPolicy(),
    };
  }

  private manifest(domainId?: string, displayName?: string): ReturnType<typeof domainManifest> {
    return domainManifest(domainId, displayName, {
      agentRouting: this.agentRouting,
      env: { EXPERT_AGENTS_GCP_PROJECT: this.gcpProject },
    });
  }

  /**
   * The declared disclosure policy for a domain, or `undefined` when the agent
   * declares none. Every disclosure code path in this file is guarded on this
   * being defined, so an agent without a posture takes exactly the paths it
   * took before disclosure enforcement existed.
   */
  private disclosurePolicyFor(domainId: string): DisclosurePolicy | undefined {
    const declared = this.agentRouting[domainId]?.disclosure;
    return declared ? resolveDisclosurePolicy(declared) : undefined;
  }

  private assertCorpusDisclosable(domainId: string, corpusId: string): void {
    const policy = this.disclosurePolicyFor(domainId);
    if (!policy) return;
    if (policy.postureFor(corpusId) === 'full') return;
    throw disclosureError(DISCLOSURE_REFUSAL_CODES.corpusNotDisclosable);
  }

  /**
   * Decides, before any retrieval executes, which of the requested corpora a
   * served deployment may read. Returns `undefined` when the agent declares no
   * posture, which is the signal every caller uses to take the unconstrained
   * path.
   */
  private openDisclosure(
    domainId: string,
    params: DomainAskRequestParams,
    requestedCorpora: readonly string[],
  ): DomainAskDisclosure | undefined {
    const policy = this.disclosurePolicyFor(domainId);
    if (!policy) return undefined;
    const sessionId = requireDisclosureSessionId(params.sessionId);
    // An explicitly named corpus is refused rather than dropped, so a caller
    // is never quietly answered from something other than what it asked for.
    // The default corpus list is filtered instead: a `derived` or `excluded`
    // corpus is simply not part of what this deployment holds.
    const explicit = Boolean(params.corpusId || params.corpora?.length);
    const { disclosable, withheld } = partitionCorporaByDisclosure(policy, requestedCorpora);
    if (explicit && withheld.length > 0) {
      throw disclosureError(DISCLOSURE_REFUSAL_CODES.corpusNotDisclosable);
    }
    if (disclosable.length === 0) {
      throw disclosureError(DISCLOSURE_REFUSAL_CODES.noDisclosableCorpus);
    }
    return {
      policy,
      ledger: this.disclosureSessions.ledgerFor(`${domainId}\u0000${sessionId}`),
      corpora: disclosable,
      withheldCorpusCount: withheld.length,
      summary: { excerptsDisclosed: 0, excerptsTruncated: 0, excerptsWithheld: 0 },
    };
  }

  async run(request: DomainExpertRequest): Promise<unknown> {
    this.agentRouting = this.registrations.routes();
    switch (request.tool) {
      case 'domain_agent':
        return this.domainAgent(parseDomainAgentParams(request.params));
      case 'domain_ask':
        return this.domainAsk(parseDomainAskParams(request.params));
      case 'domain_source':
        return this.domainSource(parseDomainSourceParams(request.params));
      case 'rag_corpus':
        return this.ragCorpus(parseRagCorpusParams(request.params));
      case 'domain_doc':
        return this.domainDoc(parseDomainDocParams(request.params));
      case 'annas_archive_search':
        return this.annasSearch(parseAnnasArchiveSearchParams(request.params));
      case 'annas_archive_import':
        return this.annasImport(parseAnnasArchiveImportParams(request.params));
      default:
        throw new DomainExpertWorkerError(400, 'invalid_tool', 'Unsupported domain expert tool.');
    }
  }

  private async domainAgent(params: DomainAgentParams): Promise<unknown> {
    if (params.action === 'register') {
      const domainId = requireString(params.domainId, 'domain_id');
      const dryRun = params.dryRun ?? true;
      if (!dryRun) requireApprovalId(params.approvalId, 'domain_agent register');
      const registration = {
        ...(params.displayName ? { displayName: params.displayName } : {}),
        library: params.library,
        targetCorpusDisplayName: params.targetCorpusDisplayName,
      };
      const preview = this.registrations.register(domainId, registration, true);
      if (!dryRun && !preview.existing) {
        const corpora = await this.google.listRagCorpora({ project: this.gcpProject, location: this.manifest(domainId).rag_location });
        if (corpora.some(corpus => corpus.displayName === params.targetCorpusDisplayName?.trim())) {
          throw new OperationError('agent_registration_conflict', 'The requested corpus name already exists and cannot be adopted by a new registration.');
        }
      }
      const result = dryRun ? preview : this.registrations.register(domainId, registration, false);
      if (!dryRun) this.agentRouting = result.routes;
      return {
        kind: 'domain_agent_registration',
        status: dryRun ? 'dry_run_registration_ready' : result.existing ? 'already_registered' : 'registered',
        domain_id: domainId,
        manifest: domainManifest(domainId, params.displayName, { agentRouting: result.routes, env: { EXPERT_AGENTS_GCP_PROJECT: this.gcpProject } }),
        policy: domainPolicy(),
      };
    }
    const manifest = this.manifest(params.domainId, params.displayName);
    if (params.action === 'status') {
      const root = this.rootFor(manifest.workspace_root_id);
      const rootPath = await checkedRootPath(root);
      return this.domainAgentStatus(manifest, root, rootPath);
    }
    if (params.action === 'catalog') {
      requireConfiguredAgent(manifest, 'domain_agent catalog');
      return this.domainAgentCatalog(manifest);
    }

    const dryRun = params.dryRun ?? true;
    const plan = planDomainAgent({ ...params, dryRun: true }, manifest);
    if (dryRun) return plan;

    const root = this.rootFor(manifest.workspace_root_id);
    const rootPath = await checkedRootPath(root);
    const directories = [
      manifest.workspace_relative_path,
      `${manifest.workspace_relative_path}/inbox`,
      `${manifest.workspace_relative_path}/references`,
      `${manifest.workspace_relative_path}/templates`,
      `${manifest.workspace_relative_path}/eval`,
      `${manifest.workspace_relative_path}/outputs/briefs`,
      `${manifest.workspace_relative_path}/outputs/resource-wiki-proposals`,
    ];
    for (const relativePath of directories) {
      await mkdir(await resolveWritePathInside(rootPath, relativePath), { recursive: true });
    }

    const writes = await writeWorkspaceSeedFiles(root, rootPath, manifest);
    await audit(root, {
      kind: 'domain_agent_audit',
      action: 'bootstrap',
      domain_id: manifest.domain_id,
      files: writes,
      created_at: new Date().toISOString(),
    });
    return {
      kind: 'domain_agent_result',
      status: 'workspace_bootstrapped',
      domain_id: manifest.domain_id,
      root_id: root.rootId,
      workspace_relative_path: manifest.workspace_relative_path,
      directories_created: directories,
      files: writes,
      aliases_to_create: manifest.library_aliases.map((alias, index) => ({
        alias,
        target_hint: manifest.canonical_resource_paths[index] ?? manifest.canonical_resource_paths[0],
      })),
      policy: domainPolicy(),
    };
  }

  private async domainAgentCatalog(
    manifest: ReturnType<typeof domainManifest>,
  ): Promise<Record<string, unknown>> {
    const library = manifest.routing.library;
    const scopeManifestPath = manifest.routing.scope_manifest_path;
    if (!library || !scopeManifestPath) {
      throw new DomainExpertWorkerError(
        503,
        'library_catalog_not_configured',
        'domain_agent catalog requires a configured scope manifest path.',
      );
    }

    try {
      const scopeText = await readFile(scopeManifestPath, 'utf8');
      const scope = parseScopeManifest(scopeText);
      const manifestBytes = await this.google.downloadGcsObject(
        library.bucket,
        `${library.prefix}/manifest/master.json`,
      );
      if (manifestBytes === null) throw new Error('master manifest missing');
      const master = parseMasterManifest(decodeUtf8Bytes(manifestBytes));
      const ledgerBytes = await this.google.downloadGcsObject(
        library.bucket,
        `${library.prefix}/ledgers/${scope.agentId}.json`,
      );
      const ledger = ledgerBytes === null
        ? { schemaVersion: MATERIALIZATION_LEDGER_SCHEMA_VERSION, entries: [] }
        : catalogPlannerLedger(decodeUtf8Bytes(ledgerBytes));
      const plan = planReconciliation(master, scope, ledger);
      const selectedIds = new Set([
        ...plan.imports.map((entry) => entry.objectId),
        ...plan.alreadyMaterialized.map((entry) => entry.objectId),
      ]);
      const materializedIds = new Set(plan.alreadyMaterialized.map((entry) => entry.objectId));
      const objects = master.objects
        .filter((object) => selectedIds.has(object.id))
        .map((object) => ({
          objectId: object.id,
          display: object.title ?? humanizeSourceLocatorBasename(object.sourceLocators[0]!),
          ...(object.creator === undefined ? {} : { creator: object.creator }),
          byteSize: object.byteSize,
          trustTier: object.trustTier,
          materialized: materializedIds.has(object.id),
        }))
        .sort((left, right) => compareStrings(left.display, right.display)
          || compareStrings(left.objectId, right.objectId));
      const unmaterializedIds = objects
        .filter((object) => !object.materialized)
        .map((object) => object.objectId)
        .sort(compareStrings);

      return {
        kind: 'domain_agent_catalog',
        domainId: manifest.domain_id,
        targetCorpusDisplayName: scope.targetCorpusDisplayName,
        objects,
        summary: {
          libraryRevision: master.revision,
          totalObjects: master.objects.length,
          tombstones: master.tombstones.length,
          selected: objects.length,
          materialized: objects.length - unmaterializedIds.length,
          unmaterializedIds,
        },
      };
    } catch {
      throw new DomainExpertWorkerError(
        502,
        'library_catalog_unreadable',
        'Library catalog state could not be read or validated.',
      );
    }
  }

  private async domainAgentStatus(
    manifest: ReturnType<typeof domainManifest>,
    root: DomainExpertWorkspaceRootPolicy,
    rootPath: string,
  ): Promise<Record<string, unknown>> {
    const workspacePath = resolveInside(rootPath, manifest.workspace_relative_path);
    const workspaceInfo = await stat(workspacePath).catch(() => undefined);
    const seededFiles = await Promise.all(domainWorkspaceSeedFiles(manifest).map(async (file) => {
      const relativePath = String(file.relative_path);
      return {
        relative_path: relativePath,
        kind: file.kind,
        exists: await exists(resolveInside(rootPath, relativePath)),
      };
    }));
    const registryRelativePath = `${manifest.workspace_relative_path}/references/source-registry.jsonl`;
    const registry = await readDomainSourceRegistry(resolveInside(rootPath, registryRelativePath));
    const mappingCache = await inspectRagCorpusMappingCache(this.dataDir);
    const scopeManifest = manifest.routing.scope_manifest_path
      ? await inspectConfiguredScopeManifest(
          manifest.routing.scope_manifest_path,
          manifest.routing.target_corpus_display_name,
        )
      : undefined;
    const preferencePath = this.agentRouting[manifest.domain_id]?.retrieval?.preferenceProfilePath;
    const preferenceStatus = preferencePath
      ? await loadRetrievalPreferenceFile(preferencePath).then((loaded) => ({
          configured: true, valid: true, profile_sha256: loaded.sha256,
          unit_count: loaded.profile.units.length, corpus_binding_verified: false,
        })).catch(() => ({ configured: true, valid: false, corpus_binding_verified: false }))
      : undefined;
    const missingRequirements = seededFiles
      .filter((file) => !file.exists)
      .map(({ relative_path, kind }) => ({ relative_path, kind }));
    const healthIssues: Array<Record<string, unknown>> = [];
    if (preferenceStatus?.valid === false) healthIssues.push({
      code: 'retrieval_preferences_invalid', message: 'The configured retrieval preference file could not be validated.',
    });
    if (workspaceInfo?.isDirectory() !== true) {
      healthIssues.push({
        code: 'workspace_missing',
        message: 'The domain workspace directory is missing.',
      });
    }
    if (missingRequirements.length > 0) {
      healthIssues.push({
        code: 'workspace_seed_incomplete',
        message: `The domain workspace is missing ${missingRequirements.length} of ${seededFiles.length} required seed files.`,
        missing_requirement_count: missingRequirements.length,
      });
    }
    if (registry.missing) {
      healthIssues.push({
        code: 'source_registry_missing',
        message: 'The source registry is missing.',
      });
    } else if (registry.malformedLines > 0) {
      healthIssues.push({
        code: 'source_registry_malformed',
        message: `The source registry contains ${registry.malformedLines} malformed line${registry.malformedLines === 1 ? '' : 's'}.`,
      });
    }
    if (mappingCache.exists !== true) {
      healthIssues.push({
        code: 'corpus_mapping_cache_missing',
        message: 'The corpus mapping cache is missing.',
      });
    } else if (mappingCache.readable !== true) {
      healthIssues.push({
        code: 'corpus_mapping_cache_unreadable',
        message: 'The corpus mapping cache is unreadable.',
      });
    }
    if (scopeManifest && scopeManifest.present !== true) {
      healthIssues.push({
        code: 'scope_manifest_missing',
        message: 'The configured scope manifest is missing.',
      });
    } else if (scopeManifest && scopeManifest.parseable !== true) {
      healthIssues.push({
        code: 'scope_manifest_unparseable',
        message: 'The configured scope manifest is not parseable.',
      });
    } else if (scopeManifest && scopeManifest.target_matches_routing !== true) {
      healthIssues.push({
        code: 'scope_manifest_target_mismatch',
        message: 'The configured scope manifest target does not match agent routing.',
      });
    }
    const recommendedRecovery = missingRequirements.length > 0
      ? {
          action: 'bootstrap_missing_workspace_seed',
          tool: 'domain_agent',
          params: {
            action: 'bootstrap',
            domain_id: manifest.domain_id,
            dry_run: false,
          },
          effect: 'Create missing required seed files without retrieving source content or making cloud calls; preserve existing files when overwrite is disabled.',
        }
      : undefined;
    return {
      kind: 'domain_agent_status',
      status: 'completed',
      health: healthIssues.length === 0 ? 'healthy' : 'degraded',
      health_issues: healthIssues,
      ...(preferenceStatus ? { retrieval_preferences: preferenceStatus } : {}),
      inspection_scope: 'filesystem',
      cloud_calls_made: false,
      domain_id: manifest.domain_id,
      root_id: root.rootId,
      workspace: {
        relative_path: manifest.workspace_relative_path,
        exists: workspaceInfo?.isDirectory() === true,
        seeded_files: seededFiles,
        seeded_file_count: seededFiles.filter((file) => file.exists).length,
        seeded_file_total: seededFiles.length,
        missing_requirements: missingRequirements,
        ...(recommendedRecovery ? { recommended_recovery: recommendedRecovery } : {}),
      },
      source_registry: {
        relative_path: registryRelativePath,
        exists: !registry.missing,
        record_count: registry.totalRecords,
        tombstone_count: registry.records.filter((record) => record.removed).length,
        malformed_line_count: registry.malformedLines,
      },
      corpus_mapping_cache: mappingCache,
      ...(scopeManifest ? { scope_manifest: scopeManifest } : {}),
      policy: domainPolicy(),
    };
  }

  private async domainAsk(params: DomainAskRequestParams): Promise<unknown> {
    const manifest = this.manifest(params.domainId);
    requireConfiguredAgent(manifest, 'domain_ask');
    const plan = planDomainAsk(params, manifest);
    requireGoogleProject(manifest.gcp_project);
    const question = requireString(params.question, 'question');
    const requestedCorpora = params.corpusId
      ? [params.corpusId]
      : (params.corpora?.length ? params.corpora : manifest.corpora.map((corpus) => corpus.id));
    const disclosure = this.openDisclosure(manifest.domain_id, params, requestedCorpora);
    const corpora = disclosure ? disclosure.corpora : requestedCorpora;
    const retrievalOverrides = this.agentRouting[manifest.domain_id]?.retrieval;
    const preferencePath = retrievalOverrides?.preferenceProfilePath;
    // History is an explicit recovery path even when an operator profile is unavailable.
    const preference = preferencePath && params.retrievalMode !== 'history'
      ? await loadRetrievalPreferenceFile(preferencePath).catch(() => {
        throw new DomainExpertWorkerError(503, 'retrieval_preferences_unavailable',
          'Configured retrieval preferences could not be validated.',
          'Repair the operator profile or explicitly request retrieval_mode history.');
      }) : undefined;
    const preferenceMode = params.retrievalMode ?? preference?.profile.query_layer.default_mode ?? 'history';
    const topK = Math.min(params.maxResults ?? retrievalOverrides?.topK ?? this.google.retrievalTopK(),
      preference?.profile.query_layer.candidate_top_k ?? Number.POSITIVE_INFINITY);
    const answerContextLimit = Math.min(
      topK,
      retrievalOverrides?.contextLimit ?? this.google.answerContextLimit(),
    );
    const resolvedCorpora: ResolvedRagCorpus[] = [];
    const warnings: RagCorpusWarning[] = [];
    for (const corpusId of corpora) {
      const resolved = await this.resolveRagCorpus(manifest, corpusId).catch((error) => {
        if (error instanceof DomainExpertWorkerError && error.code === 'rag_corpus_not_found' && corpora.length > 1) {
          warnings.push(ragCorpusWarning(corpusId, error));
          return undefined;
        }
        throw error;
      });
      if (resolved) {
        resolvedCorpora.push(resolved);
        warnings.push(...ragCorpusWarnings(resolved));
      }
    }
    if (resolvedCorpora.length === 0) {
      throw new DomainExpertWorkerError(
        404,
        'rag_corpus_not_found',
        `No requested RAG corpora could be resolved for ${manifest.domain_id}: ${corpora.join(', ')}.`,
        'Run rag_corpus create for at least one requested corpus before asking.',
      );
    }
    if (preference && !resolvedCorpora.some((corpus) => corpus.resourceName === preference.profile.corpus)) {
      throw new DomainExpertWorkerError(409, 'retrieval_preferences_corpus_mismatch',
        'Configured retrieval preferences do not match the resolved corpus.',
        'Repair the operator profile or explicitly request retrieval_mode history.');
    }
    let queries = [question];
    if (retrievalOverrides?.multiQuery ?? this.google.multiQueryEnabled()) {
      try {
        queries = domainRetrievalQueries(question, await this.google.generateQueryReformulations({
          project: manifest.gcp_project,
          location: manifest.rag_location,
          model: this.google.model(),
          question,
        }));
      } catch (error) {
        // The reason travels with the fallback. Without it this degradation is
        // invisible: retrieval still answers, just from one query instead of
        // several, so a comparison question can retrieve one subject and report
        // the other as absent from a library that holds both. That ran
        // unnoticed on every request until a user asked a two-author question.
        console.warn(JSON.stringify({
          kind: 'domain_expert_multi_query_fallback',
          query_count: 1,
          reason: sanitizeWebImportProvenanceText(
            error instanceof Error ? error.message : 'query reformulation failed',
          ).slice(0, 300),
        }));
      }
    }
    const rankedLists: Array<Array<Record<string, unknown> & { corpus_id: string }>> = [];
    const usedCorpora = new Map<string, ResolvedRagCorpus>();
    for (const corpus of resolvedCorpora) {
      let currentCorpus = corpus;
      for (const [queryIndex, query] of queries.entries()) {
        let retrieval: Awaited<ReturnType<typeof this.withRagCorpusRetry<Array<Record<string, unknown>>>>>;
        try {
          retrieval = await this.withRagCorpusRetry(manifest, currentCorpus, (candidate) => this.google.retrieveContexts({
            project: manifest.gcp_project,
            location: manifest.rag_location,
            corpusName: candidate.resourceName,
            query,
            topK,
            ...(retrievalOverrides?.reranker ? { reranker: retrievalOverrides.reranker } : {}),
          }));
        } catch (error) {
          if (queryIndex === 0) throw error;
          const warning: RagRetrievalQueryFailedWarning = {
            kind: 'rag_retrieval_query_failed',
            corpus_id: currentCorpus.requested,
          };
          warnings.push(warning);
          console.warn(JSON.stringify(warning));
          continue;
        }
        const { value: contexts, resolved, warnings: retryWarnings } = retrieval;
        currentCorpus = resolved;
        usedCorpora.set(resolved.requested, resolved);
        warnings.push(...retryWarnings);
        rankedLists.push(contexts.map((context) => ({
          ...context,
          corpus_id: resolved.requested,
        })));
      }
    }
    if (preference && ![...usedCorpora.values()].some((corpus) => corpus.resourceName === preference.profile.corpus)) {
      throw new DomainExpertWorkerError(409, 'retrieval_preferences_corpus_mismatch',
        'Configured retrieval preferences do not match the retrieved corpus.');
    }
    const citationOrdinals = new Map<string, number>();
    const synthesisContextLimit = Math.min(answerContextLimit, DOMAIN_ANSWER_SYNTHESIS_CONTEXT_CAP);
    const candidates = reciprocalRankFuse<Record<string, unknown> & { corpus_id: string }>(rankedLists,
      preference && preferenceMode === 'preferred' ? topK : synthesisContextLimit);
    // Scope bare Vertex file IDs before ranking: identical IDs in another corpus
    // must never inherit this profile's editorial weight.
    const preferred = preference ? applyRetrievalPreferences(candidates.map((context) => {
      const fileId = (context.chunk as { fileId?: unknown } | undefined)?.fileId;
      const resource = usedCorpora.get(context.corpus_id)?.resourceName;
      return {
        original: context,
        ...(typeof context.text === 'string' ? { text: context.text } : {}),
        ...(typeof context.sourceUri === 'string' ? { sourceUri: context.sourceUri } : {}),
        ...(typeof fileId === 'string' ? { chunk: { fileId: fileId.includes('/') ? fileId : `${resource}/ragFiles/${fileId}` } } : {}),
      };
    }), preference.profile, { corpus: preference.profile.corpus, mode: preferenceMode, limit: synthesisContextLimit }) : undefined;
    const fusedContexts = preferred ? preferred.contexts.map((context) => context.original) : candidates;
    // Sentence completion runs before the disclosure bound, so a declared
    // posture measures, and may still trim, the completed text.
    const completedContexts = await this.completePassageSentences(fusedContexts);
    const boundedContexts = disclosure ? boundDisclosedContexts(disclosure, completedContexts) : completedContexts;
    const retrieved: Array<Record<string, unknown> & { citation_id: string; corpus_id: string }> = boundedContexts.map((context) => {
      const ordinal = (citationOrdinals.get(context.corpus_id) ?? 0) + 1;
      citationOrdinals.set(context.corpus_id, ordinal);
      return {
        ...context,
        citation_id: `${context.corpus_id}:${ordinal}`,
      };
    });
    const citationSources = await this.resolveCitationSources(retrieved, manifest);
    const cited: typeof retrieved = retrieved.map((context, index) => {
      const source = citationSources.metadata[index];
      return {
        ...context,
        ...(source?.title ? { sourceTitle: source.title } : {}),
        ...(source?.creator ? { sourceCreator: source.creator } : {}),
      };
    });
    console.info(JSON.stringify({
      kind: 'domain_expert_retrieval_counts',
      // The domain id is routing vocabulary, not user content — without it a
      // journal cannot say which lane a request served, and a multi-domain
      // incident cannot be attributed after the fact.
      domain_id: manifest.domain_id,
      query_count: queries.length,
      corpus_count: usedCorpora.size,
      ranked_list_count: rankedLists.length,
      candidate_context_count: rankedLists.reduce((sum, contexts) => sum + contexts.length, 0),
      selected_context_count: retrieved.length,
    }));
    const shared = {
      ...(preferencePath || params.retrievalMode ? { retrieval_preferences: {
        configured: Boolean(preferencePath),
        mode: preferenceMode,
        status: preference ? 'applied' : preferencePath ? 'bypassed' : 'unconfigured',
        ...(preference ? { profile_sha256: preference.sha256, unit_count: preference.profile.units.length,
          diagnostics: preferred?.diagnostics } : {}),
      } } : {}),
      domain_id: manifest.domain_id,
      question,
      citations: cited.map((context) => ({
        citation_id: context.citation_id,
        corpus_id: context.corpus_id,
        ...citationSourceFields(context),
        source_display_name: context.sourceDisplayName,
        source_uri: context.sourceUri,
        score: context.score,
      })),
      retrieved_context_count: retrieved.length,
      ...(citationSources.diagnostics.length ? { citation_diagnostics: citationSources.diagnostics } : {}),
      resolved_corpora: [...usedCorpora.values()].map((corpus) => ({
        requested: corpus.requested,
        corpus_id: corpus.corpusId,
        resource_name: corpus.resourceName,
        ...(corpus.displayName ? { display_name: corpus.displayName } : {}),
      })),
      ...(warnings.length ? { warnings } : {}),
      ...(disclosure ? { disclosure: disclosureReport(disclosure) } : {}),
      // The plan was built from what was requested. Under a declared posture
      // the echo is narrowed to what was actually disclosable, so a corpus the
      // deployment withheld is never named back to the caller.
      retrieval_plan: disclosure
        ? { ...(plan as Record<string, unknown>).retrieval as Record<string, unknown>, corpora }
        : (plan as Record<string, unknown>).retrieval,
      policy: domainPolicy(),
    };
    if (params.output === 'passages') {
      return {
        kind: 'domain_passages',
        status: 'retrieved',
        ...shared,
        passages: cited.map((context) => ({
          citation_id: context.citation_id,
          corpus_id: context.corpus_id,
          header: citationHeader(context),
          ...citationSourceFields(context),
          text: typeof context.text === 'string' ? context.text : '',
          ...(context.sentence_completed === true && context.excerpt_truncated !== true ? { completed: true } : {}),
          source_display_name: context.sourceDisplayName,
          source_uri: context.sourceUri,
          score: context.score,
        })),
      };
    }
    const answer = await this.google.generateAnswer({
      project: manifest.gcp_project,
      location: manifest.rag_location,
      model: this.google.model(),
      question,
      contexts: cited,
    });
    return {
      kind: 'domain_answer',
      status: 'answered',
      ...shared,
      answer,
    };
  }

  private async domainSource(params: DomainSourceParams): Promise<unknown> {
    const dryRun = params.dryRun ?? true;
    const manifest = this.manifest(params.domainId);
    const root = this.rootFor(manifest.workspace_root_id);
    const rootPath = await checkedRootPath(root);
    const registryRelativePath = `${manifest.workspace_relative_path}/references/source-registry.jsonl`;
    const registryPath = resolveInside(rootPath, registryRelativePath);
    if (params.action === 'list') {
      return this.listDomainSources(params, registryPath, registryRelativePath, manifest.domain_id);
    }
    if (params.action === 'status') {
      return this.statusDomainSource(params, registryPath, registryRelativePath, manifest.domain_id);
    }
    const plan = planDomainSource({ ...params, dryRun: true }, manifest);
    if (params.action === 'remove') {
      return this.removeDomainSource(params, registryPath, registryRelativePath, manifest.domain_id, dryRun);
    }
    if (dryRun) return plan;
    const sourceRecord = (plan as { source_record: Record<string, unknown> }).source_record;
    const logPath = resolveInside(rootPath, `${manifest.workspace_relative_path}/references/ingest-log.md`);
    await mkdir(dirname(registryPath), { recursive: true });
    await this.appendRegistryJsonLine(registryPath, { ...sourceRecord, registered_at: new Date().toISOString() });
    await appendFile(logPath, `- ${new Date().toISOString()} registered ${sourceRecord.source_id} (${params.action})\n`, 'utf8');
    return {
      kind: 'domain_source_result',
      status: 'registered',
      action: params.action,
      domain_id: manifest.domain_id,
      source_record: sourceRecord,
      registry_relative_path: registryRelativePath,
      policy: domainPolicy(),
    };
  }

  private async listDomainSources(
    params: DomainSourceParams,
    registryPath: string,
    registryRelativePath: string,
    domainId: string,
  ): Promise<Record<string, unknown>> {
    const registry = await readDomainSourceRegistry(registryPath);
    const includeHistory = params.includeHistory === true;
    const includeRemoved = params.includeRemoved === true;
    const grouped = groupDomainSourceRecords(registry.records);
    const sources = [...grouped.entries()]
      .map(([sourceId, history]) => ({ sourceId, history, current: latestDomainSourceRecord(history) }))
      .filter(({ current }) => includeRemoved || !current.removed)
      .filter(({ current }) => !params.sourceKind || stringRecordField(current.record, 'kind') === params.sourceKind)
      .filter(({ current }) => !params.corpusId || stringRecordField(current.record, 'target_corpus_id') === params.corpusId)
      .sort((left, right) => compareDomainSourceRecords(left.current, right.current))
      .map(({ sourceId, history, current }) => ({
        source_id: sourceId,
        record_count: history.length,
        current: current.record,
        ...(includeHistory ? { history: history.map((entry) => entry.record) } : {}),
      }));
    return {
      kind: 'domain_source_list',
      status: 'ok',
      domain_id: domainId,
      registry_relative_path: registryRelativePath,
      total_records: registry.totalRecords,
      malformed_lines: registry.malformedLines,
      sources,
      ...(registry.missing ? { note: `Source registry ${registryRelativePath} does not exist yet.` } : {}),
      filters: {
        ...(params.sourceKind ? { kind: params.sourceKind } : {}),
        ...(params.corpusId ? { corpus_id: params.corpusId } : {}),
        include_history: includeHistory,
        include_removed: includeRemoved,
      },
      policy: domainPolicy(),
    };
  }

  private async statusDomainSource(
    params: DomainSourceParams,
    registryPath: string,
    registryRelativePath: string,
    domainId: string,
  ): Promise<Record<string, unknown>> {
    const sourceId = params.sourceId?.trim();
    if (!sourceId) throw new DomainExpertWorkerError(400, 'invalid_params', 'domain_source status requires source_id.');
    const registry = await readDomainSourceRegistry(registryPath);
    const history = registry.records
      .filter((entry) => entry.sourceId === sourceId)
      .sort(compareDomainSourceRecords);
    if (history.length === 0) {
      throw new DomainExpertWorkerError(404, 'domain_source_not_found', `Source ${sourceId} was not found in ${registryRelativePath}.`);
    }
    const current = latestDomainSourceRecord(history);
    return {
      kind: 'domain_source_status',
      status: 'ok',
      domain_id: domainId,
      source_id: sourceId,
      registry_relative_path: registryRelativePath,
      total_records: registry.totalRecords,
      malformed_lines: registry.malformedLines,
      current: current.record,
      history: history.map((entry) => entry.record),
      removed: current.removed,
      policy: domainPolicy(),
    };
  }

  private async removeDomainSource(
    params: DomainSourceParams,
    registryPath: string,
    registryRelativePath: string,
    domainId: string,
    dryRun: boolean,
  ): Promise<Record<string, unknown>> {
    const sourceId = params.sourceId?.trim();
    if (!sourceId) throw new DomainExpertWorkerError(400, 'invalid_params', 'domain_source remove requires source_id.');
    const registry = await readDomainSourceRegistry(registryPath);
    const history = registry.records
      .filter((entry) => entry.sourceId === sourceId)
      .sort(compareDomainSourceRecords);
    if (history.length === 0) {
      throw new DomainExpertWorkerError(404, 'domain_source_not_found', `Source ${sourceId} was not found in ${registryRelativePath}.`);
    }
    const current = latestDomainSourceRecord(history);
    const tombstone = {
      source_id: sourceId,
      domain_id: domainId,
      ingest_status: 'removed',
      removed: true,
      registered_at: new Date().toISOString(),
    };
    if (dryRun) {
      return {
        kind: 'domain_source_plan',
        status: 'dry_run_source_lifecycle_ready',
        action: 'remove',
        domain_id: domainId,
        registry_relative_path: registryRelativePath,
        target_record: current.record,
        tombstone_record: tombstone,
        policy: domainPolicy(),
      };
    }
    const logPath = resolveInside(dirname(dirname(registryPath)), 'references/ingest-log.md');
    await mkdir(dirname(registryPath), { recursive: true });
    await this.appendRegistryJsonLine(registryPath, tombstone);
    await appendFile(logPath, `- ${tombstone.registered_at} removed ${sourceId} (remove)\n`, 'utf8');
    return {
      kind: 'domain_source_result',
      status: 'removed',
      action: 'remove',
      domain_id: domainId,
      source_record: tombstone,
      target_record: current.record,
      registry_relative_path: registryRelativePath,
      policy: domainPolicy(),
    };
  }

  private async ensureRagCorpus(params: RagCorpusParams): Promise<unknown> {
    const manifest = this.manifest(params.domainId);
    requireConfiguredAgent(manifest, 'rag_corpus ensure');
    const corpusId = params.corpusId ?? defaultCorpusId(manifest);
    if (!this.configuredCorpusIds(manifest).includes(corpusId)) throw corpusNotConfiguredForDomainError(manifest, corpusId);
    this.assertCorpusDisclosable(manifest.domain_id, corpusId);
    const dryRun = params.dryRun ?? true;
    const base = { kind: 'rag_corpus_ensure', domain_id: manifest.domain_id, corpus_id: corpusId, policy: domainPolicy() };
    if (dryRun) return { ...base, status: 'dry_run_ensure_ready' };
    requireApprovalId(params.approvalId, 'rag_corpus ensure');
    const work = async () => {
      const directory = join(this.dataDir, 'corpus-creations');
      const identity = { project: manifest.gcp_project, location: manifest.rag_location, corpus_id: corpusId };
      const path = join(directory, `${sha256(new TextEncoder().encode(canonicalJson(identity)))}.json`);
      // Refresh discovery on every retry: an earlier empty listing must not
      // hide a just-created corpus or trigger a duplicate creation.
      const resolved = await this.resolveRagCorpus(manifest, corpusId, { refresh: true }).catch(error => {
        if (error instanceof DomainExpertWorkerError && error.code === 'rag_corpus_not_found') return undefined;
        throw error;
      });
      if (resolved) {
        if (resolved.warnings?.some(warning => 'code' in warning && warning.code === 'rag_corpus_duplicate_display_name')) {
          throw new DomainExpertWorkerError(409, 'rag_corpus_ambiguous', 'Multiple corpora have the configured display name.');
        }
        const resource = asOptionalRecord(await this.google.getRagCorpus({ project: manifest.gcp_project, location: manifest.rag_location, corpusName: resolved.resourceName }));
        const state = asOptionalRecord(resource?.corpusStatus)?.state;
        if (state === 'ERROR') throw new DomainExpertWorkerError(502, 'rag_corpus_creation_failed', 'The configured corpus is in an error state.');
        if (state !== 'ACTIVE' && await exists(path)) await this.reconcileRagCorpusCreation(path, identity);
        return { ...base, status: state === 'ACTIVE' ? 'ready' : 'create_requested', creation_pending: state !== 'ACTIVE', resolved_corpus: resolvedCorpusRecord(resolved) };
      }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const receipt = { schema_version: 1, ...identity, status: 'creation_pending', submitted_at: new Date().toISOString() };
      try {
        // Durable intent and exclusive creation also fence another process.
        // A lost provider response is reconciled through discovery, never by
        // replaying the non-idempotent corpus creation request.
        writeExclusiveDurably(path, canonicalJson(receipt));
      } catch (error) {
        if (!isFileSystemError(error, 'EEXIST')) throw error;
        await this.reconcileRagCorpusCreation(path, identity);
        return { ...base, status: 'create_requested', creation_pending: true };
      }
      let operation: unknown;
      try {
        operation = await this.google.createRagCorpus({ project: manifest.gcp_project, location: manifest.rag_location, displayName: corpusId });
      } catch (error) {
        await writeJsonFileAtomically(path, { ...receipt, status: 'creation_unknown' }).catch(() => undefined);
        throw error;
      }
      const record = asOptionalRecord(operation);
      // This is a bounded, untrusted recovery reference, not permission to poll.
      // Persist it before the independent project-alias lookup can fail.
      const candidate = corpusCreationOperationCandidate(identity.project, identity.location, record, corpusId);
      const submitted = { ...receipt, operation_name: candidate };
      await writeJsonFileAtomically(path, submitted);
      let validated;
      try {
        validated = await this.google.validateCreationOperationName(identity.project, identity.location, candidate, record?.response);
      } catch (error) {
        if (!isCreationProjectIdentityUnavailable(error)) throw error;
        return { ...base, status: 'create_requested', creation_pending: true };
      }
      const { name, parents } = validated;
      const status = validateCorpusCreationOperation(record, name, parents, corpusId);
      await writeJsonFileAtomically(path, { ...receipt, status, operation_name: name });
      if (status === 'creation_failed') throw new DomainExpertWorkerError(502, 'rag_corpus_creation_failed', 'The corpus creation operation failed and requires operator reconciliation.');
      return { ...base, status: 'create_requested', creation_pending: true };
    };
    const result = this.corpusEnsureQueue.then(work, work);
    this.corpusEnsureQueue = result.catch(() => undefined);
    return result;
  }

  private async reconcileRagCorpusCreation(path: string, identity: { project: string; location: string; corpus_id: string }): Promise<void> {
    const stored = asOptionalRecord(JSON.parse(await readFile(path, 'utf8')));
    if (!stored || stored.project !== identity.project || stored.location !== identity.location || stored.corpus_id !== identity.corpus_id) {
      throw new DomainExpertWorkerError(500, 'rag_corpus_creation_receipt_invalid', 'The corpus creation receipt could not be validated.');
    }
    if (stored.status === 'creation_failed') throw new DomainExpertWorkerError(502, 'rag_corpus_creation_failed', 'The corpus creation operation failed and requires operator reconciliation.');
    if (stored.operation_name === undefined || stored.status === 'creation_complete') return;
    // The receipt may have been restored from disk after a restart, so validate
    // its authority again before issuing even a read against the operation.
    let validated;
    try {
      validated = await this.google.validateCreationOperationName(identity.project, identity.location, stored.operation_name);
    } catch (error) {
      if (!isCreationProjectIdentityUnavailable(error)) throw error;
      return;
    }
    const { name } = validated;
    const operation = await this.google.getRagCorpusCreationOperation({ project: identity.project, location: identity.location, operationName: name });
    const record = asOptionalRecord(operation);
    if (record?.name !== name) throw new DomainExpertWorkerError(502, 'rag_corpus_creation_operation_invalid', 'The corpus creation operation response could not be validated.');
    // Reject malformed/out-of-location proof even when alias lookup is unavailable.
    corpusCreationOperationCandidate(identity.project, identity.location, record, identity.corpus_id);
    let responseIdentity;
    try {
      responseIdentity = await this.google.validateCreationOperationName(identity.project, identity.location, name, record?.response);
    } catch (error) {
      if (!isCreationProjectIdentityUnavailable(error)) throw error;
      return;
    }
    const { parents } = responseIdentity;
    const status = validateCorpusCreationOperation(record, name, parents, identity.corpus_id);
    await writeJsonFileAtomically(path, { ...stored, status });
    if (status === 'creation_failed') throw new DomainExpertWorkerError(502, 'rag_corpus_creation_failed', 'The corpus creation operation failed and requires operator reconciliation.');
  }

  private async ragCorpus(params: RagCorpusParams): Promise<unknown> {
    if (params.action === 'ensure') return this.ensureRagCorpus(params);
    const dryRun = params.dryRun ?? true;
    const manifest = this.manifest(params.domainId);
    if (!manifest.routing.configured && dryRun) {
      return planRagCorpus({ ...params, dryRun: true }, manifest);
    }
    if (!dryRun) requireConfiguredAgent(manifest, 'rag_corpus');
    if (!dryRun || params.action === 'list_files') requireGoogleProject(manifest.gcp_project);
    if (params.action === 'stage_import') {
      return this.stageRagImport(params, dryRun);
    }
    if (params.action === 'web_import') {
      return this.webRagImport(params, dryRun);
    }
    if (params.action === 'notion_import') {
      return this.notionRagImport(params, dryRun);
    }
    const plan = planRagCorpus({ ...params, dryRun: true }, manifest);
    if (dryRun && params.action !== 'list_files') return plan;
    requireConfiguredAgent(manifest, 'rag_corpus');
    const corpusId = params.corpusId ?? defaultCorpusId(manifest);
    assertReviewedLiveRagImport(manifest, params, dryRun);
    if (params.action === 'create') {
      // create is the one corpus-scoped action that does not resolve an
      // existing corpus, so the allowlist every other action is checked
      // against has to be applied here too: a domain mints only the corpora
      // its routing names, never an arbitrary display name of the caller's.
      if (!this.configuredCorpusIds(manifest).includes(corpusId)) {
        throw corpusNotConfiguredForDomainError(manifest, corpusId);
      }
      const description = manifest.corpora.find((corpus) => corpus.id === corpusId)?.description;
      const operation = await this.google.createRagCorpus({
        project: manifest.gcp_project,
        location: manifest.rag_location,
        displayName: corpusId,
        ...(description ? { description } : {}),
      });
      const createdResourceName = extractRagCorpusResourceName(operation);
      if (createdResourceName) {
        await this.recordRagCorpusMapping(manifest.gcp_project, manifest.rag_location, corpusId, createdResourceName);
      }
      return {
        kind: 'rag_corpus_result',
        status: 'create_requested',
        domain_id: manifest.domain_id,
        operation,
        ...(createdResourceName ? {
          resolved_corpus: {
            requested: corpusId,
            corpus_id: corpusIdFromResourceName(createdResourceName),
            resource_name: createdResourceName,
            display_name: corpusId,
          },
        } : {}),
        policy: domainPolicy(),
      };
    }
    const resolved = await this.resolveRagCorpus(manifest, corpusId);
    const resolutionWarnings = ragCorpusWarnings(resolved);
    if (params.action === 'status' || params.action === 'refresh') {
      const { value: corpus, resolved: usedResolved, warnings } = await this.withRagCorpusRetry(manifest, resolved, (candidate) => this.google.getRagCorpus({
        project: manifest.gcp_project,
        location: manifest.rag_location,
        corpusName: candidate.resourceName,
      }));
      return {
        kind: 'rag_corpus_status',
        domain_id: manifest.domain_id,
        routing: manifest.routing,
        resolved_corpus: {
          requested: usedResolved.requested,
          corpus_id: usedResolved.corpusId,
          resource_name: usedResolved.resourceName,
          ...(usedResolved.displayName ? { display_name: usedResolved.displayName } : {}),
        },
        corpus,
        ...([...resolutionWarnings, ...warnings].length ? { warnings: [...resolutionWarnings, ...warnings] } : {}),
        policy: domainPolicy(),
      };
    }
    if (params.action === 'list_files') {
      const { value: result, resolved: usedResolved, warnings } = await this.withRagCorpusRetry(manifest, resolved, (candidate) => this.google.listRagFiles({
        project: manifest.gcp_project,
        location: manifest.rag_location,
        corpusName: candidate.resourceName,
        ...(params.pageToken ? { pageToken: params.pageToken } : {}),
      }));
      this.rememberResolvedRagCorpusProjectAliases(manifest, usedResolved);
      this.rememberListedRagFileProjects(manifest, usedResolved, result.files);
      return {
        kind: 'rag_corpus_files',
        domain_id: manifest.domain_id,
        resolved_corpus: resolvedCorpusRecord(usedResolved),
        files: result.files,
        ...(result.nextPageToken ? { next_page_token: result.nextPageToken } : {}),
        ...([...resolutionWarnings, ...warnings].length ? { warnings: [...resolutionWarnings, ...warnings] } : {}),
        policy: domainPolicy(),
      };
    }
    if (params.action === 'delete_file') {
      const ragFileName = requireString(params.ragFileName, 'rag_file_name');
      this.assertRagFileBelongsToResolvedCorpus(manifest, ragFileName, resolved);
      const base = {
        action: 'delete_file',
        domain_id: manifest.domain_id,
        resolved_corpus: resolvedCorpusRecord(resolved),
        rag_file_name: ragFileName,
        ...([...resolutionWarnings].length ? { warnings: resolutionWarnings } : {}),
        policy: domainPolicy(),
      };
      if (dryRun) {
        return {
          kind: 'rag_corpus_delete_file_plan',
          status: 'dry_run_delete_file_ready',
          ...base,
        };
      }
      const deleted = await (async () => {
        try {
          return await this.withRagCorpusRetry(manifest, resolved, (candidate) => {
            this.assertRagFileBelongsToResolvedCorpus(manifest, ragFileName, candidate);
            return this.google.deleteRagFile({
              project: manifest.gcp_project,
              location: manifest.rag_location,
              ragFileName,
            });
          });
        } catch (error) {
          if (isGoogleNotFoundError(error)) throw ragFileNotFoundError(ragFileName);
          throw error;
        }
      })();
      const { value: operation, resolved: usedResolved, warnings } = deleted;
      return {
        kind: 'rag_corpus_delete_file_result',
        status: 'delete_file_requested',
        ...base,
        resolved_corpus: resolvedCorpusRecord(usedResolved),
        ...([...resolutionWarnings, ...warnings].length ? { warnings: [...resolutionWarnings, ...warnings] } : {}),
        operation,
      };
    }
    const importResultSink = params.gcsUri && this.agentRouting[manifest.domain_id]?.ingestion?.importResultSink !== 'client'
      ? importResultSinkUri(manifest.allowed_gcs_prefixes, manifest.domain_id)
      : undefined;
    const { value: submission, resolved: usedResolved, warnings } = await this.withRagCorpusRetry(manifest, resolved, async (candidate) => {
      if (params.gcsUri) await this.deleteErrorRagFileRecords(manifest, candidate, [params.gcsUri]);
      return this.submitRagImport({
        project: manifest.gcp_project,
        location: manifest.rag_location,
        corpusName: candidate.resourceName,
        ...(params.gcsUri ? { gcsUri: params.gcsUri } : {}),
        ...(params.driveFileId ? { driveFileId: params.driveFileId } : {}),
        ...(importResultSink ? { importResultGcsSink: importResultSink } : {}),
        chunkTokens: manifest.chunking.chunk_tokens,
        chunkOverlap: manifest.chunking.chunk_overlap,
        llmParserEligible: llmParserEligibleUris(params.gcsUri ? [params.gcsUri] : []),
      });
    });
    return {
      kind: 'rag_corpus_result',
      status: 'import_requested',
      submission_receipt: submission.submissionReceipt,
      domain_id: manifest.domain_id,
      resolved_corpus: {
        requested: usedResolved.requested,
        corpus_id: usedResolved.corpusId,
        resource_name: usedResolved.resourceName,
        ...(usedResolved.displayName ? { display_name: usedResolved.displayName } : {}),
      },
      ...(importResultSink ? { import_result_sink: importResultSink } : {}),
      ...([...resolutionWarnings, ...warnings].length ? { warnings: [...resolutionWarnings, ...warnings] } : {}),
      operation: submission.operation,
      policy: domainPolicy(),
    };
  }

  private async stageRagImport(params: RagCorpusParams, dryRun: boolean): Promise<unknown> {
    const manifest = this.manifest(params.domainId);
    const corpusId = params.corpusId ?? defaultCorpusId(manifest);
    const root = this.rootFor(manifest.workspace_root_id);
    const rootPath = await checkedRootPath(root);
    const workspaceRelativePath = requireString(params.workspaceRelativePath, 'workspace_relative_path');
    const batchId = normalizeStageBatchId(params.batchId ?? randomUUID());
    const stage = await this.planStageImportDirectory({
      manifest,
      rootPath,
      workspaceRelativePath,
      batchId,
      corpusId,
      includeMedia: params.includeMedia ?? false,
    });
    const { eligible, skipped, totalBytes, destination, resolvedCorpus } = stage;
    const resolutionWarnings = ragCorpusWarnings(stage.resolved);
    if (eligible.length === 0) {
      throw new DomainExpertWorkerError(
        400,
        'no_stage_import_files',
        'stage_import found no eligible files after applying extension and size limits.',
      );
    }
    const base = {
      action: 'stage_import',
      domain_id: manifest.domain_id,
      source: {
        workspace_root_id: manifest.workspace_root_id,
        workspace_relative_path: workspaceRelativePath,
        recursive: true,
      },
      destination: {
        gcs_uri_prefix: destination.directoryUri,
        bucket: destination.bucket,
        object_prefix: destination.objectPrefix,
        batch_id: batchId,
        allowed_gcs_prefixes: manifest.allowed_gcs_prefixes,
      },
      resolved_corpus: resolvedCorpus,
      file_policy: {
        recursive: true,
        allowed_extensions: [...STAGE_IMPORT_ALLOWED_EXTENSIONS].map((extension) => extension.slice(1)),
        max_file_bytes: PDF_PROCESSING_MAX_BYTES,
        text_default_max_file_bytes: STAGE_IMPORT_MAX_FILE_BYTES,
        pdf_max_file_bytes: PDF_PROCESSING_MAX_BYTES,
        max_batch_bytes: STAGE_IMPORT_MAX_BATCH_BYTES,
        media_max_file_bytes: MEDIA_TRANSCRIBE_MAX_BYTES,
        media_bytes_count_against_text_batch_cap: false,
      },
      eligible_files: eligible.map((file) => ({
        workspace_relative_path: file.workspaceRelativePath,
        upload_relative_path: file.uploadRelativePath,
        bytes: file.bytes,
        gcs_uri: file.gcsUri,
      })),
      skipped_files: skipped,
      eligible_file_count: eligible.length,
      skipped_file_count: skipped.length,
      total_eligible_bytes: totalBytes,
      ...(resolutionWarnings.length ? { warnings: resolutionWarnings } : {}),
      policy: domainPolicy(),
    };
    if (dryRun) {
      return {
        kind: 'rag_corpus_stage_import_plan',
        status: 'dry_run_stage_import_ready',
        ...base,
      };
    }
    const { stagedFiles, operation, warnings, resolved, importResultSink, submissionReceipt } = await this.executeStageImport(stage);
    return {
      kind: 'rag_corpus_stage_import_result',
      status: 'staged_and_import_requested',
      ...base,
      resolved_corpus: resolvedCorpusRecord(resolved),
      staged_files: stagedFiles,
      ...(importResultSink ? { import_result_sink: importResultSink } : {}),
      submission_receipt: submissionReceipt,
      ...([...resolutionWarnings, ...warnings].length ? { warnings: [...resolutionWarnings, ...warnings] } : {}),
      operation,
    };
  }

  /**
   * The subprocess boundary for web_import. The environment is built twice
   * over: the allowlist is what keeps worker credentials that are not
   * credential-shaped by name — an inline service-account JSON, for one — out
   * of the extractor, and the shared credential strip is the ruled gate the
   * ingest CLI applies to the same binary.
   */
  private extractionRuntime(): ExtractionRuntimeContext {
    return {
      binaryPath: this.summarizeBin,
      dataDir: this.dataDir,
      env: {
        ...process.env,
        ...(this.ytDlpBin ? { YT_DLP_PATH: this.ytDlpBin } : {}),
      },
      timeoutMs: SUMMARIZE_EXTRACT_TIMEOUT_MS,
      extract: this.summarizeExtract,
    };
  }

  private async webRagImport(params: RagCorpusParams, dryRun: boolean): Promise<unknown> {
    const manifest = this.manifest(params.domainId);
    const corpusId = params.corpusId ?? defaultCorpusId(manifest);
    const urls = params.urls ?? [];
    if (urls.length === 0 || urls.length > 200) {
      throw new DomainExpertWorkerError(400, 'invalid_params', 'rag_corpus web_import requires urls with 1 to 200 entries.');
    }
    const includeMedia = params.includeMedia ?? false;
    const transcriptMode = params.transcriptMode ?? 'auto';
    const root = this.rootFor(manifest.workspace_root_id);
    const rootPath = await checkedRootPath(root);
    const batchId = normalizeStageBatchId(params.batchId ?? randomUUID());
    const importWorkspaceRelativePath = `${manifest.workspace_relative_path}/sources/web-imports/${batchId}`;
    const importPath = await resolveWritePathInside(rootPath, importWorkspaceRelativePath);
    const fetchedAt = new Date().toISOString();
    const budget = webImportBudget();
    const guardedFetch = (url: string) => guardedWebImportFetch({
      url,
      fetchImpl: this.webImportFetchImpl,
      resolveHost: this.resolveHostImpl,
      budget,
      timeoutMs: this.webImportFetchTimeoutMs,
    });
    const mediaDestination = stageDestination(manifest.allowed_gcs_prefixes, manifest.domain_id, batchId);
    const derivation = await deriveWebImportFiles({
      urls,
      includeMedia,
      transcriptMode,
      dryRun,
      fetchedAt,
      fetch: guardedFetch,
      extraction: this.extractionRuntime(),
    });
    const writePreflight = preflightDerivativeWrites(
      derivation.files,
      root.maxWriteBytes,
      importWorkspaceRelativePath,
    );

    if (!dryRun && writePreflight.files.length > 0) {
      await mkdir(importPath, { recursive: true, mode: 0o700 });
      for (const file of writePreflight.files) {
        const absolutePath = await resolveWritePathInside(importPath, file.fileName);
        await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
        await writeWorkspaceImportFile(absolutePath, file.bytes, `${importWorkspaceRelativePath}/${file.fileName}`);
      }
    }

    const stage = dryRun
      ? await this.planWebImportDerivatives({
        manifest,
        importPath,
        importWorkspaceRelativePath,
        batchId,
        corpusId,
        includeMedia,
        files: writePreflight.files,
      })
      : await this.planStageImportDirectory({
        manifest,
        rootPath,
        workspaceRelativePath: importWorkspaceRelativePath,
        batchId,
        corpusId,
        includeMedia,
      }).catch((error) => {
        if (writePreflight.files.length === 0 && error instanceof DomainExpertWorkerError && error.code === 'workspace_path_not_found') {
          return undefined;
        }
        throw error;
      });
    const eligible = stage?.eligible ?? [];
    const skipped = [...writePreflight.skipped, ...(stage?.skipped ?? [])];
    const totalBytes = stage?.totalBytes ?? 0;
    const destination = stage?.destination ?? mediaDestination;
    const resolved = stage?.resolved ?? await this.resolveRagCorpus(manifest, corpusId);
    const resolvedCorpus = stage?.resolvedCorpus ?? resolvedCorpusRecord(resolved);
    const resolutionWarnings = ragCorpusWarnings(resolved);
    const provenanceUrls = urls.map(webImportProvenanceUrl);
    const base = {
      action: 'web_import',
      domain_id: manifest.domain_id,
      source: {
        urls: provenanceUrls,
        include_media: includeMedia,
        transcript_mode: transcriptMode,
        transcript_mode_effect: WEB_IMPORT_TRANSCRIPT_MODE_EFFECT,
        transcript_mode_note: WEB_IMPORT_TRANSCRIPT_MODE_NOTE,
        extractor: [...new Set(derivation.urlResults.map((result) => result.extractor).filter(Boolean))].join(', ') || 'direct-file',
        batch_id: batchId,
        workspace_root_id: manifest.workspace_root_id,
        workspace_relative_path: importWorkspaceRelativePath,
      },
      handler_table: WEB_IMPORT_HANDLERS.map((handler) => handler.id),
      fetch_policy: {
        https_only: true,
        private_ip_denied: true,
        max_fetch_bytes: WEB_IMPORT_MAX_FETCH_BYTES,
        max_batch_bytes: WEB_IMPORT_MAX_BATCH_BYTES,
        max_fetches: WEB_IMPORT_MAX_FETCHES,
        timeout_ms: this.webImportFetchTimeoutMs,
        text_default_max_processing_bytes: STAGE_IMPORT_MAX_FILE_BYTES,
        pdf_max_processing_bytes: PDF_PROCESSING_MAX_BYTES,
        media_max_file_bytes: MEDIA_TRANSCRIBE_MAX_BYTES,
        media_bytes_count_against_text_batch_cap: false,
        extraction_fetch_performed_by: {
          local_input: WEB_IMPORT_WORKER_FETCHER,
          youtube_url: SUMMARIZE_BINARY,
        },
        extraction_timeout_ms: SUMMARIZE_EXTRACT_TIMEOUT_MS,
        // A dry run reports real byte counts, which means it really extracts.
        // It writes nothing and uploads nothing.
        extraction_performed_in_dry_run: true,
      },
      destination: {
        gcs_uri_prefix: destination.directoryUri,
        bucket: destination.bucket,
        object_prefix: destination.objectPrefix,
        batch_id: batchId,
        allowed_gcs_prefixes: manifest.allowed_gcs_prefixes,
      },
      resolved_corpus: resolvedCorpus,
      derived_files: derivation.files.map((file) => ({
        source_url: webImportProvenanceUrl(file.sourceUrl),
        final_url: webImportProvenanceUrl(file.finalUrl),
        kind: file.kind,
        workspace_relative_path: `${importWorkspaceRelativePath}/${file.fileName}`,
        bytes: file.bytes.byteLength,
        sha256: sha256(file.bytes),
        ...(file.warnings?.length ? { warnings: file.warnings } : {}),
      })),
      url_results: derivation.urlResults,
      errors: derivation.errors,
      eligible_files: eligible.map((file) => ({
        workspace_relative_path: file.workspaceRelativePath,
        upload_relative_path: file.uploadRelativePath,
        bytes: file.bytes,
        gcs_uri: file.gcsUri,
      })),
      skipped_files: skipped,
      eligible_file_count: eligible.length,
      skipped_file_count: skipped.length,
      total_eligible_bytes: totalBytes,
      ...(resolutionWarnings.length ? { warnings: resolutionWarnings } : {}),
      policy: domainPolicy(),
    };
    if (dryRun) {
      return {
        kind: 'rag_corpus_web_import_plan',
        status: eligible.length > 0 ? 'dry_run_web_import_ready' : 'dry_run_web_import_no_importable_files',
        ...base,
      };
    }
    if (!stage || eligible.length === 0) {
      return {
        kind: 'rag_corpus_web_import_result',
        status: 'web_import_no_importable_files',
        ...base,
      };
    }
    const { stagedFiles, operation, warnings, resolved: importResolved, importResultSink, submissionReceipt } = await this.executeStageImport(stage);
    const importResolvedCorpus = resolvedCorpusRecord(importResolved);
    await this.appendWebImportRegistryRecord({
      manifest,
      rootPath,
      urls,
      batchId,
      importWorkspaceRelativePath,
      resolvedCorpus: importResolvedCorpus,
      stagedFileCount: stagedFiles.length,
    });
    return {
      kind: 'rag_corpus_web_import_result',
      status: 'staged_and_import_requested',
      ...base,
      resolved_corpus: importResolvedCorpus,
      staged_files: stagedFiles,
      ...(importResultSink ? { import_result_sink: importResultSink } : {}),
      submission_receipt: submissionReceipt,
      ...([...resolutionWarnings, ...warnings].length ? { warnings: [...resolutionWarnings, ...warnings] } : {}),
      operation,
    };
  }

  private async planWebImportDerivatives(input: {
    manifest: ReturnType<typeof domainManifest>;
    importPath: string;
    importWorkspaceRelativePath: string;
    batchId: string;
    corpusId: string;
    includeMedia: boolean;
    files: WebImportDerivedFile[];
  }): Promise<{
    destination: ReturnType<typeof stageDestination>;
    batchId: string;
    eligible: StageImportEligibleFile[];
    skipped: StageImportSkippedFile[];
    totalBytes: number;
    resolved: ResolvedRagCorpus;
    resolvedCorpus: Record<string, unknown>;
    manifest: ReturnType<typeof domainManifest>;
  }> {
    const destination = stageDestination(input.manifest.allowed_gcs_prefixes, input.manifest.domain_id, input.batchId);
    const candidates = input.files.map((file) => ({
      workspaceRelativePath: `${input.importWorkspaceRelativePath}/${file.fileName}`,
      uploadRelativePath: file.fileName,
      absolutePath: resolveInside(input.importPath, file.fileName),
      bytes: file.bytes.byteLength,
    }));
    const { eligible, skipped, totalBytes } = planStageImportCandidates(
      candidates,
      destination.bucket,
      destination.objectPrefix,
      { includeMedia: input.includeMedia },
    );
    const resolved = await this.resolveRagCorpus(input.manifest, input.corpusId);
    return {
      destination,
      batchId: input.batchId,
      eligible,
      skipped,
      totalBytes,
      resolved,
      resolvedCorpus: resolvedCorpusRecord(resolved),
      manifest: input.manifest,
    };
  }

  private async notionRagImport(params: RagCorpusParams, dryRun: boolean): Promise<unknown> {
    if (!this.notion.configured()) {
      throw new DomainExpertWorkerError(
        503,
        'notion_not_configured',
        DOMAIN_EXPERT_NOTION_CREDENTIAL_GUIDANCE,
      );
    }
    const manifest = this.manifest(params.domainId);
    const corpusId = params.corpusId ?? defaultCorpusId(manifest);
    const batchId = normalizeStageBatchId(params.batchId ?? randomUUID());
    const importWorkspaceRelativePath = `${manifest.workspace_relative_path}/sources/notion-imports/${batchId}`;
    const sources = notionImportSources(params);
    const maxObjects = this.notion.maxObjects();
    if (sources.length === 0 || sources.length > maxObjects) {
      throw new DomainExpertWorkerError(400, 'invalid_params', `rag_corpus notion_import requires 1 to ${maxObjects} urls, page_ids, or database_ids.`);
    }
    await this.notion.probe();
    const objectPlans: NotionImportObjectPlan[] = [];
    const errors: Array<Record<string, unknown>> = [];
    let skippedObjectCount = 0;
    for (const source of sources) {
      try {
        const metadata = await this.notion.inspectObject(source.id, source.type);
        const titleSlug = safeObjectName(metadata.title || metadata.objectId);
        objectPlans.push({
          object_id: metadata.objectId,
          object_type: metadata.objectType,
          title: metadata.title,
          ...(source.url ? { source_url: source.url } : {}),
          ...(metadata.childBlockCount !== undefined ? { child_block_count: metadata.childBlockCount } : {}),
          ...(metadata.rowPageCount !== undefined ? { row_page_count: metadata.rowPageCount } : {}),
          workspace_relative_path: `${importWorkspaceRelativePath}/${titleSlug}-${metadata.objectId.slice(0, 8)}.md`,
          ...(metadata.warnings.length ? { warnings: metadata.warnings } : {}),
        });
        skippedObjectCount += metadata.skippedObjectCount;
      } catch (error) {
        errors.push(notionImportErrorForObject(error, source));
      }
    }
    const destination = stageDestination(manifest.allowed_gcs_prefixes, manifest.domain_id, batchId);
    const base = {
      action: 'notion_import',
      domain_id: manifest.domain_id,
      source: {
        urls: (params.urls ?? []).map(sanitizeNotionSourceUrl),
        page_ids: (params.pageIds ?? []).map(normalizeNotionObjectId),
        database_ids: (params.databaseIds ?? []).map(normalizeNotionObjectId),
        batch_id: batchId,
        workspace_root_id: manifest.workspace_root_id,
        workspace_relative_path: importWorkspaceRelativePath,
      },
      api_policy: {
        base_url: NOTION_BASE_URL,
        notion_version: this.notion.notionVersion(),
        max_starting_objects: maxObjects,
        block_depth_cap: NOTION_DEFAULT_DEPTH,
        media_downloads: false,
        retry_429: true,
      },
      destination: {
        gcs_uri_prefix: destination.directoryUri,
        bucket: destination.bucket,
        object_prefix: destination.objectPrefix,
        batch_id: batchId,
        allowed_gcs_prefixes: manifest.allowed_gcs_prefixes,
      },
      corpus: {
        corpus_id: corpusId,
        backend: manifest.rag_backend,
        gcp_project: manifest.gcp_project,
        location: manifest.rag_location,
      },
      derived_files: objectPlans,
      object_count: objectPlans.length,
      skipped_object_count: skippedObjectCount,
      errors,
      policy: domainPolicy(),
    };
    if (dryRun) {
      return {
        kind: 'rag_corpus_notion_import_plan',
        status: objectPlans.length > 0 ? 'dry_run_notion_import_ready' : 'dry_run_notion_import_no_importable_objects',
        ...base,
      };
    }
    const root = this.rootFor(manifest.workspace_root_id);
    const rootPath = await checkedRootPath(root);
    const importPath = await resolveWritePathInside(rootPath, importWorkspaceRelativePath);
    const retrievedAt = new Date().toISOString();
    const markdownFiles: NotionMarkdownDerivative[] = [];
    const liveErrors = [...errors];
    const notionWarnings: string[] = [];
    for (const plan of objectPlans) {
      const source = sources.find((candidate) => candidate.id === plan.object_id);
      try {
        if (plan.object_type === 'database') {
          const database = await this.notion.listDatabasePages(plan.object_id);
          for (const warning of database.warnings) {
            notionWarnings.push(warning);
            if (!plan.warnings?.includes(warning)) plan.warnings = [...(plan.warnings ?? []), warning];
          }
          for (const page of database.pages) {
            markdownFiles.push(await this.notion.fetchPageMarkdown({
              id: page.objectId,
              retrievedAt,
              filePrefix: database.databaseTitle,
            }));
          }
        } else {
          markdownFiles.push(await this.notion.fetchPageMarkdown({
            id: plan.object_id,
            ...(source?.url ? { sourceUrl: source.url } : {}),
            retrievedAt,
          }));
        }
      } catch (error) {
        liveErrors.push(notionImportErrorForObject(error, {
          id: plan.object_id,
          type: plan.object_type,
          ...(source?.url ? { url: source.url } : {}),
        }));
      }
    }
    const writePreflight = preflightDerivativeWrites(
      markdownFiles,
      root.maxWriteBytes,
      importWorkspaceRelativePath,
    );
    if (writePreflight.files.length > 0) {
      await mkdir(importPath, { recursive: true, mode: 0o700 });
      for (const file of writePreflight.files) {
        const absolutePath = await resolveWritePathInside(importPath, file.fileName);
        await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
        await writeWorkspaceImportFile(absolutePath, file.bytes, `${importWorkspaceRelativePath}/${file.fileName}`);
      }
    }
    const stage = writePreflight.files.length > 0
      ? await this.planStageImportDirectory({
          manifest,
          rootPath,
          workspaceRelativePath: importWorkspaceRelativePath,
          batchId,
          corpusId,
          includeMedia: false,
        })
      : undefined;
    const eligible = stage?.eligible ?? [];
    const skipped = [...writePreflight.skipped, ...(stage?.skipped ?? [])];
    const totalBytes = stage?.totalBytes ?? 0;
    const resolved = stage?.resolved ?? await this.resolveRagCorpus(manifest, corpusId);
    const resolutionWarnings = ragCorpusWarnings(resolved);
    const liveBase = {
      ...base,
      errors: liveErrors,
      ...(notionWarnings.length ? { notion_warnings: [...new Set(notionWarnings)] } : {}),
      derived_files: markdownFiles.map((file) => ({
        source_url: file.sourceUrl,
        notion_object_id: file.objectId,
        notion_object_type: file.objectType,
        title: file.title,
        workspace_relative_path: `${importWorkspaceRelativePath}/${file.fileName}`,
        bytes: file.bytes.byteLength,
        ...(file.parentPageId ? { parent_page_id: file.parentPageId } : {}),
        ...(file.parentDatabaseId ? { parent_database_id: file.parentDatabaseId } : {}),
        ...(file.warnings.length ? { warnings: [...new Set(file.warnings)] } : {}),
      })),
      eligible_files: eligible.map((file) => ({
        workspace_relative_path: file.workspaceRelativePath,
        upload_relative_path: file.uploadRelativePath,
        bytes: file.bytes,
        gcs_uri: file.gcsUri,
      })),
      skipped_files: skipped,
      eligible_file_count: eligible.length,
      skipped_file_count: skipped.length,
      total_eligible_bytes: totalBytes,
      ...(resolutionWarnings.length ? { warnings: resolutionWarnings } : {}),
    };
    if (!stage || eligible.length === 0) {
      return {
        kind: 'rag_corpus_notion_import_result',
        status: 'notion_import_no_importable_files',
        ...liveBase,
      };
    }
    const { stagedFiles, operation, warnings, resolved: importResolved, importResultSink, submissionReceipt } = await this.executeStageImport(stage);
    const importResolvedCorpus = resolvedCorpusRecord(importResolved);
    await this.appendNotionImportRegistryRecord({
      manifest,
      rootPath,
      sources,
      batchId,
      importWorkspaceRelativePath,
      resolvedCorpus: importResolvedCorpus,
      stagedFileCount: stagedFiles.length,
    });
    return {
      kind: 'rag_corpus_notion_import_result',
      status: 'staged_and_import_requested',
      ...liveBase,
      corpus: {
        ...base.corpus,
        resolved_corpus: importResolvedCorpus,
      },
      staged_files: stagedFiles,
      ...(importResultSink ? { import_result_sink: importResultSink } : {}),
      submission_receipt: submissionReceipt,
      ...([...resolutionWarnings, ...warnings].length ? { warnings: [...resolutionWarnings, ...warnings] } : {}),
      operation,
    };
  }

  private async planStageImportDirectory(input: {
    manifest: ReturnType<typeof domainManifest>;
    rootPath: string;
    workspaceRelativePath: string;
    batchId: string;
    corpusId: string;
    includeMedia: boolean;
  }): Promise<{
    destination: ReturnType<typeof stageDestination>;
    batchId: string;
    eligible: StageImportEligibleFile[];
    skipped: StageImportSkippedFile[];
    totalBytes: number;
    resolved: ResolvedRagCorpus;
    resolvedCorpus: Record<string, unknown>;
    manifest: ReturnType<typeof domainManifest>;
  }> {
    const targetPath = resolveInside(input.rootPath, input.workspaceRelativePath);
    const destination = stageDestination(input.manifest.allowed_gcs_prefixes, input.manifest.domain_id, input.batchId);
    const { eligible, skipped, totalBytes } = await planStageImportFiles(
      input.rootPath,
      targetPath,
      destination.bucket,
      destination.objectPrefix,
      { includeMedia: input.includeMedia },
    );
    const resolved = await this.resolveRagCorpus(input.manifest, input.corpusId);
    return {
      destination,
      batchId: input.batchId,
      eligible,
      skipped,
      totalBytes,
      resolved,
      resolvedCorpus: resolvedCorpusRecord(resolved),
      manifest: input.manifest,
    };
  }

  private async executeStageImport(stage: {
    destination: ReturnType<typeof stageDestination>;
    batchId: string;
    eligible: StageImportEligibleFile[];
    resolved: ResolvedRagCorpus;
    manifest: ReturnType<typeof domainManifest>;
  }): Promise<{ stagedFiles: Array<Record<string, unknown>>; operation: unknown; warnings: Array<Record<string, unknown> | RagCorpusWarning>; resolved: ResolvedRagCorpus; importResultSink: string | undefined; submissionReceipt: Record<string, unknown> }> {
    const stagedFiles: Array<Record<string, unknown>> = [];
    const warnings: Array<Record<string, unknown> | RagCorpusWarning> = [];
    for (const file of stage.eligible) {
      const bytes = new Uint8Array(await readFile(file.absolutePath));
      if (bytes.byteLength !== file.bytes || bytes.byteLength > maxStageFileBytes(file.workspaceRelativePath)) {
        throw new DomainExpertWorkerError(409, 'stage_import_file_changed', `${file.workspaceRelativePath} changed during staging.`);
      }
      await this.google.uploadGcsObject(stage.destination.bucket, file.objectName, bytes);
      const stagedFile = {
        workspace_relative_path: file.workspaceRelativePath,
        upload_relative_path: file.uploadRelativePath,
        gcs_uri: file.gcsUri,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
      };
      stagedFiles.push(stagedFile);
      if (isTranscribableMediaPath(file.workspaceRelativePath)) {
        const mimeType = mediaMimeType(file.workspaceRelativePath);
        try {
          const transcript = await transcribeMediaFromGcs({
            project: stage.manifest.gcp_project,
            location: stage.manifest.rag_location,
            sourceUrl: file.workspaceRelativePath,
            title: basename(file.workspaceRelativePath),
            kind: 'media',
            retrievedAt: new Date().toISOString(),
            transcriptSource: 'asr',
            gcsUri: file.gcsUri,
            mimeType,
            transcribe: (input) => this.google.transcribeMedia({
              project: stage.manifest.gcp_project,
              location: stage.manifest.rag_location,
              model: this.google.transcribeModel(),
              ...input,
            }),
          });
          const transcriptObjectName = `${stage.destination.objectPrefix}${safeGcsRelativePath(`${file.uploadRelativePath}.transcript.md`)}`;
          await this.google.uploadGcsObject(stage.destination.bucket, transcriptObjectName, transcript.bytes);
          stagedFiles.push({
            workspace_relative_path: `${file.workspaceRelativePath}.transcript.md`,
            upload_relative_path: `${file.uploadRelativePath}.transcript.md`,
            kind: 'media_transcript',
            transcript_source: 'asr',
            source_media_gcs_uri: file.gcsUri,
            gcs_uri: `gs://${stage.destination.bucket}/${transcriptObjectName}`,
            bytes: transcript.bytes.byteLength,
            sha256: sha256(transcript.bytes),
          });
        } catch (error) {
          warnings.push({
            workspace_relative_path: file.workspaceRelativePath,
            code: error instanceof DomainExpertWorkerError ? error.code : 'media_transcription_failed',
            message: error instanceof Error ? error.message : 'Media transcription failed.',
            ...(error instanceof DomainExpertWorkerError && error.stderrTail ? { stderr_tail: error.stderrTail } : {}),
          });
        }
      }
    }
    const importResultSink = this.agentRouting[stage.manifest.domain_id]?.ingestion?.importResultSink === 'client'
      ? undefined : importResultSinkUri(stage.manifest.allowed_gcs_prefixes, stage.manifest.domain_id, stage.batchId);
    const retry = await this.withRagCorpusRetry(stage.manifest, stage.resolved, async (candidate) => {
      await this.deleteErrorRagFileRecords(stage.manifest, candidate, [stage.destination.directoryUri]);
      return this.submitRagImport({
        project: stage.manifest.gcp_project,
        location: stage.manifest.rag_location,
        corpusName: candidate.resourceName,
        gcsUri: stage.destination.directoryUri,
        ...(importResultSink ? { importResultGcsSink: importResultSink } : {}),
        chunkTokens: stage.manifest.chunking.chunk_tokens,
        chunkOverlap: stage.manifest.chunking.chunk_overlap,
        // The request imports the whole staging directory, so the parser choice
        // is made against every file that was staged into it.
        llmParserEligible: llmParserEligibleUris(stagedFiles.map((file) => String(file.gcs_uri))),
      });
    });
    warnings.push(...retry.warnings);
    return { stagedFiles, operation: retry.value.operation, submissionReceipt: retry.value.submissionReceipt, warnings, resolved: retry.resolved, importResultSink };
  }

  private async submitRagImport(options: Parameters<GoogleRuntimeClient['importRagFiles']>[0]): Promise<{
    operation: unknown; submissionReceipt: Record<string, unknown>;
  }> {
    const submissionId = randomUUID();
    const receipt = {
      schema_version: 1, kind: 'rag_import_submission', submission_id: submissionId,
      submitted_at: new Date().toISOString(), corpus_resource_name: options.corpusName,
      source_reference_sha256: sha256(new TextEncoder().encode(options.gcsUri ?? options.driveFileId ?? '')),
      status: 'submission_pending',
    };
    const directory = join(this.dataDir, 'import-submissions');
    const receiptPath = join(directory, `${submissionId}.json`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // If durable intent cannot be written, fail before the provider write.
    await writeJsonFileAtomically(receiptPath, receipt);
    let operation: unknown;
    try {
      operation = await this.google.importRagFiles(options);
    } catch (error) {
      // The pending receipt remains durable even if this update cannot persist.
      await writeJsonFileAtomically(receiptPath, { ...receipt, status: 'submission_unknown' }).catch(() => undefined);
      throw error;
    }
    let result = vertexImportSubmissionReceipt(operation, options.corpusName);
    if (!result) {
      const candidate = vertexImportOperationCandidate(operation, options);
      if (candidate) {
        // Retain the private candidate before the independent scoped read. It
        // cannot be promoted to a public receipt until that read proves identity.
        await writeJsonFileAtomically(receiptPath, { ...receipt, operation_name_candidate: candidate.name });
        const alias = await this.google.verifyRagImportOperationAlias(options, operation);
        result = vertexImportSubmissionReceipt(operation, options.corpusName, alias);
      }
    }
    if (!result) {
      throw new DomainExpertWorkerError(502, 'rag_import_operation_scope_invalid',
        'The import returned an untrusted operation reference.',
        `Submission ${submissionId} requires reconciliation before another import.`);
    }
    const submissionReceipt = { ...receipt, ...result };
    try {
      await writeJsonFileAtomically(receiptPath, submissionReceipt);
    } catch {
      throw new DomainExpertWorkerError(500, 'rag_import_receipt_write_failed',
        'The import was submitted but its operation receipt could not be updated.',
        `Reconcile operation ${result.operation_name} for submission ${submissionId} before another import.`);
    }
    return { operation, submissionReceipt };
  }

  // Vertex importRagFiles dedupes new files against every existing record for
  // the same source URI — including ERROR-state records — so a retry of a
  // failed import reports skippedRagFilesCount and silently does nothing.
  // Verified live 2026-07-29 against a shared-library corpus: embedding-backend
  // 429s left ERROR records behind, and every retry no-oped until those records
  // were deleted first. Live imports therefore clear ERROR records for their
  // target URIs before importing.
  private async deleteErrorRagFileRecords(
    manifest: ReturnType<typeof domainManifest>,
    resolved: ResolvedRagCorpus,
    targetUris: string[],
  ): Promise<void> {
    const errorRecords: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.google.listRagFiles({
        project: manifest.gcp_project,
        location: manifest.rag_location,
        corpusName: resolved.resourceName,
        ...(pageToken ? { pageToken } : {}),
      });
      for (const file of page.files) {
        if (file.state === 'ERROR' && ragFileMatchesTargets(file, targetUris)) {
          errorRecords.push(String(file.name));
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    for (const ragFileName of errorRecords) {
      try {
        await this.google.deleteRagFile({
          project: manifest.gcp_project,
          location: manifest.rag_location,
          ragFileName,
        });
      } catch (error) {
        // A concurrent retry may have deleted the record already; gone is the goal.
        if (error instanceof DomainExpertWorkerError && error.status === 404) continue;
        throw error;
      }
    }
    if (errorRecords.length > 0) {
      console.info(JSON.stringify({
        kind: 'domain_expert_rag_error_record_cleanup',
        domain_id: manifest.domain_id,
        corpus_id: resolved.corpusId,
        deleted_count: errorRecords.length,
      }));
    }
  }

  private async appendWebImportRegistryRecord(input: {
    manifest: ReturnType<typeof domainManifest>;
    rootPath: string;
    urls: string[];
    batchId: string;
    importWorkspaceRelativePath: string;
    resolvedCorpus: Record<string, unknown>;
    stagedFileCount: number;
  }): Promise<void> {
    const urls = input.urls.map(webImportProvenanceUrl);
    const registryPath = resolveInside(input.rootPath, `${input.manifest.workspace_relative_path}/references/source-registry.jsonl`);
    await mkdir(dirname(registryPath), { recursive: true });
    await this.appendRegistryJsonLine(registryPath, {
      source_id: `${input.manifest.domain_id}-web-import-${input.batchId}`,
      domain_id: input.manifest.domain_id,
      kind: 'web_import',
      urls,
      batch_id: input.batchId,
      corpus: input.resolvedCorpus,
      staged_file_count: input.stagedFileCount,
      workspace_relative_path: input.importWorkspaceRelativePath,
      target_corpus_id: input.resolvedCorpus.requested,
      trust_posture: input.manifest.trust_posture,
      ingest_status: 'import_requested',
      timestamp: new Date().toISOString(),
    });
  }

  private async appendNotionImportRegistryRecord(input: {
    manifest: ReturnType<typeof domainManifest>;
    rootPath: string;
    sources: NotionImportSource[];
    batchId: string;
    importWorkspaceRelativePath: string;
    resolvedCorpus: Record<string, unknown>;
    stagedFileCount: number;
  }): Promise<void> {
    const registryPath = resolveInside(input.rootPath, `${input.manifest.workspace_relative_path}/references/source-registry.jsonl`);
    await mkdir(dirname(registryPath), { recursive: true });
    await this.appendRegistryJsonLine(registryPath, {
      source_id: `${input.manifest.domain_id}-notion-import-${input.batchId}`,
      domain_id: input.manifest.domain_id,
      kind: 'notion_import',
      notion_object_ids: input.sources.map((source) => source.id),
      urls: input.sources.map((source) => source.url).filter((url): url is string => typeof url === 'string'),
      batch_id: input.batchId,
      corpus: input.resolvedCorpus,
      staged_file_count: input.stagedFileCount,
      workspace_relative_path: input.importWorkspaceRelativePath,
      target_corpus_id: input.resolvedCorpus.requested,
      trust_posture: input.manifest.trust_posture,
      ingest_status: 'import_requested',
      timestamp: new Date().toISOString(),
    });
  }

  private async domainDoc(params: DomainDocParams): Promise<unknown> {
    const dryRun = params.dryRun ?? true;
    const manifest = this.manifest(params.domainId);
    const plan = planDomainDoc({ ...params, dryRun: true }, manifest);
    if (dryRun) return plan;
    requireConfiguredAgent(manifest, 'domain_doc');
    const action = params.action;
    if (action === 'read') {
      const doc = await this.google.getDocument(params.documentId);
      return documentReadResult(manifest.domain_id, doc);
    }
    if (action === 'comment') {
      return {
        kind: 'domain_doc_result',
        status: 'comment_created',
        domain_id: manifest.domain_id,
        document_id: params.documentId,
        comment: await this.google.createDriveComment(params.documentId, requireString(params.comment, 'comment')),
        policy: domainPolicy(),
      };
    }
    if (action === 'visual_insert' || action === 'visual_replace') {
      requireApprovalId(params.approvalId, action);
      const editBatchId = params.editBatchId ?? randomUUID();
      const doc = await this.google.getDocument(params.documentId);
      const insertIndex = params.rangeStart ?? documentEndIndex(doc);
      const text = `${manifest.visual_review_style.prefix_marker} ${requireString(params.text, 'text')}`;
      const priorText = action === 'visual_replace'
        ? extractDocumentTextRange(doc, requireNumber(params.rangeStart, 'range_start'), requireNumber(params.rangeEnd, 'range_end'))
        : undefined;
      const requests: Array<Record<string, unknown>> = [];
      if (action === 'visual_replace') {
        requests.push({ deleteContentRange: { range: { startIndex: params.rangeStart, endIndex: params.rangeEnd } } });
      }
      requests.push(
        { insertText: { location: { index: insertIndex }, text } },
        {
          updateTextStyle: {
            range: { startIndex: insertIndex, endIndex: insertIndex + text.length },
            textStyle: styleFromManifest(manifest),
            fields: 'foregroundColor,backgroundColor',
          },
        },
      );
      const batchUpdate = await this.google.batchUpdateDocument(params.documentId, requests);
      if (params.comment) await this.google.createDriveComment(params.documentId, params.comment);
      const ledger: VisualEditLedgerRecord = {
        kind: 'domain_doc_visual_edit',
        edit_batch_id: editBatchId,
        domain_id: manifest.domain_id,
        document_id: params.documentId,
        action,
        inserted_text: text,
        inserted_start_index: insertIndex,
        inserted_end_index: insertIndex + text.length,
        ...(priorText !== undefined ? { prior_text: priorText } : {}),
        created_at: new Date().toISOString(),
        ...(params.approvalId ? { approval_id: params.approvalId } : {}),
      };
      await appendLedger(this.dataDir, ledger);
      return {
        kind: 'domain_doc_result',
        status: 'visual_edit_created',
        domain_id: manifest.domain_id,
        document_id: params.documentId,
        edit_batch_id: editBatchId,
        batch_update: batchUpdate,
        visual_review_style: manifest.visual_review_style,
        policy: domainPolicy(),
      };
    }
    return this.cleanupVisualEdit(manifest.domain_id, params);
  }

  private async cleanupVisualEdit(domainId: string, params: DomainDocParams): Promise<unknown> {
    const editBatchId = requireString(params.editBatchId, 'edit_batch_id');
    const ledger = await findLedgerRecord(this.dataDir, editBatchId);
    if (!ledger) throw new DomainExpertWorkerError(404, 'edit_batch_not_found', 'No visual edit ledger entry found for edit_batch_id.');
    if (ledger.document_id !== params.documentId || ledger.domain_id !== domainId) {
      throw new DomainExpertWorkerError(403, 'edit_batch_mismatch', 'The edit batch does not belong to this domain/document.');
    }
    if (params.action === 'accept_visual_edits') {
      const requests: Array<Record<string, unknown>> = [{
        updateTextStyle: {
          range: { startIndex: ledger.inserted_start_index, endIndex: ledger.inserted_end_index },
          textStyle: {},
          fields: 'foregroundColor,backgroundColor',
        },
      }];
      return {
        kind: 'domain_doc_result',
        status: 'visual_edit_accepted',
        domain_id: domainId,
        document_id: params.documentId,
        edit_batch_id: editBatchId,
        batch_update: await this.google.batchUpdateDocument(params.documentId, requests),
        policy: domainPolicy(),
      };
    }
    const requests: Array<Record<string, unknown>> = [
      {
        deleteContentRange: {
          range: {
            startIndex: ledger.inserted_start_index,
            endIndex: ledger.inserted_end_index,
          },
        },
      },
    ];
    if (ledger.action === 'visual_replace' && ledger.prior_text) {
      requests.push({ insertText: { location: { index: ledger.inserted_start_index }, text: ledger.prior_text } });
    }
    return {
      kind: 'domain_doc_result',
      status: 'visual_edit_rejected',
      domain_id: domainId,
      document_id: params.documentId,
      edit_batch_id: editBatchId,
      batch_update: await this.google.batchUpdateDocument(params.documentId, requests),
      policy: domainPolicy(),
    };
  }

  private async annasSearch(params: AnnasArchiveSearchParams): Promise<unknown> {
    // Validates the request the same way it always has; the plan itself is no
    // longer a thing this method can return.
    planAnnasArchiveSearch(params, this.manifest(params.domainId));
    const query = params.query ?? params.topic;
    // Anna Archive publishes no JSON search API, so base-URL mode drives the HTML search
    // page, which reads only q and lang. A configured template keeps its own placeholders.
    const url = this.annas.searchUrlTemplate
      ? annasUrl(this.annas.searchUrlTemplate, undefined, '/search', {
        query,
        topic: params.topic,
        title: params.title,
        author: params.author,
        language: params.language,
        max_results: String(params.maxResults ?? Math.max(params.topN ?? 10, 10)),
      })
      : annasUrl(undefined, this.annas.baseUrl, '/search', {
        q: query ?? params.title ?? params.author,
        lang: params.language,
      });
    // An unconfigured backend is a refusal, not a plan. Returning planning text
    // here would answer a live search with a shape that reads like progress
    // while nothing was searched — the same deception that let a plugin own no
    // tools and still look healthy. Every sibling acquisition path already
    // refuses with this code; search was the one that did not.
    if (!url) {
      throw new DomainExpertWorkerError(
        503,
        'annas_archive_not_configured',
        'Anna Archive base URL or search URL template is required for live search.',
        'Set EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_ARCHIVE_BASE_URL on the worker host.',
      );
    }
    if (!this.annas.apiKey) {
      throw new DomainExpertWorkerError(
        503,
        'annas_archive_not_configured',
        'Anna Archive API key is not configured.',
        'Set EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_ARCHIVE_API_KEY on the worker host.',
      );
    }
    let items: unknown[];
    let backend: 'annas_archive' | 'libgen_fallback' = 'annas_archive';
    const warnings: string[] = [];
    try {
      const { response } = await fetchAnnasCredentialed(this.fetchImpl, url, {
        config: this.annas,
        apiKey: this.annas.apiKey,
        purpose: 'search',
      });
      const body = await responseTextOrJson(response);
      if (!response.ok) {
        throw new DomainExpertWorkerError(response.status, 'annas_archive_error', 'Anna Archive search failed.');
      }
      items = annasSearchCandidates(body);
    } catch (error) {
      // 2026-09-17: Anna Archive put its HTML search behind a browser check (302 to
      // ?check=1, then 403 for anything that is not a browser) while the member
      // download API kept answering. Search is discovery only: a Library Genesis
      // result carries the same md5 the fast-download path resolves, so the
      // acquisition contract does not change — only where the candidate list came
      // from, which the result says out loud. Anything else still fails honestly.
      if (!this.annas.libgenBaseUrl) throw error;
      const reason = error instanceof DomainExpertWorkerError ? `HTTP ${error.status}` : 'network failure';
      try {
        items = await this.libgenSearch(query ?? params.title ?? params.author ?? '');
      } catch (fallbackError) {
        const detail = fallbackError instanceof DomainExpertWorkerError ? `HTTP ${fallbackError.status}` : 'network failure';
        if (error instanceof DomainExpertWorkerError) {
          throw new DomainExpertWorkerError(error.status, error.code, error.message,
            `Anna Archive search failed (${reason}) and the Library Genesis fallback also failed (${detail}). Supply the item md5 to annas_archive_import directly.`);
        }
        throw error;
      }
      backend = 'libgen_fallback';
      warnings.push(`Anna Archive search failed (${reason}); candidates come from Library Genesis. Import still resolves each md5 through Anna Archive fast download.`);
    }
    const candidates = rankAnnasCandidates(items, params);
    return {
      kind: 'annas_archive_search_result',
      status: 'candidates_ready',
      domain_id: params.domainId ?? 'research',
      search: {
        ...(query ? { query } : {}),
        ...(params.topic ? { topic: params.topic } : {}),
        top_n: params.topN ?? params.maxResults ?? 10,
        format_preference: params.formatPreference ?? 'auto',
        ...(params.ingestIntent ? { ingest_intent: true } : {}),
        backend,
      },
      ...(warnings.length ? { warnings } : {}),
      candidates,
      approval_gate: {
        required_before_download: true,
        selection_fields: ['annas_archive_id or url', 'title', 'author', 'format', 'md5', 'copyright_posture'],
      },
      policy: domainPolicy(),
    };
  }

  /** Uncredentialed HTML search against the configured Library Genesis origin. */
  private async libgenSearch(query: string): Promise<unknown[]> {
    const q = query.trim();
    if (!q) throw new DomainExpertWorkerError(400, 'libgen_query_required', 'A query, title, or author is required for the Library Genesis fallback.');
    const base = this.annas.libgenBaseUrl!;
    const search = new URLSearchParams({ req: q, res: String(LIBGEN_SEARCH_PAGE_SIZE), filesuns: 'all' });
    for (const [key, value] of [['columns[]', 't'], ['columns[]', 'a'], ['objects[]', 'f'], ['topics[]', 'l']]) search.append(key!, value!);
    const url = `${base}/index.php?${search.toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIBGEN_SEARCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: { accept: 'text/html' }, redirect: 'follow', signal: controller.signal });
    } finally { clearTimeout(timer); }
    if (!response.ok) throw new DomainExpertWorkerError(response.status, 'libgen_error', 'Library Genesis search failed.');
    return parseLibgenSearchHtml(await response.text());
  }

  private async annasImport(params: AnnasArchiveImportParams): Promise<unknown> {
    const dryRun = params.dryRun ?? true;
    const manifest = this.manifest(params.domainId);
    const plan = planAnnasArchiveImport({ ...params, dryRun: true }, manifest);
    if (dryRun) return plan;
    requireApprovalId(params.approvalId, 'annas_archive_import');
    if (params.ingest && resolveTargetCorpus(params.corpusId, manifest)) requireGoogleProject(manifest.gcp_project);
    if (!this.annas.apiKey) throw new DomainExpertWorkerError(503, 'annas_archive_not_configured', 'Anna Archive API key is not configured.');
    // The owner naming a book authorizes the download regardless of routing
    // state (the skill's promise: an unrouted domain still downloads, and the
    // corpus decision is reported as pending). Cloud ingest self-gates below:
    // needs_corpus_decision fires before any cloud call when no corpus is
    // configured or named, and an explicit corpus from an unrouted domain is
    // refused by the empty GCS destination allowlist.
    const locator = params.annasArchiveId ?? params.url;
    const plannedFormat: NonNullable<AnnasArchiveImportParams['format']> = params.format && params.format !== 'unknown'
      ? params.format
      : extensionFormat(params.url ?? `${locator ?? 'download'}.pdf`) as NonNullable<AnnasArchiveImportParams['format']>;
    const plannedPath = await annasDownloadPlan(this.annasBooksRoot, { ...params, format: plannedFormat });
    const duplicate = await existingAnnasAcquisition(this.annasBooksRoot, params, plannedPath.targetPath);
    if (duplicate && params.ingest) return this.ingestExistingAnnasAcquisition(manifest, params, duplicate, locator);
    if (duplicate) {
      await appendAnnasAudit(this.annasBooksRoot, {
        kind: 'annas_archive_acquisition_audit',
        action: 'skipped_duplicate',
        domain_id: manifest.domain_id,
        approval_id: params.approvalId,
        selected: annasSelectionAudit(params),
        target_path: duplicate.targetPath,
        reason: duplicate.reason,
        created_at: new Date().toISOString(),
      });
      return {
        kind: 'annas_archive_import_result',
        status: 'skipped_duplicate',
        domain_id: manifest.domain_id,
        download: { status: 'skipped_duplicate', path: duplicate.targetPath, reason: duplicate.reason },
        rag_ingest: { status: 'not_requested' },
        registry: { status: 'skipped', reason: 'rag_ingest was not requested.' },
        policy: domainPolicy(),
      };
    }

    const { response, url: finalDownloadUrl } = this.annas.fastDownload
      ? await this.openAnnasFastDownload(params)
      : await this.openAnnasTemplateDownload(params, locator, plannedFormat);
    if (!response.ok) throw new DomainExpertWorkerError(response.status, 'annas_archive_error', 'Anna Archive download failed.');
    const bytes = await readCappedAnnasDownloadBody(response, finalDownloadUrl, this.annasDownloadTimeoutMs, this.annasMaxDownloadBytes);
    const format: NonNullable<AnnasArchiveImportParams['format']> = params.format && params.format !== 'unknown'
      ? params.format
      : extensionFormat(finalDownloadUrl) as NonNullable<AnnasArchiveImportParams['format']>;
    const finalPath = format === plannedFormat ? plannedPath : await annasDownloadPlan(this.annasBooksRoot, { ...params, format });
    const digest = sha256(bytes);
    await writeAnnasBookFile(finalPath.root, finalPath.relativePath, bytes);
    const download = {
      status: 'downloaded',
      path: finalPath.targetPath,
      relative_path: finalPath.relativePath,
      bytes: bytes.byteLength,
      sha256: digest,
      format,
    };
    // Measured once, before the audit append that precedes ingest, so the record
    // carries the scale facts whether or not an ingest follows.
    const scale = this.measureArtifactScale(format, bytes, params);
    await appendAnnasAudit(this.annasBooksRoot, {
      kind: 'annas_archive_acquisition_audit',
      action: 'downloaded',
      domain_id: manifest.domain_id,
      approval_id: params.approvalId,
      selected: annasSelectionAudit(params),
      download,
      scale,
      created_at: new Date().toISOString(),
    });

    const ragIngest = params.ingest
      ? await this.tryAnnasRagIngest(manifest, params, locator ?? digest, format, bytes, scale, finalPath.targetPath)
      : { status: 'not_requested' };
    const registry = params.ingest
      ? await this.registerAnnasIngest(manifest, params, locator ?? digest, format, ragIngest)
      : { status: 'skipped', reason: 'rag_ingest was not requested.' };

    return {
      kind: 'annas_archive_import_result',
      status: annasAcquisitionStatus('downloaded', String(ragIngest.status)),
      domain_id: manifest.domain_id,
      download,
      rag_ingest: ragIngest,
      registry,
      policy: domainPolicy(),
    };
  }

  // A book already on disk still has to be able to reach the corpus. Re-ingest takes the
  // existing file as the source instead of re-downloading it, so an ingest that never ran
  // — or one that failed after the download — is recoverable without deleting the book.
  private async ingestExistingAnnasAcquisition(
    manifest: ReturnType<typeof domainManifest>,
    params: AnnasArchiveImportParams,
    duplicate: { reason: string; targetPath: string },
    locator: string | undefined,
  ): Promise<unknown> {
    const format: NonNullable<AnnasArchiveImportParams['format']> = params.format && params.format !== 'unknown'
      ? params.format
      : extensionFormat(duplicate.targetPath) as NonNullable<AnnasArchiveImportParams['format']>;
    const bytes = await readExistingAnnasBookFile(duplicate.targetPath, this.annasMaxDownloadBytes);
    const digest = sha256(bytes);
    const download = {
      status: 'skipped_duplicate',
      path: duplicate.targetPath,
      reason: duplicate.reason,
      bytes: bytes.byteLength,
      sha256: digest,
      format,
    };
    const scale = this.measureArtifactScale(format, bytes, params);
    const ragIngest = await this.tryAnnasRagIngest(manifest, params, locator ?? digest, format, bytes, scale, duplicate.targetPath);
    const registry = await this.registerAnnasIngest(manifest, params, locator ?? digest, format, ragIngest);
    await appendAnnasAudit(this.annasBooksRoot, {
      kind: 'annas_archive_acquisition_audit',
      action: 'ingested_existing',
      domain_id: manifest.domain_id,
      approval_id: params.approvalId,
      selected: annasSelectionAudit(params),
      target_path: duplicate.targetPath,
      reason: duplicate.reason,
      download,
      scale,
      rag_ingest_status: ragIngest.status,
      created_at: new Date().toISOString(),
    });
    return {
      kind: 'annas_archive_import_result',
      status: annasAcquisitionStatus('ingested_existing', String(ragIngest.status)),
      domain_id: manifest.domain_id,
      download,
      rag_ingest: ragIngest,
      registry,
      policy: domainPolicy(),
    };
  }

  private async openAnnasTemplateDownload(
    params: AnnasArchiveImportParams,
    locator: string | undefined,
    plannedFormat: string,
  ): Promise<{ response: Response; url: string }> {
    const downloadUrl = params.url ?? annasUrl(this.annas.downloadUrlTemplate, this.annas.baseUrl, `/download/${encodeURIComponent(requireString(locator, 'annas_archive_id'))}`, {
      id: params.annasArchiveId,
      format: plannedFormat,
    });
    if (!downloadUrl) throw new DomainExpertWorkerError(503, 'annas_archive_not_configured', 'Anna Archive download endpoint is not configured.');
    return fetchAnnasDownload(this.fetchImpl, downloadUrl, this.annas, requireString(this.annas.apiKey, 'annas_archive_api_key'));
  }

  private async openAnnasFastDownload(params: AnnasArchiveImportParams): Promise<{ response: Response; url: string }> {
    const md5 = annasFastDownloadMd5(params);
    if (!md5) {
      throw new DomainExpertWorkerError(
        400,
        'annas_archive_md5_required',
        'Anna Archive fast downloads resolve files by md5; provide md5, an md5 annas_archive_id, or an /md5/ record URL.',
      );
    }
    const apiKey = requireString(this.annas.apiKey, 'annas_archive_api_key');
    // The member API takes the account secret as a query parameter, so this request must
    // stay inside the credential-egress allowlist just like any other credentialed hop.
    const url = annasUrl(undefined, this.annas.baseUrl, ANNAS_FAST_DOWNLOAD_PATH, { md5, key: apiKey });
    if (!url) throw new DomainExpertWorkerError(503, 'annas_archive_not_configured', 'Anna Archive base URL is required for fast downloads.');
    const { response } = await fetchAnnasCredentialed(this.fetchImpl, url, {
      config: this.annas,
      apiKey,
      purpose: 'download',
    });
    const body = await responseTextOrJson(response);
    const downloadUrl = annasFastDownloadUrl(body);
    if (!downloadUrl) throw annasFastDownloadError(response, body, apiKey);
    return fetchAnnasPartnerDownload({
      // The pinned transport, not this.fetchImpl: a generic fetch cannot be told which
      // address to connect to, so it cannot honour the resolution that was validated.
      fetchImpl: this.webImportFetchImpl,
      resolveHost: this.resolveHostImpl,
      rawUrl: downloadUrl,
      timeoutMs: this.annasDownloadTimeoutMs,
    });
  }

  private measureArtifactScale(format: string, bytes: Uint8Array, params: AnnasArchiveImportParams): AnnasArtifactScale {
    return annasArtifactScale(format, bytes, {
      minPdfPages: this.annasMinPdfPages,
      allowShortArtifact: params.allowShortArtifact === true,
    });
  }

  private async tryAnnasRagIngest(
    manifest: ReturnType<typeof domainManifest>,
    params: AnnasArchiveImportParams,
    locator: string,
    format: string,
    bytes: Uint8Array,
    scale: AnnasArtifactScale,
    sourcePath: string,
  ): Promise<Record<string, unknown>> {
    // Shared with planAnnasArchiveImport so the dry run cannot report a
    // different target than this executes against. A configured domain's
    // routing already names the corpus its library materializes into; only a
    // domain with no routing at all genuinely has nothing to ingest into.
    const corpusTarget = resolveTargetCorpus(params.corpusId, manifest);
    if (!corpusTarget) {
      return { status: 'needs_corpus_decision', reason: NO_TARGET_CORPUS_REASON };
    }
    const corpusId = corpusTarget.target_corpus_id;
    // The single choke point for every ingest, so the scale gate sits here: a
    // positively measured sub-book-scale artifact stops before anything is
    // uploaded or imported, and the downloaded file stays on disk for
    // inspection. Returned rather than thrown because the catch below carries no
    // extra facts and the measurement is the whole point of the refusal.
    if (scale.below_min_pdf_pages && !scale.short_artifact_override) {
      return {
        status: 'blocked',
        ...corpusTarget,
        error: {
          code: 'annas_artifact_scale_implausible',
          message: `Measured ${scale.pages} page(s) in the downloaded ${scale.format}, below the ${scale.min_pdf_pages}-page floor for a book-scale artifact. Nothing was uploaded or imported; the file is still on disk.`,
          suggestion: 'Confirm the file is the edition its metadata advertised — a source can advertise a monograph and deliver a pamphlet. To ingest it deliberately anyway, re-run annas_archive_import with allow_short_artifact: true.',
        },
        scale,
      };
    }
    // Vertex RAG parses PDF, text, Markdown and HTML. On 2026-09-20 sixteen
    // EPUB/DJVU/MOBI uploads each completed with importedRagFilesCount=0 and
    // no error, and every one was reported as import_requested. Ebooks are
    // converted to Markdown here before upload, or refused with a typed code
    // that says the download is still on disk.
    const artifact = await this.prepareAnnasIngestArtifact(format, bytes, sourcePath, params);
    if ('refusal' in artifact) {
      return { status: 'blocked', ...corpusTarget, error: artifact.refusal, source_path: sourcePath };
    }
    const conversion = artifact.conversion ? { conversion: artifact.conversion } : {};
    try {
      // The GCS object path becomes the file's identity inside the RAG
      // corpus, so it carries the book's own details — author, title, year —
      // never an acquisition-source locator. Owner ruling 2026-07-29.
      const title = params.title?.trim();
      const author = params.author?.trim();
      const year = params.year?.trim();
      const descriptor = title
        ? `${author ? `${author} - ` : ''}${title}${year ? ` (${year})` : ''}`
        : locator;
      const gcsUri = await this.uploadApprovedImportToGcs(manifest, descriptor, artifact.format, artifact.bytes);
      // One budget for the whole ingest: waiting out a busy corpus and waiting
      // for the operation both draw from it, so a tool call has one bound.
      const deadline = Date.now() + this.annasImportPollTimeoutMs;
      const submission = await this.submitAnnasImportWithBackoff(manifest, corpusId, gcsUri, deadline);
      if ('blocked' in submission) {
        return { status: 'blocked', ...corpusTarget, gcs_uri: gcsUri, ...conversion, error: submission.blocked };
      }
      const outcome = await this.awaitAnnasImportOutcome(manifest, submission.result, artifact.format, deadline);
      return {
        status: outcome.status,
        ...corpusTarget,
        gcs_uri: gcsUri,
        ...conversion,
        rag_import: submission.result,
        import_outcome: outcome.detail,
        ...(submission.retries ? { submission_retries: submission.retries } : {}),
      };
    } catch (error) {
      return {
        status: 'blocked',
        ...corpusTarget,
        ...conversion,
        error: error instanceof DomainExpertWorkerError
          ? { code: error.code, message: error.message, ...(error.suggestion ? { suggestion: error.suggestion } : {}) }
          : { code: 'rag_ingest_error', message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  // What actually gets uploaded for a downloaded artifact: the PDF itself, a
  // Markdown conversion of an ebook, or a typed refusal. The refusal names the
  // on-disk path so the owner knows nothing was lost.
  private async prepareAnnasIngestArtifact(
    format: string,
    bytes: Uint8Array,
    sourcePath: string,
    params: AnnasArchiveImportParams,
  ): Promise<
    | { format: string; bytes: Uint8Array; conversion?: Record<string, unknown> }
    | { refusal: { code: string; message: string; suggestion: string } }
  > {
    const onDisk = `Nothing was uploaded or imported; the download is still on disk at ${sourcePath}.`;
    if (ANNAS_NATIVE_INGEST_FORMATS.has(format)) return { format, bytes };
    const front = { ...(params.title?.trim() ? { title: params.title.trim() } : {}), ...(params.author?.trim() ? { creator: params.author.trim() } : {}) };
    if (format === 'epub') {
      try {
        const converted = convertEpubToMarkdown(bytes);
        const markdown = new TextEncoder().encode(converted.markdown);
        return {
          format: 'md',
          bytes: markdown,
          conversion: {
            from: 'epub',
            to: 'md',
            sections: converted.sections,
            skipped_sections: converted.skipped,
            converted_bytes: markdown.byteLength,
            ...(converted.warnings.length ? { warnings: converted.warnings } : {}),
          },
        };
      } catch (error) {
        const detail = error instanceof EbookConversionError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
        return {
          refusal: {
            code: 'ebook_conversion_failed',
            message: `The EPUB could not be converted to text (${detail}). ${onDisk}`,
            suggestion: 'Acquire another edition (a PDF, or an EPUB that opens in a reader); annas_archive_search with ingest_intent: true ranks ingestible formats first.',
          },
        };
      }
    }
    if (format === 'djvu') {
      const binary = Bun.which(this.annasDjvutxtBin);
      if (!binary) {
        return {
          refusal: {
            code: 'unsupported_ingest_format',
            message: `DJVU ingest needs ${this.annasDjvutxtBin} (djvulibre) on the worker host, and it is not installed. ${onDisk}`,
            suggestion: 'Install djvulibre on the worker host, or acquire a PDF or EPUB edition instead.',
          },
        };
      }
      let text: string;
      try {
        text = await runDjvuTextExtraction(binary, sourcePath);
      } catch (error) {
        return {
          refusal: {
            code: 'ebook_conversion_failed',
            message: `djvutxt could not extract text from the DJVU (${error instanceof Error ? error.message : String(error)}). ${onDisk}`,
            suggestion: 'The scan may carry no text layer. Acquire a PDF or EPUB edition instead.',
          },
        };
      }
      if (!text.trim()) {
        return {
          refusal: {
            code: 'ebook_conversion_failed',
            message: `djvutxt produced no text for the DJVU; the scan has no text layer. ${onDisk}`,
            suggestion: 'Acquire a PDF or EPUB edition instead, or OCR the scan outside the worker and ingest the result.',
          },
        };
      }
      const markdown = new TextEncoder().encode(plainTextToMarkdown(text, front));
      return { format: 'md', bytes: markdown, conversion: { from: 'djvu', to: 'md', converter: 'djvutxt', converted_bytes: markdown.byteLength } };
    }
    return {
      refusal: {
        code: 'unsupported_ingest_format',
        message: `Vertex RAG does not parse ${format.toUpperCase()} and the worker has no converter for it. ${onDisk}`,
        suggestion: 'Acquire a PDF or EPUB edition of the same work; annas_archive_search with ingest_intent: true ranks ingestible formats first.',
      },
    };
  }

  // A corpus accepts one import at a time and the embedding backend meters
  // requests: FAILED_PRECONDITION "other operations running" and 429 both mean
  // "not now", not "never". Retry with backoff inside the ingest budget instead
  // of surfacing them as a blocked ingest on the first answer.
  private async submitAnnasImportWithBackoff(
    manifest: ReturnType<typeof domainManifest>,
    corpusId: string,
    gcsUri: string,
    deadline: number,
  ): Promise<{ result: Record<string, unknown>; retries: number } | { blocked: { code: string; message: string; suggestion: string } }> {
    let retries = 0;
    let delay = this.annasImportPollIntervalMs;
    for (;;) {
      try {
        const result = await this.ragCorpus({ action: 'import', domainId: manifest.domain_id, corpusId, gcsUri, dryRun: false });
        return { result: asOptionalRecord(result) ?? {}, retries };
      } catch (error) {
        const transient = annasImportTransientReason(error);
        if (!transient) throw error;
        if (Date.now() + delay > deadline) {
          return {
            blocked: {
              code: transient.code,
              message: `${transient.message} Retried ${retries} time(s) within the ${this.annasImportPollTimeoutMs} ms ingest budget; the converted object is uploaded at ${gcsUri}.`,
              suggestion: 'Re-run annas_archive_import with ingest: true once the corpus is idle; the download is on disk and the object is already uploaded, so the retry only resubmits the import.',
            },
          };
        }
        await sleepMs(delay);
        retries += 1;
        delay = Math.min(delay * 2, ANNAS_IMPORT_BACKOFF_MAX_MS);
      }
    }
  }

  // Submission is not ingestion. The operation is read back until Vertex says
  // what happened to the file, and the status names that outcome; only a poll
  // that runs out of budget still says import_requested, with the operation
  // name so the caller can finish the check.
  private async awaitAnnasImportOutcome(
    manifest: ReturnType<typeof domainManifest>,
    importResult: Record<string, unknown>,
    uploadedFormat: string,
    deadline: number,
  ): Promise<{ status: AnnasImportOutcomeStatus; detail: Record<string, unknown> }> {
    const receipt = asOptionalRecord(importResult.submission_receipt);
    const operationName = typeof receipt?.operation_name === 'string' ? receipt.operation_name : undefined;
    const corpusName = asOptionalRecord(importResult.resolved_corpus)?.resource_name;
    if (!operationName || typeof corpusName !== 'string') {
      return { status: 'import_requested', detail: { reason: 'operation_reference_unavailable', hint: 'The submission carried no verifiable operation name; check the corpus file list for the object.' } };
    }
    const scope = { project: manifest.gcp_project, location: manifest.rag_location, corpusName };
    const startedAt = Date.now();
    let operation: unknown = importResult.operation;
    let polls = 0;
    let delay = this.annasImportPollIntervalMs;
    for (;;) {
      const settled = classifyRagImportOperation(operation, operationName, uploadedFormat);
      if (settled) return { status: settled.status, detail: { ...settled.detail, polls, waited_ms: Date.now() - startedAt } };
      if (Date.now() + delay > deadline) {
        return {
          status: 'import_requested',
          detail: {
            operation_name: operationName,
            polls,
            waited_ms: Date.now() - startedAt,
            hint: `Vertex had not finished the import within the ${this.annasImportPollTimeoutMs} ms budget. Read the operation to learn whether the file was imported before reporting it as in the library.`,
          },
        };
      }
      await sleepMs(delay);
      polls += 1;
      try {
        operation = await this.google.getRagImportOperation(scope, operationName);
        delay = this.annasImportPollIntervalMs;
      } catch (error) {
        const transient = error instanceof DomainExpertWorkerError && error.code === 'google_api_error' && (error.status === 429 || error.status >= 500);
        if (transient) {
          delay = Math.min(delay * 2, ANNAS_IMPORT_BACKOFF_MAX_MS);
          continue;
        }
        return {
          status: 'import_requested',
          detail: {
            operation_name: operationName,
            polls,
            waited_ms: Date.now() - startedAt,
            poll_error: error instanceof DomainExpertWorkerError
              ? { code: error.code, message: error.message }
              : { code: 'rag_import_poll_error', message: error instanceof Error ? error.message : String(error) },
            hint: 'The operation could not be read back; read it directly before reporting the file as in the library.',
          },
        };
      }
    }
  }

  private annasImportGcsPrefix(manifest: ReturnType<typeof domainManifest>): string {
    const prefix = this.annas.importGcsPrefix;
    if (!prefix) throw new DomainExpertWorkerError(503, 'annas_archive_not_configured', 'EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_IMPORT_GCS_PREFIX is required for direct RAG imports.');
    assertAllowedGcsDestination(prefix, manifest.allowed_gcs_prefixes);
    return prefix;
  }

  private async uploadApprovedImportToGcs(manifest: ReturnType<typeof domainManifest>, descriptor: string, format: string, bytes: Uint8Array): Promise<string> {
    const prefix = this.annasImportGcsPrefix(manifest);
    const parsed = parseGcsPrefix(prefix);
    // Stable, metadata-derived name: re-ingesting the same book overwrites
    // the same object instead of accumulating timestamped duplicates.
    const objectName = `${parsed.prefix}${manifest.domain_id}/${safeObjectName(descriptor)}.${format}`;
    const gcsUri = `gs://${parsed.bucket}/${objectName}`;
    assertAllowedGcsDestination(gcsUri, manifest.allowed_gcs_prefixes);
    await this.google.uploadGcsObject(parsed.bucket, objectName, bytes);
    return gcsUri;
  }

  private async withRagCorpusRetry<T>(
    manifest: ReturnType<typeof domainManifest>,
    resolved: ResolvedRagCorpus,
    operation: (resolved: ResolvedRagCorpus) => Promise<T>,
  ): Promise<{ value: T; resolved: ResolvedRagCorpus; warnings: RagCorpusWarning[] }> {
    try {
      return { value: await operation(resolved), resolved, warnings: [] };
    } catch (error) {
      if (!(await this.isStaleResolvedRagCorpusError(error, manifest, resolved))) throw error;
      if (!resolved.displayName) {
        throw ragCorpusNotFoundError(resolved.requested, manifest.gcp_project, manifest.rag_location);
      }
    }

    await this.invalidateRagCorpusMapping(manifest.gcp_project, manifest.rag_location, resolved.displayName);
    const fresh = await this.resolveRagCorpus(manifest, resolved.displayName, { refresh: true });
    try {
      return { value: await operation(fresh), resolved: fresh, warnings: ragCorpusWarnings(fresh) };
    } catch (error) {
      if (await this.isStaleResolvedRagCorpusError(error, manifest, fresh)) {
        throw ragCorpusNotFoundError(fresh.requested, manifest.gcp_project, manifest.rag_location);
      }
      throw error;
    }
  }

  private async isStaleResolvedRagCorpusError(
    error: unknown,
    manifest: ReturnType<typeof domainManifest>,
    resolved: ResolvedRagCorpus,
  ): Promise<boolean> {
    if (!isGoogleNotFoundError(error)) return false;
    const missingResource = googleNotFoundResourceKind(error, resolved.resourceName);
    if (missingResource !== 'unknown') return missingResource === 'corpus';
    try {
      await this.google.getRagCorpus({
        project: manifest.gcp_project,
        location: manifest.rag_location,
        corpusName: resolved.resourceName,
      });
      return false;
    } catch (corpusError) {
      if (isGoogleNotFoundError(corpusError)) return true;
      throw corpusError;
    }
  }

  /** The corpora agent routing configures this domain to reach, by display name. */
  private configuredCorpusIds(manifest: ReturnType<typeof domainManifest>): string[] {
    return manifest.corpora.map((corpus) => corpus.id);
  }

  /**
   * Maps a requested corpus spelling — display name, numeric id, or full
   * resource name — onto the identity of a corpus this domain is configured
   * for, or refuses. Authorization is decided on that canonical identity
   * rather than on the spelling, so the three spellings are one subject and
   * neither an alias nor a foreign project can widen what a domain reaches.
   */
  private async canonicalRagCorpusId(
    manifest: ReturnType<typeof domainManifest>,
    requested: string,
  ): Promise<string> {
    const configured = this.configuredCorpusIds(manifest);
    // A display name this domain is routed to is already canonical. Answering
    // it without a lookup is what keeps a posture refusal free of any cloud
    // call, and it is the spelling every default path uses.
    if (configured.includes(requested)) return requested;
    if (configured.length === 0) throw corpusNotConfiguredForDomainError(manifest, requested);

    const parsedResource = parseRagCorpusResourceName(requested);
    let parsed: ParsedRagCorpusResourceName;
    if (parsedResource) {
      parsed = parsedResource;
      // Pinned to the manifest before anything is resolved: a resource name is
      // otherwise a way to name any location Vertex serves.
      if (parsed.location !== manifest.rag_location) {
        throw ragCorpusForeignLocationError(manifest, parsed.location);
      }
    } else if (isNumericRagCorpusId(requested)) {
      parsed = { project: manifest.gcp_project, location: manifest.rag_location, corpusId: requested };
    } else {
      // Any other spelling is a display name, and it is not one of this
      // domain's. Refused before it is looked up, so the refusal cannot be
      // read as an existence oracle for another domain's library.
      throw corpusNotConfiguredForDomainError(manifest, requested);
    }

    for (const configuredId of configured) {
      const canonical = await this.canonicalConfiguredRagCorpus(manifest, configuredId);
      if (!canonical) continue;
      if (canonical.corpusId !== parsed.corpusId || canonical.location !== parsed.location) continue;
      if (!this.ragCorpusProjectAllowed(manifest, canonical, parsed.project)) {
        throw ragCorpusForeignProjectError(manifest, parsed.project);
      }
      return configuredId;
    }
    throw corpusNotConfiguredForDomainError(manifest, requested);
  }

  /**
   * The resolved identity of one configured corpus, or undefined when it does
   * not exist yet. Authorization-only, so it deliberately skips the disclosure
   * check: an excluded corpus still has to be identifiable for a request that
   * spells it as a number to be refused as that corpus.
   */
  private async canonicalConfiguredRagCorpus(
    manifest: ReturnType<typeof domainManifest>,
    configuredId: string,
  ): Promise<ParsedRagCorpusResourceName | undefined> {
    const resolved = await this.resolveRagCorpusByDisplayName(manifest, configuredId).catch((error) => {
      if (error instanceof DomainExpertWorkerError && error.code === 'rag_corpus_not_found') return undefined;
      throw error;
    });
    return resolved ? parseRagCorpusResourceName(resolved.resourceName) : undefined;
  }

  private ragCorpusProjectAllowed(
    manifest: ReturnType<typeof domainManifest>,
    canonical: ParsedRagCorpusResourceName,
    project: string,
  ): boolean {
    if (project === manifest.gcp_project || project === canonical.project) return true;
    // Vertex answers with the project number where the manifest names the
    // project id, so a resource name echoed back from an earlier response is
    // legitimate under an alias this runtime has already recorded for exactly
    // this corpus. Nothing else widens the set.
    const aliases = this.ragCorpusProjectAliases.get(
      ragCorpusProjectAliasKey(manifest.gcp_project, canonical.location, canonical.corpusId),
    );
    return aliases?.has(project) === true;
  }

  private async resolveRagCorpus(
    manifest: ReturnType<typeof domainManifest>,
    requested: string,
    options: { refresh?: boolean } = {},
  ): Promise<ResolvedRagCorpus> {
    const corpus = requireString(requested, 'corpus_id');
    // Every corpus-scoped operation funnels through here, so this is the
    // structural point at which a corpus this domain is not routed to, and a
    // `derived` or `excluded` corpus, stop being reachable — before any
    // retrieval or listing call is made against them. Both checks run on the
    // canonical identity, never on the spelling the caller chose.
    const canonicalId = await this.canonicalRagCorpusId(manifest, corpus);
    this.assertCorpusDisclosable(manifest.domain_id, canonicalId);
    if (isFullRagCorpusResourceName(corpus)) {
      const resolved = {
        requested: corpus,
        corpusId: corpusIdFromResourceName(corpus),
        resourceName: corpus,
      };
      this.rememberResolvedRagCorpusProjectAliases(manifest, resolved);
      return resolved;
    }
    if (isNumericRagCorpusId(corpus)) {
      const resolved = {
        requested: corpus,
        corpusId: corpus,
        resourceName: corpusResourceNameFromParts(manifest.gcp_project, manifest.rag_location, corpus),
      };
      this.rememberResolvedRagCorpusProjectAliases(manifest, resolved);
      return resolved;
    }
    return this.resolveRagCorpusByDisplayName(manifest, corpus, options);
  }

  private async resolveRagCorpusByDisplayName(
    manifest: ReturnType<typeof domainManifest>,
    corpus: string,
    options: { refresh?: boolean } = {},
  ): Promise<ResolvedRagCorpus> {
    const cacheKey = ragCorpusMappingKey(manifest.gcp_project, manifest.rag_location, corpus);
    if (!options.refresh) {
      const cached = this.ragCorpusCache.get(cacheKey);
      if (cached) return cached;

      const mapping = await this.loadRagCorpusMapping();
      const mapped = mapping.corpora[cacheKey];
      if (mapped) {
        if (!isValidRagCorpusMapping(mapped, manifest.gcp_project, manifest.rag_location, corpus)) {
          await this.discardInvalidRagCorpusMapping(cacheKey);
        } else {
          const resolved = {
            requested: corpus,
            corpusId: mapped.corpus_id,
            resourceName: mapped.resource_name,
            displayName: mapped.display_name,
            warnings: this.consumeRagCorpusMappingWarnings(),
          };
          this.rememberRagCorpusProjectAlias(manifest.gcp_project, manifest.rag_location, mapped.corpus_id, mapped.project);
          this.rememberResolvedRagCorpusProjectAliases(manifest, resolved);
          this.ragCorpusCache.set(cacheKey, resolved);
          return resolved;
        }
      }
    }

    const listed = await this.listRagCorpora(
      manifest.gcp_project,
      manifest.rag_location,
      options.refresh ? { refresh: true } : {},
    );
    const matches = listed.filter((candidate) => candidate.displayName === corpus);
    const match = matches[0];
    if (!match?.name) {
      throw ragCorpusNotFoundError(corpus, manifest.gcp_project, manifest.rag_location);
    }
    const warnings = [
      ...this.consumeRagCorpusMappingWarnings(),
      ...duplicateRagCorpusWarnings(corpus, matches),
    ];
    const resolved = {
      requested: corpus,
      corpusId: corpusIdFromResourceName(match.name),
      resourceName: match.name,
      ...(match.displayName ? { displayName: match.displayName } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
    this.rememberResolvedRagCorpusProjectAliases(manifest, resolved);
    this.ragCorpusCache.set(cacheKey, resolved);
    await this.recordRagCorpusMapping(manifest.gcp_project, manifest.rag_location, corpus, match.name);
    return resolved;
  }

  private async listRagCorpora(project: string, location: string, options: { refresh?: boolean } = {}): Promise<Array<{ name: string; displayName?: string }>> {
    const cacheKey = `${project}/${location}`;
    const cached = this.ragCorpusListCache.get(cacheKey);
    if (cached && !options.refresh) return cached;
    const listed = await this.google.listRagCorpora({ project, location });
    this.ragCorpusListCache.set(cacheKey, listed);
    const recordedDisplayNames = new Set<string>();
    for (const corpus of listed) {
      if (!corpus.displayName || recordedDisplayNames.has(corpus.displayName)) continue;
      recordedDisplayNames.add(corpus.displayName);
      await this.recordRagCorpusMapping(project, location, corpus.displayName, corpus.name);
    }
    return listed;
  }

  private async loadRagCorpusMapping(): Promise<RagCorpusMappingFile> {
    return this.withRagCorpusMappingLock(() => this.loadRagCorpusMappingUnlocked());
  }

  private async loadRagCorpusMappingUnlocked(): Promise<RagCorpusMappingFile> {
    if (this.ragCorpusMapping) return this.ragCorpusMapping;
    const path = ragCorpusMappingPath(this.dataDir);
    const raw = await readFile(path, 'utf8').catch(() => '');
    if (!raw) {
      this.ragCorpusMapping = { version: 1, corpora: {} };
      return this.ragCorpusMapping;
    }
    await chmod(path, 0o600);
    let parsed: Partial<RagCorpusMappingFile>;
    try {
      parsed = JSON.parse(raw) as Partial<RagCorpusMappingFile>;
    } catch (error) {
      this.ragCorpusMappingWarnings.push({
        code: 'rag_corpus_mapping_file_unreadable',
        message: 'rag-corpus-mapping.json could not be parsed; rebuilding corpus name mappings from Vertex ragCorpora.',
        mapping_file: 'rag-corpus-mapping.json',
      });
      console.warn(`rag-corpus-mapping.json could not be parsed; rebuilding from Vertex ragCorpora. ${error instanceof Error ? error.message : String(error)}`);
      this.ragCorpusMapping = { version: 1, corpora: {} };
      return this.ragCorpusMapping;
    }
    this.ragCorpusMapping = {
      version: 1,
      corpora: parsed.corpora && typeof parsed.corpora === 'object' ? parsed.corpora : {},
    };
    return this.ragCorpusMapping;
  }

  private async recordRagCorpusMapping(project: string, location: string, displayName: string, resourceName: string): Promise<void> {
    await this.withRagCorpusMappingLock(async () => {
      const corpusId = corpusIdFromResourceName(resourceName);
      const key = ragCorpusMappingKey(project, location, displayName);
      const mapping = await this.loadRagCorpusMappingUnlocked();
      mapping.corpora[key] = {
        display_name: displayName,
        corpus_id: corpusId,
        resource_name: resourceName,
        project,
        location,
        updated_at: new Date().toISOString(),
      };
      this.rememberRagCorpusProjectAlias(project, location, corpusId, project);
      const parsedResourceName = parseRagCorpusResourceName(resourceName);
      if (parsedResourceName) {
        this.rememberRagCorpusProjectAlias(project, parsedResourceName.location, corpusId, parsedResourceName.project);
      }
      this.ragCorpusCache.set(key, {
        requested: displayName,
        corpusId,
        resourceName,
        displayName,
      });
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      await writeJsonFileAtomically(ragCorpusMappingPath(this.dataDir), mapping);
    });
  }

  private async discardInvalidRagCorpusMapping(key: string): Promise<void> {
    await this.withRagCorpusMappingLock(async () => {
      const mapping = await this.loadRagCorpusMappingUnlocked();
      delete mapping.corpora[key];
      this.ragCorpusMappingWarnings.push(ragCorpusMappingFileWarning());
      console.warn('rag-corpus-mapping.json contained an invalid entry; rebuilding from Vertex ragCorpora.');
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      await writeJsonFileAtomically(ragCorpusMappingPath(this.dataDir), mapping);
    });
  }

  private assertRagFileBelongsToResolvedCorpus(
    manifest: ReturnType<typeof domainManifest>,
    ragFileName: string,
    resolved: ResolvedRagCorpus,
  ): void {
    const parsedCorpus = parseRagCorpusResourceName(resolved.resourceName);
    const aliasKey = parsedCorpus
      ? ragCorpusProjectAliasKey(manifest.gcp_project, parsedCorpus.location, parsedCorpus.corpusId)
      : undefined;
    const allowedProjects = new Set<string>([
      manifest.gcp_project,
      ...(parsedCorpus ? [parsedCorpus.project] : []),
      ...(aliasKey ? this.ragCorpusProjectAliases.get(aliasKey) ?? [] : []),
    ]);
    assertRagFileBelongsToCorpus(ragFileName, resolved.resourceName, { allowedProjects });
  }

  private rememberResolvedRagCorpusProjectAliases(
    manifest: Pick<ReturnType<typeof domainManifest>, 'gcp_project'>,
    resolved: ResolvedRagCorpus,
  ): void {
    const parsed = parseRagCorpusResourceName(resolved.resourceName);
    if (!parsed) return;
    this.rememberRagCorpusProjectAlias(manifest.gcp_project, parsed.location, parsed.corpusId, manifest.gcp_project);
    this.rememberRagCorpusProjectAlias(manifest.gcp_project, parsed.location, parsed.corpusId, parsed.project);
  }

  private rememberListedRagFileProjects(
    manifest: ReturnType<typeof domainManifest>,
    resolved: ResolvedRagCorpus,
    files: Array<Record<string, unknown>>,
  ): void {
    const parsedCorpus = parseRagCorpusResourceName(resolved.resourceName);
    if (!parsedCorpus) return;
    for (const file of files) {
      if (typeof file.name !== 'string') continue;
      const parsedFile = parseRagFileResourceName(file.name);
      if (!parsedFile) continue;
      if (parsedFile.location !== parsedCorpus.location || parsedFile.corpusId !== parsedCorpus.corpusId) continue;
      this.rememberRagCorpusProjectAlias(manifest.gcp_project, parsedFile.location, parsedFile.corpusId, parsedFile.project);
    }
  }

  private rememberRagCorpusProjectAlias(manifestProject: string, location: string, corpusId: string, projectAlias: string): void {
    const key = ragCorpusProjectAliasKey(manifestProject, location, corpusId);
    let aliases = this.ragCorpusProjectAliases.get(key);
    if (!aliases) {
      aliases = new Set<string>();
      this.ragCorpusProjectAliases.set(key, aliases);
    }
    aliases.add(projectAlias);
  }

  private async invalidateRagCorpusMapping(project: string, location: string, displayName: string): Promise<void> {
    await this.withRagCorpusMappingLock(async () => {
      const key = ragCorpusMappingKey(project, location, displayName);
      this.ragCorpusCache.delete(key);
      this.ragCorpusListCache.delete(`${project}/${location}`);
      const mapping = await this.loadRagCorpusMappingUnlocked();
      if (mapping.corpora[key]) {
        delete mapping.corpora[key];
        await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
        await writeJsonFileAtomically(ragCorpusMappingPath(this.dataDir), mapping);
      }
    });
  }

  private consumeRagCorpusMappingWarnings(): RagCorpusMappingFileWarning[] {
    if (this.ragCorpusMappingWarnings.length === 0) return [];
    const warnings = this.ragCorpusMappingWarnings;
    this.ragCorpusMappingWarnings = [];
    return warnings;
  }

  // Titles for citations. A retrieved context names the rag file's GCS object;
  // for a canonical library object that is a content hash, which is what a
  // served expert read back to users on 2026-09-20 ("citations [6, 8, 11]"). The
  // master manifest already carries title and creator for those objects, so
  // it is read through the worker's own credential, cached per library root,
  // and re-read once when an id is unknown so a freshly materialized object
  // resolves. A worker-lane book import carries its author/title in the
  // object name itself. Nothing here can fail the answer: an unreadable
  // manifest leaves the hash in place and adds one diagnostic line.
  // Extends each passage cut mid-sentence to whole sentences from its source
  // text (passage-completion.ts). Source reads are optional: any failure, a
  // non-text source, or a deployment without read access to book text leaves
  // the passage as retrieved.
  private async completePassageSentences<T extends Record<string, unknown>>(contexts: T[]): Promise<T[]> {
    const sources = new Map<string, Promise<string | undefined>>();
    for (const context of contexts) {
      const uri = typeof context.sourceUri === 'string' ? context.sourceUri : undefined;
      if (!uri || sources.has(uri) || typeof context.text !== 'string' || !context.text.trim()) continue;
      if (!completionSourceObject(uri)) continue;
      sources.set(uri, this.passageSourceText(uri));
    }
    if (sources.size === 0) return contexts;
    const texts = new Map<string, string | undefined>();
    for (const [uri, text] of sources) texts.set(uri, await text);
    let completedCount = 0;
    const completed = contexts.map((context) => {
      const source = typeof context.sourceUri === 'string' ? texts.get(context.sourceUri) : undefined;
      if (!source || typeof context.text !== 'string') return context;
      try {
        const result = completePassageSentences(context.text, source);
        if (!result.completed) return context;
        completedCount += 1;
        return { ...context, text: result.text, sentence_completed: true };
      } catch {
        return context;
      }
    });
    if (completedCount > 0) {
      console.info(JSON.stringify({ kind: 'domain_expert_passages_completed', completed_count: completedCount }));
    }
    return completed;
  }

  private async passageSourceText(uri: string): Promise<string | undefined> {
    const target = completionSourceObject(uri);
    if (!target) return undefined;
    const cached = this.sourceTexts.get(uri);
    if (cached !== undefined) return cached;
    if (this.sourceTexts.recentlyMissed(uri, target.bucket)) return undefined;
    try {
      const text = await this.google.downloadGcsText(
        target.bucket, target.objectName, PASSAGE_SOURCE_MAX_BYTES, PASSAGE_SOURCE_READ_TIMEOUT_MS);
      if (text === null) {
        this.sourceTexts.miss(uri);
        return undefined;
      }
      this.sourceTexts.set(uri, text);
      return text;
    } catch (error) {
      const status = error instanceof DomainExpertWorkerError ? error.status : undefined;
      if (status === 401 || status === 403) {
        // A deployment granted only the manifest (a public provider's VM identity)
        // cannot read book text: stop asking that bucket for a while.
        this.sourceTexts.deny(target.bucket);
        console.warn(JSON.stringify({ kind: 'domain_expert_passage_source_denied', bucket: target.bucket, status }));
      } else {
        this.sourceTexts.miss(uri);
      }
      return undefined;
    }
  }

  private async resolveCitationSources(
    contexts: Array<Record<string, unknown>>,
    manifest: ReturnType<typeof domainManifest>,
  ): Promise<{ metadata: Array<CitationSourceMetadata | undefined>; diagnostics: string[] }> {
    const diagnostics = new Set<string>();
    const refreshed = new Set<string>();
    const metadata: Array<CitationSourceMetadata | undefined> = [];
    let registered: Map<string, CitationSourceMetadata> | undefined;
    for (const context of contexts) {
      const uri = typeof context.sourceUri === 'string' ? context.sourceUri : undefined;
      if (!uri) {
        metadata.push(undefined);
        continue;
      }
      const canonical = parseCanonicalLibraryObjectUri(uri);
      if (canonical) {
        metadata.push(await this.lookupLibraryObjectMetadata(canonical, refreshed, diagnostics));
        continue;
      }
      registered ??= await this.registeredSourceTitles(manifest);
      // The object name is read only when Vertex's display name is that same
      // name: a display name that already says more is never replaced.
      const display = typeof context.sourceDisplayName === 'string' ? context.sourceDisplayName.trim() : '';
      const nameOnly = !display || display === uri.slice(uri.lastIndexOf('/') + 1);
      metadata.push(registered.get(uri) ?? (nameOnly ? parseObjectNameUri(uri) : undefined));
    }
    return { metadata, diagnostics: [...diagnostics] };
  }

  // Titles the domain's source registry recorded for a staged object (a web
  // or book import writes gcs_uri beside title and author). Read per answer:
  // the file is small, and a worker without a workspace root, or with an
  // unreadable registry, falls through to the object name.
  private async registeredSourceTitles(
    manifest: ReturnType<typeof domainManifest>,
  ): Promise<Map<string, CitationSourceMetadata>> {
    const titles = new Map<string, CitationSourceMetadata>();
    const root = this.roots.get(manifest.workspace_root_id);
    if (!root) return titles;
    try {
      const rootPath = await checkedRootPath(root);
      const registry = await readDomainSourceRegistry(
        resolveInside(rootPath, `${manifest.workspace_relative_path}/references/source-registry.jsonl`));
      for (const history of groupDomainSourceRecords(registry.records).values()) {
        const latest = latestDomainSourceRecord(history);
        if (latest.removed) continue;
        const uri = stringRecordField(latest.record, 'gcs_uri', 'gcsUri');
        const title = stringRecordField(latest.record, 'title');
        if (!uri || !title) continue;
        const creator = stringRecordField(latest.record, 'author', 'creator');
        titles.set(uri, { title, ...(creator ? { creator } : {}) });
      }
    } catch {
      // Display only: the object name still titles the citation.
    }
    return titles;
  }

  private async lookupLibraryObjectMetadata(
    target: { bucket: string; prefix: string; objectId: string },
    refreshed: Set<string>,
    diagnostics: Set<string>,
  ): Promise<CitationSourceMetadata | undefined> {
    const key = `${target.bucket}/${target.prefix}`;
    let index = this.libraryManifestCache.get(key);
    if (!index || Date.now() - index.loadedAt >= index.ttlMs) {
      index = await this.loadLibraryManifestIndex(target.bucket, target.prefix);
      refreshed.add(key);
    }
    let found = index.objects.get(target.objectId);
    if (!found && !index.unreadable && !refreshed.has(key)) {
      index = await this.loadLibraryManifestIndex(target.bucket, target.prefix);
      refreshed.add(key);
      found = index.objects.get(target.objectId);
    }
    if (index.unreadable) {
      diagnostics.add(`Library manifest ${libraryManifestUri(target.bucket, target.prefix)} could not be read; citations under that root show object hashes instead of titles.`);
    }
    return found;
  }

  private async loadLibraryManifestIndex(bucket: string, prefix: string): Promise<LibraryManifestIndex> {
    const key = `${bucket}/${prefix}`;
    let index: LibraryManifestIndex;
    try {
      const bytes = await this.google.downloadGcsObject(bucket, libraryManifestObjectName(prefix));
      if (bytes === null) throw new Error('master manifest missing');
      index = {
        loadedAt: Date.now(),
        ttlMs: LIBRARY_MANIFEST_CACHE_TTL_MS,
        objects: libraryManifestTitleIndex(decodeUtf8Bytes(bytes)),
        unreadable: false,
      };
    } catch (error) {
      console.warn(JSON.stringify({
        kind: 'domain_expert_library_manifest_unreadable',
        bucket,
        prefix,
        reason: sanitizeWebImportProvenanceText(error instanceof Error ? error.message : String(error)).slice(0, 300),
      }));
      index = { loadedAt: Date.now(), ttlMs: LIBRARY_MANIFEST_UNREADABLE_TTL_MS, objects: new Map(), unreadable: true };
    }
    this.libraryManifestCache.set(key, index);
    return index;
  }

  // Every source that reaches the corpus is tracked and titled (owner ruling
  // 2026-09-20): an acquisition that Vertex counted writes the same
  // source-registry record the skill's manual registration would, keyed by
  // the Anna's Archive locator so a re-ingest revises the record instead of
  // adding a second one. The registry is workspace state; a worker without a
  // configured root reports that plainly rather than failing an ingest that
  // already succeeded.
  private async registerAnnasIngest(
    manifest: ReturnType<typeof domainManifest>,
    params: AnnasArchiveImportParams,
    locator: string,
    format: string,
    ragIngest: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (ragIngest.status !== 'imported') {
      return { status: 'skipped', reason: `rag_ingest.status is ${String(ragIngest.status)}; only an imported source is registered.` };
    }
    const root = this.roots.get(manifest.workspace_root_id);
    if (!root) {
      return { status: 'unavailable', reason: 'No domain workspace root is configured, so the source registry cannot be written. Register the source manually with domain_source add.' };
    }
    try {
      const rootPath = await checkedRootPath(root);
      const registryRelativePath = `${manifest.workspace_relative_path}/references/source-registry.jsonl`;
      const registryPath = resolveInside(rootPath, registryRelativePath);
      const md5 = annasFastDownloadMd5(params);
      const sourceLocator = `annas:${md5 ?? locator}`;
      const registry = await readDomainSourceRegistry(registryPath);
      const history = registry.records.filter((record) => stringRecordField(record.record, 'locator') === sourceLocator);
      const previous = history.length ? latestDomainSourceRecord(history) : undefined;
      const sourceId = previous?.sourceId ?? `${manifest.domain_id}-annas-${safeObjectName(md5 ?? locator).slice(0, 48)}`;
      const title = params.title?.trim();
      const author = params.author?.trim();
      const year = params.year?.trim();
      const importOutcome = asOptionalRecord(ragIngest.import_outcome);
      const registeredAt = new Date().toISOString();
      const record: Record<string, unknown> = {
        source_id: sourceId,
        domain_id: manifest.domain_id,
        kind: annasSourceKind(format),
        ...(title ? { title } : {}),
        ...(author ? { author } : {}),
        ...(year ? { year } : {}),
        locator: sourceLocator,
        ...(params.url ? { canonical_url: canonicalAnnasAuditUrl(params.url) } : {}),
        acquisition: 'annas_archive_import',
        ...(typeof ragIngest.target_corpus_id === 'string' ? { target_corpus_id: ragIngest.target_corpus_id } : {}),
        trust_posture: manifest.trust_posture,
        copyright_posture: params.copyrightPosture,
        ingest_status: 'imported',
        ...(typeof ragIngest.gcs_uri === 'string' ? { gcs_uri: ragIngest.gcs_uri } : {}),
        ...(typeof importOutcome?.operation_name === 'string' ? { rag_operation_name: importOutcome.operation_name } : {}),
        registered_at: registeredAt,
      };
      await mkdir(dirname(registryPath), { recursive: true });
      await this.appendRegistryJsonLine(registryPath, record);
      const logPath = resolveInside(rootPath, `${manifest.workspace_relative_path}/references/ingest-log.md`);
      await appendFile(logPath, `- ${registeredAt} ${previous ? 'updated' : 'registered'} ${sourceId} (annas_archive_import ingest)\n`, 'utf8');
      return {
        status: previous ? 'updated' : 'registered',
        source_id: sourceId,
        locator: sourceLocator,
        registry_relative_path: registryRelativePath,
      };
    } catch (error) {
      return {
        status: 'failed',
        reason: error instanceof DomainExpertWorkerError
          ? `${error.code}: ${error.message}`
          : sanitizeWebImportProvenanceText(error instanceof Error ? error.message : String(error)).slice(0, 300),
      };
    }
  }

  private rootFor(rootId: string): DomainExpertWorkspaceRootPolicy {
    const root = this.roots.get(rootId);
    if (!root) throw new DomainExpertWorkerError(400, 'unknown_root', 'domain workspace root is not configured.');
    return root;
  }

  private async appendRegistryJsonLine(path: string, record: Record<string, unknown>): Promise<void> {
    await this.withRegistryAppendLock(() => appendCompleteLine(path, JSON.stringify(record)));
  }

  private async withRagCorpusMappingLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.ragCorpusMappingQueue.then(operation, operation);
    this.ragCorpusMappingQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async withRegistryAppendLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.registryAppendQueue.then(operation, operation);
    this.registryAppendQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

interface NotionImportSource {
  id: string;
  type?: 'page' | 'database';
  url?: string;
}

interface NotionObjectMetadata {
  objectId: string;
  objectType: 'page' | 'database';
  title: string;
  childBlockCount?: number;
  rowPageCount?: number;
  skippedObjectCount: number;
  warnings: string[];
}

interface NotionMarkdownDerivative {
  objectId: string;
  objectType: 'page';
  title: string;
  fileName: string;
  bytes: Uint8Array;
  sourceUrl?: string;
  parentPageId?: string;
  parentDatabaseId?: string;
  warnings: string[];
}

interface NotionDatabasePageList {
  databaseId: string;
  databaseTitle: string;
  pages: Array<{ objectId: string; title: string }>;
  skipped: number;
  warnings: string[];
}

class NotionRuntimeClient {
  private config: DomainExpertNotionConfig;

  constructor(config: DomainExpertNotionConfig) {
    this.config = config;
  }

  configured(): boolean {
    return Boolean(this.config.token?.trim());
  }

  notionVersion(): string {
    return this.config.notionVersion?.trim() || NOTION_DEFAULT_VERSION;
  }

  maxObjects(): number {
    return normalizePositiveInteger(this.config.maxObjects, NOTION_DEFAULT_MAX_OBJECTS);
  }

  async probe(): Promise<void> {
    await this.notionJson('/users/me');
  }

  async inspectObject(id: string, preferredType?: 'page' | 'database'): Promise<NotionObjectMetadata> {
    const objectId = normalizeNotionObjectId(id);
    if (preferredType === 'database') return this.inspectDatabase(objectId);
    if (preferredType === 'page') return this.inspectPage(objectId);
    try {
      return await this.inspectPage(objectId);
    } catch (error) {
      if (error instanceof DomainExpertWorkerError && error.status === 404) return this.inspectDatabase(objectId);
      throw error;
    }
  }

  async fetchPageMarkdown(input: {
    id: string;
    sourceUrl?: string;
    retrievedAt: string;
    filePrefix?: string;
  }): Promise<NotionMarkdownDerivative> {
    const objectId = normalizeNotionObjectId(input.id);
    const page = asRecord(await this.notionJson(`/pages/${objectId}`), 'notion page');
    const title = notionTitleFromObject(page) || 'Untitled Notion page';
    const warnings: string[] = [];
    const blocks = await this.fetchBlocksMarkdown(objectId, 0, warnings, { remaining: this.maxObjects() });
    const parent = notionParentIds(page);
    const markdown = notionMarkdownDocument({
      objectId,
      objectType: 'page',
      retrievedAt: input.retrievedAt,
      title,
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
      ...(parent.parentPageId ? { parentPageId: parent.parentPageId } : {}),
      ...(parent.parentDatabaseId ? { parentDatabaseId: parent.parentDatabaseId } : {}),
      warnings,
      body: blocks.join('\n').trim(),
    });
    return {
      objectId,
      objectType: 'page',
      title,
      fileName: `${input.filePrefix ? `${safeObjectName(input.filePrefix)}/` : ''}${safeObjectName(title)}-${objectId.slice(0, 8)}.md`,
      bytes: new TextEncoder().encode(markdown),
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
      ...(parent.parentPageId ? { parentPageId: parent.parentPageId } : {}),
      ...(parent.parentDatabaseId ? { parentDatabaseId: parent.parentDatabaseId } : {}),
      warnings,
    };
  }

  async listDatabasePages(databaseIdValue: string): Promise<NotionDatabasePageList> {
    const databaseId = normalizeNotionObjectId(databaseIdValue);
    const database = asRecord(await this.notionJson(`/databases/${databaseId}`), 'notion database');
    const databaseTitle = notionTitleFromObject(database) || 'Untitled Notion database';
    const pages: Array<{ objectId: string; title: string }> = [];
    const warnings: string[] = [];
    let skipped = 0;
    let cursor: string | undefined;
    do {
      const body: Record<string, unknown> = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const response = asRecord(await this.notionJson(`/databases/${databaseId}/query`, {
        method: 'POST',
        body: JSON.stringify(body),
      }), 'notion database query');
      const results = Array.isArray(response.results) ? response.results : [];
      for (const result of results) {
        if (pages.length >= this.maxObjects()) {
          skipped += 1;
          continue;
        }
        const row = asOptionalRecord(result);
        const id = typeof row?.id === 'string' ? normalizeNotionObjectId(row.id) : undefined;
        if (!id || !row) continue;
        pages.push({ objectId: id, title: notionTitleFromObject(row) || 'Untitled Notion page' });
      }
      cursor = typeof response.next_cursor === 'string' && response.next_cursor ? response.next_cursor : undefined;
      if (pages.length >= this.maxObjects() && cursor) {
        warnings.push('notion_database_row_count_capped');
        break;
      }
    } while (cursor);
    if (skipped > 0) warnings.push('notion_database_row_count_capped');
    return { databaseId, databaseTitle, pages, skipped, warnings: [...new Set(warnings)] };
  }

  private async inspectPage(objectId: string): Promise<NotionObjectMetadata> {
    const page = asRecord(await this.notionJson(`/pages/${objectId}`), 'notion page');
    const count = await this.countChildBlocks(objectId);
    return {
      objectId,
      objectType: 'page',
      title: notionTitleFromObject(page) || 'Untitled Notion page',
      childBlockCount: count.count,
      skippedObjectCount: count.skipped,
      warnings: count.warnings,
    };
  }

  private async inspectDatabase(objectId: string): Promise<NotionObjectMetadata> {
    const database = asRecord(await this.notionJson(`/databases/${objectId}`), 'notion database');
    const count = await this.countDatabaseRows(objectId);
    return {
      objectId,
      objectType: 'database',
      title: notionTitleFromObject(database) || 'Untitled Notion database',
      rowPageCount: count.count,
      skippedObjectCount: count.skipped,
      warnings: count.warnings,
    };
  }

  private async countChildBlocks(blockId: string): Promise<{ count: number; skipped: number; warnings: string[] }> {
    let count = 0;
    let skipped = 0;
    let cursor: string | undefined;
    const warnings: string[] = [];
    do {
      const path = `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`;
      const response = asRecord(await this.notionJson(path), 'notion block children');
      const results = Array.isArray(response.results) ? response.results : [];
      count += results.length;
      if (count >= this.maxObjects()) {
        skipped += results.length - Math.max(0, this.maxObjects() - (count - results.length));
        count = this.maxObjects();
        if (response.has_more === true || skipped > 0) warnings.push('notion_page_block_count_capped');
        break;
      }
      cursor = typeof response.next_cursor === 'string' && response.next_cursor ? response.next_cursor : undefined;
    } while (cursor);
    return { count, skipped, warnings };
  }

  private async countDatabaseRows(databaseId: string): Promise<{ count: number; skipped: number; warnings: string[] }> {
    let count = 0;
    let skipped = 0;
    let cursor: string | undefined;
    const warnings: string[] = [];
    do {
      const body: Record<string, unknown> = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const response = asRecord(await this.notionJson(`/databases/${databaseId}/query`, {
        method: 'POST',
        body: JSON.stringify(body),
      }), 'notion database query');
      const results = Array.isArray(response.results) ? response.results : [];
      count += results.length;
      if (count >= this.maxObjects()) {
        skipped += results.length - Math.max(0, this.maxObjects() - (count - results.length));
        count = this.maxObjects();
        if (response.has_more === true || skipped > 0) warnings.push('notion_database_row_count_capped');
        break;
      }
      cursor = typeof response.next_cursor === 'string' && response.next_cursor ? response.next_cursor : undefined;
    } while (cursor);
    return { count, skipped, warnings };
  }

  private async fetchBlocksMarkdown(
    blockId: string,
    depth: number,
    warnings: string[],
    budget: { remaining: number },
  ): Promise<string[]> {
    if (depth >= NOTION_DEFAULT_DEPTH) {
      warnings.push('notion_block_depth_cap_reached');
      return [];
    }
    const rendered: string[] = [];
    let cursor: string | undefined;
    do {
      if (budget.remaining <= 0) {
        warnings.push('notion_page_block_count_capped');
        break;
      }
      const pageSize = Math.min(100, budget.remaining);
      const path = `/blocks/${blockId}/children?page_size=${pageSize}${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`;
      const response = asRecord(await this.notionJson(path), 'notion block children');
      const results = Array.isArray(response.results) ? response.results : [];
      for (const value of results) {
        if (budget.remaining <= 0) {
          warnings.push('notion_page_block_count_capped');
          break;
        }
        const block = asOptionalRecord(value);
        if (!block) continue;
        budget.remaining -= 1;
        const childMarkdown = block.has_children === true && block.type !== 'child_page'
          ? await this.fetchBlocksMarkdown(String(block.id ?? ''), depth + 1, warnings, budget)
          : [];
        rendered.push(renderNotionBlock(block, childMarkdown, warnings));
      }
      if (budget.remaining <= 0) {
        warnings.push('notion_page_block_count_capped');
        break;
      }
      cursor = typeof response.next_cursor === 'string' && response.next_cursor ? response.next_cursor : undefined;
    } while (cursor);
    return rendered.filter((entry) => entry.trim().length > 0);
  }

  private async notionJson(path: string, init: RequestInit = {}, attempt = 0): Promise<unknown> {
    const token = this.config.token?.trim();
    if (!token) {
      throw new DomainExpertWorkerError(
        503,
        'notion_not_configured',
        'notion_import requires EXPERT_AGENTS_DOMAIN_EXPERT_NOTION_TOKEN.',
      );
    }
    const response = await (this.config.fetchImpl ?? fetch)(`${NOTION_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': this.notionVersion(),
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (response.status === 429 && attempt < NOTION_MAX_RETRIES) {
      await sleepMs(retryAfterMs(response.headers.get('retry-after')));
      return this.notionJson(path, init, attempt + 1);
    }
    if (!response.ok) {
      throw new DomainExpertWorkerError(
        response.status,
        'notion_api_error',
        `Notion API request failed with HTTP ${response.status}.`,
      );
    }
    return response.json();
  }
}

class GoogleRuntimeClient {
  private config: DomainExpertGoogleConfig;
  private tokenCache?: { token: string; expiresAtMs: number };
  private projectNumbers = new Map<string, string>();

  constructor(config: DomainExpertGoogleConfig) {
    this.config = {
      ...config,
      scopes: config.scopes ?? DEFAULT_SCOPES,
    };
  }

  async configurationStatus(): Promise<GoogleConfigurationStatus> {
    if (this.config.accessToken?.trim()) return 'ready';
    const inlineJson = this.config.serviceAccountJson?.trim();
    const jsonPath = this.config.serviceAccountJsonPath?.trim();
    if (!inlineJson && !jsonPath) {
      if (!this.config.metadataServerToken) return 'not_configured';
      // Health is the deploy proof, so the flag alone must not read as ready:
      // an attached identity is only real when the metadata server answers.
      return await this.metadataServerAnswers() ? 'ready' : 'unreadable';
    }

    try {
      const raw = inlineJson ?? await readFile(jsonPath!, 'utf8');
      const credential = JSON.parse(raw) as Partial<GoogleServiceAccountCredential>;
      return typeof credential.client_email === 'string'
        && Boolean(credential.client_email.trim())
        && typeof credential.private_key === 'string'
        && Boolean(credential.private_key.trim())
        && (credential.token_uri === undefined || isHttpsUrl(credential.token_uri))
        ? 'ready'
        : 'unreadable';
    } catch {
      return 'unreadable';
    }
  }

  async validateCreationOperationName(project: string, location: string, value: unknown, response?: unknown): Promise<{ name: string; parents: string[] }> {
    requireGoogleProject(project);
    // A numeric candidate still must match the configured location before any
    // lookup can be deferred. No candidate ever supplies polling authority.
    corpusCreationOperationCandidate(project, location, { name: value });
    const parents = [`projects/${project}/locations/${location}`];
    let name = validatedVertexOperationName(value, parents);
    const numericOperation = typeof value === 'string' && /^projects\/[1-9][0-9]*\/locations\/[a-z0-9-]+\/operations\/[A-Za-z0-9_-]+$/.test(value);
    const responseName = asOptionalRecord(response)?.name;
    const numericResponse = name && typeof responseName === 'string' && /^projects\/[1-9][0-9]*\/locations\/[a-z0-9-]+\/ragCorpora\/[A-Za-z0-9_-]+$/.test(responseName);
    if ((!name && numericOperation) || numericResponse) {
      // Vertex can use the project number where configuration names the id.
      // Only Resource Manager establishes that alias; an operation's own
      // spelling can never confer authority to poll a different project.
      let number = this.projectNumbers.get(project);
      if (!number) {
        let resource;
        try {
          resource = asOptionalRecord(await this.googleJson(`https://cloudresourcemanager.googleapis.com/v1/projects/${project}`));
        } catch (error) {
          if (!(error instanceof DomainExpertWorkerError) || error.code !== 'google_api_error') throw error;
          throw new DomainExpertWorkerError(error.status, 'rag_corpus_creation_project_identity_unavailable', 'The submitted corpus operation is retained, but its project alias cannot currently be verified. Restore Resource Manager project lookup access and resume.');
        }
        if (resource?.projectId !== project || typeof resource.projectNumber !== 'string' || !/^[1-9][0-9]*$/.test(resource.projectNumber)) {
          throw new DomainExpertWorkerError(502, 'rag_corpus_creation_operation_scope_invalid', 'The corpus creation project identity could not be verified.');
        }
        number = resource.projectNumber;
        this.projectNumbers.set(project, number);
      }
      parents.push(`projects/${number}/locations/${location}`);
      name = validatedVertexOperationName(value, parents);
    }
    if (!name) throw new DomainExpertWorkerError(502, 'rag_corpus_creation_operation_scope_invalid', 'The corpus creation operation reference is outside the configured project and location.');
    return { name, parents };
  }

  async getRagCorpusCreationOperation(options: { project: string; location: string; operationName: string }): Promise<unknown> {
    const { name } = await this.validateCreationOperationName(options.project, options.location, options.operationName);
    return this.googleJson(`${vertexBase(options.location)}/v1/${name}`);
  }

  model(): string {
    return this.config.model ?? 'gemini-3.8-flash';
  }

  generateLocation(): string {
    return this.config.generateLocation?.trim() || 'global';
  }

  transcribeModel(): string {
    return this.config.transcribeModel ?? this.model();
  }

  retrievalTopK(): number {
    return Math.min(
      DOMAIN_ASK_RETRIEVAL_DEFAULTS.maxResultsCap,
      normalizePositiveInteger(this.config.retrievalTopK, DOMAIN_ASK_RETRIEVAL_DEFAULTS.candidateTopK),
    );
  }

  answerContextLimit(): number {
    return Math.min(
      DOMAIN_ANSWER_SYNTHESIS_CONTEXT_CAP,
      normalizePositiveInteger(this.config.answerContextLimit, DOMAIN_ASK_RETRIEVAL_DEFAULTS.synthesisContextLimit),
    );
  }

  multiQueryEnabled(): boolean {
    return this.config.multiQuery ?? DOMAIN_ASK_RETRIEVAL_DEFAULTS.multiQuery;
  }

  private reranker(): DomainExpertReranker {
    return this.config.reranker ?? DOMAIN_ASK_RETRIEVAL_DEFAULTS.reranker;
  }

  private rerankerModel(reranker: DomainExpertReranker): string {
    return this.config.rerankerModel?.trim()
      || (reranker === 'llm' ? this.model() : DOMAIN_ASK_RETRIEVAL_DEFAULTS.rerankerModel);
  }

  ragParserModel(): string | undefined {
    return resolveRagParserModel(this.config.ragParserModel);
  }

  async createRagCorpus(options: {
    project: string;
    location: string;
    displayName: string;
    description?: string;
  }): Promise<unknown> {
    requireGoogleProject(options.project);
    return this.googleJson(
      `${vertexBase(options.location)}/v1/projects/${options.project}/locations/${options.location}/ragCorpora`,
      {
        method: 'POST',
        body: JSON.stringify({
          displayName: options.displayName,
          ...(options.description ? { description: options.description } : {}),
        }),
      },
    );
  }

  async listRagCorpora(options: { project: string; location: string }): Promise<Array<{ name: string; displayName?: string }>> {
    requireGoogleProject(options.project);
    const corpora: Array<{ name: string; displayName?: string }> = [];
    const seenPageTokens = new Set<string>();
    let pageCount = 0;
    let pageToken: string | undefined;
    do {
      const url = new URL(`${vertexBase(options.location)}/v1/projects/${options.project}/locations/${options.location}/ragCorpora`);
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const response = await this.googleJson(url.toString());
      const record = response as Record<string, any>;
      for (const corpus of record.ragCorpora ?? []) {
        if (typeof corpus?.name !== 'string') continue;
        corpora.push({
          name: corpus.name,
          ...(typeof corpus.displayName === 'string' ? { displayName: corpus.displayName } : {}),
        });
      }
      pageCount += 1;
      pageToken = typeof record.nextPageToken === 'string' && record.nextPageToken ? record.nextPageToken : undefined;
      if (pageToken) {
        if (seenPageTokens.has(pageToken)) throw new VertexPaginationError('repeated nextPageToken');
        if (pageCount >= VERTEX_MAX_PAGES) throw new VertexPaginationError('page cap reached');
        seenPageTokens.add(pageToken);
      }
    } while (pageToken);
    return corpora;
  }

  async getRagCorpus(options: { project: string; location: string; corpusName: string }): Promise<unknown> {
    requireGoogleProject(options.project);
    return this.googleJson(`${vertexBase(options.location)}/v1/${options.corpusName}`);
  }

  async listRagFiles(options: {
    project: string;
    location: string;
    corpusName: string;
    pageToken?: string;
  }): Promise<{ files: Array<Record<string, unknown>>; nextPageToken?: string }> {
    requireGoogleProject(options.project);
    const url = new URL(`${vertexBase(options.location)}/v1/${options.corpusName}/ragFiles`);
    if (options.pageToken) url.searchParams.set('pageToken', options.pageToken);
    const response = await this.googleJson(url.toString());
    const record = response as Record<string, any>;
    const files = ((record.ragFiles ?? []) as Array<Record<string, any>>)
      .filter((file) => typeof file?.name === 'string')
      .map((file) => {
        // The v1 RagFile reports its origin under gcsSource.uris, not a flat
        // sourceUri; tolerate both plus the ragFileSource wrapper some
        // responses use, so callers can match records back to GCS objects.
        const sourceUri = [file.sourceUri, file.gcsSource?.uris?.[0], file.ragFileSource?.gcsSource?.uris?.[0]]
          .find((value) => typeof value === 'string' && value.startsWith('gs://'));
        return {
          name: file.name,
          ...(typeof file.displayName === 'string' ? { displayName: file.displayName } : {}),
          ...(typeof file.createTime === 'string' ? { createTime: file.createTime } : {}),
          ...(sourceUri ? { sourceUri } : {}),
          ...(typeof file.fileStatus?.state === 'string' ? { state: file.fileStatus.state } : typeof file.state === 'string' ? { state: file.state } : {}),
          // v1 carries the failure reason as fileStatus.errorStatus, a string.
          ...(typeof file.fileStatus?.errorStatus === 'string' ? { errorStatus: file.fileStatus.errorStatus }
            : asOptionalRecord(file.errorStatus) ? { errorStatus: file.errorStatus } : {}),
        };
      });
    const nextPageToken = typeof record.nextPageToken === 'string' && record.nextPageToken ? record.nextPageToken : undefined;
    return {
      files,
      ...(nextPageToken ? { nextPageToken } : {}),
    };
  }

  async deleteRagFile(options: {
    project: string;
    location: string;
    ragFileName: string;
  }): Promise<unknown> {
    requireGoogleProject(options.project);
    return this.googleJson(`${vertexBase(options.location)}/v1/${options.ragFileName}`, { method: 'DELETE' });
  }

  async verifyRagImportOperationAlias(scope: { project: string; location: string; corpusName: string }, operation: unknown): Promise<string> {
    requireGoogleProject(scope.project);
    const candidate = vertexImportOperationCandidate(operation, scope);
    if (!candidate) throw new DomainExpertWorkerError(502, 'rag_import_operation_scope_invalid', 'The import returned an untrusted operation reference.');
    // The URL always uses the configured project id, exact authorized corpus,
    // and bounded opaque operation id. Never request the candidate's project.
    let verified;
    try {
      verified = asOptionalRecord(await this.googleJson(`${vertexBase(scope.location)}/v1/${candidate.canonicalName}`));
    } catch {
      // Submission has already happened. In particular, a corpus-shaped 404
      // must not enter withRagCorpusRetry and replay the non-idempotent import.
      throw new DomainExpertWorkerError(502, 'rag_import_operation_reconciliation_required', 'The import was submitted, but its retained operation candidate could not be verified. Reconcile the submission before another import.');
    }
    if (verified?.name !== candidate.name) throw new DomainExpertWorkerError(502, 'rag_import_operation_scope_invalid', 'The import operation alias could not be verified within the configured project and corpus.');
    return candidate.corpusAlias;
  }

  // Reads a submitted import operation back under the configured project id
  // and the exact corpus; a bare name never chooses the project it is read from.
  async getRagImportOperation(scope: { project: string; location: string; corpusName: string }, operationName: string): Promise<unknown> {
    requireGoogleProject(scope.project);
    const candidate = vertexImportOperationCandidate({ name: operationName }, scope);
    if (!candidate) throw new DomainExpertWorkerError(502, 'rag_import_operation_scope_invalid', 'The import operation reference is outside the configured project and corpus.');
    return this.googleJson(`${vertexBase(scope.location)}/v1/${candidate.canonicalName}`);
  }

  async importRagFiles(options: {
    project: string;
    location: string;
    corpusName: string;
    gcsUri?: string;
    driveFileId?: string;
    chunkTokens: number;
    chunkOverlap: number;
    // Whether every file this request imports is a documented LLM parser type.
    // Drive imports and mixed staging directories are not, so they keep
    // Google's default parser. See llmParserEligibleUris.
    llmParserEligible: boolean;
    // GCS directory URI that receives Vertex's per-file import results.
    // Without it, per-file failures exist only in transient LRO metadata.
    // Field shape verified 2026-07-30 against the live v1 discovery document:
    // importRagFilesConfig.importResultGcsSink is a GcsDestination whose
    // outputUriPrefix names an output directory, created if absent.
    importResultGcsSink?: string;
  }): Promise<unknown> {
    requireGoogleProject(options.project);
    if (!options.gcsUri && !options.driveFileId) {
      throw new DomainExpertWorkerError(400, 'invalid_rag_import', 'rag_corpus import requires gcs_uri or drive_file_id.');
    }
    const importRagFilesConfig: Record<string, unknown> = ragIngestionConfig({
      project: options.project,
      location: options.location,
      parserModel: this.ragParserModel(),
      llmParserEligible: options.llmParserEligible,
      chunkTokens: options.chunkTokens,
      chunkOverlap: options.chunkOverlap,
    });
    if (options.importResultGcsSink) {
      importRagFilesConfig.importResultGcsSink = { outputUriPrefix: options.importResultGcsSink };
    }
    if (options.gcsUri) importRagFilesConfig.gcsSource = { uris: [options.gcsUri] };
    if (options.driveFileId) {
      importRagFilesConfig.googleDriveSource = {
        resourceIds: [{ resourceId: options.driveFileId, resourceType: 'RESOURCE_TYPE_FILE' }],
      };
    }
    return this.googleJson(
      `${vertexBase(options.location)}/v1/${options.corpusName}/ragFiles:import`,
      {
        method: 'POST',
        body: JSON.stringify({ importRagFilesConfig }),
      },
    );
  }

  async retrieveContexts(options: {
    project: string;
    location: string;
    corpusName: string;
    query: string;
    topK: number;
    reranker?: DomainExpertReranker;
  }): Promise<Array<Record<string, unknown>>> {
    requireGoogleProject(options.project);
    const reranker = options.reranker ?? this.reranker();
    const response = await this.googleJson(
      `${vertexBase(options.location)}/v1/projects/${options.project}/locations/${options.location}:retrieveContexts`,
      {
        method: 'POST',
        body: JSON.stringify({
          vertexRagStore: {
            ragResources: [{ ragCorpus: options.corpusName }],
          },
          query: {
            text: options.query,
            ragRetrievalConfig: {
              topK: options.topK,
              ...(reranker === 'rank-service' ? {
                ranking: { rankService: { modelName: this.rerankerModel(reranker) } },
              } : reranker === 'llm' ? {
                ranking: { llmRanker: { modelName: this.rerankerModel(reranker) } },
              } : {}),
            },
          },
        }),
      },
    );
    const contexts = ((response as Record<string, any>).contexts?.contexts ?? []) as Array<Record<string, unknown>>;
    return contexts.map(normalizeRetrievedContextSource);
  }

  async generateQueryReformulations(options: {
    project: string;
    location: string;
    model: string;
    question: string;
  }): Promise<string[]> {
    requireGoogleProject(options.project);
    const prompt = [
      'Generate exactly two concise retrieval-query reformulations for the question below.',
      'Use likely source terminology, titles, people, and concepts when the question provides them.',
      'Keep each query focused on one topic or tradition. Do not answer the question.',
      'Return only a JSON array of two strings.',
      '',
      `Question: ${options.question}`,
    ].join('\n');
    const response = await this.googleJson(
      `${vertexBase(this.generateLocation())}/v1/projects/${options.project}/locations/${this.generateLocation()}/publishers/google/models/${encodeURIComponent(options.model)}:generateContent`,
      {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            // Thinking tokens count toward maxOutputTokens, and an unbounded
            // think can starve the output, truncating the JSON mid-string.
            // Reformulation needs no more than this small budget.
            thinkingConfig: { thinkingBudget: 128 },
            maxOutputTokens: 1024,
            // JSON mime type alone still let prose through; the schema
            // constrains decoding to the array itself.
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'ARRAY',
              minItems: 2,
              maxItems: 2,
              items: { type: 'STRING' },
            },
          },
        }),
      },
    );
    const candidate = (response as Record<string, any>).candidates?.[0];
    try {
      return parseQueryReformulations(generatedText(response));
    } catch (error) {
      // finishReason distinguishes truncation (MAX_TOKENS) from a model that
      // ignored the schema; without it the fallback log cannot tell them apart.
      const finishReason = typeof candidate?.finishReason === 'string' && /^(STOP|MAX_TOKENS|SAFETY|RECITATION|OTHER|BLOCKLIST|PROHIBITED_CONTENT|SPII|MALFORMED_FUNCTION_CALL)$/.test(candidate.finishReason) ? candidate.finishReason : undefined;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(finishReason ? `${message} (finishReason: ${finishReason})` : message);
    }
  }

  async generateAnswer(options: {
    project: string;
    location: string;
    model: string;
    question: string;
    contexts: Array<Record<string, unknown>>;
  }): Promise<string> {
    requireGoogleProject(options.project);
    const contextText = options.contexts
      .map((context) => [
        citationHeader(context),
        String(context.text ?? '').slice(0, 4000),
      ].join('\n'))
      .join('\n\n');
    const prompt = [
      'Answer the question using only the supplied domain library context.',
      'Cite each source-backed claim with the bracketed citation id.',
      'If the context is insufficient, say what is missing.',
      '',
      `Question: ${options.question}`,
      '',
      `Context:\n${contextText}`,
    ].join('\n');
    const response = await this.googleJson(
      `${vertexBase(this.generateLocation())}/v1/projects/${options.project}/locations/${this.generateLocation()}/publishers/google/models/${encodeURIComponent(options.model)}:generateContent`,
      {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2 },
        }),
      },
      GOOGLE_LONG_GENERATION_TIMEOUT_MS,
    );
    return generatedText(response);
  }

  async transcribeMedia(options: {
    project: string;
    location: string;
    model: string;
    gcsUri: string;
    mimeType: string;
  }): Promise<string> {
    requireGoogleProject(options.project);
    const response = await this.googleJson(
      `${vertexBase(this.generateLocation())}/v1/projects/${options.project}/locations/${this.generateLocation()}/publishers/google/models/${encodeURIComponent(options.model)}:generateContent`,
      {
        method: 'POST',
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              {
                text: [
                  'Transcribe this approved public media source into clean plain text.',
                  'Preserve speaker wording as faithfully as possible.',
                  'Do not summarize, analyze, add timestamps, or invent missing words.',
                  'Return only the transcript text.',
                ].join(' '),
              },
              { fileData: { fileUri: options.gcsUri, mimeType: options.mimeType } },
            ],
          }],
          generationConfig: { temperature: 0 },
        }),
      },
      GOOGLE_LONG_GENERATION_TIMEOUT_MS,
    );
    return generatedText(response).trim();
  }

  async getDocument(documentId: string): Promise<Record<string, any>> {
    return this.googleJson(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}?suggestionsViewMode=SUGGESTIONS_INLINE&includeTabsContent=true`) as Promise<Record<string, any>>;
  }

  async batchUpdateDocument(documentId: string, requests: Array<Record<string, unknown>>): Promise<unknown> {
    return this.googleJson(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests }),
    });
  }

  async createDriveComment(fileId: string, content: string): Promise<unknown> {
    return this.googleJson(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/comments?fields=id,createdTime,modifiedTime,htmlContent,content,author(displayName,photoLink)`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
  }

  async uploadGcsObject(bucket: string, objectName: string, bytes: Uint8Array): Promise<unknown> {
    return this.googleBytes(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Blob([copyToArrayBuffer(bytes)], { type: 'application/octet-stream' }),
    });
  }

  async downloadGcsObject(bucket: string, objectName: string): Promise<Uint8Array | null> {
    const response = await this.authedFetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?alt=media`,
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      const body = await responseTextOrJson(response);
      throw googleError(response, body);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  // A bounded read for passage completion: a short timeout and a size cap, so
  // an optional extension never holds up or bloats an answer.
  async downloadGcsText(bucket: string, objectName: string, maxBytes: number, timeoutMs: number): Promise<string | null> {
    const response = await this.authedFetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?alt=media`,
      {},
      timeoutMs,
    );
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      const body = await responseTextOrJson(response);
      throw googleError(response, body);
    }
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > maxBytes) {
      await response.body?.cancel();
      throw new Error('source text exceeds the completion read limit');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('source text exceeds the completion read limit');
    return decodeUtf8Bytes(bytes);
  }

  private async googleJson(
    url: string,
    init: RequestInit = {},
    timeoutMs: number = GOOGLE_API_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const response = await this.authedFetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    }, timeoutMs);
    const body = await responseTextOrJson(response);
    if (!response.ok) throw googleError(response, body);
    return body;
  }

  private async googleBytes(url: string, init: RequestInit): Promise<unknown> {
    const response = await this.authedFetch(url, init);
    const body = await responseTextOrJson(response);
    if (!response.ok) throw googleError(response, body);
    return body;
  }

  private async authedFetch(
    url: string,
    init: RequestInit = {},
    timeoutMs: number = GOOGLE_API_REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const token = await this.accessToken();
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await (this.config.fetchImpl ?? fetch)(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
        signal,
      });
      upstreamResponseContexts.set(response, {
        signal,
        timeoutError: googleRequestTimeoutError,
        sensitiveValues: [token],
      });
      return response;
    } catch (error) {
      if (signal.aborted) throw googleRequestTimeoutError();
      throw error;
    }
  }

  private usesMetadataServer(): boolean {
    return Boolean(this.config.metadataServerToken)
      && !this.config.serviceAccountJson?.trim()
      && !this.config.serviceAccountJsonPath?.trim();
  }

  private async metadataServerAnswers(): Promise<boolean> {
    try {
      const response = await (this.config.fetchImpl ?? fetch)(GOOGLE_METADATA_TOKEN_URL, {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(GOOGLE_METADATA_PROBE_TIMEOUT_MS),
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  private async metadataServerAccessToken(): Promise<string> {
    const signal = AbortSignal.timeout(GOOGLE_API_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await (this.config.fetchImpl ?? fetch)(GOOGLE_METADATA_TOKEN_URL, {
        headers: { 'Metadata-Flavor': 'Google' },
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw googleRequestTimeoutError();
      throw new DomainExpertWorkerError(503, 'google_auth_not_configured', 'The instance metadata server is unreachable; attached-identity credentials are unavailable.');
    }
    upstreamResponseContexts.set(response, { signal, timeoutError: googleRequestTimeoutError, sensitiveValues: [] });
    const body = await responseTextOrJson(response);
    if (!response.ok) {
      throw new DomainExpertWorkerError(503, 'google_auth_not_configured', `The instance metadata server refused a token with HTTP ${response.status}.`);
    }
    const token = requireString((body as Record<string, unknown>).access_token, 'access_token');
    const expiresIn = Number((body as Record<string, unknown>).expires_in ?? 3600);
    this.tokenCache = { token, expiresAtMs: Date.now() + Math.max(300, expiresIn - 60) * 1000 };
    return token;
  }

  private async accessToken(): Promise<string> {
    if (this.config.accessToken) return this.config.accessToken;
    if (this.tokenCache && this.tokenCache.expiresAtMs > Date.now() + 60_000) return this.tokenCache.token;
    if (this.usesMetadataServer()) return this.metadataServerAccessToken();
    const credential = await this.serviceAccountCredential();
    const iat = Math.floor(Date.now() / 1000);
    const assertion = signJwt(
      { alg: 'RS256', typ: 'JWT' },
      {
        iss: credential.client_email,
        scope: (this.config.scopes ?? DEFAULT_SCOPES).join(' '),
        aud: credential.token_uri ?? GOOGLE_TOKEN_URL,
        iat,
        exp: iat + 3600,
      },
      credential.private_key,
    );
    const signal = AbortSignal.timeout(GOOGLE_API_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await (this.config.fetchImpl ?? fetch)(credential.token_uri ?? GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw googleRequestTimeoutError();
      throw error;
    }
    upstreamResponseContexts.set(response, {
      signal,
      timeoutError: googleRequestTimeoutError,
      sensitiveValues: [assertion],
    });
    const body = await responseTextOrJson(response);
    if (!response.ok) throw googleError(response, body);
    const token = requireString((body as Record<string, unknown>).access_token, 'access_token');
    const expiresIn = Number((body as Record<string, unknown>).expires_in ?? 3600);
    this.tokenCache = { token, expiresAtMs: Date.now() + Math.max(300, expiresIn - 60) * 1000 };
    return token;
  }

  private async serviceAccountCredential(): Promise<GoogleServiceAccountCredential> {
    const raw = this.config.serviceAccountJson
      ?? (this.config.serviceAccountJsonPath ? await readFile(this.config.serviceAccountJsonPath, 'utf8') : undefined);
    if (!raw) {
      throw new DomainExpertWorkerError(503, 'google_auth_not_configured', 'Google service account JSON or access token is not configured.');
    }
    const credential = JSON.parse(raw) as Partial<GoogleServiceAccountCredential>;
    if (!credential.client_email || !credential.private_key) {
      throw new DomainExpertWorkerError(503, 'google_auth_not_configured', 'Google service account JSON is missing client_email or private_key.');
    }
    // token_uri is both the JWT audience and the POST target, so an
    // unconstrained value would send a bearer-grade assertion for this
    // service account to an arbitrary host.
    if (credential.token_uri !== undefined && !isHttpsUrl(credential.token_uri)) {
      throw new DomainExpertWorkerError(503, 'google_auth_not_configured', 'Google service account token_uri must be an https URL.');
    }
    return {
      client_email: credential.client_email,
      private_key: credential.private_key,
      ...(credential.token_uri ? { token_uri: credential.token_uri } : {}),
      ...(credential.project_id ? { project_id: credential.project_id } : {}),
    };
  }
}

export function createDomainExpertWorker(options: DomainExpertWorkerOptions = {}): { fetch(request: Request): Promise<Response> } {
  const service = new DomainExpertService(options);
  const basePath = normalizeBasePath(options.basePath ?? '/v1');
  return {
    async fetch(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url);
        if (request.method === 'GET' && url.pathname === `${basePath}/health`) {
          return json(await service.health());
        }
        if (request.method === 'POST' && url.pathname === `${basePath}/domain`) {
          return json(await service.run(await parseDomainExpertRequest(request)));
        }
        return json({ error: { code: 'not_found', message: 'Domain expert route not found.' }, policy: domainPolicy() }, 404);
      } catch (error) {
        if (error instanceof DomainExpertWorkerError) {
          return json({
            error: {
              code: error.code,
              message: error.message,
              ...(error.suggestion ? { suggestion: error.suggestion } : {}),
            },
            policy: domainPolicy(),
          }, error.status);
        }
        if (error instanceof OperationError) {
          return json({
            error: {
              code: error.code,
              message: error.message,
              ...(error.suggestion ? { suggestion: error.suggestion } : {}),
            },
            policy: domainPolicy(),
          }, operationErrorStatus(error));
        }
        logUnhandledWorkerError(error);
        return json({
          error: {
            code: 'internal_error',
            message: 'The domain expert worker encountered an internal error.',
          },
          policy: domainPolicy(),
        }, 500);
      }
    },
  };
}

function logUnhandledWorkerError(error: unknown): void {
  const systemCode = safeSystemErrorCode(error);
  console.error('Unhandled domain expert worker error.', {
    error_type: error instanceof Error ? 'error' : typeof error,
    ...(systemCode ? { system_code: systemCode } : {}),
  });
}

function safeSystemErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' && /^(?:EACCES|EIO|EISDIR|EMFILE|ENFILE|ENOENT|ENOSPC|ENOTDIR|EPERM|EROFS)$/.test(code)
    ? code
    : undefined;
}

function operationErrorStatus(error: OperationError): number {
  if (error.code === 'domain_expert_policy_violation') return 403;
  if (error.code === 'agent_not_configured') return 503;
  if (error.code === 'invalid_params') return 400;
  if (error.code === 'invalid_agent_registration') return 400;
  if (error.code === 'agent_registration_conflict') return 409;
  if (error.code === 'agent_registration_disabled' || error.code === 'agent_registration_library_denied') return 403;
  return 500;
}

function isConfiguredGoogleProject(project: string): boolean {
  return project !== 'project-not-configured' && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project);
}

function requireGoogleProject(project: string): void {
  if (!isConfiguredGoogleProject(project)) throw new DomainExpertWorkerError(503, 'gcp_project_not_configured',
    'A valid Google Cloud project is required for domain expert cloud work.',
    'Set EXPERT_AGENTS_GCP_PROJECT to the bare project id that owns the Vertex library.');
}

function isCreationProjectIdentityUnavailable(error: unknown): boolean {
  return error instanceof DomainExpertWorkerError && error.code === 'rag_corpus_creation_project_identity_unavailable';
}

/** Syntax/envelope checks only. Numeric parents remain untrusted until Resource Manager verifies them. */
function corpusCreationOperationCandidate(
  project: string,
  location: string,
  operation: Record<string, unknown> | undefined,
  displayName?: string,
): string {
  const name = typeof operation?.name === 'string' ? operation.name : '';
  const parts = name.length <= 512
    ? /^projects\/([a-z0-9-]+)\/locations\/([a-z0-9-]+)\/operations\/[A-Za-z0-9_-]+$/.exec(name) : null;
  if (!parts || (parts[1] !== project && !/^[1-9][0-9]*$/.test(parts[1]!)) || parts[2] !== location) {
    throw new DomainExpertWorkerError(502, 'rag_corpus_creation_operation_scope_invalid', 'The corpus creation operation reference is outside the configured project and location.');
  }
  if (displayName !== undefined) {
    // Provisional parents allow envelope checking, never polling or completion.
    // Neither these parents nor the resulting provisional status leave this helper.
    const parents = [`projects/${project}/locations/${location}`, `projects/${parts[1]}/locations/${location}`];
    const responseName = asOptionalRecord(operation?.response)?.name;
    const responseParts = typeof responseName === 'string' && responseName.length <= 512
      ? /^projects\/([1-9][0-9]*)\/locations\/([a-z0-9-]+)\/ragCorpora\/[A-Za-z0-9_-]+$/.exec(responseName) : null;
    if (responseParts?.[2] === location) parents.push(`projects/${responseParts[1]}/locations/${location}`);
    validateCorpusCreationOperation(operation, name, parents, displayName);
  }
  return name;
}

function validateCorpusCreationOperation(
  operation: Record<string, unknown> | undefined,
  name: string,
  parents: readonly string[],
  displayName: string,
): 'creation_pending' | 'creation_complete' | 'creation_failed' {
  const invalid = () => new DomainExpertWorkerError(502, 'rag_corpus_creation_operation_invalid', 'The corpus creation operation response could not be validated.');
  if (!operation || operation.name !== name || (operation.done !== undefined && typeof operation.done !== 'boolean')) throw invalid();
  if (operation.done !== true) {
    if (operation.error !== undefined || operation.response !== undefined) throw invalid();
    return 'creation_pending';
  }
  if (operation.error !== undefined) {
    const error = asOptionalRecord(operation.error);
    if (operation.response !== undefined || !error || !Number.isInteger(error.code) || Number(error.code) < 1 || Number(error.code) > 16) throw invalid();
    return 'creation_failed';
  }
  const response = asOptionalRecord(operation.response);
  const corpus = typeof response?.name === 'string' && /^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/ragCorpora\/[A-Za-z0-9_-]+$/.test(response.name)
    ? parseRagCorpusResourceName(response.name) : undefined;
  if (!corpus || !parents.includes(`projects/${corpus.project}/locations/${corpus.location}`) || response?.displayName !== displayName) throw invalid();
  return 'creation_complete';
}

/** A successful HTTP response can still carry a blocked or absent generation. */
function generatedText(response: unknown): string {
  const record = asOptionalRecord(response);
  const candidate = Array.isArray(record?.candidates) ? asOptionalRecord(record.candidates[0]) : undefined;
  const finish = candidate?.finishReason;
  if (asOptionalRecord(record?.promptFeedback)?.blockReason || (finish !== undefined && finish !== 'STOP')) {
    throw new DomainExpertWorkerError(502, 'google_generation_incomplete', 'Google did not return a complete text generation.');
  }
  const parts = asOptionalRecord(candidate?.content)?.parts;
  const text = Array.isArray(parts) ? parts.map(part => {
    const value = asOptionalRecord(part);
    return value?.thought !== true && typeof value?.text === 'string' ? value.text : '';
  }).join('') : '';
  if (!text.trim()) throw new DomainExpertWorkerError(502, 'google_generation_empty', 'Google returned no usable text generation.');
  return text;
}

async function readDomainSourceRegistry(path: string): Promise<DomainSourceRegistryRead> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { records: [], totalRecords: 0, malformedLines: 0, missing: true };
    }
    throw error;
  }
  const records: DomainSourceRegistryRecord[] = [];
  let totalRecords = 0;
  let malformedLines = 0;
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    if (!rawLine.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      malformedLines += 1;
      continue;
    }
    const record = parsed as Record<string, unknown>;
    const sourceId = stringRecordField(record, 'source_id', 'sourceId');
    if (!sourceId) {
      malformedLines += 1;
      continue;
    }
    totalRecords += 1;
    const registeredAt = stringRecordField(record, 'registered_at', 'registeredAt');
    records.push({
      record,
      sourceId,
      ...(registeredAt ? { registeredAt } : {}),
      fileOrder: index,
      removed: record.removed === true || stringRecordField(record, 'ingest_status', 'ingestStatus') === 'removed',
    });
  }
  return { records, totalRecords, malformedLines, missing: false };
}

function groupDomainSourceRecords(records: DomainSourceRegistryRecord[]): Map<string, DomainSourceRegistryRecord[]> {
  const grouped = new Map<string, DomainSourceRegistryRecord[]>();
  for (const record of records) {
    const existing = grouped.get(record.sourceId);
    if (existing) {
      existing.push(record);
    } else {
      grouped.set(record.sourceId, [record]);
    }
  }
  for (const history of grouped.values()) history.sort(compareDomainSourceRecords);
  return grouped;
}

function latestDomainSourceRecord(records: DomainSourceRegistryRecord[]): DomainSourceRegistryRecord {
  return records.reduce((latest, candidate) => compareDomainSourceRecords(latest, candidate) <= 0 ? candidate : latest);
}

function compareDomainSourceRecords(left: DomainSourceRegistryRecord, right: DomainSourceRegistryRecord): number {
  const leftTime = timestampOrUndefined(left.registeredAt);
  const rightTime = timestampOrUndefined(right.registeredAt);
  if (leftTime !== undefined && rightTime !== undefined && leftTime !== rightTime) return leftTime - rightTime;
  if (leftTime !== undefined && rightTime === undefined) return 1;
  if (leftTime === undefined && rightTime !== undefined) return -1;
  return left.fileOrder - right.fileOrder;
}

function timestampOrUndefined(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

function stringRecordField(record: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function domainExpertRootsFromEnv(env: Record<string, string | undefined> = process.env): DomainExpertWorkspaceRootPolicy[] {
  const raw = env.EXPERT_AGENTS_DOMAIN_EXPERT_ROOTS_JSON?.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  const entries = Array.isArray(parsed)
    ? parsed.map((value) => asRecord(value, 'root'))
    : Object.entries(asRecord(parsed, 'EXPERT_AGENTS_DOMAIN_EXPERT_ROOTS_JSON')).map(([rootId, value]) => ({
      root_id: rootId,
      ...asRecord(value, `root ${rootId}`),
    }));
  return entries.map(rootFromRecord);
}

export function domainExpertGoogleConfigFromEnv(env: Record<string, string | undefined> = process.env): DomainExpertGoogleConfig {
  return {
    ...(env.EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_ACCESS_TOKEN ? { accessToken: env.EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_ACCESS_TOKEN } : {}),
    ...(env.EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_JSON ? { serviceAccountJson: env.EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_JSON } : {}),
    ...(env.EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_JSON_FILE ? { serviceAccountJsonPath: env.EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_JSON_FILE } : {}),
    ...(booleanEnvWithDefault(env.EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_METADATA_TOKEN, false, 'EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_METADATA_TOKEN')
      ? { metadataServerToken: true }
      : {}),
    ...(env.EXPERT_AGENTS_DOMAIN_EXPERT_GENERATE_MODEL ? { model: env.EXPERT_AGENTS_DOMAIN_EXPERT_GENERATE_MODEL } : {}),
    ...(env.EXPERT_AGENTS_DOMAIN_EXPERT_GENERATE_LOCATION ? { generateLocation: env.EXPERT_AGENTS_DOMAIN_EXPERT_GENERATE_LOCATION } : {}),
    ...(env.EXPERT_AGENTS_DOMAIN_EXPERT_TRANSCRIBE_MODEL ? { transcribeModel: env.EXPERT_AGENTS_DOMAIN_EXPERT_TRANSCRIBE_MODEL } : {}),
    retrievalTopK: env.EXPERT_AGENTS_DOMAIN_EXPERT_RETRIEVAL_TOP_K
      ? normalizePositiveInteger(env.EXPERT_AGENTS_DOMAIN_EXPERT_RETRIEVAL_TOP_K, DOMAIN_ASK_RETRIEVAL_DEFAULTS.candidateTopK)
      : DOMAIN_ASK_RETRIEVAL_DEFAULTS.candidateTopK,
    answerContextLimit: env.EXPERT_AGENTS_DOMAIN_EXPERT_ANSWER_CONTEXT_LIMIT
      ? normalizePositiveInteger(env.EXPERT_AGENTS_DOMAIN_EXPERT_ANSWER_CONTEXT_LIMIT, DOMAIN_ASK_RETRIEVAL_DEFAULTS.synthesisContextLimit)
      : DOMAIN_ASK_RETRIEVAL_DEFAULTS.synthesisContextLimit,
    reranker: domainExpertRerankerFromEnv(env.EXPERT_AGENTS_DOMAIN_EXPERT_RERANKER),
    ...(env.EXPERT_AGENTS_DOMAIN_EXPERT_RERANKER_MODEL ? { rerankerModel: env.EXPERT_AGENTS_DOMAIN_EXPERT_RERANKER_MODEL } : {}),
    ...(env.EXPERT_AGENTS_DOMAIN_EXPERT_RAG_PARSER_MODEL ? { ragParserModel: env.EXPERT_AGENTS_DOMAIN_EXPERT_RAG_PARSER_MODEL } : {}),
    multiQuery: booleanEnvWithDefault(
      env.EXPERT_AGENTS_DOMAIN_EXPERT_MULTI_QUERY,
      DOMAIN_ASK_RETRIEVAL_DEFAULTS.multiQuery,
      'EXPERT_AGENTS_DOMAIN_EXPERT_MULTI_QUERY',
    ),
  };
}

export function domainExpertAnnasConfigFromEnv(env: Record<string, string | undefined> = process.env): DomainExpertAnnasConfig {
  return {
    ...(env.EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_ARCHIVE_API_KEY ? { apiKey: env.EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_ARCHIVE_API_KEY } : {}),
    ...(env.EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_ARCHIVE_BASE_URL ? { baseUrl: trimTrailingSlash(env.EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_ARCHIVE_BASE_URL) } : {}),
    ...(env.EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_SEARCH_URL_TEMPLATE ? { searchUrlTemplate: env.EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_SEARCH_URL_TEMPLATE } : {}),
    ...(env.EXPERT_AGENTS_DOMAIN_EXPERT_LIBGEN_BASE_URL ? { libgenBaseUrl: trimTrailingSlash(env.EXPERT_AGENTS_DOMAIN_EXPERT_LIBGEN_BASE_URL) } : {}),
    ...(env.EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_DOWNLOAD_URL_TEMPLATE ? { downloadUrlTemplate: env.EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_DOWNLOAD_URL_TEMPLATE } : {}),
    ...(env.EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_IMPORT_GCS_PREFIX ? { importGcsPrefix: env.EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_IMPORT_GCS_PREFIX } : {}),
    ...(booleanEnvWithDefault(env.EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_FAST_DOWNLOAD, false, 'EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_FAST_DOWNLOAD')
      ? { fastDownload: true }
      : {}),
    ...(env.EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_MAX_DOWNLOAD_BYTES
      ? { maxDownloadBytes: normalizePositiveInteger(env.EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_MAX_DOWNLOAD_BYTES, DEFAULT_ANNAS_ARCHIVE_MAX_DOWNLOAD_BYTES) }
      : {}),
    ...(env.EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_MIN_PDF_PAGES
      ? { minPdfPages: normalizeNonNegativeInteger(env.EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_MIN_PDF_PAGES, DEFAULT_ANNAS_MIN_PDF_PAGES) }
      : {}),
    ...(env.EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_DJVUTXT_BIN ? { djvutxtBin: env.EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_DJVUTXT_BIN } : {}),
    ...(env.EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_IMPORT_POLL_INTERVAL_MS
      ? { importPollIntervalMs: normalizePositiveInteger(env.EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_IMPORT_POLL_INTERVAL_MS, DEFAULT_ANNAS_IMPORT_POLL_INTERVAL_MS) }
      : {}),
    ...(env.EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_IMPORT_POLL_TIMEOUT_MS
      ? { importPollTimeoutMs: normalizeNonNegativeInteger(env.EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_IMPORT_POLL_TIMEOUT_MS, DEFAULT_ANNAS_IMPORT_POLL_TIMEOUT_MS) }
      : {}),
    booksRoot: env.EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_BOOKS_ROOT || DEFAULT_ANNAS_BOOKS_ROOT,
  };
}

export function domainExpertNotionConfigFromEnv(env: Record<string, string | undefined> = process.env): DomainExpertNotionConfig {
  return {
    ...(env.EXPERT_AGENTS_DOMAIN_EXPERT_NOTION_TOKEN ? { token: env.EXPERT_AGENTS_DOMAIN_EXPERT_NOTION_TOKEN } : {}),
    ...(env.EXPERT_AGENTS_DOMAIN_EXPERT_NOTION_VERSION ? { notionVersion: env.EXPERT_AGENTS_DOMAIN_EXPERT_NOTION_VERSION } : {}),
    ...(env.EXPERT_AGENTS_DOMAIN_EXPERT_NOTION_MAX_OBJECTS ? { maxObjects: normalizePositiveInteger(env.EXPERT_AGENTS_DOMAIN_EXPERT_NOTION_MAX_OBJECTS, NOTION_DEFAULT_MAX_OBJECTS) } : {}),
  };
}

function parseDomainExpertRequest(request: Request): Promise<DomainExpertRequest> {
  return request.json().then((value) => {
    const record = asRecord(value, 'body');
    return {
      tool: asDomainExpertTool(record.tool),
      params: asRecord(record.params ?? {}, 'params'),
    };
  });
}

function parseDomainAgentParams(params: Record<string, unknown>): DomainAgentParams {
  return {
    action: parseDomainAgentAction(params.action),
    ...optionalStringField(params.domain_id, 'domainId'),
    ...optionalStringField(params.display_name, 'displayName'),
    ...optionalBooleanField(params.dry_run, 'dryRun'),
    ...(params.library !== undefined ? { library: params.library } : {}),
    ...optionalStringField(params.target_corpus_display_name, 'targetCorpusDisplayName'),
    ...optionalStringField(params.approval_id, 'approvalId'),
  };
}

function parseDomainAskParams(params: Record<string, unknown>): DomainAskRequestParams {
  if (params.retrieval_mode !== undefined && params.retrieval_mode !== 'preferred' && params.retrieval_mode !== 'history') {
    throw new DomainExpertWorkerError(400, 'invalid_params', 'retrieval_mode must be preferred or history.');
  }
  if (params.output !== undefined && params.output !== 'answer' && params.output !== 'passages') {
    throw new DomainExpertWorkerError(400, 'invalid_params', 'output must be answer or passages.');
  }
  return {
    ...(params.retrieval_mode !== undefined ? { retrievalMode: params.retrieval_mode as RetrievalPreferenceMode } : {}),
    ...(params.output !== undefined ? { output: params.output as DomainAskOutput } : {}),
    ...optionalStringField(params.domain_id, 'domainId'),
    question: requireString(params.question, 'question'),
    ...optionalStringField(params.corpus_id, 'corpusId'),
    ...(params.corpora !== undefined ? { corpora: asStringArray(params.corpora, 'corpora') } : {}),
    ...optionalNumberField(params.max_results, 'maxResults'),
    ...optionalStringField(params.session_id, 'sessionId'),
  };
}

function parseDomainSourceParams(params: Record<string, unknown>): DomainSourceParams {
  const action = parseDomainSourceAction(params.action);
  if (!DOMAIN_SOURCE_ACTIONS.includes(action)) throw new DomainExpertWorkerError(400, 'invalid_action', 'Invalid domain_source action.');
  return {
    action,
    ...optionalStringField(params.domain_id, 'domainId'),
    ...optionalStringField(params.source_id, 'sourceId'),
    ...optionalSourceKind(params.kind),
    ...optionalStringField(params.title, 'title'),
    ...optionalStringField(params.author, 'author'),
    ...optionalStringField(params.url, 'url'),
    ...optionalStringField(params.relative_path, 'relativePath'),
    ...optionalStringField(params.corpus_id, 'corpusId'),
    ...optionalStringField(params.trust_posture, 'trustPosture'),
    ...optionalStringField(params.copyright_posture, 'copyrightPosture'),
    ...optionalBooleanField(params.include_history, 'includeHistory'),
    ...optionalBooleanField(params.include_removed, 'includeRemoved'),
    ...optionalBooleanField(params.dry_run, 'dryRun'),
  };
}

function parseRagCorpusParams(params: Record<string, unknown>): RagCorpusParams {
  const action = parseRagCorpusAction(params.action);
  if (!RAG_CORPUS_ACTIONS.includes(action)) throw new DomainExpertWorkerError(400, 'invalid_action', 'Invalid rag_corpus action.');
  if (action === 'stage_import' && (typeof params.workspace_relative_path !== 'string' || params.workspace_relative_path.trim().length === 0)) {
    throw new DomainExpertWorkerError(400, 'invalid_params', 'rag_corpus stage_import requires workspace_relative_path.');
  }
  if (action === 'web_import' && params.urls === undefined) {
    throw new DomainExpertWorkerError(400, 'invalid_params', 'rag_corpus web_import requires urls.');
  }
  if (action === 'notion_import' && params.urls === undefined && params.page_ids === undefined && params.database_ids === undefined) {
    throw new DomainExpertWorkerError(400, 'invalid_params', 'rag_corpus notion_import requires urls, page_ids, or database_ids.');
  }
  if (action === 'delete_file' && (typeof params.rag_file_name !== 'string' || params.rag_file_name.trim().length === 0)) {
    throw new DomainExpertWorkerError(400, 'invalid_params', 'rag_corpus delete_file requires rag_file_name.');
  }
  return {
    action,
    ...optionalStringField(params.domain_id, 'domainId'),
    ...optionalStringField(params.corpus_id, 'corpusId'),
    ...optionalStringField(params.rag_file_name, 'ragFileName'),
    ...optionalStringField(params.page_token, 'pageToken'),
    ...optionalStringField(params.source_id, 'sourceId'),
    ...optionalStringField(params.gcs_uri, 'gcsUri'),
    ...optionalStringField(params.drive_file_id, 'driveFileId'),
    ...optionalStringField(params.workspace_relative_path, 'workspaceRelativePath'),
    ...optionalStringField(params.batch_id, 'batchId'),
    ...optionalStringField(params.approval_id, 'approvalId'),
    ...(params.urls !== undefined ? { urls: asStringArray(params.urls, 'urls') } : {}),
    ...(params.page_ids !== undefined ? { pageIds: asStringArray(params.page_ids, 'page_ids') } : {}),
    ...(params.database_ids !== undefined ? { databaseIds: asStringArray(params.database_ids, 'database_ids') } : {}),
    ...optionalBooleanField(params.include_media, 'includeMedia'),
    ...optionalTranscriptModeField(params.transcript_mode),
    ...optionalBooleanField(params.dry_run, 'dryRun'),
  };
}

function parseDomainDocParams(params: Record<string, unknown>): DomainDocParams {
  const action = parseDomainDocAction(params.action);
  if (!DOMAIN_DOC_ACTIONS.includes(action)) throw new DomainExpertWorkerError(400, 'invalid_action', 'Invalid domain_doc action.');
  return {
    action,
    ...optionalStringField(params.domain_id, 'domainId'),
    documentId: requireString(params.document_id, 'document_id'),
    ...optionalStringField(params.text, 'text'),
    ...optionalStringField(params.comment, 'comment'),
    ...optionalNumberField(params.range_start, 'rangeStart'),
    ...optionalNumberField(params.range_end, 'rangeEnd'),
    ...optionalStringField(params.approval_id, 'approvalId'),
    ...optionalStringField(params.edit_batch_id, 'editBatchId'),
    ...optionalBooleanField(params.dry_run, 'dryRun'),
  };
}

function parseAnnasArchiveSearchParams(params: Record<string, unknown>): AnnasArchiveSearchParams {
  return {
    ...optionalStringField(params.domain_id, 'domainId'),
    ...optionalStringField(params.query, 'query'),
    ...optionalStringField(params.topic, 'topic'),
    ...optionalStringField(params.title, 'title'),
    ...optionalStringField(params.author, 'author'),
    ...optionalStringField(params.language, 'language'),
    ...optionalNumberField(params.max_results, 'maxResults'),
    ...optionalNumberField(params.top_n, 'topN'),
    ...optionalAnnasFormatPreference(params.format_preference),
    ...optionalBooleanField(params.ingest_intent, 'ingestIntent'),
  };
}

function parseAnnasArchiveImportParams(params: Record<string, unknown>): AnnasArchiveImportParams {
  return {
    ...optionalStringField(params.domain_id, 'domainId'),
    ...optionalStringField(params.annas_archive_id, 'annasArchiveId'),
    ...optionalStringField(params.url, 'url'),
    ...optionalAnnasFormat(params.format),
    ...optionalStringField(params.corpus_id, 'corpusId'),
    ...optionalStringField(params.title, 'title'),
    ...optionalStringField(params.author, 'author'),
    ...optionalStringField(params.year, 'year'),
    ...optionalStringField(params.topic, 'topic'),
    ...optionalStringField(params.language, 'language'),
    ...optionalStringField(params.file_name, 'fileName'),
    ...optionalStringField(params.md5, 'md5'),
    ...optionalNumberField(params.file_size_bytes, 'fileSizeBytes'),
    ...optionalBooleanField(params.ingest, 'ingest'),
    ...optionalBooleanField(params.allow_short_artifact, 'allowShortArtifact'),
    copyrightPosture: requireString(params.copyright_posture, 'copyright_posture'),
    ...optionalStringField(params.approval_id, 'approvalId'),
    ...optionalBooleanField(params.dry_run, 'dryRun'),
  };
}

async function writeWorkspaceSeedFiles(
  root: DomainExpertWorkspaceRootPolicy,
  rootPath: string,
  manifest: ReturnType<typeof domainManifest>,
): Promise<Array<Record<string, unknown>>> {
  const rootRel = manifest.workspace_relative_path;
  const files: Array<[string, string]> = [
    [`${rootRel}/.gitignore`, AGENT_REPO_GITIGNORE],
    [`${rootRel}/PROPOSAL.md`, proposalContent(manifest)],
    [`${rootRel}/domain.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`],
    [`${rootRel}/references/source-registry.jsonl`, ''],
    [`${rootRel}/references/ingest-log.md`, `# Ingest Log\n\nCreated ${new Date().toISOString()}.\n`],
    [`${rootRel}/references/reading-map.md`, `# ${manifest.display_name} Reading Map\n`],
    [`${rootRel}/references/retrieval-craft.md`, retrievalCraftContent()],
    [`${rootRel}/templates/source-card.md`, '# Source Card\n\n- Title:\n- Author:\n- Corpus:\n- Status:\n- Notes:\n'],
    [`${rootRel}/templates/research-brief.md`, '# Research Brief\n\n## Question\n\n## Evidence\n\n## Answer\n\n## Gaps\n'],
    [`${rootRel}/templates/literature-review.md`, '# Literature Review\n\n## Sources\n\n## Themes\n\n## Disagreements\n'],
    [`${rootRel}/templates/disagreement-map.md`, '# Disagreement Map\n\n## Claims\n\n## Tradeoffs\n\n## Open Questions\n'],
    [`${rootRel}/eval/questions.jsonl`, `${JSON.stringify({
      id: `${manifest.domain_id}-example-1`,
      question: `What are the central open questions in the ${manifest.display_name} library?`,
      expected_sources: [],
      tags: ['example'],
      notes: 'Example format: id, question, expected_sources, tags, notes. Replace or extend this row; every persistent retrieval miss becomes an eval case.',
    })}\n`],
  ];
  const results = [];
  for (const [relativePath, content] of files) {
    const target = await resolveWritePathInside(rootPath, relativePath);
    const bytes = new TextEncoder().encode(content);
    if (bytes.byteLength > root.maxWriteBytes) {
      throw new DomainExpertWorkerError(413, 'content_too_large', `${relativePath} exceeds the root write limit.`);
    }
    await mkdir(dirname(target), { recursive: true });
    const existed = await exists(target);
    if (!existed) {
      const file = await open(target, 'wx', 0o600);
      try {
        await file.writeFile(bytes);
      } finally {
        await file.close();
      }
    } else if (root.allowOverwrite) {
      await writeFile(target, bytes, { mode: 0o600 });
    }
    results.push({
      relative_path: relativePath,
      status: existed ? (root.allowOverwrite ? 'overwritten' : 'skipped_existing') : 'created',
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
  return results;
}

function retrievalCraftContent(): string {
  return [
    '# Retrieval Craft',
    '',
    'Use these practices when you call `domain_ask`:',
    '',
    '- Name the source, author, or text when you know it.',
    '- Keep each query to one tradition or topic.',
    '- Decompose broad questions into focused retrieval questions, then synthesize across the grounded answers.',
    "- When results are weak, re-ask using the source text's own vocabulary.",
    '- Never cite or imply support from a source that retrieval did not return.',
    '- When a source you expect keeps missing, tell your owner. Retrieval misses become eval cases: record the miss in `eval/questions.jsonl` so it cannot silently regress.',
    '',
  ].join('\n');
}

function proposalContent(manifest: ReturnType<typeof domainManifest>): string {
  return [
    `# ${manifest.display_name}`,
    '',
    '## Core Role',
    '',
    `You are the ${manifest.display_name}. Answer from the curated ${manifest.domain_id} library, cite source-backed claims, and name gaps plainly.`,
    '',
    '## Source Hierarchy',
    '',
    '- Owner-authored docs and approved working notes',
    '- Canonical books, PDFs, papers, and source texts',
    '- Public web essays and blog posts',
    '',
    '## Workflow',
    '',
    'Use domain_source for intake, rag_corpus for corpus lifecycle, domain_ask for grounded answers, and domain_doc for Google Docs collaboration.',
    '',
  ].join('\n');
}

async function checkedRootPath(root: DomainExpertWorkspaceRootPolicy): Promise<string> {
  const rootPath = resolve(root.path);
  const info = await stat(rootPath).catch(() => undefined);
  if (!info?.isDirectory()) throw new DomainExpertWorkerError(400, 'root_not_directory', 'Configured domain workspace root is not a directory.');
  return rootPath;
}

function resolveInside(rootPath: string, relativePath: string): string {
  if (relativePath.startsWith('/') || relativePath.includes('\0')) {
    throw new DomainExpertWorkerError(400, 'path_escape_denied', 'Use relative paths inside the domain workspace root.');
  }
  const target = resolve(rootPath, relativePath);
  if (!(target === rootPath || target.startsWith(`${rootPath}${sep}`))) {
    throw new DomainExpertWorkerError(400, 'path_escape_denied', 'relative_path escapes the domain workspace root.');
  }
  return target;
}

async function resolveWritePathInside(
  rootPath: string,
  relativePath: string,
  containmentMessage = 'relative_path escapes the domain workspace root.',
): Promise<string> {
  const target = resolveInside(rootPath, relativePath);
  const relativeTarget = relative(rootPath, target);
  let component = rootPath;
  for (const segment of relativeTarget.split(sep).filter(Boolean)) {
    component = join(component, segment);
    const info = await lstat(component).catch((error) => {
      if (isFileSystemError(error, 'ENOENT')) return undefined;
      throw error;
    });
    if (!info) break;
    if (info.isSymbolicLink()) {
      throw new DomainExpertWorkerError(400, 'path_escape_denied', containmentMessage);
    }
  }

  const canonicalRoot = await realpath(rootPath);
  let existingAncestor = target;
  while (true) {
    try {
      const canonicalAncestor = await realpath(existingAncestor);
      if (!(canonicalAncestor === canonicalRoot || canonicalAncestor.startsWith(`${canonicalRoot}${sep}`))) {
        throw new DomainExpertWorkerError(400, 'path_escape_denied', containmentMessage);
      }
      break;
    } catch (error) {
      if (!isFileSystemError(error, 'ENOENT')) throw error;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      existingAncestor = parent;
    }
  }

  return target;
}

async function writeWorkspaceImportFile(path: string, bytes: Uint8Array, relativePath: string): Promise<void> {
  try {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (isFileSystemError(error, 'EEXIST')) {
      throw new DomainExpertWorkerError(409, 'workspace_file_exists', `${relativePath} already exists.`);
    }
    throw error;
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === code);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function audit(root: DomainExpertWorkspaceRootPolicy, record: Record<string, unknown>): Promise<void> {
  if (!root.auditPath) return;
  await mkdir(dirname(root.auditPath), { recursive: true });
  await appendFile(root.auditPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function documentReadResult(domainId: string, doc: Record<string, any>): Record<string, unknown> {
  const text = extractDocumentText(doc);
  return {
    kind: 'domain_doc_read',
    domain_id: domainId,
    document_id: doc.documentId,
    title: doc.title,
    revision_id: doc.revisionId,
    text,
    text_chars: text.length,
    suggestions_view_mode: doc.suggestionsViewMode,
    policy: domainPolicy(),
  };
}

function extractDocumentText(doc: Record<string, any>): string {
  const pieces: string[] = [];
  const content = doc.body?.content ?? doc.tabs?.[0]?.documentTab?.body?.content ?? [];
  for (const element of content) {
    for (const paragraphElement of element.paragraph?.elements ?? []) {
      const text = paragraphElement.textRun?.content;
      if (typeof text === 'string') pieces.push(text);
    }
  }
  return pieces.join('');
}

function extractDocumentTextRange(doc: Record<string, any>, start: number, end: number): string {
  const pieces: string[] = [];
  const content = doc.body?.content ?? doc.tabs?.[0]?.documentTab?.body?.content ?? [];
  for (const element of content) {
    for (const paragraphElement of element.paragraph?.elements ?? []) {
      const text = paragraphElement.textRun?.content;
      const startIndex = paragraphElement.startIndex;
      const endIndex = paragraphElement.endIndex;
      if (typeof text !== 'string' || typeof startIndex !== 'number' || typeof endIndex !== 'number') continue;
      const sliceStart = Math.max(start, startIndex) - startIndex;
      const sliceEnd = Math.min(end, endIndex) - startIndex;
      if (sliceEnd > sliceStart) pieces.push(text.slice(sliceStart, sliceEnd));
    }
  }
  return pieces.join('');
}

function documentEndIndex(doc: Record<string, any>): number {
  const content = doc.body?.content ?? doc.tabs?.[0]?.documentTab?.body?.content ?? [];
  const endIndexes = content.map((item: Record<string, unknown>) => typeof item.endIndex === 'number' ? item.endIndex : 1);
  return Math.max(1, ...endIndexes) - 1;
}

function styleFromManifest(manifest: ReturnType<typeof domainManifest>): Record<string, unknown> {
  return {
    foregroundColor: { color: { rgbColor: manifest.visual_review_style.foreground_color } },
    backgroundColor: { color: { rgbColor: manifest.visual_review_style.background_color } },
  };
}

async function appendLedger(dataDir: string, record: VisualEditLedgerRecord): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const ledgerPath = join(dataDir, 'domain-doc-edits.jsonl');
  await chmod(ledgerPath, 0o600).catch((error) => {
    if (!isFileSystemError(error, 'ENOENT')) throw error;
  });
  await appendFile(ledgerPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function findLedgerRecord(dataDir: string, editBatchId: string): Promise<VisualEditLedgerRecord | undefined> {
  const path = join(dataDir, 'domain-doc-edits.jsonl');
  const raw = await readFile(path, 'utf8').catch(() => '');
  return raw.split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as VisualEditLedgerRecord)
    .reverse()
    .find((record) => record.edit_batch_id === editBatchId);
}

function corpusResourceNameFromParts(project: string, location: string, corpusId: string): string {
  return `projects/${project}/locations/${location}/ragCorpora/${corpusId}`;
}

function isNumericRagCorpusId(value: string): boolean {
  return /^\d+$/.test(value);
}

function isFullRagCorpusResourceName(value: string): boolean {
  return parseRagCorpusResourceName(value) !== undefined;
}

function parseRagCorpusResourceName(value: string): ParsedRagCorpusResourceName | undefined {
  const match = /^projects\/([^/]+)\/locations\/([^/]+)\/ragCorpora\/(\d+)$/.exec(value);
  if (!match) return undefined;
  return {
    project: match[1]!,
    location: match[2]!,
    corpusId: match[3]!,
  };
}

function parseRagFileResourceName(value: string): ParsedRagFileResourceName | undefined {
  const match = /^projects\/([^/]+)\/locations\/([^/]+)\/ragCorpora\/(\d+)\/ragFiles\/([^/]+)$/.exec(value);
  if (!match) return undefined;
  return {
    project: match[1]!,
    location: match[2]!,
    corpusId: match[3]!,
    fileId: match[4]!,
  };
}

function assertRagFileBelongsToCorpus(
  ragFileName: string,
  corpusName: string,
  options: { allowedProjects?: Iterable<string> } = {},
): void {
  const parsedFile = parseRagFileResourceName(ragFileName);
  if (!parsedFile) {
    throw new DomainExpertWorkerError(
      400,
      'invalid_rag_file_resource',
      'rag_file_name must be a full Vertex ragFiles resource name.',
    );
  }
  const parsedCorpus = parseRagCorpusResourceName(corpusName);
  if (!parsedCorpus) {
    throw new DomainExpertWorkerError(500, 'invalid_rag_corpus_resource', 'Google returned an invalid RAG corpus resource name.');
  }
  const allowedProjects = new Set([parsedCorpus.project, ...(options.allowedProjects ?? [])]);
  if (
    parsedFile.location !== parsedCorpus.location
    || parsedFile.corpusId !== parsedCorpus.corpusId
    || !allowedProjects.has(parsedFile.project)
  ) {
    throw new DomainExpertWorkerError(
      403,
      'rag_file_foreign_corpus',
      'rag_file_name must belong to the resolved RAG corpus.',
    );
  }
}

function corpusIdFromResourceName(resourceName: string): string {
  const parsed = parseRagCorpusResourceName(resourceName);
  if (!parsed) {
    throw new DomainExpertWorkerError(500, 'invalid_rag_corpus_resource', 'Google returned an invalid RAG corpus resource name.');
  }
  return parsed.corpusId;
}

function ragCorpusMappingKey(project: string, location: string, displayName: string): string {
  return `${project}/${location}/${displayName}`;
}

function isValidRagCorpusMapping(
  mapping: RagCorpusMappingRecord,
  project: string,
  location: string,
  displayName: string,
): boolean {
  if (
    !mapping
    || typeof mapping !== 'object'
    || mapping.project !== project
    || mapping.location !== location
    || mapping.display_name !== displayName
    || typeof mapping.corpus_id !== 'string'
    || typeof mapping.resource_name !== 'string'
  ) return false;
  const match = /^projects\/([^/]+)\/locations\/([^/]+)\/ragCorpora\/([^/]+)$/.exec(mapping.resource_name);
  return Boolean(
    match
    && match[1] === project
    && match[2] === location
    && match[3] === mapping.corpus_id,
  );
}

function ragCorpusMappingFileWarning(): RagCorpusMappingFileWarning {
  return {
    code: 'rag_corpus_mapping_file_unreadable',
    message: 'rag-corpus-mapping.json could not be validated; rebuilding corpus name mappings from Vertex ragCorpora.',
    mapping_file: 'rag-corpus-mapping.json',
  };
}

function ragCorpusProjectAliasKey(manifestProject: string, location: string, corpusId: string): string {
  return `${manifestProject}/${location}/${corpusId}`;
}

function ragCorpusMappingPath(dataDir: string): string {
  return join(dataDir, 'rag-corpus-mapping.json');
}

async function inspectRagCorpusMappingCache(dataDir: string): Promise<Record<string, unknown>> {
  const path = ragCorpusMappingPath(dataDir);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { file: 'rag-corpus-mapping.json', exists: false, entry_count: 0 };
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RagCorpusMappingFile>;
    const corpora = parsed.corpora && typeof parsed.corpora === 'object' && !Array.isArray(parsed.corpora)
      ? parsed.corpora
      : {};
    return {
      file: 'rag-corpus-mapping.json',
      exists: true,
      readable: true,
      entry_count: Object.keys(corpora).length,
    };
  } catch {
    return {
      file: 'rag-corpus-mapping.json',
      exists: true,
      readable: false,
      entry_count: 0,
    };
  }
}

async function inspectConfiguredScopeManifest(
  path: string,
  configuredTargetCorpus: string | undefined,
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
    return {
      configured: true,
      present: !missing,
      parseable: false,
    };
  }

  try {
    const scope = parseScopeManifest(text);
    return {
      configured: true,
      present: true,
      parseable: true,
      agent_id: scope.agentId,
      selected_object_count: scope.selection.objectIds.length,
      target_corpus_display_name: scope.targetCorpusDisplayName,
      target_matches_routing: scope.targetCorpusDisplayName === configuredTargetCorpus,
    };
  } catch {
    return {
      configured: true,
      present: true,
      parseable: false,
    };
  }
}

function ragCorpusWarning(corpusId: string, error: DomainExpertWorkerError): RagCorpusNotFoundWarning {
  return {
    corpus_id: corpusId,
    code: 'rag_corpus_not_found',
    message: error.message,
    suggestion: error.suggestion ?? `Run rag_corpus create with corpus_id "${corpusId}" before asking.`,
  };
}

function ragCorpusWarnings(resolved: ResolvedRagCorpus): RagCorpusWarning[] {
  return resolved.warnings ?? [];
}

function duplicateRagCorpusWarnings(
  displayName: string,
  matches: Array<{ name: string; displayName?: string }>,
): RagCorpusDuplicateDisplayNameWarning[] {
  if (matches.length <= 1) return [];
  const duplicateResourceNames = matches.map((match) => match.name);
  return [{
    corpus_id: displayName,
    code: 'rag_corpus_duplicate_display_name',
    display_name: displayName,
    selected_resource_name: matches[0]!.name,
    duplicate_resource_names: duplicateResourceNames,
    selection_order: 'Vertex ragCorpora list order; the runtime selects the first matching displayName returned by the API.',
    message: `Multiple Vertex RAG corpora use displayName "${displayName}"; selected the first corpus returned by ragCorpora list.`,
  }];
}

/**
 * These refusals echo only what the caller supplied, plus configuration the
 * caller could already read from a status response. A served deployment must
 * not learn which corpora a domain holds from the shape of a rejection, so no
 * configured display name and no resolved resource name appears in one.
 */
function corpusNotConfiguredForDomainError(
  manifest: ReturnType<typeof domainManifest>,
  requested: string,
): DomainExpertWorkerError {
  console.warn(JSON.stringify({
    kind: 'domain_expert_corpus_not_configured_for_domain',
    domain_id: manifest.domain_id,
  }));
  return new DomainExpertWorkerError(
    403,
    'rag_corpus_not_configured_for_domain',
    `RAG corpus "${requested}" is not configured for domain "${manifest.domain_id}".`,
    'Ask against a corpus this domain is routed to in the agent routing configuration.',
  );
}

function ragCorpusForeignProjectError(
  manifest: ReturnType<typeof domainManifest>,
  project: string,
): DomainExpertWorkerError {
  return new DomainExpertWorkerError(
    403,
    'rag_corpus_foreign_project',
    `corpus_id names project "${project}", which is not the project configured for domain "${manifest.domain_id}".`,
    'Name the corpus by its display name, or by a resource name inside the configured project.',
  );
}

function ragCorpusForeignLocationError(
  manifest: ReturnType<typeof domainManifest>,
  location: string,
): DomainExpertWorkerError {
  return new DomainExpertWorkerError(
    403,
    'rag_corpus_foreign_location',
    `corpus_id names location "${location}", which is not the RAG location configured for domain "${manifest.domain_id}".`,
    `Name a corpus in ${manifest.rag_location}, the location this domain is configured for.`,
  );
}

function ragCorpusNotFoundError(corpus: string, project: string, location: string): DomainExpertWorkerError {
  return new DomainExpertWorkerError(
    404,
    'rag_corpus_not_found',
    `Could not resolve RAG corpus "${corpus}" in ${project}/${location}.`,
    `Run rag_corpus create with corpus_id "${corpus}" before asking, importing, or checking status.`,
  );
}

function ragFileNotFoundError(ragFileName: string): DomainExpertWorkerError {
  return new DomainExpertWorkerError(
    404,
    'rag_file_not_found',
    `RAG file "${ragFileName}" was not found.`,
    'List the corpus files and use the name of a file that still exists.',
  );
}

function isGoogleNotFoundError(error: unknown): error is DomainExpertWorkerError {
  return error instanceof DomainExpertWorkerError
    && error.status === 404
    && error.code === 'google_api_error';
}

function googleNotFoundResourceKind(
  error: DomainExpertWorkerError,
  corpusResourceName: string,
): 'corpus' | 'child' | 'unknown' {
  const body = error.googleErrorBody;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'unknown';
  const googleError = (body as Record<string, unknown>).error;
  if (!googleError || typeof googleError !== 'object' || Array.isArray(googleError)) return 'unknown';
  const details = (googleError as Record<string, unknown>).details;
  if (!Array.isArray(details)) return 'unknown';
  for (const detail of details) {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) continue;
    const record = detail as Record<string, unknown>;
    const resourceName = typeof record.resourceName === 'string' ? record.resourceName : undefined;
    const resourceType = typeof record.resourceType === 'string' ? record.resourceType.toLowerCase() : '';
    if (resourceName === corpusResourceName || resourceType.endsWith('/ragcorpus')) return 'corpus';
    if (resourceName?.startsWith(`${corpusResourceName}/`) || resourceType.endsWith('/ragfile')) return 'child';
  }
  return 'unknown';
}

async function writeJsonFileAtomically(path: string, value: unknown): Promise<void> {
  replaceDurably(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendCompleteLine(path: string, line: string): Promise<void> {
  const handle = await open(path, 'a');
  try {
    await handle.write(line.endsWith('\n') ? line : `${line}\n`);
  } finally {
    await handle.close();
  }
}

async function planStageImportFiles(
  rootPath: string,
  targetPath: string,
  destinationBucket: string,
  destinationObjectPrefix: string,
  options: { includeMedia?: boolean } = {},
): Promise<{ eligible: StageImportEligibleFile[]; skipped: StageImportSkippedFile[]; totalBytes: number }> {
  const files = await collectStageImportFiles(rootPath, targetPath);
  return planStageImportCandidates(files, destinationBucket, destinationObjectPrefix, options);
}

function preflightDerivativeWrites<T extends { fileName: string; bytes: Uint8Array }>(
  files: T[],
  maxWriteBytes: number,
  workspaceRelativeRoot: string,
): { files: T[]; skipped: StageImportSkippedFile[] } {
  const accepted: T[] = [];
  const skipped: StageImportSkippedFile[] = [];
  for (const file of files) {
    if (file.bytes.byteLength > maxWriteBytes) {
      skipped.push({
        workspace_relative_path: `${workspaceRelativeRoot}/${file.fileName}`,
        reason: 'file_size_limit_exceeded',
        bytes: file.bytes.byteLength,
      });
    } else {
      accepted.push(file);
    }
  }
  return { files: accepted, skipped };
}

function planStageImportCandidates(
  files: Array<{
    workspaceRelativePath: string;
    uploadRelativePath: string;
    absolutePath: string;
    bytes: number;
  }>,
  destinationBucket: string,
  destinationObjectPrefix: string,
  options: { includeMedia?: boolean } = {},
): { eligible: StageImportEligibleFile[]; skipped: StageImportSkippedFile[]; totalBytes: number } {
  const eligible: StageImportEligibleFile[] = [];
  const skipped: StageImportSkippedFile[] = [];
  let totalBytes = 0;
  const allowedExtensions = allowedStageImportExtensions(options.includeMedia ?? false);
  for (const file of files) {
    const extension = extname(file.workspaceRelativePath).toLowerCase();
    if (isJunkStageImportPath(file.workspaceRelativePath)) {
      skipped.push({
        workspace_relative_path: file.workspaceRelativePath,
        reason: 'junk_file',
        bytes: file.bytes,
      });
      continue;
    }
    if (!allowedExtensions.has(extension)) {
      skipped.push({
        workspace_relative_path: file.workspaceRelativePath,
        reason: `extension_not_allowed:${extension || '<none>'}`,
        bytes: file.bytes,
      });
      continue;
    }
    const maxFileBytes = maxStageFileBytes(file.workspaceRelativePath);
    if (file.bytes > maxFileBytes) {
      skipped.push({
        workspace_relative_path: file.workspaceRelativePath,
        reason: 'file_size_limit_exceeded',
        bytes: file.bytes,
      });
      continue;
    }
    const countsAgainstTextBatchCap = !isTranscribableMediaPath(file.workspaceRelativePath);
    if (countsAgainstTextBatchCap && totalBytes + file.bytes > STAGE_IMPORT_MAX_BATCH_BYTES) {
      skipped.push({
        workspace_relative_path: file.workspaceRelativePath,
        reason: 'batch_size_limit_exceeded',
        bytes: file.bytes,
      });
      continue;
    }
    if (countsAgainstTextBatchCap) totalBytes += file.bytes;
    const uploadRelativePath = safeGcsRelativePath(file.uploadRelativePath);
    const objectName = `${destinationObjectPrefix}${uploadRelativePath}`;
    eligible.push({
      workspaceRelativePath: file.workspaceRelativePath,
      uploadRelativePath,
      absolutePath: file.absolutePath,
      bytes: file.bytes,
      objectName,
      gcsUri: `gs://${destinationBucket}/${objectName}`,
    });
  }
  return { eligible, skipped, totalBytes };
}

function allowedStageImportExtensions(includeMedia: boolean): Set<string> {
  return includeMedia
    ? new Set([...STAGE_IMPORT_ALLOWED_EXTENSIONS, ...STAGE_IMPORT_MEDIA_EXTENSIONS])
    : new Set(STAGE_IMPORT_ALLOWED_EXTENSIONS);
}

function maxStageFileBytes(path: string): number {
  if (extname(path).toLowerCase() === '.pdf') return PDF_PROCESSING_MAX_BYTES;
  return isTranscribableMediaPath(path) ? MEDIA_TRANSCRIBE_MAX_BYTES : STAGE_IMPORT_MAX_FILE_BYTES;
}

function isTranscribableMediaPath(path: string): boolean {
  return STAGE_IMPORT_TRANSCRIBABLE_MEDIA_EXTENSIONS.has(extname(path).toLowerCase());
}

function isJunkStageImportPath(workspaceRelativePath: string): boolean {
  return workspaceRelativePath.split('/').some((segment) => (
    segment === '.DS_Store'
    || segment.startsWith('._')
    || (segment.startsWith('.') && segment.length > 1)
  ));
}

async function collectStageImportFiles(
  rootPath: string,
  targetPath: string,
): Promise<Array<{
  workspaceRelativePath: string;
  uploadRelativePath: string;
  absolutePath: string;
  bytes: number;
}>> {
  const targetInfo = await stat(targetPath).catch(() => undefined);
  if (!targetInfo) throw new DomainExpertWorkerError(404, 'workspace_path_not_found', 'workspace_relative_path does not exist.');
  const rootRealPath = await realpath(rootPath);
  const targetRealPath = await realpath(targetPath);
  const targetIsDirectory = targetInfo.isDirectory();
  const paths = targetIsDirectory
    ? await collectFilesRecursively(rootRealPath, targetRealPath)
    : [targetRealPath];
  const files = [];
  for (const absolutePath of paths) {
    await assertRealPathInside(rootRealPath, absolutePath, 'workspace_relative_path escapes the domain workspace root.');
    const info = await stat(absolutePath);
    if (!info.isFile()) continue;
    const workspaceRelativePath = toPortableRelativePath(rootRealPath, absolutePath);
    const uploadRelativePath = targetIsDirectory
      ? toPortableRelativePath(targetRealPath, absolutePath)
      : basename(absolutePath);
    files.push({
      workspaceRelativePath,
      uploadRelativePath,
      absolutePath,
      bytes: info.size,
    });
  }
  return files.sort((left, right) => left.workspaceRelativePath.localeCompare(right.workspaceRelativePath));
}

async function collectFilesRecursively(rootRealPath: string, directoryPath: string): Promise<string[]> {
  await assertRealPathInside(rootRealPath, directoryPath, 'workspace_relative_path escapes the domain workspace root.');
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(directoryPath, entry.name);
    const info = await stat(absolutePath);
    if (info.isDirectory()) {
      files.push(...await collectFilesRecursively(rootRealPath, await realpath(absolutePath)));
    } else if (info.isFile()) {
      files.push(await realpath(absolutePath));
    }
  }
  return files.sort();
}

async function assertRealPathInside(rootPath: string, targetPath: string, message: string): Promise<void> {
  const rootRealPath = await realpath(rootPath);
  const targetRealPath = await realpath(targetPath);
  if (!(targetRealPath === rootRealPath || targetRealPath.startsWith(`${rootRealPath}${sep}`))) {
    throw new DomainExpertWorkerError(400, 'path_escape_denied', message);
  }
}

function toPortableRelativePath(rootPath: string, targetPath: string): string {
  return relative(rootPath, targetPath).split(sep).join('/');
}

function normalizeStageBatchId(value: string): string {
  const batchId = requireString(value, 'batch_id');
  if (!/^[A-Za-z0-9._-]+$/.test(batchId)) {
    throw new DomainExpertWorkerError(400, 'invalid_batch_id', 'batch_id may contain only letters, numbers, dots, underscores, and hyphens.');
  }
  return batchId;
}

function safeGcsRelativePath(value: string): string {
  const segments = value.split('/').filter(Boolean).map((segment) => safeObjectName(segment));
  if (segments.length === 0) throw new DomainExpertWorkerError(400, 'invalid_stage_path', 'stage_import file path is empty.');
  return segments.join('/');
}

function extractRagCorpusResourceName(value: unknown): string | undefined {
  if (typeof value === 'string') return isFullRagCorpusResourceName(value) ? value : undefined;
  if (!value || typeof value !== 'object') return undefined;
  for (const item of Object.values(value as Record<string, unknown>)) {
    const found = extractRagCorpusResourceName(item);
    if (found) return found;
  }
  return undefined;
}

function defaultCorpusId(manifest: ReturnType<typeof domainManifest>): string {
  requireConfiguredAgent(manifest, 'rag_corpus');
  return configuredCorpusId(manifest)!;
}

function vertexBase(location: string): string {
  if (location === 'global') return 'https://aiplatform.googleapis.com';
  return `https://${location}-aiplatform.googleapis.com`;
}

function signJwt(header: Record<string, unknown>, claim: Record<string, unknown>, privateKey: string): string {
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedClaim = base64Url(JSON.stringify(claim));
  const signingInput = `${encodedHeader}.${encodedClaim}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  return `${signingInput}.${base64Url(signature)}`;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function responseTextOrJson(response: Response): Promise<unknown> {
  const contentKind = response.headers.get('content-type')?.toLowerCase().includes('html') ? 'HTML' : 'JSON';
  const maxBytes = contentKind === 'HTML' ? UPSTREAM_HTML_MAX_BYTES : UPSTREAM_JSON_MAX_BYTES;
  const text = await readCappedUpstreamText(response, contentKind, maxBytes);
  if (!text) return {};
  try {
    return redactConfiguredValuesInUpstreamBody(
      JSON.parse(text),
      upstreamResponseContexts.get(response)?.sensitiveValues ?? [],
    );
  } catch {
    return {
      text: redactConfiguredValues(
        text,
        upstreamResponseContexts.get(response)?.sensitiveValues ?? [],
      ),
    };
  }
}

async function readCappedUpstreamText(
  response: Response,
  contentKind: 'JSON' | 'HTML',
  maxBytes: number,
): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new UpstreamResponseSizeLimitError(contentKind, maxBytes);
  }
  if (!response.body) return '';
  const context = upstreamResponseContexts.get(response);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const pieces: string[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = context ? await readWebImportChunk(reader, context.signal) : await reader.read();
      if (result.done) break;
      if (!result.value) continue;
      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new UpstreamResponseSizeLimitError(contentKind, maxBytes);
      }
      pieces.push(decoder.decode(result.value, { stream: true }));
    }
    pieces.push(decoder.decode());
    return pieces.join('');
  } catch (error) {
    if (context?.signal.aborted) {
      await reader.cancel().catch(() => {});
      throw context.timeoutError();
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function googleRequestTimeoutError(): DomainExpertWorkerError {
  return new DomainExpertWorkerError(504, 'google_api_error', 'Google API request timed out.');
}

function googleError(response: Response, body: unknown): DomainExpertWorkerError {
  const upstreamMessage = typeof body === 'object' && body && 'error' in body
    ? JSON.stringify((body as Record<string, unknown>).error)
    : `Google API request failed with HTTP ${response.status}.`;
  const message = sanitizeUpstreamText(
    upstreamMessage,
    upstreamResponseContexts.get(response)?.sensitiveValues ?? [],
    UPSTREAM_ERROR_TEXT_MAX_CHARACTERS,
  );
  const error = new DomainExpertWorkerError(response.status, 'google_api_error', message);
  // The raw body feeds only googleNotFoundResourceKind; it never reaches a
  // response or journal line, so it stays unsanitized for classification.
  error.googleErrorBody = body;
  return error;
}

function redactConfiguredValuesInUpstreamBody(value: unknown, sensitiveValues: string[]): unknown {
  if (typeof value === 'string') return redactConfiguredValues(value, sensitiveValues);
  if (Array.isArray(value)) return value.map((item) => redactConfiguredValuesInUpstreamBody(item, sensitiveValues));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    redactConfiguredValuesInUpstreamBody(item, sensitiveValues),
  ]));
}

function redactConfiguredValues(value: string, sensitiveValues: string[]): string {
  let redacted = value;
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue) redacted = redacted.replaceAll(sensitiveValue, ANNAS_REDACTED);
  }
  return redacted;
}

function sanitizeUpstreamText(value: string, sensitiveValues: string[], maxCharacters: number): string {
  return redactConfiguredValues(value, sensitiveValues)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, maxCharacters);
}

function annasUrl(template: string | undefined, baseUrl: string | undefined, path: string, params: Record<string, string | undefined>): string | undefined {
  if (template) {
    return Object.entries(params).reduce(
      (url, [key, value]) => url.replaceAll(`{${key}}`, encodeURIComponent(value ?? '')),
      template,
    );
  }
  if (!baseUrl) return undefined;
  const url = new URL(`${trimTrailingSlash(baseUrl)}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

function annasHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'X-API-Key': apiKey,
  };
}

async function fetchAnnasDownload(
  fetchImpl: typeof fetch,
  downloadUrl: string,
  config: DomainExpertAnnasConfig,
  apiKey: string,
): Promise<{ response: Response; url: string }> {
  const result = await fetchAnnasCredentialed(fetchImpl, downloadUrl, {
    config,
    apiKey,
    purpose: 'download',
  });
  if (!result.response.ok) {
    await result.response.body?.cancel().catch(() => {});
    throw new DomainExpertWorkerError(result.response.status, 'annas_archive_error', 'Anna Archive download failed.');
  }
  return result;
}

async function fetchAnnasCredentialed(
  fetchImpl: typeof fetch,
  rawUrl: string,
  options: {
    config: DomainExpertAnnasConfig;
    apiKey: string;
    purpose: 'download' | 'search';
  },
): Promise<{ response: Response; url: string }> {
  let current = requireAllowedAnnasCredentialUrl(rawUrl, options.config, options.purpose);
  for (let redirects = 0; redirects <= ANNAS_ARCHIVE_MAX_REDIRECTS; redirects += 1) {
    const signal = AbortSignal.timeout(ANNAS_ARCHIVE_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(current.toString(), {
        headers: annasHeaders(options.apiKey),
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw annasRequestTimeoutError();
      throw error;
    }
    upstreamResponseContexts.set(response, {
      signal,
      timeoutError: annasRequestTimeoutError,
      sensitiveValues: [options.apiKey],
    });
    if (!isRedirectStatus(response.status)) {
      return { response, url: current.toString() };
    }
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (!location) {
      throw new DomainExpertWorkerError(400, 'annas_archive_redirect_without_location', 'Anna Archive request redirect did not include a Location header.');
    }
    current = requireAllowedAnnasCredentialUrl(new URL(location, current).toString(), options.config, options.purpose);
  }
  throw new DomainExpertWorkerError(400, 'annas_archive_redirect_limit_exceeded', 'Anna Archive request exceeded the maximum redirect count.');
}

function annasRequestTimeoutError(): DomainExpertWorkerError {
  return new DomainExpertWorkerError(408, 'annas_archive_error', 'Anna Archive request timed out.');
}

function requireAllowedAnnasCredentialUrl(rawUrl: string, config: DomainExpertAnnasConfig, purpose: 'download' | 'search'): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DomainExpertWorkerError(400, 'invalid_annas_archive_url', 'Anna Archive download URL must be absolute.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new DomainExpertWorkerError(403, 'annas_archive_url_not_allowed', 'Anna Archive credentials may only be sent to HTTPS Anna Archive endpoints without embedded credentials.');
  }
  const allowedOrigins = annasCredentialOrigins(config, purpose);
  if (allowedOrigins.size === 0) {
    throw new DomainExpertWorkerError(503, 'annas_archive_not_configured', `Anna Archive base URL or ${purpose} URL template is required for live ${purpose} requests.`);
  }
  if (!allowedOrigins.has(url.origin)) {
    throw new DomainExpertWorkerError(403, 'annas_archive_url_not_allowed', 'Anna Archive credentials may only be sent to the configured Anna Archive origin.');
  }
  return url;
}

function annasCredentialOrigins(config: DomainExpertAnnasConfig, purpose: 'download' | 'search'): Set<string> {
  const origins = new Set<string>();
  const template = purpose === 'download' ? config.downloadUrlTemplate : config.searchUrlTemplate;
  for (const candidate of [config.baseUrl, template]) {
    const origin = annasCredentialOrigin(candidate);
    if (origin) origins.add(origin);
  }
  return origins;
}

function annasCredentialOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

async function fetchAnnasPartnerDownload(input: {
  fetchImpl: WebImportFetchImpl;
  resolveHost: ResolveHostImpl;
  rawUrl: string;
  timeoutMs: number;
}): Promise<{ response: Response; url: string }> {
  // Partner hosts sit outside the credential allowlist. They receive the opaque URL the
  // member API just issued and nothing else: no Authorization, no X-API-Key, no secret.
  //
  // That URL is whatever the member API answered with, so a hostile or compromised
  // upstream picks the destination. Every hop therefore takes the same guarded
  // resolution web_import takes — resolve the name, refuse private and reserved space,
  // and connect only to an address that was validated — and a redirect is re-guarded
  // rather than trusted because it followed one that passed.
  let current = requireAnnasPartnerUrl(input.rawUrl);
  for (let redirects = 0; redirects <= ANNAS_ARCHIVE_MAX_REDIRECTS; redirects += 1) {
    const validatedAddresses = await assertAnnasPartnerUrlAllowed(current, input.resolveHost);
    const controller = new AbortController();
    // Bounds the connect and header exchange only. The body that follows is read by
    // readCappedAnnasDownloadBody under its own timeout, so this one is cleared as
    // soon as the response head is in rather than cutting the download short.
    const connect = setTimeout(() => controller.abort(), input.timeoutMs);
    let response: Response;
    try {
      response = await input.fetchImpl(current, { signal: controller.signal, validatedAddresses });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new DomainExpertWorkerError(408, 'annas_archive_download_timeout', 'Anna Archive partner download timed out.');
      }
      throw error;
    } finally {
      clearTimeout(connect);
    }
    if (!isRedirectStatus(response.status)) {
      return { response, url: current.toString() };
    }
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (!location) {
      throw new DomainExpertWorkerError(400, 'annas_archive_redirect_without_location', 'Anna Archive partner download redirect did not include a Location header.');
    }
    current = requireAnnasPartnerUrl(new URL(location, current).toString());
  }
  throw new DomainExpertWorkerError(400, 'annas_archive_redirect_limit_exceeded', 'Anna Archive partner download exceeded the maximum redirect count.');
}

function requireAnnasPartnerUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DomainExpertWorkerError(502, 'invalid_annas_archive_url', 'Anna Archive fast download returned a partner URL that is not absolute.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new DomainExpertWorkerError(403, 'annas_archive_url_not_allowed', 'Anna Archive partner downloads must use HTTPS without embedded credentials.');
  }
  return url;
}

function annasFastDownloadMd5(params: AnnasArchiveImportParams): string | undefined {
  for (const candidate of [params.md5, params.annasArchiveId, ANNAS_RECORD_MD5_PATH.exec(params.url ?? '')?.[1]]) {
    const value = candidate?.trim().toLowerCase();
    if (value && ANNAS_MD5_VALUE.test(value)) return value;
  }
  return undefined;
}

function annasFastDownloadUrl(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>).download_url;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function annasFastDownloadError(response: Response, body: unknown, apiKey: string): DomainExpertWorkerError {
  const reported = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).error
    : undefined;
  // The member API reports an exhausted fast-download quota or a bad key in this field.
  // Naming it keeps the failure honest instead of writing the envelope out as the book.
  const cause = sanitizeUpstreamText(
    typeof reported === 'string' && reported.trim() ? reported.trim() : `HTTP ${response.status}`,
    [apiKey],
    UPSTREAM_ERROR_TEXT_MAX_CHARACTERS,
  );
  return new DomainExpertWorkerError(
    response.status >= 400 && response.status < 500 ? response.status : 502,
    'annas_archive_fast_download_unavailable',
    `Anna Archive fast download returned no download URL: ${cause}`,
  );
}

function annasRedactedUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username) parsed.username = ANNAS_REDACTED;
    if (parsed.password) parsed.password = ANNAS_REDACTED;
    for (const key of [...parsed.searchParams.keys()]) {
      if (ANNAS_CREDENTIAL_QUERY_PARAMETER.test(key)) {
        parsed.searchParams.set(key, ANNAS_REDACTED);
      }
    }
    return parsed.toString();
  } catch {
    return url.replace(/([?&])([^=&#]+)=([^&#]*)/g, (match, separator: string, rawKey: string) => {
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey);
      } catch {}
      return ANNAS_CREDENTIAL_QUERY_PARAMETER.test(key)
        ? `${separator}${rawKey}=${ANNAS_REDACTED}`
        : match;
    });
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readCappedAnnasDownloadBody(response: Response, url: string, timeoutMs: number, maxDownloadBytes: number): Promise<Uint8Array> {
  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
  if (contentLength !== undefined && Number.isFinite(contentLength) && contentLength > maxDownloadBytes) {
    await response.body?.cancel().catch(() => {});
    throw annasDownloadSizeError(url, maxDownloadBytes);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await readCappedAnnasDownloadBodyWithSignal(response, url, controller.signal, maxDownloadBytes);
  } finally {
    clearTimeout(timeout);
  }
}

async function readCappedAnnasDownloadBodyWithSignal(response: Response, url: string, signal: AbortSignal, maxDownloadBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxDownloadBytes) throw annasDownloadSizeError(url, maxDownloadBytes);
    return bytes;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        throw annasDownloadTimeoutError(url);
      }
      const { done, value } = await readWebImportChunk(reader, signal);
      if (done) break;
      if (!value) continue;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += chunk.byteLength;
      if (totalBytes > maxDownloadBytes) {
        await reader.cancel().catch(() => {});
        throw annasDownloadSizeError(url, maxDownloadBytes);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (signal.aborted || upstreamResponseContexts.get(response)?.signal.aborted) {
      await reader.cancel().catch(() => {});
      throw annasDownloadTimeoutError(url);
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function annasDownloadSizeError(url: string, maxDownloadBytes: number): DomainExpertWorkerError {
  return new DomainExpertWorkerError(
    413,
    'annas_archive_download_size_limit_exceeded',
    `Anna Archive download from ${annasRedactedUrl(url)} exceeded the ${maxDownloadBytes} byte download limit.`,
  );
}

function annasDownloadTimeoutError(url: string): DomainExpertWorkerError {
  return new DomainExpertWorkerError(
    408,
    'annas_archive_download_timeout',
    `Timed out downloading Anna Archive item from ${annasRedactedUrl(url)}.`,
  );
}

function annasSearchCandidates(body: unknown): unknown[] {
  const structured = normalizeAnnasCandidates(body);
  if (structured.length) return structured;
  // responseTextOrJson wraps a non-JSON body as { text }; the live search endpoint is an
  // HTML page, so that wrapper is the normal path rather than an error path.
  const text = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).text
    : undefined;
  return typeof text === 'string' ? parseAnnasSearchHtml(text) : [];
}

function parseAnnasSearchHtml(html: string): Record<string, unknown>[] {
  // Anything from the partial-matches block onward is a fuzzy fallback the site shows
  // when the query itself found nothing; reporting it as a hit would be dishonest.
  const partialAt = html.indexOf(ANNAS_PARTIAL_MATCHES_MARKER);
  const exact = partialAt >= 0 ? html.slice(0, partialAt) : html;
  const hrefOffsets = [...exact.matchAll(ANNAS_MD5_HREF)].map((match) => match.index);
  const seen = new Set<string>();
  const records: Record<string, unknown>[] = [];
  for (const match of exact.matchAll(ANNAS_TITLE_ANCHOR)) {
    const md5 = (match[1] ?? '').toLowerCase();
    const title = annasHtmlText(match[2] ?? '');
    if (!title || seen.has(md5)) continue;
    seen.add(md5);
    // Each result carries a cover anchor and a title anchor to the same record, so the
    // next /md5/ href is the start of the following result and bounds this one.
    const blockStart = match.index + match[0].length;
    const blockEnd = hrefOffsets.find((offset) => offset >= blockStart) ?? exact.length;
    records.push({
      id: md5,
      md5,
      title,
      ...annasSearchRecordMetadata(exact.slice(blockStart, blockEnd)),
    });
    if (records.length >= ANNAS_SEARCH_RECORD_LIMIT) break;
  }
  return records;
}

/**
 * Library Genesis (libgen.li family) result table: one row per file with the
 * title cell first (an edition.php anchor plus badges), then authors, publisher,
 * year, language, pages, size, extension, and mirror links carrying the md5.
 * Rows without an md5 are headers or controls and are skipped; the md5 is the
 * identity the import path resolves, exactly as with an Anna Archive record.
 */
export function parseLibgenSearchHtml(html: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const row of html.matchAll(LIBGEN_ROW)) {
    const md5 = LIBGEN_MD5.exec(row[1] ?? '')?.[1]?.toLowerCase();
    if (!md5 || seen.has(md5)) continue;
    const cells = [...(row[1] ?? '').matchAll(LIBGEN_CELL)].map((cell) => cell[1] ?? '');
    if (cells.length < 8) continue;
    const title = annasHtmlText(stripHtmlTags(LIBGEN_TITLE_ANCHOR.exec(cells[0]!)?.[1] ?? ''));
    if (!title) continue;
    seen.add(md5);
    const text = (index: number) => annasHtmlText(stripHtmlTags(cells[index] ?? ''));
    const size = LIBGEN_SIZE.exec(text(6));
    const format = text(7).toLowerCase();
    const record: Record<string, unknown> = { id: md5, md5, title, source: 'libgen' };
    if (text(1)) record.author = text(1);
    if (text(2)) record.publisher = text(2);
    if (/^\d{4}$/.test(text(3))) record.year = text(3);
    if (text(4)) record.language = text(4);
    if (format && ANNAS_ARCHIVE_FORMATS.includes(format as AnnasArchiveFormat)) record.format = format;
    if (size) record.file_size_bytes = Math.round(Number(size[1]) * (ANNAS_SIZE_MULTIPLIER[(size[2] ?? '').toLowerCase()] ?? 1));
    records.push(record);
    if (records.length >= ANNAS_SEARCH_RECORD_LIMIT) break;
  }
  return records;
}

function stripHtmlTags(value: string): string {
  return value.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ');
}

function annasSearchRecordMetadata(block: string): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  const author = annasHtmlText(ANNAS_AUTHOR_ANCHOR.exec(block)?.[1] ?? '');
  if (author) record.author = author;
  // The single interpunct-separated text node holds language, format, size, and year;
  // pieces that do not match a known shape are left out rather than guessed at.
  const pieces = annasHtmlText(ANNAS_METADATA_TEXT.exec(block)?.[1] ?? '')
    .split(ANNAS_METADATA_SEPARATOR)
    .map((piece) => piece.trim())
    .filter(Boolean);
  for (const piece of pieces) {
    const size = ANNAS_SIZE_PIECE.exec(piece);
    const format = piece.toLowerCase();
    if (!record.language && ANNAS_LANGUAGE_PIECE.test(piece)) record.language = piece;
    else if (!record.format && format !== 'unknown' && ANNAS_ARCHIVE_FORMATS.includes(format as AnnasArchiveFormat)) record.format = format;
    else if (!record.file_size_bytes && size) record.file_size_bytes = Math.round(Number(size[1]) * (ANNAS_SIZE_MULTIPLIER[(size[2] ?? '').toLowerCase()] ?? 1));
    else if (!record.year && ANNAS_YEAR_PIECE.test(piece)) record.year = piece;
  }
  return record;
}

function annasHtmlText(value: string): string {
  return collapseWhitespace(decodeHtmlEntities(value));
}

function normalizeAnnasCandidates(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    for (const key of ['results', 'items', 'candidates', 'data']) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return [];
}


interface NormalizedAnnasCandidate {
  annas_archive_id?: string;
  stable_locator?: string;
  title?: string;
  author?: string;
  year?: string;
  format?: string;
  language?: string;
  file_size_bytes?: number;
  md5?: string;
  url?: string;
  score: number;
  rationale: string[];
}

function rankAnnasCandidates(items: unknown[], params: AnnasArchiveSearchParams): NormalizedAnnasCandidate[] {
  const limit = params.topN ?? params.maxResults ?? 10;
  const scored = items
    .map((item) => scoreAnnasCandidate(normalizeAnnasCandidate(item), params))
    .filter((candidate) => candidate.title || candidate.author || candidate.annas_archive_id || candidate.md5 || candidate.url);
  // Annotated across every candidate, not just the returned page, so a sibling
  // edition that falls outside top-N still informs the comparison.
  annotateAnnasSizeOutliers(scored);
  return scored
    .sort((left, right) => right.score - left.score || String(left.title ?? '').localeCompare(String(right.title ?? '')))
    .slice(0, limit);
}

// The 2026-07-29 impostor and the genuine edition came back from one search with
// identical titles, authors, years and scores. What actually separated them was
// being a small fraction of the size of the other edition of the same title —
// so that is what gets said out loud. Annotation only: no score change, no
// filtering, because size is not a quality signal on its own.
function annotateAnnasSizeOutliers(candidates: NormalizedAnnasCandidate[]): void {
  const groups = new Map<string, NormalizedAnnasCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.file_size_bytes || !candidate.title) continue;
    const key = normalizedAnnasTitleKey(candidate.title);
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const candidate of group) {
      const size = candidate.file_size_bytes ?? 0;
      // Median of the OTHER editions, never one that includes this candidate: a
      // group of two drags its own median halfway toward the outlier, so a
      // self-inclusive median would demand a 9x spread to fire at all and stay
      // silent on the 8x gap that produced the 2026-07-29 incident.
      const median = medianOfNumbers(
        group.filter((other) => other !== candidate).map((other) => other.file_size_bytes ?? 0),
      );
      if (size * ANNAS_SIZE_OUTLIER_FACTOR > median) continue;
      candidate.rationale.push(
        `unusually small vs other editions of this title (${humanByteSize(size)} vs ${humanByteSize(median)} median) — verify page count before ingest`,
      );
    }
  }
}

function normalizedAnnasTitleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function medianOfNumbers(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : sorted[middle] ?? 0;
}

// Anna Archive publishes sizes in binary units and the search parser reads them
// that way, so the rationale reports them back in the units the operator saw.
function humanByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function normalizeAnnasCandidate(item: unknown): Omit<NormalizedAnnasCandidate, 'score' | 'rationale'> {
  const record = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
  const md5 = annasCandidateString(record, ['md5', 'hash', 'file_md5']);
  const id = annasCandidateString(record, ['id', 'annas_archive_id', 'aacid', 'stable_id']);
  const url = annasCandidateString(record, ['url', 'download_url', 'href', 'link'], true);
  const stableLocator = md5 ? `md5:${md5}` : id ?? url;
  return {
    ...(id ? { annas_archive_id: id } : {}),
    ...(stableLocator ? { stable_locator: stableLocator } : {}),
    ...stringField('title', annasCandidateString(record, ['title', 'name', 'book_title'])),
    ...stringField('author', annasCandidateString(record, ['author', 'authors', 'creator'])),
    ...stringField('year', annasCandidateString(record, ['year', 'publication_year', 'published_year'])),
    ...stringField('format', normalizeAnnasFormat(annasCandidateString(record, ['format', 'extension', 'file_type', 'ext']))),
    ...stringField('language', annasCandidateString(record, ['language', 'lang', 'languages'])),
    ...numberField('file_size_bytes', firstCandidateNumber(record, ['file_size_bytes', 'filesize_bytes', 'size_bytes', 'filesize', 'size'])),
    ...(md5 ? { md5 } : {}),
    ...(url ? { url } : {}),
  };
}

function annasCandidateString(
  record: Record<string, unknown>,
  keys: string[],
  url = false,
): string | undefined {
  const value = firstCandidateString(record, keys);
  if (!value) return undefined;
  const sanitized = url ? annasRedactedUrl(value) : value;
  return sanitizeUpstreamText(sanitized, [], ANNAS_CANDIDATE_STRING_MAX_CHARACTERS);
}

function scoreAnnasCandidate(candidate: Omit<NormalizedAnnasCandidate, 'score' | 'rationale'>, params: AnnasArchiveSearchParams): NormalizedAnnasCandidate {
  let score = 0;
  const rationale: string[] = [];
  const topicTerms = tokenizeAnnasQuery([params.query, params.topic, params.title].filter(Boolean).join(' '));
  const haystack = [candidate.title, candidate.author].filter(Boolean).join(' ').toLowerCase();
  const matchedTerms = topicTerms.filter((term) => haystack.includes(term));
  if (matchedTerms.length) {
    score += matchedTerms.length * 5;
    rationale.push(`matched ${matchedTerms.length} query/topic term(s)`);
  }
  if (params.author && candidate.author?.toLowerCase().includes(params.author.toLowerCase())) {
    score += 8;
    rationale.push('author match');
  }
  if (params.language && candidate.language?.toLowerCase().includes(params.language.toLowerCase())) {
    score += 3;
    rationale.push('language match');
  }
  const format = candidate.format?.toLowerCase();
  const preference = params.formatPreference ?? 'auto';
  if (params.ingestIntent && format) {
    // Ranking for what the corpus can actually take. Before 2026-09-20 the
    // text_rag preference put EPUB first and the ingest path then uploaded
    // it unconverted, which Vertex silently imported as nothing.
    const ingestibility = annasFormatIngestibility(format);
    score += ingestibility.score;
    rationale.push(ingestibility.rationale);
  } else if ((preference === 'text_rag' || preference === 'auto') && format === 'epub') {
    score += 6;
    rationale.push('EPUB preferred for text-first reading/RAG');
  } else if (preference === 'layout' && format === 'pdf') {
    score += 6;
    rationale.push('PDF preferred for layout-heavy/design material');
  } else if (format) {
    score += 1;
    rationale.push(`format metadata present (${format})`);
  }
  if (candidate.year) {
    score += 1;
    rationale.push('publication year present');
  }
  if (candidate.file_size_bytes) {
    // Presence earns the same flat point it always did. The size itself is
    // surfaced, not scored: a clean 4 MB text-layer PDF of a 500-page book beats
    // a 44 MB scan of the same book for retrieval, so a bigger-is-better bonus
    // would systematically prefer scans and degrade the corpus.
    score += 1;
    rationale.push(`file size ${humanByteSize(candidate.file_size_bytes)}`);
  }
  if (candidate.md5 || candidate.annas_archive_id) {
    score += 2;
    rationale.push('stable locator present');
  }
  return { ...candidate, score, rationale: rationale.length ? rationale : ['candidate metadata returned by Anna Archive'] };
}

function annasFormatIngestibility(format: string): { score: number; rationale: string } {
  if (ANNAS_NATIVE_INGEST_FORMATS.has(format)) return { score: 6, rationale: `ingestible: ${format.toUpperCase()} imports into Vertex RAG as uploaded` };
  if (format === 'epub') return { score: 6, rationale: 'ingestible: EPUB is converted to Markdown before import' };
  if (format === 'djvu') return { score: 2, rationale: 'ingestible only when djvutxt is installed on the worker host' };
  return { score: 0, rationale: `not ingestible: ${format.toUpperCase()} is neither parsed by Vertex RAG nor converted by the worker` };
}

function tokenizeAnnasQuery(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 4))].slice(0, 12);
}

function firstCandidateString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (Array.isArray(value)) {
      const pieces = value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean);
      if (pieces.length) return pieces.join(', ');
    }
  }
  return undefined;
}

function firstCandidateNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value.replace(/[^0-9.]/g, ''));
      if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
    }
  }
  return undefined;
}

function stringField<K extends string>(key: K, value: string | undefined): Record<K, string> | Record<string, never> {
  return value ? { [key]: value } as Record<K, string> : {};
}

function numberField<K extends string>(key: K, value: number | undefined): Record<K, number> | Record<string, never> {
  return value !== undefined ? { [key]: value } as Record<K, number> : {};
}

function normalizeAnnasFormat(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/^\./, '').toLowerCase();
  return ANNAS_ARCHIVE_FORMATS.includes(normalized as any) ? normalized : value;
}

async function annasDownloadPlan(root: string, params: AnnasArchiveImportParams): Promise<{ root: string; relativePath: string; targetPath: string }> {
  const rootPath = resolve(root);
  const info = await stat(rootPath).catch(() => undefined);
  if (!info?.isDirectory()) throw new DomainExpertWorkerError(503, 'annas_books_root_not_configured', 'Anna Archive books root is not available on this host.');
  const topic = safeAnnasPathSegment(params.topic ?? 'General');
  const author = params.author?.trim() || 'Unknown Author';
  const title = params.title?.trim() || params.annasArchiveId || params.md5 || basename(params.url ?? 'Anna Archive Item');
  const year = params.year?.trim();
  const folder = safeAnnasPathSegment(`${author} - ${title}${year ? ` (${year})` : ''}`);
  const extension = params.format && params.format !== 'unknown' ? params.format : extensionFormat(params.url ?? 'download.pdf');
  const originalStem = params.fileName ? basename(params.fileName, extname(params.fileName)) : `${author} - ${title}${year ? ` (${year})` : ''}`;
  const locator = params.md5 ?? params.annasArchiveId;
  const suffix = locator ? `-${safeAnnasPathSegment(locator).slice(0, 16)}` : '';
  const filename = `${safeAnnasPathSegment(originalStem)}${suffix}.${extension}`;
  const relativePath = [topic, folder, filename].join('/');
  const targetPath = await resolveWritePathInside(
    rootPath,
    relativePath,
    'Anna Archive download path escaped the configured books root.',
  );
  return { root: rootPath, relativePath, targetPath };
}

async function existingAnnasAcquisition(root: string, params: AnnasArchiveImportParams, targetPath: string): Promise<{ reason: string; targetPath: string } | undefined> {
  if (await exists(targetPath)) return { reason: 'target_path_exists', targetPath };
  const stable = [
    params.md5,
    params.annasArchiveId,
    params.url ? canonicalAnnasAuditUrl(params.url) : undefined,
  ].filter(Boolean).map(String);
  if (stable.length === 0) return undefined;
  const raw = await readFile(join(resolve(root), ANNAS_AUDIT_FILE), 'utf8').catch(() => '');
  for (const line of raw.split('\n').filter(Boolean).reverse()) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const selected = record.selected && typeof record.selected === 'object' ? record.selected as Record<string, unknown> : {};
    const download = record.download && typeof record.download === 'object' ? record.download as Record<string, unknown> : {};
    const selectedValues = Object.entries(selected).map(([key, candidate]) => (
      key === 'url' && typeof candidate === 'string' ? canonicalAnnasAuditUrl(candidate) : candidate
    ));
    const matches = stable.some((value) => selectedValues.some((candidate) => candidate === value));
    const path = typeof download.path === 'string' ? download.path : typeof record.target_path === 'string' ? record.target_path : undefined;
    if (matches && path && await exists(path)) return { reason: 'stable_locator_seen_in_audit', targetPath: path };
  }
  return undefined;
}

// Re-ingest holds the whole file in memory the way a fresh download does, so it answers to
// the same configured size limit rather than trusting whatever is sitting in the books root.
async function readExistingAnnasBookFile(targetPath: string, maxDownloadBytes: number): Promise<Uint8Array> {
  const info = await stat(targetPath);
  if (info.size > maxDownloadBytes) {
    throw new DomainExpertWorkerError(
      413,
      'annas_archive_download_size_limit_exceeded',
      `The already-acquired Anna Archive file exceeds the ${maxDownloadBytes} byte download limit.`,
    );
  }
  return new Uint8Array(await readFile(targetPath));
}

async function writeAnnasBookFile(rootPath: string, relativePath: string, bytes: Uint8Array): Promise<void> {
  const targetPath = await resolveWritePathInside(
    rootPath,
    relativePath,
    'Anna Archive download path escaped the configured books root.',
  );
  await mkdir(dirname(targetPath), { recursive: true });
  try {
    await writeFile(targetPath, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'EEXIST') {
      throw new DomainExpertWorkerError(409, 'annas_archive_duplicate_path', 'Anna Archive target file already exists; refusing to overwrite.');
    }
    throw error;
  }
}

async function appendAnnasAudit(root: string, record: Record<string, unknown>): Promise<void> {
  const rootPath = resolve(root);
  await mkdir(rootPath, { recursive: true });
  const auditFile = await open(join(rootPath, ANNAS_AUDIT_FILE), 'a', 0o600);
  try {
    await auditFile.chmod(0o600);
    await auditFile.appendFile(`${JSON.stringify(record)}\n`, 'utf8');
  } finally {
    await auditFile.close();
  }
}

function safeAnnasPathSegment(value: string): string {
  return safeObjectName(value).replace(/-+/g, '-').replace(/^-+|-+$/g, '') || randomUUID();
}

function annasSelectionAudit(params: AnnasArchiveImportParams): Record<string, unknown> {
  const url = params.url ? canonicalAnnasAuditUrl(params.url) : undefined;
  return {
    ...(params.annasArchiveId ? { annas_archive_id: params.annasArchiveId } : {}),
    ...(url ? { url } : {}),
    ...(params.md5 ? { md5: params.md5 } : {}),
    ...(params.title ? { title: params.title } : {}),
    ...(params.author ? { author: params.author } : {}),
    ...(params.year ? { year: params.year } : {}),
    ...(params.topic ? { topic: params.topic } : {}),
    ...(params.format ? { format: params.format } : {}),
    copyright_posture: params.copyrightPosture,
  };
}

function canonicalAnnasAuditUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

// Measured scale of an acquired artifact. Content-free by construction: page and
// byte counts, a signal name and a short reason string, never a line of the
// document itself.
interface AnnasArtifactScale {
  measured: boolean;
  format: string;
  bytes: number;
  pages?: number;
  page_signal?: 'page_tree_count' | 'page_objects';
  // Byte-based proxy, deliberately not named for extracted text: no text
  // extractor runs here, so this is total artifact bytes divided by pages.
  content_bytes_per_page?: number;
  text_documents?: number;
  text_bytes?: number;
  reason?: string;
  min_pdf_pages?: number;
  below_min_pdf_pages?: boolean;
  short_artifact_override?: boolean;
}

type AnnasImportOutcomeStatus = 'imported' | 'import_failed' | 'import_empty' | 'import_requested';

// The acquisition's top-level status must not read as success when the
// ingest did not verify: a caller that only looks at the outer status saw
// 'downloaded' on 2026-09-20 for sixteen books that never entered the corpus.
function annasAcquisitionStatus(base: 'downloaded' | 'ingested_existing', ingestStatus: string): string {
  const prefix = base === 'downloaded' ? 'downloaded' : 'skipped_duplicate';
  if (ingestStatus === 'blocked' || ingestStatus === 'needs_corpus_decision') return `${prefix}_ingest_blocked`;
  if (ingestStatus === 'import_failed' || ingestStatus === 'import_empty') return `${prefix}_ingest_failed`;
  if (base === 'ingested_existing' && ingestStatus === 'import_requested') return 'skipped_duplicate_ingest_requested';
  return base;
}

// Vertex signals "not now" two ways: FAILED_PRECONDITION with "other
// operations running" on a corpus that is mid-import, and 429 / RESOURCE_EXHAUSTED
// from the embedding backend. Both are transient; everything else is not.
function annasImportTransientReason(error: unknown): { code: string; message: string } | undefined {
  if (!(error instanceof DomainExpertWorkerError) || error.code !== 'google_api_error') return undefined;
  const body = asOptionalRecord(asOptionalRecord(error.googleErrorBody)?.error);
  const status = typeof body?.status === 'string' ? body.status : '';
  const text = `${status} ${error.message}`;
  if (error.status === 429 || status === 'RESOURCE_EXHAUSTED') {
    return { code: 'rag_import_quota_exhausted', message: `Vertex refused the import with HTTP ${error.status} (quota): ${error.message}` };
  }
  if (/FAILED_PRECONDITION/.test(text) && /other operations?\s+(?:are\s+)?running|operations? (?:is|are) running/i.test(text)) {
    return { code: 'rag_corpus_busy', message: `The corpus is running another operation: ${error.message}` };
  }
  return undefined;
}

// Vertex's ImportRagFilesResponse counts arrive as int64 strings.
function ragImportCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function classifyRagImportOperation(
  operation: unknown,
  operationName: string,
  uploadedFormat: string,
): { status: AnnasImportOutcomeStatus; detail: Record<string, unknown> } | undefined {
  const record = asOptionalRecord(operation);
  if (!record || record.done !== true) return undefined;
  const failure = asOptionalRecord(record.error);
  if (failure) {
    const message = typeof failure.message === 'string' ? failure.message : JSON.stringify(failure);
    return {
      status: 'import_failed',
      detail: {
        operation_name: operationName,
        vertex_error: {
          ...(failure.code !== undefined ? { code: failure.code } : {}),
          message: sanitizeUpstreamText(message, [], UPSTREAM_ERROR_TEXT_MAX_CHARACTERS),
        },
      },
    };
  }
  const response = asOptionalRecord(record.response) ?? {};
  const counts = {
    imported_rag_files_count: ragImportCount(response.importedRagFilesCount),
    failed_rag_files_count: ragImportCount(response.failedRagFilesCount),
    skipped_rag_files_count: ragImportCount(response.skippedRagFilesCount),
  };
  if (counts.imported_rag_files_count >= 1) return { status: 'imported', detail: { operation_name: operationName, ...counts } };
  if (counts.failed_rag_files_count >= 1) {
    return {
      status: 'import_failed',
      detail: {
        operation_name: operationName,
        ...counts,
        hint: 'Vertex reported the file as failed. Per-file reasons are written to the import result sink when one is configured; a PDF above the parser page or size limits is the usual cause.',
      },
    };
  }
  return {
    status: 'import_empty',
    detail: {
      operation_name: operationName,
      ...counts,
      hint: counts.skipped_rag_files_count >= 1
        ? 'Vertex skipped the file as already present under the same source URI; delete the existing record before re-importing if it must be replaced.'
        : `Vertex finished without importing, failing or skipping anything, which is what it does for a format it does not parse (uploaded as ${uploadedFormat}). Vertex RAG parses PDF, text, Markdown and HTML only.`,
    },
  };
}

// djvulibre's djvutxt prints the text layer of every page to stdout. It runs
// with a bare environment so no worker credential reaches a host binary.
function runDjvuTextExtraction(binary: string, sourcePath: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(binary, [sourcePath], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      timeout: ANNAS_DJVUTXT_TIMEOUT_MS,
      maxBuffer: ANNAS_DJVUTXT_MAX_OUTPUT_BYTES,
    }, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(new Error(`${sanitizeUpstreamText(String(stderr || error.message), [], UPSTREAM_ERROR_TEXT_MAX_CHARACTERS).trim() || 'djvutxt failed'}`));
        return;
      }
      resolvePromise(String(stdout));
    });
  });
}

type AnnasArtifactMeasurement = Omit<AnnasArtifactScale, 'format' | 'bytes' | 'min_pdf_pages' | 'below_min_pdf_pages' | 'short_artifact_override'>;

// Source metadata is advertising, not evidence. On 2026-07-29 an acquisition
// arrived carrying a 512-page monograph's title, author, year and advertised
// byte size and contained a 36-page pamphlet; bytes and sha256 were both
// perfectly consistent with the lie because nothing measured what was inside the
// file. This measures the artifact itself, then annotates it with the floor in
// effect so the audit record and the ingest gate read the same facts.
function annasArtifactScale(
  format: string,
  bytes: Uint8Array,
  policy: { minPdfPages: number; allowShortArtifact: boolean },
): AnnasArtifactScale {
  const scale: AnnasArtifactScale = {
    ...measureAnnasArtifact(format, bytes),
    format,
    bytes: bytes.byteLength,
  };
  if (policy.allowShortArtifact) scale.short_artifact_override = true;
  if (format === 'pdf' && policy.minPdfPages > 0) {
    scale.min_pdf_pages = policy.minPdfPages;
    if (scale.pages !== undefined && scale.pages < policy.minPdfPages) scale.below_min_pdf_pages = true;
  }
  return scale;
}

// Fail open, and say so. The gate exists to catch a measurably short monograph,
// so an unparseable, truncated or unsupported artifact is recorded as unmeasured
// and ingests normally — turning every parser gap into a refused ingest would be
// a far larger policy change than the incident warrants.
function measureAnnasArtifact(format: string, bytes: Uint8Array): AnnasArtifactMeasurement {
  try {
    if (format === 'pdf') return measurePdfArtifactScale(bytes);
    if (format === 'epub') return measureEpubArtifactScale(bytes);
    return { measured: false, reason: 'format_not_measurable' };
  } catch {
    return { measured: false, reason: 'measurement_failed' };
  }
}

// No subprocess and no PDF library: shelling out to a C parser on an
// attacker-supplied file from inside a credentialed worker would add a remote
// code-execution surface, and a host binary is not portable to CI. This scans
// the bytes for the two page signals every writer leaves behind.
function measurePdfArtifactScale(bytes: Uint8Array): AnnasArtifactMeasurement {
  const buffer = asByteBuffer(bytes);
  const header = buffer.indexOf('%PDF-', 0, 'latin1');
  if (header < 0 || header > ANNAS_PDF_HEADER_WINDOW_BYTES) return { measured: false, reason: 'pdf_header_not_found' };
  const plain = pdfPageSignals(buffer);
  // Modern writers pack the page tree into compressed object streams, so the
  // plain scan alone reports nothing for a perfectly ordinary book.
  const compressed = pdfObjectStreamPageSignals(buffer);
  const pageTreeCount = Math.max(plain.pageTreeCount, compressed.pageTreeCount);
  const pageObjects = plain.pageObjects + compressed.pageObjects;
  const pages = Math.max(pageTreeCount, pageObjects);
  if (pages <= 0) return { measured: false, reason: 'pdf_page_signal_not_found' };
  return {
    measured: true,
    pages,
    page_signal: pageTreeCount >= pageObjects ? 'page_tree_count' : 'page_objects',
    content_bytes_per_page: Math.round(bytes.byteLength / pages),
  };
}

function pdfPageSignals(buffer: Buffer): { pageObjects: number; pageTreeCount: number } {
  return { pageObjects: countPdfPageObjects(buffer), pageTreeCount: pdfPageTreeCount(buffer) };
}

// Tolerates arbitrary whitespace between /Type and /Page, and refuses to let a
// page-tree node (/Type /Pages) inflate the tally.
function countPdfPageObjects(buffer: Buffer): number {
  let count = 0;
  let cursor = 0;
  while (count < ANNAS_PDF_MAX_PAGE_HITS) {
    const hit = buffer.indexOf('/Type', cursor, 'latin1');
    if (hit < 0) break;
    cursor = hit + '/Type'.length;
    const at = skipPdfWhitespace(buffer, cursor);
    if (!matchesAscii(buffer, at, '/Page')) continue;
    const after = at + '/Page'.length;
    const next = after < buffer.length ? buffer[after]! : 0x20;
    if (next === 0x73) continue;
    if (!isPdfWhitespace(next) && !isPdfDelimiter(next)) continue;
    count += 1;
  }
  return count;
}

// /Count is also an outline-dictionary key, so a value only counts when a
// page-tree marker sits in the same neighbourhood. The bias is deliberately
// toward the larger plausible reading: an over-count fails open and blocks
// nothing, while an under-count would refuse a real book.
function pdfPageTreeCount(buffer: Buffer): number {
  let best = 0;
  let cursor = 0;
  for (let probe = 0; probe < ANNAS_PDF_MAX_COUNT_PROBES; probe += 1) {
    const hit = buffer.indexOf('/Count', cursor, 'latin1');
    if (hit < 0) break;
    cursor = hit + '/Count'.length;
    const value = readPdfInteger(buffer, skipPdfWhitespace(buffer, cursor));
    if (value === undefined || value <= best) continue;
    if (!hasPdfPageTreeMarkerNear(buffer, hit)) continue;
    best = value;
  }
  return best;
}

function hasPdfPageTreeMarkerNear(buffer: Buffer, at: number): boolean {
  const start = Math.max(0, at - ANNAS_PDF_PAGE_TREE_WINDOW_BYTES);
  const end = Math.min(buffer.length, at + ANNAS_PDF_PAGE_TREE_WINDOW_BYTES);
  const found = buffer.indexOf('/Pages', start, 'latin1');
  return found >= 0 && found < end;
}

// Only object streams can carry page objects, so content streams and image data
// are never inflated. Every bound is enforced here: compressed input per stream,
// inflated output per stream, total inflated output, and stream count.
function pdfObjectStreamPageSignals(buffer: Buffer): { pageObjects: number; pageTreeCount: number } {
  let pageObjects = 0;
  let pageTreeCount = 0;
  let budget = ANNAS_PDF_MAX_TOTAL_INFLATED_BYTES;
  let cursor = 0;
  for (let stream = 0; stream < ANNAS_PDF_MAX_INFLATE_STREAMS && budget > 0; stream += 1) {
    const marker = buffer.indexOf('/ObjStm', cursor, 'latin1');
    if (marker < 0) break;
    cursor = marker + '/ObjStm'.length;
    const start = pdfStreamDataStart(buffer, cursor);
    if (start === undefined) continue;
    const decoded = inflatePdfStream(
      buffer.subarray(start, Math.min(buffer.length, start + ANNAS_PDF_MAX_STREAM_INPUT_BYTES)),
      Math.min(budget, ANNAS_PDF_MAX_STREAM_OUTPUT_BYTES),
    );
    if (!decoded) continue;
    budget -= decoded.length;
    pageObjects += countPdfPageObjects(decoded);
    pageTreeCount = Math.max(pageTreeCount, pdfPageTreeCount(decoded));
  }
  return { pageObjects, pageTreeCount };
}

function pdfStreamDataStart(buffer: Buffer, from: number): number | undefined {
  const keyword = buffer.indexOf('stream', from, 'latin1');
  if (keyword < 0 || keyword > from + ANNAS_PDF_STREAM_HEADER_WINDOW_BYTES) return undefined;
  let at = keyword + 'stream'.length;
  if (buffer[at] === 0x0d) at += 1;
  if (buffer[at] === 0x0a) at += 1;
  return at < buffer.length ? at : undefined;
}

// Z_SYNC_FLUSH so a truncated stream yields what it has instead of throwing, and
// maxOutputLength so a compression bomb costs a bounded allocation. A stream that
// fails either way costs only itself.
function inflatePdfStream(input: Buffer, maxOutputLength: number): Buffer | undefined {
  if (maxOutputLength <= 0 || input.length === 0) return undefined;
  try {
    return inflateSync(input, { finishFlush: zlibConstants.Z_SYNC_FLUSH, maxOutputLength });
  } catch {
    return undefined;
  }
}

// EPUB text scale from the ZIP central directory alone: it records uncompressed
// sizes, so nothing has to be inflated. Informational only — there is no EPUB
// floor, and an archive this cannot read is simply unmeasured.
function measureEpubArtifactScale(bytes: Uint8Array): AnnasArtifactMeasurement {
  const buffer = asByteBuffer(bytes);
  const directory = zipCentralDirectory(buffer);
  if (!directory) return { measured: false, reason: 'epub_central_directory_not_found' };
  let documents = 0;
  let textBytes = 0;
  let cursor = directory.offset;
  for (let entry = 0; entry < Math.min(directory.entries, ANNAS_ZIP_MAX_ENTRIES); entry += 1) {
    if (cursor + ANNAS_ZIP_CENTRAL_HEADER_BYTES > buffer.length) break;
    if (buffer.readUInt32LE(cursor) !== ANNAS_ZIP_CENTRAL_SIGNATURE) break;
    const uncompressed = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const nameStart = cursor + ANNAS_ZIP_CENTRAL_HEADER_BYTES;
    const nameEnd = Math.min(buffer.length, nameStart + nameLength);
    const name = buffer.toString('latin1', nameStart, nameEnd).toLowerCase();
    if (ANNAS_EPUB_TEXT_DOCUMENT.test(name) && !name.endsWith('container.xml')) {
      documents += 1;
      textBytes += uncompressed;
    }
    cursor = nameEnd + extraLength + commentLength;
  }
  if (documents === 0) return { measured: false, reason: 'epub_text_documents_not_found' };
  return { measured: true, text_documents: documents, text_bytes: textBytes };
}

// Zip64 archives park sentinels in these fields; that reads as an unusable
// directory here, which is the fail-open answer.
function zipCentralDirectory(buffer: Buffer): { offset: number; entries: number } | undefined {
  const floor = Math.max(0, buffer.length - ANNAS_ZIP_EOCD_SEARCH_BYTES);
  for (let at = buffer.length - ANNAS_ZIP_EOCD_MIN_BYTES; at >= floor; at -= 1) {
    if (buffer.readUInt32LE(at) !== ANNAS_ZIP_EOCD_SIGNATURE) continue;
    const entries = buffer.readUInt16LE(at + 10);
    const offset = buffer.readUInt32LE(at + 16);
    return entries > 0 && offset > 0 && offset < buffer.length ? { offset, entries } : undefined;
  }
  return undefined;
}

function asByteBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function skipPdfWhitespace(buffer: Buffer, from: number): number {
  let at = from;
  while (at < buffer.length && isPdfWhitespace(buffer[at]!)) at += 1;
  return at;
}

function isPdfWhitespace(byte: number): boolean {
  return byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

function isPdfDelimiter(byte: number): boolean {
  return byte === 0x28 || byte === 0x29 || byte === 0x3c || byte === 0x3e || byte === 0x5b
    || byte === 0x5d || byte === 0x7b || byte === 0x7d || byte === 0x2f || byte === 0x25;
}

function matchesAscii(buffer: Buffer, at: number, text: string): boolean {
  if (at + text.length > buffer.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (buffer[at + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function readPdfInteger(buffer: Buffer, from: number): number | undefined {
  let at = from;
  let digits = 0;
  let value = 0;
  while (at < buffer.length && digits < 9) {
    const byte = buffer[at]!;
    if (byte < 0x30 || byte > 0x39) break;
    value = value * 10 + (byte - 0x30);
    digits += 1;
    at += 1;
  }
  return digits > 0 ? value : undefined;
}

function parseGcsPrefix(prefix: string): { bucket: string; prefix: string } {
  if (!prefix.startsWith('gs://')) throw new DomainExpertWorkerError(400, 'invalid_gcs_prefix', 'GCS prefix must start with gs://.');
  const withoutScheme = prefix.slice('gs://'.length);
  const slash = withoutScheme.indexOf('/');
  const bucket = slash === -1 ? withoutScheme : withoutScheme.slice(0, slash);
  const objectPrefix = slash === -1 ? '' : `${withoutScheme.slice(slash + 1).replace(/\/?$/, '/')}`;
  if (!bucket) throw new DomainExpertWorkerError(400, 'invalid_gcs_prefix', 'GCS prefix must include a bucket.');
  return { bucket, prefix: objectPrefix };
}

function assertReviewedLiveRagImport(manifest: ReturnType<typeof domainManifest>, params: RagCorpusParams, dryRun: boolean): void {
  if (params.action !== 'import') return;
  if (params.gcsUri) {
    assertAllowedGcsDestination(params.gcsUri, manifest.allowed_gcs_prefixes);
  }
  if (!dryRun && params.driveFileId) {
    throw new DomainExpertWorkerError(
      403,
      'drive_import_review_required',
      'Live Google Drive RAG imports require a reviewed source-registry import path before Vertex ingestion.',
    );
  }
}

function stageDestination(allowedPrefixes: string[], domainId: string, batchId: string): { bucket: string; objectPrefix: string; directoryUri: string } {
  const primaryPrefix = allowedPrefixes[0];
  if (!primaryPrefix) {
    throw new DomainExpertWorkerError(403, 'gcs_destination_not_allowed', 'Domain manifest has no allowed_gcs_prefixes entry for stage_import.');
  }
  const parsed = parseGcsPrefix(primaryPrefix);
  const objectPrefix = `${parsed.prefix}staged/${safeObjectName(domainId)}/${batchId}/`;
  const directoryUri = `gs://${parsed.bucket}/${objectPrefix}`;
  assertAllowedGcsDestination(directoryUri, allowedPrefixes);
  return { bucket: parsed.bucket, objectPrefix, directoryUri };
}

// Where a live import asks Vertex to write its per-file results
// (importResultGcsSink). Sinks live beside the staged batches under the
// primary library prefix; the trailing random segment keeps every request's
// receipts in their own directory, because Vertex's result-file naming under
// a shared prefix is undocumented.
function importResultSinkUri(allowedPrefixes: string[], domainId: string, batchId?: string): string {
  const primaryPrefix = allowedPrefixes[0];
  if (!primaryPrefix) {
    throw new DomainExpertWorkerError(403, 'gcs_destination_not_allowed', 'Domain manifest has no allowed_gcs_prefixes entry for import results.');
  }
  const parsed = parseGcsPrefix(primaryPrefix);
  const objectPrefix = `${parsed.prefix}import-results/${safeObjectName(domainId)}/${batchId ? `${batchId}/` : ''}${randomUUID()}/`;
  const directoryUri = `gs://${parsed.bucket}/${objectPrefix}`;
  assertAllowedGcsDestination(directoryUri, allowedPrefixes);
  return directoryUri;
}

function ragFileMatchesTargets(file: Record<string, unknown>, targetUris: string[]): boolean {
  const sourceUri = typeof file.sourceUri === 'string' ? file.sourceUri : undefined;
  if (sourceUri) {
    // A directory target (trailing slash) covers every record staged under it.
    return targetUris.some((target) => (target.endsWith('/') ? sourceUri.startsWith(target) : sourceUri === target));
  }
  // A record that surfaces no URI can still be matched by display name, which
  // Vertex derives from the imported object's file name.
  const displayName = typeof file.displayName === 'string' ? file.displayName : undefined;
  if (!displayName) return false;
  return targetUris.some((target) => !target.endsWith('/') && target.split('/').pop() === displayName);
}

export function assertAllowedGcsDestination(destinationUri: string, allowedPrefixes: string[]): void {
  if (!destinationUri.startsWith('gs://')) {
    throw new DomainExpertWorkerError(400, 'invalid_gcs_prefix', 'GCS destination must start with gs://.');
  }
  const allowed = allowedPrefixes.some((prefix) => {
    const normalizedPrefix = prefix.replace(/\/+$/g, '');
    return destinationUri === normalizedPrefix || destinationUri.startsWith(`${normalizedPrefix}/`);
  });
  if (!allowed) {
    throw new DomainExpertWorkerError(
      403,
      'gcs_destination_not_allowed',
      `GCS destination must be inside one of the domain allowlisted prefixes: ${allowedPrefixes.join(', ')}.`,
    );
  }
}

function extensionFormat(value: string): string {
  const ext = extname(new URL(value, 'https://example.test').pathname).replace('.', '').toLowerCase();
  return ANNAS_ARCHIVE_FORMATS.includes(ext as any) && ext !== 'unknown' ? ext : 'pdf';
}

const LIBRARY_MANIFEST_CACHE_TTL_MS = 10 * 60 * 1000;
// Passage completion source reads: the largest library text object is under
// 10 MB (the default parser's limit), a read gets a few seconds at most, and
// the cache holds a working set of books, not the library.
const PASSAGE_SOURCE_MAX_BYTES = 12_000_000;
const PASSAGE_SOURCE_READ_TIMEOUT_MS = 4_000;
const PASSAGE_SOURCE_CACHE_MAX_CHARS = 32_000_000;
const PASSAGE_SOURCE_MISS_TTL_MS = 10 * 60 * 1000;
const LIBRARY_MANIFEST_UNREADABLE_TTL_MS = 60 * 1000;

interface CitationSourceMetadata {
  title?: string;
  creator?: string;
}

interface LibraryManifestIndex {
  loadedAt: number;
  ttlMs: number;
  objects: Map<string, CitationSourceMetadata>;
  unreadable: boolean;
}

const CANONICAL_LIBRARY_OBJECT_PATH = /^(?:(.+)\/)?objects\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})(?:\.[A-Za-z0-9]+)?$/;

// gs://<bucket>/<prefix>/objects/sha256/<2hex>/<64hex>[.ext] -> the library
// root that owns it and the content id the master manifest is keyed by. The
// prefix is whatever precedes /objects/, so no routing lookup is needed.
function parseCanonicalLibraryObjectUri(uri: string): { bucket: string; prefix: string; objectId: string } | undefined {
  if (!uri.startsWith('gs://')) return undefined;
  const withoutScheme = uri.slice('gs://'.length);
  const slash = withoutScheme.indexOf('/');
  if (slash <= 0) return undefined;
  const bucket = withoutScheme.slice(0, slash);
  const match = CANONICAL_LIBRARY_OBJECT_PATH.exec(withoutScheme.slice(slash + 1));
  if (!match || match[2] !== match[3]!.slice(0, 2)) return undefined;
  return { bucket, prefix: match[1] ?? '', objectId: `sha256:${match[3]}` };
}

function libraryManifestObjectName(prefix: string): string {
  return prefix ? `${prefix}/manifest/master.json` : 'manifest/master.json';
}

function libraryManifestUri(bucket: string, prefix: string): string {
  return `gs://${bucket}/${libraryManifestObjectName(prefix)}`;
}

// Read for display only, so plain JSON is enough: a manifest whose hash no
// longer verifies still names its objects, and a title lookup must not be
// stricter than the answer it decorates.
function libraryManifestTitleIndex(text: string): Map<string, CitationSourceMetadata> {
  const parsed = JSON.parse(text) as unknown;
  const objects = asOptionalRecord(parsed)?.objects;
  if (!Array.isArray(objects)) throw new Error('master manifest has no objects list');
  const index = new Map<string, CitationSourceMetadata>();
  for (const entry of objects) {
    const object = asOptionalRecord(entry);
    const id = typeof object?.id === 'string' ? object.id : undefined;
    if (!object || !id) continue;
    const title = typeof object.title === 'string' && object.title.trim() ? object.title.trim() : undefined;
    const creator = typeof object.creator === 'string' && object.creator.trim() ? object.creator.trim() : undefined;
    if (title || creator) index.set(id, { ...(title ? { title } : {}), ...(creator ? { creator } : {}) });
  }
  return index;
}

// The inverse of the name uploadApprovedImportToGcs builds from
// `<author> - <title> (<year>)` through safeObjectName: " - " survives as
// "---", the year as a trailing "-NNNN", and case is gone, so words are
// re-capitalized. A name with no "---" is a title alone. Staged web, Notion
// and book imports outside book-imports/ are slugged the same way, so every
// non-canonical object is read like this; a trailing content-hash or date
// suffix the importer appended is not part of the title.
function parseObjectNameUri(uri: string): CitationSourceMetadata | undefined {
  if (!uri.startsWith('gs://')) return undefined;
  let stem = uri.slice(uri.lastIndexOf('/') + 1);
  const extension = extname(stem);
  if (extension) stem = stem.slice(0, -extension.length);
  stem = stem
    .replace(/-+$/, '')
    .replace(/-{1,2}(?=[0-9a-f]*\d)[0-9a-f]{8,}$/, '')
    .replace(/-(1[5-9]|20)\d{2}-\d{2}-\d{2}$/, '')
    .replace(/-+$/, '');
  if (!stem) return undefined;
  // "---" names an author only in the book naming convention: under
  // book-imports/, or ahead of a trailing year. A page title that merely
  // contained " - " stays one title.
  const dashes = stem.indexOf('---');
  const year = /-(1[5-9]|20)\d{2}$/;
  const separator = dashes !== -1 && (uri.includes('/book-imports/') || year.test(stem)) ? dashes : -1;
  const creatorSlug = separator === -1 ? undefined : stem.slice(0, separator);
  let titleSlug = separator === -1 ? stem : stem.slice(separator + 3);
  titleSlug = titleSlug.replace(year, '');
  const title = humanizeObjectNameSlug(titleSlug) || humanizeObjectNameSlug(stem);
  const creator = creatorSlug ? humanizeObjectNameSlug(creatorSlug) : undefined;
  if (!title) return undefined;
  return { title, ...(creator ? { creator } : {}) };
}

function humanizeObjectNameSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((token) => `${token.charAt(0).toUpperCase()}${token.slice(1)}`)
    .join(' ');
}

function citationSourceFields(context: Record<string, unknown>): { title?: string; creator?: string } {
  return {
    ...(typeof context.sourceTitle === 'string' ? { title: context.sourceTitle } : {}),
    ...(typeof context.sourceCreator === 'string' ? { creator: context.sourceCreator } : {}),
  };
}

// `[<citation_id>] <creator> — <title>` when the source is titled, else the
// display name or URI as before. Shared by the passages output and the
// synthesis prompt so the model and the caller see the same label.
function citationHeader(context: Record<string, unknown>): string {
  const { title, creator } = citationSourceFields(context);
  const display = title
    ? (creator ? `${creator} — ${title}` : title)
    : String(context.sourceDisplayName ?? context.sourceUri ?? 'source');
  return `[${String(context.citation_id)}] ${display}`;
}

function annasSourceKind(format: string): 'pdf' | 'epub' | 'book' {
  if (format === 'pdf') return 'pdf';
  if (format === 'epub') return 'epub';
  return 'book';
}

function safeObjectName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || randomUUID();
}

function notionImportSources(params: RagCorpusParams): NotionImportSource[] {
  return [
    ...(params.urls ?? []).map((url) => ({ id: notionObjectIdFromUrlOrId(url), url: sanitizeNotionSourceUrl(url) })),
    ...(params.pageIds ?? []).map((pageId) => ({ id: normalizeNotionObjectId(pageId), type: 'page' as const })),
    ...(params.databaseIds ?? []).map((databaseId) => ({ id: normalizeNotionObjectId(databaseId), type: 'database' as const })),
  ];
}

function notionObjectIdFromUrlOrId(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/([0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[?#/]|$)/);
  if (match?.[1]) return normalizeNotionObjectId(match[1]);
  return normalizeNotionObjectId(trimmed);
}

function normalizeNotionObjectId(value: string): string {
  const compact = value.trim().replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    throw new DomainExpertWorkerError(400, 'invalid_notion_object_id', 'Notion object ids must be 32 hexadecimal characters, with or without dashes.');
  }
  return compact;
}

function sanitizeNotionSourceUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!/(\.|^)notion\.(so|site)$/i.test(url.hostname)) return value;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

function isNotionImportUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /(\.|^)notion\.(so|site)$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function notionTitleFromObject(record: Record<string, unknown>): string | undefined {
  const directTitle = richTextPlainText(record.title);
  if (directTitle) return directTitle;
  const properties = asOptionalRecord(record.properties);
  if (!properties) return undefined;
  for (const value of Object.values(properties)) {
    const property = asOptionalRecord(value);
    if (!property) continue;
    if (property.type === 'title') {
      const title = richTextPlainText(property.title);
      if (title) return title;
    }
  }
  return undefined;
}

function notionParentIds(record: Record<string, unknown>): { parentPageId?: string; parentDatabaseId?: string } {
  const parent = asOptionalRecord(record.parent);
  if (!parent) return {};
  const pageId = typeof parent.page_id === 'string' ? normalizeNotionObjectId(parent.page_id) : undefined;
  const databaseId = typeof parent.database_id === 'string' ? normalizeNotionObjectId(parent.database_id) : undefined;
  return {
    ...(pageId ? { parentPageId: pageId } : {}),
    ...(databaseId ? { parentDatabaseId: databaseId } : {}),
  };
}

function notionMarkdownDocument(input: {
  sourceUrl?: string;
  objectId: string;
  objectType: 'page';
  retrievedAt: string;
  title: string;
  parentPageId?: string;
  parentDatabaseId?: string;
  warnings: string[];
  body: string;
}): string {
  const frontmatter: Record<string, unknown> = {
    kind: 'notion',
    title: input.title,
    notion_object_id: input.objectId,
    notion_object_type: input.objectType,
    retrieved_at: input.retrievedAt,
    ...(input.sourceUrl ? { source_url: input.sourceUrl } : {}),
    ...(input.parentPageId ? { parent_page_id: input.parentPageId } : {}),
    ...(input.parentDatabaseId ? { parent_database_id: input.parentDatabaseId } : {}),
    ...(input.warnings.length ? { warnings: [...new Set(input.warnings)] } : {}),
  };
  return `---\n${Object.entries(frontmatter).map(([key, value]) => `${key}: ${yamlValue(value)}`).join('\n')}\n---\n\n# ${input.title}\n\n${input.body || '_No readable Notion blocks returned._'}\n`;
}

function renderNotionBlock(block: Record<string, unknown>, childMarkdown: string[], warnings: string[]): string {
  const type = typeof block.type === 'string' ? block.type : 'unknown';
  const payload = asOptionalRecord(block[type]) ?? {};
  const text = richTextPlainText(payload.rich_text) ?? '';
  const children = childMarkdown.length ? `\n${indentMarkdown(childMarkdown.join('\n'), type === 'quote' ? '> ' : '  ')}` : '';
  switch (type) {
    case 'paragraph':
      return `${text}${children}`.trim();
    case 'heading_1':
      return `# ${text}`.trim();
    case 'heading_2':
      return `## ${text}`.trim();
    case 'heading_3':
      return `### ${text}`.trim();
    case 'bulleted_list_item':
      return `- ${text}${children}`.trim();
    case 'numbered_list_item':
      return `1. ${text}${children}`.trim();
    case 'to_do':
      return `- [${payload.checked === true ? 'x' : ' '}] ${text}${children}`.trim();
    case 'toggle':
      return `<details><summary>${escapeHtml(text || 'Toggle')}</summary>\n\n${childMarkdown.join('\n')}\n\n</details>`;
    case 'quote':
      return `> ${text}${children}`.trim();
    case 'callout':
      return `> ${text}${children}`.trim();
    case 'code': {
      const language = typeof payload.language === 'string' ? payload.language : '';
      return `\`\`\`${language}\n${text}\n\`\`\``;
    }
    case 'divider':
      return '---';
    case 'table':
      return childMarkdown.join('\n');
    case 'table_row':
      return renderNotionTableRow(payload);
    case 'child_page': {
      const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : 'Child page';
      warnings.push('notion_child_page_not_inlined');
      return `## ${title}\n\n_Notion child page boundary; import this page separately if needed._`;
    }
    case 'bookmark':
    case 'link_preview': {
      const url = typeof payload.url === 'string' ? payload.url : '';
      return url ? `[${text || url}](${url})` : text;
    }
    case 'file':
    case 'pdf':
    case 'image':
    case 'video':
    case 'audio': {
      const url = notionFileUrl(payload);
      warnings.push(`notion_media_not_downloaded:${type}`);
      return url ? `[${text || type}](${url})` : `[${text || type}](notion-media-url-expired)`;
    }
    default:
      warnings.push(`notion_block_unsupported:${type}`);
      return text || `_Unsupported Notion block: ${type}_`;
  }
}

function renderNotionTableRow(payload: Record<string, unknown>): string {
  const cells = Array.isArray(payload.cells) ? payload.cells : [];
  return `| ${cells.map((cell) => richTextPlainText(cell) ?? '').join(' | ')} |`;
}

function notionFileUrl(payload: Record<string, unknown>): string | undefined {
  const file = asOptionalRecord(payload.file);
  const external = asOptionalRecord(payload.external);
  return typeof file?.url === 'string' ? file.url : (typeof external?.url === 'string' ? external.url : undefined);
}

function indentMarkdown(value: string, prefix: string): string {
  return value.split('\n').map((line) => `${prefix}${line}`).join('\n');
}

function yamlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => yamlValue(entry)).join(', ')}]`;
  if (typeof value === 'string') return JSON.stringify(value);
  return JSON.stringify(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function richTextPlainText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((entry) => asOptionalRecord(entry)?.plain_text)
    .filter((entry): entry is string => typeof entry === 'string')
    .join('')
    .trim();
  return text || undefined;
}

function requireDisclosureSessionId(value: string | undefined): string {
  const sessionId = value?.trim();
  if (!sessionId || sessionId.length > DISCLOSURE_SESSION_ID_MAX_LENGTH) {
    throw disclosureError(DISCLOSURE_REFUSAL_CODES.sessionRequired);
  }
  return sessionId;
}

function disclosureError(code: DisclosureRefusalCode): DomainExpertWorkerError {
  return disclosureErrorFrom(disclosureRefusal(code));
}

function disclosureErrorFrom(refusal: DisclosureRefusal): DomainExpertWorkerError {
  return new DomainExpertWorkerError(refusal.status, refusal.code, refusal.message, refusal.remediation);
}

/**
 * Applies the declared excerpt bounds to one response's contexts. A crossing
 * of the cumulative per-source bound throws rather than trimming, so a client
 * cannot walk a source across a session.
 */
function boundDisclosedContexts<T extends Record<string, unknown> & { corpus_id: string }>(
  disclosure: DomainAskDisclosure,
  contexts: readonly T[],
): T[] {
  const result = discloseExcerpts(
    disclosure.policy,
    disclosure.ledger,
    contexts.map((context) => disclosureCandidate(context)),
  );
  if (result.status === 'refused') throw disclosureErrorFrom(result.refusal);
  disclosure.summary = result.summary;
  const kept: T[] = [];
  for (const [index, decision] of result.decisions.entries()) {
    if (decision.kind !== 'disclosed') continue;
    kept.push({
      ...contexts[index]!,
      text: decision.text,
      ...(decision.truncated ? { excerpt_truncated: true } : {}),
    });
  }
  return kept;
}

function disclosureCandidate(context: Record<string, unknown> & { corpus_id: string }): DisclosureExcerptCandidate {
  const sourceKey = disclosureSourceKey(context);
  const sourceChars = positiveNumberValue(context.sourceCharCount)
    ?? positiveNumberValue(context.source_char_count);
  const uri = retrievedContextSourceUri(context);
  const display = retrievedContextDisplayName(context);
  const sourceKeys = [...(uri ? [`uri:${uri}`] : []), ...(display ? [`display:${display}`] : [])];
  return {
    corpusId: context.corpus_id,
    ...(sourceKey ? { sourceKey } : {}),
    ...(sourceKeys.length ? { sourceKeys } : {}),
    text: stringValue(context.text) ?? '',
    ...(sourceChars === undefined ? {} : { sourceChars }),
  };
}

/**
 * Opaque per-source counting key. It never leaves this process: refusals carry
 * a code and a generic message, never the source identity.
 */
function disclosureSourceKey(context: Record<string, unknown>): string | undefined {
  const uri = retrievedContextSourceUri(context);
  if (uri) return `uri:${uri}`;
  const display = retrievedContextDisplayName(context);
  return display ? `display:${display}` : undefined;
}

function positiveNumberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Content-free disclosure report. Counts and configured bounds only — no
 * excerpt text, no source identity, and no id of a corpus that was withheld.
 */
function disclosureReport(disclosure: DomainAskDisclosure): Record<string, unknown> {
  return {
    posture_declared: true,
    citation_required: true,
    bounds: {
      max_quote_chars: disclosure.policy.bounds.maxQuoteChars,
      max_quotes_per_source: disclosure.policy.bounds.maxQuotesPerSource,
      max_source_coverage_per_session: disclosure.policy.bounds.maxSourceCoveragePerSession,
    },
    corpora: disclosure.corpora.map((corpusId) => ({
      corpus_id: corpusId,
      disclosure: disclosure.policy.postureFor(corpusId),
    })),
    withheld_corpus_count: disclosure.withheldCorpusCount,
    excerpts_disclosed: disclosure.summary.excerptsDisclosed,
    excerpts_truncated: disclosure.summary.excerptsTruncated,
    excerpts_withheld: disclosure.summary.excerptsWithheld,
  };
}

function normalizeRetrievedContextSource(context: Record<string, unknown>): Record<string, unknown> {
  return {
    ...context,
    ...(!stringValue(context.sourceDisplayName) ? optionalField('sourceDisplayName', retrievedContextDisplayName(context)) : {}),
    ...(!stringValue(context.sourceUri) ? optionalField('sourceUri', retrievedContextSourceUri(context)) : {}),
  };
}

export function reciprocalRankFuse<T extends Record<string, unknown>>(rankedLists: T[][], limit = Number.POSITIVE_INFINITY): T[] {
  const fused = new Map<string, { context: T; score: number; firstSeen: number }>();
  let firstSeen = 0;
  for (const contexts of rankedLists) {
    const seenInList = new Set<string>();
    for (const [index, context] of contexts.entries()) {
      const key = retrievedContextDedupeKey(context);
      if (seenInList.has(key)) continue;
      seenInList.add(key);
      const score = 1 / (DOMAIN_RRF_K + index + 1);
      const existing = fused.get(key);
      if (existing) {
        existing.score += score;
      } else {
        fused.set(key, { context, score, firstSeen: firstSeen++ });
      }
    }
  }
  return [...fused.values()]
    .sort((left, right) => right.score - left.score || left.firstSeen - right.firstSeen)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.context);
}

function retrievedContextDedupeKey(context: Record<string, unknown>): string {
  const chunk = asOptionalRecord(context.chunk);
  const contextId = stringValue(context.id)
    ?? stringValue(context.contextId)
    ?? stringValue(context.context_id)
    ?? stringValue(context.chunkId)
    ?? stringValue(context.chunk_id)
    ?? stringValue(chunk?.id)
    ?? stringValue(chunk?.name);
  if (contextId) return `id:${stringValue(context.corpus_id) ?? ''}\n${contextId}`;
  const sourceUri = retrievedContextSourceUri(context) ?? '';
  const text = String(context.text ?? chunk?.text ?? '');
  return `source:${sourceUri}\ntext:${createHash('sha256').update(text).digest('hex')}`;
}

function domainRetrievalQueries(question: string, reformulations: string[]): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [question, ...reformulations]) {
    const query = candidate.trim();
    const key = query.toLocaleLowerCase();
    if (!query || seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= DOMAIN_ASK_RETRIEVAL_DEFAULTS.maxQueries) break;
  }
  if (queries.length < 3) {
    throw new Error('Query reformulations must yield at least two distinct non-blank queries different from the original question.');
  }
  return queries;
}

function parseQueryReformulations(text: string): string[] {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(cleaned) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Query reformulations must be a JSON array.');
  return parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).slice(0, 2);
}

function domainExpertRerankerFromEnv(value: string | undefined): DomainExpertReranker {
  const normalized = value?.trim().toLowerCase().replaceAll('_', '-') || DOMAIN_ASK_RETRIEVAL_DEFAULTS.reranker;
  if (normalized === 'rank-service' || normalized === 'llm' || normalized === 'off') return normalized;
  if (normalized === 'none' || normalized === 'false' || normalized === '0') return 'off';
  throw new Error('EXPERT_AGENTS_DOMAIN_EXPERT_RERANKER must be rank-service, llm, or off.');
}

function booleanEnvWithDefault(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
  throw new Error(`${name} must be true or false.`);
}

function retrievedContextDisplayName(context: Record<string, unknown>): string | undefined {
  return stringValue(context.sourceDisplayName)
    ?? stringValue(asOptionalRecord(context.source)?.displayName)
    ?? stringValue(asOptionalRecord(context.ragFile)?.displayName)
    ?? stringValue(asOptionalRecord(asOptionalRecord(context.chunk)?.source)?.displayName)
    ?? stringValue(asOptionalRecord(asOptionalRecord(context.chunk)?.ragFile)?.displayName);
}

function retrievedContextSourceUri(context: Record<string, unknown>): string | undefined {
  return stringValue(context.sourceUri)
    ?? stringValue(asOptionalRecord(context.source)?.uri)
    ?? stringValue(asOptionalRecord(context.source)?.sourceUri)
    ?? stringValue(asOptionalRecord(context.ragFile)?.sourceUri)
    ?? firstString(asOptionalRecord(asOptionalRecord(context.ragFile)?.gcsSource)?.uris)
    ?? stringValue(asOptionalRecord(asOptionalRecord(context.chunk)?.source)?.uri)
    ?? stringValue(asOptionalRecord(asOptionalRecord(context.chunk)?.source)?.sourceUri)
    ?? stringValue(asOptionalRecord(asOptionalRecord(context.chunk)?.ragFile)?.sourceUri)
    ?? firstString(asOptionalRecord(asOptionalRecord(asOptionalRecord(context.chunk)?.ragFile)?.gcsSource)?.uris);
}

function optionalField(key: string, value: string | undefined): Record<string, string> {
  return value ? { [key]: value } : {};
}

function firstString(value: unknown): string | undefined {
  return Array.isArray(value) ? value.find((item): item is string => typeof item === 'string' && item.length > 0) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function notionImportErrorForObject(error: unknown, source: NotionImportSource): Record<string, unknown> {
  if (error instanceof DomainExpertWorkerError) {
    return {
      object_id: source.id,
      ...(source.url ? { source_url: source.url } : {}),
      ...(source.type ? { object_type: source.type } : {}),
      code: error.code,
      message: error.message,
      ...(error.suggestion ? { suggestion: error.suggestion } : {}),
    };
  }
  return {
    object_id: source.id,
    ...(source.url ? { source_url: source.url } : {}),
    ...(source.type ? { object_type: source.type } : {}),
    code: 'notion_object_failed',
    message: error instanceof Error ? error.message : 'Notion object probe failed.',
  };
}

function retryAfterMs(value: string | null): number {
  if (!value) return 250;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5_000);
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? 250 : Math.min(Math.max(0, dateMs - Date.now()), 5_000);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export const WEB_IMPORT_HANDLERS: readonly WebImportHandler[] = [
  {
    id: 'direct-file',
    detect: (context) => directFileExtension(context.finalUrl, context.response.headers, context.response.bytes) !== undefined,
    derive: deriveDirectFile,
  },
  {
    id: 'notion',
    detect: (context) => isNotionImportUrl(context.sourceUrl) || isNotionImportUrl(context.finalUrl),
    derive: deriveNotionRequiresApiImport,
  },
  // Terminal handler: web pages and YouTube alike are extracted by the owner's
  // ruled engine, not by page parsing or a yt-dlp call of this worker's own.
  {
    id: 'summarize-extract',
    detect: () => true,
    derive: deriveSummarizeExtraction,
  },
];

export function selectWebImportHandler(context: WebImportHandlerContext, handlers: readonly WebImportHandler[] = WEB_IMPORT_HANDLERS): WebImportHandler {
  const handler = handlers.find((candidate) => candidate.detect(context));
  if (!handler) throw new DomainExpertWorkerError(500, 'web_import_handler_missing', 'No web import handler matched the URL.');
  return handler;
}

async function deriveWebImportFiles(input: {
  urls: string[];
  includeMedia: boolean;
  transcriptMode: 'auto' | 'captions' | 'asr';
  dryRun: boolean;
  fetchedAt: string;
  fetch: (url: string) => Promise<WebImportFetchResult>;
  extraction: ExtractionRuntimeContext;
}): Promise<{
  files: WebImportDerivedFile[];
  errors: WebImportUrlError[];
  urlResults: Array<Record<string, unknown>>;
}> {
  const files: WebImportDerivedFile[] = [];
  const errors: WebImportUrlError[] = [];
  const urlResults: Array<Record<string, unknown>> = [];
  const usedFileNames = new Set<string>();
  for (const sourceUrl of input.urls) {
    const sourceProvenanceUrl = webImportProvenanceUrl(sourceUrl);
    let response: WebImportFetchResult | undefined;
    let handler: WebImportHandler | undefined;
    try {
      if (isNotionImportUrl(sourceUrl)) {
        const error = notionRequiresApiImportError(sourceProvenanceUrl);
        errors.push(error);
        urlResults.push({
          source_url: sourceProvenanceUrl,
          final_url: sourceProvenanceUrl,
          handler: 'notion',
          file_count: 0,
          error_count: 1,
          suggestion: error.suggestion,
        });
        continue;
      }
      response = await input.fetch(sourceUrl);
      const finalProvenanceUrl = webImportProvenanceUrl(response.url);
      const context: WebImportHandlerContext = {
        sourceUrl,
        finalUrl: response.url,
        sourceProvenanceUrl,
        finalProvenanceUrl,
        response,
        includeMedia: input.includeMedia,
        transcriptMode: input.transcriptMode,
        dryRun: input.dryRun,
        fetchedAt: input.fetchedAt,
        fetch: input.fetch,
        extraction: input.extraction,
      };
      handler = selectWebImportHandler(context);
      const activeHandler = handler;
      assertWebImportProcessingLimit(context, activeHandler);
      const result = await activeHandler.derive(context);
      for (const file of result.files) {
        const fileName = uniqueWebImportFileName(file.fileName, usedFileNames);
        files.push({ ...file, fileName });
      }
      if (result.errors?.length) {
        errors.push(...result.errors.map((error) => sanitizeWebImportUrlError({
          ...error,
          handler: error.handler ?? activeHandler.id,
        })));
      }
      urlResults.push({
        source_url: sourceProvenanceUrl,
        final_url: finalProvenanceUrl,
        handler: activeHandler.id,
        file_count: result.files.length,
        error_count: result.errors?.length ?? 0,
        ...(result.plan ?? {}),
      });
    } catch (error) {
      if (error instanceof DomainExpertWorkerError && WEB_IMPORT_FAIL_CLOSED_CODES.has(error.code)) {
        throw error;
      }
      const normalized = webImportErrorForUrl(error, sourceProvenanceUrl, response?.url, handler?.id);
      errors.push(normalized);
      // Name the engine this URL would actually have used: the summarize
      // subprocess for YouTube, the in-process converter for a page.
      const extractor = isAllowedYoutubeUrl(sourceUrl) || (response !== undefined && isAllowedYoutubeUrl(response.url))
        ? EXTRACTION_METHOD
        : WEB_IMPORT_LOCAL_HTML_EXTRACTOR;
      urlResults.push({
        source_url: sourceProvenanceUrl,
        ...(response?.url ? { final_url: webImportProvenanceUrl(response.url) } : {}),
        ...(handler?.id ? { handler: handler.id } : {}),
        file_count: 0,
        error_count: 1,
        ...(handler?.id === 'summarize-extract' ? { extractor } : {}),
      });
    }
  }
  return { files, errors, urlResults };
}

const WEB_IMPORT_FAIL_CLOSED_CODES = new Set([
  'web_import_https_required',
  'web_import_url_credentials_denied',
  'web_import_hostname_unresolved',
  'web_import_private_address_denied',
  'web_import_redirect_without_location',
  'web_import_redirect_limit_exceeded',
  'web_import_fetch_size_limit_exceeded',
  'web_import_processing_size_limit_exceeded',
  'web_import_batch_size_limit_exceeded',
  'web_import_fetch_limit_exceeded',
  'web_import_unpinned_fetch_impl',
  // A missing extractor is not a property of any one URL.
  'summarize_not_installed',
]);

function webImportErrorForUrl(error: unknown, sourceUrl: string, finalUrl: string | undefined, handler: string | undefined): WebImportUrlError {
  if (error instanceof DomainExpertWorkerError) {
    return sanitizeWebImportUrlError({
      source_url: sourceUrl,
      ...(finalUrl ? { final_url: finalUrl } : {}),
      ...(handler ? { handler } : {}),
      code: error.code,
      message: error.message,
      ...(error.suggestion ? { suggestion: error.suggestion } : {}),
      ...(error.stderrTail ? { stderr_tail: error.stderrTail } : {}),
    });
  }
  return sanitizeWebImportUrlError({
    source_url: sourceUrl,
    ...(finalUrl ? { final_url: finalUrl } : {}),
    ...(handler ? { handler } : {}),
    code: 'web_import_url_failed',
    message: error instanceof Error ? error.message : 'web_import failed for this URL.',
  });
}

async function deriveNotionRequiresApiImport(context: WebImportHandlerContext): Promise<WebImportHandlerResult> {
  return {
    files: [],
    errors: [notionRequiresApiImportError(context.sourceProvenanceUrl, context.finalProvenanceUrl)],
  };
}

function notionRequiresApiImportError(sourceUrl: string, finalUrl?: string): WebImportUrlError {
  return {
    source_url: sourceUrl,
    ...(finalUrl ? { final_url: finalUrl } : {}),
    handler: 'notion',
    code: 'notion_requires_api_import',
    message: 'Notion pages require the official Notion API import lane because public Notion pages are client-rendered.',
    suggestion: 'Use rag_corpus action=notion_import with Notion URLs, page_ids, or database_ids after sharing the target pages with the integration.',
  };
}

function sanitizeWebImportUrlError(error: WebImportUrlError): WebImportUrlError {
  return {
    ...error,
    source_url: webImportProvenanceUrl(error.source_url),
    ...(error.final_url ? { final_url: webImportProvenanceUrl(error.final_url) } : {}),
    message: sanitizeWebImportProvenanceText(error.message),
    ...(error.suggestion ? { suggestion: sanitizeWebImportProvenanceText(error.suggestion) } : {}),
    ...(error.stderr_tail ? { stderr_tail: sanitizeWebImportProvenanceText(error.stderr_tail) } : {}),
  };
}

function sanitizeWebImportProvenanceText(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/g, (match) => webImportProvenanceUrl(match));
}

function webImportProvenanceUrl(value: string): string {
  try {
    const url = new URL(value);
    const allowed = allowedWebImportProvenanceParams(url);
    const params = new URLSearchParams();
    for (const [key, item] of url.searchParams.entries()) {
      if (allowed.has(key.toLowerCase())) params.append(key, item);
    }
    url.username = '';
    url.password = '';
    url.search = params.toString();
    url.hash = '';
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

function allowedWebImportProvenanceParams(url: URL): Set<string> {
  const hostname = normalizedUrlHostname(url);
  if ((hostname === 'youtube.com' || hostname === 'www.youtube.com' || hostname === 'm.youtube.com')
    && url.pathname === '/watch') {
    return new Set(['v']);
  }
  return new Set();
}

function uniqueWebImportFileName(fileName: string, used: Set<string>): string {
  const safe = safeRelativeFileName(fileName);
  if (!used.has(safe)) {
    used.add(safe);
    return safe;
  }
  const extension = extname(safe);
  const stem = extension ? safe.slice(0, -extension.length) : safe;
  for (let index = 2; ; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

function safeRelativeFileName(value: string): string {
  const extension = extname(value).toLowerCase();
  const stem = extension ? value.slice(0, -extension.length) : value;
  return `${safeObjectName(stem)}${extension || '.md'}`;
}

type SummarizeExtractionInput =
  | { mode: 'local_input'; source: Uint8Array; fetchPerformedBy: typeof WEB_IMPORT_WORKER_FETCHER }
  | { mode: 'youtube_url'; source: string; fetchPerformedBy: typeof SUMMARIZE_BINARY };

/**
 * The single extraction path for web_import. YouTube must stay in URL mode so
 * summarize can use its transcript machinery; every other page is converted in
 * process from the bytes already fetched through the worker's DNS-pinned
 * transport, so a page import never spawns a second, unpinned fetch.
 */
async function deriveSummarizeExtraction(context: WebImportHandlerContext): Promise<WebImportHandlerResult> {
  const youtube = isAllowedYoutubeUrl(context.sourceUrl) || isAllowedYoutubeUrl(context.finalUrl);
  const kind = youtube ? 'youtube' : 'html';
  const extractionInput: SummarizeExtractionInput = youtube
    ? { mode: 'youtube_url', source: context.finalUrl, fetchPerformedBy: SUMMARIZE_BINARY }
    : { mode: 'local_input', source: context.response.bytes, fetchPerformedBy: WEB_IMPORT_WORKER_FETCHER };
  const extracted = extractionInput.mode === 'youtube_url'
    ? await runSummarizeExtraction(context.extraction, extractionInput.source)
    : localHtmlExtraction(extractionInput.source);
  const extractor = extractionInput.mode === 'youtube_url' ? EXTRACTION_METHOD : WEB_IMPORT_LOCAL_HTML_EXTRACTOR;
  const html = utf8(context.response.bytes);
  const title = extractHtmlTitle(html)
    || firstMarkdownHeading(extracted)
    || new URL(context.finalUrl).hostname;
  // The extractor usually emits its own leading heading; a second one would
  // just be noise in the retrieved chunk.
  const heading = extracted.startsWith('#') ? '' : `# ${title}\n\n`;
  const markdown = `${frontmatter({
    source_url: context.sourceProvenanceUrl,
    retrieved_at: context.fetchedAt,
    kind,
    title,
    extractor,
  })}${heading}${extracted}`;
  return {
    files: [{
      sourceUrl: context.sourceProvenanceUrl,
      finalUrl: context.finalProvenanceUrl,
      kind,
      fileName: `${safeObjectName(title)}.md`,
      bytes: new TextEncoder().encode(markdown),
      ...(extracted.length < WEB_IMPORT_SHORT_EXTRACTION_CHARACTERS ? { warnings: ['short_extraction'] } : {}),
    }],
    plan: {
      extractor,
      extracted_characters: extracted.length,
      extraction_input_mode: extractionInput.mode,
      extraction_fetch_performed_by: extractionInput.fetchPerformedBy,
      // transcript_mode is reported on every YouTube URL precisely because it
      // no longer chooses anything; see WEB_IMPORT_TRANSCRIPT_MODE_NOTE.
      ...(youtube
        ? {
          transcript_mode: context.transcriptMode,
          transcript_mode_effect: WEB_IMPORT_TRANSCRIPT_MODE_EFFECT,
        }
        : {}),
    },
  };
}

/**
 * A page's bytes are already in this process: the library's own converter turns
 * them into Markdown without a subprocess, a temp file, or a second fetch. An
 * empty result is refused with the same code the extractor's own empty answer
 * uses, and the message carries no page content.
 */
function localHtmlExtraction(bytes: Uint8Array): string {
  const extracted = normalizeExtractedText(xhtmlToMarkdown(utf8(bytes)).markdown);
  if (extracted.length === 0) {
    throw new DomainExpertWorkerError(
      422,
      'summarize_extraction_empty',
      `${WEB_IMPORT_LOCAL_HTML_EXTRACTOR} produced no text for this page.`,
    );
  }
  return extracted;
}

async function runSummarizeExtraction(extraction: ExtractionRuntimeContext, source: string): Promise<string> {
  const extractionRoot = await mkdtemp(join(resolve(extraction.dataDir), '.extraction-runtime-'));
  const directories = ensurePrivateExtractionDirectories(extractionRoot);
  const request: ExtractionRequest = {
    binaryPath: extractionBinaryForPrivateCwd(extraction.binaryPath),
    source: extractionSourceForPrivateCwd(source),
    args: EXTRACTION_ARGUMENTS,
    env: isolatedExtractorEnvironment(extraction.env, directories),
    workingDirectory: extractionRoot,
    timeoutMs: extraction.timeoutMs,
  };
  let result: ExtractionResult;
  try {
    result = await extraction.extract(request);
  } catch (error) {
    // A missing extractor is a host misconfiguration, not a bad URL: it fails
    // the whole request rather than reporting every URL as its own failure.
    if (isMissingExecutableError(error)) {
      throw new DomainExpertWorkerError(
        503,
        'summarize_not_installed',
        `${SUMMARIZE_BINARY} is required for web_import extraction. Install it with \`${SUMMARIZE_INSTALL_COMMAND}\`, or set EXPERT_AGENTS_DOMAIN_EXPERT_SUMMARIZE_BIN.`,
        `Run ${SUMMARIZE_INSTALL_COMMAND} on the worker host.`,
      );
    }
    if (isKilledSubprocessError(error)) {
      throw withStderrTail(
        new DomainExpertWorkerError(
          408,
          'summarize_extraction_timeout',
          `${EXTRACTION_METHOD} exceeded the ${extraction.timeoutMs} ms extraction timeout.`,
        ),
        execErrorText(error, 'stderr'),
      );
    }
    // The thrown message carries the spawned command line, and a diagnostic can
    // carry a signed media URL, so both are stripped of query material before
    // they reach a result.
    const message = error instanceof Error ? error.message : `${SUMMARIZE_BINARY} failed.`;
    throw withStderrTail(
      new DomainExpertWorkerError(502, 'summarize_extraction_failed', sanitizeWebImportProvenanceText(message)),
      execErrorText(error, 'stderr'),
    );
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
  if (result.exitCode !== 0) {
    throw withStderrTail(
      new DomainExpertWorkerError(
        502,
        'summarize_extraction_failed',
        `${EXTRACTION_METHOD} exited with code ${result.exitCode}: ${sanitizeWebImportProvenanceText(firstDiagnosticLine(result.stderr))}`,
      ),
      result.stderr,
    );
  }
  const extracted = normalizeExtractedText(result.stdout);
  if (extracted.length === 0) {
    throw withStderrTail(
      new DomainExpertWorkerError(
        422,
        'summarize_extraction_empty',
        `${EXTRACTION_METHOD} produced no text for this URL: ${sanitizeWebImportProvenanceText(firstDiagnosticLine(result.stderr))}`,
      ),
      result.stderr,
    );
  }
  return extracted;
}

function extractionBinaryForPrivateCwd(binaryPath: string): string {
  return isAbsolute(binaryPath) || (!binaryPath.includes('/') && !binaryPath.includes('\\'))
    ? binaryPath
    : resolve(binaryPath);
}

function extractionSourceForPrivateCwd(source: string): string {
  try {
    new URL(source);
    return source;
  } catch {
    return isAbsolute(source) ? source : resolve(source);
  }
}

function firstMarkdownHeading(markdown: string): string | undefined {
  const heading = markdown.split('\n').find((line) => /^#{1,6}\s+\S/.test(line));
  return heading ? heading.replace(/^#{1,6}\s+/, '').trim() : undefined;
}

const defaultSummarizeExtract: ReferenceExtractor = (request) => new Promise((resolvePromise, rejectPromise) => {
  execFile(request.binaryPath, [request.source, ...request.args], {
    cwd: request.workingDirectory,
    env: request.env,
    ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }),
    maxBuffer: SUMMARIZE_EXTRACT_MAX_OUTPUT_BYTES,
  }, (error, stdout, stderr) => {
    if (!error) {
      resolvePromise({ exitCode: 0, stdout, stderr });
      return;
    }
    // A refused spawn and a killed subprocess are conditions of the host, so
    // they are thrown; a non-zero exit is the extractor's own answer about the
    // source, so it is returned with the diagnostics it printed.
    if (isMissingExecutableError(error) || isKilledSubprocessError(error)) {
      Object.assign(error, { stdout, stderr });
      rejectPromise(error);
      return;
    }
    resolvePromise({
      exitCode: typeof error.code === 'number' ? error.code : 1,
      stdout,
      stderr,
    });
  });
});

function isMissingExecutableError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT');
}

function isKilledSubprocessError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { killed?: unknown }).killed === true);
}

function execErrorText(error: unknown, key: 'stdout' | 'stderr'): string {
  if (!error || typeof error !== 'object' || !(key in error)) return '';
  return String((error as Record<string, unknown>)[key] ?? '');
}

function withStderrTail<T extends DomainExpertWorkerError>(error: T, stderr: string): T {
  const tail = stderrTail(stderr);
  if (tail) error.stderrTail = tail;
  return error;
}

function stderrTail(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(-500) : undefined;
}

function transcriptMarkdown(input: {
  sourceUrl: string;
  retrievedAt: string;
  kind: string;
  title: string;
  channel?: string;
  transcriptSource: 'captions' | 'asr';
  transcript: string;
}): string {
  return `${frontmatter({
    source_url: input.sourceUrl,
    retrieved_at: input.retrievedAt,
    kind: input.kind,
    transcript_source: input.transcriptSource,
    title: input.title,
    ...(input.channel ? { channel: input.channel } : {}),
  })}# ${input.title}

${input.channel ? `Channel: ${input.channel}\n\n` : ''}Source: ${input.sourceUrl}

## Transcript

${input.transcript.trim()}
`;
}

async function transcribeMediaFromGcs(input: {
  project: string;
  location: string;
  sourceUrl: string;
  title: string;
  kind: string;
  retrievedAt: string;
  transcriptSource: 'asr';
  gcsUri: string;
  mimeType: string;
  transcribe(media: { gcsUri: string; mimeType: string }): Promise<string>;
}): Promise<{ bytes: Uint8Array }> {
  const transcript = await input.transcribe({ gcsUri: input.gcsUri, mimeType: input.mimeType });
  if (!transcript.trim()) {
    throw new DomainExpertWorkerError(502, 'media_asr_empty', 'Gemini ASR returned no readable transcript text for this media file.');
  }
  return {
    bytes: new TextEncoder().encode(transcriptMarkdown({
      sourceUrl: input.sourceUrl,
      retrievedAt: input.retrievedAt,
      kind: input.kind,
      title: input.title,
      transcriptSource: input.transcriptSource,
      transcript,
    })),
  };
}

async function deriveDirectFile(context: WebImportHandlerContext): Promise<WebImportHandlerResult> {
  const extension = directFileExtension(context.finalUrl, context.response.headers, context.response.bytes);
  if (!extension) {
    return { files: [] };
  }
  const isMedia = STAGE_IMPORT_MEDIA_EXTENSIONS.has(extension);
  if (isMedia && !context.includeMedia) {
    return {
      files: [],
      errors: [{
        source_url: context.sourceProvenanceUrl,
        final_url: context.finalProvenanceUrl,
        code: 'media_requires_include_media',
        message: `${extension.slice(1)} media files are skipped unless include_media=true.`,
      }],
    };
  }
  const urlPathName = directFileMetadataName(context.finalUrl, context.response.headers);
  const fallbackName = `${new URL(context.finalUrl).hostname}${extension}`;
  const fileName = urlPathName
    ? `${urlPathName.slice(0, Math.max(0, urlPathName.length - extname(urlPathName).length)) || 'download'}${extension}`
    : fallbackName;
  const bytes = extension !== '.pdf' && !isMedia
    ? new TextEncoder().encode(`${frontmatter({
        source_url: context.sourceProvenanceUrl,
        retrieved_at: context.fetchedAt,
        kind: 'file',
      })}${utf8(context.response.bytes)}`)
    : context.response.bytes;
  return {
    files: [{
      sourceUrl: context.sourceProvenanceUrl,
      finalUrl: context.finalProvenanceUrl,
      kind: 'file',
      fileName,
      bytes,
    }],
  };
}

function directFileExtension(url: string, headers: Headers, bytes: Uint8Array): string | undefined {
  const pathExtension = extname(new URL(url).pathname).toLowerCase();
  const dispositionExtension = extname(directFileMetadataName(url, headers) ?? '').toLowerCase();
  // A PDF extension or MIME type is only a hint. Direct-file treatment requires
  // the PDF header in the fetched bytes, which also recognizes download hashes
  // that arrive as application/octet-stream with a disposition filename.
  if (hasPdfHeader(bytes)) return '.pdf';
  if (pathExtension === '.pdf' || dispositionExtension === '.pdf') return undefined;
  if (STAGE_IMPORT_ALLOWED_EXTENSIONS.has(pathExtension) || STAGE_IMPORT_MEDIA_EXTENSIONS.has(pathExtension)) {
    return pathExtension;
  }
  const contentType = headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const byContentType: Record<string, string> = {
    'text/markdown': '.md',
    'text/plain': '.txt',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/aac': '.aac',
    'audio/ogg': '.ogg',
    'audio/wav': '.wav',
    'audio/wave': '.wav',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
  };
  return contentType ? byContentType[contentType] : undefined;
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, Math.min(bytes.byteLength, 1024));
  for (let at = 0; at <= window.byteLength - 8; at += 1) {
    if (window[at] === 0x25 && window[at + 1] === 0x50 && window[at + 2] === 0x44
      && window[at + 3] === 0x46 && window[at + 4] === 0x2d
      && (window[at + 5] === 0x31 || window[at + 5] === 0x32)
      && window[at + 6] === 0x2e
      && window[at + 7]! >= 0x30 && window[at + 7]! <= 0x39
      && window.subarray(0, at).every((byte) => isPdfWhitespace(byte))) return true;
  }
  return false;
}

function directFileMetadataName(url: string, headers: Headers): string | undefined {
  const disposition = headers.get('content-disposition');
  const encoded = disposition?.match(/(?:^|;)\s*filename\*=UTF-8''([^;]+)/i)?.[1];
  const quoted = disposition?.match(/(?:^|;)\s*filename="([^"]+)"/i)?.[1];
  const bare = disposition?.match(/(?:^|;)\s*filename=([^;]+)/i)?.[1]?.trim();
  let candidate = encoded ? safeDecodeURIComponent(encoded.trim()) : (quoted ?? bare);
  if (!candidate) candidate = basename(new URL(url).pathname);
  candidate = candidate.replaceAll('\\', '/').split('/').pop()?.trim();
  return candidate || undefined;
}

function safeDecodeURIComponent(value: string): string {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function assertWebImportProcessingLimit(context: WebImportHandlerContext, handler: WebImportHandler): void {
  const extension = handler.id === 'direct-file'
    ? directFileExtension(context.finalUrl, context.response.headers, context.response.bytes)
    : undefined;
  const limit = extension === '.pdf' ? PDF_PROCESSING_MAX_BYTES : maxStageFileBytes(`source${extension ?? '.html'}`);
  if (context.response.bytes.byteLength > limit) {
    throw new DomainExpertWorkerError(
      413,
      'web_import_processing_size_limit_exceeded',
      `web_import ${extension === '.pdf' ? 'PDF' : 'text/default'} processing is limited to ${limit} bytes per file.`,
    );
  }
}

function mediaMimeType(path: string): string {
  const byExtension: Record<string, string> = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
  };
  return byExtension[extname(path).toLowerCase()] ?? 'audio/mp4';
}

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

function isAllowedYoutubeUrl(value: string): boolean {
  try {
    return YOUTUBE_HOSTS.has(normalizedUrlHostname(new URL(value)));
  } catch {
    return false;
  }
}

function timedTextToPlainText(xml: string): string {
  const parts = [...xml.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)]
    .map((match) => decodeHtmlEntities((match[1] ?? '').replace(/<[^>]+>/g, ' ')).trim())
    .filter(Boolean);
  return collapseWhitespace(parts.join(' '));
}

function extractHtmlTitle(html: string): string | undefined {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? collapseWhitespace(decodeHtmlEntities((match[1] ?? '').replace(/<[^>]+>/g, ' '))) : undefined;
}

function extractJsonString(text: string, key: string): string | undefined {
  const match = text.match(new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'i'));
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1] ?? ''}"`);
  } catch {
    return (match[1] ?? '').replaceAll('\\"', '"');
  }
}

function frontmatter(values: Record<string, unknown>): string {
  const lines = Object.entries(values).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `---\n${lines.join('\n')}\n---\n\n`;
}

function webImportFetchFromFetchImpl(_fetchImpl: typeof fetch): WebImportFetchImpl {
  return (_url, _options) => {
    return Promise.reject(new DomainExpertWorkerError(
      500,
      'web_import_unpinned_fetch_impl',
      'Guarded outbound fetches cannot use a generic fetchImpl because it cannot enforce the prevalidated destination address. Provide webImportFetchImpl or use the default pinned HTTPS transport.',
    ));
  };
}

// The runtime's socket layer may call this with {all: true} (happy-eyeballs
// family selection sorts the result array), or without it for a single
// address — both shapes must be served or the request dies inside net.
export function pinnedWebImportLookup(validatedAddresses: readonly string[]): (
  hostname: string,
  lookupOptions: unknown,
  callback: (err: Error | null, address?: unknown, family?: number) => void,
) => void {
  const entries = validatedAddresses
    .map((address) => ({ address, family: isIP(address) }))
    .filter((entry) => entry.family !== 0 && !isPrivateOrReservedAddress(entry.address));
  return (_hostname, lookupOptions, callback) => {
    const first = entries[0];
    if (!first) {
      callback(new Error('web_import pinned lookup has no validated public addresses.'));
      return;
    }
    if ((lookupOptions as { all?: boolean } | undefined)?.all) {
      callback(null, entries);
      return;
    }
    callback(null, first.address, first.family);
  };
}

function defaultWebImportFetch(url: URL, options: {
  signal: AbortSignal;
  validatedAddresses: readonly string[];
}): Promise<Response> {
  const publicAddresses = options.validatedAddresses
    .filter((address) => isIP(address) !== 0 && !isPrivateOrReservedAddress(address));
  if (publicAddresses.length === 0) {
    return Promise.reject(new DomainExpertWorkerError(
      400,
      'web_import_private_address_denied',
      `web_import denied non-public address ${options.validatedAddresses[0] ?? 'unresolved'} for ${normalizedUrlHostname(url)}.`,
    ));
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpsRequest(url, {
      method: 'GET',
      lookup: pinnedWebImportLookup(publicAddresses) as never,
      signal: options.signal,
    }, (message) => {
      resolvePromise(responseFromIncomingMessage(message));
    });
    request.on('error', rejectPromise);
    request.end();
  });
}

function responseFromIncomingMessage(message: IncomingMessage): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, String(value));
    }
  }
  const status = message.statusCode && message.statusCode >= 100 && message.statusCode <= 599
    ? message.statusCode
    : 502;
  const body = status === 204 || status === 304 ? null : readableStreamFromIncomingMessage(message);
  return new Response(body, {
    status,
    headers,
    ...(message.statusMessage ? { statusText: message.statusMessage } : {}),
  });
}

function readableStreamFromIncomingMessage(message: IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      message.on('data', (chunk: Buffer | Uint8Array | string) => {
        if (typeof chunk === 'string') {
          controller.enqueue(new TextEncoder().encode(chunk));
          return;
        }
        controller.enqueue(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
      });
      message.on('end', () => controller.close());
      message.on('error', (error) => controller.error(error));
    },
    cancel() {
      message.destroy();
    },
  });
}

async function guardedWebImportFetch(input: {
  url: string;
  fetchImpl: WebImportFetchImpl;
  resolveHost: ResolveHostImpl;
  budget: WebImportBudget;
  timeoutMs: number;
}): Promise<WebImportFetchResult> {
  let current = new URL(input.url);
  for (let redirects = 0; redirects <= WEB_IMPORT_MAX_REDIRECTS; redirects += 1) {
    const validatedAddresses = await assertWebImportUrlAllowed(current, input.resolveHost);
    if (input.budget.fetches >= WEB_IMPORT_MAX_FETCHES) {
      throw new DomainExpertWorkerError(400, 'web_import_fetch_limit_exceeded', 'web_import exceeded the maximum number of outbound fetches.');
    }
    input.budget.fetches += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    let response: Response;
    try {
      response = await input.fetchImpl(current, {
        validatedAddresses,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (controller.signal.aborted) {
        throw new DomainExpertWorkerError(408, 'web_import_fetch_timeout', `Timed out fetching ${webImportProvenanceUrl(current.toString())}.`);
      }
      throw error;
    }
    try {
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new DomainExpertWorkerError(400, 'web_import_redirect_without_location', `Redirect from ${webImportProvenanceUrl(current.toString())} did not include a Location header.`);
        }
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        throw new DomainExpertWorkerError(response.status, 'web_import_fetch_failed', `Fetch failed for ${webImportProvenanceUrl(current.toString())} with HTTP ${response.status}.`);
      }
      const bytes = await readCappedWebImportBody(response, input.budget, webImportProvenanceUrl(current.toString()), controller.signal);
      return {
        url: current.toString(),
        status: response.status,
        headers: response.headers,
        bytes,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new DomainExpertWorkerError(408, 'web_import_fetch_timeout', `Timed out fetching ${webImportProvenanceUrl(current.toString())}.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new DomainExpertWorkerError(400, 'web_import_redirect_limit_exceeded', 'web_import exceeded the maximum redirect count.');
}

interface WebImportBudget {
  fetches: number;
  totalBytes: number;
}

function webImportBudget(): WebImportBudget {
  return { fetches: 0, totalBytes: 0 };
}

async function readCappedWebImportBody(response: Response, budget: WebImportBudget, url: string, signal: AbortSignal): Promise<Uint8Array> {
  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
  if (contentLength !== undefined && Number.isFinite(contentLength)) {
    if (contentLength > WEB_IMPORT_MAX_FETCH_BYTES) {
      throw new DomainExpertWorkerError(413, 'web_import_fetch_size_limit_exceeded', `Fetch for ${url} exceeded the ${WEB_IMPORT_MAX_FETCH_BYTES} byte per-fetch limit.`);
    }
    if (budget.totalBytes + contentLength > WEB_IMPORT_MAX_BATCH_BYTES) {
      throw new DomainExpertWorkerError(413, 'web_import_batch_size_limit_exceeded', 'web_import exceeded the 100 MB batch fetch limit.');
    }
  }
  const startingBudgetBytes = budget.totalBytes;
  const chunks: Uint8Array[] = [];
  let fetchBytes = 0;
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    fetchBytes = bytes.byteLength;
    enforceWebImportBodyBudget(fetchBytes, { ...budget, totalBytes: startingBudgetBytes }, url);
    budget.totalBytes += chargedWebImportBytes(contentLength, fetchBytes);
    return bytes;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        throw new DomainExpertWorkerError(408, 'web_import_fetch_timeout', `Timed out fetching ${url}.`);
      }
      const { done, value } = await readWebImportChunk(reader, signal);
      if (done) break;
      if (!value) continue;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      fetchBytes += chunk.byteLength;
      try {
        enforceWebImportBodyBudget(fetchBytes, { ...budget, totalBytes: startingBudgetBytes }, url);
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (signal.aborted) {
      await reader.cancel().catch(() => {});
      throw new DomainExpertWorkerError(408, 'web_import_fetch_timeout', `Timed out fetching ${url}.`);
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  budget.totalBytes += chargedWebImportBytes(contentLength, fetchBytes);
  const bytes = new Uint8Array(fetchBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function chargedWebImportBytes(contentLength: number | undefined, actualBytes: number): number {
  return contentLength !== undefined && Number.isFinite(contentLength)
    ? Math.max(contentLength, actualBytes)
    : actualBytes;
}

function readWebImportChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> {
  if (signal.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(new DOMException('The operation was aborted.', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolvePromise(result);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        rejectPromise(error);
      },
    );
  });
}

function enforceWebImportBodyBudget(fetchBytes: number, budget: WebImportBudget, url: string): void {
  if (fetchBytes > WEB_IMPORT_MAX_FETCH_BYTES) {
    throw new DomainExpertWorkerError(413, 'web_import_fetch_size_limit_exceeded', `Fetch for ${url} exceeded the ${WEB_IMPORT_MAX_FETCH_BYTES} byte per-fetch limit.`);
  }
  if (budget.totalBytes + fetchBytes > WEB_IMPORT_MAX_BATCH_BYTES) {
    throw new DomainExpertWorkerError(413, 'web_import_batch_size_limit_exceeded', 'web_import exceeded the 100 MB batch fetch limit.');
  }
}

/**
 * The one destination guard both outbound lanes share: resolve the host, then
 * refuse the whole answer unless every address is public. Callers connect to
 * the addresses returned here and to nothing else, so a name that resolves
 * differently on a second lookup cannot move the connection into private space.
 * The reason is returned rather than thrown so each lane names the refusal in
 * its own error vocabulary.
 */
type PublicAddressResolution =
  | { ok: true; addresses: string[] }
  | { ok: false; reason: 'unresolved'; hostname: string }
  | { ok: false; reason: 'private_address'; hostname: string; address: string };

async function resolvePublicAddresses(url: URL, resolveHost: ResolveHostImpl): Promise<PublicAddressResolution> {
  const hostname = normalizedUrlHostname(url);
  const addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname);
  if (addresses.length === 0) return { ok: false, reason: 'unresolved', hostname };
  for (const address of addresses) {
    if (isPrivateOrReservedAddress(address)) {
      return { ok: false, reason: 'private_address', hostname, address };
    }
  }
  return { ok: true, addresses };
}

async function assertWebImportUrlAllowed(url: URL, resolveHost: ResolveHostImpl): Promise<string[]> {
  if (url.protocol !== 'https:') {
    throw new DomainExpertWorkerError(400, 'web_import_https_required', 'web_import only allows https URLs.');
  }
  // The URL is handed to summarize as child argv, so userinfo in it would be
  // readable from the process table — and it would be sent to the host as an
  // Authorization header besides.
  if (url.username || url.password) {
    throw new DomainExpertWorkerError(400, 'web_import_url_credentials_denied', 'web_import URLs may not carry embedded credentials.');
  }
  const resolution = await resolvePublicAddresses(url, resolveHost);
  if (resolution.ok) return resolution.addresses;
  throw resolution.reason === 'unresolved'
    ? new DomainExpertWorkerError(400, 'web_import_hostname_unresolved', `Could not resolve hostname ${resolution.hostname}.`)
    : new DomainExpertWorkerError(400, 'web_import_private_address_denied', `web_import denied non-public address ${resolution.address} for ${resolution.hostname}.`);
}

async function assertAnnasPartnerUrlAllowed(url: URL, resolveHost: ResolveHostImpl): Promise<string[]> {
  const resolution = await resolvePublicAddresses(url, resolveHost);
  if (resolution.ok) return resolution.addresses;
  throw resolution.reason === 'unresolved'
    ? new DomainExpertWorkerError(502, 'annas_archive_partner_host_unresolved', `Could not resolve Anna Archive partner host ${resolution.hostname}.`)
    : new DomainExpertWorkerError(403, 'annas_archive_partner_address_denied', `Anna Archive partner download denied non-public address ${resolution.address} for ${resolution.hostname}.`);
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(normalized)) return [normalized];
  const records = await lookup(normalized, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function normalizedUrlHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

// The allowlist itself lives in the shared extraction contract, so the ingest
// CLI and this worker cannot drift into two different ideas of what an
// extractor is allowed to inherit.
export function scrubbedExtractionEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  return allowlistedExtractionEnv(env);
}

function isPrivateOrReservedAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  const mapped = ipv4FromMappedIpv6(normalized) ?? normalized;
  const family = isIP(mapped);
  if (family === 4) return isPrivateOrReservedIpv4(mapped);
  if (family === 6) return isPrivateOrReservedIpv6(mapped);
  return true;
}

function isPrivateOrReservedIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a = -1, b = -1] = parts;
  return a === 0
    || a === 10
    || a === 127
    || a >= 224
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19));
}

function isPrivateOrReservedIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb')
    || normalized.startsWith('ff');
}

function ipv4FromMappedIpv6(address: string): string | undefined {
  const words = expandIpv6Words(address);
  if (!words || words.length !== 8) return undefined;
  if (
    words.slice(0, 5).some((word) => word !== 0)
    || words[5] !== 0xffff
  ) {
    return undefined;
  }
  const [high = 0, low = 0] = words.slice(6);
  return [
    (high >> 8) & 0xff,
    high & 0xff,
    (low >> 8) & 0xff,
    low & 0xff,
  ].join('.');
}

function expandIpv6Words(address: string): number[] | undefined {
  const normalized = replaceDottedIpv4Tail(address);
  if (!normalized) return undefined;
  const parts = normalized.split('::');
  if (parts.length > 2) return undefined;
  const left = ipv6WordsFromPart(parts[0] ?? '');
  const right = parts.length === 2 ? ipv6WordsFromPart(parts[1] ?? '') : [];
  if (!left || !right) return undefined;
  if (parts.length === 1) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [
    ...left,
    ...Array.from({ length: missing }, () => 0),
    ...right,
  ];
}

function replaceDottedIpv4Tail(address: string): string | undefined {
  const dotted = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address)?.[1];
  if (!dotted) return address;
  const parts = dotted.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  const high = ((parts[0] ?? 0) << 8) | (parts[1] ?? 0);
  const low = ((parts[2] ?? 0) << 8) | (parts[3] ?? 0);
  return `${address.slice(0, -dotted.length)}${high.toString(16)}:${low.toString(16)}`;
}

function ipv6WordsFromPart(part: string): number[] | undefined {
  if (!part) return [];
  const words = part.split(':').map((segment) => {
    if (!/^[0-9a-f]{1,4}$/i.test(segment)) return Number.NaN;
    return Number.parseInt(segment, 16);
  });
  return words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : undefined;
}

function resolvedCorpusRecord(resolved: ResolvedRagCorpus): Record<string, unknown> {
  return {
    requested: resolved.requested,
    corpus_id: resolved.corpusId,
    resource_name: resolved.resourceName,
    ...(resolved.displayName ? { display_name: resolved.displayName } : {}),
  };
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isFile(), () => false);
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function decodeUtf8Bytes(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function catalogPlannerLedger(text: string): MaterializationLedger {
  const value = JSON.parse(text) as unknown;
  if (canonicalJson(value) !== text) throw new Error('catalog ledger is not canonical');
  const record = catalogRecord(value);
  if (record.schemaVersion !== MATERIALIZATION_LEDGER_SCHEMA_VERSION
    || !Number.isSafeInteger(record.revision)
    || (record.revision as number) < 0
    || !Array.isArray(record.entries)) {
    throw new Error('catalog ledger header is invalid');
  }
  const entries = record.entries.map((value) => {
    const entry = catalogRecord(value);
    const allowed = new Set([
      'objectId',
      'ragFileId',
      'targetCorpusDisplayName',
      'corpusResourceName',
      'importedAtRevision',
    ]);
    if (['objectId', 'ragFileId', 'corpusResourceName', 'importedAtRevision'].some((key) => !(key in entry))
      || Object.keys(entry).some((key) => !allowed.has(key))
      || typeof entry.objectId !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(entry.objectId)
      || !catalogNonEmptyString(entry.ragFileId)
      || !catalogNonEmptyString(entry.corpusResourceName)
      || !Number.isSafeInteger(entry.importedAtRevision)
      || (entry.importedAtRevision as number) < 0
      || (entry.targetCorpusDisplayName !== undefined && !catalogNonEmptyString(entry.targetCorpusDisplayName))) {
      throw new Error('catalog ledger entry is invalid');
    }
    return {
      objectId: entry.objectId as Sha256Id,
      ragFileId: entry.ragFileId as string,
      ...(entry.targetCorpusDisplayName === undefined
        ? {}
        : { targetCorpusDisplayName: entry.targetCorpusDisplayName as string }),
    };
  });
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.objectId >= entries[index]!.objectId) {
      throw new Error('catalog ledger entries are not sorted and unique');
    }
  }
  if (new Set(entries.map((entry) => entry.ragFileId)).size !== entries.length) {
    throw new Error('catalog ledger RAG file ids are not unique');
  }
  return { schemaVersion: MATERIALIZATION_LEDGER_SCHEMA_VERSION, entries };
}

function catalogRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('catalog state is not an object');
  }
  return value as Record<string, unknown>;
}

function catalogNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function humanizeSourceLocatorBasename(locator: string): string {
  let path = locator.split(/[?#]/, 1)[0] ?? locator;
  try {
    path = new URL(locator).pathname;
  } catch {
    // Non-URL locators still have portable slash-delimited basenames.
  }
  let slug = basename(path) || path;
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // Preserve malformed percent encodings as literal slug text.
  }
  const extension = extname(slug);
  if (extension) slug = slug.slice(0, -extension.length);
  const humanized = slug
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((token) => `${token.charAt(0).toUpperCase()}${token.slice(1)}`)
    .join(' ');
  return humanized || 'Untitled Object';
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, ' ');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeRoot(root: DomainExpertWorkspaceRootPolicy): DomainExpertWorkspaceRootPolicy {
  return {
    rootId: requireString(root.rootId, 'root_id'),
    path: requireString(root.path, 'path'),
    maxWriteBytes: normalizePositiveInteger(root.maxWriteBytes, 100 * 1024 * 1024),
    allowOverwrite: root.allowOverwrite === true,
    ...(root.auditPath ? { auditPath: root.auditPath } : {}),
  };
}

function rootFromRecord(record: Record<string, unknown>): DomainExpertWorkspaceRootPolicy {
  return normalizeRoot({
    rootId: requireString(record.root_id ?? record.rootId, 'root_id'),
    path: requireString(record.path, 'path'),
    maxWriteBytes: normalizePositiveInteger(record.max_write_bytes ?? record.maxWriteBytes, 100 * 1024 * 1024),
    allowOverwrite: record.allow_overwrite === true || record.allowOverwrite === true,
    ...(typeof record.audit_path === 'string' ? { auditPath: record.audit_path } : {}),
    ...(typeof record.auditPath === 'string' ? { auditPath: record.auditPath } : {}),
  });
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new DomainExpertWorkerError(400, 'invalid_config', 'Expected a positive integer.');
  return parsed;
}

// Zero-tolerant twin of normalizePositiveInteger, for a bound whose documented
// off switch is 0 (the PDF page floor) rather than an absent value.
function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new DomainExpertWorkerError(400, 'invalid_config', 'Expected a non-negative integer.');
  return parsed;
}

function asDomainExpertTool(value: unknown): DomainExpertTool {
  if (
    value === 'domain_agent'
    || value === 'domain_ask'
    || value === 'domain_source'
    || value === 'rag_corpus'
    || value === 'domain_doc'
    || value === 'annas_archive_search'
    || value === 'annas_archive_import'
  ) return value;
  throw new DomainExpertWorkerError(400, 'invalid_tool', 'Unsupported domain expert tool.');
}

function optionalSourceKind(value: unknown): { sourceKind: NonNullable<DomainSourceParams['sourceKind']> } | Record<string, never> {
  if (value === undefined || value === null || value === '') return {};
  const sourceKind = String(value) as NonNullable<DomainSourceParams['sourceKind']>;
  if (!DOMAIN_SOURCE_KINDS.includes(sourceKind)) {
    throw new DomainExpertWorkerError(400, 'invalid_params', 'kind is not a supported domain source kind.');
  }
  return { sourceKind };
}

function optionalAnnasFormat(value: unknown): { format: NonNullable<AnnasArchiveImportParams['format']> } | Record<string, never> {
  if (value === undefined || value === null || value === '') return {};
  const format = String(value) as NonNullable<AnnasArchiveImportParams['format']>;
  if (!ANNAS_ARCHIVE_FORMATS.includes(format)) {
    throw new DomainExpertWorkerError(400, 'invalid_params', 'format is not a supported Anna Archive format.');
  }
  return { format };
}

function optionalAnnasFormatPreference(value: unknown): { formatPreference: NonNullable<AnnasArchiveSearchParams['formatPreference']> } | Record<string, never> {
  if (value === undefined || value === null || value === '') return {};
  const preference = String(value) as NonNullable<AnnasArchiveSearchParams['formatPreference']>;
  if (!['auto', 'text_rag', 'layout'].includes(preference)) {
    throw new DomainExpertWorkerError(400, 'invalid_params', 'format_preference must be auto, text_rag, or layout.');
  }
  return { formatPreference: preference };
}

function optionalStringField<T extends string>(value: unknown, key: T): { [K in T]?: string } {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string') {
    const fieldName = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    throw new DomainExpertWorkerError(400, 'invalid_params', `${fieldName} must be a string.`);
  }
  return { [key]: value } as { [K in T]?: string };
}

function optionalBooleanField<T extends string>(value: unknown, key: T): { [K in T]?: boolean } {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'boolean') return { [key]: value } as { [K in T]?: boolean };
  if (value === 'true' || value === '1' || value === 'yes') return { [key]: true } as { [K in T]?: boolean };
  if (value === 'false' || value === '0' || value === 'no') return { [key]: false } as { [K in T]?: boolean };
  throw new DomainExpertWorkerError(400, 'invalid_params', `${key} must be true or false.`);
}

function optionalTranscriptModeField(value: unknown): { transcriptMode?: NonNullable<RagCorpusParams['transcriptMode']> } {
  if (value === undefined || value === null || value === '') return {};
  const transcriptMode = optionalWebImportTranscriptMode(value);
  return transcriptMode ? { transcriptMode } : {};
}

function optionalNumberField<T extends string>(value: unknown, key: T): { [K in T]?: number } {
  if (value === undefined || value === null || value === '') return {};
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new DomainExpertWorkerError(400, 'invalid_params', `${key} must be a number.`);
  return { [key]: parsed } as { [K in T]?: number };
}

function asStringArray(value: unknown, name: string): string[] {
  if (Array.isArray(value)) return value.map((item) => requireString(item, name));
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  throw new DomainExpertWorkerError(400, 'invalid_params', `${name} must be an array or comma-separated string.`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainExpertWorkerError(400, 'invalid_params', `${name} must be a non-empty string.`);
  }
  return value.trim();
}

function requireApprovalId(value: string | undefined, action: string): string {
  if (!value?.trim()) {
    throw new DomainExpertWorkerError(403, 'approval_required', `${action} requires approval_id.`);
  }
  return value.trim();
}

function requireNumber(value: unknown, name: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) throw new DomainExpertWorkerError(400, 'invalid_params', `${name} must be a number.`);
  return number;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainExpertWorkerError(400, 'invalid_params', `${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed.replace(/\/+$/g, '') : `/${trimmed.replace(/\/+$/g, '')}`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, '');
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
