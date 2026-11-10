# Shared library

Every expert's originals live in one shared library: a configured Google Cloud
Storage bucket and prefix (or a local directory, with
`EXPERT_AGENTS_DOMAIN_EXPERT_LIBRARY_OBJECTS_ROOT`) with one versioned master
manifest. The [page library](page-library.md) parses those originals into
page-addressed units and searches them; this page describes the library
contract underneath it.

The Vertex materializer that once imported library objects into per-agent
Vertex RAG corpora was removed on 2026-11-10 (#78), along with its operator
commands (`library:materialize`, `library:partition`, `expert:ingest` and the
owner-lane `expert:library ingest`). Ingest goes through the worker's
`library_ingest` (`expert:library library-ingest`) or `annas_archive_import`.

## Owner ruling and boundary

The library location is configuration, never a value derived from an agent or
domain ID:

```text
gs://<configured-bucket>/<configured-prefix>/objects/sha256/<first-two-hex>/<64-hex>
```

The `@expert-agents/library` package defines this contract. Its manifest and
serialization functions are pure TypeScript using only Node built-ins; they
make no network or cloud calls and write no files.

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
annotations document, applies the annotation operation under a GCS generation compare-and-set
(`scripts/library-gcs.ts`), and writes a
deterministic content-free receipt containing only counts, object IDs, applied
field names, revision movement, and CAS-conflict counts.

## Agent-owned scope manifests

A `ScopeManifest` is a legacy of the Vertex lane: it selected the objects
imported into an agent's corpus. Nothing reads it for retrieval or ingest any
more; when a route names a `scopeManifestPath`, `domain_agent status` only
reports whether it is present and parses. It belongs in the repository of the
agent that owns it. Scope manifests do not live in this machinery repository or
the shared library bucket. Each contains:

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

## Operator CLI

`bun run expert:library -- <command>` is the documented surface for library
work from a shell harness (Claude Code, Codex, a terminal). It adds no
machinery: every command calls a running domain-expert worker over HTTP
(`POST <worker>/v1/domain` with `{tool, params}`) and prints what happened.
`scripts/expert-library.ts`; tests in `test/expert-library-cli.test.ts`;
`--help` prints the authoritative usage.

The URL comes from `--worker` or `EXPERT_AGENTS_WORKER_URL`; the bearer token
only from `EXPERT_AGENTS_WORKER_TOKEN` or `--token-file <path>` — never an
argument value, never printed, never written into a receipt (every emitted
line is redacted against the secrets the process holds).

| Command | Worker tool |
| --- | --- |
| `health` | `GET /v1/health` |
| `library --domain <id> --action <catalog\|search\|grep\|read\|read_range\|view_page> ...` | `domain_library` |
| `library-ingest --domain <id> --action <start\|status\|list> ...` | `library_ingest` (`start` is a dry run without `--apply`) |
| `search --domain <id> --query "<q>" [--author --title --language --top <n>] [--ingest-intent]` | `annas_archive_search` (table: rank, format, size, title, author, year, language, md5; libgen-fallback warnings) |
| `acquire --domain <id> --md5 <md5> --format <f> --title --author [--year] --copyright-posture <p> --approval-id <id> [--no-ingest] [--dry-run] [--no-wait]` | `annas_archive_import` with `dry_run: false` unless `--dry-run`; prints the full `rag_ingest` status and any error verbatim |

Worker errors are printed verbatim (HTTP status, code, message, suggestion)
and exit 1. `acquire` treats a quota refusal (`RESOURCE_EXHAUSTED`) and HTTP 429 as
wait-and-retry: 30s, 90s, then tripling
to a 5-minute cap within a 15-minute budget, unless `--no-wait` is given. A
retry after a completed download re-ingests the file already on disk.

## Runtime routing

The active runtime consumes `EXPERT_AGENTS_DOMAIN_EXPERT_AGENTS_JSON` as strict
inline JSON or an `@`-file reference. Each domain entry declares a
`pageLibrary`, the shared-library `bucket` and `prefix` its originals live in,
and optional display name, scope-manifest path and disclosure posture; the
field list is in the [deployment guide](../deploy/README.md). This routing
configuration is the only source of runtime cloud destinations.

### Disclosure posture (optional)

A served deployment declares an optional `disclosure` block. It is the runtime
half of the `serving` block in `agent.json`
([`AGENT_REPO_CONTRACT.md`](./AGENT_REPO_CONTRACT.md)) and reuses the same
`corpusId` and `disclosure` vocabulary:

```json
{
  "neutral-domain": {
    "library": { "bucket": "neutral-shared-library", "prefix": "v1" },
    "pageLibrary": { "sourceId": "neutral-domain" },
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

With a posture declared, `domain_library` requires a `session_id` so the
cumulative per-source bound is meaningful across an engagement, each returned excerpt is bounded to `maxQuoteChars` with at most
`maxQuotesPerSource` per source per response, an excerpt with no attributable
source is withheld because citation is not configurable off, and crossing the
cumulative bound refuses the request rather than trimming it. The refusal is
typed and content-free: a code and a generic message, never the withheld text,
the source, or a path. The response carries a `disclosure` report of counts and
the bounds that were applied.

**Absence of the block is the declaration that no posture applies.** A routing
entry without `disclosure` never enters any of these paths, never requires a
`session_id`, and behaves exactly as it did before disclosure enforcement
existed.

For a configured domain, the runtime allowlists only
`gs://<bucket>/<prefix>` and validates staging and ingest destinations against
that library root. A
configured scope path is inspected read-only by `domain_agent status` using the
shared-library parser; the scope stays in its owning agent repository.
The status contract reports successful execution as `status: "completed"` and
reports inspected service health independently as `health: "healthy"` or
`"degraded"`. A degraded inspection is data-health information, not a tool
execution error; its findings remain content-free and include a bounded recovery
request when required workspace seed files are missing.

For an unconfigured domain, local status and dry-run plans remain available and
are explicitly marked unconfigured. Every cloud-touching action fails with the
typed `agent_not_configured` error naming the required environment field. The
runtime never derives a bucket, prefix, or library from a domain or agent ID.
Per-domain bucket and three-corpus generation are removed compatibility
behavior and must not be restored or copied into agent repositories.
