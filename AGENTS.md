# Expert Agents agent instructions

Expert Agents is generic machinery for creating and operating expert agents.
Other projects depend on it and call the domain-expert worker. When a consumer
needs a library capability (a retrieval mode, a citation shape, a serving
allowlist), add it here so every consumer gets it; downstream repositories do
not re-implement retrieval. External systems are consumed only through stable
public interfaces — no imports of another project's private modules, and no
privileged integration.

Use TypeScript and Bun. Keep deterministic mechanics in packages and
judgment/workflow in skills. Never add persona-specific defaults to the generic
runtime, and use neutral names in fixtures and examples; the boundary scan
enforces this. Each expert's workspace, persona and library holdings live in
its own repository, never here.

Never commit credentials, source holdings, workspaces, memories, databases,
logs, generated web output, caches, or learning episodes. Secret values are
injected through a task-scoped credential adapter and must not appear in
errors or receipts.

`bun run verify` is the full gate: all Bun tests, TypeScript checks, builds,
boundary scans, and plugin packaging without skip-on-missing behavior. Run
focused checks locally; the full verify and required CI must be green before
merge, and `main` requires a pull request and a green check. Preserve
unrelated work and stage files intentionally.
