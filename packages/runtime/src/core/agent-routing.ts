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
}

export interface AgentRoutingIngestionConfig {
  /** Optional provider-written result receipts. Client submission receipts are always retained. */
  importResultSink?: 'client' | 'gcs';
}

export interface AgentRoutingEntry {
  domainId: string;
  displayName?: string;
  library: LibraryLocationConfig;
  targetCorpusDisplayName: string;
  scopeManifestPath?: string;
  retrieval?: AgentRoutingRetrievalConfig;
  ingestion?: AgentRoutingIngestionConfig;
  /**
   * Optional. Its absence is the declaration that no disclosure posture
   * applies, which is why every entry written before serving machinery
   * existed keeps behaving exactly as it did.
   */
  disclosure?: AgentDisclosureConfig;
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
    ['displayName', 'library', 'targetCorpusDisplayName', 'scopeManifestPath', 'retrieval', 'ingestion', 'disclosure'],
    'an entry',
  );
  if (!('library' in entry) || !('targetCorpusDisplayName' in entry)) {
    throw new AgentRoutingConfigError('an entry is missing a required field');
  }

  let library: LibraryLocationConfig;
  try {
    library = validateLibraryLocationConfig(entry.library);
  } catch {
    throw new AgentRoutingConfigError('an entry has an invalid library location');
  }

  const displayName = optionalNonEmptyString(entry.displayName, 'an entry displayName');
  const scopeManifestPath = optionalNonEmptyString(entry.scopeManifestPath, 'an entry scopeManifestPath');
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

  return {
    domainId,
    ...(displayName ? { displayName } : {}),
    library,
    targetCorpusDisplayName: requireNonEmptyString(
      entry.targetCorpusDisplayName,
      'an entry targetCorpusDisplayName',
    ),
    ...(scopeManifestPath ? { scopeManifestPath } : {}),
    ...(retrieval ? { retrieval } : {}),
    ...(ingestion ? { ingestion } : {}),
    ...(disclosure ? { disclosure } : {}),
  };
}

function validateRetrieval(value: unknown): AgentRoutingRetrievalConfig {
  const retrieval = requireRecord(value, 'an entry retrieval must be an object');
  requireExactKeys(retrieval, ['topK', 'contextLimit', 'reranker', 'multiQuery', 'preferenceProfilePath'], 'an entry retrieval');
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
  return Object.freeze(result);
}

function validateIngestion(value: unknown): AgentRoutingIngestionConfig {
  const ingestion = requireRecord(value, 'an entry ingestion must be an object');
  requireExactKeys(ingestion, ['importResultSink'], 'an entry ingestion');
  if (ingestion.importResultSink !== undefined && ingestion.importResultSink !== 'client' && ingestion.importResultSink !== 'gcs') {
    throw new AgentRoutingConfigError('an entry ingestion importResultSink must be client or gcs');
  }
  return Object.freeze(ingestion.importResultSink === undefined ? {} : { importResultSink: ingestion.importResultSink });
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
