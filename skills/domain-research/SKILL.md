---
name: domain-research
version: 0.1.0
description: Answer any question about what a library book, paper, talk, or author says — domain_ask first, with your domain_id, before web search, memory, or any other lane. Also covers bounded source intake, corpus operations, and reviewable document collaboration for a configured expert.
tools:
  - domain_ask
  - domain_source
  - rag_corpus
  - domain_doc
mutating: true
---

# Domain Research

## When this skill applies

Any question about what a book, paper, talk, or author says — what X argues,
where X and Y disagree, what a report claimed — is a library question: call
`domain_ask` FIRST, with the expert's stable `domain_id` named explicitly,
before any web search, memory search, or another product's source tools.
Repository and code search tools cannot see the library; reaching for one on
a library question is always the wrong tool, not a fallback. If retrieval
errors, report the error verbatim and stop — there is no fallback lane.

## Grounded answering

Use `domain_ask` for grounded questions. Pass the expert's stable domain id and
return cited claims plus explicit gaps. Where configured, editorial preferences
apply automatically. Pass `output: "passages"` when you will write the answer
yourself from the named passages (the worker then skips its own synthesis, so
the library is read once). Use `retrieval_mode: "history"` for historical/version
comparison or when the owner explicitly requests ordinary retrieval order.
Preference labels indicate source usefulness, not current beliefs. Report a
profile error; do not silently bypass it.

Never add question-specific answer
templates or imply support from material retrieval did not return.

Use `domain_source` to register approved material. Record title, author,
canonical locator, trust posture, copyright posture, and explicit target
corpus. Private or unclear material requires owner approval before cloud
import.

Use `rag_corpus` for dry-run lifecycle plans, then execute only after the plan
and destination have been approved. Credentials stay inside the configured
task-scoped adapter. Use `domain_doc` for comments or visibly marked edits;
direct edits require approval and must remain reviewable.

## Verified intake

A source is in the library only when its import reports `imported` (or the
ingestion ledger has it and the corpus lists the rag file as `ACTIVE`).
`import_requested`, `import_empty`, `import_failed` and `blocked` are not
success: report them verbatim, with the operation name or error the result
carries, and never summarize them as "ingested". Every object needs a title
and creator in the master manifest, otherwise it cites as a hash. Vertex RAG
parses PDF, text, Markdown and HTML only; ebooks (EPUB, DJVU) are converted to
Markdown before import and MOBI/AZW3 are refused, so do not upload them raw.

If an adapter or corpus is unavailable, report the missing layer. Do not route
around the boundary with shell, browser scraping, raw credentials, or another
product's private implementation.
