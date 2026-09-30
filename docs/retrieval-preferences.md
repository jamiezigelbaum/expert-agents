# Persistent editorial retrieval preferences

An operator can configure `retrieval.preferenceProfilePath` on any domain in
`EXPERT_AGENTS_DOMAIN_EXPERT_AGENTS_JSON`. It is an absolute path to a private,
UTF-8 JSON profile, read afresh on each request. Keep source holdings and real
profiles outside this repository. The file must be regular, at most 2 MiB,
and readable by the worker account. Publish updates by atomic replacement.

```json
{
  "schema_version": 1,
  "corpus": "projects/example-project/locations/us-central1/ragCorpora/123",
  "query_layer": {
    "candidate_top_k": 40,
    "default_mode": "preferred",
    "multipliers": { "preferred": 1.6, "commentary": 0.7 },
    "max_per_work_default": 2
  },
  "units": [{
    "rag_file_id": "456",
    "unit_id": "reviewed-unit-1",
    "source_id": "source-1",
    "work_family": "work-1",
    "kind": "primary",
    "priority": "preferred"
  }]
}
```

Set domain retrieval `topK` to the desired candidate count (for example 40).
The profile caps that count; it does not expand an explicit `max_results`.
`contextLimit` still bounds synthesis. The profile corpus must exactly match a
resolved, authorized Vertex resource, including its project identifier. Use
the resource returned by Vertex rather than guessing a project ID/number alias.
Invalid or mismatched configured profiles fail explicitly.

`domain_ask` accepts `retrieval_mode: "preferred" | "history"`. The default is
the profile's mode. History preserves normal retrieval order and bypasses file
loading, including a broken profile. Unconfigured domains retain existing
retrieval behavior. Answer results report configuration, mode, status, profile
SHA-256 and content-free ranking counts. Filesystem-only `domain_agent status`
validates the local profile but explicitly does not prove cloud corpus binding.

Preferred mode ranks the fused candidate pool before synthesis truncation.
Bounded editorial multipliers use original rank, not source prose. Duplicate
removal is whitespace-only within one source identity; URL, case and numeric
changes remain distinct. Work diversity is a soft cap. Neighboring chunks from
boosted files in the first five candidates remain eligible together, to retain
qualifying clauses. Unknown files retain ordinary weight. A preference is
neither an access grant nor evidence of the owner's current belief; disclosure
bounds still apply after selection.

Profiles map Vertex file identities. Reimporting a file with a new ID requires
an explicit profile update. Keep the original-to-prepared-unit manifest and
verified import receipt alongside the private profile, with independent backup.
A new expert may point to that same corpus and profile after its ordinary
routing and access configuration is established. No source reimport is needed.

For already reviewed text, use [prepared text intake](prepared-text-intake.md).
For Vertex import receipts, a domain may set `ingestion.importResultSink` to
`client` to omit the optional provider GCS output sink. The default is `gcs` for
compatibility. A submission/operation receipt is not completed ingestion:
materialization requires an ACTIVE Vertex file for the exact source URI.

Runtime direct and staged imports write an intent under the configured data
folder's `import-submissions/<submission_id>.json` before the provider request.
The result returns `submission_receipt` with the validated operation name and
only a hash of the source reference. A pending/unknown intent requires
reconciliation before resubmission. A post-submission receipt-write failure
returns the validated handle in its recovery instruction. Keep the caller's
source manifest to match the hash; receipts deliberately contain no source text.
This adds no polling API: use the recorded operation and exact-source ACTIVE
file listing through the operator's established Vertex reconciliation workflow.
