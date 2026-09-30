---
name: expert-agent-workshop
version: 0.4.0
description: Create an independent expert from a conversational request using expert_factory: repository, purpose-based soul, bounded Vertex library and managed Telegram bot, with resumable progress and explicit readiness. Offer the guided identity workshop when the owner wants it.
tools:
  - expert_factory
  - domain_agent
  - rag_corpus
  - domain_ask
mutating: true
---

# Agent Workshop

Create each expert in its own repository. Never place an agent workspace, soul,
identity, user context, source library, or personal content in the Expert Agents
machinery repository.

## Default conversational path

When the owner asks to create an expert, use `expert_factory`. The factory is
packaged with the plugin; the normal path needs no machinery checkout or shell
commands from the model. Respect authorization already given. Infer routine
names and technical identifiers when the owner delegated those choices. Ask
only for a missing product decision or an actual deployment prerequisite.

1. Translate the request into `action: "create"`, a new lowercase `agent_id`,
   `display_name`, `purpose`, and a suggested `telegram_username` ending in
   `bot`. Suggest one plausible name and move on: availability cannot be
   checked before creation, and if Telegram reports it taken the owner picks
   another name inside the confirmation flow and the factory adopts the bot
   actually created. Include an authored `soul` if the owner asked you to draft one;
   otherwise the factory writes a minimal soul from the stated purpose. Never
   put credentials in tool arguments.
2. Use `apply: true` when the owner has authorized creation. Omit it for a
   preview. Do not ask for another approval of an already-authorized step.
3. Show `confirmation_url` as soon as it is returned. Telegram's supported
   managed-bot flow requires the owner to confirm creation using the configured
   Telegram account. The deployment must have a dedicated manager bot with
   Bot Management Mode enabled and no competing poller or webhook. Do not
   impersonate the owner's account or promise unattended bot creation.
4. After confirmation, call `action: "resume"`, the same `agent_id`, and
   `apply: true`. Resume also handles pending Vertex provisioning. Keep the
   existing operation; do not create a second agent or corpus to retry.
5. Report the returned status literally. `waiting_for_activation` means the
   Gateway owner must complete the installation's approved activation path;
   the factory never improvises a restart. `ready_empty_library` proves a
   committed repository, a ready corpus, validated configuration, and matching
   live Telegram identity/polling. It does not prove a populated library or a
   successful expert answer. `status` reads saved progress only; use `resume`
   for fresh readiness checks.
6. Import the owner's approved sources into the new domain using `rag_corpus`
   and run the retrieval/citation checks before claiming the expert knows that
   material. Existing shared-library selections still use the reviewed scope
   and materialization workflow below. Never silently inherit another domain's
   corpus. A local file must be inside the worker's configured workspace for
   `stage_import`; a Telegram attachment is not automatically there. Report a
   missing approved attachment intake adapter rather than treating metadata
   registration as ingestion or reading another session's media.

The factory is available only in an owner session with host filesystem
authority and explicitly enabled deployment settings. Its refusal explains the
missing prerequisite; do not bypass it using shell or guessed credentials.
Each generated expert defaults to its own domain when making research calls.
Agent repositories are initialized locally; remote Git hosting is a separate
deployment choice and is never implied by a local commit.

## Optional guided workshop

Use the identity ceremony below when the owner wants to choose a name, avatar,
or personality interactively. Its preview gates apply to that guided mode.
Do not make it a prerequisite for an explicitly delegated creation request.

## Intake

Confirm the target directory, stable agent and domain IDs, display name, optional
emoji, corpus display name, recurring jobs, privacy posture, approved library
location, escalation channel, workspace adapter, and whether managed RAG is
appropriate. Ask before importing private or copyrighted material, creating
cloud or GitHub resources, or binding a messaging identity.

## Identity ceremony

### 1. Brain dump

Ask the owner to describe the expert in their own words: the domain, what it
should be able to talk about, what it should refuse, the temperament they want,
and anything it should feel like. Let them ramble. Do not interview yet, and do
not start proposing while they are still describing.

Capture the brain dump **verbatim** into the creation notes before you interpret
any of it. It seeds the name, the avatar, the soul interview, and the library
scope, so a tidy paraphrase throws away material you will need three steps
later. Read it back and ask what is missing.

### 2. Name suggestions

Propose 3-5 candidate names, each with a one-line rationale grounded in the
domain — a figure associated with it, a concept at its center, or a word that
carries its texture. Vary the register across the candidates rather than
offering five versions of one idea.

Check each candidate **before** you propose it, and show the check beside the
name:

- it must reduce to a valid agent id: a lowercase slug of letters, digits, dots,
  underscores, and hyphens, beginning and ending with a letter or digit;
- no agent, repository, or workspace of that name may already exist in this
  deployment — look, do not assume; and
- a messaging handle cannot be confirmed free without the owner, so say that
  plainly instead of implying availability.

The owner picks one, counters with their own, or asks for another round. Creation
does not start until a name is chosen.

### 3. Avatar suggestions — iterative rounds

Generate AT LEAST THREE candidate avatar images per round with the image tool
available in this deployment, working from the brain dump and the chosen name.
Keep the prompts clear of living people's likenesses and of third-party marks.

Show every round's candidates with the file path of each. The owner picks one,
or gives feedback — and feedback starts a NEW round: fold the feedback into
the prompts and generate at least three fresh candidates. There is no round
limit; the ceremony holds at this step until the owner picks. Keep every
round's files until a pick is made, so the owner can reach back to an earlier
candidate.

The chosen file is passed to `expert:create` as `--avatar`; the factory copies
it into the repository, names it in `agent.json`, and includes it in the first
commit.

If no image tool is available in this deployment, say so plainly and continue
without an avatar. It can be added later — by re-running creation with
`--avatar`, or by committing an image into the agent repository and setting
`agent.json`'s `avatar` to its repo-relative path.

### 4. Messaging identity

The agent's bot is created by the messaging platform's own manager-bot flow, on
the owner's confirmation. Never drive the owner's messaging account: an agent
operating that account holds every power the account holds, which is not a
power this ceremony asks for.

For Telegram, run the factory command and stay with it until it returns:

```sh
bun run expert:telegram-provision -- \
  --username <ChosenNameBot> \
  --name <display-name> \
  --token-file <deployment-token-file-path> \
  [--avatar <chosen-jpeg-path>]
```

The command prints a confirmation link. Show the owner that link and say what
the tap does: **one tap creates the bot; this tap is the owner's deliberate
gate — no agent ever operates the owner's Telegram account.** The suggested
username and display name arrive pre-filled and stay editable, so the owner may
change them at the last moment.

Then wait for the command's own receipt. It reports the username Telegram
actually created, the token-file path, a token fingerprint, and whether the
avatar was set. Record **the username from that receipt**, not the one you
requested, in `binding.json`. If the owner has not tapped by the timeout, say so
and re-run the same command — a tap that lands late stays queued and the next
run resolves it without asking for a second tap.

One-time deployment prerequisite: a manager bot with bot-management mode enabled
on the messaging platform, with its token in the deployment's secret store,
exposed to the command through the environment. Without one, this step has no
automation — see the fallback below. The manager credential is never passed as a
command-line argument.

The manager can retrieve or rotate child credentials. The command
`bun run expert:telegram-provision -- --rotate --username <ChosenNameBot>
--token-file <path>` invalidates the previous token and stores a replacement;
rotation is not retirement. Disable the account through the approved Gateway
configuration path when the intended outcome is to stop it serving.

The bot token is a credential: it goes directly into the deployment's secret
store and token-file path, is never pasted into chat or logs, and is referenced
everywhere else only by its store name and fingerprint. Gateway registration and
routing stay with whichever lane owns the gateway configuration and go through
its blessed pathway.

**No-automation fallback.** With no manager bot in this deployment, hand the
owner the exact manual steps and wait: talk to the platform's bot-registration
bot, create the bot under the chosen username, set the display name and the
chosen avatar, and place the token in the deployment's secret store at the
token-file path — the owner does this, and the token never passes through chat.
Then record the username the platform assigned in `binding.json`.

### 5. Personality

Hand the brain dump to the `soul-workshop` skill and run that flow to
completion. It owns the interview, the complete preview, explicit owner
acceptance, and the writes of `SOUL.md` and `IDENTITY.md`. Do not draft a
personality here, and never treat the scaffolded placeholder as one.

The ceremony ends when the soul and identity are **accepted and written**, not
when the repository exists.

## Assembly order

Brain dump → names → avatar → messaging identity → `expert:create` →
`soul-workshop` → library and corpus wiring → the ready-to-populate report.
Each step consumes the previous one's output, so a step taken early is a step
taken on a guess.

## Advanced checkout workflow

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

## Ready-to-populate report

Close with a short report of exactly what now exists, so the owner knows what
they can hand books to:

- the repository path and its first commit id;
- the chosen name and agent id;
- the avatar: its repo-relative path, or that none was chosen;
- soul and identity: accepted and written, or still pending;
- the routing snippet from the creation output and whether it was applied; and
- corpus status: created and populated, created and empty, or not yet created.

Report only what a tool result actually shows. Never narrate a step as done
because it was planned, and state plainly what remains before the expert can be
populated.

`domain_agent bootstrap` remains available for legacy workspace-internal work;
do not use it to create an independent agent repository. Never route around a
missing adapter with raw credentials, direct cloud access, or another product's
private internals.
