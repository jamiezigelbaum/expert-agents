import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson } from "../../library/src/index.ts";
import type {
  AgentBindingManifest,
  AgentManifest,
  BindingArtifactReceipt,
  BindingDescriptor,
  BindingEmitResult,
  BindingIdentifierStatus,
  BindingVerificationReport,
} from "./types.ts";
import { validateAgentManifest, validateBindingManifest } from "./validation.ts";

export const BINDING_DESCRIPTOR_FILE = "binding-descriptor.json";
export const BINDING_CHECKLIST_FILE = "APPLICATION_CHECKLIST.md";
export const BINDING_RECEIPT_FILE = "BINDING_RECEIPT.json";

export async function emitBindingArtifacts(
  agentDirectory: string,
  outputDirectory: string,
): Promise<BindingEmitResult> {
  const root = resolve(agentDirectory);
  const outputDir = resolve(outputDirectory);
  const { manifest, binding } = await readBindingInputs(root);
  const descriptor = createBindingDescriptor(manifest, binding);
  const checklist = createBindingChecklist(descriptor);
  const artifacts = new Map<string, string>([
    [BINDING_CHECKLIST_FILE, checklist],
    [BINDING_DESCRIPTOR_FILE, canonicalJson(descriptor)],
  ]);
  const receipt: BindingArtifactReceipt = {
    schemaVersion: 1,
    kind: "expert_binding_receipt",
    files: [...artifacts]
      .map(([path, contents]) => ({
        path,
        sha256: createHash("sha256").update(contents).digest("hex"),
        bytes: Buffer.byteLength(contents),
      }))
      .sort((left, right) => compareStrings(left.path, right.path)),
  };

  await assertEmptyOutput(outputDir);
  await mkdir(outputDir, { recursive: true });
  for (const [path, contents] of [...artifacts].sort(([left], [right]) => compareStrings(left, right))) {
    await writeFile(join(outputDir, path), contents, { encoding: "utf8", flag: "wx" });
  }
  await writeFile(
    join(outputDir, BINDING_RECEIPT_FILE),
    canonicalJson(receipt),
    { encoding: "utf8", flag: "wx" },
  );
  return { outputDir, descriptor, checklist, receipt };
}

export async function verifyBindingConfig(
  agentDirectory: string,
  gatewayConfigPath: string,
): Promise<BindingVerificationReport> {
  const { manifest, binding } = await readBindingInputs(agentDirectory);
  let gatewayConfig: string;
  try {
    gatewayConfig = await readFile(resolve(gatewayConfigPath), "utf8");
  } catch {
    throw new Error("could not read the operator-supplied gateway configuration");
  }
  const identifiers: BindingIdentifierStatus[] = [{
    identifier: "agentId",
    found: containsStableIdentifier(gatewayConfig, manifest.agentId),
  }];
  if (binding.telegram?.botUsername !== undefined) {
    identifiers.push({
      identifier: "botUsername",
      found: gatewayConfig.includes(binding.telegram.botUsername),
    });
  }
  if (binding.telegram !== undefined) {
    identifiers.push({
      identifier: "tokenFilePath",
      found: gatewayConfig.includes(binding.telegram.tokenFilePath),
    });
  }
  return {
    schemaVersion: 1,
    kind: "expert_binding_verification",
    method: "identifier_presence",
    networkAccess: false,
    valid: identifiers.every((identifier) => identifier.found),
    identifiers,
  };
}

export function createBindingDescriptor(
  manifest: AgentManifest,
  binding: AgentBindingManifest,
): BindingDescriptor {
  if (manifest.agentId !== binding.openclaw.agentId) {
    throw new Error("binding.json OpenClaw agent id must match agent.json agent id");
  }
  return {
    schemaVersion: 1,
    kind: "expert_binding_descriptor",
    agent: {
      agentId: manifest.agentId,
      displayName: manifest.displayName,
    },
    openclaw: binding.openclaw,
    ...(binding.telegram === undefined ? {} : { telegram: binding.telegram }),
    routing: {
      domainId: manifest.domainId,
      targetCorpusDisplayName: manifest.targetCorpusDisplayName,
    },
  };
}

export function createBindingChecklist(descriptor: BindingDescriptor): string {
  const lines = [
    "# Binding application checklist",
    "",
    "This checklist is declarative and offline. The tool does not contact or modify a gateway, Telegram, BotFather, or any messaging API.",
    "",
    "## Apply",
    "",
  ];
  let step = 1;
  if (descriptor.telegram !== undefined && descriptor.telegram.botUsername === undefined) {
    lines.push(
      `${step}. [MANUAL] Talk to @BotFather, run /newbot, record the assigned username in binding.json, and never record the token value in any repository, descriptor, checklist, or receipt.`,
    );
    step += 1;
  }
  if (descriptor.telegram !== undefined) {
    lines.push(
      `${step}. [MANUAL] Provision the Telegram token file at \`${descriptor.telegram.tokenFilePath}\` with mode 0600. Never commit the token or copy its value into machinery outputs.`,
    );
    step += 1;
  }
  const contractFirst = "Verify the exact keys with `openclaw docs` / `config.schema.lookup`, then apply only via `openclaw config set` / `config.patch`.";
  const workspaceField = descriptor.openclaw.workspacePath === undefined
    ? "Add `workspace` only when a `workspacePath` has been declared."
    : `Set \`workspace\` from the declared \`workspacePath\` (\`${descriptor.openclaw.workspacePath}\`).`;
  lines.push(
    `${step}. [MANUAL] Register the native OpenClaw gateway configuration through the approved change protocol. This tool does not modify gateways:`,
    `   1. [MANUAL] Add an \`agents.list[]\` entry with \`id\` \`${descriptor.openclaw.agentId}\` and \`name\` \`${descriptor.agent.displayName}\`. ${workspaceField} ${contractFirst}`,
  );
  if (descriptor.telegram !== undefined) {
    lines.push(
      `   2. [MANUAL] Add a \`bindings[]\` entry shaped as \`{agentId, match: {channel: "telegram", accountId}}\`, using the declared agent ID and the operator-approved Telegram account ID. ${contractFirst}`,
      `   3. [MANUAL] Provision the bot token at \`channels.telegram.accounts.<id>.botToken\` through the operator's secret-custody process. Never place the token value in this checklist or another machinery artifact. ${contractFirst}`,
    );
  }
  lines.push(
    `${step + 1}. Run the offline identifier-presence verification against the operator-supplied gateway configuration after application.`,
    "",
    "## ROLLBACK",
    "",
    "Perform these inverse steps in reverse application order:",
    "",
    `1. [MANUAL] Remove the declared \`bindings[]\` entry, when present, and the \`agents.list[]\` entry for \`${descriptor.openclaw.agentId}\` through the approved change protocol. ${contractFirst}`,
  );
  let rollbackStep = 2;
  if (descriptor.telegram !== undefined) {
    lines.push(
      `${rollbackStep}. [MANUAL] Remove the provisioned token file at \`${descriptor.telegram.tokenFilePath}\` using the operator-approved secret-custody process.`,
    );
    rollbackStep += 1;
  }
  if (descriptor.telegram !== undefined && descriptor.telegram.botUsername === undefined) {
    lines.push(
      `${rollbackStep}. [MANUAL] If the newly created Telegram bot must be retired, return to @BotFather and perform the owner-approved inverse action.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function readBindingInputs(
  agentDirectory: string,
): Promise<{ manifest: AgentManifest; binding: AgentBindingManifest }> {
  const root = resolve(agentDirectory);
  const manifest = validateAgentManifest(await readJsonFile(join(root, "agent.json"), "agent.json"));
  const binding = validateBindingManifest(await readJsonFile(join(root, "binding.json"), "binding.json"));
  if (manifest.agentId !== binding.openclaw.agentId) {
    throw new Error("binding.json OpenClaw agent id must match agent.json agent id");
  }
  return { manifest, binding };
}

async function readJsonFile(path: string, displayPath: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) throw new Error(`${displayPath} is required`);
    throw new Error(`could not read ${displayPath}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${displayPath} is not valid JSON`);
  }
}

async function assertEmptyOutput(outputDir: string): Promise<void> {
  try {
    const output = await stat(outputDir);
    if (!output.isDirectory()) throw new Error("binding output path exists and is not a directory");
    if ((await readdir(outputDir)).length > 0) throw new Error("binding output directory must be empty");
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function containsStableIdentifier(text: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9._-])${escaped}(?![A-Za-z0-9._-])`).test(text);
}
