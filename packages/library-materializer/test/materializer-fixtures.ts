import {
  SCOPE_SCHEMA_VERSION,
  serializeScopeManifest,
  type ScopeManifest,
} from "@expert-agents/library";
import type {
  CandidateObjectMetadata,
  MaterializerCandidate,
} from "../src/index.ts";

export function candidate(path: string, value: Uint8Array): MaterializerCandidate {
  return {
    path,
    bytes: async () => value,
    metadata: candidateMetadata(path),
  };
}

export function candidateMetadata(path: string): CandidateObjectMetadata {
  return {
    sourceLocators: [`candidate://${path}`],
    mediaType: "text/plain",
    derivativeKind: null,
    provenance: {
      acquiredBy: "neutral-test-operator",
      acquiredAt: "2026-01-02T03:04:05.000Z",
      acquisitionMethod: "offline-fixture",
    },
    trustTier: "reviewed-fixture",
    copyrightPosture: "fixture-only",
    lineage: { supersedes: [], supersededBy: [] },
    createdAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-01-02T03:04:05.000Z",
  };
}

export function scopeText(
  objectIds: ScopeManifest["selection"]["objectIds"],
  masterRevision = 0,
  targetCorpusDisplayName = "neutral-agent-library",
): string {
  return serializeScopeManifest({
    agentId: "neutral-agent",
    schemaVersion: SCOPE_SCHEMA_VERSION,
    selection: { objectIds },
    targetCorpusDisplayName,
    masterRevision,
  });
}
