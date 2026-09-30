import type { Sha256Id } from "./types.ts";

export interface SourceRegistryCandidate {
  lineNumber: number;
  domainId: string;
  locator: string;
  sourceKind: string | null;
  targetCorpusDisplayName: string | null;
  trustTier: string;
  copyrightPosture: string;
  ingestStatus: string;
  contentHash: Sha256Id | null;
  requires_hashing: boolean;
}

export interface SourceRegistryReadResult {
  candidates: SourceRegistryCandidate[];
  counts: {
    totalLines: number;
    parsedLines: number;
    malformedLines: number;
    emptyLines: number;
    requiresHashing: number;
  };
}

export interface CorpusMappingEntry {
  displayName: string;
  resourceName: string;
}

export interface CorpusMappingReadResult {
  entries: CorpusMappingEntry[];
  counts: {
    totalEntries: number;
    parsedEntries: number;
    malformedEntries: number;
  };
  documentMalformed: boolean;
}

export function readSourceRegistryCandidates(jsonlText: string): SourceRegistryReadResult {
  const lines = physicalLines(jsonlText);
  const candidates: SourceRegistryCandidate[] = [];
  let malformedLines = 0;
  let emptyLines = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]!;
    if (text.trim().length === 0) {
      emptyLines += 1;
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      const candidate = readRegistryRecord(parsed, index + 1);
      if (candidate === undefined) {
        malformedLines += 1;
      } else {
        candidates.push(candidate);
      }
    } catch {
      malformedLines += 1;
    }
  }
  return {
    candidates,
    counts: {
      totalLines: lines.length,
      parsedLines: candidates.length,
      malformedLines,
      emptyLines,
      requiresHashing: candidates.filter((candidate) => candidate.requires_hashing).length,
    },
  };
}

export function readCorpusMappingLedger(jsonText: string): CorpusMappingReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return {
      entries: [],
      counts: { totalEntries: 0, parsedEntries: 0, malformedEntries: 1 },
      documentMalformed: true,
    };
  }
  if (!isRecord(parsed)) {
    return {
      entries: [],
      counts: { totalEntries: 0, parsedEntries: 0, malformedEntries: 1 },
      documentMalformed: true,
    };
  }
  const pairs = Object.entries(parsed);
  const entries: CorpusMappingEntry[] = [];
  let malformedEntries = 0;
  for (const [displayName, resourceName] of pairs) {
    if (!isTrimmedNonEmpty(displayName) || !isTrimmedNonEmpty(resourceName)) {
      malformedEntries += 1;
      continue;
    }
    entries.push({ displayName, resourceName });
  }
  entries.sort((left, right) => compareStrings(left.displayName, right.displayName));
  return {
    entries,
    counts: {
      totalEntries: pairs.length,
      parsedEntries: entries.length,
      malformedEntries,
    },
    documentMalformed: false,
  };
}

function readRegistryRecord(value: unknown, lineNumber: number): SourceRegistryCandidate | undefined {
  if (!isRecord(value)) return undefined;
  const domainId = aliasedString(value, ["domain_id", "domainId", "domain"]);
  const locator = aliasedString(value, ["locator", "source_locator", "sourceLocator"]);
  const trustTier = aliasedString(value, ["trust_tier", "trustTier", "trust"]);
  const copyrightPosture = aliasedString(value, [
    "copyright_posture",
    "copyrightPosture",
    "copyright_status",
    "copyrightStatus",
  ]);
  const ingestStatus = aliasedString(value, ["ingest_status", "ingestStatus"]);
  if (domainId === undefined || locator === undefined || trustTier === undefined
    || copyrightPosture === undefined || ingestStatus === undefined) {
    return undefined;
  }
  const sourceKind = optionalAliasedString(value, ["source_kind", "sourceKind", "source_type", "sourceType"]);
  const targetCorpusDisplayName = optionalAliasedString(value, [
    "target_corpus_display_name",
    "targetCorpusDisplayName",
    "target_corpus",
    "targetCorpus",
  ]);
  if (sourceKind === false || targetCorpusDisplayName === false) return undefined;

  const hashValue = aliasedValue(value, ["content_hash", "contentHash"]);
  let contentHash: Sha256Id | null = null;
  if (hashValue !== undefined && hashValue !== null) {
    if (typeof hashValue !== "string" || !/^sha256:[a-f0-9]{64}$/.test(hashValue)) return undefined;
    contentHash = hashValue as Sha256Id;
  }
  return {
    lineNumber,
    domainId,
    locator,
    sourceKind: sourceKind ?? null,
    targetCorpusDisplayName: targetCorpusDisplayName ?? null,
    trustTier,
    copyrightPosture,
    ingestStatus,
    contentHash,
    requires_hashing: contentHash === null,
  };
}

function physicalLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function aliasedValue(record: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (name in record) return record[name];
  }
  return undefined;
}

function aliasedString(record: Record<string, unknown>, names: string[]): string | undefined {
  const value = aliasedValue(record, names);
  return isTrimmedNonEmpty(value) ? value : undefined;
}

function optionalAliasedString(record: Record<string, unknown>, names: string[]): string | undefined | false {
  const value = aliasedValue(record, names);
  if (value === undefined || value === null) return undefined;
  return isTrimmedNonEmpty(value) ? value : false;
}

function isTrimmedNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
