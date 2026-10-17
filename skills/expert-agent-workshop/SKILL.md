---
name: expert-agent-workshop
version: 0.6.0
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

## Create an expert with expert_factory

When the owner asks to create an expert, use `expert_factory`. The factory is
packaged with the plugin; the normal path needs no machinery checkout or shell
commands from the model. Respect authorization already given. Infer routine
names and technical identifiers when the owner delegated those choices. Ask
only for a missing product decision or an actual deployment prerequisite.

1. **Pre-flight, before the first create.**
   - Work in a turn the owner sent. The factory refuses with
     `factory_owner_required` in a subagent completion, another session or a
     scheduled turn.
   - Check whether this session has `rag_corpus`. If it does not, tell the
     owner now that filling the library needs a session that has it (step 7).
   - Tell the owner up front: the new bot stays silent until activation. After
     the Gateway is configured, it starts the bot's Telegram account once
     in-flight runs finish, which can take about five minutes while other work
     is running.
   - With `apply: true`, the factory runs its own preflight before it creates
     anything. A refusal with phase `preflight` (`factory_gateway_reload_off`,
     `factory_google_not_ready`, `factory_remote_missing`,
     `factory_remote_has_history`, or `factory_command_failed` such as System
     GitHub refused or a missing `gh` or deployment program) means nothing was
     created. Tell the owner the named cause, have it fixed, then repeat the
     same create. `factory_remote_has_history` means a repository with that
     name already exists: pick another `agent_id`; never ask to overwrite it.
2. Translate the request into `action: "create"`, a new lowercase `agent_id`,
   `display_name`, `purpose`, and a suggested `telegram_username` ending in
   `bot`. Suggest one plausible name and move on: availability cannot be
   checked before creation, and if Telegram reports it taken the owner picks
   another name inside the confirmation flow and the factory adopts the bot
   actually created. Include an authored `soul` if the owner asked you to draft
   one; otherwise the factory writes a minimal soul from the stated purpose.
   Never put credentials in tool arguments. Use `apply: true` when the owner has
   authorized creation; omit it for a preview. Do not ask for another approval
   of an already-authorized step.
3. Show `confirmation_url` as soon as it is returned. Telegram's managed-bot
   flow requires the owner to confirm creation with the configured Telegram
   account. Do not impersonate the owner's account or promise unattended bot
   creation. The link exists before the repository is written: if the create
   fails at a later phase, call `status` for the same `agent_id`, which returns
   `confirmation_url`, share it, and resume once the cause is fixed.
4. **Resume only in the owner's own turn.** After the owner confirms, call
   `action: "resume"` with the same `agent_id` and `apply: true`. If you fixed a
   cause in the background (a subagent or another session), do not resume from
   that completion turn: tell the owner what changed and ask them to say go,
   then resume in their reply. Resume also handles pending Vertex provisioning.
   Keep the existing operation; never start a second agent, corpus or operation
   to retry.
5. Report the returned status literally. `status` reads saved progress only;
   `resume` checks again live.
   - `waiting_for_activation`: configuration is written and validated, but the
     bot is not proven running, so it is still silent. Wait a few minutes and
     resume in the owner's next turn; the factory never improvises a restart.
   - `ready_empty_library` is reached only by a resume after the Telegram
     account is live. It proves the committed repository, a ready corpus,
     validated configuration and matching Telegram identity and polling. The
     real test is the owner messaging the bot and getting a reply. The library
     is still empty.
6. **When a call fails, locate it before retrying.** Factory errors from an
   applied call name their `phase` and usually a `step`; command failures also
   name a `category` (`auth`, `not_found`, `rejected`, `unavailable`,
   `invalid`, `timeout`, `missing_command`, `failed`). Private output is always
   withheld. Phase `preflight` means a check stopped the call before any step
   ran: have the cause fixed, then repeat the same request. Any other phase is
   where progress stopped: have the cause fixed, then resume the same operation
   in the owner's turn. If an error carries no phase, read (never edit)
   `operations/<agent_id>/state.json` under the factory root, the directory two
   levels above `repository_path`; its `phase` names the step.
   - `factory_busy`: another factory call is running. Retry after it
     finishes; a lock left by a process that exited clears itself. Ask the
     deployment owner only when the message says the lock names no owner.
   - `factory_timeout`: the call exceeded five minutes and was stopped.
     Progress is kept: call `status`, then resume in the owner's turn.

   | Phase | Step to check |
   | --- | --- |
   | `creating_repository` | Writing the local agent repository |
   | `committing_repository` | The first local Git commit |
   | `wiring_remote` | Creating the GitHub repository and pushing as System GitHub (`tools.github`) |
   | `registering_library` | Worker domain registration |
   | `bootstrapping_workspace` | Seeding the worker's domain workspace; resume re-checks it |
   | `creating_corpus` | Requesting the Vertex corpus |
   | `waiting_for_corpus` | Vertex corpus readiness; resume checks it again |
   | `waiting_for_telegram` | The owner confirming the bot through the link |
   | `installing_telegram_token` | Installing the bot token |
   | `configuring_gateway` | Agent, route and Telegram account; `not_found` on `agents.update` usually means the Gateway did not load the change (reload off) |
   | `waiting_for_activation` | The Gateway starting the Telegram account |
   | `ready_empty_library` | Done; the library is empty |

7. Import the owner's approved sources into the new domain with `rag_corpus`,
   in a session that has that tool, and run the retrieval and citation checks
   before claiming the expert knows that material. When this session lacks
   `rag_corpus`, say so plainly; never substitute shell, direct cloud access or
   another product's tools. Never silently inherit another domain's corpus. A
   local file must be inside the worker's configured workspace for
   `stage_import`; a Telegram attachment is not automatically there. Report a
   missing approved attachment intake adapter rather than treating metadata
   registration as ingestion or reading another session's media.

The factory is available only in an owner session with host filesystem
authority and explicitly enabled deployment settings. Its refusal explains the
missing prerequisite; do not bypass it using shell or guessed credentials.
Each generated expert defaults to its own domain when making research calls.

## Optional guided workshop

When the owner wants to choose a name, avatar, or personality interactively,
run the identity ceremony in `references/guided-workshop.md`: brain dump, name
suggestions, avatar rounds, messaging identity, and the `soul-workshop` skill.
Do not make it a prerequisite for an explicitly delegated creation request.

## Advanced checkout workflow

To work from a machinery checkout, for example to select a shared library
through a reviewed scope and materialization, follow
`references/checkout-workflow.md`.

## Ready-to-populate report

Close with a short report of exactly what now exists, so the owner knows what
they can hand books to:

- the repository path, its first commit id and its remote, if any;
- the chosen name, agent id and Telegram link (and a changed username);
- soul and identity: accepted and written, or the minimal purpose-based soul;
- the returned status; and
- corpus status: created and populated, created and empty, or not yet created.

Report only what a tool result actually shows. Never narrate a step as done
because it was planned, and state plainly what remains before the expert can be
populated.

The factory seeds each expert's worker workspace with `domain_agent bootstrap`
itself. If `domain_agent status` later reports a missing workspace seed for a
factory expert, resume its operation instead of calling bootstrap, and never
use bootstrap to create an independent agent repository. Never route around a
missing adapter with raw credentials, direct cloud access, or another product's
private internals.
