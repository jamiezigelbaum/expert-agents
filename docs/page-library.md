# Page library

The page library is the expert-agent library design chosen by the
2026-10-20 retrieval test. It is three pieces:

- a parse-once lane that turns every original into page-addressed units;
- a hybrid search index over those units;
- a six-tool belt that lets the agent search, verify, read whole ranges and
  look at pages.

It runs as a **shadow** next to the Vertex RAG Engine path. Nothing here
changes `domain_ask`, `domain_read`, the Vertex corpora or the gateway's tool
surface. Cutover, and any deletion of the Vertex import path, is a separate,
owner-approved change.

## 1. Parse once: page-addressed units

`scripts/library-pages.ts parse` reads each served original and writes a
derivative keyed by the original's SHA-256:

```text
<library prefix>/derivatives/pages/v1/<first two hex>/<64 hex>/units.jsonl
<library prefix>/derivatives/pages/v1/<first two hex>/<64 hex>/manifest.json
```

- **PDFs** become one unit per physical page (`p0001`), from the text layer
  (`pdftotext`).
  - A page with no text layer is rendered and parsed by Gemini 3.5
    Flash-Lite.
  - A page Gemini refuses (RECITATION) goes to DeepSeek-OCR at `OLLAMA_URL`,
    when that is set.
  - Pages still empty are listed in `emptyUnits`, never silently dropped.
- **Text and converted ebooks** become sections of about 1,200 words (`s0001`),
  cut at headings and never mid-paragraph.
- **Figures:** a page holding an embedded image smaller than the page gets a
  Gemini figure description (label, caption, 2–5 sentences, bounding box).
  Scan-only documents are skipped by this heuristic; their scan pages already
  return figures from the OCR call.
- Model results are cached per page, so a rerun pays only for new pages.

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
with the original's page or section numbering; `source_page` and
`source_unit` keep each part's own locator. Titles and authors come from the
master manifest, then from `author---title` file names, then from the first
heading.

## 2. Search: GBrain on Postgres

`deploy/page-library/` runs [GBrain](https://github.com/garrytan/gbrain) (MIT)
at a pinned commit, on Postgres 17 with pgvector, both bound to loopback.

- **Embeddings:** Voyage `voyage-4`, 1024 dimensions.
- **Search:** Postgres full text plus vectors, fused, then reranked with
  Voyage `rerank-3`.
- **Kept off by `configure.sh`:** writeback, fact and chronicle extraction,
  write-through, personal-brain boosts and self-upgrade. The index is a pure
  function of the tree.
- **Read-only tree:** the container mounts the tree read-only, so GBrain can
  never rewrite the files it imports.
- **Version:** the pin is the version. Moving it means rerunning the
  retrieval eval.

```sh
cp page-library.env.example page-library.env   # fill from the credential broker
docker compose --env-file page-library.env build gbrain
docker compose --env-file page-library.env up -d postgres
docker compose --env-file page-library.env run --rm -T gbrain init --url "$GBRAIN_DATABASE_URL" --non-interactive --db-only --embedding-model voyage:voyage-4 --embedding-dimensions 1024 --search-mode balanced
./configure.sh <domain>
docker compose --env-file page-library.env run --rm -T gbrain import /library --source-id <domain> --workers 8
docker compose --env-file page-library.env run --rm -T gbrain auth create worker --scopes read   # token → worker env
docker compose --env-file page-library.env run --rm -T gbrain auth rescope --token worker --sources <domain>
docker compose --env-file page-library.env up -d gbrain                                          # gbrain serve --http :3131
```

Re-imports are idempotent by content hash; only changed units re-embed.

## 3. Tools: `domain_library`

The worker answers `POST /v1/domain` with `{"tool": "domain_library", ...}`.
The domain's route must declare

```json
"pageLibrary": { "root": "/abs/path/to/tree", "sourceId": "<domain>", "searchUrl": "http://127.0.0.1:3131/mcp" }
```

and the worker reads the search token from
`EXPERT_AGENTS_DOMAIN_EXPERT_PAGE_SEARCH_TOKEN`.

| action | parameters | returns |
|---|---|---|
| `catalog` | `query?` | books: id, author, title, unit range, figure count |
| `search` | `query`, `k?` (≤25), `book?` | reranked hits with slug, citation, text |
| `grep` | `pattern` (regex, ≤200 chars), `book?`, `max_hits?` (≤50) | matching lines with slug and citation |
| `read` | `slug` | one unit (≤12,000 characters) |
| `read_range` | `book`, `from_unit`, `to_unit` | ≤25 consecutive units, `next_unit` to continue |
| `view_page` | `slug` | the JPEG of that PDF page, rendered from the original |

Slugs are `books/<book>/<unit>`. Every hit carries a citation label
(`Author, Title, p.N` or `section N`). The tool refuses a domain with a
disclosure policy, as `domain_read` does.

It is deliberately **not** registered as a gateway tool yet. That happens at
cutover, together with the agent instructions. The 2026-10-20 test found two
things the agent instructions need:
- abstain when the library is silent;
- a larger step budget (about 30) for synthesis.

## Evaluation

Eval sets and receipts live in each agent's repository (for Guru,
`guru-deva/library/`), never here. The shadow is scored on the same questions
as Vertex. Each passage is scored three ways:
- the repo rule (`scripts/retrieval-eval.ts`): source match plus ordered-word
  quote coverage;
- a source-blind quote rule;
- for page units, the pinned evidence unit.
