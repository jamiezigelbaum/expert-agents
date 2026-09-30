# Shared library architecture

## Owner ruling and boundary

Expert Agents has one shared knowledge library. All acquired canonical bytes
have one upload destination: a configured Google Cloud Storage bucket and
prefix with one versioned master manifest. Per-agent Vertex RAG corpora are
materialized views of that library. Duplicate embeddings between views are an
accepted cost.

The library location is configuration, never a value derived from an agent or
domain ID:

```text
gs://<configured-bucket>/<configured-prefix>/objects/sha256/<first-two-hex>/<64-hex>
```

The `@expert-agents/library` package defines this contract and its deterministic
planner. It is pure TypeScript using only Node built-ins. It makes no network or
cloud calls and writes no files. This tranche does not change runtime ingestion
or worker routing.

## Canonical object identity

A `LibraryObject.id` is `sha256:<64 lowercase hex>` computed from the canonical
object bytes. The object record carries metadata about those bytes but does not
change their identity. Its `relativePath` is derived only from the ID:

```text
objects/sha256/<first-two-hex>/<64-hex>
```

Joining that relative path to the configured bucket and prefix yields the only
canonical object URI. The package does not generate a bucket or prefix.

Every `LibraryObject` has these fields:

- `id`: content-addressed SHA-256 ID.
- optional `title` and `creator`: non-empty human-facing metadata. These fields
  describe the canonical bytes but do not participate in object identity.
- `sourceLocators`: a non-empty, sorted, unique list of source locators.
- `mediaType` and nullable `derivativeKind`: the media and derivative
  classification used by scope filters.
- `byteSize`: a non-negative integer.
- `provenance`: `acquiredBy`, canonical UTC `acquiredAt`, and
  `acquisitionMethod`.
- `trustTier` and `copyrightPosture`: explicit source-governance posture.
- `lineage`: sorted, unique `supersedes` and `supersededBy` object-ID lists.
- `createdAt` and `updatedAt`: canonical UTC timestamps supplied by the caller.
  Pure package functions never read the clock.
- `relativePath`: the exact ID-derived path described above.

Set-like arrays must already be sorted and unique. Timestamps use the canonical
JavaScript UTC form with milliseconds, for example
`2026-01-02T03:04:05.000Z`.

## Master manifest

`MasterManifest` is the sole versioned inventory of canonical library objects:

- `schemaVersion`: currently `1`.
- `revision`: a monotonically increasing, non-negative integer.
- `ingestionCursor`: a nullable opaque string.
- `objects`: live `LibraryObject` records sorted by ID.
- `tombstones`: records sorted by object ID, each containing `objectId`, the
  positive manifest `revision` at removal, and a non-empty `reason`.
- `manifestHash`: SHA-256 of the canonical manifest serialization with this
  field omitted.

An ID cannot be both live and tombstoned. Tombstoned IDs cannot be introduced
again. A tombstone retains no source content or locator data.

## Canonical serialization and hashing

Contract documents use canonical JSON with recursively sorted object keys,
two-space indentation, JSON array order preserved, and exactly one trailing
newline. Undefined values, non-finite numbers, non-plain objects, unknown
schema fields, and noncanonical set ordering are rejected.

`contentIdFromBytes` hashes canonical object bytes. `manifestHash` hashes the
canonical JSON of all master-manifest fields except `manifestHash` itself.
Canonical document parsers require this byte representation and verify the
manifest hash, so parsing and serializing any accepted document is
byte-identical.

## Atomic manifest updates

`applyManifestUpdate(current, update)` is a pure compare-and-set operation.
`update.expectedRevision` must equal the current revision. Cursor advancement
also supplies `from` and `to`; `from` must equal the current opaque cursor.

One update may atomically:

- add validated objects;
- link a prior and replacement object in both directions with a caller-supplied
  `updatedAt` timestamp;
- annotate a live object with at least one of `title` or `creator` and a
  caller-supplied `updatedAt` timestamp;
- tombstone live objects with a reason; and
- advance the ingestion cursor.

The operation rejects empty updates, revision or cursor races, duplicate IDs,
duplicate supersession edges, unknown supersession endpoints, replacement IDs
that are being tombstoned, additions of current or historical tombstone IDs,
same-update add/tombstone conflicts, duplicate annotation targets, annotations
of unknown or tombstoned IDs, annotation entries with no applied field, and
supersession cycles. The supported replacement transaction is add replacement,
link supersession, then tombstone the prior object in one call.

Every accepted update increments the revision by exactly one, assigns that
revision to new tombstones, sorts the resulting sets, and recomputes
`manifestHash`. Inputs are not mutated. Errors identify only fields, counts,
revisions, cursors as a conflict category, and content-addressed IDs; they do
not include source text, locators, annotation values, or tombstone reasons.

The root `library:annotate` command follows a review-first workflow. `--propose`
reads the master manifest and writes local title/creator proposals derived from
source-locator basenames without changing GCS. `--execute` accepts a reviewed
annotations document, applies the annotation operation with the same
generation compare-and-set discipline as materialization, and writes a
deterministic content-free receipt containing only counts, object IDs, applied
field names, revision movement, and CAS-conflict counts.

## Agent-owned scope manifests

A `ScopeManifest` belongs in the repository of the agent that owns the
materialized view. Scope manifests do not live in this machinery repository or
the shared library bucket. Each contains:

The scope manifest and retrieval eval set are required parts of the independent
[agent repository contract](./AGENT_REPO_CONTRACT.md).

- `agentId` and `schemaVersion` (`1`);
- `selection.objectIds`, a sorted, unique explicit ID list;
- optional `selection.includeFilters` containing one or more sorted, non-empty
  lists of `trustTiers`, `kinds`, or `locatorPrefixes`;
- `targetCorpusDisplayName`; and
- `masterRevision`, the master revision against which the scope was authored.

Explicit IDs are unioned with the filter result. Within one filter dimension,
values are ORed; populated dimensions are ANDed. `kinds` can match either an
object's `mediaType` or non-null `derivativeKind`. An older authored revision is
valid for planning against a newer master; a future authored revision is
rejected.

## Reconciliation plan

`planReconciliation` compares a verified master manifest, one verified scope
manifest, and a version-1 materialization ledger of object-ID/RAG-file-ID pairs
with an optional `targetCorpusDisplayName` corpus key.
It returns a version-1, canonically serializable receipt-shaped plan containing
sorted:

- `imports`: selected objects absent from the ledger, identified by object ID
  and ID-derived relative path;
- `alreadyMaterialized`: selected entries already in the ledger;
- `retractions`: ledger entries outside the desired selection, always with
  `dry_run_only: true` in this tranche; and
- `unresolvableSelections`: explicit IDs missing from the master and a
  content-free description of an include-filter group that matched nothing.

The plan also includes the agent and corpus identifiers, master and authored
revisions, and summary counts. It never contains source locators, filter values,
source text, canonical bytes, credentials, or cloud operations. Equal inputs
produce byte-identical serialized plans.

A selected object is already materialized only when its ledger entry carries a
`targetCorpusDisplayName` equal to the scope target. An entry for an earlier
target, or a legacy entry without the optional field, is planned as an import.
This prevents a corpus retarget from treating the old corpus as current.

## Compatibility readers

Two read-only helpers allow rehearsal against current local state without a
migration:

- `readSourceRegistryCandidates(jsonlText)` lifts valid source-registry records,
  normalizes supported snake-case and camel-case fields, maps trust and
  copyright posture, marks absent content hashes as `requires_hashing`, and
  reports total, parsed, malformed, empty, and unhashed line counts.
- `readCorpusMappingLedger(jsonText)` returns sorted display-name/resource-name
  pairs and counts malformed entries or a malformed document.

These helpers consume caller-provided text. They do not open, alter, or replace
the registry, mapping cache, manifest, or any workspace file.

## Append-only materializer

Tranche 3 adds `@expert-agents/library-materializer`, a bounded executor around
the Tranche 1 contract. It receives candidate bytes with explicit caller-supplied
governance metadata, hashes the bytes, uploads only missing canonical objects,
appends their records to the master manifest, plans the agent scope, and imports
only missing selected objects into the target Vertex corpus. The package has
narrow injected GCS and Vertex interfaces; all orchestration tests use in-memory
fakes with real generation semantics. CI makes no network or cloud calls.

The configured library root has this fixed layout:

```text
gs://<bucket>/<prefix>/objects/sha256/<first-two-hex>/<64-hex>
gs://<bucket>/<prefix>/manifest/master.json
gs://<bucket>/<prefix>/ledgers/<agentId>.json
```

The object path is the Tranche 1 `LibraryObject.relativePath` joined directly to
the configured prefix. The materializer never derives a bucket or prefix from
an agent or domain ID. The local scope manifest is read from the owning agent
repository and is never copied to or written by the materializer.

The master manifest and each per-agent ledger use canonical JSON. A ledger has
a schema version, a monotonically increasing revision, and object-ID-sorted
entries containing `objectId`, the opaque `ragFileId`,
`targetCorpusDisplayName`, `corpusResourceName`, and `importedAtRevision`.
Schema version 1 remains unchanged, and readers tolerate legacy entries without
the corpus display name. Candidate bytes are uploaded before their manifest
records are appended. A successful upload followed by a lost manifest race is
therefore safe to rerun: the canonical object path is content-addressed and the
next run observes the existing bytes.

The first run against a legacy ledger entry deliberately replans that object.
The materializer ensures the configured target corpus and lists its files. If
the canonical GCS URI is already present, listing recovery performs no Vertex
import and rewrites the ledger entry with `targetCorpusDisplayName` under GCS
generation CAS; otherwise it imports into the target and writes the same keyed
entry. The following run is a no-op. A genuine corpus retarget follows the same
path, importing only when the canonical URI is absent from the new corpus.

Manifest and ledger reads return the GCS object generation. Every write supplies
that generation as `ifGenerationMatch`; first creation uses generation `0`.
After one generation conflict the materializer re-reads and recomputes once. A
second conflict is a typed CAS error and is not retried blindly. Object creation
also uses generation `0`; a competing successful creation converges by checking
that the canonical path now exists.

Materialization is append-only. The executor can ensure a corpus, list its
files, and import a canonical GCS URI. Its Vertex adapter has no deletion
operation. Planner retractions remain in receipts with `dry_run_only: true` and
are never sent to GCS or Vertex. Receipts are canonical and hashed. They contain
counts, content IDs, opaque corpus/RAG identifiers, revision movement, and CAS
conflict counts, but no candidate paths, source locators, source text, canonical
bytes, or credentials. Before the CLI writes a receipt it fails closed if the
serialized bytes contain configured access-token or private-key material.

## Import-partition discovery

Stable Vertex rejections were not correlated with file size, invalid UTF-8,
control characters, or a fixed poisonous byte region. Rejected regions whose
halves both imported successfully showed that the failure follows burst size,
and adaptive rejection-led splitting converged for every observed source.

**Root cause (established empirically 2026-07-23):** the opaque
`An internal error occurred` import rejection is quota exhaustion inside
Vertex's chunk-insertion stage. Importing the same file with an explicit
`ragFileTransformationConfig` chunking config surfaces the true error —
`429 Resource has been exhausted` from "Rag Managed Vector Search" — and the
same request non-deterministically renders as either message. Splitting works
because smaller files produce smaller chunk-insert bursts, not because of
content alignment. Consequences: (1) imports should send the explicit
chunking config so failures surface truthfully and the adapter's existing
quota retries apply; (2) medium files that intermittently failed can heal by
retry alone; (3) very large files (a 7.2 MB source was retried six times,
spaced, and never landed whole) exceed the per-import window regardless of
timing, so partitioning remains the working mitigation for them until
Google's quota granularity changes.

`bun run library:partition` discovers a partition against an explicitly named
scratch corpus: it tries the whole source, then recursively splits rejected
pieces at the nearest paragraph boundary (falling back to a newline and then
the byte midpoint). The `--scratch-corpus` value must start with `scratch-`.
Probe objects are isolated under `<configured-prefix>-probe/scratch-probe/`,
never the canonical library prefix, and the tool does not delete them.

After discovery, the emitted byte-exact part files freeze the observed working
partition and enter the existing `candidates.json` flow as ordinary objects.
For part `NN`, use the parent locator with `#partNN` appended, set
`derivativeKind` to `import-partition`, and title it `<Parent Title> (Part N of
M)`. The canonical whole remains a library object; agent scopes select the
parts instead of that whole when the partitioned representation is required.

The deterministic, content-free receipt records the source hash, part hashes
and offset ranges, probe attempt tree and counts, and every probe object path.
The operator must use those paths to remove probe objects and must remove the
scratch corpus after review; cleanup is deliberately never automatic.

## Reference ingestion

`bun run expert:ingest` turns a reference into a staged candidate. It shells out
to the external [`summarize`](https://github.com/steipete/summarize) CLI in its
extraction-only mode (`--extract --format md`), which performs no summarization
and therefore reads no model credential. The binary is resolved with
`Bun.which`; its absence is a typed error naming
`npm i -g @steipete/summarize`, never a silent skip and never a fallback fetch
of our own. The subprocess receives an environment stripped of every
credential-shaped variable, so the audio-transcription and paid-extraction
fallbacks stay unconfigured: an unavailable published transcript is a typed
failure the operator resolves. The machinery itself makes no network call.

```sh
bun run expert:ingest -- \
  --source "https://example.invalid/reference" \
  --library "/path/to/candidates" \
  [--trust-tier <tier>] [--copyright-posture <posture>] [--corpus <corpus-id>]
```

The extracted text is hashed, written to
`<library>/objects/sha256/<first-two-hex>/<64-hex>.md` — the canonical
ID-derived path — and recorded in `<library>/candidates.json`, so the staged
directory is exactly what `library:materialize --candidates` already consumes.
Provenance records the source locator and the extractor used, and the object is
validated against the Tranche 1 contract before it is staged.

Trust tier and copyright posture default to the permissive public values
(owner ruling 2026-07-28: a source belongs to the public corpus unless a
copyright ruling has to be enforced). Either flag overrides the default, and an
omitted flag inherits a posture already staged for those exact bytes, so a later
undeclared run cannot silently relax a declared restriction. `--corpus` records
the intended corpus for an object in `<library>/corpus-intents.json`; corpus
membership itself remains the agent scope manifest's decision.

## Materialization rehearsal runbook

The candidate directory must contain the canonical files plus a
`candidates.json` descriptor. Each descriptor entry names a portable relative
file path and supplies all Tranche 1 metadata other than the content-derived
`id`, `byteSize`, and `relativePath`. In particular, provenance timestamps,
trust tier, and copyright posture are explicit operator inputs; the CLI does not
invent governance defaults or read the clock.

The operator supplies the configured shared-library bucket and non-root prefix,
the scope-manifest path from the agent's own repository, the candidate
directory, and a local receipt path. Google authentication uses only the
existing `EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_ACCESS_TOKEN`,
`EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_JSON`, or
`EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_JSON_FILE` fields. Execute
mode resolves the Vertex project from the existing `EXPERT_AGENTS_GCP_PROJECT`
setting or the service account's `project_id`; its location is the runtime's
established `us-central1` location.

Always rehearse without `--execute` first:

```sh
bun run library:materialize -- \
  --bucket "$LIBRARY_BUCKET" \
  --prefix "$LIBRARY_PREFIX" \
  --scope "/path/to/agent-repo/library/scope.json" \
  --candidates "/path/to/candidates" \
  --receipt "/path/to/receipts/materialization-plan.json"
```

Plan-only mode reads and validates current state, emits the full would-be
receipt, and performs zero GCS or Vertex writes. After reviewing that receipt,
the eventual operator invocation is the same command with a distinct receipt
path and the explicit execution flag:

```sh
bun run library:materialize -- \
  --bucket "$LIBRARY_BUCKET" \
  --prefix "$LIBRARY_PREFIX" \
  --scope "/path/to/agent-repo/library/scope.json" \
  --candidates "/path/to/candidates" \
  --receipt "/path/to/receipts/materialization-execute.json" \
  --execute
```

This runbook is rehearsal only today. The first real GCS/Vertex execution awaits
the owner's shared bucket/project decision and explicit go-ahead. Do not use the
CLI to touch the current live corpus during rehearsal.

## Operator CLI

`bun run expert:library -- <command>` is the one documented surface for
library work from a shell harness (Claude Code, Codex, a terminal). It adds no
machinery: every command orchestrates a lane that already exists and prints
what happened. `scripts/expert-library.ts`; tests in
`test/expert-library-cli.test.ts`; `--help` prints the authoritative usage.

**Worker lane** talks to a running domain-expert worker over HTTP
(`POST <worker>/v1/domain` with `{tool, params}`). The URL comes from
`--worker` or `EXPERT_AGENTS_WORKER_URL`; the bearer token only from
`EXPERT_AGENTS_WORKER_TOKEN` or `--token-file <path>` — never an argument
value, never printed, never written into a receipt (every emitted line is
redacted against the secrets the process holds).

| Command | Worker tool |
| --- | --- |
| `health` | `GET /v1/health` |
| `ask --domain <id> "<q>" [--passages] [--corpus <id>]` | `domain_ask` |
| `search --domain <id> --query "<q>" [--author --title --language --top <n>] [--ingest-intent]` | `annas_archive_search` (table: rank, format, size, title, author, year, language, md5; libgen-fallback warnings) |
| `acquire --domain <id> --md5 <md5> --format <f> --title --author [--year] --corpus <id> --copyright-posture <p> --approval-id <id> [--no-ingest] [--dry-run] [--no-wait]` | `annas_archive_import` with `dry_run: false` unless `--dry-run`; prints the full `rag_ingest` status and any error verbatim |
| `source register --domain <id> --kind <k> --title --author --locator <url> [--trust-tier --copyright-posture --corpus]` | `domain_source` `add`, `dry_run: false` |
| `status --domain <id> [--corpus <id>]` | `rag_corpus` `status` |

Worker errors are printed verbatim (HTTP status, code, message, suggestion)
and exit 1. `acquire` treats a busy corpus (`FAILED_PRECONDITION` / "other
operations running") and HTTP 429 as wait-and-retry: 30s, 90s, then tripling
to a 5-minute cap within a 15-minute budget, unless `--no-wait` is given. A
retry after a completed download re-ingests the file already on disk.

**Owner lane** runs locally against Google ADC and needs no worker:

```sh
bun run expert:library -- ingest \
  --scope "/path/to/agent-repo/library/scope-manifest.json" \
  --library "/path/to/candidates" \
  --bucket "$LIBRARY_BUCKET" --prefix "$LIBRARY_PREFIX" \
  --receipts "/path/to/receipts" \
  [--title "<t>" --creator "<c>" | --meta meta.json] \
  [--trust-tier <t>] [--copyright-posture <p>] \
  <url-or-path>...
```

For each source it stages a candidate through `expert:ingest` (`.txt`/`.md`
taken as prepared; `.epub`/`.mobi`/`.azw3`/`.djvu` converted to text with
calibre's `ebook-convert`, or `pandoc` for epub, else a typed refusal; anything
else extracted with `summarize`), appends the new object ids to the scope
manifest's `selection.objectIds` (sorted, unique, canonical), runs the
materializer plan and then execute through `materialize-scope`'s module
functions, and annotates title/creator on any object that was already live
(new objects carry both fields on the candidate — `expert:ingest` accepts
`--title` and `--creator`). `--meta` maps each source to `{title, creator}`
when several are ingested at once. `EXPERT_AGENTS_GCP_PROJECT` is required;
the access token comes from `EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_ACCESS_TOKEN`
or, when unset, `gcloud auth application-default print-access-token` run via a
direct spawn. It prints one line per object (id, bytes, title), the plan and
execute summaries, revision deltas, and writes the plan, execute, annotation,
and run receipts under `--receipts`; a non-empty `rejectedImports` exits 1.

## Runtime routing

The active runtime consumes `EXPERT_AGENTS_DOMAIN_EXPERT_AGENTS_JSON` as strict
inline JSON or an `@`-file reference. Each domain entry declares exactly one
shared-library `bucket` and `prefix`, one `targetCorpusDisplayName`, and optional
display-name, scope-manifest path, retrieval overrides, and disclosure posture.
The existing `EXPERT_AGENTS_GCP_PROJECT` setting supplies the Vertex project.
This routing configuration is the only source of runtime cloud destinations.

### Disclosure posture (optional)

A served deployment declares an optional `disclosure` block. It is the runtime
half of the `serving` block in `agent.json`
([`AGENT_REPO_CONTRACT.md`](./AGENT_REPO_CONTRACT.md)) and reuses the same
`corpusId` and `disclosure` vocabulary:

```json
{
  "neutral-domain": {
    "library": { "bucket": "neutral-shared-library", "prefix": "v1" },
    "targetCorpusDisplayName": "neutral-library",
    "disclosure": {
      "corpora": [{ "corpusId": "neutral-private", "disclosure": "derived" }],
      "bounds": { "maxQuoteChars": 1500, "maxQuotesPerSource": 5, "maxSourceCoveragePerSession": 0.2 },
      "excludedSources": [{ "displayName": "A Work Not Cleared For Public Quoting" }, { "uri": "gs://neutral-shared-library/v1/private.pdf" }]
    }
  }
}
```

`excludedSources` is optional. It names individual works, by exact source
display name or URI, that this deployment never quotes even from a `full`
corpus. It is a deny list because a public deployment serves the whole shared
corpus by default (owner ruling 2026-09-09); one corpus can therefore back a
private expert and a public one, with the public deployment carrying only the
exceptions.

`bounds` is optional and partial; every omitted value takes the owner policy
default shown above. They are deliberately generous policy values and exist to
be changed by a policy decision, which is why they live in configuration rather
than at any call site. A corpus that declares no posture is `full`.

With a posture declared, `domain_ask` requires a `session_id` so the cumulative
per-source bound is meaningful across an engagement, a `derived` or `excluded`
corpus is unreachable from every corpus-scoped surface before any Vertex call is
made, each returned excerpt is bounded to `maxQuoteChars` with at most
`maxQuotesPerSource` per source per response, an excerpt with no attributable
source is withheld because citation is not configurable off, and crossing the
cumulative bound refuses the request rather than trimming it. The refusal is
typed and content-free: a code and a generic message, never the withheld text,
the source, or a path. The answer carries a `disclosure` report of counts and
the bounds that were applied.

**Absence of the block is the declaration that no posture applies.** A routing
entry without `disclosure` never enters any of these paths, never requires a
`session_id`, and behaves exactly as it did before disclosure enforcement
existed.

For a configured domain, the runtime allowlists only
`gs://<bucket>/<prefix>`, defaults retrieval to exactly the declared corpus,
and validates staging and import destinations against that library root. A
configured scope path is inspected read-only by `domain_agent status` using the
shared-library parser; the scope stays in its owning agent repository.
The status contract reports successful execution as `status: "completed"` and
reports inspected service health independently as `health: "healthy"` or
`"degraded"`. A degraded inspection is data-health information, not a tool
execution error; its findings remain content-free and include a bounded recovery
request when required workspace seed files are missing.

For a configured domain with a scope path, `domain_agent catalog` reads that
local scope plus `<prefix>/manifest/master.json` and
`<prefix>/ledgers/<agentId>.json` from the configured bucket through the
worker's existing Google credential path. It performs GCS reads only. The
response lists selected objects sorted by display name, using `title` when
present and a humanized first-locator basename otherwise, and reports
corpus-keyed materialization status and content-free summary counts. An
unconfigured domain is refused with `agent_not_configured`; unreadable catalog
state returns a typed content-free error.

For an unconfigured domain, local status and dry-run plans remain available and
are explicitly marked unconfigured. Every cloud-touching action fails with the
typed `agent_not_configured` error naming the required environment field. The
runtime never derives a bucket, prefix, or corpus from a domain or agent ID.
Per-domain bucket and three-corpus generation are removed compatibility
behavior and must not be restored or copied into agent repositories.
