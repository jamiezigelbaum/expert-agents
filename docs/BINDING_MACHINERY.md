# Binding machinery

Binding machinery moves an expert repository from merely valid to ready for an
operator to make reachable. It is declarative and entirely offline: it creates
application artifacts and checks an operator-supplied text file. It never
contacts or modifies an OpenClaw gateway, Telegram, BotFather, or any messaging
API.

## Declarative model

An agent repository may contain `binding.json`:

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

The OpenClaw agent ID must equal `agent.json`'s `agentId`. `workspacePath` is
optional. The whole Telegram declaration is optional. When Telegram is
declared, `dmPolicy` is `allowlist` (native) or `owner-allowlist` (legacy
spelling), `botUsername` is optional and
must match `^@[A-Za-z0-9_]{4,31}bot$` when present, and `tokenFilePath` must be
an absolute path.

`tokenFilePath` is a reference only. The machinery does not read the file. A
token value must never be placed in an agent repository, binding declaration,
descriptor, checklist, or receipt. Shell shorthand such as `~` is not an
absolute path for contract validation; supply its expanded absolute path.

New factory scaffolds always contain the OpenClaw declaration. Add a starter
Telegram declaration by supplying a token-file reference:

```sh
bun run expert:create -- \
  --target <agent-repo> \
  --agent-id <agent-id> \
  --display-name <display-name> \
  --domain-id <domain-id> \
  --target-corpus <corpus-display-name> \
  --receipt <approved-receipt-path> \
  --telegram-token-path <absolute-token-file-path>
```

The starter omits `botUsername`, ensuring the application checklist preserves
BotFather bot creation as a manual step. Existing pre-binding repositories may
omit `binding.json`; `expert:status` validates it only when present.

## Emit application artifacts

Run:

```sh
bun run expert:bindings -- \
  --dir <agent-repo> \
  --emit \
  --out <empty-output-directory>
```

The output directory receives:

- `binding-descriptor.json`: agent identity, OpenClaw and optional Telegram
  declarations, plus the routing linkage (`domainId` and
  `targetCorpusDisplayName`);
- `APPLICATION_CHECKLIST.md`: numbered operator actions; and
- `BINDING_RECEIPT.json`: only artifact-relative paths, SHA-256 hashes, and byte
  counts.

Equal valid inputs produce byte-identical outputs. The receipt does not contain
agent identity, routing values, workspace contents, token paths, or token
values.

Every human or external-system action is explicitly marked `[MANUAL]`. When the
username is absent, the checklist tells the operator to talk to `@BotFather`,
run `/newbot`, record the assigned username, and keep the token out of all
repositories and machinery outputs. Token-file provisioning is a separate
`[MANUAL]` action requiring mode `0600`.

Gateway registration is a numbered set of `[MANUAL]` native OpenClaw changes:
an `agents.list[]` entry with `id`, `name`, and `workspace` when a
`workspacePath` is declared; a `bindings[]` entry shaped as
`{agentId, match: {channel: "telegram", accountId}}`; and bot-token
provisioning at `channels.telegram.accounts.<id>.botToken` through the
operator's secret-custody process. Every sub-step is contract-first: verify the
exact keys with `openclaw docs` / `config.schema.lookup`, then apply only via
`openclaw config set` / `config.patch`. The machinery remains declarative and
offline and invents no key values.

## Verify an applied configuration

After the operator applies the declaration, run:

```sh
bun run expert:bindings -- \
  --dir <agent-repo> \
  --verify \
  --gateway-config <operator-supplied-file>
```

This reads the supplied file as text and performs an identifier-presence check;
it is not a semantic parse of any gateway configuration format. It checks the
bounded agent ID and, when declared, the exact bot username and token-file path.
It exits zero only when every declared identifier is found.

The deterministic JSON report names only identifier classes (`agentId`,
`botUsername`, and `tokenFilePath`) with found/missing booleans. It contains no
identifier values, gateway content, or absolute gateway-config path.
Verification uses no network and neither reads nor validates the token file
itself.

## Rollback

The emitted checklist has a `ROLLBACK` section with inverse manual actions in
reverse application order:

1. `[MANUAL]` Remove the native `bindings[]` entry, when present, and the
   `agents.list[]` entry through the approved contract-first change protocol.
2. `[MANUAL]` Remove the provisioned token file through the approved
   secret-custody process, when Telegram was declared.
3. `[MANUAL]` Return to BotFather for an owner-approved inverse action when the
   checklist created a new bot.

The machinery does not execute any rollback action.
