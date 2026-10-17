# Expert Agents domain expert deployment

This runbook installs the domain expert worker as a system-level systemd
service. A system service is deliberate: the worker gets a dedicated
unprivileged account, stable machine-level configuration and state paths, and
automatic startup independent of an interactive login.

The deployment layout is:

- `/opt/expert-agents/releases/<version>`: immutable extracted deploy artifacts;
- `/opt/expert-agents/current`: symlink to the active release;
- `/etc/expert-agents/domain-expert.env`: operator-provisioned configuration
  and credential references, owned by `root:expert-agents` with mode `0640`;
- `/etc/expert-agents/*.json`: optional broker-rendered credential or routing
  files, owned by `root:expert-agents` with mode `0640`;
- `/var/lib/expert-agents/domain-expert`: worker-writable state owned by the
  `expert-agents` service account; and
- `/etc/systemd/system/expert-agents-domain-expert.service`: installed unit.

## Prerequisites

- A Linux host using systemd.
- Bun exactly `1.3.14`, installed at `/usr/local/bin/bun`. Confirm with
  `/usr/local/bin/bun --version`.
- `summarize` (`npm i -g @steipete/summarize`) installed system-wide and on the
  service account's `PATH`, plus the Node runtime it needs. `rag_corpus
  web_import` uses it for YouTube transcript extraction and fails closed when
  that lane needs it but it is absent. Ordinary HTML pages are converted from
  the worker's already-fetched bytes in process; they do not require summarize. Point
  `EXPERT_AGENTS_DOMAIN_EXPERT_SUMMARIZE_BIN` at the binary if it is installed
  outside the unit's `PATH`, and confirm with `configured.summarize` in the
  health response.
- Optional: `yt-dlp`, summarize's media dependency for YouTube and audio/video
  sources. The worker never invokes it directly; a path in
  `EXPERT_AGENTS_DOMAIN_EXPERT_YTDLP_BIN` is forwarded to summarize as
  `YT_DLP_PATH`.
- A deployment-time credential broker able to render a systemd environment
  file without exposing values in source control, command output, logs, or
  receipts.

## Install a packaged release

Create the unprivileged service account and fixed directories once:

```sh
sudo useradd --system --home-dir /var/lib/expert-agents --shell /usr/sbin/nologin expert-agents
sudo install -d -m 0755 -o root -g root /opt/expert-agents
sudo install -d -m 0755 -o expert-agents -g expert-agents /opt/expert-agents/releases
sudo install -d -m 0750 -o expert-agents -g expert-agents /var/lib/expert-agents/domain-expert
sudo install -d -m 0750 -o root -g expert-agents /etc/expert-agents
```

Obtain the `dist/deploy-package/` artifact produced by `bun run package:deploy`
for a verified `vX.Y.Z` release. Verify it through the approved distribution
channel, then replace `<artifact-dir>` and `<version>` below. The artifact
already contains a self-contained worker bundle; it does not contain repository
source or dependency directories and must not run `bun install` or
`bun run build`:

```sh
sudo install -d -m 0755 -o root -g root '/opt/expert-agents/releases/<version>'
sudo cp -a '<artifact-dir>/.' '/opt/expert-agents/releases/<version>/'
sudo chown -R root:root '/opt/expert-agents/releases/<version>'
sudo ln -sfn '/opt/expert-agents/releases/<version>' /opt/expert-agents/current
```

The systemd unit invokes the packaged
`packages/runtime/dist/server.js` directly with Bun. No package manager install,
source checkout, or build toolchain is required on the deployment host.
Import-partition discovery and retrieval-quality evaluation are release-side
workflows that must be completed from a source checkout before packaging; they
are not commands or documentation included in this deploy artifact.

Install the unit from the active release:

```sh
sudo install -m 0644 -o root -g root /opt/expert-agents/current/deploy/systemd/expert-agents-domain-expert.service /etc/systemd/system/expert-agents-domain-expert.service
```

### Packaging an artifact from a commit on the deploy host

When no published release covers the commit you need, build the artifact in a
scratch directory (never under `/opt`) as the deploying operator, then install
it exactly like a packaged release. The host needs a git clone over https
(the `expert-agents` service account has no GitHub credentials and is not
used) and Bun `1.3.14`:

```sh
git clone https://github.com/jamiezigelbaum/Expert-Agents.git "$HOME/.rb-tmp/deploy-<sha>"
cd "$HOME/.rb-tmp/deploy-<sha>" && git checkout <sha>
bun install --frozen-lockfile && bun run build && bun run package:deploy
```

Use `dist/deploy-package/.` as `<artifact-dir>` and the full commit sha as the
version (`/opt/expert-agents/releases/git-<full-sha>`), repoint `current`, then
restart the unit and require both readiness proofs below. Rollback is the
procedure in "Roll back to a previous version".

## Provision configuration and credentials

Use `deploy/systemd/domain-expert.env.example` as the field list, but have the
credential broker render the enabled assignments directly to
`/etc/expert-agents/domain-expert.env` during deployment. The broker operation
must write to a root-controlled temporary file, set ownership to
`root:expert-agents` and mode to `0640`, then atomically rename it into place.
Any separately rendered service-account JSON or routing JSON inside
`/etc/expert-agents` must use the same `root:expert-agents 0640` ownership and
mode. The broker must not print values or include them in Git, deployment logs,
or receipts. Do not commit rendered files.

Set `EXPERT_AGENTS_DOMAIN_EXPERT_DATA_DIR` to
`/var/lib/expert-agents/domain-expert`. Keep the default loopback host unless a
remote bind is explicitly required. Provision
`EXPERT_AGENTS_DOMAIN_EXPERT_AUTH_TOKEN` for authenticated health and worker
requests; a non-loopback bind will refuse to start without it. Enable only the
external integrations the deployment uses.

`EXPERT_AGENTS_DOMAIN_EXPERT_AGENTS_JSON` is **REQUIRED for live domain
serving**. It is the domain-keyed routing manifest for the worker: every entry
declares one shared-library bucket/prefix and one target Vertex corpus, with
optional display name, agent-owned scope-manifest path, and retrieval overrides.
The value may be strict inline JSON or `@` followed by an absolute JSON-file
path. If the `@` form is used, provision that file separately with
`root:expert-agents 0640` access and do not place credentials in it. For
example, a governance domain mapped to its corpus display name has this shape:

```json
{
  "governance": {
    "displayName": "Governance Expert",
    "library": {
      "bucket": "<shared-library-bucket>",
      "prefix": "<shared-library-prefix>"
    },
    "targetCorpusDisplayName": "governance-docs"
  }
}
```

The worker does not generate buckets, prefixes, or corpora for missing domain
entries. Offline status and dry-run planning remain available and report the
domain as unconfigured; a cloud-touching request is refused with
`agent_not_configured`. `EXPERT_AGENTS_GCP_PROJECT` is **REQUIRED for live
deployments** and must name the project hosting the declared target corpora. A
configured `scopeManifestPath` is read only by `domain_agent status` and the
read-only `domain_agent catalog` action for configured domains; it remains owned
by the agent repository and is never copied or mutated by this deployment.

Optional `retrieval.preferenceProfilePath` and `ingestion.importResultSink`
settings are described in [retrieval preferences](../docs/retrieval-preferences.md).

Optional `ingestion.explicitCorpusRequiredFor` lists acquisition operations
(`annas_archive_import`, `web_import`) that must name `corpus_id`. Without it,
an import defaults to the first configured corpus (the first
`servingCorpusDisplayNames` entry, else `targetCorpusDisplayName`). A domain
whose first corpus is private and whose public acquisitions belong on separate
shelves sets it so those imports cannot land in the private corpus by default:

```json
"ingestion": { "explicitCorpusRequiredFor": ["annas_archive_import", "web_import"] }
```

A listed operation without `corpus_id` is refused with `corpus_id_required`
before any fetch, download or staging, including in dry runs. An
`annas_archive_import` without `ingest: true` chooses no corpus and is not
affected. A named `corpus_id` is still checked against the domain's corpora.
Provision profiles as private operator files with `root:expert-agents 0640`
permissions and atomically replace them when reviewed file IDs change.

`domain_agent status` separates inspection execution from the inspected service
health. A completed read-only inspection returns `status: "completed"` even
when `health` is `"degraded"`; invocation and transport failures remain tool
errors. Degraded workspace seeding names every missing requirement and returns
a `domain_agent bootstrap` recovery request. That recovery creates missing seed
files without source retrieval or cloud calls and preserves existing files when
workspace overwrite is disabled.

### Ingestion limits and PDF handling

`rag_corpus web_import` accepts one fetched PDF up to exactly 100,000,000 bytes.
It recognizes a PDF from its `%PDF-` header in the fetched bytes; URL suffixes,
`Content-Type`, and `Content-Disposition` supply naming hints but cannot make
HTML or another payload count as a PDF. This covers download services that
return a real PDF as `application/octet-stream` with a disposition filename.
The guarded HTTPS fetch, public-address check, pinned destination addresses,
redirect cap, timeout, and 100 MiB batch cap still apply.

Text, HTML, Markdown, and the default parser path retain the 10 MB
(10,000,000-byte) per-file processing and staging limit. `stage_import` applies
the same 100,000,000-byte limit to `.pdf` files and reports both limits in its
`file_policy`; skipped files identify `file_size_limit_exceeded`. The worker
runs YouTube `summarize` extraction with a temporary private HOME and XDG
cache/config/data tree
under `EXPERT_AGENTS_DOMAIN_EXPERT_DATA_DIR`, then removes it after extraction.
HTML uses the existing in-process HTML-to-Markdown converter on fetched bytes.
It preserves text and headings but does not perform browser rendering or
readability-based removal of page navigation. A read-only service home
therefore does not prevent extraction, direct PDF
imports create no extractor cache, and unrelated user configuration is not
inherited. The subprocess also uses that temporary tree as its working
directory, preventing `summarize` from discovering a caller-project `.env` and
reloading provider keys that the environment filter removed. The existing
credential environment filter remains in force.

`annas_archive_import` with `ingest: true` uploads only what Vertex RAG can
parse (PDF, text, Markdown, HTML). An EPUB is converted to Markdown in-process
(no dependency) and uploaded as `book-imports/<domain>/<surname - main title
(year)>.md` (first author's surname, title without subtitle or edition notes;
a different file already at that name gets a `--<content hash>` suffix, never
an overwrite); a DJVU is converted through `djvutxt` when
`EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_DJVUTXT_BIN` (default `djvutxt`, from
djvulibre) resolves on PATH; MOBI/AZW3 are refused with
`unsupported_ingest_format` and the download stays on disk. While imports use
the LLM parser a PDF holds at most
`EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_PDF_SPLIT_PAGES` (default 200) pages per
import ([measured limit](../docs/vertex-rag-limits.md)). A longer PDF is split
with `qpdf` into `<name>--partNofM.pdf` parts that are imported one at a time
and coverage-checked (ACTIVE ragFile; text layer read with `pdftotext`); the
host needs `qpdf` and `pdftotext` (poppler-utils) on PATH, and without `qpdf`,
or for a file `qpdf` cannot read, such a PDF is refused before upload with
`pdf_exceeds_parser_page_limit`. Worker health reports `pdf_import` as
`degraded` while either tool is missing.

These worker routes take the same PDF pipeline: `annas_archive_import`;
`rag_corpus import` of one GCS PDF object, which the worker reads to identify
it and count its pages (the worker's service account needs
`storage.objects.get` on it; an unreadable object answers 502
`gcs_object_unreadable`, one over 100,000,000 bytes 413
`file_size_limit_exceeded`; one that changes while it is read 409
`gcs_object_changed`), with parts beside it as `<name>--partNofM.pdf`. Vertex
reads the URI after the worker inspected it, so once the import settles the
worker reads the object's generation again: if it changed, the record keeps the
inspected sha256 but says `sha256_verified: false` with `source_check`, and the
result reports `source_changed_during_import`. Identity is claimed only for
bytes the registry proved: an object any of its source's records holds with
`sha256_verified: false` (a hand split's parts, an object that changed during
its import) is matched with `identity_verified: false` and cited with its
`source_id` and `identity_verified: false`, its citation header ending
`(source identity unverified)`;
and `stage_import` and `web_import`, where a PDF already in the corpus, one to
split or one refused leaves the batch. The plan's `pdf_routing` and the
receipt's `pdf_sources` list each such PDF with its route (`present`, `split`,
`refused`, or `duplicate` for a later file with the same bytes as an earlier
one in the batch, reported `duplicate_in_batch` with `duplicate_of` and not
imported; or `in_progress` when another operation on the same file still holds
it past the response budget); `eligible_files` lists only what the batch stages, and a batch of
refused PDFs answers `pdf_sources_refused`. The 100 MiB batch cap counts only
the files the batch stages; a routed PDF is bounded by the per-file limit alone
(web_import's 100 MiB fetch budget still covers everything it fetches). Each staged file is
addressed by its bytes, `staged/<domain>/<batch>/<first 32 hex of its
sha256>/<file name>` (the receipt's `destination.object_naming`), and the batch
imports exactly its own objects, named one by one, never a directory. An
unchanged file keeps its URI, so a re-run of the batch is skipped by Vertex for
it; a changed file gets a new URI and is imported; an object no run names any
more is never imported again; and two runs of one `batch_id`, overlapping or
not, cannot reach each other's objects. Nothing is deleted. A batch staged
before this release, at `staged/<domain>/<batch>/<file name>`, imports each
file once more under its new name on its first re-run. A changed file's
previous version stays in the corpus as its own ragFile, the earlier version
rather than a duplicate, and the batch's registry record names the new URI. A
medium's transcript sits beside the medium, so a re-run keeps it instead of
transcribing the same bytes again. The import goes in requests of at most 25
URIs: `ImportRagFiles` documents no per-request maximum, so 25 is a cautious
guess. Each request settles before the next is submitted (a corpus takes one
import at a time), a busy corpus or quota refusal is waited out within the poll
budget, and the requests share the Vertex RAG request pacing. From the first
accepted request the batch record names every file with each request's
operation (`rag_operation_names` once there are several), and the run ends
with one terminal record; a receipt of several requests carries
`submission_receipts`, `operations` and `import_outcome.requests`. A request
still running when its budget ends stops the batch with the rest unsubmitted
(`request_still_running`); re-running the batch finishes it, skipping what is
already in. Parts go to `staged/<domain>/<batch>--parts/` after the batch import, and a staged PDF that
is the batch's only file is registered under the `source_id` the import names.
A PDF imported by URI without `source_id` is registered under its sha256 as
`<domain>-pdf-<sha prefix>` and answers within the response budget. A
single object is a PDF when its key ends in `.pdf` or, under any other key, when
its first five bytes are `%PDF-` (a ranged read; an unreadable object answers
502 `gcs_object_unreadable`). Its record then says `content_type:
application/pdf`, so it takes the LLM parser and its citations carry pages
whatever its key. One operation at a time works on a file: every route that
checks or imports a source (acquisition, `rag_corpus import`, staged routing
and its deferred splits, `domain_source add` with a sha256) holds a lock on its
sha256 from checking the holding until it has written the outcome or an
in-progress record, and a split that outlives its request keeps the lock until
its outcome is recorded. Another operation on the same file waits for it, then
sees what it recorded; past the response budget it answers
`import_in_progress` (`source_import_in_progress`, naming the holder and the
source) instead. The lock lives in the worker process: running several worker
processes against one registry would need a distributed lock. A `rag_corpus import` of a GCS directory
(`gs://…/prefix/`) or a Drive file does not take the pipeline: it is imported as before, so a long PDF in it is not
split. The library materializer imports each object whole and does not split:
under the LLM parser its CLI counts each PDF's pages with `qpdf`, in a plan as
in an execution, and rejects one over the limit (`pdf_exceeds_parser_page_limit`)
or one it cannot count, including every PDF on a host without `qpdf`
(`pdf_page_count_unavailable`), in the receipt's `rejectedImports`; import such
a PDF through the worker instead. Registry rows written before this release
name the split codes `annas_pdf_split_import_incomplete` and
`annas_pdf_split_failed`; they are now `pdf_split_import_incomplete` and
`pdf_split_failed`.

Citations name the original source: a passage or citation from a registered
object carries `source_id`, `source_part` for a split's part, and
`original_pages` (`first_page`, `last_page`, `basis`). For a part the original
pages are the part's first original page plus the chunk's page span within
the part (`basis: chunk`), or the part's whole range when Vertex returns no
span (`basis: part_range`); a whole PDF's span is already original. The
passage header ends with the pages. An unregistered part claims no pages.

Every source has one identity, the sha256 of the original file.
Before anything is uploaded the worker looks it up in the domain's
`references/source-registry.jsonl`: a source the registry records in the
corpus, whole or as parts of any split, is reported present (when the ragFile
listing fails, a part the registry already knows as imported stays imported),
and nothing is uploaded or imported again, whatever the split size, parser or
installed tools are now. A split records its progress in the registry after
its uploads, at each part's submission and at each part's outcome; every part
record carries the original sha256 and its page range in the original. A
re-run, including one after a worker restart, imports only the parts not yet
in the corpus, deleting a failed part's ERROR ragFile first so Vertex does not
skip it. A holding made outside the worker (for example a book split by hand
and imported straight into Vertex) is registered without importing anything:

```json
{"tool": "domain_source", "params": {"action": "add", "domain_id": "<domain>", "kind": "book",
  "title": "<title>", "author": "<author>", "corpus_id": "<corpus>",
  "sha256": "<sha256sum of the original file>",
  "gcs_uris": ["gs://<bucket>/<dir>/<name>--part1of2.pdf", "gs://<bucket>/<dir>/<name>--part2of2.pdf"],
  "dry_run": false}}
```

Each entry names an object, not a directory or bucket. The parts of a split are
named `<name>--partNofM.pdf` for one M, N from 1 to M once each, and are ordered
by N. The worker requires every object to have an ACTIVE ragFile matched by its
exact source URI, counts each PDF's pages with `qpdf` to record each part's
original page range, and writes one `imported` record
(`acquisition: registered_holding`). A whole object must hash to the given
sha256; a split's parts cannot prove it, so their record says
`sha256_verified: false` and an import that matches it reports
`identity_verified: false`. The same call again answers `already_registered`
(with `identity_verified: false` for such a split) and writes nothing; a different holding for the same sha256, or the same one in
another corpus, is refused with `source_identity_conflict`. A record written
before sources carried a sha256 that holds the same objects is updated rather
than duplicated. A book already imported whole before sources carried their
sha256 is left whole, and a split recorded before parts carried page ranges
gets its ranges back from the part names and the original's page count, so a
re-run imports only the unfinished parts. Two imports of the same book at once
are not locked against each other: Vertex skips the URI the other import holds
and registry writes are serialized.

Upgrading from a release with `EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_PDF_SPLIT_PAGES=0`:
0 still disables splitting, and a PDF over 200 pages is then refused before
upload; health reports `pdf_split_disabled`. After submission
the worker polls the Vertex operation, starting at
`EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_IMPORT_POLL_INTERVAL_MS` (default 5000) and
growing ×1.5 per read up to 30 s while the import runs (each read counts
against the 60/min VertexRagDataService regional quota), for up to `EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_IMPORT_POLL_TIMEOUT_MS` (default
600000, shared with submission backoff) and reports `rag_ingest.status` as
`imported`, `import_failed` (with Vertex's message), `import_empty` (finished
with zero counts, the signature of an unparsed format), or `import_requested`
only when the poll timed out (with `operation_name`). A busy corpus
(`FAILED_PRECONDITION`, other operations running) or a 429 is retried with
backoff inside that budget before reporting `blocked`.

`rag_corpus` `stage_import`, `web_import`, `notion_import`, and `import` with
`source_id` poll the same way, within the same interval and timeout, and
write the outcome to the domain's `references/source-registry.jsonl`: an
`import_requested` record with `rag_operation_name` when Vertex accepts the
import, then `imported` (with `rag_file_name`, `gcs_uri`, `verification`),
`import_failed` or `import_empty` (with `ingest_reason`) once it settles. The
batch record and the source named by `source_id` are both updated; an unknown
`source_id` is refused before anything is staged. The tool result keeps its
submission `status` and adds `import_outcome` and `source_registry`.

PDFs above 100,000,000 bytes are currently rejected. The accepted 1 GB original
PDF target requires a durable background ingestion subsystem rather than a
larger in-memory cap: stream the original into a content-addressed spool;
checkpoint byte and hash progress for resume; split with a page-aware PDF tool
into parts no larger than 100,000,000 bytes; record the original hash and exact
original page range for every part; upload and submit parts independently; and
persist per-part upload, Vertex operation, completion, and failure state in a
queryable job receipt. The current synchronous `web_import` request and import
submission receipt do not provide that spool, page-safe split, resume, or job
status machinery, so this release does not claim 1 GB support.

The 1 GB target is complete only when behavioral tests prove all of the
following without paid or production calls:

- a 1,000,000,000-byte original downloads with memory use bounded independently
  of original size, and an interrupted download resumes from its verified
  checkpoint;
- every generated part is an independently valid PDF no larger than 100,000,000
  bytes, and the part manifest covers every original page exactly once in order;
- retrieval citations resolve each part back to the original source and original
  page numbers;
- a process restart preserves job progress, a failed part produces a visible
  partial-failure state, and retry continues only unfinished or failed work; and
- status reports downloaded, split, uploaded, submitted, completed, and failed
  counts plus byte/page progress without exposing source bytes or credentials.

After provisioning, verify metadata without reading the file contents:

```sh
sudo stat -c '%U:%G %a %n' /etc/expert-agents /etc/expert-agents/domain-expert.env
sudo find /etc/expert-agents -maxdepth 1 -type f -exec stat -c '%U:%G %a %n' {} \;
```

The expected result is `root:expert-agents 750` for the directory and
`root:expert-agents 640` for every broker-rendered file inside it.

### Credential adapter identities

The installation owner supplies a task-scoped credential adapter and registers
the identities needed by that installation. No other product repository or
particular broker implementation is required. This repository defines the
generic caller names and environment fields its runtime needs. Registration
must preserve task-scoped access and content-free receipts.

| Caller identity | Environment field populated | Purpose |
| --- | --- | --- |
| `expert-agents.google.service-account-rag` | `EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_SERVICE_ACCOUNT_JSON` | Google managed RAG, generation, transcription, and configured reranking |
| `expert-agents.notion.token` | `EXPERT_AGENTS_DOMAIN_EXPERT_NOTION_TOKEN` | Notion import |
| `expert-agents.annas.api-key` | `EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_ARCHIVE_API_KEY` | Anna's Archive acquisition |
| `expert-agents.worker.auth-token` | `EXPERT_AGENTS_DOMAIN_EXPERT_AUTH_TOKEN` | Worker HTTP bearer authentication |

No Gemini API-key caller identity is proposed: the current
`domainExpertGoogleConfigFromEnv` surface consumes no Gemini API-key environment
variable. Generation and reranking therefore use the existing Google
access-token or service-account credential paths rather than an invented field.

## Enable, start, and prove readiness

This is a system service, so use `sudo systemctl`, not `systemctl --user`:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now expert-agents-domain-expert.service
sudo systemctl status expert-agents-domain-expert.service
```

The canonical boot proof is this stdout line in the service journal, with the
configured host and port substituted:

```text
Expert Agents domain expert worker listening on http://<host>:<port>/v1
```

Inspect the current boot without exporting credential values:

```sh
sudo journalctl -u expert-agents-domain-expert.service -b
```

Then make an authenticated health request. Replace the placeholder using an
approved secret-safe invocation mechanism; do not paste a real token into shell
history or process logs:

```sh
curl --fail --silent --show-error \
  --header 'Authorization: Bearer <worker-auth-token>' \
  http://127.0.0.1:8040/v1/health
```

Both the boot-proof line and a successful `GET /v1/health` are required before
the deployment is considered ready. A live Google-backed deployment must also
report `configured.google: true` and `configuration_status.google: "ready"`.

## Stop or disable

Stop the worker while retaining boot enablement:

```sh
sudo systemctl stop expert-agents-domain-expert.service
```

Stop it and remove boot enablement:

```sh
sudo systemctl disable --now expert-agents-domain-expert.service
```

## Roll back to a previous version

The previous packaged version must already be installed and must have completed
the same artifact verification. Replace `<previous-version>`, then repoint the
active release, restore that release's unit, and restart:

```sh
sudo systemctl stop expert-agents-domain-expert.service
sudo ln -sfn '/opt/expert-agents/releases/<previous-version>' /opt/expert-agents/current
sudo install -m 0644 -o root -g root /opt/expert-agents/current/deploy/systemd/expert-agents-domain-expert.service /etc/systemd/system/expert-agents-domain-expert.service
sudo systemctl daemon-reload
sudo systemctl start expert-agents-domain-expert.service
```

Keep the existing broker-rendered env file only if its fields are compatible
with the previous version. Repeat both readiness proofs before declaring rollback
complete.

## Uninstall

Disable the service and remove only the installed unit and release pointer/code:

```sh
sudo systemctl disable --now expert-agents-domain-expert.service
sudo rm -f /etc/systemd/system/expert-agents-domain-expert.service
sudo systemctl daemon-reload
sudo rm -f /opt/expert-agents/current
sudo rm -r /opt/expert-agents/releases
```

This intentionally retains `/etc/expert-agents/domain-expert.env` and
`/var/lib/expert-agents/domain-expert` so credentials and worker state are not
silently destroyed. After taking any required backup, an operator may remove
those exact paths and then remove the `expert-agents` service account as a
separate, explicit data-destruction step.

## Container image

The repository root `Dockerfile` packages the same artifact this runbook
installs — `dist/deploy-package` from `bun run package:deploy` — into an
`oven/bun:1.3.14-slim` image at `/opt/expert-agents/current`. The build stage
runs `bun install --frozen-lockfile` and `bun run package:deploy` only; the
runtime stage contains no repository source, dependency directories, or build
toolchain, and never runs `bun install` or `bun run build`. It is for
deployments that run the worker beside a consumer as a container (for example
a public expert provider on a cloud VM); the systemd path above stays canonical
for a host-level install.

Image facts a deployment may rely on:

- Process user `expert-agents`, uid and gid `10001`; the root filesystem can be
  mounted read-only.
- `EXPERT_AGENTS_DOMAIN_EXPERT_HOST` defaults to `127.0.0.1` and no port is
  exposed or published. The worker is reachable only inside the network
  namespace the container shares with its consumer: a host network, or a pod
  namespace the consumer joins (`--network=container:<worker>`). Do not bind
  it elsewhere for a consumer on the same box.
- `EXPERT_AGENTS_DOMAIN_EXPERT_DATA_DIR` and `EXPERT_AGENTS_DATA_DIR` default to
  `/var/lib/expert-agents/domain-expert`. Serving keeps only a corpus-mapping
  cache and factory registrations there; it holds no customer data and no
  durable state a deployment must back up. A tmpfs owned by `10001:10001`
  (mode `0700`) is sufficient for a serving-only deployment.
- `HEALTHCHECK` runs `deploy/docker/healthcheck.js` inside the container with
  the container's own bearer, so health works with networking disabled and
  the token never leaves the environment.
- On Google Compute Engine, set
  `EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_METADATA_TOKEN=1` and provision no key:
  the worker takes access tokens from the instance metadata server (the VM's
  attached service account). `EXPERT_AGENTS_GCP_PROJECT` names the project
  that hosts the corpora, which may be a different project from the one
  running the VM; that identity then needs retrieval-only access there.
  Citation titles need one read beyond retrieval: the worker resolves each
  canonical library object's title and creator from
  `gs://<bucket>/<prefix>/manifest/master.json`, so grant the identity
  `storage.objects.get` on that one object (a bucket-level
  `roles/storage.objectViewer` binding with an IAM condition on
  `resource.name` equal to
  `projects/_/buckets/<bucket>/objects/<prefix>/manifest/master.json`).
  Without it answers still serve, but passages carry the content-hash display
  name instead of a title and `citation_diagnostics` says the manifest could
  not be read.
  `EXPERT_AGENTS_DOMAIN_EXPERT_RAG_LOCATION` names the corpus location when it
  is not the default `us-central1`.
- `summarize` is not installed: `rag_corpus web_import` fails closed with
  `summarize_not_installed` in this image. Serving does not need it.

`deploy/docker/domain-expert.container.env.example` is the environment shape
for a public expert deployment: one domain routed to the shared corpus,
`retrieval.multiQuery` and `retrieval.reranker` on, and
`disclosure.excludedSources` empty so the whole corpus is served unless named
works are withheld. Every field in it is documented in
`deploy/systemd/domain-expert.env.example`; render the real values with the
credential broker and pass the file with `docker run --env-file`.

Build and prove the image locally or in CI:

```sh
bash scripts/docker-smoke.sh
```

The script builds the image, runs it with `--network none`, `--read-only`,
`--cap-drop ALL` and a tmpfs data directory, waits for the container health
probe, and asserts the boot line, uid `10001`, one loaded agent route, an
honest `configured.google: false` (no metadata server is reachable), and a
`401` for unauthenticated and wrong-bearer health requests. The `docker-smoke`
job in `.github/workflows/verify.yml` runs it on every push; the static
Dockerfile invariants (Bun pin, packaged-artifact path, non-root user, example
routing validity) are part of `bun run verify` through
`test/dockerfile.test.ts`.

## Residual risk — loopback bearer (accepted 2026-07-31)

The gateway plugin authenticates to this worker with a bearer token over
loopback TCP. While the worker is down (a deploy, or a crash plus the unit's
five-second restart delay), any local process may bind the worker port,
capture one request's bearer, release the port, and replay the token against
the real worker. Exploitation requires prior local code execution as another
user on this host plus a gateway request landing inside that window; severity
was assessed Medium by two independent reviews.

The planned fix is a permissioned Unix-domain socket riding the next plugin
release, with TCP retained as a config-selectable rollback mode. Two hard
requirements when that lands: a dedicated IPC group (never the
`expert-agents` group, which guards the credential env file) and a protected
runtime directory (never `/tmp`).

Until then, operationally:

- One deploy = one restart cycle; no exploratory restarts.
- Treat `EADDRINUSE` on worker start as an incident, not noise: identify the
  listener (`ss -ltnp | grep <port>`) before retrying.
- After any suspicious window, rotate the worker bearer and re-run the
  dispatch battery.
