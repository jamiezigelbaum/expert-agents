# Reviewed text intake

Use the explicit prepared mode for a reviewed UTF-8 text artifact already held outside the repository:

```sh
bun run expert:ingest -- --prepared --source /private/source/reviewed.md --library /private/library --trust-tier reviewed --copyright-posture restricted --corpus configured-corpus
```

The source must be a readable regular local `.txt`, `.md`, or `.markdown` file. URLs (including `file:` URLs), credential-bearing locators, binary control bytes, malformed UTF-8, empty text, and files above the extraction contract's 25 MiB bound are rejected. Prepared mode does not require or invoke `summarize`. It hashes and stages the original bytes without trimming, newline conversion, or BOM removal. Ordinary intake without `--prepared` still uses extraction.

New objects record `prepared-text` and acquisition method `prepared local file (exact bytes)`; `.txt` uses `text/plain`, Markdown uses `text/markdown`. These labels describe custody of a reviewed artifact and do not claim that the original source is complete, independently verified, or successfully imported by a provider. The caller remains responsible for source review and completeness evidence.

When the bytes already exist in staging, prepared intake retains the existing media type, provenance, derivative kind, lineage, and omitted governance fields and adds the local locator. Explicit governance flags override inherited values. New objects retain the CLI's permissive defaults, so supply restrictive posture explicitly when applicable. A corpus intent is recorded only when `--corpus` is supplied; staging and corpus intent are not provider ingestion proof. Keep private sources and generated library holdings outside this repository.

Programmatic callers use `runExpertIngestCli` with the same argv. Tests may lower the bound through `maxPreparedBytes`; it cannot exceed `PREPARED_MAX_BYTES`.
