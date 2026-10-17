---
name: expert-annas-archive-acquisition
version: 0.6.0
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
download stays on disk and the refusal names the path.

**Always acquire the EPUB; take a PDF only when no EPUB of the work is
offered** (owner ruling). PDF imports with the LLM parser fail at about 300
pages, so while this deployment imports with the LLM parser (its usual
setting) a PDF holds at most 200 pages per import: the runtime splits a longer
PDF into parts of at most 200 pages, uploads them as `<name>--partNofM.pdf`
and imports them one at a time. `rag_ingest.split` gives the page count and
how many parts imported; `rag_ingest.parts` lists each part's page range in
the original, status and coverage (`covered`, `text_layer_absent` for a scan
the parser read from images — probe it with `domain_ask` — `not_covered` or
`unverified`). When a part fails or is blocked the error is
`annas_pdf_split_import_incomplete`, naming each part and its pages; re-run
the same import once the cause is cleared: parts already in the corpus are
kept, a failed part's leftover ragFile is removed, and only the parts not yet
imported are imported again. The registry records each part as it goes, so a
re-run after a worker restart also resumes where the split stopped. If
splitting fails the code is `annas_pdf_split_failed` and the file stays on
disk. A book already in the corpus whole is not split; when that cannot be
checked the import stops with `annas_pdf_whole_copy_unverified` — re-run it
later rather than splitting by hand. On a host that cannot split (no qpdf, or
a PDF qpdf cannot read) a PDF longer than 200 pages is refused before upload
with `pdf_exceeds_parser_page_limit`; the file stays on disk.

Every source has one identity, the sha256 of the original file. Before
uploading anything the runtime looks that identity up in the domain's source
registry: a book already in the corpus, whole or as parts of any split, is
reported `imported` with `import_outcome.already_present: true` and nothing
is uploaded or imported again, whatever this host could do now. When that
copy's corpus state cannot be read and the registry does not already know it
as imported, the import stops with `source_holding_unverified`; re-run it
later. A partly imported split is resumed on its recorded page ranges; when
the remaining parts cannot be cut the code is
`source_parts_resume_unavailable`. A book that reached the corpus outside the
worker (split by hand and imported straight into Vertex) is registered with
`domain_source add` giving `sha256` (of the original file) and `gcs_uris`
(its objects, parts in page order); the runtime checks each object has an
ACTIVE ragFile and records each part's page range, and registering it again
changes nothing.

Report a refusal or failure with the measured page count (`scale.pages`) and,
for a split, the failing parts; do not substitute another copy without telling
the owner. When the owner intends to ingest, search with
`ingest_intent: true`: EPUB ranks first, PDF next, DJVU below them, MOBI/AZW3
last with the rationale "not ingestible". Without the flag the reading
preference alone decides.

After submitting an import the runtime reads the Vertex operation back and
reports `rag_ingest.status` as what actually happened:

- `imported` — Vertex counted the file; the book is in the library.
- `import_failed` — the operation errored or Vertex reported the file failed;
  the Vertex message is in `import_outcome`.
- `imported` with `import_outcome.already_present: true` — the source was
  already in the corpus and ACTIVE (found by its sha256 in the registry, or
  Vertex skipped a re-import of the same object). The book is in the library;
  do not retry it.
- `import_empty` — the operation finished having imported nothing (the
  format was not parsed, or a skipped object has no ACTIVE ragFile).
- `import_requested` — only when the poll ran out of budget;
  `import_outcome.operation_name` names the operation to check.
- `import_in_progress` — the import outlasted the call's response budget and
  is still running on the worker. The source is already in the registry as
  `import_requested`, and the worker records the real outcome there when
  Vertex finishes. Check `domain_source status` for the source later; do not
  re-import it or substitute another copy while it is in progress.
- `blocked` — nothing was imported; `error.code` says why (a busy corpus or
  quota is retried with backoff first and reports `rag_corpus_busy` or
  `rag_import_quota_exhausted` only after the budget).

Report these verbatim. Only `imported` means the book is in the library;
never describe `import_requested`, `import_in_progress`, `import_empty`,
`import_failed` or `blocked` as success.

An `imported` acquisition is also recorded automatically in the domain's
source registry with the original file's sha256, its Anna locator
(`annas:<md5>`), title, author and year, and for a split each part's page
range; the result's `registry` reports `registered`, `updated` (a re-ingest
revised the existing record), `unchanged` (the source was already registered
as present) or `unavailable` (no workspace root is configured; register the
source manually with `domain_source add`).
