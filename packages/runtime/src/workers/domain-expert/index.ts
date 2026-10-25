import { execFile } from 'node:child_process';
import { createHash, createSign, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { lstatSync, mkdirSync } from 'node:fs';
import { appendFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { constants as zlibConstants, inflateSync } from 'node:zlib';
import {
  ANNAS_ARCHIVE_FORMATS,
  WEB_IMPORT_TRANSCRIPT_MODE_EFFECT,
  domainManifest,
  domainPolicy,
  domainWorkspaceSeedFiles,
  parseDomainAgentAction,
  planAnnasArchiveImport,
  planAnnasArchiveSearch,
  planDomainAgent,
  requireConfiguredAgent,
} from '../../core/domain-expert.ts';
import type {
  AnnasArchiveFormat,
  AnnasArchiveImportParams,
  AnnasArchiveSearchParams,
  DomainAgentParams,
} from '../../core/domain-expert.ts';
import { AgentRegistrationStore, pageLibraryRootFromEnv, registrationLibraryFromEnv } from '../../core/agent-registration.ts';
import { OperationError } from '../../core/operation-error.ts';
import {
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
  normalizeExtractedText,
  parseMasterManifest,
  parseScopeManifest,
  planReconciliation,
  type ExtractionRequest,
  type ExtractionResult,
  type MaterializationLedger,
  type ReferenceExtractor,
  type Sha256Id,
  type LibraryLocationConfig,
  MEDIA_EXTENSIONS,
  splitFrontmatter,
} from '@expert-agents/library';
import { extractWebMainText } from '@expert-agents/library/web-text';
import {
  agentRoutingConfigFromEnv,
  type AgentRoutingConfig,
  pageLibraryOriginalBuckets,
  pageLibraryMembers,
} from '../../core/agent-routing.ts';
import {
  DISCLOSURE_REFUSAL_CODES,
  DisclosureSessionStore,
  disclosureRefusal,
  resolveDisclosurePolicy,
  type DisclosurePolicy,
  type DisclosureRefusal,
  type DisclosureRefusalCode,
} from '../../core/disclosure.ts';
import { LibraryObjectExistsError, LibraryReadError, libraryObjectsRootFromEnv, LocalLibraryObjects, type LibraryObjectStore } from './library-objects.ts';
import { PageIndex, voyageClient, type VoyageClient } from './page-index.ts';
import { MultiPageStore, type PageLibraryMember } from './page-libraries.ts';
import { PageDisclosureRefusal, runDisclosedPageLibrary } from './page-disclosure.ts';
import { PageLibrary, PageLibraryError, parsePageLibraryParams, type PageSearchHit } from './page-library.ts';
import { DatabasePageStore, TreePageStore, type PageStore } from './page-store.ts';
import { PageIngestError, PageIngestQueue, type IngestSourceInput, type IngestSourceRef, type MaterializedSource, type PageIndexWriter } from './page-ingest.ts';

export const DOMAIN_EXPERT_ENV_EXAMPLE = 'deploy/systemd/domain-expert.env.example';
export const DOMAIN_EXPERT_NOTION_CREDENTIAL_GUIDANCE = `Notion ingest requires EXPERT_AGENTS_DOMAIN_EXPERT_NOTION_TOKEN. Configure it as documented in ${DOMAIN_EXPERT_ENV_EXAMPLE}.`;

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
  fetchImpl?: typeof fetch;
}

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
  google?: DomainExpertGoogleConfig;
  /** Where originals and other library objects live; defaults to a local root when one is set, else Google Cloud Storage. */
  libraryObjects?: LibraryObjectStore;
  /** A local directory holding library objects as `<bucket>/<name>` (EXPERT_AGENTS_DOMAIN_EXPERT_LIBRARY_OBJECTS_ROOT). */
  libraryObjectsRoot?: string;
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
  /** Directory of registered domains' page-library trees; defaults to EXPERT_AGENTS_DOMAIN_EXPERT_PAGE_LIBRARY_ROOT. */
  pageLibraryRoot?: string;
  /** Postgres URL of the page library's search index; defaults to EXPERT_AGENTS_DOMAIN_EXPERT_PAGE_INDEX_DATABASE_URL. */
  pageIndexDatabaseUrl?: string;
  /** Voyage API key for page search embeddings and reranking; defaults to EXPERT_AGENTS_DOMAIN_EXPERT_VOYAGE_API_KEY. */
  voyageApiKey?: string;
  /** Test seam: the fetch Voyage embedding and rerank calls go through. */
  voyageFetch?: typeof fetch;
  /**
   * Postgres URLs of named page-library databases (route `pageLibrary.database`), by name; a name
   * missing here falls back to EXPERT_AGENTS_DOMAIN_EXPERT_PAGE_LIBRARY_DATABASE_URL_<NAME>.
   */
  pageLibraryDatabaseUrls?: Record<string, string>;
  /** The same for ingest: ..._PAGE_LIBRARY_WRITER_DATABASE_URL_<NAME>. */
  pageLibraryWriterDatabaseUrls?: Record<string, string>;
  /** Test seam: replaces the page index search; `database` names the route library's database. */
  pageSearch?: (query: string, k: number, sourceId: string, database?: string) => Promise<PageSearchHit[]>;
  /** Test seam: replaces the page index's per-source status in health. */
  pageIndexStatus?: (sourceId: string, database?: string) => Promise<{ units: number; chunks: number; pending_embeddings: number }>;
  /** Test seam: the store of a page library kept in the database (a route without `root`). */
  pageStore?: (sourceId: string, database?: string) => PageStore;
  /**
   * Postgres URL library_ingest writes the index with; defaults to
   * EXPERT_AGENTS_DOMAIN_EXPERT_PAGE_INDEX_WRITER_DATABASE_URL. Separate from the
   * search URL so the serving role can stay read-only.
   */
  pageIndexWriterDatabaseUrl?: string;
  /** Test seam: replaces the page index writer. */
  pageIndexWriter?: PageIndexWriter;
  /** Test seam: replaces the writer of named databases, by name. */
  pageIndexWriters?: Record<string, PageIndexWriter>;
  /**
   * Local OCR lanes for library_ingest: the model router's OCR profile
   * (DeepSeek-OCR) and its deep profile for escalations and figures. Default
   * from EXPERT_AGENTS_DOMAIN_EXPERT_OCR_ROUTER_URL (…/v1); the deep profile is
   * off when EXPERT_AGENTS_DOMAIN_EXPERT_OCR_DEEP_LANE is "off".
   */
  ocrLanes?: { routerUrl?: string; deep?: boolean; fetch?: typeof fetch };
}

type ResolveHostImpl = (hostname: string) => Promise<string[]>;
type WebImportFetchImpl = (url: URL, options: {
  signal: AbortSignal;
  validatedAddresses: readonly string[];
}) => Promise<Response>;

type DomainExpertTool =
  | 'domain_agent'
  | 'domain_library'
  | 'library_ingest'
  | 'annas_archive_search'
  | 'annas_archive_import';

interface DomainExpertRequest {
  tool: DomainExpertTool;
  params: Record<string, unknown>;
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

const DEFAULT_SCOPES = [
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
const UPSTREAM_JSON_MAX_BYTES = 8 * 1024 * 1024;
const UPSTREAM_HTML_MAX_BYTES = 4 * 1024 * 1024;
const UPSTREAM_ERROR_TEXT_MAX_CHARACTERS = 2_000;
const ANNAS_CANDIDATE_STRING_MAX_CHARACTERS = 1_000;
const DEFAULT_ANNAS_ARCHIVE_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const DEFAULT_ANNAS_BOOKS_ROOT = join(homedir(), 'ExpertAgents', 'Books');
// Book-scale floor. The 2026-07-29 impostor was a 36-page pamphlet wearing a
// 512-page monograph's metadata; genuine monographs run well past 200 pages, so
// 60 catches the pamphlet class with margin while clearing legitimately short
// books. A configured 0 disables the gate.
const DEFAULT_ANNAS_MIN_PDF_PAGES = 60;
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
  private registrationLibrary: LibraryLocationConfig | undefined;
  private google: GoogleRuntimeClient;
  private objects: LibraryObjectStore;
  private pageLibraries = new Map<string, PageLibrary>();
  private pageIndexDatabaseUrl: string | undefined;
  private voyageApiKey: string | undefined;
  private pageIndex: PageIndex | undefined;
  private namedPageIndexes = new Map<string, PageIndex>();
  private pageLibraryDatabaseUrls: Record<string, string>;
  private pageSearch: DomainExpertWorkerOptions['pageSearch'];
  private pageIndexStatus: DomainExpertWorkerOptions['pageIndexStatus'];
  private pageStoreOverride: DomainExpertWorkerOptions['pageStore'];
  private voyageFetch: typeof fetch | undefined;
  private pageIngest!: PageIngestQueue;
  private annas: DomainExpertAnnasConfig;
  private annasBooksRoot: string;
  private annasMaxDownloadBytes: number;
  private annasMinPdfPages: number;
  private notion: NotionRuntimeClient;
  private dataDir: string;
  private fetchImpl: typeof fetch;
  private webImportFetchImpl: WebImportFetchImpl;
  private webImportFetchTimeoutMs: number;
  private annasDownloadTimeoutMs: number;
  // Member session for Anna Archive HTML search. Held in memory only, never
  // returned, logged, or written to the audit trail.
  private annasMemberSession?: AnnasMemberSession;
  private annasMemberSignIn?: Promise<AnnasMemberSession | undefined>;
  private annasMemberSignInBlockedUntil = 0;
  private resolveHostImpl: ResolveHostImpl;
  private ytDlpBin?: string;
  private summarizeBin: string;
  private summarizeExtract: ReferenceExtractor;
  private disclosureSessions = new DisclosureSessionStore(DISCLOSURE_SESSION_CACHE_LIMIT);

  constructor(options: DomainExpertWorkerOptions = {}) {
    this.roots = new Map((options.roots ?? []).map((root) => [root.rootId, normalizeRoot(root)]));
    this.agentRouting = options.agentRouting ?? agentRoutingConfigFromEnv();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webImportFetchImpl = options.webImportFetchImpl
      ?? (options.fetchImpl ? webImportFetchFromFetchImpl(options.fetchImpl) : defaultWebImportFetch);
    this.webImportFetchTimeoutMs = normalizePositiveInteger(options.webImportFetchTimeoutMs, WEB_IMPORT_FETCH_TIMEOUT_MS);
    this.annasDownloadTimeoutMs = normalizePositiveInteger(options.annasDownloadTimeoutMs, ANNAS_ARCHIVE_DOWNLOAD_TIMEOUT_MS);
    this.google = new GoogleRuntimeClient({
      ...(options.google ?? {}),
      fetchImpl: options.google?.fetchImpl ?? options.fetchImpl ?? fetch,
    });
    const objectsRoot = options.libraryObjectsRoot ?? libraryObjectsRootFromEnv();
    this.objects = options.libraryObjects ?? (objectsRoot ? new LocalLibraryObjects(objectsRoot) : this.google);
    this.pageIndexDatabaseUrl = options.pageIndexDatabaseUrl ?? process.env.EXPERT_AGENTS_DOMAIN_EXPERT_PAGE_INDEX_DATABASE_URL;
    this.voyageApiKey = options.voyageApiKey ?? process.env.EXPERT_AGENTS_DOMAIN_EXPERT_VOYAGE_API_KEY;
    this.pageLibraryDatabaseUrls = options.pageLibraryDatabaseUrls ?? {};
    this.pageSearch = options.pageSearch;
    this.pageIndexStatus = options.pageIndexStatus;
    this.pageStoreOverride = options.pageStore;
    this.voyageFetch = options.voyageFetch;
    this.annas = options.annas ?? {};
    this.annasBooksRoot = options.annas?.booksRoot ?? DEFAULT_ANNAS_BOOKS_ROOT;
    this.annasMaxDownloadBytes = normalizePositiveInteger(options.annas?.maxDownloadBytes, DEFAULT_ANNAS_ARCHIVE_MAX_DOWNLOAD_BYTES);
    this.annasMinPdfPages = normalizeNonNegativeInteger(options.annas?.minPdfPages, DEFAULT_ANNAS_MIN_PDF_PAGES);
    this.notion = new NotionRuntimeClient({
      ...(options.notion ?? {}),
      fetchImpl: options.notion?.fetchImpl ?? options.fetchImpl ?? fetch,
    });
    this.dataDir = options.dataDir ?? join(tmpdir(), `expert-agents-domain-expert-${currentUid()}`);
    ensurePrivateDataDirectory(this.dataDir);
    this.registrationLibrary = options.registrationLibrary ?? registrationLibraryFromEnv();
    this.registrations = new AgentRegistrationStore(this.dataDir, this.agentRouting, this.registrationLibrary, options.pageLibraryRoot ?? pageLibraryRootFromEnv());
    this.agentRouting = this.registrations.routes();
    this.pageIngest = this.createPageIngest(options);
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
    const googleStatus = await this.google.configurationStatus();
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
      page_library: await this.pageLibraryStatus(),
      configuration_status: {
        google: googleStatus,
      },
      roots: [...this.roots.values()].map((root) => ({
        root_id: root.rootId,
        max_write_bytes: root.maxWriteBytes,
        allow_overwrite: root.allowOverwrite,
      })),
      policy: domainPolicy(),
    };
  }

  /**
   * Whether each page-library domain can serve and ingest: its tree's catalog,
   * what the search index holds for it, and the lanes ingest reads pages with.
   * One bounded count per domain; nothing is searched or embedded.
   */
  private async pageLibraryStatus(): Promise<Record<string, unknown>> {
    const routes = Object.entries(this.agentRouting).filter(([, route]) => route.pageLibrary);
    const lanes = this.pageIngest.lanes();
    const index = Boolean(this.pageSearch || (this.pageIndexDatabaseUrl && this.voyageApiKey));
    const configured = {
      index,
      writer: this.pageIngestWriterConfigured(),
      ocr_lane: lanes.deepseek_ocr,
      vision_lane: lanes.vision,
      originals: this.objects instanceof LocalLibraryObjects ? 'local' : 'google',
    };
    if (routes.length === 0) return { status: 'not_configured', domains: [], configured };
    const issues: Array<{ code: string; domain_id?: string; message: string }> = [];
    if (!index) issues.push({ code: 'page_search_not_configured', message: 'The page index URL or the Voyage key is not set: domain_library search fails.' });
    if (!configured.writer) issues.push({ code: 'page_ingest_writer_not_configured', message: 'The index writer URL is not set: library_ingest cannot start.' });
    if (!configured.ocr_lane) issues.push({ code: 'ocr_not_configured', message: 'No OCR lane (EXPERT_AGENTS_DOMAIN_EXPERT_OCR_ROUTER_URL): pages without a text layer are listed as failed.' });
    if (this.objects instanceof LocalLibraryObjects && !(await stat(this.objects.root).then((info) => info.isDirectory(), () => false))) {
      issues.push({ code: 'library_objects_unavailable', message: 'The local library-object root is not a readable directory: originals cannot be stored or opened.' });
    }
    if (!configured.vision_lane) issues.push({ code: 'vision_not_configured', message: 'The deep vision profile is off: hard pages keep their OCR reading and figures stay undescribed; both are listed.' });
    const statusFor = (database?: string) => this.pageIndexStatus ?? (this.voyageApiKey && this.pageIndexUrl(database)
      ? (sourceId: string, _database?: string) => this.pageIndexFor(database).sourceStatus(sourceId)
      : undefined);
    const domains = [];
    for (const [domainId, route] of routes) {
      const config = route.pageLibrary!;
      const libraries: Array<{ source_id: string; database: string; catalog: 'ready' | 'empty' | 'unreadable'; books: number }> = [];
      const primary: { catalog: 'ready' | 'empty' | 'unreadable'; books: number; indexStatus: Record<string, unknown> } = { catalog: 'empty', books: 0, indexStatus: { status: 'not_configured' } };
      for (const [i, member] of pageLibraryMembers(config).entries()) {
        let catalog: 'ready' | 'empty' | 'unreadable' = 'empty';
        let books = 0;
        try {
          books = (await withTimeout(this.pageStoreFor({ ...(i === 0 && config.root ? { root: config.root } : {}), ...member }).catalog(), PAGE_INDEX_HEALTH_TIMEOUT_MS)).length;
          catalog = books > 0 ? 'ready' : 'empty';
        } catch {
          catalog = 'unreadable';
        }
        if (catalog === 'unreadable') issues.push({ code: 'page_library_unavailable', domain_id: domainId, message: 'The page library catalog is not readable.' });
        let indexStatus: Record<string, unknown> = { status: 'not_configured' };
        const statusOf = statusFor(member.database);
        if (statusOf) {
          try {
            const counts = await withTimeout(statusOf(member.sourceId, member.database), PAGE_INDEX_HEALTH_TIMEOUT_MS);
            indexStatus = { status: 'ready', ...counts };
            if (counts.pending_embeddings > 0) issues.push({ code: 'page_embeddings_pending', domain_id: domainId, message: `${counts.pending_embeddings} chunks have no vector yet: semantic search misses them until they are embedded.` });
            if (books > 0 && counts.units === 0) issues.push({ code: 'page_index_empty', domain_id: domainId, message: 'The catalog lists books but the index holds none of them: search finds nothing.' });
          } catch {
            indexStatus = { status: 'unreachable' };
            issues.push({ code: 'page_search_unavailable', domain_id: domainId, message: 'The page index did not answer.' });
          }
        }
        libraries.push({ source_id: member.sourceId, database: member.database ?? 'default', catalog, books });
        if (i === 0) Object.assign(primary, { catalog, books, indexStatus });
      }
      domains.push({ domain_id: domainId, source_id: config.sourceId, store: config.root ? 'tree' : 'database', catalog: primary.catalog, books: primary.books, index: primary.indexStatus, disclosure: Boolean(route.disclosure), libraries });
    }
    return { status: issues.length ? 'degraded' : 'ready', configured, domains, ...(issues.length ? { issues } : {}) };
  }

  private manifest(domainId?: string, displayName?: string): ReturnType<typeof domainManifest> {
    const manifest = domainManifest(domainId, displayName, { agentRouting: this.agentRouting });
    // A routed domain may also write and import its own acquisitions. A registered domain's
    // library is its own subtree, which can never contain the deployment's shared import prefix
    // (2026-10-16: the first factory domain could download a book but not ingest it).
    const acquisitions = manifest.routing.configured ? this.acquisitionDirectory(manifest.domain_id) : undefined;
    if (!acquisitions || gcsPrefixesCover(manifest.allowed_gcs_prefixes, acquisitions.uri) || this.acquisitionDirectoryConflicts(acquisitions.uri)) return manifest;
    return { ...manifest, allowed_gcs_prefixes: [...manifest.allowed_gcs_prefixes, acquisitions.uri] };
  }

  // A domain is granted its acquisition directory only while that directory holds no library: an
  // import prefix above other libraries (for example a bucket's top level) would otherwise give a
  // domain whose id names one of them that whole subtree. Every route's library and read-only
  // roots and the registration library count, including the domain's own library.
  private acquisitionDirectoryConflicts(uri: string): boolean {
    const locations = [
      ...Object.values(this.agentRouting).flatMap((route) => [...(route.library ? [route.library] : []), ...(route.readOnlySourceRoots ?? [])]),
      ...(this.registrationLibrary ? [this.registrationLibrary] : []),
    ];
    return locations.some((location) => gcsPrefixesCover([uri], `gs://${location.bucket}/${location.prefix}`));
  }

  // The domain's own directory under the operator's shared acquisition import prefix. Objects
  // already imported there keep their names, so re-acquisitions still find them. Undefined when
  // acquisition imports are not configured or the configured prefix is invalid.
  private acquisitionDirectory(domainId: string): { bucket: string; prefix: string; uri: string } | undefined {
    if (!this.annas.importGcsPrefix) return undefined;
    let parsed: { bucket: string; prefix: string };
    try { parsed = parseGcsPrefix(this.annas.importGcsPrefix); } catch { return undefined; }
    const prefix = `${parsed.prefix}${domainId}`;
    return { bucket: parsed.bucket, prefix, uri: `gs://${parsed.bucket}/${prefix}` };
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

  async run(request: DomainExpertRequest): Promise<unknown> {
    this.agentRouting = this.registrations.routes();
    switch (request.tool) {
      case 'domain_agent':
        return this.domainAgent(parseDomainAgentParams(request.params));
      case 'domain_library':
        return this.domainLibrary(request.params);
      case 'library_ingest':
        return this.libraryIngest(request.params);
      case 'annas_archive_search':
        return this.annasSearch(parseAnnasArchiveSearchParams(request.params));
      case 'annas_archive_import':
        return this.annasImport(parseAnnasArchiveImportParams(request.params));
      default:
        throw new DomainExpertWorkerError(400, 'invalid_tool', 'Unsupported domain expert tool.');
    }
  }

  /**
   * The page library tool belt (docs/page-library.md). Refused for a domain
   * without a pageLibrary route block. A route with a disclosure policy serves
   * it under that policy's bounds, per book and per session
   * (page-disclosure.ts).
   */
  private async domainLibrary(params: Record<string, unknown>): Promise<unknown> {
    try {
      const parsed = parsePageLibraryParams(params);
      const manifest = this.manifest(optionalStringField(params.domain_id, 'domainId').domainId);
      requireConfiguredAgent(manifest, 'domain_library');
      const route = this.agentRouting[manifest.domain_id]!;
      if (!route.pageLibrary) throw new PageLibraryError('page_library_not_configured', 'This domain has no page library.', 404);
      const config = route.pageLibrary;
      const members = pageLibraryMembers(config);
      const key = `${manifest.domain_id}\u0000${config.root ?? ''}\u0000${members.map((m) => `${m.database ?? ''}:${m.sourceId}`).join(',')}`;
      let library = this.pageLibraries.get(key);
      if (!library) {
        // One search and one store per library; several are read as one (page-libraries.ts).
        const parts: PageLibraryMember[] = members.map((m, i) => ({
          ...m,
          search: this.pageSearchFor(m.database, m.sourceId),
          store: this.pageStoreFor({ ...(i === 0 && config.root ? { root: config.root } : {}), ...m }),
        }));
        const multi = parts.length > 1 ? new MultiPageStore(parts) : undefined;
        library = new PageLibrary(
          // The domain's acquisition directory holds originals library_ingest stored for it.
          { sourceId: config.sourceId, originalBuckets: [...new Set([...pageLibraryOriginalBuckets(route), ...(this.acquisitionDirectory(manifest.domain_id) ? [this.acquisitionDirectory(manifest.domain_id)!.bucket] : [])])] },
          {
            search: multi ? (query, k) => multi.search(query, k) : (query, k) => parts[0]!.search(query, k),
            store: multi ?? parts[0]!.store,
            download: (bucket, name, maxBytes, timeoutMs) => this.objects.downloadLibraryObject(bucket, name, maxBytes, timeoutMs),
          },
        );
        this.pageLibraries.set(key, library);
      }
      const policy = this.disclosurePolicyFor(manifest.domain_id);
      const body = policy
        ? await runDisclosedPageLibrary(
          library,
          parsed,
          policy,
          this.disclosureSessions.ledgerFor(`${manifest.domain_id}\u0000${requireDisclosureSessionId(typeof params.session_id === 'string' ? params.session_id : undefined)}`),
          config.sourceId,
        )
        : await library.run(parsed);
      return { kind: 'domain_library_result', domain_id: manifest.domain_id, action: parsed.action, ...body, policy: domainPolicy() };
    } catch (error) {
      if (error instanceof PageDisclosureRefusal) throw disclosureErrorFrom(error.refusal);
      if (error instanceof PageLibraryError) throw new DomainExpertWorkerError(error.status, error.code, error.message);
      throw error;
    }
  }

  private voyage(): VoyageClient {
    return voyageClient(this.voyageApiKey!, this.voyageFetch ? { fetch: this.voyageFetch } : {});
  }

  /** The configured Postgres URL of the default or a named page-library database (reader). */
  private pageIndexUrl(database?: string): string | undefined {
    if (database === undefined) return this.pageIndexDatabaseUrl;
    return this.pageLibraryDatabaseUrls[database] ?? (process.env[pageLibraryEnvName('DATABASE_URL', database)] || undefined);
  }

  /** The search index of the default or a named database, opened on first use and kept. */
  private pageIndexFor(database?: string): PageIndex {
    const url = this.pageIndexUrl(database);
    if (!url || !this.voyageApiKey) throw new PageLibraryError('page_search_not_configured', 'The page library database is not configured.', 503);
    if (database === undefined) return this.pageIndex ??= new PageIndex(url, this.voyage());
    let index = this.namedPageIndexes.get(database);
    if (!index) { index = new PageIndex(url, this.voyage()); this.namedPageIndexes.set(database, index); }
    return index;
  }

  private pageSearchFor(database: string | undefined, sourceId: string): (query: string, k: number) => Promise<PageSearchHit[]> {
    const seam = this.pageSearch;
    if (seam) return (query, k) => seam(query, k, sourceId, database);
    if (!this.pageIndexUrl(database) || !this.voyageApiKey) {
      throw new PageLibraryError('page_search_not_configured', 'The page search index is not configured.', 503);
    }
    const index = this.pageIndexFor(database);
    return async (query, k) => {
      try { return await index.search(sourceId, query, k); }
      catch (error) {
        if (error instanceof PageLibraryError) throw error;
        throw new PageLibraryError('page_search_unavailable', 'The page search index could not run the query.', 503);
      }
    };
  }

  /**
   * Where a library's catalog and units are read: its tree when it names a root, else the page
   * library database (the default or the named one) through the serving (read-only) URL.
   */
  private pageStoreFor(config: { root?: string; sourceId: string; database?: string }): PageStore {
    if (config.root) return new TreePageStore(config.root);
    if (this.pageStoreOverride) return this.pageStoreOverride(config.sourceId, config.database);
    return new DatabasePageStore(this.pageIndexFor(config.database).sql, config.sourceId);
  }

  private createPageIngest(options: DomainExpertWorkerOptions): PageIngestQueue {
    const lanesConfig = {
      routerUrl: options.ocrLanes?.routerUrl ?? (process.env.EXPERT_AGENTS_DOMAIN_EXPERT_OCR_ROUTER_URL?.trim() || undefined),
      deep: options.ocrLanes?.deep ?? process.env.EXPERT_AGENTS_DOMAIN_EXPERT_OCR_DEEP_LANE?.trim() !== 'off',
    };
    const writerUrlOf = (database?: string): string | undefined => database === undefined
      ? options.pageIndexWriterDatabaseUrl ?? process.env.EXPERT_AGENTS_DOMAIN_EXPERT_PAGE_INDEX_WRITER_DATABASE_URL
      : options.pageLibraryWriterDatabaseUrls?.[database] ?? (process.env[pageLibraryEnvName('WRITER_DATABASE_URL', database)] || undefined);
    // One writer per database, opened on first use; '' is the default database.
    const writers = new Map<string, PageIndexWriter>();
    const seamWriter = (database?: string) => database === undefined ? options.pageIndexWriter : options.pageIndexWriters?.[database];
    const queue = new PageIngestQueue({
      stateDir: join(this.dataDir, 'page-ingest'),
      ...(lanesConfig.routerUrl ? { lanes: {
        routerUrl: lanesConfig.routerUrl,
        deep: lanesConfig.deep,
        ...(options.ocrLanes?.fetch ? { fetch: options.ocrLanes.fetch } : {}),
      } } : {}),
      writer: (database) => {
        const cached = writers.get(database ?? '') ?? seamWriter(database);
        if (cached) return cached;
        const writerUrl = writerUrlOf(database);
        if (!writerUrl || !this.voyageApiKey) throw new PageIngestError('page_ingest_writer_not_configured', 'The page index writer is not configured.', 503);
        const index = new PageIndex(writerUrl, this.voyage(), { maxConnections: 4 });
        const writer: PageIndexWriter = {
          importUnits: (s, u, o) => index.importUnits(s, u, o), embedPending: (s) => index.embedPending(s), pendingEmbeddings: (s) => index.pendingEmbeddings(s),
          catalog: (s) => index.catalog(s), replaceBooks: (s, e, o) => index.replaceBooks(s, e, o),
        };
        writers.set(database ?? '', writer);
        return writer;
      },
      materialize: (domainId, ref, dir) => this.materializeIngestRef(domainId, ref, dir),
      changed: (domainId, library) => {
        for (const key of [...this.pageLibraries.keys()]) if (key.startsWith(`${domainId}\u0000`)) this.pageLibraries.delete(key);
        (library.database === undefined ? this.pageIndex : this.namedPageIndexes.get(library.database))?.invalidate(library.sourceId);
      },
      log: (record) => console.info(JSON.stringify(record)),
    });
    this.pageIngestWriterConfigured = (database) => Boolean(writers.get(database ?? '') || seamWriter(database) || (writerUrlOf(database) && this.voyageApiKey));
    void queue.resume().catch((error: unknown) => console.warn(JSON.stringify({ kind: 'page_ingest_resume_failed', error: String(error).slice(0, 200) })));
    return queue;
  }

  private pageIngestWriterConfigured: (database?: string) => boolean = () => false;

  /**
   * library_ingest: add workspace files or library originals to a domain's page library
   * (page-ingest.ts). Every original gets a gs:// home view_page can render from: a library
   * object keeps its own; a workspace file is stored in the domain's acquisition directory.
   */
  private async libraryIngest(params: Record<string, unknown>): Promise<unknown> {
    const allowed = ['domain_id', 'action', 'source_id', 'workspace_relative_path', 'gcs_uri', 'urls', 'notion', 'title', 'creator', 'job_id', 'dry_run', 'approval_id'];
    const extra = Object.keys(params).filter((key) => !allowed.includes(key));
    if (extra.length) throw new DomainExpertWorkerError(400, 'invalid_params', `library_ingest does not take: ${extra.join(', ')}.`);
    const action = params.action;
    if (action !== 'start' && action !== 'status' && action !== 'list') throw new DomainExpertWorkerError(400, 'invalid_params', 'action must be start, status or list.');
    const manifest = this.manifest(optionalStringField(params.domain_id, 'domainId').domainId);
    requireConfiguredAgent(manifest, 'library_ingest');
    const route = this.agentRouting[manifest.domain_id]!;
    if (!route.pageLibrary) throw new DomainExpertWorkerError(404, 'page_library_not_configured', 'This domain has no page library.');
    if (route.disclosure) throw new DomainExpertWorkerError(403, 'page_ingest_not_disclosable', 'This deployment serves under a disclosure policy; ingest into its library from the owner deployment.');
    const result = (body: Record<string, unknown>) => ({ kind: 'library_ingest_result', domain_id: manifest.domain_id, action, ...body, policy: domainPolicy() });
    try {
      if (action === 'status') return result({ job: await this.pageIngest.get(manifest.domain_id, requireString(params.job_id, 'job_id')) });
      if (action === 'list') return result({ jobs: await this.pageIngest.list(manifest.domain_id) });
    } catch (error) {
      if (error instanceof PageIngestError) throw new DomainExpertWorkerError(error.status, error.code, error.message);
      throw error;
    }

    // Which library the job writes: required when the route reads several, so nothing lands in one by omission.
    const target = this.pageIngestTarget(manifest.domain_id, params.source_id === undefined ? undefined : requireString(params.source_id, 'source_id'));
    const workspacePath = params.workspace_relative_path === undefined ? undefined : requireString(params.workspace_relative_path, 'workspace_relative_path');
    const gcsUri = params.gcs_uri === undefined ? undefined : requireString(params.gcs_uri, 'gcs_uri');
    const given = ['workspace_relative_path', 'gcs_uri', 'urls', 'notion'].filter((key) => params[key] !== undefined);
    if (given.length !== 1) throw new DomainExpertWorkerError(400, 'invalid_params', 'start takes exactly one of workspace_relative_path, gcs_uri, urls or notion.');
    const title = params.title === undefined ? undefined : requireString(params.title, 'title');
    const creator = params.creator === undefined ? undefined : requireString(params.creator, 'creator');
    const dryRun = params.dry_run === undefined ? true : params.dry_run === true;
    const acquisitions = this.acquisitionDirectory(manifest.domain_id);

    // Web pages and Notion pages are fetched by the job itself, so start answers at once.
    if (!workspacePath && !gcsUri) {
      const refs = await this.pageIngestRefs(given[0]!, params[given[0]!]);
      if ((title || creator) && refs.length > 1) throw new DomainExpertWorkerError(400, 'invalid_params', 'title and creator name one source; ingest several without them.');
      const plan = {
        sources: refs.map((r) => ({ name: r.name, type: r.ref.type, ...(r.origin ? { origin: r.origin } : {}) })),
        skipped: [],
        lanes: this.pageIngest.lanes(),
        ...(route.pageLibrary.also ? { source_id: target.sourceId } : {}),
        index_writer_configured: this.pageIngestWriterConfigured(target.database),
      };
      if (dryRun) return result({ status: 'dry_run', ...plan });
      requireApprovalId(typeof params.approval_id === 'string' ? params.approval_id : undefined, 'library_ingest start');
      if (!this.pageIngestWriterConfigured(target.database)) throw new DomainExpertWorkerError(503, 'page_ingest_writer_not_configured', 'The page index writer is not configured.');
      try {
        const job = await this.pageIngest.enqueue(manifest.domain_id, target, refs.map((r) => ({
          name: r.name, ref: r.ref, ...(r.origin ? { origin: r.origin } : {}), ...(title ? { title } : {}), ...(creator ? { creator } : {}),
        })));
        return result({ status: 'queued', job, lanes: plan.lanes, skipped: [] });
      } catch (error) {
        if (error instanceof PageIngestError) throw new DomainExpertWorkerError(error.status, error.code, error.message);
        throw error;
      }
    }

    type Candidate = { name: string; bytes: number; read: () => Promise<Uint8Array>; uri?: string };
    const candidates: Candidate[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    if (workspacePath) {
      const rootPath = await checkedRootPath(this.rootFor(manifest.workspace_root_id));
      for (const file of await collectStageImportFiles(rootPath, resolveInside(rootPath, workspacePath))) {
        const ext = extname(file.absolutePath).toLowerCase();
        if (isJunkStageImportPath(file.workspaceRelativePath)) continue;
        if (!PAGE_INGEST_EXTENSIONS.has(ext)) { skipped.push({ path: file.workspaceRelativePath, reason: 'unsupported_type' }); continue; }
        if (file.bytes > PAGE_INGEST_MAX_BYTES) { skipped.push({ path: file.workspaceRelativePath, reason: 'too_large' }); continue; }
        candidates.push({ name: basename(file.absolutePath), bytes: file.bytes, read: async () => new Uint8Array(await readFile(file.absolutePath)) });
      }
    } else {
      const readable = [route.library, ...(route.readOnlySourceRoots ?? [])].filter((r): r is NonNullable<typeof r> => Boolean(r))
        .map((r) => `gs://${r.bucket}/${r.prefix}`).concat(acquisitions ? [acquisitions.uri] : []);
      if (gcsUri!.slice(5).split('/').some((segment) => segment === '.' || segment === '..') || !gcsPrefixesCover(readable, gcsUri!)) {
        throw new DomainExpertWorkerError(403, 'gcs_source_not_allowed', 'gcs_uri must be an object in this domain\'s library or acquisition directory.');
      }
      const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(gcsUri!);
      if (!m) throw new DomainExpertWorkerError(400, 'invalid_params', 'gcs_uri must be gs://<bucket>/<object>.');
      candidates.push({ name: basename(m[2]!), bytes: 0, uri: gcsUri!, read: async () => {
        const bytes = await this.objects.downloadLibraryObject(m[1]!, m[2]!, PAGE_INGEST_MAX_BYTES, 120_000);
        if (!bytes) throw new DomainExpertWorkerError(404, 'gcs_source_not_found', 'The gcs_uri object does not exist.');
        return bytes;
      } });
    }
    if (!candidates.length) throw new DomainExpertWorkerError(400, 'page_ingest_no_sources', 'No PDF, EPUB, Markdown, text, audio or video file was found to ingest.');
    if ((title || creator) && candidates.length > 1) throw new DomainExpertWorkerError(400, 'invalid_params', 'title and creator name one source; ingest a folder without them.');
    const plan = {
      sources: candidates.map((c) => ({ name: c.name, ...(c.bytes ? { bytes: c.bytes } : {}), ...(c.uri ? { gcs_uri: c.uri } : {}) })),
      skipped,
      lanes: this.pageIngest.lanes(),
      ...(this.agentRouting[manifest.domain_id]!.pageLibrary!.also ? { source_id: target.sourceId } : {}),
      index_writer_configured: this.pageIngestWriterConfigured(target.database),
    };
    if (dryRun) return result({ status: 'dry_run', ...plan });
    requireApprovalId(typeof params.approval_id === 'string' ? params.approval_id : undefined, 'library_ingest start');
    if (!this.pageIngestWriterConfigured(target.database)) throw new DomainExpertWorkerError(503, 'page_ingest_writer_not_configured', 'The page index writer is not configured.');
    const job = await this.enqueuePageIngest(manifest, candidates.map((c) => ({
      name: c.name, read: c.read, ...(c.uri ? { uri: c.uri } : {}), ...(title ? { title } : {}), ...(creator ? { creator } : {}),
    })), target);
    return result({ status: 'queued', job, lanes: plan.lanes, skipped });
  }

  /**
   * The library an ingest writes: the route's only one, or the one `sourceId` names among
   * several (then it is required). A route reading a named database writes through that
   * database's writer.
   */
  private pageIngestTarget(domainId: string, sourceId: string | undefined): { root?: string; sourceId: string; database?: string } {
    const config = this.agentRouting[domainId]?.pageLibrary;
    if (!config) throw new DomainExpertWorkerError(404, 'page_library_not_configured', 'This domain has no page library.');
    const members = pageLibraryMembers(config);
    if (members.length > 1 && sourceId === undefined) {
      throw new DomainExpertWorkerError(400, 'page_ingest_source_required', `This route reads ${members.length} page libraries; name the one to write with source_id: ${[...new Set(members.map((m) => m.sourceId))].join(', ')}.`);
    }
    const matches = members.map((m, i) => ({ m, i })).filter(({ m }) => sourceId === undefined || m.sourceId === sourceId);
    if (!matches.length) {
      throw new DomainExpertWorkerError(400, 'page_ingest_source_unknown', `source_id is not one of this route's libraries: ${[...new Set(members.map((m) => m.sourceId))].join(', ')}.`);
    }
    if (matches.length > 1) throw new DomainExpertWorkerError(400, 'page_ingest_source_ambiguous', 'More than one of this route\'s libraries has that source_id; give each library its own source id to ingest into it.');
    const { m, i } = matches[0]!;
    return { ...(i === 0 && config.root ? { root: config.root } : {}), ...m };
  }

  /**
   * Store each original where view_page can render it (a library object keeps its own URI; other
   * bytes go to the domain's acquisition directory, content-addressed), copy it for the job, and
   * queue the job.
   */
  private async enqueuePageIngest(
    manifest: ReturnType<typeof domainManifest>,
    sources: Array<{ name: string; read: () => Promise<Uint8Array>; uri?: string; title?: string; creator?: string }>,
    target: { root?: string; sourceId: string; database?: string },
  ): Promise<unknown> {
    const route = this.agentRouting[manifest.domain_id]!;
    if (!route.pageLibrary) throw new DomainExpertWorkerError(404, 'page_library_not_configured', 'This domain has no page library.');
    if (!this.pageIngestWriterConfigured(target.database)) throw new DomainExpertWorkerError(503, 'page_ingest_writer_not_configured', 'The page index writer is not configured.');
    const acquisitions = this.acquisitionDirectory(manifest.domain_id);
    if (sources.some((c) => !c.uri) && !acquisitions) {
      throw new DomainExpertWorkerError(503, 'page_ingest_no_original_store', 'No acquisition directory is configured for this domain, so the original has nowhere to be stored for view_page.');
    }
    const scratch = await this.pageIngest.scratch(manifest.domain_id);
    const inputs: IngestSourceInput[] = [];
    for (const [i, c] of sources.entries()) {
      // One original in memory at a time.
      const bytes = await c.read();
      const hex = createHash('sha256').update(bytes).digest('hex');
      const ext = extname(c.name).toLowerCase() || '.bin';
      const file = join(scratch, `${i}-${hex.slice(0, 16)}${ext}`);
      await writeFile(file, bytes, { mode: 0o600 });
      const uri = c.uri ?? await this.storeIngestOriginal(manifest, bytes, ext);
      inputs.push({ name: c.name, uri, file, ...(c.title ? { title: c.title } : {}), ...(c.creator ? { creator: c.creator } : {}) });
    }
    try {
      return await this.pageIngest.enqueue(manifest.domain_id, target, inputs);
    } catch (error) {
      if (error instanceof PageIngestError) throw new DomainExpertWorkerError(error.status, error.code, error.message);
      throw error;
    }
  }

  /** Store an original in the domain's acquisition directory, content-addressed, where view_page can render it. */
  private async storeIngestOriginal(manifest: ReturnType<typeof domainManifest>, bytes: Uint8Array, ext: string): Promise<string> {
    const acquisitions = this.acquisitionDirectory(manifest.domain_id);
    if (!acquisitions) throw new PageIngestError('page_ingest_no_original_store', 'No acquisition directory is configured for this domain, so the original has nowhere to be stored for view_page.', 503);
    const hex = createHash('sha256').update(bytes).digest('hex');
    const objectName = `${acquisitions.prefix}/originals/${hex}${ext}`;
    const uri = `gs://${acquisitions.bucket}/${objectName}`;
    assertAllowedGcsDestination(uri, manifest.allowed_gcs_prefixes);
    try { await this.objects.uploadGcsObject(acquisitions.bucket, objectName, bytes, { ifGenerationMatch: '0' }); }
    catch (error) {
      // 412: the same content-addressed original is already stored.
      if (!isCreateOnlyConflict(error)) throw error;
    }
    return uri;
  }

  /**
   * The references a start names, checked before anything is queued: https URLs (web pages,
   * direct files, media, YouTube), Notion pages or databases (a database becomes one source per
   * row page). Notion URLs go through `notion`: their pages are client-rendered.
   */
  private async pageIngestRefs(key: string, value: unknown): Promise<Array<{ name: string; ref: IngestSourceRef; origin?: string }>> {
    const list = (max: number) => {
      if (!Array.isArray(value) || value.length < 1 || value.length > max || !value.every((v) => typeof v === 'string' && v.trim())) {
        throw new DomainExpertWorkerError(400, 'invalid_params', `${key} must be a list of 1 to ${max} strings.`);
      }
      return [...new Set((value as string[]).map((v) => v.trim()))];
    };
    if (key === 'urls') {
      return list(PAGE_INGEST_MAX_REFS).map((url) => {
        let parsed: URL;
        try { parsed = new URL(url); } catch { throw new DomainExpertWorkerError(400, 'invalid_params', 'urls must be absolute https URLs.'); }
        if (parsed.protocol !== 'https:') throw new DomainExpertWorkerError(400, 'web_import_https_required', 'urls must be https.');
        if (isNotionImportUrl(url)) {
          throw new DomainExpertWorkerError(400, 'notion_requires_api_import', 'Notion pages are client-rendered; pass them in notion instead of urls.', 'Use library_ingest start with notion: [<page or database URL or id>].');
        }
        const provenance = webImportProvenanceUrl(url);
        return { name: provenance, ref: { type: 'url', ref: url }, origin: `url:${provenance}` };
      });
    }
    if (!this.notion.configured()) {
      throw new DomainExpertWorkerError(503, 'notion_not_configured', DOMAIN_EXPERT_NOTION_CREDENTIAL_GUIDANCE, 'Configure the Notion credential on the worker host.');
    }
    const out: Array<{ name: string; ref: IngestSourceRef; origin?: string }> = [];
    for (const v of list(this.notion.maxObjects())) {
      const id = notionObjectIdFromUrlOrId(v);
      const object = await this.notion.inspectObject(id);
      let pages = [{ objectId: id, title: object.title }];
      if (object.objectType === 'database') {
        const rows = await this.notion.listDatabasePages(id);
        if (rows.skipped > 0) throw new DomainExpertWorkerError(400, 'invalid_params', `The Notion database "${rows.databaseTitle}" has more than ${this.notion.maxObjects()} pages; ingest its pages in smaller sets.`);
        pages = rows.pages;
      }
      for (const page of pages) {
        if (out.length >= this.notion.maxObjects()) throw new DomainExpertWorkerError(400, 'invalid_params', `notion names more than ${this.notion.maxObjects()} pages; ingest fewer at a time.`);
        out.push({ name: page.title || page.objectId, ref: { type: 'notion', ref: page.objectId }, origin: `notion:${page.objectId}` });
      }
    }
    return out;
  }

  /** Fetch one reference for an ingest job: the job's fetch step (page-ingest.ts). */
  private async materializeIngestRef(domainId: string, ref: IngestSourceRef, dir: string): Promise<MaterializedSource> {
    const manifest = this.manifest(domainId);
    const retrievedAt = new Date().toISOString();
    const write = async (bytes: Uint8Array, ext: string) => {
      const file = join(dir, `${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}${ext}`);
      await writeFile(file, bytes, { mode: 0o600 });
      return file;
    };
    // Text is stored without its front matter, so a page fetched again unchanged is the same object.
    const text = (markdown: string) => {
      const { meta, body } = splitFrontmatter(markdown);
      return { meta, bytes: new TextEncoder().encode(body.trim() + '\n') };
    };
    if (ref.type === 'notion') {
      if (!this.notion.configured()) throw new PageIngestError('notion_not_configured', DOMAIN_EXPERT_NOTION_CREDENTIAL_GUIDANCE, 503);
      const page = await this.notion.fetchPageMarkdown({ id: ref.ref, retrievedAt, blockSeparator: '\n\n' });
      const { bytes } = text(new TextDecoder().decode(page.bytes));
      const sourceUrl = page.sourceUrl ?? `https://www.notion.so/${page.objectId}`;
      return { name: `${safeObjectName(page.title)}.md`, file: await write(bytes, '.md'), uri: sourceUrl, origin: `notion:${page.objectId}`, sourceUrl, retrievedAt, title: page.title };
    }
    // A web page: the web_import fetch (https only, public addresses, size and redirect bounds) and extraction.
    const budget = webImportBudget();
    const derived = await deriveWebImportFiles({
      urls: [ref.ref], includeMedia: true, transcriptMode: 'captions', dryRun: false, fetchedAt: retrievedAt,
      fetch: (url) => guardedWebImportFetch({ url, fetchImpl: this.webImportFetchImpl, resolveHost: this.resolveHostImpl, budget, timeoutMs: this.webImportFetchTimeoutMs }),
      extraction: this.extractionRuntime(),
    });
    const error = derived.errors[0];
    if (error) throw new PageIngestError(error.code, error.suggestion ? `${error.message} ${error.suggestion}` : error.message);
    const file = derived.files[0];
    if (!file) throw new PageIngestError('web_ingest_nothing_extracted', 'Nothing readable was found at this URL.');
    const ext = extname(file.fileName).toLowerCase();
    const base = { origin: `url:${file.sourceUrl}`, sourceUrl: file.finalUrl, retrievedAt };
    if (ext === '.pdf') return { ...base, name: file.fileName, file: await write(file.bytes, ext), uri: await this.storeIngestOriginal(manifest, file.bytes, ext) };
    if (MEDIA_EXTENSIONS.has(ext)) return { ...base, name: file.fileName, file: await write(file.bytes, ext), uri: file.finalUrl };
    if (ext !== '.md' && ext !== '.txt' && ext !== '.markdown') throw new PageIngestError('page_ingest_format_unsupported', `The page library reads web pages, PDF, text, audio and video; this URL is ${ext.slice(1) || 'an unknown type'}.`);
    const t = text(new TextDecoder('utf-8', { fatal: false }).decode(file.bytes));
    return { ...base, name: file.fileName, file: await write(t.bytes, '.md'), uri: file.finalUrl, ...(t.meta.title ? { title: t.meta.title } : {}), ...(t.meta.author || t.meta.channel ? { creator: t.meta.author || t.meta.channel } : {}) };
  }

  /** An acquisition for a page-library domain is stored as its original and queued for ingest. */
  private async annasPageLibraryIngest(
    manifest: ReturnType<typeof domainManifest>,
    params: AnnasArchiveImportParams,
    format: string,
    bytes: Uint8Array,
    sourcePath: string,
    scale: AnnasArtifactScale,
  ): Promise<{ ragIngest: Record<string, unknown>; registry: Record<string, unknown> }> {
    const notStarted = { status: 'skipped', reason: 'The page-library ingest did not start.' };
    if (scale.below_min_pdf_pages && !scale.short_artifact_override) {
      return { ragIngest: { status: 'blocked', target: 'page_library', scale, error: {
        code: 'annas_artifact_scale_implausible',
        message: `Measured ${scale.pages} page(s) in the downloaded ${scale.format}, below the ${scale.min_pdf_pages}-page floor for a book-scale artifact. Nothing was ingested; the file is still on disk.`,
        suggestion: 'Confirm the file is the edition its metadata advertised. To ingest it deliberately anyway, re-run annas_archive_import with allow_short_artifact: true.',
      } }, registry: notStarted };
    }
    if (!PAGE_INGEST_EXTENSIONS.has(`.${format}`)) {
      return { ragIngest: { status: 'blocked', target: 'page_library', error: {
        code: 'page_ingest_format_unsupported',
        message: `The page library reads PDF, EPUB, Markdown and text; this download is ${format}. It is still on disk at ${sourcePath}.`,
        suggestion: 'Acquire a PDF or EPUB edition instead.',
      } }, registry: notStarted };
    }
    try {
      const name = `${basename(sourcePath).replace(/\.[a-z0-9]{1,5}$/i, '')}.${format}`;
      const job = await this.enqueuePageIngest(manifest, [{
        name, read: async () => bytes, ...(params.title ? { title: params.title } : {}), ...(params.author ? { creator: params.author } : {}),
      }], this.pageIngestTarget(manifest.domain_id, params.sourceId)) as { job_id: string; state: string };
      return {
        ragIngest: { status: 'page_ingest_queued', target: 'page_library', job_id: job.job_id, next: 'Check library_ingest status with this job_id.' },
        registry: { status: 'skipped', reason: 'Page-library sources are catalogued by the page library.' },
      };
    } catch (error) {
      return { ragIngest: { status: 'blocked', target: 'page_library', error: ingestErrorRecord(error) }, registry: notStarted };
    }
  }

  /** Test seam: wait for queued ingest jobs. */
  async pageIngestIdle(): Promise<void> { await this.pageIngest.idle(); }

  private async domainAgent(params: DomainAgentParams): Promise<unknown> {
    if (params.action === 'register') {
      const domainId = requireString(params.domainId, 'domain_id');
      const dryRun = params.dryRun ?? true;
      if (!dryRun) requireApprovalId(params.approvalId, 'domain_agent register');
      const registration = {
        ...(params.displayName ? { displayName: params.displayName } : {}),
        library: params.library,
        ...(params.pageLibrary !== undefined ? { pageLibrary: params.pageLibrary } : {}),
      };
      const preview = this.registrations.register(domainId, registration, true);
      const result = dryRun ? preview : this.registrations.register(domainId, registration, false);
      if (!dryRun) this.agentRouting = result.routes;
      return {
        kind: 'domain_agent_registration',
        status: dryRun ? 'dry_run_registration_ready' : result.existing ? 'already_registered' : 'registered',
        domain_id: domainId,
        manifest: domainManifest(domainId, params.displayName, { agentRouting: result.routes }),
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
      const manifestBytes = await this.objects.downloadGcsObject(
        library.bucket,
        `${library.prefix}/manifest/master.json`,
      );
      if (manifestBytes === null) throw new Error('master manifest missing');
      const master = parseMasterManifest(decodeUtf8Bytes(manifestBytes));
      const ledgerBytes = await this.objects.downloadGcsObject(
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
    const scopeManifest = manifest.routing.scope_manifest_path
      ? await inspectConfiguredScopeManifest(manifest.routing.scope_manifest_path)
      : undefined;
    const missingRequirements = seededFiles
      .filter((file) => !file.exists)
      .map(({ relative_path, kind }) => ({ relative_path, kind }));
    const healthIssues: Array<Record<string, unknown>> = [];
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
      ...(scopeManifest ? { scope_manifest: scopeManifest } : {}),
      policy: domainPolicy(),
    };
  }

  /**
   * The subprocess boundary for web ingest. The environment is built twice
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
      const response = await this.annasSearchResponse(url, this.annas.apiKey);
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

  /**
   * Anna Archive serves its HTML search behind a DDoS-Guard browser check for
   * anonymous visitors (2026-09-17 onward) but not for signed-in members. When a
   * search is refused with 403, sign in with the member key and retry with the
   * session cookie; the session is reused until it expires or is refused. A
   * sign-in that does not get search through backs off before the key is sent
   * again, and concurrent refusals share one sign-in.
   */
  private async annasSearchResponse(url: string, apiKey: string): Promise<Response> {
    const attempt = async (session?: AnnasMemberSession) => (await fetchAnnasCredentialed(this.fetchImpl, url, {
      config: this.annas,
      apiKey,
      purpose: 'search',
      ...(session ? { cookie: session.cookie, sensitiveValues: [session.value] } : {}),
    })).response;
    const cached = this.annasMemberSession && this.annasMemberSession.expiresAt > Date.now()
      ? this.annasMemberSession
      : undefined;
    const first = await attempt(cached);
    if (first.ok || first.status !== 403 || Date.now() < this.annasMemberSignInBlockedUntil) return first;
    await first.body?.cancel().catch(() => {});
    const refused = () => new DomainExpertWorkerError(first.status, 'annas_archive_error', 'Anna Archive search failed.');
    if (this.annasMemberSession === cached) this.annasMemberSession = undefined;
    // Another search may already have signed in while this one waited on its refusal.
    if (!this.annasMemberSession) {
      this.annasMemberSignIn ??= annasMemberSignIn(this.fetchImpl, new URL(url).origin, this.annas, apiKey)
        .catch(() => undefined)
        .finally(() => { this.annasMemberSignIn = undefined; });
    }
    const session = this.annasMemberSession ?? await this.annasMemberSignIn;
    if (!session) {
      this.annasMemberSignInBlockedUntil = Date.now() + ANNAS_MEMBER_SIGN_IN_BACKOFF_MS;
      throw refused();
    }
    this.annasMemberSession = session;
    const backOff = () => {
      if (this.annasMemberSession === session) this.annasMemberSession = undefined;
      this.annasMemberSignInBlockedUntil = Date.now() + ANNAS_MEMBER_SIGN_IN_BACKOFF_MS;
    };
    let retried: Response;
    try {
      retried = await attempt(session);
    } catch {
      backOff();
      throw refused();
    }
    if (!retried.ok) backOff();
    return retried;
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
    const toPageLibrary = Boolean(params.ingest && this.agentRouting[manifest.domain_id]?.pageLibrary);
    // A route reading several libraries must say which one gets the book, before anything is downloaded.
    if (toPageLibrary) this.pageIngestTarget(manifest.domain_id, params.sourceId);
    const plan = planAnnasArchiveImport({ ...params, dryRun: true }, manifest);
    if (dryRun) return plan;
    requireApprovalId(params.approvalId, 'annas_archive_import');
    if (!this.annas.apiKey) throw new DomainExpertWorkerError(503, 'annas_archive_not_configured', 'Anna Archive API key is not configured.');
    // The owner naming a book authorizes the download regardless of routing
    // state (the skill's promise: an unrouted domain still downloads). An
    // ingest for a domain without a page library is reported blocked and the
    // download is kept.
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

    const { ragIngest, registry } = toPageLibrary
      ? await this.annasPageLibraryIngest(manifest, params, format, bytes, finalPath.targetPath, scale)
      : params.ingest
      ? annasNoPageLibrary(finalPath.targetPath)
      : { ragIngest: { status: 'not_requested' }, registry: { status: 'skipped', reason: 'rag_ingest was not requested.' } };

    return {
      kind: 'annas_archive_import_result',
      status: annasAcquisitionStatus('downloaded', String(ragIngest.status)),
      domain_id: manifest.domain_id,
      download,
      // Content-free measured scale, so a failed import can be explained by its page count.
      scale,
      rag_ingest: ragIngest,
      registry,
      policy: domainPolicy(),
    };
  }

  // A book already on disk still has to be able to reach the library. Re-ingest takes the
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
    const { ragIngest, registry } = this.agentRouting[manifest.domain_id]?.pageLibrary
      ? await this.annasPageLibraryIngest(manifest, params, format, bytes, duplicate.targetPath, scale)
      : annasNoPageLibrary(duplicate.targetPath);
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
      // Content-free measured scale, so a failed import can be explained by its page count.
      scale,
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

  private rootFor(rootId: string): DomainExpertWorkspaceRootPolicy {
    const root = this.roots.get(rootId);
    if (!root) throw new DomainExpertWorkerError(400, 'unknown_root', 'domain workspace root is not configured.');
    return root;
  }

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
    /** Between top-level blocks; a blank line makes each block its own paragraph. */
    blockSeparator?: string;
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
      body: blocks.join(input.blockSeparator ?? '\n').trim(),
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
        'Notion ingest requires EXPERT_AGENTS_DOMAIN_EXPERT_NOTION_TOKEN.',
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

  async uploadGcsObject(bucket: string, objectName: string, bytes: Uint8Array, options: { ifGenerationMatch?: string } = {}): Promise<unknown> {
    const precondition = options.ifGenerationMatch === undefined ? '' : `&ifGenerationMatch=${encodeURIComponent(options.ifGenerationMatch)}`;
    return this.googleBytes(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}${precondition}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Blob([copyToArrayBuffer(bytes)], { type: 'application/octet-stream' }),
    });
  }

  // The object's first bytes, by a ranged read; null when it does not exist.
  async readGcsObjectHead(bucket: string, objectName: string, length: number): Promise<Uint8Array | null> {
    const response = await this.authedFetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?alt=media`,
      { headers: { Range: `bytes=0-${length - 1}` } },
    );
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) throw googleError(response, await responseTextOrJson(response));
    return new Uint8Array(await response.arrayBuffer()).subarray(0, length);
  }

  async getGcsObjectMetadata(bucket: string, objectName: string): Promise<GcsObjectMetadata | null> {
    const response = await this.authedFetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?fields=generation,size,md5Hash,crc32c`,
    );
    const body = await responseTextOrJson(response);
    if (response.status === 404) return null;
    if (!response.ok) throw googleError(response, body);
    const record = asOptionalRecord(body) ?? {};
    const field = (key: string) => (typeof record[key] === 'string' ? { [key]: record[key] as string } : {});
    return { ...field('generation'), ...field('size'), ...field('md5Hash'), ...field('crc32c') };
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

  async listLibraryObjectNames(bucket: string, prefix: string, timeoutMs: number): Promise<string[]> {
    const names: string[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.authedFetch(
        `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o?prefix=${encodeURIComponent(prefix)}&fields=items(name),nextPageToken${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
        {}, timeoutMs,
      );
      const body = asOptionalRecord(await responseTextOrJson(response)) ?? {};
      if (!response.ok) throw new LibraryReadError('library_read_unavailable', 'The source or library state could not be read or validated.', 502);
      for (const item of Array.isArray(body.items) ? body.items : []) {
        const name = asOptionalRecord(item)?.name;
        if (typeof name === 'string') names.push(name);
      }
      pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : undefined;
    } while (pageToken && names.length < 10_000);
    return names;
  }

  async downloadLibraryObject(bucket: string, objectName: string, maxBytes: number, timeoutMs: number): Promise<Uint8Array | null> {
    const response = await this.authedFetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?alt=media`,
      {}, timeoutMs,
    );
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) {
      await response.body?.cancel();
      throw new LibraryReadError('library_read_unavailable', 'The source or library state could not be read or validated.', 502);
    }
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      throw new LibraryReadError('library_source_too_large', 'The source exceeds the worker read size limit.', 413);
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const signal = upstreamResponseContexts.get(response)!.signal;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await readWebImportChunk(reader, signal);
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new LibraryReadError('library_source_too_large', 'The source exceeds the worker read size limit.', 413);
        chunks.push(value);
      }
      return new Uint8Array(Buffer.concat(chunks, size));
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
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
  if (error.code === 'invalid_page_library_root') return 500;
  if (error.code === 'invalid_params') return 400;
  if (error.code === 'invalid_agent_registration') return 400;
  if (error.code === 'agent_registration_conflict') return 409;
  if (error.code === 'agent_registration_disabled' || error.code === 'agent_registration_library_denied') return 403;
  return 500;
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

// The wire spells the registration's page library snake_case; the store validates the result.
function wirePageLibrary(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { source_id: sourceId, ...rest } = value as Record<string, unknown>;
  return { ...rest, ...(sourceId !== undefined ? { sourceId } : {}) };
}

function parseDomainAgentParams(params: Record<string, unknown>): DomainAgentParams {
  return {
    action: parseDomainAgentAction(params.action),
    ...optionalStringField(params.domain_id, 'domainId'),
    ...optionalStringField(params.display_name, 'displayName'),
    ...optionalBooleanField(params.dry_run, 'dryRun'),
    ...(params.library !== undefined ? { library: params.library } : {}),
    ...(params.page_library !== undefined ? { pageLibrary: wirePageLibrary(params.page_library) } : {}),
    ...optionalStringField(params.approval_id, 'approvalId'),
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
    ...optionalStringField(params.source_id, 'sourceId'),
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
    [`${rootRel}/references/ingest-log.md`, `# Ingest Log\n\nCreated ${new Date().toISOString()}.\n`],
    [`${rootRel}/references/reading-map.md`, `# ${manifest.display_name} Reading Map\n`],
    [`${rootRel}/references/retrieval-craft.md`, retrievalCraftContent()],
    [`${rootRel}/templates/source-card.md`, `# Source Card\n\n- Title:\n- Author:\n- Book:\n- Status:\n- Notes:\n`],
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
    'Use these practices when you call `domain_library`:',
    '',
    '- Start with `catalog` to see which books you hold; name the book (`book`) when you know it.',
    '- `search` with several short, focused queries from different angles; one topic per query.',
    "- When results are weak, search again in the source's own vocabulary, or `grep` for the exact term.",
    '- `read` the unit a hit came from before relying on it, and `read_range` to follow an argument across pages.',
    '- Use `view_page` for figures, tables and diagrams; the text of a page may not describe them.',
    '- Cite every claim with the citation label the tool returned. Never cite or imply support from a passage you did not read.',
    '- When the library is silent, say so and stop; do not answer from memory.',
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
    'Use library_ingest to add approved sources and domain_library for grounded answers with page citations.',
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

async function inspectConfiguredScopeManifest(path: string): Promise<Record<string, unknown>> {
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
    };
  } catch {
    return {
      configured: true,
      present: true,
      parseable: false,
    };
  }
}

const PAGE_INGEST_EXTENSIONS = new Set(['.pdf', '.epub', '.md', '.markdown', '.txt', ...MEDIA_EXTENSIONS]);
// URLs one start may name.
const PAGE_INGEST_MAX_REFS = 50;
const PAGE_INGEST_MAX_BYTES = 300_000_000;
// Health counts each page-library source's index rows; an index that does not answer in this long is unreachable.
const PAGE_INDEX_HEALTH_TIMEOUT_MS = 3_000;

// Spelled out whole so the deploy-env test sees each prefix the env example documents.
const PAGE_LIBRARY_ENV_PREFIX = {
  DATABASE_URL: 'EXPERT_AGENTS_DOMAIN_EXPERT_PAGE_LIBRARY_DATABASE_URL_',
  WRITER_DATABASE_URL: 'EXPERT_AGENTS_DOMAIN_EXPERT_PAGE_LIBRARY_WRITER_DATABASE_URL_',
} as const;

/** The reader or writer URL variable for a named page-library database: the prefix plus <NAME>. */
function pageLibraryEnvName(kind: keyof typeof PAGE_LIBRARY_ENV_PREFIX, database: string): string {
  return PAGE_LIBRARY_ENV_PREFIX[kind] + database.toUpperCase().replace(/-/g, '_');
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); }),
  ]).finally(() => clearTimeout(timer));
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

// GCS answers 412 to a create-only write over an existing object; the local store throws its own error.
function isCreateOnlyConflict(error: unknown): boolean {
  return error instanceof LibraryObjectExistsError || (error instanceof DomainExpertWorkerError && error.status === 412);
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
    cookie?: string;
    sensitiveValues?: string[];
  },
): Promise<{ response: Response; url: string }> {
  let current = requireAllowedAnnasCredentialUrl(rawUrl, options.config, options.purpose);
  for (let redirects = 0; redirects <= ANNAS_ARCHIVE_MAX_REDIRECTS; redirects += 1) {
    const signal = AbortSignal.timeout(ANNAS_ARCHIVE_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(current.toString(), {
        headers: {
          ...annasHeaders(options.apiKey),
          ...(options.cookie ? { Cookie: options.cookie } : {}),
        },
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
      sensitiveValues: [options.apiKey, ...(options.cookie ? [options.cookie] : []), ...(options.sensitiveValues ?? [])],
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

const ANNAS_MEMBER_COOKIE = 'aa_account_id2';
const ANNAS_MEMBER_SESSION_DEFAULT_MS = 24 * 60 * 60 * 1000;
const ANNAS_MEMBER_SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000;
const ANNAS_MEMBER_SIGN_IN_BACKOFF_MS = 10 * 60 * 1000;

interface AnnasMemberSession {
  cookie: string;
  value: string;
  expiresAt: number;
}

/**
 * Signs in to the configured Anna Archive origin the way its account form does
 * (POST /account/ with the member key) and returns the session cookie. The key
 * goes only to an allowed credential origin; nothing here is ever surfaced.
 */
async function annasMemberSignIn(
  fetchImpl: typeof fetch,
  origin: string,
  config: DomainExpertAnnasConfig,
  apiKey: string,
): Promise<AnnasMemberSession | undefined> {
  const url = requireAllowedAnnasCredentialUrl(`${origin}/account/`, config, 'search');
  const signal = AbortSignal.timeout(ANNAS_ARCHIVE_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key: apiKey }).toString(),
      redirect: 'manual',
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw annasRequestTimeoutError();
    throw error;
  }
  await response.body?.cancel().catch(() => {});
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = headers.getSetCookie?.() ?? (headers.get('set-cookie') ? [headers.get('set-cookie')!] : []);
  for (const line of setCookies) {
    const [pair, ...attributes] = line.split(';');
    const separator = pair?.indexOf('=') ?? -1;
    if (!pair || separator < 0 || pair.slice(0, separator).trim() !== ANNAS_MEMBER_COOKIE) continue;
    const value = pair.slice(separator + 1).trim();
    if (!value) return undefined;
    return { cookie: `${ANNAS_MEMBER_COOKIE}=${value}`, value, expiresAt: Date.now() + annasMemberSessionLifetimeMs(attributes) };
  }
  return undefined;
}

function annasMemberSessionLifetimeMs(attributes: string[]): number {
  let lifetime = ANNAS_MEMBER_SESSION_DEFAULT_MS;
  for (const attribute of attributes) {
    const separator = attribute.indexOf('=');
    if (separator < 0) continue;
    const name = attribute.slice(0, separator).trim().toLowerCase();
    const value = attribute.slice(separator + 1).trim();
    if (name === 'max-age' && /^\d+$/.test(value)) {
      lifetime = Number(value) * 1000;
      break;
    }
    if (name === 'expires') {
      const expires = Date.parse(value);
      if (Number.isFinite(expires)) lifetime = expires - Date.now();
    }
  }
  return Math.max(0, Math.min(lifetime, ANNAS_MEMBER_SESSION_MAX_MS));
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
    // Ranking for what the page library can actually read.
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
    // would systematically prefer scans and degrade the library.
    score += 1;
    rationale.push(`file size ${humanByteSize(candidate.file_size_bytes)}`);
  }
  if (candidate.md5 || candidate.annas_archive_id) {
    score += 2;
    rationale.push('stable locator present');
  }
  return { ...candidate, score, rationale: rationale.length ? rationale : ['candidate metadata returned by Anna Archive'] };
}

// EPUB first, PDF when no EPUB is offered (owner ruling 2026-10-07): an EPUB
// carries clean text, while a PDF may be a scan or a mislabelled edition. The
// margin outweighs the flat metadata points so a same-work PDF never outranks
// its EPUB.
function annasFormatIngestibility(format: string): { score: number; rationale: string } {
  if (format === 'epub') return { score: 10, rationale: 'preferred: the page library reads EPUB text directly' };
  if (format === 'pdf') return { score: 6, rationale: 'ingestible: the page library reads PDF pages, with OCR for scans; use it when no EPUB is offered' };
  return { score: 0, rationale: `not ingestible: the page library does not read ${format.toUpperCase()}` };
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
  // Pages both signals report. Without qpdf's count, only this may refuse a PDF as too long.
  corroborated_pages?: number;
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

/** An ingest asked of a domain with no page library: the download is kept and nothing is ingested. */
function annasNoPageLibrary(sourcePath: string): { ragIngest: Record<string, unknown>; registry: Record<string, unknown> } {
  return {
    ragIngest: { status: 'blocked', error: {
      code: 'page_library_not_configured',
      message: `This domain has no page library, so nothing was ingested. The download is on disk at ${sourcePath}.`,
      suggestion: 'Give the domain a page library, then re-run annas_archive_import with ingest: true.',
    } },
    registry: { status: 'skipped', reason: 'The ingest did not start.' },
  };
}

function ingestErrorRecord(error: unknown): { code: string; message: string; suggestion?: string } {
  return error instanceof DomainExpertWorkerError
    ? { code: error.code, message: error.message, ...(error.suggestion ? { suggestion: error.suggestion } : {}) }
    : { code: 'rag_ingest_error', message: error instanceof Error ? error.message : String(error) };
}

// The acquisition's top-level status must not read as success when the
// ingest did not verify: a caller that only looks at the outer status saw
// 'downloaded' on 2026-09-20 for sixteen books that never entered the library.
function annasAcquisitionStatus(base: 'downloaded' | 'ingested_existing', ingestStatus: string): string {
  const prefix = base === 'downloaded' ? 'downloaded' : 'skipped_duplicate';
  if (ingestStatus === 'blocked') return `${prefix}_ingest_blocked`;
  if (ingestStatus === 'page_ingest_queued') return `${prefix}_ingest_in_progress`;
  return base;
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
    // The smaller signal. Each can over-count: the page tree scan takes the largest nearby
    // /Count (an outline's count qualifies), and loose page objects include superseded ones in
    // an incrementally updated file. Only pages both report may refuse a PDF as too long.
    corroborated_pages: Math.min(pageTreeCount, pageObjects),
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

function gcsPrefixesCover(prefixes: string[], uri: string): boolean {
  return prefixes.some((prefix) => {
    const normalized = prefix.replace(/\/+$/g, '');
    return uri === normalized || uri.startsWith(`${normalized}/`);
  });
}

export function assertAllowedGcsDestination(destinationUri: string, allowedPrefixes: string[]): void {
  if (!destinationUri.startsWith('gs://')) {
    throw new DomainExpertWorkerError(400, 'invalid_gcs_prefix', 'GCS destination must start with gs://.');
  }
  // Allowlist checks compare string prefixes; a dot segment must never reach one.
  if (destinationUri.slice('gs://'.length).split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new DomainExpertWorkerError(400, 'invalid_gcs_prefix', 'GCS destination must not contain . or .. path segments.');
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

const SAFE_OBJECT_NAME_MAX_LENGTH = 80;

interface GcsObjectMetadata {
  generation?: string;
  size?: string;
  md5Hash?: string;
  crc32c?: string;
}

function safeObjectName(value: string): string {
  return sanitizeObjectName(value).slice(0, SAFE_OBJECT_NAME_MAX_LENGTH) || randomUUID();
}

function sanitizeObjectName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
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

function booleanEnvWithDefault(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
  throw new Error(`${name} must be true or false.`);
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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
    message: 'Notion pages require the official Notion API because public Notion pages are client-rendered.',
    suggestion: 'Use library_ingest start with notion: [<page or database URL or id>] after sharing the target pages with the integration.',
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
  const page = extractionInput.mode === 'youtube_url'
    ? { text: await runSummarizeExtraction(context.extraction, extractionInput.source) }
    : localHtmlExtraction(extractionInput.source);
  const extracted = page.text;
  const extractor = extractionInput.mode === 'youtube_url' ? EXTRACTION_METHOD : WEB_IMPORT_LOCAL_HTML_EXTRACTOR;
  const html = utf8(context.response.bytes);
  const title = page.title
    || extractHtmlTitle(html)
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
    ...(page.author ? { author: page.author } : {}),
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
 * A page's bytes are already in this process: Readability picks the article
 * (navigation, menus and footers dropped) and the library's own converter turns
 * it into Markdown without a subprocess, a temp file, or a second fetch. An
 * empty result is refused with the same code the extractor's own empty answer
 * uses, and the message carries no page content.
 */
function localHtmlExtraction(bytes: Uint8Array): { text: string; title?: string; author?: string } {
  const page = extractWebMainText(utf8(bytes));
  const extracted = normalizeExtractedText(page.markdown);
  if (extracted.length === 0) {
    throw new DomainExpertWorkerError(
      422,
      'summarize_extraction_empty',
      `${WEB_IMPORT_LOCAL_HTML_EXTRACTOR} produced no text for this page.`,
    );
  }
  return { text: extracted, ...(page.title ? { title: page.title } : {}), ...(page.author ? { author: page.author } : {}) };
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

async function deriveDirectFile(context: WebImportHandlerContext): Promise<WebImportHandlerResult> {
  const extension = directFileExtension(context.finalUrl, context.response.headers, context.response.bytes);
  if (!extension) {
    return { files: [] };
  }
  const isMedia = STAGE_IMPORT_MEDIA_EXTENSIONS.has(extension) || MEDIA_EXTENSIONS.has(extension);
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
  if (STAGE_IMPORT_ALLOWED_EXTENSIONS.has(pathExtension) || STAGE_IMPORT_MEDIA_EXTENSIONS.has(pathExtension) || MEDIA_EXTENSIONS.has(pathExtension)) {
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
    'audio/x-wav': '.wav',
    'audio/flac': '.flac',
    'audio/x-flac': '.flac',
    'audio/opus': '.opus',
    'video/x-matroska': '.mkv',
    'video/x-m4v': '.m4v',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
  };
  return contentType ? byContentType[contentType] : undefined;
}

// Whether the bytes open with a PDF header (%PDF-1.x or %PDF-2.x), after nothing but
// whitespace, within the first PDF_SNIFF_BYTES. The one test of "is this a PDF" by content.
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

function extractHtmlTitle(html: string): string | undefined {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? collapseWhitespace(decodeHtmlEntities((match[1] ?? '').replace(/<[^>]+>/g, ' '))) : undefined;
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
    || value === 'domain_library'
    || value === 'library_ingest'
    || value === 'annas_archive_search'
    || value === 'annas_archive_import'
  ) return value;
  throw new DomainExpertWorkerError(400, 'invalid_tool', 'Unsupported domain expert tool.');
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

function optionalNumberField<T extends string>(value: unknown, key: T): { [K in T]?: number } {
  if (value === undefined || value === null || value === '') return {};
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new DomainExpertWorkerError(400, 'invalid_params', `${key} must be a number.`);
  return { [key]: parsed } as { [K in T]?: number };
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
