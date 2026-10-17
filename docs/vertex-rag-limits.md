# Vertex RAG Engine limits

Platform facts the worker's import code depends on, with how each was
established. Code that enforces one of these limits links here; change the
code and this page together.

The backend, embedder and parser are fixed for now (owner decision): Vertex AI
RAG Engine, `text-embedding-005`, and the Gemini LLM parser
(`ragFileParsingConfig.llmParser`) for the file types Google documents it
supports, with `EXPERT_AGENTS_DOMAIN_EXPERT_RAG_PARSER_MODEL=default` as the
deployment switch to Google's default parser.

## LLM parser: pages per PDF

**Measured.** LLM-parser imports of long PDFs fail inside Vertex.
`ImportRagFiles` finishes with `failedRagFilesCount: 1` and
`partialFailures[0] = {code: 13, "An internal error occurred processing
gs://…"}` after roughly a minute; nothing is imported.

| Date | PDF | Result |
| --- | --- | --- |
| 2026-10-08 | born-digital, 254 pages | imported |
| 2026-10-08 | born-digital, 251 pages | imported |
| 2026-10-08 | about 330, 350, 400 and 500 pages | failed, code 13 |
| 2026-10-16 | text PDF, 582 pages, about 7 MB | failed, code 13, on every attempt |
| 2026-10-16 | 4 books (one a 508-page OCR scan) split with qpdf into 9 parts of at most 200 pages | 9 of 9 parts imported |

The limit is a page count, not a byte size: the failing 582-page file was
about 12 KB per page, well under the import byte limits. Google's parser
documentation gives 500 pages per PDF for its LLM and layout parsers (as
recorded in issue #33); the measured failures start well below that, so the
measurement governs.

**Choice: 200 pages per PDF.** `EXPERT_AGENTS_DOMAIN_EXPERT_ANNAS_PDF_SPLIT_PAGES`
(default 200) is the single page knob. It is below the smallest measured
failure (about 330) and the largest measured success (254), it is the size
whose parts imported 9 of 9 including an OCR scan, and a scan's pages cost the
parser more than born-digital pages. Parts are balanced and contiguous, so a
508-page book becomes 170 + 169 + 169 pages rather than 200 + 200 + 108.

What the worker does with it, while imports use the LLM parser:

- a PDF of at most 200 pages is imported whole;
- a longer PDF is split with `qpdf` into parts of at most 200 pages, each
  imported and coverage-checked on its own (`pdftotext` reads each part's
  text layer);
- a longer PDF the worker cannot split (no `qpdf`, or a file `qpdf` cannot
  read) is refused before upload with `pdf_exceeds_parser_page_limit`.

The worker applies this to acquisitions, to `rag_corpus import` of one GCS PDF
object, and to the PDFs of `stage_import` and `web_import` batches. A
`rag_corpus import` of a GCS directory or a Drive file is imported as before,
without the check. The library materializer does not split; it rejects a
longer PDF, or one it cannot count, before import.

Worker health reports `pdf_import.status: degraded` while the LLM parser is
configured and `qpdf` or `pdftotext` is missing.

With Google's default parser no page limit has been observed and none is
applied.

## Re-imports of a URI the corpus already holds

`ImportRagFiles` dedupes against every existing ragFile with the same source
URI, ERROR records included: a re-import of such a URI reports
`skippedRagFilesCount` and imports nothing. Verified live on 2026-07-29, when
embedding-backend 429s left ERROR records behind and every retry no-oped until
those records were deleted. The worker deletes ERROR records for a URI before
importing it, so a failed import (a failed split part included) can be
retried, and it reports a skipped import as present only when the URI's
ragFile is ACTIVE.

A staged batch relies on this dedupe across re-runs: each file is staged at
`staged/<domain>/<batch>/<first 32 hex of its sha256>/<file name>` and the
batch imports exactly those URIs, so an unchanged file is skipped and a changed
one is imported under a new URI. The changed file's previous version stays in
the corpus; an object no run names is never imported again.

The worker matches a ragFile to an object by its exact source URI. When Vertex
lists a ragFile without one, it falls back to the display name (the object's
file name) only when no ragFile names the URI and exactly one ragFile in the
corpus carries that name. A changed file and its previous version share a file
name, so such an object is left unmatched (its state unknown) rather than taken
for the other version.

`ImportRagFiles` takes several URIs per request (`GcsSource.uris` is a repeated
string) and documents no maximum; the worker sends at most 25 per request, a
cautious guess rather than a known limit.

## Sources

- Issue #33 (2026-10-16): the 582-page failure, the code-13 failure shape and
  the documented 500-page parser limit.
- Pull request #37 (2026-10-16): the 2026-10-08 page-count measurements and
  the 9-of-9 manual split.
- The ERROR-record dedupe note in the worker's `deleteErrorRagFileRecords`
  (verified 2026-07-29).
