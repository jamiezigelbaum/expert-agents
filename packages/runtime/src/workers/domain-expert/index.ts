import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import {
  domainManifest, domainPolicy, domainWorkspaceSeedFiles, planAnnasArchiveImport, planAnnasArchiveSearch,
  planDomainAgent, requireConfiguredAgent, type AnnasArchiveImportParams, type AnnasArchiveSearchParams,
  type DomainAgentParams,
} from '../../core/domain-expert.ts';
import { AgentRegistrationStore, pageLibraryRootFromEnv, registrationLibraryFromEnv } from '../../core/agent-registration.ts';
import { OperationError } from '../../core/operation-error.ts';
import {
  SUMMARIZE_BINARY, type ReferenceExtractor, type LibraryLocationConfig, MEDIA_EXTENSIONS, splitFrontmatter,
} from '@expert-agents/library';
import {
  agentRoutingConfigFromEnv, type AgentRoutingConfig, pageLibraryOriginalBuckets, pageLibraryMembers,
} from '../../core/agent-routing.ts';
import {
  DISCLOSURE_REFUSAL_CODES, DisclosureSessionStore, disclosureRefusal, resolveDisclosurePolicy,
  type DisclosurePolicy, type DisclosureRefusal, type DisclosureRefusalCode,
} from '../../core/disclosure.ts';
import { libraryObjectsRootFromEnv, LocalLibraryObjects, type LibraryObjectStore } from './library-objects.ts';
import { PageIndex, voyageClient, type VoyageClient } from './page-index.ts';
import { MultiPageStore, type PageLibraryMember } from './page-libraries.ts';
import { PageDisclosureRefusal, runDisclosedPageLibrary } from './page-disclosure.ts';
import {
  PageLibrary, PageLibraryError, pageSearchResult, parsePageLibraryParams, type PageSearchResult,
  type PageSearchScope,
} from './page-library.ts';
import { DatabasePageStore, TreePageStore, type PageStore } from './page-store.ts';
import {
  PageIngestError, PageIngestQueue, type IngestSourceInput, type IngestSourceRef, type MaterializedSource,
  type PageIndexWriter,
} from './page-ingest.ts';
import {
  currentUid, normalizePositiveInteger, normalizeNonNegativeInteger, withTimeout, optionalStringField,
  requireString, requireApprovalId, safeObjectName, extensionFormat, sha256, normalizeBasePath, json,
} from './worker-util.ts';
import { DomainExpertWorkerError } from './worker-errors.ts';
import {
  type DomainExpertWorkspaceRootPolicy, type DomainExpertWorkerOptions, type DomainExpertAnnasConfig,
  normalizeRoot, DEFAULT_ANNAS_BOOKS_ROOT, DEFAULT_ANNAS_ARCHIVE_MAX_DOWNLOAD_BYTES,
  DEFAULT_ANNAS_MIN_PDF_PAGES, DOMAIN_EXPERT_NOTION_CREDENTIAL_GUIDANCE,
} from './worker-config.ts';
import {
  GoogleRuntimeClient, gcsPrefixesCover, parseGcsPrefix, assertAllowedGcsDestination, isCreateOnlyConflict,
} from './object-store.ts';
import { NotionRuntimeClient, isNotionImportUrl, notionObjectIdFromUrlOrId } from './notion-client.ts';
import {
  type WebImportFetchImpl, type ResolveHostImpl, webImportFetchFromFetchImpl, defaultWebImportFetch,
  WEB_IMPORT_FETCH_TIMEOUT_MS, defaultResolveHost, webImportProvenanceUrl, webImportBudget,
  guardedWebImportFetch,
} from './network-guard.ts';
import {
  type AnnasMemberSession, ANNAS_ARCHIVE_DOWNLOAD_TIMEOUT_MS, ingestErrorRecord, annasUrl,
  annasSearchCandidates, rankAnnasCandidates, fetchAnnasCredentialed, annasMemberSignIn,
  ANNAS_MEMBER_SIGN_IN_BACKOFF_MS, LIBGEN_SEARCH_PAGE_SIZE, LIBGEN_SEARCH_TIMEOUT_MS, parseLibgenSearchHtml,
  annasDownloadPlan, existingAnnasAcquisition, appendAnnasAudit, annasSelectionAudit,
  readCappedAnnasDownloadBody, writeAnnasBookFile, annasNoPageLibrary, annasAcquisitionStatus,
  readExistingAnnasBookFile, fetchAnnasDownload, annasFastDownloadMd5, ANNAS_FAST_DOWNLOAD_PATH,
  annasFastDownloadUrl, annasFastDownloadError, fetchAnnasPartnerDownload,
} from './acquisition.ts';
import {
  defaultSummarizeExtract, deriveWebImportFiles, type ExtractionRuntimeContext, SUMMARIZE_EXTRACT_TIMEOUT_MS,
} from './web-import.ts';
import {
  type DomainExpertRequest, parseDomainAgentParams, parseAnnasArchiveSearchParams,
  parseAnnasArchiveImportParams, parseDomainExpertRequest,
} from './worker-request.ts';
import {
  checkedRootPath, collectStageImportFiles, resolveInside, isJunkStageImportPath, resolveWritePathInside,
  writeWorkspaceSeedFiles, audit, exists, inspectConfiguredScopeManifest,
} from './workspace-seed.ts';
import { type AnnasArtifactScale, annasArtifactScale } from './artifact-scale.ts';
import { responseTextOrJson } from './upstream.ts';

export {
  DOMAIN_EXPERT_ENV_EXAMPLE, DOMAIN_EXPERT_NOTION_CREDENTIAL_GUIDANCE, domainExpertRootsFromEnv,
  domainExpertGoogleConfigFromEnv, domainExpertAnnasConfigFromEnv, domainExpertNotionConfigFromEnv,
} from './worker-config.ts';
export type {
  DomainExpertWorkspaceRootPolicy, GoogleServiceAccountCredential, DomainExpertGoogleConfig,
  DomainExpertAnnasConfig, DomainExpertNotionConfig, DomainExpertWorkerOptions,
} from './worker-config.ts';
export { DomainExpertWorkerError } from './worker-errors.ts';
export { assertAllowedGcsDestination } from './object-store.ts';
export { pinnedWebImportLookup } from './network-guard.ts';
export { WEB_IMPORT_HANDLERS, selectWebImportHandler, scrubbedExtractionEnv } from './web-import.ts';
export type { WebImportHandler } from './web-import.ts';
export { parseLibgenSearchHtml } from './acquisition.ts';

// Memory bound on retained session ledgers, not a policy value. Eviction is
// least-recently-used; the disclosure bounds themselves live in configuration.
const DISCLOSURE_SESSION_CACHE_LIMIT = 1_000;
const DISCLOSURE_SESSION_ID_MAX_LENGTH = 200;

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
  /** Searches that ran without Voyage since this worker started, for health. */
  private readonly degradedSearches: { keyword_only: number; unranked: number; last_at?: string } = { keyword_only: 0, unranked: 0 };
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
    const degraded = this.degradedSearches;
    if (degraded.last_at && Date.now() - Date.parse(degraded.last_at) < DEGRADED_SEARCH_RECENT_MS) {
      issues.push({ code: 'page_search_degraded', message: 'A recent search ran without Voyage (no query vector or no rerank): results came back keyword-only or unranked.' });
    }
    return {
      status: issues.length ? 'degraded' : 'ready', configured, domains,
      ...(degraded.last_at ? { degraded_searches: { ...degraded } } : {}),
      ...(issues.length ? { issues } : {}),
    };
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
            search: multi ? (query, k, _source, scope) => multi.search(query, k, scope) : (query, k, _source, scope) => parts[0]!.search(query, k, scope),
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

  private pageSearchFor(database: string | undefined, sourceId: string): (query: string, k: number, scope?: PageSearchScope) => Promise<PageSearchResult> {
    // Every degraded search is counted, so health shows Voyage failing before a reader reports it.
    const counted = (result: PageSearchResult) => {
      if (result.degraded) {
        this.degradedSearches[result.degraded]++;
        this.degradedSearches.last_at = new Date().toISOString();
      }
      return result;
    };
    const seam = this.pageSearch;
    if (seam) return async (query, k, scope) => counted(pageSearchResult(await seam(query, k, sourceId, database, scope)));
    if (!this.pageIndexUrl(database) || !this.voyageApiKey) {
      throw new PageLibraryError('page_search_not_configured', 'The page search index is not configured.', 503);
    }
    const index = this.pageIndexFor(database);
    return async (query, k, scope) => {
      try { return counted(await index.search(sourceId, query, k, scope)); }
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

const PAGE_INGEST_EXTENSIONS = new Set(['.pdf', '.epub', '.md', '.markdown', '.txt', ...MEDIA_EXTENSIONS]);
// URLs one start may name.
const PAGE_INGEST_MAX_REFS = 50;
const PAGE_INGEST_MAX_BYTES = 300_000_000;
// Health counts each page-library source's index rows; an index that does not answer in this long is unreachable.
const PAGE_INDEX_HEALTH_TIMEOUT_MS = 3_000;
// Health reports Voyage trouble while a degraded search is this recent.
const DEGRADED_SEARCH_RECENT_MS = 15 * 60_000;

// Spelled out whole so the deploy-env test sees each prefix the env example documents.
const PAGE_LIBRARY_ENV_PREFIX = {
  DATABASE_URL: 'EXPERT_AGENTS_DOMAIN_EXPERT_PAGE_LIBRARY_DATABASE_URL_',
  WRITER_DATABASE_URL: 'EXPERT_AGENTS_DOMAIN_EXPERT_PAGE_LIBRARY_WRITER_DATABASE_URL_',
} as const;

/** The reader or writer URL variable for a named page-library database: the prefix plus <NAME>. */
function pageLibraryEnvName(kind: keyof typeof PAGE_LIBRARY_ENV_PREFIX, database: string): string {
  return PAGE_LIBRARY_ENV_PREFIX[kind] + database.toUpperCase().replace(/-/g, '_');
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
