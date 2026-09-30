# Agent repository contract

## Ownership and file classes

Every expert agent has one independent Git history and two checkouts: the live
OpenClaw workspace and an owner working copy. A history or checkout is never
shared between agents. The live workspace is authoritative for workspace files;
the repository records their history and also carries machinery-facing contract
files.

Files belong to one of three ownership classes:

- **Workspace-file class:** the six required seed files (`AGENTS.md`,
  `SOUL.md`, `IDENTITY.md`, `TOOLS.md`, `USER.md`, and `HEARTBEAT.md`) plus
  everything the agent authors in its live checkout, including `MEMORY.md`,
  `memory/`, `BOOT.md`, checklists, and arbitrary files. The live workspace
  wins. Owner-side edits are proposals that travel by Git push and pull and
  take effect at the agent's next session start.
- **Contract-file class:** `agent.json`, `binding.json`, the avatar image named
  by `agent.json`, `library/`, and `derived/`. The machinery side wins; these
  files change only through reviewed commits and are inert to the live agent's
  context. The avatar is the one contract file that is public-safe by
  definition: it is the face the agent shows to whoever it talks to, so it is
  expected to ship in serving artifacts rather than to be held back.
- **Excluded class:** secret- and transcript-class content, runtime state, and
  local caches. These files never enter Git, are named by the scaffolded
  `.gitignore` that exists from the first commit onward, and remain in the
  encrypted-snapshot custody lane.

Agent workspaces, souls, identity and user context, private evaluation
questions, source holdings, and personal content never belong in the Expert
Agents machinery repository. This repository contains only the tenant-neutral
factory, validators, templates, and plugin-distributed agent skills.

The contract is validated offline by `@expert-agents/provisioning`. Validation
reads the caller-selected agent repository and makes no network or cloud calls.

## Required layout

An agent repository root has this shape:

```text
.gitignore
agent.json
binding.json (optional)
avatar.<png|jpg|jpeg|webp> (optional)
AGENTS.md
SOUL.md
IDENTITY.md
TOOLS.md
USER.md
HEARTBEAT.md
references/
library/
  scope-manifest.json
  eval-questions.json
derived/ (optional)
  <artifact-id>/
    artifact.json
    content.md
```

The six Markdown workspace files are required non-empty seeds, not the complete
workspace. `references/` must exist as a directory and may otherwise be empty.
Validators tolerate additional agent-owned files.

Hydrate a live workspace through OpenClaw's native path:

```sh
git clone <agent-repository-url> <workspace-path>
openclaw setup --workspace <workspace-path>
```

The clone makes the workspace the second checkout of the agent's single
history. `openclaw setup` backfills any missing native template files; it does
not replace files already present in the checkout.

## Two skill systems

**Superseding note (2026-07-31):** this section replaces the former owner-only
classification. Since the 2026-07-30 packaging cutover, every skill in this
repository's `skills/manifest.json` is distributed as an agent-side skill in
the OpenClaw plugin package:

- `expert-agent-workshop`: plugin-distributed agent creation and proving workflow;
- `expert-annas-archive-acquisition`: plugin-distributed bounded acquisition workflow;
- `domain-research`: plugin-distributed research and domain-tool routing workflow;
- `soul-workshop`: plugin-distributed soul and identity workshop workflow.

`scripts/package-plugin.ts` copies the complete `skills/` tree into the plugin
artifact. These four skills are machinery-owned, tenant-neutral agent skills;
they do not become owner-only Claude Code tooling merely because a developer
may also load one from a local checkout.

## Agent manifest

`agent.json` is strict schema version 1:

```json
{
  "schemaVersion": 1,
  "agentId": "neutral-agent",
  "displayName": "Neutral Agent",
  "domainId": "neutral-domain",
  "targetCorpusDisplayName": "neutral-corpus",
  "emoji": "◉",
  "avatar": "avatar.png"
}
```

`emoji`, `avatar`, and `serving` are optional; all other fields are required.
Unknown fields are rejected. IDs use lowercase letters, digits, dots,
underscores, and hyphens, begin and end with a letter or digit, and have at most
128 characters. Human-facing values must be non-empty, trimmed, single-line
strings.

`avatar` is a repo-relative POSIX path to the agent's image. It must be a
non-empty trimmed single-line string, may not be absolute, `~`-prefixed, or
contain a backslash, a `.` or `..` segment, or an empty segment, and may not end
in `/` — it names a file, not a directory. It may not resolve into any
structurally or excluded-class path, so an avatar cannot be smuggled through a
class of content that may never ship. Format and size are creation-time rules
rather than manifest rules, so a repository whose avatar predates them stays
valid.

The manifest is consistent only when:

- `agentId` equals `library/scope-manifest.json`'s `agentId`;
- `targetCorpusDisplayName` equals the scope manifest's target; and
- `domainId` equals `library/eval-questions.json`'s `domainId`.

## Deployment posture and the serving set

One repository has N deployments in two postures.

- **Tracking (owner-facing).** A live git checkout with a write-scoped deploy
  key. The agent self-edits, commits, and pushes. Every agent has one.
- **Pinned (customer-facing).** A read-only workspace materialized from a
  release artifact built from a tag, with no git remote and no push credential
  in the sandbox. An agent with no `serving` block has none, and is not
  packageable — absence is default-deny, not an error.

`agent.json` may carry an optional `serving` block. It stays optional and
`schemaVersion` stays `1`, so every repository created before serving machinery
remains valid and untouched.

```json
{
  "serving": {
    "include": ["AGENTS.md", "SOUL.md", "derived/"],
    "corpora": [
      { "corpusId": "neutral-public", "disclosure": "full" },
      { "corpusId": "neutral-private", "disclosure": "derived" }
    ]
  }
}
```

`include` is a default-deny allowlist of repo-relative POSIX paths. It must be
non-empty and unique; entries are single-line and may not be absolute, contain a
backslash, contain a `.` or `..` segment, or be the bare `.` or `/`. An entry
ending in `/` is a directory prefix; any other entry is an exact file path.

**Structural exclusions.** `USER.md`, `MEMORY.md`, and `memory/` may never reach
a served deployment, and neither may any excluded-class path named by the
scaffolded `.gitignore`. Naming one is a hard validation error, and the same
refusal runs again at packaging time after directory prefixes expand. The
second check is the real gate: a lexically innocent prefix such as `notes/` is
refused when it expands onto `notes/MEMORY.md`.

`corpora` is optional; when present it is non-empty with unique corpus IDs.
Disclosure posture is per corpus, so one agent can mix all three:

- **`full`** — the served instance may retrieve across the corpus, bounded at
  answer time by excerpt caps, mandatory citation, and refusal of bulk or
  sequential reconstruction.
- **`derived`** — the sources never reach a served instance; only an accepted
  distillation does.
- **`excluded`** — the corpus is absent from served deployments entirely.

**Memory policy by posture.** A tracking deployment owns `MEMORY.md` and
`memory/` as workspace-file class and rewrites them freely. A pinned deployment
never receives them, and its per-hire state lives outside the artifact and is
never committed back.

`expert:status` warns with `agent.serving.missing_path` when a named path is
absent from the working tree and `agent.serving.derived_without_artifact` when a
`derived` corpus has no accepted distillation. Both are warnings that leave the
default exit code alone, and both name `agent.json` and a rule ID only — never
the absent path or the corpus.

### Where disclosure is enforced

Files are enforced at packaging; retrieval is enforced in the worker. The worker
mediates every corpus read, so it is the layer that can actually deliver the
guarantee — a quote bound in worker code is a guarantee, the same rule in a
prompt is a hope.

A served deployment declares its posture in its routing entry
(`EXPERT_AGENTS_DOMAIN_EXPERT_AGENTS_JSON`, see
[`LIBRARY_ARCHITECTURE.md`](./LIBRARY_ARCHITECTURE.md)), reusing the same
`corpusId` and `disclosure` vocabulary as the `serving` block. With a posture
declared, the worker refuses to reach a `derived` or `excluded` corpus before
any retrieval executes, bounds every excerpt it returns from a `full` corpus,
withholds any excerpt it cannot attribute, and refuses rather than trims once a
session has crossed the cumulative per-source bound. Holdings listing stays
permitted and truthful for a disclosed corpus: an agent that can say what it has
read is more useful and more honest.

**An agent that declares no posture is unconstrained.** Absence means no
constraint applied, so tracking deployments configured before this machinery
existed behave exactly as they did.

## Derived artifacts

A derived artifact lives at `derived/<artifact-id>/` and is **contract-file
class**, not workspace-file class: the machinery side wins, and an accepted
artifact changes only through a reviewed commit. The live agent drafts; the
owner reviews and accepts; the accepted text is committed. A live agent must not
silently rewrite an accepted artifact.

**Doctrine** is the agent's working model: its position on the material in its
library and how it does its work. It exists to make the agent better at serving,
and every expert may have one whatever its corpora look like. A doctrine is
**not** a privacy control, and it is distinct from `SOUL.md` — the soul is who
the agent is, the doctrine is how it works a body of material.

**Distillation** is a public-safe synthesis standing in for sources held back
under a `derived` posture. It *is* a privacy and copyright control, and its test
is the owner's: something that, if fully leaked, would be fine.

`artifact.json` is strict schema version 1:

```json
{
  "schemaVersion": 1,
  "kind": "distillation",
  "artifactId": "neutral-distillation",
  "corpusId": "neutral-private",
  "acceptedAt": "2026-07-28T00:00:00Z",
  "acceptedBy": "neutral-owner",
  "provenance": {
    "sourceCorpusId": "neutral-private",
    "sourceObjectIds": ["sha256:..."],
    "note": "Accepted after owner review."
  }
}
```

`artifactId` equals the directory name. A `distillation` must carry `corpusId`
naming the corpus it stands in for; a `doctrine` may omit it. `acceptedAt` is an
ISO-8601 UTC instant supplied by the caller — machinery never reads the clock.
No string in the manifest may read as a path outside the artifact's own
directory. `content.md` holds the artifact text, must be non-empty, and a
high-confidence secret pattern in it is a hard error, mirroring soul lint.

## Engagement learning

Client material lives in **per-engagement storage**, which is neither the agent
repository nor the shared library. `openEngagementStore` refuses a storage root
that overlaps either in either direction, and refuses a root inside any git
working tree, so client content has no path into an agent's history. One storage
root serves one engagement: reopening it under a different engagement id is
refused, so two clients of the same expert cannot be pointed at shared state.

The store's surface is write-and-delete. Nothing exported returns client
content, so a caller has nothing to hand to a library object, and the module
imports no library path at all. `expert:ingest` refuses a source — or a library
root — held inside per-engagement storage, which is the same rule enforced at
the library's own entrance. `closeEngagement` deletes every stored item at
engagement end and returns counts, never names, paths, or content.

Learning returns only as an accepted derived artifact of kind `doctrine`, never
as a distillation: a distillation stands in for held-back *library* sources, and
client content is never a library source. Extraction is an owner-side action:

```sh
bun run expert:learning -- --engagement <dir> --agent <agent-repo> --library <dir> \
  --draft <file> [--artifact-id <id> --accepted-by <name> --accepted-at <instant>]
```

Without the acceptance triple the command seals a draft for review and writes
nothing. `extractEngagementLearning` is where **the learning opt-out is
enforced** — not in any user interface. It refuses a draft that repeats client
content verbatim beyond `LEARNING_VERBATIM_SPAN_LIMIT` characters, refuses a
draft that names its engagement, and refuses one carrying a high-confidence
secret pattern. Only a sealed draft can be accepted.

**The opt-out is prospective only** (owner ruling 2026-07-28). Opting out stops
extraction from that moment and does not unwind learning already accepted.
Accordingly there is no provenance from an accepted generalization back to an
engagement and no rebuild-without-it path: `acceptEngagementLearning` takes no
engagement parameter, so the link cannot be recorded even by mistake. Reversing
that ruling is an architecture change, not a settings change.

## Release packaging

```sh
bun run expert:release -- --dir <agent-repo> --tag <tag> --out <output-root>
```

Content is read **at the tag** through local git plumbing — never from the
working tree, never fetching. A missing git binary is a typed error, not a
silent pass. The output root must be absent or empty.

```text
<output-root>/
  workspace/            # serving-set files at their repo-relative paths
  SERVING_MANIFEST.json
  SERVING_CHECKLIST.md
  SERVING_RECEIPT.json
```

Only `workspace/` is ever mounted. The manifest, checklist, and receipt are
operator material and never land inside it. `SERVING_MANIFEST.json` is
generated rather than copied from `agent.json`, so a future manifest field
cannot reach a customer by default. It names the `avatar` only when the serving
set actually materialized that file, so the manifest never points a served
deployment at an image its artifact does not contain; the `include` allowlist
remains the only thing that decides what ships.

Packaging enforces these preconditions as hard failures that leave no output
directory behind:

- the manifest at the tag declares a `serving` block;
- every named path resolves to at least one file at the tag;
- no materialized path is structurally or excluded-class refused, re-checked
  after directory prefixes expand;
- every derived artifact at the tag is valid, including its `content.md`;
- every `derived`-posture corpus has an accepted `distillation` naming it, and
  none of that corpus's declared source objects reach the artifact — checked by
  content address, so a source object cannot ship under a renamed path, and by
  path, so a source object ID cannot appear as a shipped path. Semantic review
  of a distillation remains the owner's acceptance gate;
- no file entering the artifact contains a high-confidence secret pattern.

`SERVING_RECEIPT.json` is canonical JSON listing every artifact file by
repo-relative path, SHA-256, and byte count, sorted by path. Equal tag in,
byte-identical artifact and receipt out.

Soul lint, retrieval evaluation, and the parity battery are network gates.
Packaging does not attempt them; it names them as `[MANUAL]` preconditions the
operator runs, and `SERVING_CHECKLIST.md` repeats them alongside the four
offline posture steps: read-only `workspace/` mount, no git remote or push
credential in the sandbox, deny-by-default egress, and per-hire state kept
outside the artifact and never committed back.

## Binding declaration

`binding.json` is optional so repositories created before binding machinery
remain valid. When present, it is strict schema version 1:

```json
{
  "schemaVersion": 1,
  "openclaw": {
    "agentId": "neutral-agent",
    "workspacePath": "/srv/agents/neutral-agent"
  },
  "telegram": {
    "botUsername": "@neutral_bot",
    "tokenFilePath": "/run/secrets/telegram-neutral-agent.token",
    "dmPolicy": "owner-allowlist",
    "groupTopics": [
      { "topicId": 42, "note": "Operator-approved topic" }
    ]
  }
}
```

`openclaw.agentId` must equal `agent.json`'s `agentId`; `workspacePath` is
optional. The Telegram declaration is optional. When present, its DM policy is
either `allowlist` (the gateway's native value) or `owner-allowlist` (this
repository's older private spelling of the same intent, still accepted so
binding files written before 2026-07-28 stay valid), its token-file path is
absolute or `~/`-prefixed, and an
optional username matches `^@[A-Za-z0-9_]{4,31}bot$`. Token values never belong
in the repository or any machinery artifact. See
[`BINDING_MACHINERY.md`](./BINDING_MACHINERY.md) for the offline application and
verification workflow.

## Library files

`library/scope-manifest.json` is an agent-owned
[`ScopeManifest`](./LIBRARY_ARCHITECTURE.md) validated by
`@expert-agents/library`. It never moves into this machinery repository or the
shared-library bucket.

`library/eval-questions.json` follows the strict schema in
[`RETRIEVAL_EVAL.md`](./RETRIEVAL_EVAL.md). The retrieval gate requires at least
one question. A factory scaffold therefore contains one clearly marked valid
placeholder question and a placeholder content ID; replace both with an
owner-approved evaluation before running `retrieval:eval`.

## Soul mechanics

Soul authorship is a judgment workflow owned by the `soul-workshop` skill. The
validator enforces only mechanical rules:

- `SOUL.md` is non-empty under the workspace-file contract;
- its length is at most 20,000 JavaScript string characters;
- its last non-empty line is an italic `*...*` notification footer; and
- it contains no high-confidence secret pattern from the repository boundary
  scan.

Length, footer, and soul-lint non-empty findings are warnings in status. A
secret-pattern finding is a hard error. The workspace contract independently
treats an empty `SOUL.md` as an error because every required workspace file must
be non-empty.

## Factory and status commands

Create a scaffold from the machinery checkout:

```sh
bun run expert:create -- \
  --target <agent-repo> \
  --agent-id <agent-id> \
  --display-name <display-name> \
  --domain-id <domain-id> \
  --target-corpus <corpus-display-name> \
  --receipt <approved-receipt-path> \
  [--emoji <emoji>] \
  [--avatar <image-path>] \
  [--telegram-token-path <absolute-token-file-path>] \
  [--issue-tracker <escalation-channel>] \
  [--remote <private-repository-url>] \
  [--no-git]
```

The target may be absent or an empty directory; a non-empty target is refused.
The factory fills plain `{{placeholder}}` Markdown templates, writes deterministic
JSON, preserves `references/` in Git with an empty marker, and leaves source and
personal content out of the scaffold. It always writes the OpenClaw portion of
`binding.json`; `--telegram-token-path` adds a starter Telegram declaration with
no bot username.

Version control is the default, not an opt-in: local `git init` runs, only
scaffold files are explicitly staged, and an initial commit is created, so no
agent repository is ever handed over with zero commits. `--no-git` opts out and
the skipped commands are printed instead. `--remote` runs `git remote add
origin` locally; the factory pushes nothing and creates no remote repository,
because no hosting credential is assumed to exist wherever the factory runs.
`--issue-tracker` names the escalation channel rendered into the seeded
`AGENTS.md`; without it the scaffold renders a visible placeholder rather than
inheriting any repository path.

`--avatar` takes an image on the operator's disk and copies it into the scaffold
as `avatar.<ext>`, sets the manifest's `avatar` to that path, and stages it with
the rest of the first commit. Only `png`, `jpg`, `jpeg`, and `webp` are
accepted, decided by the source file's extension before any bytes are read, and
the image must be non-empty and at most 2,097,152 bytes. Without `--avatar` the
manifest carries no `avatar` field at all and the creation output names adding
one as a next step, so an agent without a face is a visible gap rather than a
silent one.

The command prints three operator handoffs: an
`EXPERT_AGENTS_DOMAIN_EXPERT_AGENTS_JSON` routing snippet with configured-library
placeholders, remote-wiring commands it does not execute (creating or wiring a
private repository, and publishing the first commit), and `[MANUAL]` workspace
hydration steps to clone the agent repository, run `openclaw setup --workspace`
to backfill missing templates, and start a new session so OpenClaw loads the
workspace files.

The seeded `AGENTS.md` carries two enforced sections. `## Harness discipline`
states that the agent is a reporter and escalator, never an implementer of
shared-repository code or host configuration, never hand-patches a live system,
escalates through the configured channel, and that the digest overrides softer
local guidance. `## Closing out` requires committing tracked changes scoped to
the agent's own paths before reporting done, naming the file and commit id
rather than describing intent, and stating explicitly when a commit was not
possible.

The creation receipt contains only sorted relative paths, SHA-256 hashes, byte
counts, and directory names. Equal inputs produce byte-identical receipt bytes;
the target directory itself and generated file content are absent.

Inspect an existing repository with:

```sh
bun run expert:status -- --dir <agent-repo>
```

Status exits zero only when the hard contract is valid. Its deterministic report
contains per-item presence, parse, and validity booleans plus findings named only
by file and rule ID. Its `git` section contains only `isRepo`, `hasUpstream`,
`aheadCount`, `behindCount`, `dirtyTrackedCount`, and `untrackedCount`. It reads
local refs and worktree state without fetching; missing upstream and non-repo
targets are represented by booleans and zero counts. If Git is unavailable,
`git` is `null` and ordinary status still succeeds.

Status warns with `repo.sync.behind`, `repo.sync.dirty`, and
`repo.sync.no-upstream` without changing the default exit code. Require a clean,
locally current checkout with an upstream for owner-side mutation workflows:

```sh
bun run expert:status -- --dir <agent-repo> --require-sync
```

The sync gate exits non-zero for any sync warning, unavailable Git, or a
non-repository target. It never includes workspace file content, Git branch or
file names, remote URLs, manifest values, question or answer text, source data,
or absolute repository paths.

When `binding.json` is present, status validates its schema and its agent-ID
consistency with `agent.json`. Its absence is not a finding.
