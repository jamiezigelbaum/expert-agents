# Plan

Open engineering work.

1. **Retire the Vertex materializer.** The worker no longer reads or imports
   into Vertex corpora. `packages/library-materializer`, the owner-lane
   `expert:library ingest` and `expert:ingest` staging, `library:materialize`,
   `library:partition` and the docs they cite (Vertex RAG limits, library
   architecture, prepared text intake) remain until it is removed.
2. **Worker socket transport.** Replace the loopback bearer with a permissioned
   Unix-domain socket, keeping TCP as a config-selectable fallback; see the
   [residual-risk note](deploy/README.md#residual-risk--loopback-bearer-accepted-2026-07-31).

Deferred: factory and container redesign.
