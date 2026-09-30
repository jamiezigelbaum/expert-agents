# Plan

Open engineering work.

1. **Large-document ingestion.** The delivered per-PDF ceiling is 100,000,000
   bytes. The 1 GB target needs streaming, resumable processing with
   original-page citations; acceptance criteria are in the
   [deployment guide](deploy/README.md#ingestion-limits-and-pdf-handling).
2. **Worker socket transport.** Replace the loopback bearer with a permissioned
   Unix-domain socket, keeping TCP as a config-selectable fallback; see the
   [residual-risk note](deploy/README.md#residual-risk--loopback-bearer-accepted-2026-07-31).

Deferred: factory and container redesign.
