# Retrieval-quality evaluation

The retrieval eval gate measures whether a configured domain returns expected
content-addressed sources and valid inline citation markers. It is an explicit
operator workflow: the deployed worker does not run evals automatically.

Eval questions belong to the individual agent repository, for example
`<agent-repo>/library/eval-questions.json`. They may contain private domain
material. Eval-set files and generated receipts are runtime artifacts and must
never be committed to Expert Agents.

## Eval-set format

An eval set uses schema version 1:

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

## Run the gate

The worker must implement `GET /v1/health` and the `POST /v1/domain`
`domain_ask` contract. The runner checks health before sending any questions,
then evaluates questions in file order. All CLI paths are operator-chosen:

```sh
bun run retrieval:eval -- \
  --worker https://worker.example.invalid \
  --questions <agent-repo>/library/eval-questions.json \
  --receipt <approved-artifact-path>/retrieval-eval.json
```

For an authenticated worker, inject its bearer token through
`EXPERT_AGENTS_PARITY_CANDIDATE_TOKEN`. This reuses the candidate-runtime token
slot because the parity battery and retrieval eval have the same trust class.
Do not place a token in an argument, eval set, log, or receipt.

The command exits with code 0 only when all three configured thresholds pass.
A quality-threshold failure writes the receipt and exits 1. Health, input,
response, or receipt-safety failures also exit 1. Tests use injected fetch and
clock implementations and never contact a worker or cloud service.

## Per-question metrics

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

## Summary and threshold semantics

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

## Receipt safety and custody

Receipts use deterministic JSON serialization and sort question records and
miss IDs by question ID. They contain the eval-set SHA-256 and byte count, the
worker origin, question IDs, statuses, booleans, ranks, counts, latencies,
summary metrics, and threshold verdicts.

Receipts never contain question text, answer text, source display names,
source URIs, or bearer tokens. No prose evidence field is needed; if a future
schema requires one, it must use only a SHA-256 and character count. Receipt
writing fails closed if the configured bearer token appears in the serialized
bytes.

Store and transfer eval sets and receipts through the agent lane's approved
private artifact process. Do not add either artifact type to this repository.
