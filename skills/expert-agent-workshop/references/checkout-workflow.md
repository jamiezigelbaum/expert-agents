# Advanced checkout workflow

Use this workflow from an Expert Agents machinery checkout, for example to select
a shared library through a reviewed scope and materialization.

1. From the Expert Agents machinery checkout, create the independent repository
   with the chosen name, emoji, and avatar:

   ```sh
   bun run expert:create -- \
     --target <agent-repo> \
     --agent-id <agent-id> \
     --display-name <display-name> \
     --domain-id <domain-id> \
     --target-corpus <corpus-display-name> \
     --receipt <approved-receipt-path> \
     --issue-tracker <escalation-channel> \
     [--emoji <emoji>] \
     [--avatar <chosen-image-path>] \
     [--remote <private-repository-url>]
   ```

   Git initialization and the first commit run by default; never hand over a
   zero-commit agent repository. `--avatar` accepts one png, jpg, jpeg, or webp
   image of at most 2 MB and refuses anything else. Review the printed routing
   snippet. The printed remote-wiring commands are a handoff only; run them
   solely after the owner approves the external write. `--remote` wires `origin`
   locally and still pushes nothing.
2. Run `bun run expert:status -- --dir <agent-repo>`. Resolve hard contract
   failures before continuing.
3. Use the `soul-workshop` skill to interview the owner, preview the complete
   draft, obtain explicit acceptance, and write `SOUL.md` and `IDENTITY.md` in
   the agent repository.
4. Author `<agent-repo>/library/scope-manifest.json` against the shared-library
   contract and replace the placeholder in
   `<agent-repo>/library/eval-questions.json`. Run `expert:status` again.
5. Rehearse materialization without `--execute`, review its content-free receipt,
   then execute only after approval:

   ```sh
   bun run library:materialize -- \
     --bucket <configured-bucket> \
     --prefix <configured-prefix> \
     --scope <agent-repo>/library/scope-manifest.json \
     --candidates <approved-candidate-directory> \
     --receipt <approved-plan-receipt>
   ```

6. Use `bun run library:annotate -- --bucket <bucket> --prefix <prefix>
   --propose --out <proposal>` for missing metadata. Review proposals before the
   separate `--execute --annotations <reviewed-file> --receipt <receipt>` call.
7. Run the retrieval gate with `bun run retrieval:eval -- --worker <worker-url>
   --questions <agent-repo>/library/eval-questions.json --receipt <receipt>`.
8. Call `domain_agent` with `action=catalog` and the configured domain ID. Check
   that every selected source is materialized in the intended corpus and resolve
   content-free catalog errors.
9. Apply the factory's `EXPERT_AGENTS_DOMAIN_EXPERT_AGENTS_JSON` routing snippet
   through the approved runtime configuration path. Prove identity, one grounded
   answer with citations, and one explicit knowledge gap before declaring ready.

