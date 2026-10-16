# Guided identity workshop

Use this ceremony when the owner wants to choose a name, avatar, or personality
interactively. Its preview gates apply to that guided mode. It is never a
prerequisite for an explicitly delegated creation request.

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

