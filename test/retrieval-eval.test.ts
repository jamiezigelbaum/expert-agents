import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeRetrievalEvalQuestionMetrics,
  createRetrievalEvalReceipt,
  executeRetrievalEval,
  extractCitationMarkers,
  parseRetrievalEvalSet,
  retrievalEvalExitCode,
  runRetrievalEvalCli,
  serializeRetrievalEvalReceipt,
  writeRetrievalEvalReceipt,
  type RetrievalEvalFetch,
  type RetrievalEvalQuestionExecution,
  type RetrievalEvalSet,
} from '../scripts/retrieval-eval.ts';

const OBJECT_ID_A = `sha256:${'a'.repeat(64)}`;
const OBJECT_ID_B = `sha256:${'b'.repeat(64)}`;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('retrieval eval set validation', () => {
  test('accepts a valid retrieval eval set', () => {
    const value = validEvalSet();
    value.questions[0]!.corpora = ['neutral-primary', 'neutral-commentary'];
    value.questions[0]!.expectedObjectIds = [OBJECT_ID_A, OBJECT_ID_B];

    expect(parseRetrievalEvalSet(JSON.stringify(value))).toEqual(value);
  });

  test('rejects invalid retrieval eval JSON without reflecting content', () => {
    const privateFragment = 'private-question-fragment';

    expect(() => parseRetrievalEvalSet(`{"${privateFragment}"`)).toThrow(
      'Invalid retrieval eval set: expected valid JSON.',
    );
    try {
      parseRetrievalEvalSet(`{"${privateFragment}"`);
    } catch (error) {
      expect(String(error)).not.toContain(privateFragment);
    }
  });

  test('rejects duplicate question ids with a content-free validation path', () => {
    const value = validEvalSet();
    value.questions.push({ ...value.questions[0]! });

    expect(() => parseRetrievalEvalSet(JSON.stringify(value))).toThrow(
      '$.questions[1].id: expected a unique id.',
    );
  });

  test('rejects malformed object ids and out-of-range thresholds', () => {
    const malformedId = validEvalSet();
    malformedId.questions[0]!.expectedObjectIds = ['sha256:not-an-object-id'];
    expect(() => parseRetrievalEvalSet(JSON.stringify(malformedId))).toThrow(
      '$.questions[0].expectedObjectIds[0]: expected a lowercase sha256 id.',
    );

    const invalidThreshold = validEvalSet();
    invalidThreshold.thresholds.maxMissRate = 1.01;
    expect(() => parseRetrievalEvalSet(JSON.stringify(invalidThreshold))).toThrow(
      '$.thresholds.maxMissRate: expected a number from 0 through 1.',
    );
  });

  test('rejects empty required values and unexpected fields', () => {
    const emptyQuestions = validEvalSet() as unknown as Record<string, unknown>;
    emptyQuestions.questions = [];
    expect(() => parseRetrievalEvalSet(JSON.stringify(emptyQuestions))).toThrow(
      '$.questions: expected a non-empty array.',
    );

    const unexpected = { ...validEvalSet(), privateQuestion: 'must-not-be-reflected' };
    expect(() => parseRetrievalEvalSet(JSON.stringify(unexpected))).toThrow(
      'Invalid retrieval eval set at $: unexpected field.',
    );
  });
});

describe('retrieval eval execution and metrics', () => {
  test('a schema-1 eval set checks health, then refuses: the worker no longer answers questions', async () => {
    const calls: Array<{ url: string; authorization: string | null; body?: unknown }> = [];
    const fetchImpl: RetrievalEvalFetch = async (url, init = {}) => {
      const headers = new Headers(init.headers);
      calls.push({
        url,
        authorization: headers.get('Authorization'),
        ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      return jsonResponse({ healthy: true });
    };

    await expect(executeRetrievalEval(validEvalSet(), {
      worker: { baseUrl: 'https://worker.test/runtime/', token: 'synthetic-token' },
      fetchImpl,
    })).rejects.toThrow('a schema-1 eval set scores worker answers, and the worker no longer answers questions');
    expect(calls).toEqual([{
      url: 'https://worker.test/runtime/v1/health',
      authorization: 'Bearer synthetic-token',
    }]);
  });

  test('the CLI refuses a schema-1 eval set and writes no receipt', async () => {
    const fixture = await createCliFixture();
    await expect(runRetrievalEvalCli(cliArgs(fixture), {
      fetchImpl: async () => jsonResponse({ healthy: true }),
      env: {},
    })).rejects.toThrow('Use a schema-2 eval set in passages mode');
    await expect(readFile(fixture.receiptPath, 'utf8')).rejects.toThrow();
  });

  test('computes expected source hit and one-based first-hit rank from canonical object paths', () => {
    const metrics = computeRetrievalEvalQuestionMetrics(questionExecution(domainAnswer({
      citations: [
        citation('neutral:1', `gs://neutral/objects/sha256/cc/${'c'.repeat(64)}.txt`),
        citation('neutral:2', `gs://neutral/objects/sha256/aa/${'a'.repeat(64)}.pdf`),
      ],
      answer: 'Neutral result [neutral:2].',
      retrieved_context_count: 2,
    })));

    expect(metrics).toEqual({
      id: 'neutral-question-1',
      status: 'answered',
      expected_source_hit: true,
      first_expected_hit_rank: 2,
      citation_marker_count: 1,
      invalid_citation_marker_count: 0,
      distinct_cited_source_count: 2,
      retrieved_context_count: 2,
      latency_ms: 12,
    });
  });

  test('counts missing expected sources and invalid citation markers', () => {
    const metrics = computeRetrievalEvalQuestionMetrics(questionExecution(domainAnswer({
      citations: [citation('neutral:1', `gs://neutral/objects/sha256/cc/${'c'.repeat(64)}.txt`)],
      answer: 'Neutral result [neutral:1] plus absent [neutral:9].',
    })));

    expect(metrics.expected_source_hit).toBeFalse();
    expect(metrics.first_expected_hit_rank).toBeNull();
    expect(metrics.citation_marker_count).toBe(2);
    expect(metrics.invalid_citation_marker_count).toBe(1);
  });

  test('treats non-answered status as a miss even when an expected source is cited', () => {
    const metrics = computeRetrievalEvalQuestionMetrics(questionExecution(domainAnswer({
      status: 'insufficient_context',
      citations: [citation('neutral:1', `gs://neutral/objects/sha256/aa/${'a'.repeat(64)}.txt`)],
    })));

    expect(metrics.status).toBe('insufficient_context');
    expect(metrics.expected_source_hit).toBeFalse();
    expect(metrics.first_expected_hit_rank).toBeNull();
  });

  test('extracts individual citation ids from grouped markers', () => {
    expect(extractCitationMarkers(
      'Grouped [neutral corpus:1, neutral corpus:2] and solo [other:3].',
    )).toEqual(['neutral corpus:1', 'neutral corpus:2', 'other:3']);
  });
});

describe('retrieval eval receipt and gate', () => {
  test('summarizes metrics and evaluates every configured threshold', () => {
    const source = `${JSON.stringify(validEvalSet())}\n`;
    const receipt = createRetrievalEvalReceipt(
      { evalSet: validEvalSet(), bytes: new TextEncoder().encode(source) },
      {
        questions: [
          questionExecution(domainAnswer()),
          {
            ...questionExecution(domainAnswer({
              answer: 'Neutral answer [neutral:9].',
              citations: [citation(
                'neutral:1',
                `gs://neutral/objects/sha256/bb/${'b'.repeat(64)}.txt`,
              )],
            })),
            question: {
              ...validEvalSet().questions[0]!,
              id: 'neutral-question-2',
              expectedObjectIds: [OBJECT_ID_A],
            },
          },
        ],
      },
      'https://worker.test/runtime',
    );

    expect(receipt.questions.map((question) => question.id)).toEqual([
      'neutral-question-1',
      'neutral-question-2',
    ]);
    expect(receipt.summary).toEqual({
      total: 2,
      expected_source_hits: 1,
      recall: 0.5,
      miss_question_ids: ['neutral-question-2'],
      miss_rate: 0.5,
      citation_marker_count: 2,
      invalid_citation_marker_count: 1,
      invalid_citation_rate: 0.5,
      latency_ms: { min: 12, mean: 12, max: 12 },
    });
    expect(receipt.verdict).toEqual({
      min_recall: { threshold: 0.8, actual: 0.5, passed: false },
      max_invalid_citation_rate: { threshold: 0.05, actual: 0.5, passed: false },
      max_miss_rate: { threshold: 0.2, actual: 0.5, passed: false },
      passed: false,
    });
    expect(receipt.worker).toBe('https://worker.test');
  });

  test('maps passing and failing threshold verdicts to process exit behavior', () => {
    expect(retrievalEvalExitCode(receiptFor(true))).toBe(0);
    expect(retrievalEvalExitCode(receiptFor(false))).toBe(1);
    expect(serializeRetrievalEvalReceipt(receiptFor(false))).toContain('"passed": false');
  });

  test('fails closed before writing when a bearer token reaches receipt fields', async () => {
    const fixture = await createCliFixture();
    const token = 'synthetic-secret-token';
    const receipt = receiptFor(true, domainAnswer({ status: token }));

    await expect(writeRetrievalEvalReceipt(fixture.receiptPath, receipt, [token]))
      .rejects.toThrow('Refusing to write retrieval eval receipt because it contains a bearer token.');
    await expect(readFile(fixture.receiptPath, 'utf8')).rejects.toThrow();
  });

  test('writes deterministic content-free receipts with only allowed question fields', async () => {
    const fixture = await createCliFixture();
    const privateQuestion = 'PRIVATE_QUESTION_TEXT_SENTINEL';
    const privateAnswer = 'PRIVATE_ANSWER_TEXT_SENTINEL';
    const privateDisplayName = 'PRIVATE_DISPLAY_NAME_SENTINEL';
    const bearerToken = 'PRIVATE_BEARER_TOKEN_SENTINEL';
    const evalSet = validEvalSet();
    evalSet.questions[0]!.question = privateQuestion;
    const answer = domainAnswer({
      answer: privateAnswer,
      citations: [{
        ...citation('neutral:1', `gs://neutral/objects/sha256/aa/${'a'.repeat(64)}.txt`),
        source_display_name: privateDisplayName,
      }],
    });
    const build = () => createRetrievalEvalReceipt(
      { evalSet, bytes: new TextEncoder().encode(`${JSON.stringify(evalSet)}\n`) },
      { questions: [{ question: evalSet.questions[0]!, result: { kind: 'response', latency_ms: 23, answer: answer as never } }] },
      'https://worker.test/runtime',
    );

    const first = build();
    await writeRetrievalEvalReceipt(fixture.receiptPath, first, [bearerToken]);
    await writeRetrievalEvalReceipt(fixture.secondReceiptPath, build(), [bearerToken]);
    const firstBytes = await readFile(fixture.receiptPath, 'utf8');
    const secondBytes = await readFile(fixture.secondReceiptPath, 'utf8');

    expect(secondBytes).toBe(firstBytes);
    expect(firstBytes).not.toContain(privateQuestion);
    expect(firstBytes).not.toContain(privateAnswer);
    expect(firstBytes).not.toContain(privateDisplayName);
    expect(firstBytes).not.toContain(bearerToken);
    expect(Object.keys(first.questions[0]!)).toEqual([
      'id',
      'status',
      'expected_source_hit',
      'first_expected_hit_rank',
      'citation_marker_count',
      'invalid_citation_marker_count',
      'distinct_cited_source_count',
      'retrieved_context_count',
      'latency_ms',
    ]);
  });
});

function validEvalSet(): RetrievalEvalSet {
  return {
    schemaVersion: 1,
    domainId: 'neutral-history',
    thresholds: {
      minRecall: 0.8,
      maxInvalidCitationRate: 0.05,
      maxMissRate: 0.2,
    },
    questions: [{
      id: 'neutral-question-1',
      question: 'Which neutral source records the event?',
      expectedObjectIds: [OBJECT_ID_A],
    }],
  };
}

function questionExecution(answer: Record<string, unknown>): RetrievalEvalQuestionExecution {
  return {
    question: validEvalSet().questions[0]!,
    result: {
      kind: 'response',
      latency_ms: 12,
      answer: answer as never,
    },
  };
}

function domainAnswer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'domain_answer',
    status: 'answered',
    answer: 'Neutral answer [neutral:1].',
    citations: [citation(
      'neutral:1',
      `gs://neutral/objects/sha256/aa/${'a'.repeat(64)}.txt`,
    )],
    retrieved_context_count: 1,
    ...overrides,
  };
}

function citation(citationId: string, sourceUri: string): Record<string, unknown> {
  return {
    citation_id: citationId,
    corpus_id: 'neutral-corpus',
    source_display_name: 'Neutral Source',
    source_uri: sourceUri,
    score: 0.9,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface CliFixture {
  questionsPath: string;
  receiptPath: string;
  secondReceiptPath: string;
}

async function createCliFixture(): Promise<CliFixture> {
  const root = await mkdtemp(join(tmpdir(), 'expert-agents-retrieval-eval-test-'));
  temporaryRoots.push(root);
  const questionsPath = join(root, 'eval-questions.json');
  await writeFile(questionsPath, `${JSON.stringify(validEvalSet(), null, 2)}\n`);
  return {
    questionsPath,
    receiptPath: join(root, 'receipts', 'retrieval-eval.json'),
    secondReceiptPath: join(root, 'receipts', 'retrieval-eval-second.json'),
  };
}

function cliArgs(fixture: CliFixture): string[] {
  return [
    '--worker', 'https://worker.test/runtime',
    '--questions', fixture.questionsPath,
    '--receipt', fixture.receiptPath,
  ];
}

function receiptFor(hit: boolean, override?: Record<string, unknown>) {
  const evalSet = validEvalSet();
  const answer = override ?? domainAnswer({
    citations: [citation(
      'neutral:1',
      hit
        ? `gs://neutral/objects/sha256/aa/${'a'.repeat(64)}.txt`
        : `gs://neutral/objects/sha256/cc/${'c'.repeat(64)}.txt`,
    )],
  });
  return createRetrievalEvalReceipt(
    { evalSet, bytes: new TextEncoder().encode(`${JSON.stringify(evalSet)}\n`) },
    { questions: [questionExecution(answer)] },
    'https://worker.test/runtime',
  );
}
