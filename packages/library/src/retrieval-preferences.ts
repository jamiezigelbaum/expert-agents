/** Editorial ordering only. This module does not grant access or perform disclosure filtering. */
export type RetrievalPreferenceMode = "preferred" | "history";

export interface RetrievalPreferenceUnit {
  rag_file_id: string;
  unit_id: string;
  source_id: string;
  work_family: string;
  kind: string;
  priority: string;
}

export interface RetrievalPreferenceProfile {
  schema_version: 1;
  corpus: string;
  query_layer: {
    candidate_top_k: number;
    default_mode: RetrievalPreferenceMode;
    multipliers: Record<string, number>;
    max_per_work_default: number;
  };
  units: RetrievalPreferenceUnit[];
}

export interface RetrievalPreferenceContext {
  text?: string;
  sourceUri?: string;
  sourceDisplayName?: string;
  chunk?: { fileId?: string };
}

export interface RetrievalPreferenceOptions {
  corpus: string;
  mode?: RetrievalPreferenceMode;
  limit?: number;
  maxPerWork?: number;
}

export interface RetrievalPreferenceAnnotation {
  originalRank: number;
  multiplier: number;
  editorialScore: number;
  priority: string;
  unitId?: string;
  sourceId?: string;
  workFamily?: string;
  duplicateOriginalRanks: number[];
}

export interface RetrievalPreferenceResult<T> {
  contexts: T[];
  annotations: RetrievalPreferenceAnnotation[];
  diagnostics: {
    mode: RetrievalPreferenceMode;
    candidateCount: number;
    returnedCount: number;
    matchedCount: number;
    duplicateCount: number;
    diversityDeferredCount: number;
  };
}

const CORPUS = /^projects\/[A-Za-z0-9_-]+\/locations\/[A-Za-z0-9_-]+\/ragCorpora\/[A-Za-z0-9_-]+$/;
const FILE_ID = /^[A-Za-z0-9_-]+$/;
const LABEL = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const invalid = () => new Error("Invalid retrieval preference profile");

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) throw invalid();
  return value;
}

function boundedInteger(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw invalid();
  return value;
}

function modeValue(value: unknown): RetrievalPreferenceMode {
  if (value !== "preferred" && value !== "history") throw invalid();
  return value;
}

function fileId(value: string, corpus: string): string | undefined {
  if (FILE_ID.test(value)) return value;
  const prefix = `${corpus}/ragFiles/`;
  if (value.startsWith(prefix) && FILE_ID.test(value.slice(prefix.length))) return value.slice(prefix.length);
  return undefined;
}

/** Copies controlling fields; descriptive metadata is deliberately not interpreted or retained. */
export function parseRetrievalPreferenceProfile(value: unknown): RetrievalPreferenceProfile {
  try {
    const input = object(value);
    if (input.schema_version !== 1 || typeof input.corpus !== "string" || input.corpus.length > 512 || !CORPUS.test(input.corpus)) throw invalid();
    const layer = object(input.query_layer);
    const candidateTopK = boundedInteger(layer.candidate_top_k, 100);
    const rawMultipliers = object(layer.multipliers);
    const entries = Object.entries(rawMultipliers);
    if (entries.length === 0 || entries.length > 64) throw invalid();
    const multipliers: Record<string, number> = Object.create(null);
    for (const [key, weight] of entries) {
      if (!LABEL.test(key) || key === "__proto__" || key === "constructor" || key === "prototype" || typeof weight !== "number" || !Number.isFinite(weight) || weight < 0.5 || weight > 2) throw invalid();
      multipliers[key] = weight;
    }
    if (!Array.isArray(input.units) || input.units.length > 10000) throw invalid();
    const seen = new Set<string>();
    const units = Array.from(input.units, (value): RetrievalPreferenceUnit => {
      const unit = object(value);
      const ragFileId = fileId(identifier(unit.rag_file_id), input.corpus as string);
      const priority = identifier(unit.priority);
      if (!ragFileId || seen.has(ragFileId) || !Object.hasOwn(multipliers, priority)) throw invalid();
      seen.add(ragFileId);
      return {
        rag_file_id: ragFileId,
        unit_id: identifier(unit.unit_id),
        source_id: identifier(unit.source_id),
        work_family: identifier(unit.work_family),
        kind: identifier(unit.kind),
        priority,
      };
    });
    return {
      schema_version: 1,
      corpus: input.corpus,
      query_layer: {
        candidate_top_k: candidateTopK,
        default_mode: modeValue(layer.default_mode),
        multipliers,
        max_per_work_default: boundedInteger(layer.max_per_work_default, candidateTopK),
      },
      units,
    };
  } catch {
    // Do not include rejected values, parser causes, paths, or private metadata in errors.
    throw invalid();
  }
}

/** Relevance uses the supplied order, never text claims, titles, or score-like metadata. */
export function applyRetrievalPreferences<T extends RetrievalPreferenceContext>(
  contexts: readonly T[],
  profile: RetrievalPreferenceProfile,
  options: RetrievalPreferenceOptions,
): RetrievalPreferenceResult<T> {
  const policy = parseRetrievalPreferenceProfile(profile);
  if (options.corpus !== policy.corpus) throw new Error("Retrieval preference corpus mismatch");
  const mode = modeValue(options.mode ?? policy.query_layer.default_mode);
  const limit = boundedInteger(options.limit ?? policy.query_layer.candidate_top_k, policy.query_layer.candidate_top_k);
  const maxPerWork = boundedInteger(options.maxPerWork ?? policy.query_layer.max_per_work_default, policy.query_layer.candidate_top_k);
  if (!Array.isArray(contexts) || contexts.length > policy.query_layer.candidate_top_k) throw new Error("Retrieval preference candidate bound exceeded");
  const byFile = new Map(policy.units.map(unit => [unit.rag_file_id, unit]));
  const items = contexts.map((context, index) => {
    const rawFileId = context.chunk?.fileId;
    const id = typeof rawFileId === "string" ? fileId(rawFileId, policy.corpus) : undefined;
    // A foreign full resource cannot inherit preferences or identity from a bare suffix.
    const unit = id ? byFile.get(id) : undefined;
    const priority = unit?.priority ?? "unreviewed";
    const multiplier = mode === "history" || unit === undefined ? 1 : (policy.query_layer.multipliers[priority] ?? 1);
    const identity = unit ? `source:${unit.source_id}` : id ? `file:${id}` : rawFileId ? `resource:${rawFileId}` : context.sourceUri ? `uri:${context.sourceUri}` : `unknown:${index}`;
    const annotation: RetrievalPreferenceAnnotation = {
      originalRank: index + 1,
      multiplier,
      editorialScore: multiplier / (10 + index + 1),
      priority,
      ...(unit ? { unitId: unit.unit_id, sourceId: unit.source_id, workFamily: unit.work_family } : {}),
      duplicateOriginalRanks: [],
    };
    return { context, annotation, id, identity, work: unit ? `work:${unit.work_family}` : identity, unit };
  });
  let selected = items;
  let duplicateCount = 0;
  let diversityDeferredCount = 0;
  if (mode === "preferred") {
    const protectedFiles = new Set(items.filter(item => item.annotation.originalRank <= 5 && item.unit && item.annotation.multiplier > 1).map(item => item.id));
    selected = [...items].sort((a, b) => b.annotation.editorialScore - a.annotation.editorialScore || a.annotation.originalRank - b.annotation.originalRank);
    const seen = new Map<string, typeof items[number]>();
    selected = selected.filter(item => {
      const wording = item.context.text?.replace(/\s+/gu, " ").trim();
      if (!wording) return true;
      const key = JSON.stringify([item.identity, wording]);
      const previous = seen.get(key);
      if (previous) {
        previous.annotation.duplicateOriginalRanks.push(item.annotation.originalRank);
        duplicateCount++;
        return false;
      }
      seen.set(key, item);
      return true;
    });
    const counts = new Map<string, number>();
    const chosen: typeof items = [];
    const deferred: typeof items = [];
    for (const item of selected) {
      const count = counts.get(item.work) ?? 0;
      if (count >= maxPerWork && !(item.id && protectedFiles.has(item.id))) deferred.push(item);
      else {
        chosen.push(item);
        counts.set(item.work, count + 1);
      }
    }
    diversityDeferredCount = deferred.length;
    selected = [...chosen, ...deferred];
  }
  selected = selected.slice(0, limit);
  return {
    contexts: selected.map(item => item.context),
    annotations: selected.map(item => item.annotation),
    diagnostics: {
      mode,
      candidateCount: contexts.length,
      returnedCount: selected.length,
      matchedCount: items.filter(item => item.unit).length,
      duplicateCount,
      diversityDeferredCount,
    },
  };
}
