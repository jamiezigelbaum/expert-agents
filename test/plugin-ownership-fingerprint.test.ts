import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GATEWAY_TOOL_NAMES,
  classifyToolOwnership,
  createOwnershipFingerprint,
  formatOwnershipReport,
  parseCapturedResponses,
  pluginOwnershipExitCode,
  runPluginOwnershipFingerprintCli,
  type CapturedResponses,
  type OwnershipFingerprint,
  type ToolOwnership,
} from '../scripts/plugin-ownership-fingerprint.ts';

// Sentinels stand in for the two kinds of content a captured body carries that
// must never reach a report: retrieved corpus prose and acquisition source URLs.
const CORPUS_SENTINEL = 'PRIVATE_CORPUS_TEXT_SENTINEL';
const SOURCE_SENTINEL = 'https://sentinel.invalid/private-source.pdf';
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('captured response validation', () => {
  test('rejects an unknown tool name and names what it got', () => {
    expect(() => parseCapturedResponses(JSON.stringify({ domain_summarize: ourResponse() }))).toThrow(
      'Invalid captured responses at $: "domain_summarize" is not a gateway tool name.',
    );
    expect(() => parseCapturedResponses(JSON.stringify([{ tool: 'olympus_ask', response: ourResponse() }]))).toThrow(
      'Invalid captured responses at $[0].tool: "olympus_ask" is not a gateway tool name.',
    );
  });

  test('rejects malformed input shapes and duplicate entries', () => {
    expect(() => parseCapturedResponses('{')).toThrow('Invalid captured responses: expected valid JSON.');
    expect(() => parseCapturedResponses('"domain_ask"')).toThrow(
      'Invalid captured responses at $: expected an object mapping tool name to response, or an array of { tool, response } entries.',
    );
    expect(() => parseCapturedResponses(JSON.stringify([{ tool: 'domain_ask' }]))).toThrow(
      'Invalid captured responses at $[0].response: expected a captured response body.',
    );
    expect(() => parseCapturedResponses(JSON.stringify([
      { tool: 'domain_ask', response: ourResponse() },
      { tool: 'domain_ask', response: ourResponse() },
    ]))).toThrow('Invalid captured responses at $[1].tool: duplicate entry for "domain_ask".');
  });

  test('accepts the array entry form as an equivalent capture of the same set', () => {
    const entries = GATEWAY_TOOL_NAMES.map((tool) => ({ tool, response: ourResponse() }));

    const fingerprint = createOwnershipFingerprint(parseCapturedResponses(JSON.stringify(entries)));

    expect(fingerprint.verdict.owned_by_expert_agents).toBeTrue();
    // Same verdicts from either input form must produce the same evidence value.
    expect(fingerprint.sha256).toBe(createOwnershipFingerprint(allOurs()).sha256);
  });
});

describe('ownership classification', () => {
  test('passes when every tool carries our control-plane stamp', () => {
    const fingerprint = createOwnershipFingerprint(allOurs());

    expect(fingerprint.tools).toHaveLength(GATEWAY_TOOL_NAMES.length);
    expect(fingerprint.tools.every((entry) => entry.verdict === 'expert-agents')).toBeTrue();
    expect(fingerprint.counts['expert-agents']).toBe(GATEWAY_TOOL_NAMES.length);
    expect(fingerprint.verdict).toEqual({ owned_by_expert_agents: true, missing_tools: [], unowned_tools: [] });
    expect(pluginOwnershipExitCode(fingerprint)).toBe(0);
  });

  test('fails and names the tool a colliding plugin answered', () => {
    // The 2026-07-30 incident: the cutover looked healthy while the fork on the
    // same gateway answered tool calls our plugin believed it owned.
    const captured = allOurs();
    captured.set('domain_ask', forkResponse());

    const fingerprint = createOwnershipFingerprint(captured);

    expect(entryFor(fingerprint, 'domain_ask').verdict).toBe('olympus');
    expect(entryFor(fingerprint, 'domain_ask').reason).toBe('only olympus_control_plane_only is true.');
    expect(fingerprint.verdict.unowned_tools).toEqual(['domain_ask']);
    expect(pluginOwnershipExitCode(fingerprint)).toBe(1);
    expect(formatOwnershipReport(fingerprint)).toContain('Not ours: domain_ask');
  });

  test('fails and names a tool with no captured response', () => {
    const captured = allOurs();
    captured.delete('rag_corpus');

    const fingerprint = createOwnershipFingerprint(captured);

    expect(fingerprint.tools).toHaveLength(GATEWAY_TOOL_NAMES.length);
    expect(entryFor(fingerprint, 'rag_corpus')).toEqual({
      tool: 'rag_corpus',
      verdict: 'missing',
      reason: 'no response was captured for this tool name.',
      stamps: null,
    });
    expect(fingerprint.verdict.missing_tools).toEqual(['rag_corpus']);
    expect(pluginOwnershipExitCode(fingerprint)).toBe(1);
    expect(formatOwnershipReport(fingerprint)).toContain(
      'Missing: rag_corpus. A tool name with no captured response is a failure, not a pass.',
    );
  });

  test('treats both stamps set as ambiguous rather than as ours', () => {
    const captured = allOurs();
    captured.set('domain_doc', ourResponse({ olympus_control_plane_only: true }));

    const fingerprint = createOwnershipFingerprint(captured);

    expect(entryFor(fingerprint, 'domain_doc').verdict).toBe('ambiguous');
    expect(entryFor(fingerprint, 'domain_doc').stamps).toEqual({
      expert_agents_control_plane_only: true,
      olympus_control_plane_only: true,
    });
    expect(fingerprint.verdict.unowned_tools).toEqual(['domain_doc']);
    expect(pluginOwnershipExitCode(fingerprint)).toBe(1);
  });

  test('treats a response without a policy object as unknown ownership', () => {
    const captured = allOurs();
    captured.set('domain_source', { kind: 'domain_answer', answer: CORPUS_SENTINEL });
    captured.set('domain_agent', 'not-an-object');

    const fingerprint = createOwnershipFingerprint(captured);

    expect(entryFor(fingerprint, 'domain_source').verdict).toBe('unknown');
    expect(entryFor(fingerprint, 'domain_source').reason).toBe('the response carries no policy object.');
    expect(entryFor(fingerprint, 'domain_agent').reason).toBe('the captured response is not a JSON object.');
    expect(fingerprint.counts.unknown).toBe(2);
    expect(pluginOwnershipExitCode(fingerprint)).toBe(1);
  });

  test('treats a policy object with neither stamp true as unknown ownership', () => {
    const ownership = classifyToolOwnership('domain_ask', { policy: { raw_runtime_secrets_exposed: false } });

    expect(ownership.verdict).toBe('unknown');
    expect(ownership.reason).toBe('neither control-plane stamp is true.');
    expect(ownership.stamps).toEqual({
      expert_agents_control_plane_only: false,
      olympus_control_plane_only: false,
    });
  });

  test('changes the receipt digest when a single tool changes owner', () => {
    const changed = allOurs();
    changed.set('domain_doc', forkResponse());

    expect(createOwnershipFingerprint(changed).sha256).not.toBe(createOwnershipFingerprint(allOurs()).sha256);
  });
});

describe('ownership fingerprint CLI', () => {
  test('reads captured responses from a file path and reports in human-readable form', async () => {
    const path = await capturedFixture(allOurs());

    const result = await runPluginOwnershipFingerprintCli([path]);

    expect(pluginOwnershipExitCode(result.fingerprint)).toBe(0);
    expect(result.output).toContain(`${GATEWAY_TOOL_NAMES.length}/${GATEWAY_TOOL_NAMES.length} gateway tool names answered by expert-agents.`);
    expect(result.output).toContain('expert_agents_control_plane_only=true  olympus_control_plane_only=false');
    expect(result.output).toContain('Verdict: PASSED.');
  });

  test('reads captured responses from stdin when no path is given', async () => {
    const captured = allOurs();
    captured.set('annas_archive_import', forkResponse());

    const result = await runPluginOwnershipFingerprintCli([], {
      readStdin: async () => JSON.stringify(capturedObject(captured)),
    });

    expect(pluginOwnershipExitCode(result.fingerprint)).toBe(1);
    expect(result.output).toContain('Not ours: annas_archive_import');
    expect(result.output).toContain('Verdict: FAILED.');
  });

  test('emits a machine-readable receipt under --json', async () => {
    const path = await capturedFixture(allOurs());

    const result = await runPluginOwnershipFingerprintCli([path, '--json']);
    const receipt = JSON.parse(result.output) as Record<string, unknown>;

    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.sha256).toBe(result.fingerprint.sha256);
    expect(receipt.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.counts).toEqual({
      'expert-agents': GATEWAY_TOOL_NAMES.length,
      olympus: 0,
      ambiguous: 0,
      unknown: 0,
      missing: 0,
    });
  });

  test('rejects unknown flags and a second path argument', () => {
    expect(runPluginOwnershipFingerprintCli(['--verbose'])).rejects.toThrow('Usage: bun run plugin:ownership');
    expect(runPluginOwnershipFingerprintCli(['first.json', 'second.json'])).rejects.toThrow(
      'Usage: bun run plugin:ownership',
    );
  });

  test('never reflects captured response content into either output form', async () => {
    const captured: CapturedResponses = new Map(GATEWAY_TOOL_NAMES.map((tool) => [tool, {
      kind: 'domain_answer',
      answer: CORPUS_SENTINEL,
      citations: [{ corpus_id: 'sentinel', source_uri: SOURCE_SENTINEL }],
      acquisition: { download_url: SOURCE_SENTINEL },
      policy: { expert_agents_control_plane_only: true, raw_runtime_secrets_exposed: false },
    }]));
    const path = await capturedFixture(captured);

    const human = await runPluginOwnershipFingerprintCli([path]);
    const json = await runPluginOwnershipFingerprintCli([path, '--json']);

    for (const output of [human.output, json.output]) {
      expect(output).not.toContain(CORPUS_SENTINEL);
      expect(output).not.toContain(SOURCE_SENTINEL);
      expect(output).not.toContain('sentinel');
      expect(output).not.toContain('citations');
    }
    expect(human.output).toContain('domain_ask');
  });
});

function allOurs(): CapturedResponses {
  return new Map(GATEWAY_TOOL_NAMES.map((tool) => [tool, ourResponse()]));
}

function ourResponse(extraPolicy: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'domain_answer',
    answer: CORPUS_SENTINEL,
    policy: { expert_agents_control_plane_only: true, raw_runtime_secrets_exposed: false, ...extraPolicy },
  };
}

function forkResponse(): Record<string, unknown> {
  return {
    kind: 'domain_answer',
    answer: CORPUS_SENTINEL,
    policy: { olympus_control_plane_only: true, raw_runtime_secrets_exposed: false },
  };
}

function capturedObject(captured: CapturedResponses): Record<string, unknown> {
  return Object.fromEntries(captured);
}

async function capturedFixture(captured: CapturedResponses): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'expert-agents-ownership-'));
  temporaryRoots.push(root);
  const path = join(root, 'captured-responses.json');
  await writeFile(path, JSON.stringify(capturedObject(captured)), 'utf8');
  return path;
}

function entryFor(fingerprint: OwnershipFingerprint, tool: string): ToolOwnership {
  const entry = fingerprint.tools.find((candidate) => candidate.tool === tool);
  if (!entry) throw new Error(`Expected a fingerprint row for ${tool}.`);
  return entry;
}
