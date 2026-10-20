# Page library

The page library is every expert's library (owner decision 2026-10-20, after
that day's retrieval test). It has three pieces:

- a parse-once lane that turns every original into page-addressed units, read
  locally so that no page can be refused;
- a lean hybrid search index over those units, built into this repository;
- a six-tool belt that lets the agent search, verify, read whole ranges and
  look at pages.

New experts get one from the factory. A domain still on a Vertex corpus
switches by declaring a `pageLibrary` route (section 3); the Vertex path
(`domain_ask`, `domain_read`, `rag_corpus`) stays only until those domains have
moved, then is deleted.

## 1. Parse once: page-addressed units

`scripts/library-pages.ts parse` reads each served original and writes a
derivative keyed by the original's SHA-256:

```text
<library prefix>/derivatives/pages/v1/<first two hex>/<64 hex>/units.jsonl
<library prefix>/derivatives/pages/v1/<first two hex>/<64 hex>/manifest.json
```

**PDFs** become one unit per physical page (`p0001`). Each page is read in
this order, and no cloud model is on the path:

1. The PDF text layer (`pdftotext`). Most pages need nothing more.
2. DeepSeek-OCR, through the OCR profile (`delphi/vision-quality`) of a local
   model router (`OCR_ROUTER_URL`, OpenAI-compatible), with its native prompt
   `<image>\nFree OCR.`. The markdown prompt returns empty output on many scan
   pages.
3. The router's deep profile (`delphi/vision-deep`), for pages DeepSeek reads
   badly:
   - a dense page that yields little text;
   - a looping or garbled reading;
   - a table.

How the results are kept:
- A short reading of a title or blank page stands.
- Pages still near-empty are listed in `emptyUnits`, never silently dropped.
- Every lane call's finish reason, and any refusal, is logged to
  `<out>/lane-calls.jsonl`.
- A refusal is never used as page text.

**Figures** are found on every page, not only on OCR'd ones. A page
qualifies when either holds:
- it carries an embedded image smaller than the page (a page scan is not a
  figure);
- its text layer has a `Figure N` / `Table N` caption line, which catches
  vector art and set tables.

The vision lane describes each figure with a label, caption, 2–5 sentences
and a bounding box. Figures inside page scans are reached through
`view_page`.

**Text and converted ebooks** become sections of about 1,200 words (`s0001`),
cut at headings and never mid-paragraph.

Lane results are cached per page, so a rerun only reads pages it has not seen.
A failed call is not cached and is retried by the next run. When both lanes
share one machine's memory, run the parse twice: first with
`OCR_DEEP_LANE=off` (DeepSeek reads every page), then without it (only
escalations and figures go to the deep profile).

Calls name a router profile, never a model: the router chooses the backing
model, queues each profile one call at a time and waits for memory. The router
listens on loopback on its own host, so a worker elsewhere reaches it through
a forwarded port.

`upload` writes the derivatives beside the originals in the library bucket. It
only ever adds objects under `derivatives/`; originals and the master manifest
are never touched.

`assemble` builds the tree the tools and the index read:

```text
<tree>/catalog.json
<tree>/books/<book>/p0001.md        one unit, YAML front matter + text
<tree>/books/<book>/fig-p0012-1.md  one figure description
```

Parts of a split source (`…-part-2-of-4.pdf`) are merged back into one book
with continuous page or section numbering; `source_page` and `source_unit`
keep each part's own locator. Titles and authors come from these sources, in
order:
1. the master manifest;
2. `author---title` file names;
3. the first heading.

## 2. Search: the page index

`packages/runtime/src/workers/domain-expert/page-index.ts` is the engine:
Postgres full text plus pgvector, fused with reciprocal rank fusion, then
reranked by Voyage.

- **Rows:** one per unit (page, section or figure), keyed by `(source, slug)`
  with a content hash, plus its search chunks. A unit of up to ~480 words (a
  typical page) is one chunk; a longer one is cut into ~380-word windows that
  overlap by 60 words. One vector per long section missed passages buried
  inside it; hits and citations are still whole units.
- **The database is the library.** Each unit row also keeps its front matter
  (`meta`: the original and its page, which `view_page` renders), and
  `page_books` holds one catalog entry per book. A worker needs nothing on
  disk to serve a library, and any host can fill it (section 5).
- **Import is idempotent.** It updates only units whose text changed and
  deletes units whose file is gone, so a second run leaves the index unchanged.
  A unit whose text is unchanged keeps its chunks; only its front matter is
  refreshed.
- **Embeddings:** Voyage `voyage-4`, 1024 dimensions, one vector per chunk
  (title plus text). Vectors are also kept by text hash, so text that comes
  back unchanged, including under another source, is never paid for twice.
- **Search** runs two arms over the chunks, each keeping a unit's best chunk.
  Voyage `rerank-2.5` orders the vector arm's top 200 and the keyword arm's
  top 50 (deduplicated) by that best chunk. Blending the arms' ranks into the
  rerank score only lowered accuracy on the golden set; `rerank-2.5` edged
  `rerank-3` on conceptual questions.
  - Keyword arm: the query's content words **ORed** (a sentence query is not
    an AND of every word, the failure that made GBrain's keyword arm useless
    on whole questions), each chunk scored by the summed IDF of the words it
    holds. Words in over a fifth of the chunks are dropped. Plain `ts_rank`
    over ORed words favours long chunks full of common words: on the golden
    set it put the right page in the top 5 for 5% of questions; IDF scoring
    for 44%.
  - Vector arm: nearest neighbours over HNSW.

`scripts/page-index.ts` is the operator CLI (`bun run library:index`; the
deploy package and image carry it as `packages/runtime/dist/page-index.js`):

```sh
bun scripts/page-index.ts migrate [--reader page_reader] [--writer page_writer]
bun scripts/page-index.ts import --source <id> --tree <tree> [--books a,b]
bun scripts/page-index.ts embed  --source <id>
bun scripts/page-index.ts search --source <id> --query "…"
```

- `migrate` creates or updates the tables and grants the serving role read
  and the ingest role row writes (never schema changes). Run it after every
  upgrade: a table added since the roles were made is granted too.
- `import` makes the library match the tree: units, front matter and the
  catalog. With `--books`, only those books are compared and replaced; every
  other book is left alone. A tree with units but no catalog is refused.

It reads `PAGE_INDEX_DATABASE_URL` (the owner login for `migrate`, the writer
for the rest) and `VOYAGE_API_KEY` from the environment and never prints them.

## 3. Tools: `domain_library`

The worker answers `POST /v1/domain` with `{"tool": "domain_library", ...}`.
The domain's route must declare:

```json
"pageLibrary": { "sourceId": "<library id>" }
```

The library is then read from the database under that id. A route that adds
`"root": "/abs/path/to/tree"` serves an assembled tree from local disk instead
(the original layout; the search rows still come from the database). New
registrations are database-backed unless the operator sets
`EXPERT_AGENTS_DOMAIN_EXPERT_PAGE_LIBRARY_ROOT`.

Several routes may name the same `sourceId`: one library, many agents, each
route with its own disclosure (an owner agent unbounded, a public one under
bounds). The worker reads the library with
`EXPERT_AGENTS_DOMAIN_EXPERT_PAGE_INDEX_DATABASE_URL` (a read-only login) and
`EXPERT_AGENTS_DOMAIN_EXPERT_VOYAGE_API_KEY`. Books another host ingests
appear within a minute; keyword statistics are re-read every five minutes.

`grep` runs in Postgres for a database library: each line is matched the
way JavaScript would (`^`/`$` per line, `\b` a word boundary), and a pattern
Postgres cannot read is scanned unfiltered instead of refused.

| action | parameters | returns |
|---|---|---|
| `catalog` | `query?` | books: id, author, title, unit range, figure count |
| `search` | `query`, `k?` (≤25), `book?` | reranked hits with slug, citation, text |
| `grep` | `pattern` (regex, ≤200 chars), `book?`, `max_hits?` (≤50) | matching lines with slug and citation |
| `read` | `slug` | one unit (≤12,000 characters) |
| `read_range` | `book`, `from_unit`, `to_unit` | ≤25 consecutive units, `next_unit` to continue |
| `view_page` | `slug` | the JPEG of that PDF page, rendered from the original |

Slugs are `books/<book>/<unit>`. Every hit carries a citation label
(`Author, Title, p.N` or `section N`).

Under a disclosure policy (the route's `disclosure` block,
[`AGENT_REPO_CONTRACT.md`](./AGENT_REPO_CONTRACT.md)) the tool serves the same
bounds `domain_ask` does, with a book as the source: `session_id` is required;
every passage is cut to `maxQuoteChars`; each response carries at most
`maxQuotesPerSource` passages per book (`read_range` returns that many units
and resumes from the next); a session may see at most
`maxSourceCoveragePerSession` of a book, measured against the book's real
extent (the characters of its page or section units), and crossing it refuses
the response rather than trimming it. `view_page` charges its page's full text
because an image cannot be cut. Books in `excludedSources` (by catalog title or
original `gs://` URI) are absent from `catalog`, dropped from `search` and
`grep`, and refused by name (`disclosure_source_excluded`). A library whose
`sourceId` is declared `derived` or `excluded` is refused. Ingest stays with the
owner deployment.

The OpenClaw plugin registers it as the gateway tool `domain_library`; a
`view_page` image reaches the model as an image block, not base64 text. The
`domain-research` skill tells the agent how to use it. The 2026-10-20 test
found two things an agent's instructions need:
- abstain when the library is silent;
- a larger step budget (about 30) for synthesis.

## 4. Ingest: `library_ingest`

Agents add sources through the gateway tool `library_ingest` (worker tool of
the same name). It runs the same parse code as the operator CLI
(`packages/library/src/page-parse.ts`).

| action | parameters | returns |
|---|---|---|
| `start` | `workspace_relative_path` or `gcs_uri`; `title?`, `creator?` (one source); `dry_run` (default true); `approval_id` | `job_id`, the lanes in use, skipped files |
| `status` | `job_id` | the job: state, and per source its book, units, parsers used, failed pages, empty pages, unresolved escalations, undescribed figure pages, refusals; then the index counts |
| `list` | | recent jobs |

- **Where originals live.** A `gcs_uri` must be inside the domain's library,
  read-only roots or acquisition directory, and keeps its own URI. A workspace
  file is stored content-addressed in the domain's acquisition directory
  (`<acquisition prefix>/<domain>/originals/<sha256>.<ext>`), so `view_page`
  can render it.
- **Per source:** page units, local OCR, figure descriptions, then the book's
  unit files are written into the domain's tree and its catalog entry is
  replaced. Re-ingesting an original replaces its earlier book, even under a
  new title. For a database library the tree is a staging tree under the
  job's state, removed when the job ends.
- **Per job:** the job's books are imported into the index (only those books
  are compared, so the rest of the source is untouched), then, for a database
  library, their catalog entries; then embedded.
- **Background and observable.** Jobs run one at a time. Each job's state is a
  JSON file under the worker's data directory, rewritten as it moves. A job
  interrupted by a restart resumes, and lane results are cached per page.
- **Nothing silent.** A page whose lane failed, a page without an OCR lane, a
  reading no vision lane re-read and a figure page nobody described are each
  listed. A job with any failed page ends `done_with_failures`.
- **Acquisitions.** `annas_archive_import` with `ingest: true` on a domain with
  a page library queues a `library_ingest` job instead of a Vertex import, and
  answers with its `job_id`. The book-scale floor still applies.

The worker needs, besides the search settings in section 3:
- `EXPERT_AGENTS_DOMAIN_EXPERT_PAGE_INDEX_WRITER_DATABASE_URL`, a role that
  may write (the serving URL can stay read-only);
- `EXPERT_AGENTS_DOMAIN_EXPERT_OCR_ROUTER_URL`, the model router (…/v1);
- optionally `EXPERT_AGENTS_DOMAIN_EXPERT_OCR_DEEP_LANE=off`, to leave hard
  pages and figures listed instead of sending them to the deep profile.

The operator CLIs are `bun run library:pages` (parse, upload, assemble a
whole library) and `bun run library:index` (migrate, import, embed, search).

## 5. Hosting: one library, any host

`deploy/page-library/compose.yaml` runs a library and its worker from the
same image on any Linux host with Docker; nothing in it names a host.
`scripts/page-library-smoke.sh` (CI job `page-library-compose`) proves it
from nothing.

```sh
cd deploy/page-library
cp page-library.env.example page-library.env   # fill with generated hex passwords
cp worker.env.example worker.env               # routes, bearer, Voyage, Google, OCR router
docker compose --env-file page-library.env --profile worker up -d --build
```

- `postgres` creates the `page_reader` and `page_writer` logins on a fresh
  volume; `migrate` (one-shot) creates the tables and grants them; `worker`
  serves with `page_reader` and ingests with `page_writer`. The owner login
  never reaches the worker.
- Both ports bind loopback by default (`PAGE_LIBRARY_PG_BIND`,
  `PAGE_LIBRARY_WORKER_BIND`). An agent on another host reaches the worker
  over a private network address or a tunnel, with the bearer; never publish
  either port openly.
- **Ingest from another host.** A machine with the OCR models (the parse
  lane) parses and assembles locally, then writes into the library over a
  tunnel to the database port with the writer login:

  ```sh
  bun run library:pages parse … && bun run library:pages assemble --tree <tree> …
  PAGE_INDEX_DATABASE_URL=postgres://page_writer:…@127.0.0.1:<tunnel>/pages \
    bun run library:index import --source <id> --tree <tree> --books <new books>
  PAGE_INDEX_DATABASE_URL=… VOYAGE_API_KEY=… bun run library:index embed --source <id>
  ```

  Serving workers see the new books within a minute; nothing restarts.
- **A private shelf is a second library.** Run a second project from the same
  file (`PAGE_LIBRARY_PROJECT=<name>`, its own env files, ports and
  passwords). Its worker holds only its own database's logins, so no route of
  the public worker, misconfigured or not, can reach a private book: the
  public worker has no credential for that database. Same code, same deploy
  command, different database.

### Moving a library

The library is the database; the worker's volume holds only resumable ingest
state. To move a library to another host:

1. On the new host, stand up the compose project as above (`postgres` only):
   `docker compose --env-file page-library.env up -d postgres`.
2. Copy the data, schema and all:

   ```sh
   docker compose -p <old project> exec -T postgres pg_dump -U pages -Fc pages > library.dump
   docker compose -p <new project> exec -T postgres pg_restore -U pages -d pages --clean --if-exists --no-owner < library.dump
   ```

   The roles are per cluster, not in the dump: the new host made its own on
   its fresh volume, and `migrate` (next step) grants them.
3. `docker compose --env-file page-library.env --profile worker up -d`; check
   `/v1/health` reports each domain `store: database`, `catalog: ready` and the
   same `books` and index counts as the old host.
4. Point consumers at the new worker address, then stop the old project.

Re-importing from originals is the fallback when no dump is at hand: parse
and assemble from the library bucket (`bun run library:pages`), `import` each
source id, then `embed`. Vectors are paid for again, so prefer the dump.

A library still served from a tree (`root` set) moves into the database the
same way: `import` the tree (catalog included), check `catalog` and a `read`
through a test route without `root`, then drop `root` from the route.

## Evaluation

`bun run retrieval:eval` evaluates a page-library domain in passages mode: each
question runs one `domain_library` search, and each hit is matched against the
evidence through the `source_uri` of its book's stored original. The worker
writes no answers for a page library, so answer mode is refused there; answers
are evaluated through the agent. The factory scaffolds a schema-2 passages set
in `library/eval-questions.json`.

Eval sets and receipts live in each agent's own repository, never here. The
page library was scored on the same questions as Vertex. Each passage is
scored three ways:
- the repo rule (`scripts/retrieval-eval.ts`): source match plus ordered-word
  quote coverage;
- a source-blind quote rule;
- for page units, the pinned evidence unit.

Before any agent run, the engine must match GBrain's one-shot result from
the test: passage@5 0.66 overall and 0.53 on conceptual questions.
