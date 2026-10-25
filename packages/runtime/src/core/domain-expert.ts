import { EXTRACTION_METHOD } from '@expert-agents/library';
import { OperationError } from './operation-error.ts';
import {
  AGENT_ROUTING_ENV_VAR,
  agentRoutingConfigFromEnv,
  type AgentRoutingConfig,
} from './agent-routing.ts';

export const DOMAIN_AGENT_ACTIONS = ['bootstrap', 'status', 'catalog', 'register'] as const;
export type DomainAgentAction = typeof DOMAIN_AGENT_ACTIONS[number];

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

export const ANNAS_ARCHIVE_FORMATS = ['pdf', 'epub', 'mobi', 'azw3', 'djvu', 'unknown'] as const;
export type AnnasArchiveFormat = typeof ANNAS_ARCHIVE_FORMATS[number];

export interface DomainManifest {
  domain_id: string;
  display_name: string;
  workspace_root_id: string;
  workspace_relative_path: string;
  inbox_relative_path: string;
  library_aliases: string[];
  canonical_resource_paths: string[];
  allowed_gcs_prefixes: string[];
  routing: {
    configured: boolean;
    source_env: typeof AGENT_ROUTING_ENV_VAR;
    library?: { bucket: string; prefix: string; uri: string };
    page_library?: { source_id: string };
    scope_manifest_path?: string;
  };
  trust_posture: 'cloud_eligible_with_source_review';
  resource_wiki_namespace: string;
  eval_set: string;
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
  /** Register with a page library: {} (the tree and index source follow from the domain id). */
  pageLibrary?: unknown;
  approvalId?: string;
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
  // The caller intends to ingest what it picks: rank by what the page library
  // reads (PDF and EPUB) ahead of formats it cannot, instead of by reading
  // preference alone.
  ingestIntent?: boolean;
}

export interface AnnasArchiveImportParams {
  domainId?: string;
  annasArchiveId?: string;
  url?: string;
  format?: AnnasArchiveFormat;
  /** Page-library ingest: which of the route's libraries gets the book (required when it reads several). */
  sourceId?: string;
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
const RUNTIME_SECRET_REF = 'task-scoped credential adapter';
const ANNAS_ARCHIVE_SECRET_NAME = 'Annas-Archive-API-Key';
export const ANNAS_ARCHIVE_SEARCH_LIMIT_MAX = 50;

export function parseDomainAgentAction(value: unknown): DomainAgentAction {
  return parseEnum(value, DOMAIN_AGENT_ACTIONS, 'action');
}

export function optionalWebImportTranscriptMode(value: unknown): WebImportTranscriptMode | undefined {
  return value === undefined || value === null || value === ''
    ? undefined
    : parseEnum(value, WEB_IMPORT_TRANSCRIPT_MODES, 'transcript_mode');
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
  const libraryUri = routing?.library ? `gs://${routing.library.bucket}/${routing.library.prefix}` : undefined;
  return {
    domain_id: domainId,
    display_name: title,
    workspace_root_id: 'expert_agents_workspace',
    workspace_relative_path: workspaceRelativePath,
    inbox_relative_path: `${workspaceRelativePath}/inbox`,
    library_aliases: [`${resourceName} alias`],
    canonical_resource_paths: [`libraries/${domainId}/books`, `libraries/${domainId}/sources`],
    allowed_gcs_prefixes: libraryUri ? [libraryUri] : [],
    routing: routing
      ? {
          configured: true,
          source_env: AGENT_ROUTING_ENV_VAR,
          ...(routing.library ? { library: { ...routing.library, uri: libraryUri! } } : {}),
          ...(routing.pageLibrary ? { page_library: { source_id: routing.pageLibrary.sourceId } } : {}),
          ...(routing.scopeManifestPath ? { scope_manifest_path: routing.scopeManifestPath } : {}),
        }
      : { configured: false, source_env: AGENT_ROUTING_ENV_VAR },
    trust_posture: 'cloud_eligible_with_source_review',
    resource_wiki_namespace: `03 Resources/${resourceName}`,
    eval_set: 'eval/questions.jsonl',
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
      scoped_tools: ['domain_library', 'library_ingest', 'annas_archive_search', 'annas_archive_import', 'expert_agents_workspace'],
    },
    policy: domainPolicy(),
    next_steps: [
      'Materialize these paths through the bounded workspace adapter or live OpenClaw runtime.',
      'Initialize version control and wire the private remote before the workspace accumulates working memory.',
      'Ingest approved sources into the page library with library_ingest before asking grounded questions.',
    ],
  };
}

function operatingSkillForDomain(domainId: string): string {
  return domainId === DEFAULT_DOMAIN_ID ? DEFAULT_OPERATING_SKILL : `${domainId}-research`;
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
      'Ask for import/copyright approval before downloading files into the configured books folder or the page library.',
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
  // The download is owner-authorized by the naming; an ingest for a domain
  // without a page library is reported blocked at execution time, and the
  // download is kept. Kept in agreement with the worker's gate.
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
    rag_ingest: !params.ingest
      ? { status: 'not_requested' }
      : manifest.routing.page_library
      ? { status: 'planned', target: 'page_library' }
      : { status: 'blocked', reason: 'This domain has no page library; the download would be kept and nothing ingested.' },
    format_preference: {
      default: 'epub_for_text_pdf_for_layout_heavy',
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
      'with ingest, queue a library_ingest job into the domain\'s page library',
    ],
    policy: domainPolicy(),
  };
}

function parseEnum<T extends readonly string[]>(value: unknown, allowed: T, name: string): T[number] {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new OperationError('invalid_params', `${name} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T[number];
}

/** The policy stamp on every result. */
export function domainPolicy(): Record<string, unknown> {
  return {
    expert_agents_control_plane_only: true,
    backend: 'page_library',
    host_source_contracts_unchanged: true,
    per_question_answer_logic_in_runtime: false,
    raw_runtime_secrets_exposed: false,
    library_ingest_requires_source_review: true,
  };
}

function compactDomain(manifest: DomainManifest): Record<string, unknown> {
  return {
    domain_id: manifest.domain_id,
    display_name: manifest.display_name,
    workspace_root_id: manifest.workspace_root_id,
    workspace_relative_path: manifest.workspace_relative_path,
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

/** The domain reads its page library (domain_library). */
export function servesPageLibrary(manifest: DomainManifest): boolean {
  return Boolean(manifest.routing.page_library);
}

function throwDomainBackendNotConfigured(toolName: string): never {
  throw new OperationError(
    'domain_expert_not_configured',
    `${toolName} live execution is not configured in this Expert Agents runtime yet.`,
    'Use dry_run=true for the Phase 0 control-plane plan, or wire the OpenClaw runtime worker for Google/Gemini/Anna access.',
  );
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
