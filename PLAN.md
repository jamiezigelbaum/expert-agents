# Plan

Delivered in source: [direct library reading](docs/direct-library-reading.md)
through `domain_read`, with scoped canonical-source access, revision-pinned
sequential reads, and extraction coverage. Live activation requires the worker
and host plugin update under their deployment owner's procedure.
Legacy staged/acquired holdings are also readable by their current authorized
RAG file identity, without copying source objects or creating new embeddings.

Open engineering work.

1. **Large-document ingestion.** The delivered per-PDF ceiling is 100,000,000
   bytes, and with the LLM parser 200 pages per imported PDF
   ([limits](docs/vertex-rag-limits.md)). Acquired PDFs are split into parts
   by every worker import route, with a per-part registry record, resumable
   retries and citations in original pages; the materializer rejects them.
   The 1 GB target needs streaming, resumable processing; acceptance criteria
   are in the
   [deployment guide](deploy/README.md#ingestion-limits-and-pdf-handling).
2. **Worker socket transport.** Replace the loopback bearer with a permissioned
   Unix-domain socket, keeping TCP as a config-selectable fallback; see the
   [residual-risk note](deploy/README.md#residual-risk--loopback-bearer-accepted-2026-07-31).

Deferred: factory and container redesign.
