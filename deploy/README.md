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
`unsupported_ingest_format` and the download stays on disk. After submission
the worker polls the Vertex operation every
`EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_IMPORT_POLL_INTERVAL_MS` (default 5000) for
up to `EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_IMPORT_POLL_TIMEOUT_MS` (default
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
