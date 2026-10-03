import {
  EXTRACTION_METHOD,
  RAG_CHUNK_OVERLAP,
  RAG_CHUNK_TOKENS,
  resolveRagParserModel,
  type RetrievalPreferenceMode,
} from '@expert-agents/library';
import { OperationError } from './operation-error.ts';
import {
  AGENT_ROUTING_ENV_VAR,
  agentRoutingConfigFromEnv,
  type AgentRoutingConfig,
} from './agent-routing.ts';

export const DOMAIN_AGENT_ACTIONS = ['bootstrap', 'status', 'catalog', 'register'] as const;
export type DomainAgentAction = typeof DOMAIN_AGENT_ACTIONS[number];

export const DOMAIN_SOURCE_ACTIONS = ['add', 'list', 'status', 'remove'] as const;
export type DomainSourceAction = typeof DOMAIN_SOURCE_ACTIONS[number];

export const RAG_CORPUS_ACTIONS = ['create', 'ensure', 'import', 'stage_import', 'web_import', 'notion_import', 'list_files', 'delete_file', 'status', 'refresh'] as const;
export type RagCorpusAction = typeof RAG_CORPUS_ACTIONS[number];
export const WEB_IMPORT_TRANSCRIPT_MODES = ['auto', 'captions', 'asr'] as const;
export type WebImportTranscriptMode = typeof WEB_IMPORT_TRANSCRIPT_MODES[number];
/**
 * transcript_mode is still accepted and still validated, but it no longer
 * selects anything. Transcript acquisition moved to the ruled extraction
 * engine, which owns its own caption and media handling, and the extraction
 * subprocess carries no credentials, so no paid transcription provider is
 * reachable from it either. Every plan and every result says so, because a
 * parameter that quietly does nothing is worse than one that is refused.
 */
export const WEB_IMPORT_TRANSCRIPT_MODE_EFFECT = 'not_applicable';
export const WEB_IMPORT_TRANSCRIPT_MODE_NOTE = `${EXTRACTION_METHOD} owns transcript acquisition for YouTube and media URLs; `
  + 'this worker no longer selects between captions and ASR, and the extraction subprocess carries no credentials, '
  + 'so transcript_mode changes nothing about what is imported.';

export const DOMAIN_DOC_ACTIONS = [
  'read',
  'comment',
  'visual_insert',
  'visual_replace',
  'accept_visual_edits',
  'reject_visual_edits',
] as const;
export type DomainDocAction = typeof DOMAIN_DOC_ACTIONS[number];

export const DOMAIN_SOURCE_KINDS = [
  'book',
  'pdf',
  'epub',
  'google_doc',
  'blog_post',
  'transcript',
  'note',
  'dataset',
  'web_page',
  'unknown',
] as const;
export type DomainSourceKind = typeof DOMAIN_SOURCE_KINDS[number];

export const ANNAS_ARCHIVE_FORMATS = ['pdf', 'epub', 'mobi', 'azw3', 'djvu', 'unknown'] as const;
export type AnnasArchiveFormat = typeof ANNAS_ARCHIVE_FORMATS[number];

export type DomainAskReranker = 'rank-service' | 'llm' | 'off';
export const DOMAIN_ASK_RETRIEVAL_DEFAULTS = {
  candidateTopK: 30,
  synthesisContextLimit: 12,
  reranker: 'rank-service' as DomainAskReranker,
  rerankerModel: 'semantic-ranker-default@latest',
  multiQuery: true,
  maxQueries: 3,
  maxResultsCap: 100,
} as const;

interface Color {
  red: number;
  green: number;
  blue: number;
}

export interface DomainVisualStyle {
  foreground_color: Color;
  background_color: Color;
  prefix_marker: string;
  companion_comment_required: boolean;
}

export interface DomainManifest {
  domain_id: string;
  display_name: string;
  workspace_root_id: string;
  workspace_relative_path: string;
  inbox_relative_path: string;
  library_aliases: string[];
  canonical_resource_paths: string[];
  gcp_project: string;
  rag_location: string;
  allowed_gcs_prefixes: string[];
  routing: {
    configured: boolean;
    source_env: typeof AGENT_ROUTING_ENV_VAR;
    library?: { bucket: string; prefix: string; uri: string };
    target_corpus_display_name?: string;
    scope_manifest_path?: string;
  };
  rag_backend: 'gemini_enterprise_rag_engine';
  corpora: Array<{ id: string; description: string }>;
  embedding_model: string;
  chunking: {
    // 'llm' means the LLM parser is sent for the file types Google documents
    // it supports; everything else in an import keeps the default parser.
    parser: 'llm' | 'default';
    parser_model?: string;
    chunk_tokens: number;
    chunk_overlap: number;
  };
  retrieval: {
    candidate_top_k: number;
    synthesis_context_limit: number;
    reranker: DomainAskReranker;
    reranker_model: string;
    multi_query: boolean;
    preference_profile_configured?: boolean;
  };
  trust_posture: 'cloud_eligible_with_source_review';
  resource_wiki_namespace: string;
  eval_set: string;
  docs_service_account_mode: 'per_domain_service_account';
  visual_review_style: DomainVisualStyle;
}

export interface DomainManifestOptions {
  agentRouting?: AgentRoutingConfig;
  env?: Record<string, string | undefined>;
}

export interface DomainAgentParams {
  action: DomainAgentAction;
  domainId?: string;
  displayName?: string;
  dryRun?: boolean;
  library?: unknown;
  targetCorpusDisplayName?: string;
  approvalId?: string;
}

export interface DomainAskParams {
  domainId?: string;
  question: string;
  corpusId?: string;
  corpora?: string[];
  maxResults?: number;
  retrievalMode?: RetrievalPreferenceMode;
}

export interface DomainSourceParams {
  action: DomainSourceAction;
  domainId?: string;
  sourceId?: string;
  sourceKind?: DomainSourceKind;
  title?: string;
  author?: string;
  url?: string;
  relativePath?: string;
  corpusId?: string;
  trustPosture?: string;
  copyrightPosture?: string;
  includeHistory?: boolean;
  includeRemoved?: boolean;
  dryRun?: boolean;
}

export interface RagCorpusParams {
  action: RagCorpusAction;
  approvalId?: string;
  domainId?: string;
  corpusId?: string;
  ragFileName?: string;
  pageToken?: string;
  sourceId?: string;
  gcsUri?: string;
  driveFileId?: string;
  workspaceRelativePath?: string;
  batchId?: string;
  urls?: string[];
  pageIds?: string[];
  databaseIds?: string[];
  includeMedia?: boolean;
  transcriptMode?: WebImportTranscriptMode;
  dryRun?: boolean;
}

export interface DomainDocParams {
  action: DomainDocAction;
  domainId?: string;
  documentId: string;
  text?: string;
  comment?: string;
  rangeStart?: number;
  rangeEnd?: number;
  approvalId?: string;
  editBatchId?: string;
  dryRun?: boolean;
}

export interface AnnasArchiveSearchParams {
  domainId?: string;
  query?: string;
  topic?: string;
  title?: string;
  author?: string;
  maxResults?: number;
  topN?: number;
  formatPreference?: 'auto' | 'text_rag' | 'layout';
  language?: string;
  // The caller intends to ingest what it picks: rank by what Vertex RAG can
  // actually parse (PDF, and EPUB via the worker's text conversion) ahead of
  // formats it cannot, instead of by reading preference alone.
  ingestIntent?: boolean;
}

export interface AnnasArchiveImportParams {
  domainId?: string;
  annasArchiveId?: string;
  url?: string;
  format?: AnnasArchiveFormat;
  corpusId?: string;
  title?: string;
  author?: string;
  year?: string;
  topic?: string;
  language?: string;
  fileName?: string;
  md5?: string;
  fileSizeBytes?: number;
  ingest?: boolean;
  // Deliberate bypass of the measured book-scale floor on ingest. The
  // measurement is still taken and still recorded when this is set.
  allowShortArtifact?: boolean;
  copyrightPosture?: string;
  approvalId?: string;
  dryRun?: boolean;
}

const DEFAULT_DOMAIN_ID = 'research';
const DEFAULT_DISPLAY_NAME = 'Research Expert';
const AGENT_WORKSHOP_SKILL = 'expert-agent-workshop';
const DEFAULT_OPERATING_SKILL = 'domain-research';
const DEFAULT_RAG_LOCATION = 'us-central1';
const RAG_BACKEND = 'gemini_enterprise_rag_engine';
const RUNTIME_SECRET_REF = 'task-scoped credential adapter';
const ANNAS_ARCHIVE_SECRET_NAME = 'Annas-Archive-API-Key';
export const ANNAS_ARCHIVE_SEARCH_LIMIT_MAX = 50;

export function parseDomainAgentAction(value: unknown): DomainAgentAction {
  return parseEnum(value, DOMAIN_AGENT_ACTIONS, 'action');
}

export function parseDomainSourceAction(value: unknown): DomainSourceAction {
  return parseEnum(value, DOMAIN_SOURCE_ACTIONS, 'action');
}

export function parseRagCorpusAction(value: unknown): RagCorpusAction {
  return parseEnum(value, RAG_CORPUS_ACTIONS, 'action');
}

export function optionalWebImportTranscriptMode(value: unknown): WebImportTranscriptMode | undefined {
  return value === undefined || value === null || value === ''
    ? undefined
    : parseEnum(value, WEB_IMPORT_TRANSCRIPT_MODES, 'transcript_mode');
}

export function parseDomainDocAction(value: unknown): DomainDocAction {
  return parseEnum(value, DOMAIN_DOC_ACTIONS, 'action');
}

export function optionalDomainSourceKind(value: unknown): DomainSourceKind | undefined {
  return value === undefined || value === null || value === ''
    ? undefined
    : parseEnum(value, DOMAIN_SOURCE_KINDS, 'kind');
}

export function optionalAnnasArchiveFormat(value: unknown): AnnasArchiveFormat | undefined {
  return value === undefined || value === null || value === ''
    ? undefined
    : parseEnum(value, ANNAS_ARCHIVE_FORMATS, 'format');
}

export function normalizeDomainId(value: string | undefined): string {
  const raw = (value ?? DEFAULT_DOMAIN_ID).trim().toLowerCase();
  const normalized = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized) {
    throw new OperationError('invalid_params', 'domain_id must contain at least one letter or number.');
  }
  if (normalized.length > 64) {
    throw new OperationError('invalid_params', 'domain_id must be 64 characters or fewer after normalization.');
  }
  return normalized;
}

/**
 * The Vertex location every corpus, retrieval and generation call for a domain
 * is addressed to. A deployment that serves a corpus hosted elsewhere sets
 * it; an invalid value fails at manifest time, before any cloud request.
 */
export function resolveRagLocation(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) return DEFAULT_RAG_LOCATION;
  if (!/^[a-z]+-[a-z]+[0-9]+$/.test(raw)) {
    throw new OperationError('invalid_params', 'EXPERT_AGENTS_DOMAIN_EXPERT_RAG_LOCATION must be a Google Cloud region such as us-central1.');
  }
  return raw;
}

export function domainManifest(
  domainIdValue?: string,
  displayNameValue?: string,
  options: DomainManifestOptions = {},
): DomainManifest {
  const domainId = normalizeDomainId(domainIdValue);
  const env = options.env ?? process.env;
  const routing = (options.agentRouting ?? agentRoutingConfigFromEnv(env))[domainId];
  const title = routing?.displayName
    || displayNameValue?.trim()
    || (domainId === DEFAULT_DOMAIN_ID ? DEFAULT_DISPLAY_NAME : `${titleCase(domainId)} Researcher`);
  const workspaceRelativePath = `experts/${domainId}`;
  const resourceName = title.replace(/\s+(Researcher|Expert)$/i, '').trim() || titleCase(domainId);
  const libraryUri = routing ? `gs://${routing.library.bucket}/${routing.library.prefix}` : undefined;
  const ragParserModel = resolveRagParserModel(env.EXPERT_AGENTS_DOMAIN_EXPERT_RAG_PARSER_MODEL);
  return {
    domain_id: domainId,
    display_name: title,
    workspace_root_id: 'expert_agents_workspace',
    workspace_relative_path: workspaceRelativePath,
    inbox_relative_path: `${workspaceRelativePath}/inbox`,
    library_aliases: [`${resourceName} alias`],
    canonical_resource_paths: [`libraries/${domainId}/books`, `libraries/${domainId}/sources`],
    gcp_project: env.EXPERT_AGENTS_GCP_PROJECT?.trim() ?? '',
    rag_location: resolveRagLocation(env.EXPERT_AGENTS_DOMAIN_EXPERT_RAG_LOCATION),
    allowed_gcs_prefixes: libraryUri ? [libraryUri] : [],
    routing: routing
      ? {
          configured: true,
          source_env: AGENT_ROUTING_ENV_VAR,
          library: { ...routing.library, uri: libraryUri! },
          target_corpus_display_name: routing.targetCorpusDisplayName,
          ...(routing.scopeManifestPath ? { scope_manifest_path: routing.scopeManifestPath } : {}),
        }
      : { configured: false, source_env: AGENT_ROUTING_ENV_VAR },
    rag_backend: RAG_BACKEND,
    corpora: routing
      ? (routing.servingCorpusDisplayNames ?? [routing.targetCorpusDisplayName])
        .map((id) => ({ id, description: 'Configured materialized library view' }))
      : [],
    // No corpus-creation path sends ragEmbeddingModelConfig, so every corpus
    // takes the API default. The manifest names the model the corpora actually
    // use rather than one we would like them to use.
    embedding_model: 'text-embedding-005',
    chunking: {
      parser: ragParserModel === undefined ? 'default' : 'llm',
      ...(ragParserModel === undefined ? {} : { parser_model: ragParserModel }),
      chunk_tokens: RAG_CHUNK_TOKENS,
      chunk_overlap: RAG_CHUNK_OVERLAP,
    },
    retrieval: {
      candidate_top_k: routing?.retrieval?.topK ?? DOMAIN_ASK_RETRIEVAL_DEFAULTS.candidateTopK,
      synthesis_context_limit: routing?.retrieval?.contextLimit ?? DOMAIN_ASK_RETRIEVAL_DEFAULTS.synthesisContextLimit,
      reranker: routing?.retrieval?.reranker ?? DOMAIN_ASK_RETRIEVAL_DEFAULTS.reranker,
      reranker_model: DOMAIN_ASK_RETRIEVAL_DEFAULTS.rerankerModel,
      multi_query: routing?.retrieval?.multiQuery ?? DOMAIN_ASK_RETRIEVAL_DEFAULTS.multiQuery,
      ...(routing?.retrieval?.preferenceProfilePath ? { preference_profile_configured: true } : {}),
    },
    trust_posture: 'cloud_eligible_with_source_review',
    resource_wiki_namespace: `03 Resources/${resourceName}`,
    eval_set: 'eval/questions.jsonl',
    docs_service_account_mode: 'per_domain_service_account',
    visual_review_style: visualStyle(domainId),
  };
}

export function planDomainAgent(
  params: DomainAgentParams,
  manifest: DomainManifest = domainManifest(params.domainId, params.displayName),
): Record<string, unknown> {
  const dryRun = params.dryRun ?? true;
  if (!dryRun) throwDomainBackendNotConfigured('domain_agent');
  return {
    kind: 'domain_agent_plan',
    status: params.action === 'bootstrap' ? 'dry_run_scaffold_ready' : 'dry_run_status_ready',
    action: params.action,
    domain: manifest,
    workspace_scaffold: {
      root_id: manifest.workspace_root_id,
      relative_path: manifest.workspace_relative_path,
      directories: bootstrapDirectories(manifest),
      files: domainWorkspaceSeedFiles(manifest),
      version_control: workspaceVersionControlPlan(manifest),
      aliases_to_create: manifest.library_aliases.map((alias, index) => ({
        alias,
        target_hint: manifest.canonical_resource_paths[index] ?? manifest.canonical_resource_paths[0],
      })),
    },
    openclaw_agent: {
      agent_id: manifest.domain_id,
      display_name: manifest.display_name,
      workspace: manifest.workspace_relative_path,
      created_by_skill: AGENT_WORKSHOP_SKILL,
      operating_skill: operatingSkillForDomain(manifest.domain_id),
      scoped_tools: [
        'domain_ask',
        'domain_source',
        'rag_corpus',
        'domain_doc',
        'annas_archive_search',
        'annas_archive_import',
        'expert_agents_workspace',
      ],
    },
    policy: domainPolicy(),
    next_steps: [
      'Materialize these paths through the bounded workspace adapter or live OpenClaw runtime.',
      'Initialize version control and wire the private remote before the workspace accumulates working memory.',
      'Share a test Google Doc with the per-domain service account before enabling document edits.',
      'Create or verify Gemini Enterprise RAG corpora before asking grounded questions.',
    ],
  };
}

function operatingSkillForDomain(domainId: string): string {
  return domainId === DEFAULT_DOMAIN_ID ? DEFAULT_OPERATING_SKILL : `${domainId}-research`;
}

export function planDomainAsk(
  params: DomainAskParams,
  manifest: DomainManifest = domainManifest(params.domainId),
): Record<string, unknown> {
  const question = requireNonEmpty(params.question, 'question');
  const candidateTopK = validatedDomainAskMaxResults(params.maxResults, manifest.retrieval.candidate_top_k);
  if (params.retrievalMode !== undefined && params.retrievalMode !== 'preferred' && params.retrievalMode !== 'history') {
    throw new OperationError('invalid_params', 'retrieval_mode must be preferred or history');
  }
  const corpora = params.corpusId
    ? [params.corpusId]
    : (params.corpora?.length ? params.corpora : manifest.corpora.map((corpus) => corpus.id));
  return {
    kind: 'domain_ask_plan',
    status: 'runtime_execution_available',
    domain: compactDomain(manifest),
    question,
    retrieval: {
      backend: 'vertex-rag',
      configuration_required: true,
      gcp_project: manifest.gcp_project,
      location: manifest.rag_location,
      corpora,
      candidate_top_k: candidateTopK,
      synthesis_context_limit: Math.min(candidateTopK, manifest.retrieval.synthesis_context_limit),
      reranker: {
        mode: manifest.retrieval.reranker,
        model: manifest.retrieval.reranker_model,
      },
      multi_query: {
        enabled: manifest.retrieval.multi_query,
        max_queries: DOMAIN_ASK_RETRIEVAL_DEFAULTS.maxQueries,
      },
      cross_corpus_retrieval: true,
      ...(manifest.retrieval.preference_profile_configured || params.retrievalMode ? {
        preferences: {
          configured: manifest.retrieval.preference_profile_configured === true,
          requested_mode: params.retrievalMode ?? 'profile_default',
        },
      } : {}),
    },
    expected_output: {
      answer: true,
      citations: true,
    },
    policy: domainPolicy(),
    next_steps: [
      'Configure the documented Vertex AI credentials and corpus mappings before live execution.',
      'Return cited answers; do not add domain-specific answer code in Expert Agents.',
    ],
  };
}

function validatedDomainAskMaxResults(value: number | undefined, defaultValue: number): number {
  if (value === undefined) return Math.min(defaultValue, DOMAIN_ASK_RETRIEVAL_DEFAULTS.maxResultsCap);
  if (!Number.isInteger(value) || value <= 0 || value > DOMAIN_ASK_RETRIEVAL_DEFAULTS.maxResultsCap) {
    throw new OperationError(
      'invalid_params',
      `max_results must be a positive integer no greater than ${DOMAIN_ASK_RETRIEVAL_DEFAULTS.maxResultsCap}.`,
    );
  }
  return value;
}

export function planDomainSource(
  params: DomainSourceParams,
  manifest: DomainManifest = domainManifest(params.domainId),
): Record<string, unknown> {
  const dryRun = params.dryRun ?? true;
  if (!dryRun) throwDomainBackendNotConfigured('domain_source');
  validateDomainSourceRequest(params);
  const sourceId = params.sourceId ?? plannedSourceId(manifest.domain_id, params);
  return {
    kind: 'domain_source_plan',
    status: 'dry_run_source_registration_ready',
    action: params.action,
    domain: compactDomain(manifest),
    source_record: {
      source_id: sourceId,
      domain_id: manifest.domain_id,
      kind: params.sourceKind ?? 'unknown',
      ...(params.title ? { title: params.title } : {}),
      ...(params.author ? { author: params.author } : {}),
      ...(params.url ? { canonical_url: params.url } : {}),
      ...(params.relativePath ? { workspace_relative_path: params.relativePath } : {}),
      ...(params.corpusId ? { target_corpus_id: params.corpusId } : {}),
      trust_posture: params.trustPosture ?? manifest.trust_posture,
      ...(params.copyrightPosture ? { copyright_posture: params.copyrightPosture } : {}),
      ingest_status: params.action === 'add' ? 'not_ingested' : 'lookup_planned',
    },
    registration_effects: [
      'append source-registry.jsonl and ingest-log.md',
    ],
    ingestion: {
      performed_by_domain_source_add: false,
      available_via: [
        'rag_corpus stage_import or import',
        'rag_corpus web_import',
        'rag_corpus notion_import',
        'annas_archive_import',
      ],
    },
    policy: domainPolicy(),
  };
}

export function planRagCorpus(
  params: RagCorpusParams,
  manifest: DomainManifest = domainManifest(params.domainId),
): Record<string, unknown> {
  const dryRun = params.dryRun ?? true;
  if (!dryRun) requireConfiguredAgent(manifest, 'rag_corpus');
  if (!dryRun) throwDomainBackendNotConfigured('rag_corpus');
  validateRagCorpusRequest(params, manifest);
  validateGcsUri(manifest, params.gcsUri);
  const corpusId = resolveTargetCorpus(params.corpusId, manifest)?.target_corpus_id;
  const destinationRoot = manifest.allowed_gcs_prefixes[0];
  const stageImport = params.action === 'stage_import'
    ? {
        workspace_relative_path: params.workspaceRelativePath,
        batch_id: params.batchId,
        recursive: true,
        include_media: params.includeMedia ?? false,
        eligible_extensions: params.includeMedia
          ? ['md', 'txt', 'pdf', 'html', 'png', 'jpg', 'jpeg', 'webp', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'mp4', 'mov', 'webm']
          : ['md', 'txt', 'pdf', 'html'],
        max_file_bytes: 10 * 1024 * 1024,
        max_batch_bytes: 100 * 1024 * 1024,
        media_max_file_bytes: 200 * 1024 * 1024,
        media_bytes_count_against_text_batch_cap: false,
        ...(destinationRoot ? { destination_prefix: `${destinationRoot}/staged/${manifest.domain_id}/${params.batchId ?? '<generated-batch-id>'}/` } : {}),
      }
    : undefined;
  const webImport = params.action === 'web_import'
    ? {
        urls: params.urls,
        batch_id: params.batchId,
        include_media: params.includeMedia ?? false,
        transcript_mode: params.transcriptMode ?? 'auto',
        transcript_mode_effect: WEB_IMPORT_TRANSCRIPT_MODE_EFFECT,
        transcript_mode_note: WEB_IMPORT_TRANSCRIPT_MODE_NOTE,
        workspace_relative_path: `${manifest.workspace_relative_path}/sources/web-imports/${params.batchId ?? '<generated-batch-id>'}`,
        ...(corpusId ? { target_corpus_id: corpusId } : {}),
        handler_table: ['direct-file', 'notion', 'summarize-extract'],
        extractor: EXTRACTION_METHOD,
        youtube_media_transcripts: `${EXTRACTION_METHOD} handles YouTube and media URLs with its own tooling; the worker selects neither captions nor ASR`,
        media_max_file_bytes: 200 * 1024 * 1024,
        media_bytes_count_against_text_batch_cap: false,
        ...(destinationRoot ? { destination_prefix: `${destinationRoot}/staged/${manifest.domain_id}/${params.batchId ?? '<generated-batch-id>'}/` } : {}),
    }
    : undefined;
  const notionImport = params.action === 'notion_import'
    ? {
        urls: params.urls,
        page_ids: params.pageIds,
        database_ids: params.databaseIds,
        batch_id: params.batchId,
        workspace_relative_path: `${manifest.workspace_relative_path}/sources/notion-imports/${params.batchId ?? '<generated-batch-id>'}`,
        ...(corpusId ? { target_corpus_id: corpusId } : {}),
        api: {
          base_url: 'https://api.notion.com/v1',
          notion_version: '2022-06-28',
          object_cap_default: 200,
          recursive_block_depth_default: 6,
        },
        ...(destinationRoot ? { destination_prefix: `${destinationRoot}/staged/${manifest.domain_id}/${params.batchId ?? '<generated-batch-id>'}/` } : {}),
      }
    : undefined;
  return {
    kind: 'rag_corpus_plan',
    status: manifest.routing.configured ? 'dry_run_corpus_lifecycle_ready' : 'dry_run_agent_not_configured',
    action: params.action,
    domain: compactDomain(manifest),
    corpus: {
      ...(corpusId ? { corpus_id: corpusId } : {}),
      routing_configured: manifest.routing.configured,
      backend: manifest.rag_backend,
      gcp_project: manifest.gcp_project,
      location: manifest.rag_location,
      embedding_model: manifest.embedding_model,
      chunking: manifest.chunking,
      ...(params.gcsUri ? { gcs_uri: params.gcsUri } : {}),
      ...(params.driveFileId ? { drive_file_id: params.driveFileId } : {}),
      ...(params.ragFileName ? { rag_file_name: params.ragFileName } : {}),
      ...(params.pageToken ? { page_token: params.pageToken } : {}),
      ...(params.sourceId ? { source_id: params.sourceId } : {}),
      ...(stageImport ? { stage_import: stageImport } : {}),
      ...(webImport ? { web_import: webImport } : {}),
      ...(notionImport ? { notion_import: notionImport } : {}),
    },
    allowed_gcs_prefixes: manifest.allowed_gcs_prefixes,
    policy: domainPolicy(),
    next_steps: [
      'Resolve Google credentials through the OpenClaw runtime secret provider.',
      'Use Gemini Enterprise RAG Engine corpus lifecycle APIs, then record corpus state in the domain registry.',
    ],
  };
}

export function planDomainDoc(
  params: DomainDocParams,
  manifest: DomainManifest = domainManifest(params.domainId),
): Record<string, unknown> {
  const dryRun = params.dryRun ?? true;
  validateDomainDocRequest(params, dryRun);
  if (!dryRun) requireConfiguredAgent(manifest, 'domain_doc');
  if (!dryRun) throwDomainBackendNotConfigured('domain_doc');
  return {
    kind: 'domain_doc_plan',
    status: 'dry_run_google_doc_operation_ready',
    action: params.action,
    domain: compactDomain(manifest),
    document: {
      document_id: params.documentId,
      service_account_mode: manifest.docs_service_account_mode,
      credentials: RUNTIME_SECRET_REF,
      ...(params.rangeStart !== undefined ? { range_start: params.rangeStart } : {}),
      ...(params.rangeEnd !== undefined ? { range_end: params.rangeEnd } : {}),
      ...(params.editBatchId ? { edit_batch_id: params.editBatchId } : {}),
    },
    requested_change: {
      ...(params.text ? { text: params.text } : {}),
      ...(params.comment ? { comment: params.comment } : {}),
      ...(params.approvalId ? { approval_id: params.approvalId } : {}),
    },
    visual_review_style: manifest.visual_review_style,
    google_docs_posture: {
      native_suggestion_mode_created_by_api: false,
      comments_supported_path: true,
      direct_visual_edits_supported_path: true,
      direct_visual_edits_require_approval: true,
    },
    policy: domainPolicy(),
  };
}

export function planAnnasArchiveSearch(
  params: AnnasArchiveSearchParams,
  manifest: DomainManifest = domainManifest(params.domainId),
): Record<string, unknown> {
  const query = firstNonEmpty(params.query, params.topic, params.title, params.author);
  if (!query) {
    throw new OperationError('invalid_params', 'Provide query, topic, title, or author for annas_archive_search.');
  }
  const limits = validatedAnnasArchiveSearchLimits(params);
  return {
    kind: 'annas_archive_search_plan',
    status: 'requires_runtime_secret_and_api_worker',
    domain: compactDomain(manifest),
    search: {
      ...(params.query ? { query: params.query } : {}),
      ...(params.topic ? { topic: params.topic } : {}),
      ...(params.title ? { title: params.title } : {}),
      ...(params.author ? { author: params.author } : {}),
      ...(params.language ? { language: params.language } : {}),
      max_results: limits.maxResults,
      ...(limits.topN !== undefined ? { top_n: limits.topN } : {}),
      format_preference: params.formatPreference ?? 'auto',
      ...(params.ingestIntent ? { ingest_intent: true } : {}),
    },
    runtime_secret: {
      provider: RUNTIME_SECRET_REF,
      name: ANNAS_ARCHIVE_SECRET_NAME,
      exposed_to_agent: false,
    },
    policy: domainPolicy(),
    next_steps: [
      'Run Anna Archive discovery inside the bounded runtime worker and return candidate metadata only.',
      'Present top-N candidates with ranking rationale; do not download until the owner approves selections.',
      'Ask for import/copyright approval before downloading files into the configured books folder or a RAG pipeline.',
    ],
  };
}

function validatedAnnasArchiveSearchLimits(
  params: Pick<AnnasArchiveSearchParams, 'maxResults' | 'topN'>,
): { maxResults: number; topN?: number } {
  const validate = (value: number, field: 'max_results' | 'top_n'): number => {
    if (!Number.isInteger(value) || value <= 0 || value > ANNAS_ARCHIVE_SEARCH_LIMIT_MAX) {
      throw new OperationError(
        'invalid_params',
        `${field} must be a positive integer no greater than ${ANNAS_ARCHIVE_SEARCH_LIMIT_MAX}.`,
      );
    }
    return value;
  };
  const maxResults = validate(params.maxResults ?? 10, 'max_results');
  return {
    maxResults,
    ...(params.topN === undefined ? {} : { topN: validate(params.topN, 'top_n') }),
  };
}

export function planAnnasArchiveImport(
  params: AnnasArchiveImportParams,
  manifest: DomainManifest = domainManifest(params.domainId),
): Record<string, unknown> {
  const dryRun = params.dryRun ?? true;
  const locator = firstNonEmpty(params.annasArchiveId, params.url);
  if (!locator) {
    throw new OperationError('invalid_params', 'Provide annas_archive_id or url for annas_archive_import.');
  }
  if (!params.copyrightPosture?.trim()) {
    throw new OperationError(
      'domain_expert_policy_violation',
      'annas_archive_import requires an explicit copyright_posture before any download/import plan.',
    );
  }
  if (!dryRun && !params.approvalId?.trim()) {
    throw new OperationError(
      'domain_expert_policy_violation',
      'annas_archive_import with dry_run=false requires approval_id.',
    );
  }
  // Ingest for an unrouted domain resolves to a pending corpus decision at
  // execution time rather than a refusal here; the download itself is
  // owner-authorized by the naming. Kept in agreement with the worker's gate.
  if (!dryRun) throwDomainBackendNotConfigured('annas_archive_import');
  return {
    kind: 'annas_archive_import_plan',
    status: 'dry_run_acquisition_ready',
    domain: compactDomain(manifest),
    acquisition: {
      ...(params.annasArchiveId ? { annas_archive_id: params.annasArchiveId } : {}),
      ...(params.url ? { url: params.url } : {}),
      ...(params.md5 ? { md5: params.md5 } : {}),
      ...(params.title ? { title: params.title } : {}),
      ...(params.author ? { author: params.author } : {}),
      ...(params.year ? { year: params.year } : {}),
      ...(params.topic ? { topic: params.topic } : {}),
      ...(params.language ? { language: params.language } : {}),
      ...(params.fileName ? { file_name: params.fileName } : {}),
      ...(params.fileSizeBytes !== undefined ? { file_size_bytes: params.fileSizeBytes } : {}),
      format: params.format ?? 'unknown',
      copyright_posture: params.copyrightPosture,
      destination: 'books_folder',
      deterministic_layout: 'topic/Author - Title (Year)/filename',
    },
    rag_ingest: plannedRagIngest(params, manifest),
    format_preference: {
      default: 'epub_for_text_first_rag_pdf_for_layout_heavy',
      configurable: true,
    },
    runtime_secret: {
      provider: RUNTIME_SECRET_REF,
      name: ANNAS_ARCHIVE_SECRET_NAME,
      exposed_to_agent: false,
    },
    ingest_pipeline: [
      'download approved file inside the configured runtime worker',
      'save into the configured books folder without overwriting existing files',
      'audit selected/downloaded/skipped path and hashes',
      'optionally stage/import into an explicit Gemini Enterprise RAG corpus',
      'record source and ingest status in the domain registry when a corpus is chosen',
    ],
    policy: domainPolicy(),
  };
}

// The dry-run twin of the worker's ingest gate: same resolver, same reason, so
// the plan names the corpus the identical live request would import into.
function plannedRagIngest(params: AnnasArchiveImportParams, manifest: DomainManifest): Record<string, unknown> {
  if (!params.ingest) return { status: 'not_requested' };
  const target = resolveTargetCorpus(params.corpusId, manifest);
  if (!target) return { status: 'needs_corpus_decision', reason: NO_TARGET_CORPUS_REASON };
  return { status: 'planned', ...target };
}

function parseEnum<T extends readonly string[]>(value: unknown, allowed: T, name: string): T[number] {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new OperationError('invalid_params', `${name} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T[number];
}

function visualStyle(domainId: string): DomainVisualStyle {
  return {
    foreground_color: { red: 0.22, green: 0.32, blue: 0.72 },
    background_color: { red: 0.88, green: 0.92, blue: 1 },
    prefix_marker: `[${titleCase(domainId)}]`,
    companion_comment_required: true,
  };
}

export function domainPolicy(): Record<string, unknown> {
  return {
    expert_agents_control_plane_only: true,
    backend: RAG_BACKEND,
    host_source_contracts_unchanged: true,
    per_question_answer_logic_in_runtime: false,
    raw_runtime_secrets_exposed: false,
    cloud_corpus_requires_source_review: true,
    direct_google_doc_edits_require_approval: true,
  };
}

function compactDomain(manifest: DomainManifest): Record<string, unknown> {
  return {
    domain_id: manifest.domain_id,
    display_name: manifest.display_name,
    workspace_root_id: manifest.workspace_root_id,
    workspace_relative_path: manifest.workspace_relative_path,
    rag_backend: manifest.rag_backend,
    gcp_project: manifest.gcp_project,
    rag_location: manifest.rag_location,
    corpora: manifest.corpora,
    routing: manifest.routing,
  };
}

function bootstrapDirectories(manifest: DomainManifest): string[] {
  const root = manifest.workspace_relative_path;
  return [
    root,
    `${root}/inbox`,
    `${root}/references`,
    `${root}/templates`,
    `${root}/eval`,
    `${root}/outputs`,
    `${root}/outputs/briefs`,
    `${root}/outputs/resource-wiki-proposals`,
  ];
}

/**
 * A workspace whose instructions were never committed, or whose only copy is
 * one host's disk, is the failure this block exists to prevent. The control
 * plane cannot run git for the operator, so it hands over the exact commands
 * instead of assuming a hosting credential exists wherever it is materialized.
 */
function workspaceVersionControlPlan(manifest: DomainManifest): Record<string, unknown> {
  const root = manifest.workspace_relative_path;
  return {
    required: true,
    first_commit_required: true,
    ignore_file: `${root}/.gitignore`,
    ordering_note: 'Write the ignore file before the first stage, so no runtime secret or cache is ever staged.',
    remote: { required: true, visibility: 'private', wired_by_operator: true },
    operator_commands: [
      'git init',
      'git add --all',
      "git commit -m 'Initialize expert workspace'",
      'git remote add origin <private-repository-url>',
      'git push -u origin HEAD',
    ],
  };
}

export function domainWorkspaceSeedFiles(manifest: DomainManifest): Array<Record<string, unknown>> {
  const root = manifest.workspace_relative_path;
  return [
    { relative_path: `${root}/.gitignore`, kind: 'ignore_rules' },
    { relative_path: `${root}/PROPOSAL.md`, kind: 'operating_doctrine' },
    { relative_path: `${root}/domain.manifest.json`, kind: 'domain_manifest', content_preview: manifest },
    { relative_path: `${root}/references/source-registry.jsonl`, kind: 'source_registry' },
    { relative_path: `${root}/references/ingest-log.md`, kind: 'ingest_log' },
    { relative_path: `${root}/references/reading-map.md`, kind: 'reading_map' },
    { relative_path: `${root}/references/retrieval-craft.md`, kind: 'agent_retrieval_guidance' },
    { relative_path: `${root}/templates/source-card.md`, kind: 'template' },
    { relative_path: `${root}/templates/research-brief.md`, kind: 'template' },
    { relative_path: `${root}/templates/literature-review.md`, kind: 'template' },
    { relative_path: `${root}/templates/disagreement-map.md`, kind: 'template' },
    { relative_path: `${root}/eval/questions.jsonl`, kind: 'eval_seed' },
  ];
}

function validateDomainSourceRequest(params: DomainSourceParams): void {
  if (params.action === 'add' && !firstNonEmpty(params.url, params.relativePath)) {
    throw new OperationError('invalid_params', 'domain_source add requires url or relative_path.');
  }
  if ((params.action === 'status' || params.action === 'remove') && !params.sourceId?.trim()) {
    throw new OperationError('invalid_params', `domain_source ${params.action} requires source_id.`);
  }
}

function validateDomainDocRequest(params: DomainDocParams, dryRun: boolean): void {
  requireNonEmpty(params.documentId, 'document_id');
  if ((params.action === 'comment') && !params.comment?.trim()) {
    throw new OperationError('invalid_params', 'domain_doc comment requires comment.');
  }
  if ((params.action === 'visual_insert' || params.action === 'visual_replace') && !params.text?.trim()) {
    throw new OperationError('invalid_params', `domain_doc ${params.action} requires text.`);
  }
  if (params.action === 'visual_replace' && (params.rangeStart === undefined || params.rangeEnd === undefined)) {
    throw new OperationError('invalid_params', 'domain_doc visual_replace requires range_start and range_end.');
  }
  if ((params.action === 'visual_insert' || params.action === 'visual_replace') && !dryRun && !params.approvalId?.trim()) {
    throw new OperationError(
      'domain_expert_policy_violation',
      `domain_doc ${params.action} with dry_run=false requires approval_id.`,
    );
  }
}

function validateRagCorpusRequest(params: RagCorpusParams, manifest: DomainManifest): void {
  if (params.action === 'stage_import' && !params.workspaceRelativePath?.trim()) {
    throw new OperationError('invalid_params', 'rag_corpus stage_import requires workspace_relative_path.');
  }
  if (params.action === 'web_import') {
    requireResolvableCorpus(params, manifest, 'web_import');
    if (!params.urls || params.urls.length === 0 || params.urls.length > 200) {
      throw new OperationError('invalid_params', 'rag_corpus web_import requires urls with 1 to 200 entries.');
    }
    for (const url of params.urls) {
      requireNonEmpty(url, 'urls');
    }
  }
  if (params.action === 'notion_import') {
    requireResolvableCorpus(params, manifest, 'notion_import');
    const sourceCount = (params.urls?.length ?? 0) + (params.pageIds?.length ?? 0) + (params.databaseIds?.length ?? 0);
    if (sourceCount === 0) {
      throw new OperationError('invalid_params', 'rag_corpus notion_import requires urls, page_ids, or database_ids.');
    }
    if (sourceCount > 200) {
      throw new OperationError('invalid_params', 'rag_corpus notion_import accepts at most 200 starting objects.');
    }
    for (const url of params.urls ?? []) requireNonEmpty(url, 'urls');
    for (const pageId of params.pageIds ?? []) requireNonEmpty(pageId, 'page_ids');
    for (const databaseId of params.databaseIds ?? []) requireNonEmpty(databaseId, 'database_ids');
  }
  if (params.action === 'delete_file') {
    requireNonEmpty(params.ragFileName, 'rag_file_name');
  }
}

// Execution resolves an unnamed corpus to the domain's configured target, so a
// planner that demanded corpus_id refused requests the worker imports happily.
// The refusal survives only where there is genuinely nothing to resolve.
function requireResolvableCorpus(params: RagCorpusParams, manifest: DomainManifest, action: string): void {
  if (resolveTargetCorpus(params.corpusId, manifest)) return;
  throw new OperationError(
    'invalid_params',
    `rag_corpus ${action} requires corpus_id: none was supplied and this domain has no configured target corpus.`,
  );
}

function validateGcsUri(manifest: DomainManifest, gcsUri: string | undefined): void {
  if (!gcsUri) return;
  if (!gcsUri.startsWith('gs://')) {
    throw new OperationError('invalid_params', 'gcs_uri must start with gs://.');
  }
  if (!manifest.allowed_gcs_prefixes.some((prefix) => gcsUri === prefix || gcsUri.startsWith(`${prefix}/`))) {
    throw new OperationError(
      'domain_expert_policy_violation',
      `gcs_uri must be inside one of the domain allowlisted prefixes: ${manifest.allowed_gcs_prefixes.join(', ')}.`,
    );
  }
}

function plannedSourceId(domainId: string, params: DomainSourceParams): string {
  const basis = firstNonEmpty(params.url, params.relativePath, params.title, params.author) ?? 'source';
  return `${domainId}-${slugify(basis).slice(0, 48)}-${stableShortHash(basis)}`;
}

// The domain's routing target — the corpus a configured deployment's library
// materializes into — or undefined for a domain with no routing at all.
export function configuredCorpusId(manifest: DomainManifest): string | undefined {
  return manifest.corpora[0]?.id;
}

export const NO_TARGET_CORPUS_REASON =
  'RAG ingest has no target corpus: no corpus_id was supplied and this domain has no configured target corpus.';

/**
 * The one place a corpus target is chosen. Planning and execution both call it,
 * which is the point: a planner that resolved the target on its own told an
 * agent an ingest had nowhere to go, and the identical live request then
 * imported into the configured corpus. Only a domain with no routing at all
 * genuinely has nothing to resolve.
 */
export function resolveTargetCorpus(
  requestedCorpusId: string | undefined,
  manifest: DomainManifest,
): { target_corpus_id: string; target_corpus_source: 'request' | 'domain_default' } | undefined {
  const requested = requestedCorpusId?.trim();
  const corpusId = requested || configuredCorpusId(manifest);
  if (!corpusId) return undefined;
  return {
    target_corpus_id: corpusId,
    target_corpus_source: requested ? 'request' : 'domain_default',
  };
}

export function requireConfiguredAgent(manifest: DomainManifest, toolName: string): void {
  if (manifest.routing.configured) return;
  // Name the refused domain in the error and the journal: a caller that
  // drifted to an unrouted id (an omitted domain_id normalizes to the
  // default) is otherwise indistinguishable from a missing deployment, and
  // the journal cannot attribute the refusal after the fact.
  console.warn(JSON.stringify({
    kind: 'domain_expert_agent_not_configured',
    domain_id: manifest.domain_id,
    tool: toolName,
  }));
  throw new OperationError(
    'agent_not_configured',
    `${toolName} live cloud execution requires an agent entry in ${AGENT_ROUTING_ENV_VAR} for domain "${manifest.domain_id}".`,
    `Configure ${AGENT_ROUTING_ENV_VAR} for this domain before retrying.`,
  );
}

function throwDomainBackendNotConfigured(toolName: string): never {
  throw new OperationError(
    'domain_expert_not_configured',
    `${toolName} live execution is not configured in this Expert Agents runtime yet.`,
    'Use dry_run=true for the Phase 0 control-plane plan, or wire the OpenClaw runtime worker for Google/Gemini/Anna access.',
  );
}

function requireNonEmpty(value: string | undefined, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OperationError('invalid_params', `${name} must be a non-empty string.`);
  }
  return value.trim();
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'source';
}

function stableShortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0').slice(0, 7);
}
