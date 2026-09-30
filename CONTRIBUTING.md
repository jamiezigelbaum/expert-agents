# Contributing

## Setup

Requires Bun 1.3+.

```sh
bun install --frozen-lockfile
bun run verify
```

`bun run verify` must pass before a pull request is ready. CI runs the same
command from a clean checkout, plus a container smoke test of the worker image.

## Conventions

- TypeScript on Bun. Deterministic mechanics live in `packages/`; judgment and
  workflow live in `skills/`.
- Every workspace package defines real `typecheck`, `test`, and `build`
  scripts; the verifier rejects placeholders.
- The runtime is tenant-neutral: no persona-specific defaults, and fixtures
  use neutral names. The boundary scan enforces this.
- Credentials enter only through the task-scoped credential adapter and never
  appear in errors, logs, receipts, or Git.
- Retrieval, reranking, and citation improvements belong here so every
  consumer gets them; downstream projects should not re-implement them.
- Keep `docs/` current: update the reference doc a change affects, and keep
  dated logs, handoffs and deployment records out of the repository.

## Pull requests

Keep each pull request to one change, describe what it changes and how it was
verified, and add or update tests with behavior changes. Pull requests are
squash-merged once CI passes.
