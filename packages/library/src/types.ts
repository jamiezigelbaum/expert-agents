export const LIBRARY_SCHEMA_VERSION = 1 as const;
export const SCOPE_SCHEMA_VERSION = 1 as const;

export type Sha256Id = `sha256:${string}`;

export interface LibraryLocationConfig {
  bucket: string;
  prefix: string;
}

export interface LibraryProvenance {
  acquiredBy: string;
  acquiredAt: string;
  acquisitionMethod: string;
}

export interface VersionLineage {
  supersedes: Sha256Id[];
  supersededBy: Sha256Id[];
}

export interface LibraryObject {
  id: Sha256Id;
  title?: string;
  creator?: string;
  sourceLocators: string[];
  mediaType: string;
  derivativeKind: string | null;
  byteSize: number;
  provenance: LibraryProvenance;
  trustTier: string;
  copyrightPosture: string;
  lineage: VersionLineage;
  createdAt: string;
  updatedAt: string;
  relativePath: string;
}

export interface ManifestTombstone {
  objectId: Sha256Id;
  revision: number;
  reason: string;
}

export interface MasterManifest {
  schemaVersion: typeof LIBRARY_SCHEMA_VERSION;
  revision: number;
  ingestionCursor: string | null;
  objects: LibraryObject[];
  tombstones: ManifestTombstone[];
  manifestHash: Sha256Id;
}

export interface ScopeIncludeFilters {
  trustTiers?: string[];
  kinds?: string[];
  locatorPrefixes?: string[];
}

export interface ScopeManifest {
  agentId: string;
  schemaVersion: typeof SCOPE_SCHEMA_VERSION;
  selection: {
    objectIds: Sha256Id[];
    includeFilters?: ScopeIncludeFilters;
  };
  targetCorpusDisplayName: string;
  masterRevision: number;
}
