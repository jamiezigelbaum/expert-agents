# Page library

The page library is the expert-agent library design chosen by the
2026-10-20 retrieval test. It has three pieces:

- a parse-once lane that turns every original into page-addressed units, read
  locally so that no page can be refused;
- a lean hybrid search index over those units, built into this repository;
- a six-tool belt that lets the agent search, verify, read whole ranges and
  look at pages.

It runs next to the Vertex RAG Engine path. Nothing here changes
`domain_ask`, `domain_read` or the Vertex corpora. A domain switches to it by
declaring a `pageLibrary` route (section 3); any deletion of the Vertex import
path is a separate, owner-approved change.

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
2. DeepSeek-OCR through Ollama (`OLLAMA_URL`), with its native prompt
   `<image>\nFree OCR.`. The markdown prompt returns empty output on many scan
   pages.
3. The vision lane (`VISION_URL`, an OpenAI-compatible endpoint such as
   `delphi/vision-deep`), for pages DeepSeek reads badly:
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
share one machine's memory, run the parse twice: first without `VISION_URL`
(DeepSeek reads every page), then with it once Ollama has unloaded the OCR
model (only escalations and figures go to the vision lane).

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
- **Import is idempotent.** It updates only units whose text changed and
  deletes units whose file is gone, so a second run leaves the index unchanged.
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

`deploy/page-library/compose.yaml` runs Postgres 17 with pgvector on loopback.
`scripts/page-index.ts` is the operator CLI:

```sh
docker compose --env-file page-library.env up -d postgres
bun scripts/page-index.ts migrate
bun scripts/page-index.ts import --source <domain> --tree <tree>
bun scripts/page-index.ts embed  --source <domain>
bun scripts/page-index.ts search --source <domain> --query "…"
```

It reads `PAGE_INDEX_DATABASE_URL` and `VOYAGE_API_KEY` from the environment
and never prints them.

## 3. Tools: `domain_library`

The worker answers `POST /v1/domain` with `{"tool": "domain_library", ...}`.
The domain's route must declare:

```json
"pageLibrary": { "root": "/abs/path/to/tree", "sourceId": "<domain>" }
```

The worker reads the index's credentials from
`EXPERT_AGENTS_DOMAIN_EXPERT_PAGE_INDEX_DATABASE_URL` and
`EXPERT_AGENTS_DOMAIN_EXPERT_VOYAGE_API_KEY`.

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

The OpenClaw plugin registers it as the gateway tool `domain_library`; a
`view_page` image reaches the model as an image block, not base64 text. The
`domain-research` skill tells the agent how to use it. The 2026-10-20 test
found two things an agent's instructions need:
- abstain when the library is silent;
- a larger step budget (about 30) for synthesis.

## Evaluation

Eval sets and receipts live in each agent's own repository, never here. The
shadow is scored on the same questions as Vertex. Each passage is scored
three ways:
- the repo rule (`scripts/retrieval-eval.ts`): source match plus ordered-word
  quote coverage;
- a source-blind quote rule;
- for page units, the pinned evidence unit.

Before any agent run, the engine must match GBrain's one-shot result from
the test: passage@5 0.66 overall and 0.53 on conceptual questions.
