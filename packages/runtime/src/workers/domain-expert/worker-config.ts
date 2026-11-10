// Domain-expert worker configuration: option shapes and their environment parsers.
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ReferenceExtractor, LibraryLocationConfig } from '@expert-agents/library';
import type { AgentRoutingConfig } from '../../core/agent-routing.ts';
import type { LibraryObjectStore } from './library-objects.ts';
import type { PageSearchHit, PageSearchResult, PageSearchScope } from './page-library.ts';
import type { PageStore } from './page-store.ts';
import type { PageIndexWriter } from './page-ingest.ts';
import type { WebImportFetchImpl, ResolveHostImpl } from './network-guard.ts';
import { asRecord, trimTrailingSlash, normalizePositiveInteger, normalizeNonNegativeInteger, requireString } from './worker-util.ts';
import { NOTION_DEFAULT_MAX_OBJECTS } from './notion-client.ts';

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

export type GoogleConfigurationStatus = 'ready' | 'unreadable' | 'not_configured';

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
  pageSearch?: (query: string, k: number, sourceId: string, database?: string, scope?: PageSearchScope) => Promise<PageSearchHit[] | PageSearchResult>;
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
export const STAGE_IMPORT_ALLOWED_EXTENSIONS = new Set(['.md', '.txt', '.pdf', '.html']);
export const STAGE_IMPORT_MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.mp4', '.mov', '.webm']);
export const STAGE_IMPORT_TRANSCRIBABLE_MEDIA_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.mp4', '.mov', '.webm']);
export const STAGE_IMPORT_MAX_FILE_BYTES = 10_000_000;
export const PDF_PROCESSING_MAX_BYTES = 100_000_000;
export const MEDIA_TRANSCRIBE_MAX_BYTES = 200 * 1024 * 1024;
export const DEFAULT_ANNAS_ARCHIVE_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const DEFAULT_ANNAS_BOOKS_ROOT = join(homedir(), 'ExpertAgents', 'Books');
// Book-scale floor. The 2026-07-29 impostor was a 36-page pamphlet wearing a
// 512-page monograph's metadata; genuine monographs run well past 200 pages, so
// 60 catches the pamphlet class with margin while clearing legitimately short
// books. A configured 0 disables the gate.
export const DEFAULT_ANNAS_MIN_PDF_PAGES = 60;

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

function booleanEnvWithDefault(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
  throw new Error(`${name} must be true or false.`);
}

export function normalizeRoot(root: DomainExpertWorkspaceRootPolicy): DomainExpertWorkspaceRootPolicy {
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
