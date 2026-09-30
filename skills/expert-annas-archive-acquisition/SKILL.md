---
name: expert-annas-archive-acquisition
version: 0.4.0
description: Search for candidate books, download owner-named titles immediately, present candidates for selection questions, save approved files through the configured sink, and route them to the domain's target corpus.
tools:
  - annas_archive_search
  - annas_archive_import
mutating: true
---

# Anna Archive Acquisition

Two request shapes, two behaviors — both leave a complete content-free audit
record:

- **The owner names a specific book.** The naming message is the approval:
  download immediately, reference that message as the approval id, ingest into
  the domain's configured target corpus (or the corpus the owner named), and
  report exactly what landed. Do not ask again.
- **The owner asks a selection question** ("the best book on X"). Search first
  and return specific candidate titles with ranking rationale, then let the
  owner choose. Never guess which candidate the owner meant.

The runtime—not the agent—resolves credentials and the configured books root.
Never request or reveal an API key. Refuse overwrites and preserve stable
locators and hashes in the content-free audit record. Record the owner's
standing copyright posture with each acquisition.

If no target corpus is configured or named, a named book still downloads;
report that the corpus decision is pending rather than inventing one.

Source metadata is advertising, not evidence: a record can carry a monograph's
title, author, year and byte size and deliver a pamphlet. The runtime measures
the downloaded artifact and refuses to ingest a PDF whose measured page count is
implausibly small, leaving the file on disk. Report that refusal with the
measured page count instead of retrying; only pass `allow_short_artifact: true`
when the owner has confirmed a genuinely short work is wanted. When search
flags a candidate as unusually small against other editions of the same title,
say so before recommending it.

A search result whose `search.backend` is `libgen_fallback` came from Library
Genesis because Anna's Archive search was unavailable (the result's `warnings`
say why). Treat its candidates exactly like any other: select by md5 and import
as usual, since import still resolves the md5 through Anna's Archive fast
download. Mention the fallback to the owner in one clause; do not retry the
search hoping Anna's Archive comes back.

## Ingest: format rules and verified statuses

Vertex RAG parses PDF, plain text, Markdown and HTML only. Before an ingest
upload the runtime converts an EPUB to Markdown itself, converts a DJVU
through `djvutxt` when the worker host has it, and refuses MOBI/AZW3 (and a
DJVU on a host without `djvutxt`) with `unsupported_ingest_format` — the
download stays on disk and the refusal names the path. When the owner intends
to ingest, search with `ingest_intent: true`: PDF and EPUB rank first, DJVU
below them, MOBI/AZW3 last with the rationale "not ingestible". Without the
flag the reading preference alone decides.

After submitting an import the runtime reads the Vertex operation back and
reports `rag_ingest.status` as what actually happened:

- `imported` — Vertex counted the file; the book is in the library.
- `import_failed` — the operation errored or Vertex reported the file failed;
  the Vertex message is in `import_outcome`.
- `import_empty` — the operation finished having imported nothing (the
  format was not parsed, or the file was skipped as already present).
- `import_requested` — only when the poll ran out of budget;
  `import_outcome.operation_name` names the operation to check.
- `blocked` — nothing was imported; `error.code` says why (a busy corpus or
  quota is retried with backoff first and reports `rag_corpus_busy` or
  `rag_import_quota_exhausted` only after the budget).

Report these verbatim. Only `imported` means the book is in the library;
never describe `import_requested`, `import_empty`, `import_failed` or
`blocked` as success.

An `imported` acquisition is also recorded automatically in the domain's
source registry, keyed by its md5 (`annas:<md5>`) with title, author and
year, and the result's `registry` reports `registered`, `updated` (a
re-ingest revised the existing record) or `unavailable` (no workspace root is
configured; register the source manually with `domain_source add`).
