// Parsing and validation of incoming worker requests.
import {
  parseDomainAgentAction, type AnnasArchiveImportParams, type AnnasArchiveSearchParams,
  type DomainAgentParams,
} from '../../core/domain-expert.ts';
import { asRecord, optionalStringField, optionalBooleanField, optionalNumberField, requireString } from './worker-util.ts';
import { optionalAnnasFormatPreference, optionalAnnasFormat } from './acquisition.ts';
import { DomainExpertWorkerError } from './worker-errors.ts';

type DomainExpertTool =
  | 'domain_agent'
  | 'domain_library'
  | 'library_ingest'
  | 'annas_archive_search'
  | 'annas_archive_import';

export interface DomainExpertRequest {
  tool: DomainExpertTool;
  params: Record<string, unknown>;
}

export function parseDomainExpertRequest(request: Request): Promise<DomainExpertRequest> {
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

export function parseDomainAgentParams(params: Record<string, unknown>): DomainAgentParams {
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

export function parseAnnasArchiveSearchParams(params: Record<string, unknown>): AnnasArchiveSearchParams {
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

export function parseAnnasArchiveImportParams(params: Record<string, unknown>): AnnasArchiveImportParams {
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
