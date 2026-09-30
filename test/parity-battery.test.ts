import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareParityQuestion,
  executeParityBattery,
  parseParityBattery,
  runParityBatteryCli,
  type ParityBattery,
  type ParityFetch,
  type ParityQuestionExecution,
  type RuntimeQuestionResult,
} from '../scripts/parity-battery.ts';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('parity battery comparison', () => {
  test('returns parity for order-insensitive equivalent fixture responses', () => {
    const baseline = domainAnswer({
      answer: 'Baseline prose is intentionally different.',
      resolved_corpora: [corpus('b', 'resources/b'), corpus('a', 'resources/a')],
      citations: [citation('b', 'gs://sources/b'), citation('a', 'gs://sources/a')],
      retrieval_plan: { query: 'history', settings: { top_k: 5, mode: 'hybrid' } },
    });
    const candidate = domainAnswer({
      answer: 'Candidate prose must not affect parity.',
      resolved_corpora: [corpus('a', 'resources/a'), corpus('b', 'resources/b')],
      citations: [citation('a', 'gs://sources/a'), citation('b', 'gs://sources/b')],
      retrieval_plan: { settings: { mode: 'hybrid', top_k: 5 }, query: 'history' },
    });

    const comparison = compareParityQuestion(execution(baseline, candidate));

    expect(comparison.verdict).toBe('parity');
    expect(comparison.citation_overlap_fraction).toBe(1);
    expect(comparison.baseline.kind).toBe('domain_answer');
    expect(comparison.candidate.kind).toBe('domain_answer');
  });

  test('flags resolved corpus divergence', () => {
    const baseline = domainAnswer({ resolved_corpora: [corpus('law', 'resources/law-v1')] });
    const candidate = domainAnswer({ resolved_corpora: [corpus('law', 'resources/law-v2')] });

    const comparison = compareParityQuestion(execution(baseline, candidate));

    expect(comparison.verdict).toBe('divergence');
    expect(comparison.differences.resolved_corpora).toBeTrue();
  });

  test('flags citation divergence and reports Jaccard overlap', () => {
    const baseline = domainAnswer({
      citations: [citation('law', 'gs://sources/shared'), citation('law', 'gs://sources/baseline')],
    });
    const candidate = domainAnswer({
      citations: [citation('law', 'gs://sources/shared'), citation('law', 'gs://sources/candidate')],
    });

    const comparison = compareParityQuestion(execution(baseline, candidate));

    expect(comparison.verdict).toBe('divergence');
    expect(comparison.differences.citations).toBeTrue();
    expect(comparison.citation_overlap_fraction).toBe(1 / 3);
  });

  test('flags a renamed policy contract field as divergence on every question', () => {
    // The 2026-07-28 cutover incident: identical answers, citations, and
    // corpora — but the caller validates the policy stamp by key name, and a
    // rename broke every live request while the battery reported parity.
    const baseline = domainAnswer({
      policy: { olympus_control_plane_only: true, raw_runtime_secrets_exposed: false },
    });
    const candidate = domainAnswer({
      policy: { expert_agents_control_plane_only: true, raw_runtime_secrets_exposed: false },
    });

    const comparison = compareParityQuestion(execution(baseline, candidate));

    expect(comparison.verdict).toBe('divergence');
    expect(comparison.differences.policy_paths).toEqual([
      '$.expert_agents_control_plane_only',
      '$.olympus_control_plane_only',
    ]);
  });

  test('flags a top-level contract key present on only one side', () => {
    const comparison = compareParityQuestion(execution(
      domainAnswer(),
      domainAnswer({ disclosure: { session_coverage: 0 } }),
    ));

    expect(comparison.verdict).toBe('divergence');
    expect(comparison.differences.contract_keys).toBeTrue();
  });

  test('a missing policy object on one side is a policy divergence, not an error', () => {
    const absent = domainAnswer();
    delete absent.policy;

    const comparison = compareParityQuestion(execution(absent, domainAnswer()));

    expect(comparison.verdict).toBe('divergence');
    expect(comparison.differences.policy_paths.length).toBeGreaterThan(0);
    expect(comparison.differences.contract_keys).toBeTrue();
  });

  test('flags retrieved context count drift', () => {
    const comparison = compareParityQuestion(execution(
      domainAnswer({ retrieved_context_count: 2 }),
      domainAnswer({ retrieved_context_count: 3 }),
    ));

    expect(comparison.verdict).toBe('divergence');
    expect(comparison.differences.retrieved_context_count).toBeTrue();
    if (comparison.baseline.kind !== 'domain_answer' || comparison.candidate.kind !== 'domain_answer') {
      throw new Error('Expected comparable domain answers.');
    }
    expect(comparison.baseline.retrieved_context_count).toBe(2);
    expect(comparison.candidate.retrieved_context_count).toBe(3);
  });

  test('reports error when either fixture side errors', () => {
    const comparison = compareParityQuestion(execution(
      domainAnswer(),
      { error: { code: 'runtime_failure', message: 'Synthetic failure.' }, policy: {} },
      200,
      503,
    ));

    expect(comparison.verdict).toBe('error');
    expect(comparison.candidate).toEqual({
      kind: 'error',
      error: 'http_error',
      http_status: 503,
      error_code: 'runtime_failure',
    });
  });

  test('reports retrieval plan diff paths without values', () => {
    const comparison = compareParityQuestion(execution(
      domainAnswer({ retrieval_plan: { settings: { top_k: 5, mode: 'hybrid' } } }),
      domainAnswer({ retrieval_plan: { settings: { mode: 'hybrid', top_k: 9 } } }),
    ));

    expect(comparison.verdict).toBe('divergence');
    expect(comparison.differences.retrieval_plan_paths).toEqual(['$.settings.top_k']);
    expect(JSON.stringify(comparison.differences)).not.toContain('hybrid');
  });

  test('compares arbitrary status values verbatim', () => {
    const comparison = compareParityQuestion(execution(
      domainAnswer({ status: 'synthetic_waiting' }),
      domainAnswer({ status: 'synthetic_blocked' }),
    ));

    expect(comparison.verdict).toBe('divergence');
    expect(comparison.differences.status).toBeTrue();
  });
});

describe('parity battery validation and execution', () => {
  test('rejects duplicate battery ids with a precise validation path', () => {
    expect(() => parseParityBattery(JSON.stringify({
      schemaVersion: 1,
      questions: [
        { id: 'duplicate', domain_id: 'history', question: 'First?' },
        { id: 'duplicate', domain_id: 'history', question: 'Second?' },
      ],
    }))).toThrow('questions[1].id: duplicate id "duplicate"');
  });

  test('fails before questions when either health check is unsuccessful', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl: ParityFetch = async (url) => {
      requestedUrls.push(url);
      return new Response('{}', { status: url.includes('candidate.test') ? 503 : 200 });
    };

    await expect(executeParityBattery(singleQuestionBattery(), {
      baseline: { baseUrl: 'https://baseline.test' },
      candidate: { baseUrl: 'https://candidate.test' },
      fetchImpl,
    })).rejects.toThrow('candidate runtime health check failed with HTTP 503');
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls.every((url) => url.endsWith('/v1/health'))).toBeTrue();
  });

  test('runs end to end against injected stub handlers without sockets', async () => {
    const fixture = await createCliFixture();
    const calls: StubCall[] = [];
    const fetchImpl = createStubFetch(calls);

    const receipt = await runParityBatteryCli([
      '--battery', fixture.batteryPath,
      '--baseline', 'https://baseline.test/runtime',
      '--candidate', 'https://candidate.test/runtime',
      '--output', fixture.firstOutputPath,
    ], {
      fetchImpl,
      env: {
        EXPERT_AGENTS_PARITY_BASELINE_TOKEN: 'baseline-synthetic-token',
        EXPERT_AGENTS_PARITY_CANDIDATE_TOKEN: 'candidate-synthetic-token',
      },
    });

    expect(receipt.questions.map((question) => question.id)).toEqual(['a-question', 'z-question']);
    expect(receipt.summary).toEqual({ total: 2, parity: 2, divergence: 0, error: 0 });
    expect(receipt.endpoints).toEqual({
      baseline: 'https://baseline.test',
      candidate: 'https://candidate.test',
    });
    expect(calls.slice(0, 2).every((call) => call.url.endsWith('/v1/health'))).toBeTrue();
    expect(calls.slice(2).every((call) => call.url.endsWith('/v1/domain'))).toBeTrue();
    expect(calls.filter((call) => call.url.includes('baseline.test')).every((call) => (
      call.authorization === 'Bearer baseline-synthetic-token'
    ))).toBeTrue();
    expect(calls.filter((call) => call.url.includes('candidate.test')).every((call) => (
      call.authorization === 'Bearer candidate-synthetic-token'
    ))).toBeTrue();
    expect(JSON.parse(await readFile(fixture.firstOutputPath, 'utf8'))).toEqual(receipt);
  });

  test('writes byte-identical deterministic receipts across two runs', async () => {
    const fixture = await createCliFixture();
    const args = [
      '--battery', fixture.batteryPath,
      '--baseline', 'https://baseline.test',
      '--candidate', 'https://candidate.test',
    ];

    await runParityBatteryCli([...args, '--output', fixture.firstOutputPath], {
      fetchImpl: createStubFetch([]),
      env: {},
    });
    await runParityBatteryCli([...args, '--output', fixture.secondOutputPath], {
      fetchImpl: createStubFetch([]),
      env: {},
    });

    expect(await readFile(fixture.secondOutputPath, 'utf8')).toBe(
      await readFile(fixture.firstOutputPath, 'utf8'),
    );
  });

  test('never writes bearer tokens or answer text to receipt output', async () => {
    const fixture = await createCliFixture();
    const baselineToken = 'baseline-token-must-not-appear';
    const candidateToken = 'candidate-token-must-not-appear';

    await runParityBatteryCli([
      '--battery', fixture.batteryPath,
      '--baseline', 'https://baseline.test',
      '--candidate', 'https://candidate.test',
      '--output', fixture.firstOutputPath,
    ], {
      fetchImpl: createStubFetch([]),
      env: {
        EXPERT_AGENTS_PARITY_BASELINE_TOKEN: baselineToken,
        EXPERT_AGENTS_PARITY_CANDIDATE_TOKEN: candidateToken,
      },
    });

    const output = await readFile(fixture.firstOutputPath, 'utf8');
    expect(output).not.toContain(baselineToken);
    expect(output).not.toContain(candidateToken);
    expect(output).not.toContain('Synthetic answer from baseline.test');
    expect(output).not.toContain('Synthetic answer from candidate.test');
    expect(output).toContain('"sha256"');
    expect(output).toContain('"characters"');
  });

  test('refuses to write a receipt if a runtime mirrors a bearer token', async () => {
    const fixture = await createCliFixture();
    const mirroredToken = 'mirrored-bearer-token';
    const fetchImpl: ParityFetch = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/v1/health')) return jsonResponse({ reachable: true });
      return jsonResponse(domainAnswer({ status: mirroredToken }));
    };

    await expect(runParityBatteryCli([
      '--battery', fixture.batteryPath,
      '--baseline', 'https://baseline.test',
      '--candidate', 'https://candidate.test',
      '--output', fixture.firstOutputPath,
    ], {
      fetchImpl,
      env: { EXPERT_AGENTS_PARITY_BASELINE_TOKEN: mirroredToken },
    })).rejects.toThrow('Refusing to write parity receipt because it contains a bearer token.');
    await expect(readFile(fixture.firstOutputPath, 'utf8')).rejects.toThrow();
  });
});

interface StubCall {
  url: string;
  authorization?: string;
}

function execution(
  baselineBody: unknown,
  candidateBody: unknown,
  baselineStatus = 200,
  candidateStatus = 200,
): ParityQuestionExecution {
  return {
    question: singleQuestionBattery().questions[0]!,
    baseline: responseResult(baselineBody, baselineStatus),
    candidate: responseResult(candidateBody, candidateStatus),
  };
}

function responseResult(body: unknown, httpStatus: number): RuntimeQuestionResult {
  return { kind: 'response', httpStatus, body };
}

function domainAnswer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'domain_answer',
    status: 'answered',
    domain_id: 'history',
    question: 'What changed?',
    answer: 'Synthetic answer.',
    citations: [citation('law', 'gs://sources/shared')],
    retrieved_context_count: 1,
    resolved_corpora: [corpus('law', 'resources/law')],
    retrieval_plan: { query: 'history', settings: { top_k: 5 } },
    policy: { raw_runtime_secrets_exposed: false },
    ...overrides,
  };
}

function corpus(corpusId: string, resourceName: string): Record<string, unknown> {
  return { requested: corpusId, corpus_id: corpusId, resource_name: resourceName };
}

function citation(corpusId: string, sourceUri: string): Record<string, unknown> {
  return {
    citation_id: `${corpusId}:${sourceUri}`,
    corpus_id: corpusId,
    source_display_name: sourceUri,
    source_uri: sourceUri,
    score: 0.9,
  };
}

function singleQuestionBattery(): ParityBattery {
  return {
    schemaVersion: 1,
    questions: [{ id: 'question-1', domain_id: 'history', question: 'What changed?' }],
  };
}

async function createCliFixture(): Promise<{
  batteryPath: string;
  firstOutputPath: string;
  secondOutputPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'expert-agents-parity-battery-test-'));
  temporaryRoots.push(root);
  const batteryPath = join(root, 'battery.json');
  await writeFile(batteryPath, `${JSON.stringify({
    schemaVersion: 1,
    questions: [
      { id: 'z-question', domain_id: 'history', question: 'Question Z?' },
      { id: 'a-question', domain_id: 'history', question: 'Question A?', corpora: ['law'] },
    ],
  }, null, 2)}\n`);
  return {
    batteryPath,
    firstOutputPath: join(root, 'first', 'receipt.json'),
    secondOutputPath: join(root, 'second', 'receipt.json'),
  };
}

function createStubFetch(calls: StubCall[]): ParityFetch {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    const headers = new Headers(init.headers);
    calls.push({
      url,
      ...(headers.get('Authorization') ? { authorization: headers.get('Authorization')! } : {}),
    });
    if (parsed.pathname.endsWith('/v1/health')) {
      return jsonResponse({ kind: 'domain_expert_health', reachable: true });
    }
    if (!parsed.pathname.endsWith('/v1/domain') || init.method !== 'POST') {
      return jsonResponse({ error: { code: 'not_found', message: 'Synthetic missing route.' }, policy: {} }, 404);
    }
    const request = JSON.parse(String(init.body)) as {
      tool: string;
      params: { domain_id: string; question: string; corpora?: string[] };
    };
    if (request.tool !== 'domain_ask') {
      return jsonResponse({ error: { code: 'invalid_tool', message: 'Synthetic invalid tool.' }, policy: {} }, 400);
    }
    return jsonResponse(domainAnswer({
      domain_id: request.params.domain_id,
      question: request.params.question,
      answer: `Synthetic answer from ${parsed.hostname}.`,
    }));
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
