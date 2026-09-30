# Parity surface

The parity battery compares corpus mapping and retrieval behavior between a
baseline runtime and a candidate Expert Agents runtime. The installation cutover
lane supplies both endpoints and owns the remaining shared-library manifest
inspections. This repository's runner does not contact either runtime unless an
operator explicitly invokes it.

## Runtime contract

Each runtime must expose these HTTP endpoints below the supplied base URL:

- `GET <base>/v1/health` returns a successful HTTP status when the runtime is
  ready. The runner checks both runtimes before asking any questions and stops
  if either health check fails.
- `POST <base>/v1/domain` accepts JSON in this form:

  ```json
  {
    "tool": "domain_ask",
    "params": {
      "domain_id": "legal-history",
      "question": "Which sources describe the change?",
      "corpora": ["primary-sources", "commentary"]
    }
  }
  ```

When a runtime requires bearer authentication, the request includes
`Authorization: Bearer <token>`. Tokens are read from environment variables;
they are never command-line arguments, logs, or receipt fields.

A successful domain response has `kind: "domain_answer"`. The runner records
and compares only these response fields:

- `status`, verbatim; the runner does not restrict it to `answered`;
- `resolved_corpora[].corpus_id` and `resolved_corpora[].resource_name` as an
  order-insensitive set;
- `citations[].corpus_id` and `citations[].source_uri` as an order-insensitive
  set, with Jaccard overlap (`intersection / union`) per question;
- `retrieved_context_count`, with both values recorded and drift flagged; and
- `retrieval_plan`, deep-compared after object keys are sorted, with only
  differing JSON paths written to the receipt.

The runner never compares answer prose. It omits answer text from the receipt
and records only its SHA-256 digest and Unicode character count for each side.
An error response is expected to use
`{ "error": { "code": "...", "message": "...", "suggestion": "..." }, "policy": { ... } }`
with a 4xx or 5xx status. The receipt records the HTTP status and error code,
when present, but not the message, suggestion, or policy payload.

## Running the battery

The battery file is JSON with schema version 1 and a non-empty `questions`
array. Every `id` must be unique. `id`, `domain_id`, and `question` must be
non-empty strings; `corpora` is optional and, when present, is an array of
non-empty strings.

Example battery:

```json
{
  "schemaVersion": 1,
  "questions": [
    {
      "id": "legal-history-001",
      "domain_id": "legal-history",
      "question": "Which sources describe the change?",
      "corpora": ["primary-sources", "commentary"]
    }
  ]
}
```

If authentication is required, inject tokens into the operator environment
using these exact variable names:

- `EXPERT_AGENTS_PARITY_BASELINE_TOKEN`
- `EXPERT_AGENTS_PARITY_CANDIDATE_TOKEN`

Then run:

```sh
bun run parity:battery -- \
  --battery <battery-json-path> \
  --baseline https://baseline.example.invalid \
  --candidate https://candidate.example.invalid \
  --output <receipt-json-path>
```

All four arguments are required. The output path is always operator-chosen;
there is no repository default. The receipt contains schema version 1, the
battery file's SHA-256 and byte count, endpoint origins only, question records
sorted by ID, and summary counts for `parity`, `divergence`, and `error`.

## Cutover manifest gates

| Gate | Owner and evidence |
| --- | --- |
| Corpus-mapping parity | Automated by this runner from the `resolved_corpora` corpus/resource pairs. |
| Retrieval parity | Automated by this runner from status, citation/source sets and overlap, retrieved-context counts, and retrieval-plan difference paths. |
| Library parity | Inspected by the installation owner against the shared-library master manifest outside this repository. There is no library-parity endpoint in this runner. |
| Ingestion-cursor parity | Inspected by the installation owner against that same external shared-library master manifest. Runtime cursors are not a parity surface exposed by this runner. |

Battery files and receipts are runtime artifacts. Never commit them to this
repository. Store and transfer them using the cutover lane's approved artifact
handling process.

## Plugin ownership fingerprint

The parity battery compares runtimes. It cannot say which plugin answered a
gateway tool call. Two plugins may declare the same seven tool names in one
gateway boot, and the host resolves that collision last-writer-wins without a
warning, so a healthy-looking cutover can be a fork answering every call.

Every response carries a control-plane policy stamp naming the runtime that
produced it. This runtime stamps `expert_agents_control_plane_only: true`; the
fork stamps `olympus_control_plane_only: true`. The ownership fingerprint reads
only those two booleans and classifies each tool name as `expert-agents`,
`olympus`, `ambiguous` (both stamps true), `unknown` (neither stamp true, or no
policy object), or `missing` (no captured response at all).

The check does not contact the gateway. The operator running the ceremony calls
each of the seven tools and captures the response bodies into one JSON file,
either as an object mapping tool name to response body or as an array of
`{ tool, response }` entries. Any name outside the seven is rejected.

```sh
bun run plugin:ownership -- <captured-responses-json-path>
bun run plugin:ownership -- <captured-responses-json-path> --json
```

With no path, captured responses are read from stdin. The exit code is 0 only
when all seven names are present and every one fingerprints to `expert-agents`;
a missing name is a failure with its own message, because silence must never
read as ownership. `--json` writes a receipt with schema version 1, the per-tool
rows, verdict counts, and a SHA-256 over the normalized tool/verdict pairs for
the cutover thread to cite.

Neither output form reflects a captured response body: only the tool name, the
verdict, the reason, and the two stamp booleans are printed. Captured bodies
carry retrieved corpus content and, for the acquisition tools, source URLs, and
are runtime artifacts under the same handling rules as battery receipts.

Run this before declaring a plugin cutover complete, and again after any gateway
restart that could reorder plugin registration. Every one of the seven names must
fingerprint to `expert-agents`; anything else means the cutover is not done.
