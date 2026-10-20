# Advanced checkout workflow

Use this workflow from an Expert Agents machinery checkout, for example to build
an agent's page library from originals the owner already holds.

1. From the Expert Agents machinery checkout, create the independent repository
   with the chosen name, emoji, and avatar:

   ```sh
   bun run expert:create -- \
     --target <agent-repo> \
     --agent-id <agent-id> \
     --display-name <display-name> \
     --domain-id <domain-id> \
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
4. Replace the placeholder in `<agent-repo>/library/eval-questions.json` with
   owner-approved questions. Run `expert:status` again.
5. Fill the page library. For a handful of sources, call `library_ingest` from
   the agent's session and check each job's `status`. For a whole library the
   owner already holds, run the parse-once lane from the checkout
   ([`docs/page-library.md`](../../../docs/page-library.md)):

   ```sh
   bun run library:pages parse --sources <approved-source-list> --originals <dir> --out <derivatives>
   bun run library:pages assemble --out <derivatives> --tree <page-library-root>/<domain-id>
   bun run library:index import --source <domain-id> --tree <page-library-root>/<domain-id>
   bun run library:index embed --source <domain-id>
   ```

   Report every failed, empty or unresolved page the lane lists.
6. Call `domain_library` with `action=catalog` and the configured domain ID.
   Check that every approved source is there with a title and creator, and that
   its unit range matches the original.
7. Apply the factory's `EXPERT_AGENTS_DOMAIN_EXPERT_AGENTS_JSON` routing snippet
   (its `pageLibrary` block names the tree and the index source) through the
   approved runtime configuration path. Prove identity, one grounded answer
   with page citations, and one explicit knowledge gap before declaring ready.
