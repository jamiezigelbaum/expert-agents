# Retrieval-quality evaluation

The retrieval eval gate measures whether a configured domain returns expected
content-addressed sources and valid inline citation markers. Schema version 2
adds passage-level recall, per-category results, abstention on unanswerable
questions, and per-stage timing: what a baseline of the current pipeline and a
comparison against another retrieval backend need. It is an explicit operator
workflow: the deployed worker does not run evals automatically.

The worker searches a page library but no longer answers questions (its Vertex
answer path was removed on 2026-10-25), so the runner executes only a schema-2
set in passages mode, through `domain_library` search. A schema-1 set, and
answer or `both` mode, are refused; answers are evaluated through the agent.
The schema-1 and answer-run sections below describe receipts written before
then.

Eval questions belong to the individual agent repository, for example
`<agent-repo>/library/eval-questions.json`. They may contain private domain
material. Eval-set files and generated receipts are runtime artifacts and must
never be committed to Expert Agents.

## Eval-set format (schema version 1)

Schema version 1 is unchanged and still accepted:

```json
{
  "schemaVersion": 1,
  "domainId": "neutral-history",
  "thresholds": {
    "minRecall": 0.8,
    "maxInvalidCitationRate": 0.05,
    "maxMissRate": 0.2
  },
  "questions": [
    {
      "id": "neutral-history-001",
      "question": "Which source records the event?",
      "expectedObjectIds": [
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      ],
      "corpora": ["neutral-primary"]
    }
  ]
}
```

The root object and each question accept only the fields shown above;
`corpora` is optional. `domainId`, question IDs, question text, and corpus IDs
must be non-empty strings. Question IDs must be unique. Every question must
have at least one unique expected object ID in the library's canonical
`sha256:<64 lowercase hex>` form. Each threshold is a number from 0 through 1,
inclusive. Validation errors identify schema paths without echoing input
values.

Expected object IDs remain stable across corpus rebuilds because they identify
content, not a corpus display name or a provider-specific file ID.

## Eval-set format (schema version 2)

```json
{
  "schemaVersion": 2,
  "domainId": "neutral-history",
  "mode": "both",
  "thresholds": {
    "minRecall": 0.8,
    "maxInvalidCitationRate": 0.05,
    "maxMissRate": 0.2,
    "minPassageRecallAt": { "k": 5, "min": 0.7 },
    "minAbstentionRate": 0.8
  },
  "questions": [
    {
      "id": "neutral-history-001",
      "question": "When was the river crossing recorded?",
      "category": "quote",
      "answerable": true,
      "corpora": ["neutral-primary"],
      "evidence": [
        {
          "objectId": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "quote": "the river crossing was recorded in the harbor ledger",
          "pages": [12, 13],
          "note": "Chapter two, opening paragraph."
        }
      ],
      "answer": "Before the winter storms, in the harbor ledger."
    },
    {
      "id": "neutral-history-002",
      "question": "How was grain checked at the eastern gate?",
      "category": "exact_term",
      "answerable": true,
      "evidence": [
        {
          "sourcePath": "v2/book-imports/neutral/plain-ledger.pdf",
          "quote": "every shipment of grain was weighed twice at the eastern gate"
        }
      ]
    },
    {
      "id": "neutral-history-003",
      "question": "What did the treaty of the northern isles say?",
      "category": "unanswerable",
      "answerable": false
    }
  ]
}
```

- `mode` is `passages`, `answer`, or `both` (the default).
- `thresholds` and every threshold in it are optional. Rates are numbers from
  0 through 1. `minPassageRecallAt.k` is one of the reported cut-offs: 1, 3,
  5, 10, or 20. A threshold that the file's mode or questions cannot measure
  is a validation error: `minPassageRecallAt` needs passages mode and the
  other thresholds need answer mode; `minRecall`, `maxMissRate`, and
  `minPassageRecallAt` need at least one answerable question, and
  `minAbstentionRate` at least one unanswerable question.
- `category` is one of `exact_term`, `quote`, `conceptual`, `multi_hop`,
  `cross_book`, `figure`, or `unanswerable`.
- `answerable: true` requires at least one evidence item; `answerable: false`
  must have no evidence.
- Each evidence item names its source by `objectId` (canonical
  `sha256:<64 lowercase hex>`), by `sourcePath`, or both. `sourcePath` is an
  object-path suffix such as `v2/book-imports/neutral/x.pdf`, for legacy or
  split imports that are not hash-addressed. `quote` is verbatim source text
  of 6 through 40 words, counted after normalization (below). `pages` is an
  optional `[start, end]` physical page range and `note` an optional comment;
  neither is scored.
- `answer` is an optional reference answer for human review; it is not scored.

Root, question, threshold, and evidence objects accept only the fields shown.
As in schema 1, validation errors name schema paths without echoing values.

## Run the gate

The worker must implement `GET /v1/health` and `domain_library` over
`POST /v1/domain`, and the domain must read a page library. The runner checks
health and the domain's catalog before sending any questions, then searches
each question in file order. All CLI paths are operator-chosen:

```sh
bun run retrieval:eval -- \
  --worker https://worker.example.invalid \
  --questions <agent-repo>/library/eval-questions.json \
  --receipt <approved-artifact-path>/retrieval-eval-passages.json \
  --mode passages
```

For an authenticated worker, inject its bearer token through
`EXPERT_AGENTS_PARITY_CANDIDATE_TOKEN`. Do not place a token in an argument,
eval set, log, or receipt.

`--mode passages` overrides a file whose mode is `answer` or `both`. Thresholds
that need answer mode are listed in `verdict.skipped` instead of being
evaluated.

The command exits with code 0 only when all configured thresholds pass.
A quality-threshold failure writes the receipt and exits 1. Health, input,
response, or receipt-safety failures also exit 1. Tests use injected fetch and
clock implementations and never contact a worker or cloud service.

## Per-question metrics (schema version 1)

- **Expected-source hit:** true only when the response status is exactly
  `answered` and at least one citation `source_uri` ends in
  `/<expected-64-hex>.<extension>`. Matching uses the hash in the canonical
  object path, never a display name.
- **First expected hit rank:** the 1-based position of the first expected
  source in the returned citation array, or `null` for a miss.
- **Citation-marker count:** the number of inline `[<corpus>:<n>]` markers in
  the answer. A grouped bracket such as `[corpus one:1, corpus two:2]` contains
  two markers; members are split on commas and trimmed.
- **Invalid citation-marker count:** markers whose complete trimmed value does
  not equal any returned `citation_id`.
- **Distinct cited-source count:** the number of unique citation `source_uri`
  values.
- **Retrieved-context count:** the response's `retrieved_context_count`.
- **Latency:** elapsed process time in integer milliseconds around the domain
  request and response-body parse. Health-check time is excluded.
- **Status:** the response status verbatim. Any status other than `answered`
  is a miss even if an expected source appears in its citations.

An unreachable worker, invalid JSON, unsuccessful HTTP response, or malformed
success response produces a miss with a null status and zero response-derived
counts. Its measured request latency is retained.

## Summary and threshold semantics (schema version 1)

Recall is expected-source hits divided by total questions. Miss rate is misses
divided by total questions. Invalid citation rate is invalid markers divided
by all extracted citation markers; it is zero when no markers are present.
Latency summary values are the minimum, arithmetic mean, and maximum of the
per-question integer latencies.

Threshold comparisons are inclusive:

- recall passes when `recall >= minRecall`;
- invalid citation rate passes when
  `invalidCitationRate <= maxInvalidCitationRate`; and
- miss rate passes when `missRate <= maxMissRate`.

Every comparison and the overall conjunction are written as explicit verdicts
in the receipt.

## Schema version 2 metrics

### Source matching

A returned `source_uri` matches an evidence item when either:

- the item has an `objectId` and the URI ends in `/<that 64-hex>.<extension>`;
  or
- the item has a `sourcePath` and the URI equals it or ends with
  `/<sourcePath>` (a whole-segment suffix, so `ledger.pdf` does not match
  `plain-ledger.pdf`).

Before comparing, a split-import part suffix (`--part<i>of<n>` immediately
before the extension) is removed from both sides, so evidence naming a whole
book matches every part imported from it. Schema-1 matching is unchanged.

### Passage quote matching

Text is normalized to words: Unicode compatibility decomposition with
combining marks removed, lowercase, a word hyphenated across a line break
rejoined, and every punctuation or symbol character (Markdown emphasis and
headings, quotes, dashes, brackets) treated as a word break.

A passage contains a quote of `n` normalized words when some run of
`n + max(4, ceil(n / 2))` consecutive passage words has a longest common word
subsequence with the quote of at least `ceil(0.8 * n)` words. In-order
alignment tolerates OCR slips, dropped words, and inserted footnote markers or
running heads; the bounded window stops words scattered across a long passage
from adding up to a match. Receipts name this rule as
`passage_match_rule: "ordered-word-coverage-0.8-window-v1"`; a change to the
rule must change that name so receipts are compared like for like.

A quote that the chunker split across two passages can miss the passage match
while its source still counts as an object hit. The 6-40 word bound keeps that
rare.

### Passages run

Only a response with status `retrieved` is scored. For each answerable
question, in passage rank order:

- **Object hit@k** (k = 1, 3, 5, 10, 20): a passage from an evidence source is
  among the first k passages. When fewer than k passages return, all returned
  passages count.
- **Passage hit@k:** a passage from an evidence source contains that item's
  quote by the rule above, among the first k passages.
- **First object hit rank** and **first passage hit rank:** 1-based, or `null`.
- **Evidence found count:** evidence items whose quote was found in a passage
  from their source.
- Passage count, distinct source count, `retrieved_context_count`, latency,
  and the worker's `timings` when present.

Unanswerable questions are sent too (their latency and timings count), but
their hit fields are `null`.

### Answer run

Per question as in schema 1: expected-source hit (status `answered` and a
citation from an evidence source), first expected hit rank, citation-marker
counts, distinct cited sources, `retrieved_context_count`, latency, and
`timings`. An unanswerable question's expected-source hit is `null`.

**Abstained** is true when the status is anything other than `answered`, or
the answer matches one of the documented not-in-the-library patterns
(`ABSTENTION_PATTERNS` in `scripts/retrieval-eval.ts`). The worker has no
structured abstention status today: it answers and says what is missing. The
patterns read phrases such as "not in the library", "the sources do not
mention", "no relevant information in", "the retrieved passages are
insufficient", "I could not find", and "unable to answer". They are a
heuristic; review false answers by question ID before trusting a low
abstention rate. A request error is never counted as an abstention.

### Summaries

The receipt has `summary.overall` and `summary.by_category` (only categories
present, in the category order above), each with the same shape:

- `passages`: run and error counts; `object_recall_at` and `passage_recall_at`
  per k (hits divided by answerable questions); `object_mrr` and
  `passage_mrr` (mean of 1/first-hit-rank, 0 for a miss); and
  `passage_miss_question_ids` (answerable questions with no passage hit).
- `answer`: run and error counts; expected-source hits, `recall`, and
  `miss_rate` over answerable questions, with `miss_question_ids`; citation
  marker counts and `invalid_citation_rate` (0 when there are no markers, as in
  schema 1); `abstention_rate` and `false_answer_rate` over unanswerable
  questions (abstained, or answered without abstaining; an errored request is
  neither); and `false_abstention_rate` over answerable questions.
- `latency_ms` per mode: count, min, mean, p50, p95, max.
- `stage_timings_ms` per mode: for each stage key the worker reported, the
  number of responses carrying it, p50, and p95.

A rate whose denominator is zero (for example abstention in a category with no
unanswerable questions) is `null`. Percentiles use the nearest-rank method:
the value at 1-based rank `ceil(p / 100 * count)` of the sorted values.

Threshold comparisons are inclusive, as in schema 1, and use
`summary.overall`: `minRecall`, `maxInvalidCitationRate`, and `maxMissRate`
against the answer summary; `minPassageRecallAt` against
`passage_recall_at.at_<k>`; `minAbstentionRate` against `abstention_rate`.
Only configured thresholds appear in `verdict`; `verdict.passed` is their
conjunction (true when none are configured).

## Receipt safety and custody

Receipts use deterministic JSON serialization and sort question records and
miss IDs by question ID. A schema-2 receipt has `schemaVersion: 2`, the mode
that ran, the passage match rule name, and per-question records holding only
the ID, category, answerable flag, statuses, error kinds, booleans, ranks,
counts, latencies, and timings, then the summaries and verdict. They contain the eval-set SHA-256 and byte count, the
worker origin, question IDs, statuses, booleans, ranks, counts, latencies,
summary metrics, and threshold verdicts.

Receipts never contain question text, answer text, source display names,
source URIs, or bearer tokens. No prose evidence field is needed; if a future
schema requires one, it must use only a SHA-256 and character count. Receipt
writing fails closed if the configured bearer token appears in the serialized
bytes. A schema-2 receipt also fails closed if any question text, quote, source
path, note, or reference answer of at least eight characters appears in it.

Store and transfer eval sets and receipts through the agent lane's approved
private artifact process. Do not add either artifact type to this repository.
