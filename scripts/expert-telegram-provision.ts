/**
 * Managed-bot provisioning for a deployment's messaging identity.
 *
 * Telegram Bot API 9.6 sanctioned bot-to-bot provisioning, which replaces
 * driving the owner's Telegram account through a GUI: a manager bot asks for a
 * child bot, the owner confirms the creation with one deliberate tap, and only
 * then does the manager receive the child's identity. The tap is the point —
 * no agent ever holds the owner's account.
 *
 * Every shape below was read from the live documentation on 2026-07-30:
 *
 * - https://core.telegram.org/bots/features — section "Managed Bots". Share
 *   link format: `https://t.me/newbot/{manager_bot_username}/{new_username}?name={new_name}`.
 *   "Your @ManagerBot receives a managed_bot update with a ManagedBotUpdated
 *   object." The manager bot is a one-time deployment prerequisite: "Open the
 *   bot's settings in BotFather's MiniApp and enable 'Bot Management Mode'."
 * - https://core.telegram.org/bots/api#update — field `managed_bot`, type
 *   `ManagedBotUpdated`: "Optional. A new bot was created to be managed by the
 *   bot, or token or owner of a managed bot was changed".
 * - https://core.telegram.org/bots/api#managedbotupdated — fields `user`
 *   (User) "User that created the bot" and `bot` (User) "Information about the
 *   bot. Token of the bot can be fetched using the method getManagedBotToken."
 *   There is no discriminator between creation and token change, so a caller
 *   has to match on the bot it asked for.
 * - https://core.telegram.org/bots/api#getmanagedbottoken — "Use this method to
 *   get the token of a managed bot. Returns the token as String on success."
 *   Exactly one parameter: `user_id` (Integer, required). There is no lookup by
 *   username, which is why a numeric id is the only stateless resume handle.
 * - https://core.telegram.org/bots/api#replacemanagedbottoken — "Use this
 *   method to revoke the current token of a managed bot and generate a new one.
 *   Returns the new token as String on success." Parameter: `user_id`
 *   (Integer, required).
 * - https://core.telegram.org/bots/api#setmyprofilephoto — "Changes the profile
 *   photo of the bot. Returns True on success." Parameter: `photo`
 *   (InputProfilePhoto, required). `InputProfilePhotoStatic` is "A static
 *   profile photo in the .JPG format" and its `photo` field takes
 *   "attach://<file_attach_name>" because "Profile photos can't be reused and
 *   can only be uploaded as a new file".
 * - https://core.telegram.org/bots/api#getupdates — `allowed_updates` is "A
 *   JSON-serialized list of the update types you want your bot to receive ...
 *   See Update for a complete list of available update types", so the type
 *   string is the Update field name: `managed_bot`. Also: "An update is
 *   considered confirmed as soon as getUpdates is called with an offset higher
 *   than its update_id" — the basis of the resume path below.
 *
 * The token value never reaches stdout, stderr, an error, or a log line. Bot
 * API request URLs carry the token in their path, so every string this module
 * emits passes through the secret registry's redaction first.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

const TELEGRAM_API_BASE = "https://api.telegram.org";
/** The `Update` field name, which is also its `allowed_updates` type string. */
const MANAGED_BOT_UPDATE_TYPE = "managed_bot";
/** Telegram closes long polls well before this; 50s keeps a margin under it. */
const MAX_LONG_POLL_SECONDS = 50;
const DEFAULT_TIMEOUT_SECONDS = 900;
const IDLE_POLL_INTERVAL_MS = 1_000;
const REDACTED = "[redacted]";
const TOKEN_FINGERPRINT_CHARACTERS = 12;
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const ATTACH_NAME = "profile_photo";

export const USAGE = `Usage: bun run expert:telegram-provision -- <mode>

Provision (default):
  --username <child-bot-username>   suggested @username, must end in "bot"
  --name <display name>             suggested display name, editable by the owner
  --token-file <absolute path>      where the child token is written, 0600
  [--avatar <jpeg path>]            profile photo, JPEG only (Telegram's rule)
  [--timeout-seconds <n>]           how long to wait for the tap (default ${DEFAULT_TIMEOUT_SECONDS})
  [--replace]                       allow an existing token file to be replaced
  [--accept-username-change]        accept a managed bot whose username the owner edited
  [--user-id <n>]                   resolve this managed bot directly, no link and no wait

Rotate (revoke the current token and issue a new one):
  --rotate --username <child-bot-username> --token-file <absolute path> [--user-id <n>]

Manager credentials come from the environment, never from argv:
  EXPERT_AGENTS_TELEGRAM_MANAGER_TOKEN       the manager bot token, or
  EXPERT_AGENTS_TELEGRAM_MANAGER_TOKEN_FILE  a file holding it

One-time deployment prerequisite: a manager bot with 'Bot Management Mode'
enabled in BotFather's MiniApp, with its token in the deployment's secret store.

Use a dedicated manager without a webhook or another getUpdates consumer.
Telegram gives the manager control of the child token. Rotation (--rotate)
invalidates the previous token and writes the replacement into the secret store.

A tap that lands after the timeout is not lost. Telegram keeps the update
unconfirmed, so re-running the same command resolves it without a second tap.`;

const NAMED_ARGUMENTS = [
  "--username",
  "--name",
  "--token-file",
  "--avatar",
  "--timeout-seconds",
  "--user-id",
] as const;

const BOOLEAN_ARGUMENTS = ["--rotate", "--replace", "--accept-username-change"] as const;

/**
 * Telegram usernames are 5-32 characters, start with a letter, and end with a
 * letter or digit. BotFather additionally requires a bot username to end in
 * "bot"; catching that here costs nothing and spares the owner a rejected tap.
 */
const USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]$/;

export type TelegramFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface TelegramProvisionDependencies {
  fetchImpl?: TelegramFetch;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export type TelegramProvisionMode = "provision" | "rotate";

export interface TelegramProvisionArguments {
  mode: TelegramProvisionMode;
  username: string;
  tokenFilePath: string;
  displayName?: string;
  avatarPath?: string;
  timeoutSeconds: number;
  replace: boolean;
  acceptUsernameChange: boolean;
  userId?: number;
}

/** How the child bot was identified, which is the difference between a fresh
 * ceremony, a resumed one, and an operator supplying the id by hand. */
export type TelegramResolution = "deep-link-tap" | "pending-update" | "user-id" | "existing-token";

export interface TelegramProvisionOutcome {
  mode: TelegramProvisionMode;
  requestedUsername: string;
  actualUsername: string;
  botId: number;
  tokenFilePath: string;
  tokenFingerprint: string;
  avatarSet: boolean;
  resolvedFrom: TelegramResolution;
  managerUsername?: string;
}

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  can_manage_bots?: boolean;
  username?: string;
  first_name?: string;
}

interface TelegramUpdate {
  update_id: number;
  managed_bot?: { user?: TelegramUser; bot?: TelegramUser };
}

interface ObservedManagedBot {
  id: number;
  username: string;
}

/**
 * Replaces known secrets and anything token-shaped with a placeholder.
 *
 * Two passes, because either alone leaks. Known-secret substitution catches a
 * token echoed verbatim in a proxy error body; the shape-based passes catch a
 * token this process never registered — a Bot API URL path segment, or a bare
 * `<id>:<secret>` pair.
 */
export function redactTelegramSecrets(text: string, secrets: Iterable<string> = []): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length >= 8) redacted = redacted.split(secret).join(REDACTED);
  }
  redacted = redacted.replace(/(\/bot)[A-Za-z0-9_:-]{8,}/g, `$1${REDACTED}`);
  redacted = redacted.replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, REDACTED);
  return redacted;
}

class SecretRegistry {
  private readonly secrets = new Set<string>();

  add(secret: string): void {
    if (secret.length >= 8) this.secrets.add(secret);
  }

  redact(text: string): string {
    return redactTelegramSecrets(text, this.secrets);
  }
}

export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, TOKEN_FINGERPRINT_CHARACTERS);
}

export function buildManagedBotDeepLink(
  managerUsername: string,
  username: string,
  displayName?: string,
): string {
  const base = `https://t.me/newbot/${managerUsername}/${username}`;
  if (displayName === undefined || displayName === "") return base;
  // URLSearchParams encodes a space as "+", matching the documented example
  // `https://t.me/newbot/ManagerBot/CoolAIAgentBot?name=Cool+AI+Agent`.
  return `${base}?${new URLSearchParams({ name: displayName }).toString()}`;
}

export interface ManagedBotBeginResult {
  managerUsername: string;
  requestedUsername: string;
  deepLink: string;
}

/** A bot the owner created after this operation began, under a name other than the requested one. */
export interface ManagedBotCandidate {
  botId: number;
  username: string;
  updateId: number;
}

export type ManagedBotProbeResult = ({ status: "pending" } | {
  status: "confirmed";
  botId: number;
  actualUsername: string;
}) & {
  /** The highest update id in the manager queue at probe time (0 when empty): the caller's watermark for later probes. */
  latestUpdateId: number;
  /** Present only when the probe was given `sinceUpdateId`: newer owner-created bots not matching the requested name. */
  candidates?: ManagedBotCandidate[];
};

/** Factory entry point: return the owner confirmation link without waiting.
 * The manager must be dedicated to this factory. Telegram allows only one
 * getUpdates consumer; a Gateway poller could otherwise consume confirmations.
 */
export async function beginManagedBotProvision(
  request: { username: string; displayName: string },
  dependencies: TelegramProvisionDependencies = {},
): Promise<ManagedBotBeginResult> {
  const username = normalizeChildUsername(request.username);
  if (typeof request.displayName !== "string" || request.displayName.trim().length === 0 || [...request.displayName].length > 64) {
    throw new Error("The managed bot display name must contain 1-64 characters.");
  }
  return withManager(dependencies, async (fetchImpl, token, secrets) => {
    const manager = await callTelegram<TelegramUser>(fetchImpl, token, "getMe", {}, secrets);
    if (manager?.is_bot !== true || manager.can_manage_bots !== true || typeof manager.username !== "string" || !USERNAME_PATTERN.test(manager.username)) {
      throw new Error("The configured manager must be a bot with Bot Management Mode enabled in BotFather.");
    }
    await requirePollingManager(fetchImpl, token, secrets);
    return { managerUsername: manager.username, requestedUsername: username, deepLink: buildManagedBotDeepLink(manager.username, username, request.displayName) };
  });
}

/** One non-acknowledging probe. Never advance the global update offset merely
 * to find this request: doing so loses other agents' pending confirmations.
 */
export async function probeManagedBotProvision(
  request: { username: string; ownerUserId: number; sinceUpdateId?: number },
  dependencies: TelegramProvisionDependencies = {},
): Promise<ManagedBotProbeResult> {
  const username = normalizeChildUsername(request.username);
  if (!Number.isSafeInteger(request.ownerUserId) || request.ownerUserId <= 0) {
    throw new Error("The expected Telegram owner user id must be a positive integer.");
  }
  if (request.sinceUpdateId !== undefined && (!Number.isSafeInteger(request.sinceUpdateId) || request.sinceUpdateId < 0)) {
    throw new Error("The update watermark must be a non-negative integer.");
  }
  return withManager(dependencies, async (fetchImpl, token, secrets) => {
    await requirePollingManager(fetchImpl, token, secrets);
    const updates = await getManagedBotUpdates(fetchImpl, token, secrets, undefined, 0);
    const latestUpdateId = updates.reduce((max, update) => Number.isSafeInteger(update?.update_id) && update.update_id > max ? update.update_id : max, 0);
    const ownerBots = updates.flatMap((update) => {
      const bot = update?.managed_bot?.bot;
      return update?.managed_bot?.user?.id === request.ownerUserId
        && bot !== undefined && Number.isSafeInteger(bot.id) && bot.id > 0
        && typeof bot.username === "string" && Number.isSafeInteger(update.update_id)
        ? [{ botId: bot.id, username: bot.username, updateId: update.update_id }] : [];
    });
    const matches = ownerBots.filter((bot) => sameUsername(bot.username, username));
    if (new Set(matches.map((bot) => bot.botId)).size > 1) {
      throw new Error("Telegram reported multiple managed identities for this username; resolve the bot identity before continuing.");
    }
    // Telegram has no availability check before creation and no discriminator
    // between a creation and a token change, so the only evidence that the owner
    // renamed the bot inside the confirmation flow is a newer update than the
    // queue held when the link was issued. The caller decides what to do with it.
    const candidates = request.sinceUpdateId === undefined ? undefined : [...ownerBots
      .filter((bot) => bot.updateId > request.sinceUpdateId! && !sameUsername(bot.username, username))
      .reduce((byId, bot) => byId.set(bot.botId, (byId.get(bot.botId)?.updateId ?? -1) > bot.updateId ? byId.get(bot.botId)! : bot), new Map<number, ManagedBotCandidate>())
      .values()].sort((left, right) => left.updateId - right.updateId);
    const extra = candidates === undefined ? {} : { candidates };
    const bot = matches[0];
    if (bot !== undefined) return { status: "confirmed", botId: bot.botId, actualUsername: bot.username, latestUpdateId, ...extra };
    if (updates.length >= 100) {
      throw new Error("The manager update queue is full before this confirmation. Use a dedicated manager and reconcile its pending updates; the factory will not discard another request's updates.");
    }
    return { status: "pending", latestUpdateId, ...extra };
  });
}

async function withManager<T>(
  dependencies: TelegramProvisionDependencies,
  operation: (fetchImpl: TelegramFetch, token: string, secrets: SecretRegistry) => Promise<T>,
): Promise<T> {
  const secrets = new SecretRegistry();
  try {
    const token = await readManagerToken(dependencies.env ?? process.env);
    secrets.add(token);
    return await operation(dependencies.fetchImpl ?? ((url, init) => fetch(url, init)), token, secrets);
  } catch (error) {
    throw new Error(secrets.redact(describe(error)));
  }
}

async function requirePollingManager(fetchImpl: TelegramFetch, token: string, secrets: SecretRegistry): Promise<void> {
  const webhook = await callTelegram<{ url: string }>(fetchImpl, token, "getWebhookInfo", {}, secrets);
  if (webhook?.url !== "") {
    throw new Error("The Telegram manager has a webhook or an invalid webhook status. Configure a dedicated polling manager; the factory does not delete webhooks.");
  }
}

export function parseTelegramProvisionArguments(argv: string[]): TelegramProvisionArguments {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if ((BOOLEAN_ARGUMENTS as readonly string[]).includes(argument)) {
      if (flags.has(argument)) throw new Error(`${USAGE}\n\nDuplicate argument: ${argument}`);
      flags.add(argument);
      continue;
    }
    if (!(NAMED_ARGUMENTS as readonly string[]).includes(argument)) {
      throw new Error(`${USAGE}\n\nUnknown argument: ${argument}`);
    }
    if (values.has(argument)) throw new Error(`${USAGE}\n\nDuplicate argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${USAGE}\n\nMissing value for ${argument}.`);
    }
    values.set(argument, value);
    index += 1;
  }

  const mode: TelegramProvisionMode = flags.has("--rotate") ? "rotate" : "provision";
  const username = normalizeChildUsername(required(values, "--username"));
  const tokenFilePath = requireAbsolute(required(values, "--token-file"), "--token-file");
  const userId = values.has("--user-id") ? requirePositiveInteger(values.get("--user-id")!, "--user-id") : undefined;

  if (mode === "rotate") {
    for (const rejected of ["--name", "--avatar", "--timeout-seconds"] as const) {
      if (values.has(rejected)) throw new Error(`${USAGE}\n\n${rejected} does not apply to --rotate.`);
    }
    for (const rejected of ["--replace", "--accept-username-change"] as const) {
      if (flags.has(rejected)) throw new Error(`${USAGE}\n\n${rejected} does not apply to --rotate.`);
    }
    return {
      mode,
      username,
      tokenFilePath,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      replace: false,
      acceptUsernameChange: false,
      ...(userId === undefined ? {} : { userId }),
    };
  }

  // A display name only reaches Telegram through the deep link, so it is
  // required exactly when a link is going to be produced.
  const displayName = values.get("--name");
  if (userId === undefined && (displayName === undefined || displayName.trim() === "")) {
    throw new Error(`${USAGE}\n\nMissing required argument: --name`);
  }
  const timeoutSeconds = values.has("--timeout-seconds")
    ? requirePositiveInteger(values.get("--timeout-seconds")!, "--timeout-seconds")
    : DEFAULT_TIMEOUT_SECONDS;

  return {
    mode,
    username,
    tokenFilePath,
    timeoutSeconds,
    replace: flags.has("--replace"),
    acceptUsernameChange: flags.has("--accept-username-change"),
    ...(displayName === undefined ? {} : { displayName }),
    ...(values.has("--avatar") ? { avatarPath: values.get("--avatar")! } : {}),
    ...(userId === undefined ? {} : { userId }),
  };
}

export async function runTelegramProvisionCli(
  argv: string[],
  dependencies: TelegramProvisionDependencies = {},
): Promise<TelegramProvisionOutcome> {
  const args = parseTelegramProvisionArguments(argv);
  const secrets = new SecretRegistry();
  try {
    return await execute(args, dependencies, secrets);
  } catch (error) {
    // Last line of defence: a message assembled anywhere below still leaves
    // this function scrubbed, including messages raised by node:fs and fetch.
    throw new Error(secrets.redact(error instanceof Error ? error.message : String(error)));
  }
}

async function execute(
  args: TelegramProvisionArguments,
  dependencies: TelegramProvisionDependencies,
  secrets: SecretRegistry,
): Promise<TelegramProvisionOutcome> {
  const fetchImpl = dependencies.fetchImpl ?? ((url, init) => fetch(url, init));
  const env = dependencies.env ?? process.env;
  const log = (line: string): void => (dependencies.log ?? ((value: string) => console.log(value)))(secrets.redact(line));
  const now = dependencies.now ?? (() => Date.now());
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  const managerToken = await readManagerToken(env);
  secrets.add(managerToken);

  if (args.mode === "rotate") {
    return await rotate(args, { fetchImpl, log }, secrets, managerToken);
  }

  // Refuse an occupied token file before the owner is asked for anything. The
  // atomic link() below is the real guard; this one saves a wasted tap.
  if (!args.replace && (await pathExists(args.tokenFilePath))) {
    throw new Error(refuseOverwriteMessage(args.tokenFilePath));
  }
  // Read and validate the avatar up front for the same reason.
  const avatar = args.avatarPath === undefined ? undefined : await readAvatar(args.avatarPath);

  let bot: TelegramUser;
  let resolvedFrom: TelegramResolution;
  if (args.userId !== undefined) {
    bot = { id: args.userId };
    resolvedFrom = "user-id";
    log(`Resolving managed bot ${args.userId} directly; no link is shown and no tap is required.`);
  } else {
    const manager = await callTelegram<TelegramUser>(fetchImpl, managerToken, "getMe", {}, secrets);
    const managerUsername = manager.username;
    if (managerUsername === undefined || managerUsername === "") {
      throw new Error("The manager bot's getMe response carries no username; check the manager token.");
    }
    const deepLink = buildManagedBotDeepLink(managerUsername, args.username, args.displayName);
    log(`Manager bot: @${managerUsername}`);
    log("Open this link and confirm; one tap creates the bot:");
    log(`  ${deepLink}`);
    log("That tap is the owner's deliberate gate. No agent operates the owner's Telegram account.");
    log("The username and display name are suggestions and stay editable in the confirmation dialog.");
    const waited = await waitForManagedBot(
      { fetchImpl, log, now, sleep },
      secrets,
      managerToken,
      args,
    );
    bot = waited.bot;
    resolvedFrom = waited.resolvedFrom;
  }

  const childToken = await callTelegram<string>(
    fetchImpl,
    managerToken,
    "getManagedBotToken",
    { user_id: bot.id },
    secrets,
  );
  secrets.add(childToken);

  const child = await callTelegram<TelegramUser>(fetchImpl, childToken, "getMe", {}, secrets);
  const actualUsername = requireChildIdentity(child, bot.id, args.username, args.acceptUsernameChange);

  await writeSecretFileAtomically(args.tokenFilePath, `${childToken}\n`, args.replace);

  let avatarSet = false;
  if (avatar !== undefined) {
    await setChildProfilePhoto(fetchImpl, childToken, avatar, secrets);
    avatarSet = true;
  }

  return {
    mode: "provision",
    requestedUsername: args.username,
    actualUsername,
    botId: child.id,
    tokenFilePath: args.tokenFilePath,
    tokenFingerprint: tokenFingerprint(`${childToken}\n`),
    avatarSet,
    resolvedFrom,
  };
}

async function rotate(
  args: TelegramProvisionArguments,
  io: { fetchImpl: TelegramFetch; log: (line: string) => void },
  secrets: SecretRegistry,
  managerToken: string,
): Promise<TelegramProvisionOutcome> {
  let botId = args.userId;
  let actualUsername = args.username;
  if (botId === undefined) {
    // getManagedBotToken and replaceManagedBotToken both key on user_id and
    // Telegram offers no username lookup, so the id comes from the token the
    // deployment already holds. --user-id covers a lost or dead token file.
    const currentToken = await readTokenFile(args.tokenFilePath);
    secrets.add(currentToken);
    const child = await callTelegram<TelegramUser>(io.fetchImpl, currentToken, "getMe", {}, secrets);
    actualUsername = requireChildIdentity(child, child.id, args.username, false);
    botId = child.id;
  } else {
    // A numeric resume handle is not permission to revoke a different bot.
    // Resolve its current token through the manager even when the local token
    // is missing or revoked, then verify identity before the destructive call.
    const currentToken = await callTelegram<string>(io.fetchImpl, managerToken, "getManagedBotToken", { user_id: botId }, secrets);
    secrets.add(currentToken);
    const child = await callTelegram<TelegramUser>(io.fetchImpl, currentToken, "getMe", {}, secrets);
    actualUsername = requireChildIdentity(child, botId, args.username, false);
  }

  const newToken = await callTelegram<string>(
    io.fetchImpl,
    managerToken,
    "replaceManagedBotToken",
    { user_id: botId },
    secrets,
  );
  secrets.add(newToken);
  io.log(`Revoked the previous token for @${actualUsername}; the old value is dead as of this call.`);

  try {
    await writeSecretFileAtomically(args.tokenFilePath, `${newToken}\n`, true);
  } catch (error) {
    throw new Error(
      `The new token could not be written to ${args.tokenFilePath} (${error instanceof Error ? error.message : String(error)}). `
        + `The previous token is already revoked; recover the current token with --user-id ${botId} --replace (without --rotate).`,
    );
  }

  return {
    mode: "rotate",
    requestedUsername: args.username,
    actualUsername,
    botId,
    tokenFilePath: args.tokenFilePath,
    tokenFingerprint: tokenFingerprint(`${newToken}\n`),
    avatarSet: false,
    resolvedFrom: args.userId === undefined ? "existing-token" : "user-id",
  };
}

async function waitForManagedBot(
  io: {
    fetchImpl: TelegramFetch;
    log: (line: string) => void;
    now: () => number;
    sleep: (milliseconds: number) => Promise<void>;
  },
  secrets: SecretRegistry,
  managerToken: string,
  args: TelegramProvisionArguments,
): Promise<{ bot: TelegramUser; resolvedFrom: TelegramResolution }> {
  const observed = new Map<number, ObservedManagedBot>();

  // Resume pass. Calling getUpdates without an offset returns the earliest
  // unconfirmed updates and confirms nothing, so a tap that landed after an
  // earlier run timed out is still sitting here and costs the owner nothing.
  const pending = await getManagedBotUpdates(io.fetchImpl, managerToken, secrets, undefined, 0);
  const resumed = selectManagedBot(pending, args, observed);
  if (resumed !== undefined) {
    io.log("Found the confirmation already waiting in the manager bot's pending updates; no new tap needed.");
    return { bot: resumed, resolvedFrom: "pending-update" };
  }

  let offset = nextOffset(pending);
  const deadline = io.now() + args.timeoutSeconds * 1_000;
  io.log(`Waiting up to ${args.timeoutSeconds}s for Telegram to report the new bot...`);

  // A defensive bound so a stalled clock can never spin this loop forever;
  // real long polls burn 50s each, so this is never the binding limit.
  let remainingPolls = args.timeoutSeconds + 2;
  while (io.now() < deadline && remainingPolls > 0) {
    remainingPolls -= 1;
    const remainingSeconds = Math.ceil((deadline - io.now()) / 1_000);
    const pollSeconds = Math.max(1, Math.min(MAX_LONG_POLL_SECONDS, remainingSeconds));
    const updates = await getManagedBotUpdates(io.fetchImpl, managerToken, secrets, offset, pollSeconds);
    const match = selectManagedBot(updates, args, observed);
    if (match !== undefined) return { bot: match, resolvedFrom: "deep-link-tap" };
    const advanced = nextOffset(updates);
    if (advanced !== undefined) offset = advanced;
    else await io.sleep(IDLE_POLL_INTERVAL_MS);
  }

  throw new Error(timeoutMessage(args, [...observed.values()]));
}

async function getManagedBotUpdates(
  fetchImpl: TelegramFetch,
  managerToken: string,
  secrets: SecretRegistry,
  offset: number | undefined,
  timeoutSeconds: number,
): Promise<TelegramUpdate[]> {
  const updates = await callTelegram<TelegramUpdate[]>(
    fetchImpl,
    managerToken,
    "getUpdates",
    {
      ...(offset === undefined ? {} : { offset }),
      limit: 100,
      timeout: timeoutSeconds,
      allowed_updates: [MANAGED_BOT_UPDATE_TYPE],
    },
    secrets,
  );
  if (!Array.isArray(updates)) throw new Error("Telegram getUpdates did not return a list of updates.");
  return updates;
}

function selectManagedBot(
  updates: TelegramUpdate[],
  args: TelegramProvisionArguments,
  observed: Map<number, ObservedManagedBot>,
): TelegramUser | undefined {
  const managedBots: TelegramUser[] = [];
  for (const update of updates) {
    const bot = update.managed_bot?.bot;
    if (bot === undefined || typeof bot.id !== "number") continue;
    observed.set(bot.id, { id: bot.id, username: bot.username ?? "(no username)" });
    managedBots.push(bot);
  }
  const exact = managedBots.find((bot) => bot.username !== undefined && sameUsername(bot.username, args.username));
  if (exact !== undefined) return exact;
  // ManagedBotUpdated also fires for token and owner changes on other managed
  // bots, so an unrelated update is never mistaken for this ceremony unless the
  // operator has said the owner may have edited the suggested username.
  return args.acceptUsernameChange ? managedBots[0] : undefined;
}

function nextOffset(updates: TelegramUpdate[]): number | undefined {
  let highest: number | undefined;
  for (const update of updates) {
    if (typeof update.update_id !== "number") continue;
    if (highest === undefined || update.update_id > highest) highest = update.update_id;
  }
  return highest === undefined ? undefined : highest + 1;
}

function timeoutMessage(args: TelegramProvisionArguments, observed: ObservedManagedBot[]): string {
  const lines = [`No managed_bot update for @${args.username} arrived within ${args.timeoutSeconds}s.`];
  if (observed.length > 0) {
    lines.push("Managed bots reported during the wait:");
    for (const bot of observed) lines.push(`  @${bot.username} (user id ${bot.id})`);
    lines.push(
      `If the owner edited the username, re-run with --user-id <id> from that list, or --username <actual>.`,
    );
  }
  lines.push(
    "If the owner has not confirmed yet, re-run this command unchanged: a tap that lands after the",
    "timeout stays queued as an unconfirmed update and the next run resolves it without a second tap.",
  );
  return lines.join("\n");
}

async function setChildProfilePhoto(
  fetchImpl: TelegramFetch,
  childToken: string,
  avatar: { bytes: Uint8Array<ArrayBuffer>; fileName: string },
  secrets: SecretRegistry,
): Promise<void> {
  // InputProfilePhotoStatic: "Profile photos can't be reused and can only be
  // uploaded as a new file, so you can pass attach://<file_attach_name>".
  const form = new FormData();
  form.set("photo", JSON.stringify({ type: "static", photo: `attach://${ATTACH_NAME}` }));
  form.set(ATTACH_NAME, new Blob([avatar.bytes], { type: "image/jpeg" }), avatar.fileName);
  await callTelegram<boolean>(fetchImpl, childToken, "setMyProfilePhoto", form, secrets);
}

async function callTelegram<T>(
  fetchImpl: TelegramFetch,
  token: string,
  method: string,
  parameters: Record<string, unknown> | FormData,
  secrets: SecretRegistry,
): Promise<T> {
  const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
  const pollSeconds = method === "getUpdates" && !(parameters instanceof FormData) && typeof parameters.timeout === "number"
    ? parameters.timeout : 0;
  const signal = AbortSignal.timeout((pollSeconds + 15) * 1_000);
  let response: Response;
  try {
    response = parameters instanceof FormData
      ? await fetchImpl(url, { method: "POST", body: parameters, signal })
      : await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(parameters),
          signal,
        });
  } catch (error) {
    throw new Error(secrets.redact(`Telegram ${method} could not be reached: ${describe(error)}`));
  }

  const text = await response.text().catch(() => "");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      secrets.redact(`Telegram ${method} returned a non-JSON response (HTTP ${response.status}): ${text.slice(0, 300)}`),
    );
  }

  const record = asRecord(body);
  if (record?.ok !== true) {
    const code = typeof record?.error_code === "number" ? ` error_code ${record.error_code}` : "";
    const description = typeof record?.description === "string" ? `: ${record.description}` : "";
    throw new Error(secrets.redact(`Telegram ${method} failed (HTTP ${response.status})${code}${description}`));
  }
  return record.result as T;
}

async function readManagerToken(env: Record<string, string | undefined>): Promise<string> {
  const inline = env.EXPERT_AGENTS_TELEGRAM_MANAGER_TOKEN?.trim();
  const path = env.EXPERT_AGENTS_TELEGRAM_MANAGER_TOKEN_FILE?.trim();
  if (inline && path) {
    throw new Error(
      "Set exactly one of EXPERT_AGENTS_TELEGRAM_MANAGER_TOKEN and EXPERT_AGENTS_TELEGRAM_MANAGER_TOKEN_FILE.",
    );
  }
  if (inline) return inline;
  if (path) return await readTokenFile(path);
  throw new Error(
    "No manager credential. Set EXPERT_AGENTS_TELEGRAM_MANAGER_TOKEN or "
      + "EXPERT_AGENTS_TELEGRAM_MANAGER_TOKEN_FILE. The token is never accepted as a command-line "
      + "argument, because argv is readable from the process list.",
  );
}

async function readTokenFile(path: string): Promise<string> {
  const contents = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    throw new Error(`Could not read the token file at ${path}: ${error.code ?? "unreadable"}`);
  });
  const token = contents.trim();
  if (token === "") throw new Error(`The token file at ${path} is empty.`);
  return token;
}

async function readAvatar(path: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; fileName: string }> {
  const bytes = await readFile(path).catch((error: NodeJS.ErrnoException) => {
    throw new Error(`Could not read the avatar at ${path}: ${error.code ?? "unreadable"}`);
  });
  if (bytes.byteLength === 0) throw new Error(`The avatar at ${path} is empty.`);
  if (bytes.byteLength > AVATAR_MAX_BYTES) {
    throw new Error(`The avatar at ${path} is ${bytes.byteLength} bytes; the limit is ${AVATAR_MAX_BYTES}.`);
  }
  // InputProfilePhotoStatic is documented as "A static profile photo in the
  // .JPG format", so anything else is rejected here rather than by Telegram.
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) {
    throw new Error(
      `The avatar at ${path} is not a JPEG. Telegram's static profile photo must be .JPG; convert it first.`,
    );
  }
  // Copied into a plain ArrayBuffer-backed view so it is a valid BlobPart.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return { bytes: copy, fileName: basename(path) };
}

/**
 * Writes a credential so a reader sees either the old file or the whole new
 * one, never a half-written token, and never a mode wider than 0600.
 */
async function writeSecretFileAtomically(path: string, contents: string, replace: boolean): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.partial`);
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  try {
    // link(2) fails with EEXIST instead of clobbering, so refusing to overwrite
    // is atomic rather than a check the filesystem can invalidate underneath.
    if (replace) await rename(temporary, path);
    else await link(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(refuseOverwriteMessage(path));
    throw error;
  }
  if (!replace) await unlink(temporary).catch(() => undefined);
}

function refuseOverwriteMessage(path: string): string {
  return `Refusing to overwrite the existing token file at ${path}. Pass --replace to replace it.`;
}

export function describeTelegramProvisionOutcome(outcome: TelegramProvisionOutcome): string[] {
  const lines = outcome.mode === "rotate"
    ? [`Rotated the token for @${outcome.actualUsername} (user id ${outcome.botId}).`]
    : [`Provisioned managed bot @${outcome.actualUsername} (user id ${outcome.botId}).`];
  if (!sameUsername(outcome.actualUsername, outcome.requestedUsername)) {
    lines.push(`  requested username: @${outcome.requestedUsername} (Telegram reported a different one)`);
  }
  lines.push(
    `  token file: ${outcome.tokenFilePath} (mode 0600)`,
    `  token fingerprint (sha256 of the exact file bytes, first ${TOKEN_FINGERPRINT_CHARACTERS}): ${outcome.tokenFingerprint}`,
  );
  if (outcome.mode === "provision") {
    lines.push(
      `  avatar set: ${outcome.avatarSet ? "yes" : "no"}`,
      `  resolved from: ${outcome.resolvedFrom}`,
      `  record @${outcome.actualUsername} in the agent repository's binding.json; the token value stays in the secret store.`,
    );
  }
  return lines;
}

function sameUsername(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function requireChildIdentity(child: TelegramUser, expectedId: number, username: string, acceptUsernameChange: boolean): string {
  if (!Number.isSafeInteger(child?.id) || child.id <= 0 || child.id !== expectedId || child.is_bot !== true) {
    throw new Error("Telegram returned a bot identity that does not match the requested managed bot; no token was written or revoked.");
  }
  if (typeof child.username !== "string" || child.username.length === 0) {
    throw new Error("Telegram returned a managed bot without a username; no token was written or revoked.");
  }
  if (!acceptUsernameChange && !sameUsername(child.username, username)) {
    throw new Error(`The managed token belongs to @${child.username}, not @${username}. Refusing to use a bot that was not named.`);
  }
  return child.username;
}

function normalizeChildUsername(value: string): string {
  const username = value.startsWith("@") ? value.slice(1) : value;
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error(
      `${USAGE}\n\nInvalid --username "${value}": 5-32 characters, letters, digits and underscores, starting with a letter.`,
    );
  }
  if (!/bot$/i.test(username)) {
    throw new Error(`${USAGE}\n\nInvalid --username "${value}": a Telegram bot username must end with "bot".`);
  }
  return username;
}

function requireAbsolute(value: string, flag: string): string {
  if (!isAbsolute(value)) throw new Error(`${USAGE}\n\n${flag} must be an absolute path.`);
  return value;
}

function requirePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${USAGE}\n\n${flag} must be a positive integer.`);
  }
  return parsed;
}

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined) throw new Error(`${USAGE}\n\nMissing required argument: ${flag}`);
  return value;
}

async function pathExists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  if (process.argv.includes("--help") || process.argv.slice(2).length === 0) {
    console.log(USAGE);
  } else {
    try {
      for (const line of describeTelegramProvisionOutcome(await runTelegramProvisionCli(process.argv.slice(2)))) {
        console.log(line);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Telegram provisioning failed.");
      process.exitCode = 1;
    }
  }
}
