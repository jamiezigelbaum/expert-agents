import { readFileSync } from 'node:fs';
import {
  validateLibraryLocationConfig,
  type LibraryLocationConfig,
} from '@expert-agents/library';
import {
  validateAgentDisclosureConfig,
  type AgentDisclosureConfig,
} from './disclosure.ts';

export const AGENT_ROUTING_ENV_VAR = 'EXPERT_AGENTS_DOMAIN_EXPERT_AGENTS_JSON';

export interface AgentRoutingEntry {
  domainId: string;
  displayName?: string;
  /** Where the domain's originals live. Optional when pageLibrary names its originals buckets. */
  library?: LibraryLocationConfig;
  /** Existing source locations whose originals may be read and ingested, never written. */
  readOnlySourceRoots?: LibraryLocationConfig[];
  scopeManifestPath?: string;
  /**
   * Optional. Its absence is the declaration that no disclosure posture
   * applies, which is why every entry written before serving machinery
   * existed keeps behaving exactly as it did.
   */
  disclosure?: AgentDisclosureConfig;
  /**
   * The page library (docs/page-library.md): an assembled tree of page-addressed
   * units on the worker host, or a library in the page library database, and the
   * source id it was imported under in the page search index (the index's
   * database URL and Voyage key are worker secrets, not routing).
   */
  pageLibrary: AgentPageLibraryConfig;
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
   * The named database `sourceId` lives in (a worker reads it through
   * EXPERT_AGENTS_DOMAIN_EXPERT_PAGE_LIBRARY_DATABASE_URL_<NAME>). Absent, the
   * default page-library database. Never together with `root`, and never on a
   * route with a disclosure policy.
   */
  database?: string;
  /** Further libraries this route reads alongside the primary one (no `root`). */
  also?: Array<{ sourceId: string; database?: string }>;
  /**
   * Buckets view_page may render originals from. Absent, the route's library
   * and read-only source roots; a route without either must list them here.
   */
  originalBuckets?: string[];
}

/**
 * Keys of the retired Vertex AI retrieval routes. Live routing files and persisted
 * registrations written before 2026-10-25 still carry them, so they are accepted
 * and dropped; they configure nothing.
 */
export const RETIRED_VERTEX_ROUTING_KEYS = ['targetCorpusDisplayName', 'servingCorpusDisplayNames', 'retrieval', 'ingestion'] as const;

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
    ['displayName', 'library', 'readOnlySourceRoots', 'scopeManifestPath', 'disclosure', 'pageLibrary', ...RETIRED_VERTEX_ROUTING_KEYS],
    'an entry',
  );
  if (entry.pageLibrary === undefined) throw new AgentRoutingConfigError('an entry is missing pageLibrary');

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

  let disclosure: AgentDisclosureConfig | undefined;
  if (entry.disclosure !== undefined) {
    try {
      disclosure = Object.freeze(validateAgentDisclosureConfig(entry.disclosure));
    } catch {
      throw new AgentRoutingConfigError('an entry has an invalid disclosure block');
    }
  }

  const pageLibrary = validatePageLibrary(entry.pageLibrary);
  // A private library must never reach a public (disclosed) deployment.
  if (disclosure && (pageLibrary.database !== undefined || pageLibrary.also?.some((a) => a.database !== undefined))) {
    throw new AgentRoutingConfigError('a route served under a disclosure policy cannot read a named (private) page library');
  }
  if (!pageLibrary.originalBuckets && !library && !readOnlySourceRoots) {
    throw new AgentRoutingConfigError('pageLibrary needs originalBuckets when the entry has no library');
  }

  return {
    domainId,
    ...(displayName ? { displayName } : {}),
    ...(library ? { library } : {}),
    ...(readOnlySourceRoots ? { readOnlySourceRoots } : {}),
    ...(scopeManifestPath ? { scopeManifestPath } : {}),
    ...(disclosure ? { disclosure } : {}),
    pageLibrary,
  };
}

function validatePageLibrary(value: unknown): AgentPageLibraryConfig {
  const entry = requireRecord(value, 'pageLibrary must be an object');
  requireExactKeys(entry, ['root', 'sourceId', 'database', 'also', 'originalBuckets'], 'pageLibrary');
  const root = entry.root === undefined ? undefined : requireNonEmptyString(entry.root, 'pageLibrary root');
  if (root !== undefined && (!root.startsWith('/') || root.split('/').includes('..'))) throw new AgentRoutingConfigError('pageLibrary root must be an absolute path');
  const sourceId = requireNonEmptyString(entry.sourceId, 'pageLibrary sourceId');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(sourceId)) throw new AgentRoutingConfigError('pageLibrary sourceId is invalid');
  const database = entry.database === undefined ? undefined : validateDatabaseName(entry.database, 'pageLibrary database');
  if (root !== undefined && database !== undefined) throw new AgentRoutingConfigError('pageLibrary root cannot be combined with database');
  let also: Array<{ sourceId: string; database?: string }> | undefined;
  if (entry.also !== undefined) {
    if (!Array.isArray(entry.also) || entry.also.length < 1 || entry.also.length > 8) throw new AgentRoutingConfigError('pageLibrary also must list 1 to 8 libraries');
    const seen = new Set([`${database ?? ''}\u0000${sourceId}`]);
    also = entry.also.map((item) => {
      const rec = requireRecord(item, 'a pageLibrary also item must be an object');
      requireExactKeys(rec, ['sourceId', 'database'], 'a pageLibrary also item');
      const id = requireNonEmptyString(rec.sourceId, 'a pageLibrary also sourceId');
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new AgentRoutingConfigError('a pageLibrary also sourceId is invalid');
      const db = rec.database === undefined ? undefined : validateDatabaseName(rec.database, 'a pageLibrary also database');
      const key = `${db ?? ''}\u0000${id}`;
      if (seen.has(key)) throw new AgentRoutingConfigError('pageLibrary lists the same library twice');
      seen.add(key);
      return Object.freeze({ sourceId: id, ...(db !== undefined ? { database: db } : {}) });
    });
    Object.freeze(also);
  }
  let originalBuckets: string[] | undefined;
  if (entry.originalBuckets !== undefined) {
    if (!Array.isArray(entry.originalBuckets) || entry.originalBuckets.length < 1 || entry.originalBuckets.length > 16
      || entry.originalBuckets.some((b) => typeof b !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,221}[a-z0-9]$/.test(b))) {
      throw new AgentRoutingConfigError('pageLibrary originalBuckets must list 1 to 16 bucket names');
    }
    originalBuckets = Object.freeze([...new Set(entry.originalBuckets as string[])]) as string[];
  }
  return Object.freeze({
    ...(root !== undefined ? { root } : {}), sourceId, ...(database !== undefined ? { database } : {}), ...(also ? { also } : {}),
    ...(originalBuckets ? { originalBuckets } : {}),
  });
}

/** A named page-library database: lowercase slug, so its env var name is unambiguous. */
export const PAGE_LIBRARY_DATABASE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

function validateDatabaseName(value: unknown, label: string): string {
  const name = requireNonEmptyString(value, label);
  if (!PAGE_LIBRARY_DATABASE_NAME.test(name)) throw new AgentRoutingConfigError(`${label} is invalid`);
  return name;
}

/** The libraries a route reads, primary first. */
export function pageLibraryMembers(config: Pick<AgentPageLibraryConfig, 'sourceId' | 'database' | 'also'>): Array<{ sourceId: string; database?: string }> {
  return [{ sourceId: config.sourceId, ...(config.database !== undefined ? { database: config.database } : {}) }, ...(config.also ?? [])];
}

/** The buckets view_page may read originals from: explicit, else the route's library locations. */
export function pageLibraryOriginalBuckets(route: Pick<AgentRoutingEntry, 'library' | 'readOnlySourceRoots' | 'pageLibrary'>): string[] {
  if (route.pageLibrary.originalBuckets) return [...route.pageLibrary.originalBuckets];
  return [...new Set([...(route.library ? [route.library] : []), ...(route.readOnlySourceRoots ?? [])].map((r) => r.bucket))];
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

function isDomainId(value: string): boolean {
  return value.length <= 64 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value);
}
