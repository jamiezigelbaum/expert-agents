import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  validateLibraryLocationConfig,
  type LibraryLocationConfig,
} from '@expert-agents/library';
import {
  validateAgentDisclosureConfig,
  type AgentDisclosureConfig,
} from './disclosure.ts';

export const AGENT_ROUTING_ENV_VAR = 'EXPERT_AGENTS_DOMAIN_EXPERT_AGENTS_JSON';

export type AgentRoutingReranker = 'rank-service' | 'llm' | 'off';

export interface AgentRoutingRetrievalConfig {
  topK?: number;
  contextLimit?: number;
  reranker?: AgentRoutingReranker;
  multiQuery?: boolean;
  /** An operator-owned, atomically replaced profile. Not a model-supplied path. */
  preferenceProfilePath?: string;
  /**
   * With a preference profile and several corpora: the fewest answer contexts
   * the profile's corpus keeps when it holds passages at least as close as
   * those already chosen. Pooled ranking otherwise lets a large shelf crowd an
   * owner's own documents out before the profile ever sees them.
   */
  profileCorpusMinContexts?: number;
}

/** Acquisition operations a deployment can require to name their corpus explicitly. */
export const EXPLICIT_CORPUS_OPERATIONS = ['annas_archive_import', 'web_import'] as const;
export type ExplicitCorpusOperation = typeof EXPLICIT_CORPUS_OPERATIONS[number];

export interface AgentRoutingIngestionConfig {
  /** Optional provider-written result receipts. Client submission receipts are always retained. */
  importResultSink?: 'client' | 'gcs';
  /**
   * Optional. Operations listed here are refused without an explicit corpus_id
   * instead of defaulting to the domain's first configured corpus. Absent, every
   * operation keeps defaulting as before.
   */
  explicitCorpusRequiredFor?: ExplicitCorpusOperation[];
}

export interface AgentRoutingEntry {
  domainId: string;
  displayName?: string;
  /**
   * Where the domain's originals live. Required for a Vertex route; optional
   * for a page-library route, whose originals buckets pageLibrary names.
   */
  library?: LibraryLocationConfig;
  /** Existing source locations usable only for authorized RAG-file reads, never ingestion. */
  readOnlySourceRoots?: LibraryLocationConfig[];
  /** The Vertex corpus. Required unless the route declares pageLibrary. */
  targetCorpusDisplayName?: string;
  /**
   * Optional. The corpora domain_ask searches, in order. Absent, it searches
   * only targetCorpusDisplayName. A library that outgrows one corpus is split
   * into shelves listed here and searched in parallel.
   */
  servingCorpusDisplayNames?: string[];
  scopeManifestPath?: string;
  retrieval?: AgentRoutingRetrievalConfig;
  ingestion?: AgentRoutingIngestionConfig;
  /**
   * Optional. Its absence is the declaration that no disclosure posture
   * applies, which is why every entry written before serving machinery
   * existed keeps behaving exactly as it did.
   */
  disclosure?: AgentDisclosureConfig;
  /**
   * Optional. The page library (docs/page-library.md): an assembled tree of
   * page-addressed units on the worker host and the source id it was imported
   * under in the page search index (the index's database URL and Voyage key
   * are worker secrets, not routing). Absent, the domain_library tool refuses
   * for this domain.
   */
  pageLibrary?: AgentPageLibraryConfig;
}

export interface AgentPageLibraryConfig {
  /**
   * Absolute path of an assembled tree (catalog.json + books/) to serve from local disk.
   * Absent, the library is the page library database itself: its catalog and units are
   * read under `sourceId` through the serving database URL (docs/page-library.md).
   */
  root?: string;
  /** Library source id: the key of its catalog, units and search rows. */
  sourceId: string;
  /**
   * Buckets view_page may render originals from. Absent, the route's library
   * and read-only source roots; a route without either must list them here.
   */
  originalBuckets?: string[];
}

export type AgentRoutingConfig = Readonly<Record<string, Readonly<AgentRoutingEntry>>>;

export class AgentRoutingConfigError extends Error {
  readonly code = 'invalid_agent_routing_config';

  constructor(message: string) {
    super(`${AGENT_ROUTING_ENV_VAR} is invalid: ${message}`);
    this.name = 'AgentRoutingConfigError';
  }
}

export function agentRoutingConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
  readTextFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): AgentRoutingConfig {
  const raw = env[AGENT_ROUTING_ENV_VAR]?.trim();
  if (!raw) return Object.freeze({});

  let jsonText = raw;
  if (raw.startsWith('@')) {
    const path = raw.slice(1).trim();
    if (!path) throw new AgentRoutingConfigError('the @ file path is empty');
    try {
      jsonText = readTextFile(path);
    } catch {
      throw new AgentRoutingConfigError('the @ file could not be read');
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new AgentRoutingConfigError('the JSON document is malformed');
  }
  return validateAgentRoutingConfig(parsed);
}

export function validateAgentRoutingConfig(value: unknown): AgentRoutingConfig {
  const record = requireRecord(value, 'the top-level value must be an object');
  const entries: Record<string, Readonly<AgentRoutingEntry>> = {};
  for (const [domainId, entryValue] of Object.entries(record)) {
    if (!isDomainId(domainId)) {
      throw new AgentRoutingConfigError('a domain key is not a normalized domain id');
    }
    entries[domainId] = Object.freeze(validateRoutingEntry(domainId, entryValue));
  }
  return Object.freeze(entries);
}

function validateRoutingEntry(domainId: string, value: unknown): AgentRoutingEntry {
  const entry = requireRecord(value, 'an entry must be an object');
  requireExactKeys(
    entry,
    ['displayName', 'library', 'readOnlySourceRoots', 'targetCorpusDisplayName', 'servingCorpusDisplayNames', 'scopeManifestPath', 'retrieval', 'ingestion', 'disclosure', 'pageLibrary'],
    'an entry',
  );
  // A page-library route needs neither a Vertex corpus nor a library
  // location; every other route needs both.
  if (entry.pageLibrary === undefined && (!('library' in entry) || !('targetCorpusDisplayName' in entry))) {
    throw new AgentRoutingConfigError('an entry is missing a required field');
  }

  let library: LibraryLocationConfig | undefined;
  if (entry.library !== undefined) {
    try {
      library = validateLibraryLocationConfig(entry.library);
    } catch {
      throw new AgentRoutingConfigError('an entry has an invalid library location');
    }
  }

  const displayName = optionalNonEmptyString(entry.displayName, 'an entry displayName');
  let readOnlySourceRoots: LibraryLocationConfig[] | undefined;
  if (entry.readOnlySourceRoots !== undefined) {
    if (!Array.isArray(entry.readOnlySourceRoots) || entry.readOnlySourceRoots.length < 1 || entry.readOnlySourceRoots.length > 16) {
      throw new AgentRoutingConfigError('readOnlySourceRoots must list 1 to 16 non-root locations');
    }
    try { readOnlySourceRoots = entry.readOnlySourceRoots.map(value => Object.freeze(validateLibraryLocationConfig(value))); }
    catch { throw new AgentRoutingConfigError('a readOnlySourceRoots location is invalid'); }
    if (new Set(readOnlySourceRoots.map(root => `${root.bucket}/${root.prefix}`)).size !== readOnlySourceRoots.length) {
      throw new AgentRoutingConfigError('readOnlySourceRoots contains duplicates');
    }
    Object.freeze(readOnlySourceRoots);
  }
  const scopeManifestPath = optionalNonEmptyString(entry.scopeManifestPath, 'an entry scopeManifestPath');
  const targetCorpusDisplayName = optionalNonEmptyString(entry.targetCorpusDisplayName, 'an entry targetCorpusDisplayName');
  if (servingCorpusOrVertexOnly(entry) && targetCorpusDisplayName === undefined) {
    throw new AgentRoutingConfigError('an entry with Vertex retrieval settings needs targetCorpusDisplayName');
  }
  const servingCorpusDisplayNames = entry.servingCorpusDisplayNames === undefined
    ? undefined
    : validateServingCorpora(entry.servingCorpusDisplayNames);
  const retrieval = entry.retrieval === undefined
    ? undefined
    : validateRetrieval(entry.retrieval);
  const ingestion = entry.ingestion === undefined ? undefined : validateIngestion(entry.ingestion);

  let disclosure: AgentDisclosureConfig | undefined;
  if (entry.disclosure !== undefined) {
    try {
      disclosure = Object.freeze(validateAgentDisclosureConfig(entry.disclosure));
    } catch {
      throw new AgentRoutingConfigError('an entry has an invalid disclosure block');
    }
  }

  const pageLibrary = entry.pageLibrary === undefined ? undefined : validatePageLibrary(entry.pageLibrary);
  if (pageLibrary && !pageLibrary.originalBuckets && !library && !readOnlySourceRoots) {
    throw new AgentRoutingConfigError('pageLibrary needs originalBuckets when the entry has no library');
  }

  return {
    domainId,
    ...(displayName ? { displayName } : {}),
    ...(library ? { library } : {}),
    ...(readOnlySourceRoots ? { readOnlySourceRoots } : {}),
    ...(targetCorpusDisplayName ? { targetCorpusDisplayName } : {}),
    ...(servingCorpusDisplayNames ? { servingCorpusDisplayNames } : {}),
    ...(scopeManifestPath ? { scopeManifestPath } : {}),
    ...(retrieval ? { retrieval } : {}),
    ...(ingestion ? { ingestion } : {}),
    ...(disclosure ? { disclosure } : {}),
    ...(pageLibrary ? { pageLibrary } : {}),
  };
}

function validatePageLibrary(value: unknown): AgentPageLibraryConfig {
  const entry = requireRecord(value, 'pageLibrary must be an object');
  requireExactKeys(entry, ['root', 'sourceId', 'originalBuckets'], 'pageLibrary');
  const root = entry.root === undefined ? undefined : requireNonEmptyString(entry.root, 'pageLibrary root');
  if (root !== undefined && (!root.startsWith('/') || root.split('/').includes('..'))) throw new AgentRoutingConfigError('pageLibrary root must be an absolute path');
  const sourceId = requireNonEmptyString(entry.sourceId, 'pageLibrary sourceId');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(sourceId)) throw new AgentRoutingConfigError('pageLibrary sourceId is invalid');
  let originalBuckets: string[] | undefined;
  if (entry.originalBuckets !== undefined) {
    if (!Array.isArray(entry.originalBuckets) || entry.originalBuckets.length < 1 || entry.originalBuckets.length > 16
      || entry.originalBuckets.some((b) => typeof b !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,221}[a-z0-9]$/.test(b))) {
      throw new AgentRoutingConfigError('pageLibrary originalBuckets must list 1 to 16 bucket names');
    }
    originalBuckets = Object.freeze([...new Set(entry.originalBuckets as string[])]) as string[];
  }
  return Object.freeze({ ...(root !== undefined ? { root } : {}), sourceId, ...(originalBuckets ? { originalBuckets } : {}) });
}

/** The buckets view_page may read originals from: explicit, else the route's library locations. */
export function pageLibraryOriginalBuckets(route: Pick<AgentRoutingEntry, 'library' | 'readOnlySourceRoots' | 'pageLibrary'>): string[] {
  if (route.pageLibrary?.originalBuckets) return [...route.pageLibrary.originalBuckets];
  return [...new Set([...(route.library ? [route.library] : []), ...(route.readOnlySourceRoots ?? [])].map((r) => r.bucket))];
}

// Settings that only mean something for a Vertex corpus.
function servingCorpusOrVertexOnly(entry: Record<string, unknown>): boolean {
  return entry.servingCorpusDisplayNames !== undefined || entry.scopeManifestPath !== undefined || entry.retrieval !== undefined;
}

function validateServingCorpora(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) {
    throw new AgentRoutingConfigError('an entry servingCorpusDisplayNames must list 1 to 10 corpora');
  }
  const names = value.map((name) => requireNonEmptyString(name, 'an entry servingCorpusDisplayNames item'));
  if (new Set(names).size !== names.length) {
    throw new AgentRoutingConfigError('an entry servingCorpusDisplayNames has duplicates');
  }
  return Object.freeze(names) as string[];
}

function validateRetrieval(value: unknown): AgentRoutingRetrievalConfig {
  const retrieval = requireRecord(value, 'an entry retrieval must be an object');
  requireExactKeys(retrieval, ['topK', 'contextLimit', 'reranker', 'multiQuery', 'preferenceProfilePath', 'profileCorpusMinContexts'], 'an entry retrieval');
  const result: AgentRoutingRetrievalConfig = {};
  if (retrieval.topK !== undefined) {
    result.topK = requirePositiveInteger(retrieval.topK, 'an entry retrieval topK', 100);
  }
  if (retrieval.contextLimit !== undefined) {
    result.contextLimit = requirePositiveInteger(retrieval.contextLimit, 'an entry retrieval contextLimit', 100);
  }
  if (retrieval.reranker !== undefined) {
    if (retrieval.reranker !== 'rank-service' && retrieval.reranker !== 'llm' && retrieval.reranker !== 'off') {
      throw new AgentRoutingConfigError('an entry retrieval reranker is unsupported');
    }
    result.reranker = retrieval.reranker;
  }
  if (retrieval.multiQuery !== undefined) {
    if (typeof retrieval.multiQuery !== 'boolean') {
      throw new AgentRoutingConfigError('an entry retrieval multiQuery must be a boolean');
    }
    result.multiQuery = retrieval.multiQuery;
  }
  if (retrieval.preferenceProfilePath !== undefined) {
    const path = requireNonEmptyString(retrieval.preferenceProfilePath, 'an entry retrieval preferenceProfilePath');
    if (!isAbsolute(path) || path.length > 4096 || /[\u0000-\u001f]/.test(path)) {
      throw new AgentRoutingConfigError('an entry retrieval preferenceProfilePath must be an absolute file path');
    }
    result.preferenceProfilePath = path;
  }
  if (retrieval.profileCorpusMinContexts !== undefined) {
    if (result.preferenceProfilePath === undefined) {
      throw new AgentRoutingConfigError('an entry retrieval profileCorpusMinContexts requires preferenceProfilePath');
    }
    result.profileCorpusMinContexts = requirePositiveInteger(retrieval.profileCorpusMinContexts, 'an entry retrieval profileCorpusMinContexts', 100);
  }
  return Object.freeze(result);
}

function validateIngestion(value: unknown): AgentRoutingIngestionConfig {
  const ingestion = requireRecord(value, 'an entry ingestion must be an object');
  requireExactKeys(ingestion, ['importResultSink', 'explicitCorpusRequiredFor'], 'an entry ingestion');
  if (ingestion.importResultSink !== undefined && ingestion.importResultSink !== 'client' && ingestion.importResultSink !== 'gcs') {
    throw new AgentRoutingConfigError('an entry ingestion importResultSink must be client or gcs');
  }
  const explicitCorpusRequiredFor = ingestion.explicitCorpusRequiredFor === undefined
    ? undefined
    : validateExplicitCorpusOperations(ingestion.explicitCorpusRequiredFor);
  return Object.freeze({
    ...(ingestion.importResultSink === undefined ? {} : { importResultSink: ingestion.importResultSink }),
    ...(explicitCorpusRequiredFor ? { explicitCorpusRequiredFor } : {}),
  }) as AgentRoutingIngestionConfig;
}

function validateExplicitCorpusOperations(value: unknown): ExplicitCorpusOperation[] {
  const allowed: readonly string[] = EXPLICIT_CORPUS_OPERATIONS;
  if (!Array.isArray(value) || value.length === 0
    || value.some((operation) => typeof operation !== 'string' || !allowed.includes(operation))) {
    throw new AgentRoutingConfigError(
      `an entry ingestion explicitCorpusRequiredFor must list one or more of: ${EXPLICIT_CORPUS_OPERATIONS.join(', ')}`,
    );
  }
  if (new Set(value).size !== value.length) {
    throw new AgentRoutingConfigError('an entry ingestion explicitCorpusRequiredFor has duplicates');
  }
  return Object.freeze([...value]) as ExplicitCorpusOperation[];
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentRoutingConfigError(message);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, allowed: string[], name: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedSet.has(key))) {
    throw new AgentRoutingConfigError(`${name} contains an unknown field`);
  }
}

function optionalNonEmptyString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requireNonEmptyString(value, name);
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AgentRoutingConfigError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function requirePositiveInteger(value: unknown, name: string, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new AgentRoutingConfigError(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return value as number;
}

function isDomainId(value: string): boolean {
  return value.length <= 64 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value);
}
