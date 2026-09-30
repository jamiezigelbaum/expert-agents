import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginManagedBotProvision,
  buildManagedBotDeepLink,
  describeTelegramProvisionOutcome,
  parseTelegramProvisionArguments,
  probeManagedBotProvision,
  redactTelegramSecrets,
  runTelegramProvisionCli,
  tokenFingerprint,
  type TelegramFetch,
} from "../scripts/expert-telegram-provision.ts";

/**
 * Token-shaped fixtures assembled at run time. A bot token is
 * `<numeric id>:AA<secret>`, and the repository's boundary scan gates that
 * shape, so no tracked file may carry the literal.
 */
function fixtureToken(botId: string, seed: string): string {
  return [botId, ["A", "A", seed, "x".repeat(36 - seed.length)].join("")].join(":");
}

const MANAGER_TOKEN = fixtureToken("8100000001", "managerfixture");
const CHILD_TOKEN = fixtureToken("8100000002", "childfixture");
const ROTATED_TOKEN = fixtureToken("8100000002", "rotatedfixture");
const MANAGER_ENV = { EXPERT_AGENTS_TELEGRAM_MANAGER_TOKEN: MANAGER_TOKEN };
const MANAGER_ID = 8100000001;
const CHILD_ID = 4242;

/** A 1x1 PNG carried as text, so no binary fixture file enters this repository. */
const TINY_PNG_BASE64
  = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
/** Smallest thing the avatar reader accepts: the JPEG SOI/marker prefix. */
const TINY_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface CapturedCall {
  url: string;
  token: string;
  method: string;
  json?: Record<string, unknown>;
  form?: FormData;
}

type TelegramHandler = (call: CapturedCall) => unknown;

function telegramFake(handlers: Record<string, TelegramHandler>): {
  calls: CapturedCall[];
  fetchImpl: TelegramFetch;
} {
  const calls: CapturedCall[] = [];
  const fetchImpl: TelegramFetch = async (url, init = {}) => {
    const parsed = /\/bot([^/]+)\/([A-Za-z]+)$/.exec(url);
    if (parsed === null) throw new Error(`fake telegram received an unexpected URL shape`);
    const body = init.body;
    const call: CapturedCall = {
      url,
      token: parsed[1]!,
      method: parsed[2]!,
      ...(typeof body === "string" ? { json: JSON.parse(body) as Record<string, unknown> } : {}),
      ...(body instanceof FormData ? { form: body } : {}),
    };
    calls.push(call);
    const handler = handlers[call.method];
    if (handler === undefined) {
      return jsonResponse({ ok: false, error_code: 404, description: `no fixture for ${call.method}` }, 404);
    }
    const value = await handler(call);
    const envelope = isEnvelope(value) ? value : { ok: true, result: value };
    return jsonResponse(envelope, envelope.ok === false ? 400 : 200);
  };
  return { calls, fetchImpl };
}

function isEnvelope(value: unknown): value is { ok: boolean; [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && typeof (value as { ok?: unknown }).ok === "boolean";
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A clock that jumps forward on every read, so waits end without real time. */
function steppingClock(stepMilliseconds: number): () => number {
  let current = 0;
  return () => (current += stepMilliseconds);
}

function managedBotUpdate(updateId: number, botId: number, username: string): Record<string, unknown> {
  return { update_id: updateId, managed_bot: { user: { id: 77, first_name: "Owner" }, bot: { id: botId, username } } };
}

function getMeByToken(childUsername = "NeutralExpertBot"): TelegramHandler {
  return (call) => call.token === MANAGER_TOKEN
    ? { id: MANAGER_ID, is_bot: true, first_name: "Manager", username: "NeutralManagerBot" }
    : { id: CHILD_ID, is_bot: true, first_name: "Neutral Expert", username: childUsername };
}

/** Every secret this suite hands the CLI, plus each token's secret half. */
const SECRET_FRAGMENTS = [MANAGER_TOKEN, CHILD_TOKEN, ROTATED_TOKEN]
  .flatMap((token) => [token, token.split(":")[1]!]);

function expectNoSecretsIn(label: string, values: readonly string[]): void {
  for (const value of values) {
    for (const secret of SECRET_FRAGMENTS) {
      if (value.includes(secret)) throw new Error(`${label} leaked a token fragment: ${value}`);
    }
  }
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "telegram-provision-"));
  temporaryRoots.push(root);
  return root;
}

async function fileMode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe("telegram provision arguments", () => {
  test("parses a provision invocation", () => {
    expect(parseTelegramProvisionArguments([
      "--username", "@NeutralExpertBot",
      "--name", "Neutral Expert",
      "--token-file", "/run/secrets/neutral-expert.token",
      "--timeout-seconds", "120",
      "--replace",
    ])).toEqual({
      mode: "provision",
      username: "NeutralExpertBot",
      displayName: "Neutral Expert",
      tokenFilePath: "/run/secrets/neutral-expert.token",
      timeoutSeconds: 120,
      replace: true,
      acceptUsernameChange: false,
    });
  });

  test("parses a rotate invocation", () => {
    expect(parseTelegramProvisionArguments([
      "--rotate",
      "--username", "NeutralExpertBot",
      "--token-file", "/run/secrets/neutral-expert.token",
    ])).toEqual({
      mode: "rotate",
      username: "NeutralExpertBot",
      tokenFilePath: "/run/secrets/neutral-expert.token",
      timeoutSeconds: 900,
      replace: false,
      acceptUsernameChange: false,
    });
  });

  test("refuses unknown, duplicated, and misapplied arguments", () => {
    const base = ["--username", "NeutralExpertBot", "--token-file", "/run/secrets/a.token"];
    expect(() => parseTelegramProvisionArguments([...base, "--token"])).toThrow(/Unknown argument: --token/);
    expect(() => parseTelegramProvisionArguments([...base, "--name", "A", "--name", "B"]))
      .toThrow(/Duplicate argument: --name/);
    expect(() => parseTelegramProvisionArguments([...base, "--name"])).toThrow(/Missing value for --name/);
    expect(() => parseTelegramProvisionArguments([...base])).toThrow(/Missing required argument: --name/);
    expect(() => parseTelegramProvisionArguments(["--rotate", ...base, "--name", "A"]))
      .toThrow(/--name does not apply to --rotate/);
  });

  test("refuses a relative token file and an invalid bot username", () => {
    expect(() => parseTelegramProvisionArguments([
      "--username", "NeutralExpertBot", "--name", "A", "--token-file", "secrets/a.token",
    ])).toThrow(/--token-file must be an absolute path/);
    expect(() => parseTelegramProvisionArguments([
      "--username", "NeutralExpert", "--name", "A", "--token-file", "/run/secrets/a.token",
    ])).toThrow(/must end with "bot"/);
    expect(() => parseTelegramProvisionArguments([
      "--username", "n/a", "--name", "A", "--token-file", "/run/secrets/a.token",
    ])).toThrow(/Invalid --username/);
  });

  test("builds the documented deep link, encoding a space as a plus", () => {
    expect(buildManagedBotDeepLink("ManagerBot", "CoolAIAgentBot", "Cool AI Agent"))
      .toBe("https://t.me/newbot/ManagerBot/CoolAIAgentBot?name=Cool+AI+Agent");
    expect(buildManagedBotDeepLink("ManagerBot", "CoolAIAgentBot"))
      .toBe("https://t.me/newbot/ManagerBot/CoolAIAgentBot");
  });
});

describe("telegram manager credential", () => {
  test("refuses to run without a manager credential, and names why argv is not an option", async () => {
    const root = await temporaryRoot();
    const { fetchImpl, calls } = telegramFake({});
    await expect(runTelegramProvisionCli(
      ["--username", "NeutralExpertBot", "--name", "A", "--token-file", join(root, "a.token")],
      { fetchImpl, env: {} },
    )).rejects.toThrow(/argv is readable from the process list/);
    expect(calls).toHaveLength(0);
  });

  test("reads the manager credential from a token file and refuses both sources at once", async () => {
    const root = await temporaryRoot();
    const managerFile = join(root, "manager.token");
    await writeFile(managerFile, `${MANAGER_TOKEN}\n`, { mode: 0o600 });
    const { fetchImpl, calls } = telegramFake({
      getMe: getMeByToken(),
      getUpdates: () => [managedBotUpdate(11, CHILD_ID, "NeutralExpertBot")],
      getManagedBotToken: () => CHILD_TOKEN,
    });

    const outcome = await runTelegramProvisionCli(
      ["--username", "NeutralExpertBot", "--name", "Neutral Expert", "--token-file", join(root, "child.token")],
      { fetchImpl, env: { EXPERT_AGENTS_TELEGRAM_MANAGER_TOKEN_FILE: managerFile }, log: () => undefined },
    );

    expect(outcome.tokenFingerprint).toBe(tokenFingerprint(`${CHILD_TOKEN}\n`));
    expect(calls[0]!.token).toBe(MANAGER_TOKEN);

    await expect(runTelegramProvisionCli(
      ["--username", "NeutralExpertBot", "--name", "A", "--token-file", join(root, "other.token")],
      { fetchImpl, env: { ...MANAGER_ENV, EXPERT_AGENTS_TELEGRAM_MANAGER_TOKEN_FILE: managerFile } },
    )).rejects.toThrow(/exactly one of/i);
  });
});

describe("telegram provision happy path", () => {
  test("prints the deep link, consumes the update, and writes the token at 0600", async () => {
    const root = await temporaryRoot();
    const tokenFile = join(root, "secrets", "neutral-expert.token");
    const logs: string[] = [];
    let polls = 0;
    const { calls, fetchImpl } = telegramFake({
      getMe: getMeByToken(),
      getUpdates: () => {
        polls += 1;
        return polls <= 2 ? [] : [managedBotUpdate(42, CHILD_ID, "neutralexpertbot")];
      },
      getManagedBotToken: () => CHILD_TOKEN,
    });

    const outcome = await runTelegramProvisionCli([
      "--username", "NeutralExpertBot",
      "--name", "Neutral Expert",
      "--token-file", tokenFile,
    ], {
      fetchImpl,
      env: MANAGER_ENV,
      log: (line) => logs.push(line),
      now: steppingClock(1_000),
      sleep: async () => undefined,
    });

    expect(logs).toContain("  https://t.me/newbot/NeutralManagerBot/NeutralExpertBot?name=Neutral+Expert");
    expect(logs.join("\n")).toContain("one tap creates the bot");
    expect(logs.join("\n")).toContain("owner's deliberate gate");

    // The username is matched case-insensitively and reported as Telegram has it.
    expect(outcome.actualUsername).toBe("NeutralExpertBot");
    expect(outcome.requestedUsername).toBe("NeutralExpertBot");
    expect(outcome.botId).toBe(CHILD_ID);
    expect(outcome.resolvedFrom).toBe("deep-link-tap");
    expect(outcome.avatarSet).toBeFalse();
    expect(outcome.tokenFingerprint).toBe(tokenFingerprint(`${CHILD_TOKEN}\n`));
    expect(outcome.tokenFingerprint).toHaveLength(12);

    expect(await readFile(tokenFile, "utf8")).toBe(`${CHILD_TOKEN}\n`);
    expect(await fileMode(tokenFile)).toBe(0o600);

    // The offset only advances past updates that were actually inspected.
    const updateCalls = calls.filter((call) => call.method === "getUpdates");
    expect(updateCalls[0]!.json).not.toHaveProperty("offset");
    expect(updateCalls[0]!.json).toMatchObject({ allowed_updates: ["managed_bot"], timeout: 0 });
    expect(updateCalls[1]!.json).toMatchObject({ allowed_updates: ["managed_bot"] });
    expect(calls.find((call) => call.method === "getManagedBotToken")!.json)
      .toEqual({ user_id: CHILD_ID });

    const reported = [...logs, ...describeTelegramProvisionOutcome(outcome), JSON.stringify(outcome)];
    expectNoSecretsIn("provision output", reported);
    expect(describeTelegramProvisionOutcome(outcome).join("\n")).toContain(tokenFingerprint(`${CHILD_TOKEN}\n`));
    expect(describeTelegramProvisionOutcome(outcome).join("\n")).toContain("mode 0600");
  });

  test("resolves a tap that landed after an earlier run timed out, without a second tap", async () => {
    const root = await temporaryRoot();
    const logs: string[] = [];
    const { calls, fetchImpl } = telegramFake({
      getMe: getMeByToken(),
      getUpdates: () => [managedBotUpdate(9, CHILD_ID, "NeutralExpertBot")],
      getManagedBotToken: () => CHILD_TOKEN,
    });

    const outcome = await runTelegramProvisionCli([
      "--username", "NeutralExpertBot",
      "--name", "Neutral Expert",
      "--token-file", join(root, "child.token"),
    ], { fetchImpl, env: MANAGER_ENV, log: (line) => logs.push(line), now: steppingClock(1_000) });

    expect(outcome.resolvedFrom).toBe("pending-update");
    expect(logs.join("\n")).toContain("no new tap needed");
    // The pending pass confirms nothing, so exactly one getUpdates, with no offset.
    const updateCalls = calls.filter((call) => call.method === "getUpdates");
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.json).not.toHaveProperty("offset");
  });

  test("resolves a known managed bot id directly, showing no link and polling nothing", async () => {
    const root = await temporaryRoot();
    const logs: string[] = [];
    const { calls, fetchImpl } = telegramFake({
      getMe: getMeByToken(),
      getManagedBotToken: () => CHILD_TOKEN,
    });

    const outcome = await runTelegramProvisionCli([
      "--username", "NeutralExpertBot",
      "--token-file", join(root, "child.token"),
      "--user-id", String(CHILD_ID),
    ], { fetchImpl, env: MANAGER_ENV, log: (line) => logs.push(line) });

    expect(outcome.resolvedFrom).toBe("user-id");
    expect(calls.some((call) => call.method === "getUpdates")).toBeFalse();
    expect(logs.join("\n")).not.toContain("t.me/newbot");
  });

  test("reports the username Telegram actually created when the owner edited it", async () => {
    const root = await temporaryRoot();
    const { fetchImpl } = telegramFake({
      getMe: getMeByToken("NeutralExpertTwoBot"),
      getUpdates: () => [managedBotUpdate(3, CHILD_ID, "NeutralExpertTwoBot")],
      getManagedBotToken: () => CHILD_TOKEN,
    });

    const outcome = await runTelegramProvisionCli([
      "--username", "NeutralExpertBot",
      "--name", "Neutral Expert",
      "--token-file", join(root, "child.token"),
      "--accept-username-change",
    ], { fetchImpl, env: MANAGER_ENV, log: () => undefined, now: steppingClock(1_000) });

    expect(outcome.actualUsername).toBe("NeutralExpertTwoBot");
    expect(describeTelegramProvisionOutcome(outcome).join("\n"))
      .toContain("requested username: @NeutralExpertBot (Telegram reported a different one)");
  });
});

describe("telegram provision refusals", () => {
  test("times out without writing a token, naming the managed bots it did see", async () => {
    const root = await temporaryRoot();
    const tokenFile = join(root, "child.token");
    const { fetchImpl } = telegramFake({
      getMe: getMeByToken(),
      getUpdates: () => [managedBotUpdate(5, 5555, "OtherExpertBot")],
      getManagedBotToken: () => CHILD_TOKEN,
    });

    const failure = await runTelegramProvisionCli([
      "--username", "NeutralExpertBot",
      "--name", "Neutral Expert",
      "--token-file", tokenFile,
      "--timeout-seconds", "5",
    ], {
      fetchImpl,
      env: MANAGER_ENV,
      log: () => undefined,
      now: steppingClock(3_000),
      sleep: async () => undefined,
    }).then(() => undefined, (error: Error) => error);

    expect(failure?.message).toContain("No managed_bot update for @NeutralExpertBot arrived within 5s");
    expect(failure?.message).toContain("@OtherExpertBot (user id 5555)");
    expect(failure?.message).toContain("re-run this command unchanged");
    expect(await stat(tokenFile).then(() => true, () => false)).toBeFalse();
    expectNoSecretsIn("timeout error", [failure?.message ?? ""]);
  });

  test("refuses to overwrite an existing token file before contacting Telegram", async () => {
    const root = await temporaryRoot();
    const tokenFile = join(root, "secrets", "child.token");
    await mkdir(join(root, "secrets"), { recursive: true });
    await writeFile(tokenFile, "already-provisioned\n", { mode: 0o600 });
    const { calls, fetchImpl } = telegramFake({
      getMe: getMeByToken(),
      getUpdates: () => [managedBotUpdate(1, CHILD_ID, "NeutralExpertBot")],
      getManagedBotToken: () => CHILD_TOKEN,
    });
    const invocation = ["--username", "NeutralExpertBot", "--name", "Neutral Expert", "--token-file", tokenFile];

    await expect(runTelegramProvisionCli(invocation, { fetchImpl, env: MANAGER_ENV, log: () => undefined }))
      .rejects.toThrow(/Refusing to overwrite the existing token file/);
    // The refusal comes before the owner is asked for a tap.
    expect(calls).toHaveLength(0);
    expect(await readFile(tokenFile, "utf8")).toBe("already-provisioned\n");

    const outcome = await runTelegramProvisionCli([...invocation, "--replace"], {
      fetchImpl,
      env: MANAGER_ENV,
      log: () => undefined,
      now: steppingClock(1_000),
    });
    expect(outcome.tokenFingerprint).toBe(tokenFingerprint(`${CHILD_TOKEN}\n`));
    expect(await readFile(tokenFile, "utf8")).toBe(`${CHILD_TOKEN}\n`);
    expect(await fileMode(tokenFile)).toBe(0o600);
  });

  test("refuses a non-JPEG avatar before contacting Telegram", async () => {
    const root = await temporaryRoot();
    const avatar = join(root, "avatar.png");
    await writeFile(avatar, Buffer.from(TINY_PNG_BASE64, "base64"));
    const { calls, fetchImpl } = telegramFake({ getMe: getMeByToken() });

    await expect(runTelegramProvisionCli([
      "--username", "NeutralExpertBot",
      "--name", "Neutral Expert",
      "--token-file", join(root, "child.token"),
      "--avatar", avatar,
    ], { fetchImpl, env: MANAGER_ENV, log: () => undefined })).rejects.toThrow(/is not a JPEG/);
    expect(calls).toHaveLength(0);
  });

  test("scrubs the token out of an error body that echoes the request URL", async () => {
    const root = await temporaryRoot();
    const { fetchImpl } = telegramFake({
      getMe: getMeByToken(),
      getUpdates: () => [managedBotUpdate(2, CHILD_ID, "NeutralExpertBot")],
      getManagedBotToken: (call) => ({
        ok: false,
        error_code: 400,
        description: `Bad Request: upstream rejected ${call.url}`,
      }),
    });

    const failure = await runTelegramProvisionCli([
      "--username", "NeutralExpertBot",
      "--name", "Neutral Expert",
      "--token-file", join(root, "child.token"),
    ], { fetchImpl, env: MANAGER_ENV, log: () => undefined, now: steppingClock(1_000) })
      .then(() => undefined, (error: Error) => error);

    expect(failure?.message).toContain("Telegram getManagedBotToken failed");
    expect(failure?.message).toContain("[redacted]");
    expectNoSecretsIn("error body", [failure?.message ?? ""]);
  });

  test("redacts known secrets and anything token-shaped it never registered", () => {
    const unregistered = fixtureToken("8100000009", "neverregistered");
    const text = `url https://api.telegram.org/bot${MANAGER_TOKEN}/getMe and bare ${unregistered}`;
    const redacted = redactTelegramSecrets(text, [MANAGER_TOKEN]);
    expectNoSecretsIn("redactor", [redacted]);
    expect(redacted).not.toContain(unregistered);
    expect(redacted).toContain("[redacted]");
  });
});

describe("telegram avatar and rotation", () => {
  test("sets the child bot's profile photo with the child token", async () => {
    const root = await temporaryRoot();
    const avatar = join(root, "avatar.jpg");
    await writeFile(avatar, TINY_JPEG);
    const { calls, fetchImpl } = telegramFake({
      getMe: getMeByToken(),
      getUpdates: () => [managedBotUpdate(4, CHILD_ID, "NeutralExpertBot")],
      getManagedBotToken: () => CHILD_TOKEN,
      setMyProfilePhoto: () => true,
    });

    const outcome = await runTelegramProvisionCli([
      "--username", "NeutralExpertBot",
      "--name", "Neutral Expert",
      "--token-file", join(root, "child.token"),
      "--avatar", avatar,
    ], { fetchImpl, env: MANAGER_ENV, log: () => undefined, now: steppingClock(1_000) });

    expect(outcome.avatarSet).toBeTrue();
    const photoCall = calls.find((call) => call.method === "setMyProfilePhoto");
    expect(photoCall).toBeDefined();
    // The child's own token, never the manager's, changes the child's profile.
    expect(photoCall!.token).toBe(CHILD_TOKEN);
    expect(photoCall!.form!.get("photo"))
      .toBe(JSON.stringify({ type: "static", photo: "attach://profile_photo" }));
    expect(photoCall!.form!.get("profile_photo")).toBeInstanceOf(Blob);
    expect(describeTelegramProvisionOutcome(outcome).join("\n")).toContain("avatar set: yes");
  });

  test("rotates the token, rewrites the file at 0600, and prints the new fingerprint", async () => {
    const root = await temporaryRoot();
    const tokenFile = join(root, "child.token");
    await writeFile(tokenFile, `${CHILD_TOKEN}\n`, { mode: 0o600 });
    const logs: string[] = [];
    const { calls, fetchImpl } = telegramFake({
      getMe: getMeByToken(),
      replaceManagedBotToken: () => ROTATED_TOKEN,
    });

    const outcome = await runTelegramProvisionCli(
      ["--rotate", "--username", "NeutralExpertBot", "--token-file", tokenFile],
      { fetchImpl, env: MANAGER_ENV, log: (line) => logs.push(line) },
    );

    expect(outcome.mode).toBe("rotate");
    expect(outcome.botId).toBe(CHILD_ID);
    expect(outcome.resolvedFrom).toBe("existing-token");
    expect(outcome.tokenFingerprint).toBe(tokenFingerprint(`${ROTATED_TOKEN}\n`));
    expect(outcome.tokenFingerprint).not.toBe(tokenFingerprint(`${CHILD_TOKEN}\n`));
    expect(await readFile(tokenFile, "utf8")).toBe(`${ROTATED_TOKEN}\n`);
    expect(await fileMode(tokenFile)).toBe(0o600);

    // The id came from the token the deployment already held; the rotation call
    // itself is made with the manager's credential.
    const rotateCall = calls.find((call) => call.method === "replaceManagedBotToken")!;
    expect(rotateCall.json).toEqual({ user_id: CHILD_ID });
    expect(rotateCall.token).toBe(MANAGER_TOKEN);
    expect(calls.find((call) => call.method === "getMe")!.token).toBe(CHILD_TOKEN);

    const reported = [...logs, ...describeTelegramProvisionOutcome(outcome), JSON.stringify(outcome)];
    expectNoSecretsIn("rotate output", reported);
    expect(logs.join("\n")).toContain("Revoked the previous token");
  });

  test("refuses to rotate when the held token belongs to another bot", async () => {
    const root = await temporaryRoot();
    const tokenFile = join(root, "child.token");
    await writeFile(tokenFile, `${CHILD_TOKEN}\n`, { mode: 0o600 });
    const { calls, fetchImpl } = telegramFake({
      getMe: getMeByToken("SomeOtherExpertBot"),
      replaceManagedBotToken: () => ROTATED_TOKEN,
    });

    await expect(runTelegramProvisionCli(
      ["--rotate", "--username", "NeutralExpertBot", "--token-file", tokenFile],
      { fetchImpl, env: MANAGER_ENV, log: () => undefined },
    )).rejects.toThrow(/belongs to @SomeOtherExpertBot, not @NeutralExpertBot/);
    expect(calls.some((call) => call.method === "replaceManagedBotToken")).toBeFalse();
    expect(await readFile(tokenFile, "utf8")).toBe(`${CHILD_TOKEN}\n`);
  });

  test("rotates by explicit user id when the held token is unusable", async () => {
    const root = await temporaryRoot();
    const tokenFile = join(root, "child.token");
    const { calls, fetchImpl } = telegramFake({
      getManagedBotToken: () => CHILD_TOKEN,
      getMe: getMeByToken(),
      replaceManagedBotToken: () => ROTATED_TOKEN,
    });

    const outcome = await runTelegramProvisionCli(
      ["--rotate", "--username", "NeutralExpertBot", "--token-file", tokenFile, "--user-id", String(CHILD_ID)],
      { fetchImpl, env: MANAGER_ENV, log: () => undefined },
    );

    expect(outcome.resolvedFrom).toBe("user-id");
    expect(calls.map((call) => call.method)).toEqual(["getManagedBotToken", "getMe", "replaceManagedBotToken"]);
    expect(await readFile(tokenFile, "utf8")).toBe(`${ROTATED_TOKEN}\n`);
    expect(await fileMode(tokenFile)).toBe(0o600);
  });
});

describe("telegram managed identity verification", () => {
  test("refuses a numeric provisioning handle for another username before writing its token", async () => {
    const root = await temporaryRoot();
    const tokenFile = join(root, "child.token");
    const { fetchImpl } = telegramFake({
      getManagedBotToken: () => CHILD_TOKEN,
      getMe: getMeByToken("DifferentExpertBot"),
    });
    await expect(runTelegramProvisionCli([
      "--username", "NeutralExpertBot", "--token-file", tokenFile, "--user-id", String(CHILD_ID),
    ], { fetchImpl, env: MANAGER_ENV, log: () => undefined })).rejects.toThrow(/belongs to @DifferentExpertBot/);
    expect(await stat(tokenFile).then(() => true, () => false)).toBeFalse();
  });

  test("refuses a token whose authenticated identity differs from the managed update", async () => {
    const root = await temporaryRoot();
    const tokenFile = join(root, "child.token");
    const { fetchImpl } = telegramFake({
      getManagedBotToken: () => CHILD_TOKEN,
      getMe: () => ({ id: CHILD_ID + 1, is_bot: true, username: "NeutralExpertBot" }),
    });
    await expect(runTelegramProvisionCli([
      "--username", "NeutralExpertBot", "--token-file", tokenFile, "--user-id", String(CHILD_ID),
    ], { fetchImpl, env: MANAGER_ENV, log: () => undefined })).rejects.toThrow(/does not match/);
    expect(await stat(tokenFile).then(() => true, () => false)).toBeFalse();
  });

  test("checks the named bot before rotating an explicit numeric handle", async () => {
    const root = await temporaryRoot();
    const tokenFile = join(root, "child.token");
    const { calls, fetchImpl } = telegramFake({
      getManagedBotToken: () => CHILD_TOKEN,
      getMe: getMeByToken("DifferentExpertBot"),
      replaceManagedBotToken: () => ROTATED_TOKEN,
    });
    await expect(runTelegramProvisionCli([
      "--rotate", "--username", "NeutralExpertBot", "--token-file", tokenFile, "--user-id", String(CHILD_ID),
    ], { fetchImpl, env: MANAGER_ENV, log: () => undefined })).rejects.toThrow(/belongs to @DifferentExpertBot/);
    expect(calls.some((call) => call.method === "replaceManagedBotToken")).toBeFalse();
  });

  test("retains the numeric recovery handle after rotation succeeds but token writing fails", async () => {
    const root = await temporaryRoot();
    const tokenFile = join(root, "occupied-directory");
    await mkdir(tokenFile);
    const { fetchImpl } = telegramFake({
      getManagedBotToken: () => CHILD_TOKEN,
      getMe: getMeByToken(),
      replaceManagedBotToken: () => ROTATED_TOKEN,
    });
    const failure = await runTelegramProvisionCli([
      "--rotate", "--username", "NeutralExpertBot", "--token-file", tokenFile, "--user-id", String(CHILD_ID),
    ], { fetchImpl, env: MANAGER_ENV, log: () => undefined }).then(() => undefined, (error: Error) => error);
    expect(failure?.message).toContain(`--user-id ${CHILD_ID} --replace (without --rotate)`);
    expectNoSecretsIn("rotation recovery", [failure?.message ?? ""]);
  });
});

describe("short-lived managed bot factory steps", () => {
  test("returns a confirmation link without polling or acquiring child credentials", async () => {
    const { calls, fetchImpl } = telegramFake({
      getMe: () => ({ id: MANAGER_ID, is_bot: true, can_manage_bots: true, username: "NeutralManagerBot" }),
      getWebhookInfo: () => ({ url: "" }),
    });
    const result = await beginManagedBotProvision({ username: "@NeutralExpertBot", displayName: "Neutral Expert" }, { fetchImpl, env: MANAGER_ENV });
    expect(result).toEqual({ managerUsername: "NeutralManagerBot", requestedUsername: "NeutralExpertBot", deepLink: "https://t.me/newbot/NeutralManagerBot/NeutralExpertBot?name=Neutral+Expert" });
    expect(calls.map((call) => call.method)).toEqual(["getMe", "getWebhookInfo"]);
    expectNoSecretsIn("begin result", [JSON.stringify(result)]);
  });

  test("requires management capability before offering an unusable creation link", async () => {
    const { calls, fetchImpl } = telegramFake({ getMe: getMeByToken() });
    await expect(beginManagedBotProvision({ username: "NeutralExpertBot", displayName: "Neutral Expert" }, { fetchImpl, env: MANAGER_ENV }))
      .rejects.toThrow(/Bot Management Mode/);
    expect(calls).toHaveLength(1);
  });

  test("refuses a configured webhook without deleting it or consuming updates", async () => {
    const { calls, fetchImpl } = telegramFake({ getWebhookInfo: () => ({ url: "https://example.invalid/telegram" }) });
    await expect(probeManagedBotProvision({ username: "NeutralExpertBot", ownerUserId: 77 }, { fetchImpl, env: MANAGER_ENV }))
      .rejects.toThrow(/does not delete webhooks/);
    expect(calls.map((call) => call.method)).toEqual(["getWebhookInfo"]);
  });

  test("matches username and authorized creator in one non-acknowledging probe", async () => {
    const { calls, fetchImpl } = telegramFake({
      getWebhookInfo: () => ({ url: "" }),
      getUpdates: () => [
        { update_id: 1, managed_bot: { user: { id: 88 }, bot: { id: 99, username: "NeutralExpertBot" } } },
        managedBotUpdate(2, 999, "UnrelatedExpertBot"),
        managedBotUpdate(3, CHILD_ID, "neutralexpertbot"),
      ],
    });
    const result = await probeManagedBotProvision({ username: "NeutralExpertBot", ownerUserId: 77 }, { fetchImpl, env: MANAGER_ENV });
    expect(result).toEqual({ status: "confirmed", botId: CHILD_ID, actualUsername: "neutralexpertbot", latestUpdateId: 3 });
    expect(calls.filter((call) => call.method === "getUpdates").map((call) => call.json))
      .toEqual([{ limit: 100, timeout: 0, allowed_updates: ["managed_bot"] }]);
    expectNoSecretsIn("probe result", [JSON.stringify(result)]);
  });

  test("returns pending for a different owner without advancing the queue", async () => {
    const { calls, fetchImpl } = telegramFake({
      getWebhookInfo: () => ({ url: "" }),
      getUpdates: () => [managedBotUpdate(1, CHILD_ID, "NeutralExpertBot")],
    });
    expect(await probeManagedBotProvision({ username: "NeutralExpertBot", ownerUserId: 88 }, { fetchImpl, env: MANAGER_ENV }))
      .toEqual({ status: "pending", latestUpdateId: 1 });
    expect(calls.filter((call) => call.method === "getUpdates")).toHaveLength(1);
    expect(calls[1]!.json).not.toHaveProperty("offset");
  });

  test("with a watermark, reports only newer owner-created bots under other names as candidates", async () => {
    const { fetchImpl } = telegramFake({
      getWebhookInfo: () => ({ url: "" }),
      getUpdates: () => [
        managedBotUpdate(3, 5001, "OlderRenamedBot"),
        managedBotUpdate(4, 5002, "NewerRenamed_tBot"),
        managedBotUpdate(5, 5002, "NewerRenamed_tBot"),
        { update_id: 6, managed_bot: { user: { id: 99 }, bot: { id: 5003, is_bot: true, username: "StrangersBot" } } },
      ],
    });
    const result = await probeManagedBotProvision({ username: "NeutralExpertBot", ownerUserId: 77, sinceUpdateId: 3 }, { fetchImpl, env: MANAGER_ENV });
    expect(result).toEqual({ status: "pending", latestUpdateId: 6, candidates: [{ botId: 5002, username: "NewerRenamed_tBot", updateId: 5 }] });
    expect(await probeManagedBotProvision({ username: "NeutralExpertBot", ownerUserId: 77 }, { fetchImpl, env: MANAGER_ENV }))
      .toEqual({ status: "pending", latestUpdateId: 6 });
    await expect(probeManagedBotProvision({ username: "NeutralExpertBot", ownerUserId: 77, sinceUpdateId: -1 }, { fetchImpl, env: MANAGER_ENV }))
      .rejects.toThrow(/watermark/);
  });

  test("reports a full unmatched queue rather than silently polling forever or discarding it", async () => {
    const { fetchImpl } = telegramFake({
      getWebhookInfo: () => ({ url: "" }),
      getUpdates: () => Array.from({ length: 100 }, (_, id) => managedBotUpdate(id, 1000 + id, "UnrelatedExpertBot")),
    });
    await expect(probeManagedBotProvision({ username: "NeutralExpertBot", ownerUserId: 77 }, { fetchImpl, env: MANAGER_ENV }))
      .rejects.toThrow(/will not discard/);
  });
});
