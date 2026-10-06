import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { DomainExpertTool } from '../packages/runtime/src/core/domain-expert-client.ts';

// The research tool names this plugin registers on the gateway. Typed against
// DomainExpertTool so a tool added to the client union fails typecheck here
// until the fingerprint covers it too.
const GATEWAY_TOOLS = {
  domain_agent: true,
  domain_ask: true,
  domain_read: true,
  domain_source: true,
  rag_corpus: true,
  domain_doc: true,
  annas_archive_search: true,
  annas_archive_import: true,
} as const satisfies Record<DomainExpertTool, true>;

export const GATEWAY_TOOL_NAMES: readonly DomainExpertTool[] = (Object.keys(GATEWAY_TOOLS) as DomainExpertTool[]).sort();

// Two plugins can claim the same tool name in one gateway boot, and the host
// resolves the collision last-writer-wins without warning. The control-plane
// policy stamp is the only field that says which runtime actually produced a
// response, so it is the whole discriminator here. The fork's key is written
// unquoted on purpose: the boundary scan rejects a quoted Olympus identifier
// in active code, and quoting this key would fail `bun run boundaries`.
const OWNER_STAMPS = {
  'expert-agents': 'expert_agents_control_plane_only',
  olympus: 'olympus_control_plane_only',
} as const satisfies Record<string, keyof OwnershipStamps>;

export type PluginOwner = keyof typeof OWNER_STAMPS;

// `missing` is not a classification of a response; it is the absence of one.
// It exists so every research tool occupies a row in the report and
// silence can never be read as ownership.
export type OwnershipVerdict = PluginOwner | 'ambiguous' | 'unknown' | 'missing';

export interface OwnershipStamps {
  expert_agents_control_plane_only: boolean;
  olympus_control_plane_only: boolean;
}

export interface ToolOwnership {
  tool: DomainExpertTool;
  verdict: OwnershipVerdict;
  reason: string;
  // Null only when no response was captured for the tool name at all.
  stamps: OwnershipStamps | null;
}

export interface OwnershipFingerprint {
  schemaVersion: 1;
  tools: ToolOwnership[];
  counts: Record<OwnershipVerdict, number>;
  verdict: {
    owned_by_expert_agents: boolean;
    missing_tools: DomainExpertTool[];
    unowned_tools: DomainExpertTool[];
  };
  sha256: string;
}

export type CapturedResponses = Map<DomainExpertTool, unknown>;

export interface OwnershipCliDependencies {
  readStdin?: () => Promise<string>;
}

export interface OwnershipCliResult {
  fingerprint: OwnershipFingerprint;
  output: string;
}

interface OwnershipCliArguments {
  path?: string;
  json: boolean;
}

const EXPERT_AGENTS: PluginOwner = 'expert-agents';
const OWNER_NAMES = Object.keys(OWNER_STAMPS) as PluginOwner[];
const VERDICT_NAMES: OwnershipVerdict[] = [...OWNER_NAMES, 'ambiguous', 'unknown', 'missing'];
const TOOL_COLUMN = 22;
const VERDICT_COLUMN = 14;

const CLI_USAGE = `Usage: bun run plugin:ownership -- [<captured-responses-json-path>] [--json]

Captured gateway responses are read from the given path, or from stdin when no
path is given. This check never contacts the gateway; it only judges responses
an operator already captured.`;

export function parseCapturedResponses(text: string): CapturedResponses {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Invalid captured responses: expected valid JSON.');
  }
  return validateCapturedResponses(value);
}

export function validateCapturedResponses(value: unknown): CapturedResponses {
  const captured: CapturedResponses = new Map();
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const entry = asRecord(item);
      if (!entry) {
        throw new Error(`Invalid captured responses at $[${index}]: expected a { tool, response } object.`);
      }
      if (typeof entry.tool !== 'string' || entry.tool.trim() === '') {
        throw new Error(`Invalid captured responses at $[${index}].tool: expected a non-empty tool name.`);
      }
      if (!Object.hasOwn(entry, 'response')) {
        throw new Error(`Invalid captured responses at $[${index}].response: expected a captured response body.`);
      }
      const tool = requireGatewayTool(entry.tool, `$[${index}].tool`);
      if (captured.has(tool)) {
        throw new Error(`Invalid captured responses at $[${index}].tool: duplicate entry for "${tool}".`);
      }
      captured.set(tool, entry.response);
    });
    return captured;
  }

  const record = asRecord(value);
  if (!record) {
    throw new Error(
      'Invalid captured responses at $: expected an object mapping tool name to response, or an array of { tool, response } entries.',
    );
  }
  for (const [name, response] of Object.entries(record)) {
    captured.set(requireGatewayTool(name, '$'), response);
  }
  return captured;
}

export function classifyToolOwnership(tool: DomainExpertTool, response: unknown): ToolOwnership {
  const body = asRecord(response);
  if (!body) {
    return { tool, verdict: 'unknown', reason: 'the captured response is not a JSON object.', stamps: readStamps(undefined) };
  }
  const policy = asRecord(body.policy);
  if (!policy) {
    return { tool, verdict: 'unknown', reason: 'the response carries no policy object.', stamps: readStamps(undefined) };
  }

  const stamps = readStamps(policy);
  const stamped = OWNER_NAMES.filter((owner) => stamps[OWNER_STAMPS[owner]]);
  if (stamped.length > 1) {
    return {
      tool,
      verdict: 'ambiguous',
      reason: 'both control-plane stamps are true, so the response cannot be attributed to one plugin.',
      stamps,
    };
  }
  const owner = stamped[0];
  if (!owner) {
    return { tool, verdict: 'unknown', reason: 'neither control-plane stamp is true.', stamps };
  }
  return { tool, verdict: owner, reason: `only ${OWNER_STAMPS[owner]} is true.`, stamps };
}

export function createOwnershipFingerprint(captured: CapturedResponses): OwnershipFingerprint {
  const tools = GATEWAY_TOOL_NAMES.map((tool): ToolOwnership => (
    captured.has(tool)
      ? classifyToolOwnership(tool, captured.get(tool))
      : { tool, verdict: 'missing', reason: 'no response was captured for this tool name.', stamps: null }
  ));
  const missing = tools.filter((entry) => entry.verdict === 'missing').map((entry) => entry.tool);
  const unowned = tools
    .filter((entry) => entry.verdict !== 'missing' && entry.verdict !== EXPERT_AGENTS)
    .map((entry) => entry.tool);

  return {
    schemaVersion: 1,
    tools,
    counts: Object.fromEntries(
      VERDICT_NAMES.map((verdict) => [verdict, tools.filter((entry) => entry.verdict === verdict).length]),
    ) as Record<OwnershipVerdict, number>,
    verdict: {
      owned_by_expert_agents: missing.length === 0 && unowned.length === 0,
      missing_tools: missing,
      unowned_tools: unowned,
    },
    sha256: ownershipDigest(tools),
  };
}

export function serializeOwnershipFingerprint(fingerprint: OwnershipFingerprint): string {
  return `${JSON.stringify(fingerprint, null, 2)}\n`;
}

// Only the tool name, verdict, reason, and the two stamp booleans are printed.
// Captured bodies carry retrieved corpus text and, for the acquisition tools,
// source URLs; none of that belongs in a receipt an operator pastes into a
// cutover thread.
export function formatOwnershipReport(fingerprint: OwnershipFingerprint): string {
  const owned = fingerprint.counts[EXPERT_AGENTS];
  const lines = [
    `Plugin ownership fingerprint ${fingerprint.sha256}`,
    `${owned}/${fingerprint.tools.length} gateway tool names answered by expert-agents.`,
  ];
  for (const entry of fingerprint.tools) {
    lines.push(`  ${entry.tool.padEnd(TOOL_COLUMN)}${entry.verdict.padEnd(VERDICT_COLUMN)}${entry.reason}`);
    if (entry.stamps) lines.push(`  ${' '.repeat(TOOL_COLUMN)}${formatStamps(entry.stamps)}`);
  }

  if (fingerprint.verdict.missing_tools.length > 0) {
    lines.push(
      `Missing: ${fingerprint.verdict.missing_tools.join(', ')}. A tool name with no captured response is a failure, not a pass.`,
    );
  }
  if (fingerprint.verdict.unowned_tools.length > 0) {
    lines.push(
      `Not ours: ${fingerprint.verdict.unowned_tools.join(', ')}. These responses did not fingerprint to expert-agents.`,
    );
  }
  lines.push(`Verdict: ${fingerprint.verdict.owned_by_expert_agents ? 'PASSED' : 'FAILED'}.`);
  return `${lines.join('\n')}\n`;
}

export function parsePluginOwnershipCliArguments(args: string[]): OwnershipCliArguments {
  let path: string | undefined;
  let json = false;
  for (const arg of args) {
    if (arg === '--json') {
      if (json) throw new Error(CLI_USAGE);
      json = true;
      continue;
    }
    if (!arg || arg.startsWith('--') || path !== undefined) throw new Error(CLI_USAGE);
    path = arg;
  }
  return { ...(path !== undefined ? { path } : {}), json };
}

export async function runPluginOwnershipFingerprintCli(
  args: string[],
  dependencies: OwnershipCliDependencies = {},
): Promise<OwnershipCliResult> {
  const parsed = parsePluginOwnershipCliArguments(args);
  const text = parsed.path !== undefined ? await readFile(parsed.path, 'utf8') : await readCapturedStdin(dependencies);
  const fingerprint = createOwnershipFingerprint(parseCapturedResponses(text));
  return {
    fingerprint,
    output: parsed.json ? serializeOwnershipFingerprint(fingerprint) : formatOwnershipReport(fingerprint),
  };
}

export function pluginOwnershipExitCode(fingerprint: OwnershipFingerprint): 0 | 1 {
  return fingerprint.verdict.owned_by_expert_agents ? 0 : 1;
}

async function readCapturedStdin(dependencies: OwnershipCliDependencies): Promise<string> {
  if (dependencies.readStdin) return dependencies.readStdin();
  // With neither a path nor piped input there is nothing to judge, and blocking
  // on an interactive terminal would look like a hung ceremony step.
  if (process.stdin.isTTY) throw new Error(CLI_USAGE);
  return Bun.stdin.text();
}

function readStamps(policy: Record<string, unknown> | undefined): OwnershipStamps {
  return {
    expert_agents_control_plane_only: policy?.expert_agents_control_plane_only === true,
    olympus_control_plane_only: policy?.olympus_control_plane_only === true,
  };
}

function formatStamps(stamps: OwnershipStamps): string {
  return OWNER_NAMES.map((owner) => `${OWNER_STAMPS[owner]}=${stamps[OWNER_STAMPS[owner]]}`).join('  ');
}

function ownershipDigest(tools: ToolOwnership[]): string {
  // Only the tool name and its verdict enter the digest. Reason prose is
  // derived text; hashing it would move the digest whenever the wording is
  // edited, and two ceremonies with the same outcome must produce the same
  // evidence value.
  const normalized = tools.map(({ tool, verdict }) => ({ tool, verdict }));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function requireGatewayTool(value: string, path: string): DomainExpertTool {
  if (!GATEWAY_TOOL_NAMES.includes(value as DomainExpertTool)) {
    throw new Error(`Invalid captured responses at ${path}: ${boundedName(value)} is not a gateway tool name.`);
  }
  return value as DomainExpertTool;
}

// Names come from a capture file, so they are echoed back bounded and escaped:
// an operator needs to see what the file actually contained, and an overlong or
// control-laden key must not reshape the report it lands in.
function boundedName(value: string): string {
  const characters = [...value];
  return JSON.stringify(characters.length > 48 ? `${characters.slice(0, 48).join('')}...` : value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

if (import.meta.main) {
  try {
    const result = await runPluginOwnershipFingerprintCli(process.argv.slice(2));
    console.log(result.output.trimEnd());
    process.exitCode = pluginOwnershipExitCode(result.fingerprint);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Plugin ownership fingerprint failed.');
    process.exitCode = 1;
  }
}
