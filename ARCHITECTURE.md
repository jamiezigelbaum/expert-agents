# Expert Agents architecture

The product is tenant-neutral machinery for creating and operating expert
agents: agent planning, grounded managed RAG, source registration, document
collaboration, and approval-gated acquisition through bounded adapters. This
repository is a shared library engine: marketplaces, expert providers, and
other consumers use it through the domain-expert worker's HTTP interface or as
a package dependency. Consumer and marketplace code does not live here.
Retrieval, reranking, fusion and citation are improved once, here, for all
consumers — never re-implemented downstream.

The OpenClaw manifest and fat skills are the interaction surface. Deterministic
mechanics live in TypeScript packages. The plugin package contains only the
manifest, built plugin entry, package metadata, and active skills.

## Boundaries

- No package imports another project's private modules.
- External knowledge platforms are ordinary public-interface dependencies,
  never privileged runtime dependencies.
- Credentials enter only through a task-scoped adapter and are never included
  in tool output, logs, receipts, or Git.
- Source holdings, workspaces, generated corpora, databases, and logs remain
  external state.

## Verification

Every workspace package must define real `typecheck`, `test`, and `build`
commands. CI begins from a clean checkout, uses the committed lockfile, and
runs `bun run verify`.
