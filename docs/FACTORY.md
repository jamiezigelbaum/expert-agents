# Conversational expert factory

An owner can ask an OpenClaw assistant with this plugin to create a new expert.
The `expert_factory` tool creates an independent local Git repository and soul,
connects a new domain to its own Vertex corpus, obtains a managed Telegram bot
after the owner's confirmation, and applies the agent/account binding through
OpenClaw's supported commands. Every returned state describes observed progress.

Agent creation uses `gateway call agents.create` with the requested stable id,
workspace and optional model, followed by `agents.update` bound to that id to
apply the display name. Both RPC responses must confirm success and the expected
agent; creation must also confirm the workspace. On retry, the factory observes
the existing agent before continuing the name update and account setup.

The factory lives in the installed artifact: `dist/plugin.js` registers the tool
and `dist/factory.js` runs its Bun mechanics. It does not require a source
checkout. The manifest's `skills` field makes the workshop discoverable by
OpenClaw. Research tools carry explicit parameter schemas.

The creation and acquisition skills are named `expert-agent-workshop` and
`expert-annas-archive-acquisition`. When upgrading existing agent instructions
or explicit skill allowlists, update references to the former unprefixed names.
These distinct names allow the plugin to coexist with installations that still
publish the legacy workflows.

## One-time deployment setup

The installation owner must provide these prerequisites through its normal
configuration and credential process. Repository delivery does not enable them.

- Bun 1.3+ and a supported OpenClaw CLI on a POSIX host, both with absolute executable paths.
- An authenticated Expert Agents worker and a configured Google project with
  Vertex RAG permissions. The GCS library bucket already exists; the factory
  creates a per-agent prefix and corpus, not cloud billing/IAM or a new bucket.
  Numeric project aliases in provider responses require
  `resourcemanager.projects.get` to verify that they belong to the configured
  project; an unverified alias never authorizes an operation poll.
- Two private, owner-controlled 0700 directories: a factory root outside all
  Git worktrees, and a disjoint token directory. The factory creates
  `agents/<id>` and `operations/<id>` below the root. Token files never enter
  agent repositories, process arguments, tool outputs or receipts.
- A dedicated Telegram manager bot whose Bot Management Mode is enabled in
  BotFather. Store its token in a private regular file through approved secret
  custody. This manager must have no webhook and no other `getUpdates` consumer;
  do not configure it as a Gateway polling account. The factory reads updates
  without discarding requests belonging to other creations. A full unmatched
  queue requires operator handling and is reported explicitly.
- The owner's numeric Telegram user id. A different user cannot confirm a
  creation. The requested bot username is a suggestion: Telegram offers no
  availability check before creation, so when it reports the name taken the
  owner picks another name inside the same confirmation flow. The factory
  records the manager queue's highest update id before issuing the link and,
  on resume, adopts the single newer bot this owner created that no other
  operation claims, recording `telegram_username_changed_from`. Two or more
  such bots are refused as ambiguous rather than guessed; bots queued before
  the link are never adopted.
  A username or numeric bot identity already assigned to another factory
  operation is refused; an old confirmation cannot create a second account
  with the first bot's token.
- A trusted owner session with host filesystem authority. Sandboxed sessions
  and `workspaceOnly` tool policies cannot create repositories outside their
  workspace and receive a refusal.
- If the calling assistant has an explicit `tools.allow` list, include
  `expert_factory` in that existing list. Plugin installation and factory
  enablement do not override a caller's tool allowlist; the owner, sandbox and
  filesystem checks still apply.

The worker's registration authority is off by default. Configure an allowed
library subtree, for example:

```sh
EXPERT_AGENTS_DOMAIN_EXPERT_REGISTRATION_LIBRARY_JSON='{"bucket":"example-library","prefix":"experts"}'
```

Requests must stay in that bucket and prefix. Existing environment routes and
already-existing corpus names are protected. Dynamic registrations persist in
the worker's private data directory; do not add them to Git. A new registration
does not modify the static environment routing manifest.
Registered routes use client import receipts and omit Vertex's optional GCS
results sink. This avoids requiring the Vertex service agent to write an
additional results object. The same default applies when older registrations
are loaded; explicit deployment routes retain their configured sink behavior.
The registration request does not accept an ingestion-policy override.

The following is a configuration shape, not a command to edit live config. Verify
the installed manifest and apply it using the installation's approved
`openclaw config set` / `config.patch` pathway:

```json
{
  "factory": {
    "enabled": true,
    "rootDir": "/srv/expert-factory",
    "tokenDirectory": "/srv/expert-credentials",
    "managerTokenFile": "/srv/manager-credentials/telegram-manager.token",
    "ownerTelegramUserId": 123456,
    "libraryBucket": "example-library",
    "libraryPrefix": "experts",
    "openclawBin": "/usr/local/bin/openclaw",
    "bunBin": "/usr/local/bin/bun"
  }
}
```

Keep the normal `domainExpert` worker configuration alongside it, including its
existing SecretRef bearer. An optional `model` selects the deployment-approved
model for new agents. Model authentication remains the host's responsibility;
the factory does not copy another agent's OAuth credentials.

The optional `activationCommand` is a legacy deployment-owned executable hook.
Leave it unset when platform operations owns activation: the factory then waits
for that owner and resumes readiness checks afterward. Do not introduce a new
restart wrapper or point the hook at a lifecycle command during shared Gateway
work. Existing hook retirement belongs to the deployment owner under
[deployment ownership](DEPLOYMENT_OWNERSHIP.md). The at-most-once activation
attempt behavior remains for existing deployments; ambiguous failures never
trigger repeated restarts.

Optional remote history wiring: `remoteUrlTemplate` is an `https://`, `ssh://`
or `file:///` URL containing `{agentId}` exactly once and no credentials, for
example `https://github.com/example-owner/{agentId}.git`. When it is set, the
factory adds it as `origin` right after the initial commit, pushes with
`--set-upstream`, and records the remote only after `@{upstream}` proves the
pushed head. An optional `remoteCreateCommand` names an absolute,
deployment-owned executable that creates the remote idempotently; it receives
the agent id and the resolved URL as its only arguments and must succeed when
the repository already exists. Push authentication is the host's
responsibility (a credential helper or deploy key reachable from the Gateway's
environment). Both settings are excluded from the operation fingerprint, so an
operation recorded before wiring existed is adopted on its next resume: an
`origin` an operator already added by hand is reused, never duplicated.

## Conversation and states

Example authorized tool request:

```json
{
  "action": "create",
  "agent_id": "example-expert",
  "display_name": "Example Expert",
  "purpose": "Help me study the sources I approve for this domain. Cite evidence and state gaps.",
  "telegram_username": "ExampleExpertBot",
  "apply": true
}
```

Omitting `apply` makes a read-only plan. It never writes files or contacts
external services. Creation validates existing identities, authorizes the
worker route, writes and commits the agent repository, ensures the corpus,
then returns Telegram's confirmation link. Share that link immediately.

After the owner confirms, call:

```json
{"action":"resume","agent_id":"example-expert","apply":true}
```

| State | Meaning and next step |
| --- | --- |
| `planned` | No resources created. Repeat with authorized `apply: true`. |
| `wiring_remote` | The initial commit exists but the configured remote has not proven the pushed head. Fix the remote or its credentials, then resume; the commit is never repeated. |
| `waiting_for_corpus` | A Vertex create operation has been submitted. Resume checks its result without replaying an uncertain submission. |
| `waiting_for_telegram` | Use `confirmation_url` with the configured owner account; keep the suggested username or pick another if Telegram reports it taken. Then resume. |
| `waiting_for_activation` | Config is validated; live polling and bot identity are not yet proven. Complete approved activation, then resume. |
| `ready_empty_library` | Repository commit, corpus readiness, account configuration and matching Telegram polling are established. Import sources and prove an agent answer. |

`status` reads stored progress only; it is not a live health check. `resume`
performs a fresh readiness check. Spec changes for an existing id are refused.
Never delete and recreate an operation to work around a provider failure.

The route to the new agent is installed before its Telegram account is enabled,
so polling cannot start with a fallback route. Identical bindings are reused
after interrupted setup. Full read-only host lint retains all checks and has a
180-second subprocess budget; other commands retain 90 seconds, within the
factory invocation's overall 300-second bound.

Each factory-created workspace is bound to its own domain by trusted OpenClaw
tool context. Its research calls default to that domain, and explicit calls to
a different domain are refused. Legacy agents continue using their configured
deployment default. Telegram accounts allow only the configured owner in DMs
and disable groups by default.
Disable new creation with `factory.enabled: false` while retaining `rootDir`;
existing experts keep their domain bindings when creation is disabled.

## Library population and proof

A ready corpus is empty. The factory does not invent a library selection or
claim expertise from the presence of a cloud resource. Use the normal reviewed
scope/materialization flow for a shared library, or the bounded `rag_corpus`
import operations for approved URLs, GCS objects, Drive files or worker-local
staged files. Confirm Vertex import completion and ACTIVE files, then run a
cited answer and an explicit knowledge-gap test. Avatars and more elaborate
personality workshops remain optional subsequent work.

An OpenClaw attachment path and a worker-local path are different authorities.
The current host tool context exposes the workspace and owner identity, but no
trusted current-turn attachment list. The plugin therefore does not read the
shared inbound-media directory based on a caller-supplied path. Use an approved
host intake adapter to place the requested attachment in the worker workspace,
then `stage_import`; `domain_source add` alone only registers metadata.

## Recovery and operational limits

The September 8 activation attempt exposed an OpenClaw CLI startup failure:
`agents add` loaded plugins in full mode with an unresolved worker SecretRef.
The factory uses the supported Gateway RPC command path, which does not load
plugins in the CLI process. Worker credential validation remains unchanged;
no literal credential or plugin-disable workaround is needed. A failure after
agent creation remains resumable without repeating creation or Telegram token
installation.

The factory serializes creation across the deployment. Ordinary dependency
errors retain the last recorded step and release the lock. A killed process can
leave a lock or a partially published scaffold; the owner must inspect those
artifacts before recovery. Existing arbitrary directories and token files are
never silently adopted. Uncertain Vertex creation remains recorded and is not
reissued; operator reconciliation may be required after an ambiguous submission.
When Vertex returns a numeric project alias but Resource Manager lookup is
unavailable, the worker retains the bounded operation reference privately and
returns pending progress with the Telegram confirmation link. Resume retries
project validation before polling; no unverified alias grants access to an
operation. Restore project lookup access if the corpus is not yet discoverable
as ACTIVE. Malformed references and confirmed project mismatches remain errors.
For imports, a numeric project alias is verified by reading the operation under
the configured project id and exact authorized corpus, then requiring the full
returned name to match. A failed lookup retains a private candidate and requires
reconciliation; it never triggers another import submission. Neither a completed
operation nor its receipt proves that every imported file is ACTIVE.

Agent repositories contain authored workspace files and an initial Git commit.
Operation records contain private creation inputs and content-free progress,
with mode 0600 under the private factory root. They are not public receipts and
must not be published. Public tool results exclude soul/purpose text and raw
provider/CLI errors. Token rotation is credential replacement, not agent
retirement. No deletion, remote Git publication or automatic cleanup of cloud
resources is part of this tool.

Platform contracts verified for this implementation:
[Telegram managed bots](https://core.telegram.org/bots/features#managed-bots),
[managed token API](https://core.telegram.org/bots/api#getmanagedbottoken),
[OpenClaw agent commands](https://docs.openclaw.ai/cli/agents), and
[Telegram account configuration](https://docs.openclaw.ai/channels/telegram).
