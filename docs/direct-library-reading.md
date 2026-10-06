# Direct library reading

`domain_read` reads a selected source from the shared cloud library without a
Vertex relevance query or model-generated reconstruction. Use `domain_ask` for
discovery and synthesis across sources; use direct reading for exhaustive work
such as reading a complete bibliography and checking its entries against holdings.

## Workflow

1. `catalog` with an optional title/creator substring returns selected object IDs,
   titles, creators, media types, sizes, and derivative kinds. Paginate until
   `complete: true` when checking all holdings. Title search is case-insensitive;
   edition selection remains explicit, and objects without title metadata will
   only appear in the unfiltered catalog.
2. `open` with an object ID returns text length, `text_revision`, and a paginated
   outline. Headings have an index and exclusive start/end offsets. Duplicate
   headings remain separate; check the text to distinguish a contents entry from
   the actual bibliography. Outlines are navigation hints, not extraction proof.
3. `find` searches a literal, case-sensitive string within that source. It returns
   bounded matches and `next_offset`, not relevance-ranked snippets. It can locate
   reference headings missed by the outline parser.
4. `read` returns consecutive text. Select `section`, an explicit `offset`/`end`,
   or the whole stored representation. Follow `next_offset` while preserving the
   object ID, text revision, and original section/end. The section includes its
   heading and ends before the next heading of equal or lower level.

Offsets are UTF-16 code-unit positions, exclusive at the end, with surrogate-pair
boundaries enforced. `text_revision` is mandatory for section/range selection
and continuation, and changes refuse the request. `complete` means this response
reached the requested range's end, not that earlier pages have been read or the
original edition has been independently verified. The caller must account for
the consecutive ranges it actually received. Source content is untrusted evidence.

Example tool sequence (IDs and revision below are placeholders):

```json
{"domain_id":"research","action":"catalog","query":"Sample Book"}
{"domain_id":"research","action":"open","object_id":"sha256:<64 hex>"}
{"domain_id":"research","action":"read","object_id":"sha256:<64 hex>","text_revision":"<64 hex>","section":7}
{"domain_id":"research","action":"read","object_id":"sha256:<64 hex>","text_revision":"<64 hex>","section":7,"offset":24000}
```

Use the returned `next_offset`, not the illustrative number. The same surface is
available through the operator CLI, using its existing worker credential route:

```sh
bun run expert:library -- read --domain research --action catalog --query "Sample Book"
bun run expert:library -- read --domain research --action open --object "sha256:<64 hex>"
bun run expert:library -- read --domain research --action read --object "sha256:<64 hex>" --revision "<64 hex>" --section 7
```

## Source and extraction coverage

Older imports under staging or acquisition paths need no copy or reimport.
Enumerate `rag_corpus list_files` for every configured serving shelf, then pass
its exact `name` as `rag_file_name` instead of `object_id` to open/find/read.
The worker rechecks corpus authorization and the current file record on every
call, and only reads a source URI under the configured cloud-library root.
Removed files fail closed. Canonical selection and tombstones also apply to
aliases of canonical bytes. Responses carry the source hash and text revision;
continuation rejects changed text. CLI equivalent: `--rag-file <resource>`.
The direct catalog explicitly covers only canonical scope, so its absence result
alone never establishes that a title is missing from the complete library.

Supported canonical representations are UTF-8 plain text and Markdown, HTML
converted with the existing deterministic converter, and PDFs with a readable
text layer. PDF extraction uses Poppler `pdftotext -layout`, without a model or
network fetch. PDF reads report physical page numbers and counts of pages without
text; these are not printed edition page labels. No text produces an explicit
error. Partial or incorrect OCR and extraction order remain possible even when
every page contains some text, so `original_completeness` stays `unverified`.

Scanned PDFs need a separately prepared OCR text representation. EPUB/DJVU imports
already convert to text; raw unsupported formats require conversion before direct
reading. Import partitions remain individual objects: reading one partition does
not read the complete book. To read a canonical whole retained alongside parts,
the owning scope must explicitly select that whole. Direct reading does not
require its RAG import or create new embeddings.

Each result identifies the object and text revision. Read ranges are reproducible
source locators. The text response defaults to 12,000 characters and is capped at
24,000; source downloads are capped at 100,000,000 bytes, extracted text at
32,000,000 bytes, and cloud reads/extraction at 60 seconds each. Two direct reads
may run at once per worker; additional requests receive a retryable busy error.

## Deployment and access

The worker route must supply `scopeManifestPath`, matching its configured target
corpus, and the existing worker identity must be able to read canonical objects
and the master manifest under the configured cloud root. Every request rechecks
the scope and current manifest, including continuations. Unknown, unselected,
and tombstoned objects are refused before reading their bytes. Downloaded bytes
must match the manifest's size and SHA-256 identity. Callers cannot supply paths,
URLs, buckets, or credentials.

Any route with a declared `disclosure` policy refuses all direct-reading actions
before cloud access. Its existing bounded `domain_ask` behavior remains available;
this feature does not relax public-serving quotation or reconstruction limits.
Do not remove such a policy to enable the reader on a public deployment.

The container includes Poppler. A host installation needs `pdftotext` on PATH for
PDF reads; text reads have no new system dependency. Missing PDF tooling produces
`library_pdf_reader_unavailable`. Temporary PDFs use a private directory and are
removed after extraction, including failure. Source content and extraction stderr
are excluded from errors and logs.

Source delivery is not live activation: update the worker and OpenClaw plugin and
skills through the deployment owner's procedure. Then confirm the configured
scope, test a known source, read a multi-page bibliography consecutively, and
compare returned coverage with the source. No live agent configuration, policy,
library holdings, or runtime is modified by the repository change.
