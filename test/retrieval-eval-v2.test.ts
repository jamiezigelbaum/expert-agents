import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeRetrievalEvalQuestionMetricsV2,
  createRetrievalEvalReceiptV2,
  evidenceSourceMatches,
  executeRetrievalEvalV2,
  isAbstentionAnswer,
  nearestRankPercentile,
  parseRetrievalEvalSet,
  passageContainsQuote,
  retrievalEvalExitCode,
  runRetrievalEvalCli,
  type RetrievalEvalFetch,
  type RetrievalEvalQuestionExecutionV2,
  type RetrievalEvalQuestionV2,
  type RetrievalEvalReceiptV2,
  type RetrievalEvalSetV2,
} from '../scripts/retrieval-eval.ts';

const HEX_A = 'a'.repeat(64);
const HEX_C = 'c'.repeat(64);
const OBJECT_ID_A = `sha256:${HEX_A}`;
const URI_A = `gs://neutral/objects/sha256/aa/${HEX_A}.pdf`;
const URI_C = `gs://neutral/objects/sha256/cc/${HEX_C}.txt`;
const SPLIT_PATH = 'v2/book-imports/neutral/plain-ledger.pdf';
const URI_SPLIT_PART = `gs://neutral-bucket/v2/book-imports/neutral/plain-ledger--part2of3.pdf`;
const QUOTE_A = 'the river crossing was recorded in the harbor ledger before the winter storms';
const QUOTE_SPLIT = 'every shipment of grain was weighed twice at the eastern gate';
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('schema 2 validation', () => {
  test('accepts a valid schema-2 set and fills the default mode and thresholds', () => {
    const value = validSetV2() as unknown as Record<string, unknown>;
    delete value.mode;
    delete value.thresholds;

    const parsed = parseRetrievalEvalSet(JSON.stringify(value)) as RetrievalEvalSetV2;
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.mode).toBe('both');
    expect(parsed.thresholds).toEqual({});
    expect(parsed.questions.map((question) => question.category)).toEqual(['quote', 'cross_book', 'unanswerable']);
    expect(parsed.questions[0]!.evidence![0]).toEqual({ objectId: OBJECT_ID_A, quote: QUOTE_A, pages: [12, 13] });
  });

  test('round-trips a full set with every optional field', () => {
    const value = validSetV2();
    expect(parseRetrievalEvalSet(JSON.stringify(value))).toEqual(value);
  });

  const invalidCases: Array<[string, (set: Record<string, any>) => void, string]> = [
    ['unknown schema version', (set) => { set.schemaVersion = 3; }, '$.schemaVersion: expected 1 or 2.'],
    ['unknown mode', (set) => { set.mode = 'prose'; }, '$.mode: expected passages, answer, or both.'],
    ['unexpected root field', (set) => { set.extra = true; }, 'at $: unexpected field.'],
    ['unknown category', (set) => { set.questions[0].category = 'trivia'; }, '$.questions[0].category: expected a known category.'],
    ['non-boolean answerable', (set) => { set.questions[0].answerable = 'yes'; }, '$.questions[0].answerable: expected a boolean.'],
    ['answerable without evidence', (set) => { delete set.questions[0].evidence; }, '$.questions[0].evidence: expected at least one evidence item'],
    ['answerable with empty evidence', (set) => { set.questions[0].evidence = []; }, '$.questions[0].evidence: expected at least one evidence item'],
    ['unanswerable with evidence', (set) => { set.questions[2].evidence = set.questions[0].evidence; }, '$.questions[2].evidence: expected no evidence'],
    ['evidence without a source', (set) => { delete set.questions[0].evidence[0].objectId; }, '$.questions[0].evidence[0]: expected an objectId or a sourcePath.'],
    ['malformed object id', (set) => { set.questions[0].evidence[0].objectId = 'sha256:nope'; }, '$.questions[0].evidence[0].objectId: expected a lowercase sha256 id.'],
    ['source path with trailing slash', (set) => { set.questions[1].evidence[0].sourcePath = 'v2/book-imports/'; }, '$.questions[1].evidence[0].sourcePath: expected an object path'],
    ['quote too short', (set) => { set.questions[0].evidence[0].quote = 'five words are too short'; }, '$.questions[0].evidence[0].quote: expected 6 through 40 words.'],
    ['quote too long', (set) => { set.questions[0].evidence[0].quote = Array.from({ length: 41 }, (_, i) => `word${i}`).join(' '); }, '$.questions[0].evidence[0].quote: expected 6 through 40 words.'],
    ['reversed pages', (set) => { set.questions[0].evidence[0].pages = [13, 12]; }, '$.questions[0].evidence[0].pages: expected [start, end]'],
    ['zero page', (set) => { set.questions[0].evidence[0].pages = [0, 1]; }, '$.questions[0].evidence[0].pages: expected [start, end]'],
    ['unexpected evidence field', (set) => { set.questions[0].evidence[0].page = 4; }, '$.questions[0].evidence[0]: unexpected field.'],
    ['empty reference answer', (set) => { set.questions[0].answer = ' '; }, '$.questions[0].answer: expected a non-empty string.'],
    ['unsupported recall cut-off', (set) => { set.thresholds.minPassageRecallAt = { k: 4, min: 0.5 }; }, '$.thresholds.minPassageRecallAt.k: expected one of 1, 3, 5, 10, 20.'],
    ['out-of-range threshold', (set) => { set.thresholds.minAbstentionRate = 2; }, '$.thresholds.minAbstentionRate: expected a number from 0 through 1.'],
    ['answer threshold in passages mode', (set) => { set.mode = 'passages'; }, '$.thresholds.minRecall: requires answer mode.'],
    ['passage threshold in answer mode', (set) => { set.mode = 'answer'; }, '$.thresholds.minPassageRecallAt: requires passages mode.'],
    ['abstention threshold without unanswerable questions', (set) => { set.questions.pop(); }, '$.thresholds.minAbstentionRate: requires at least one unanswerable question.'],
  ];
  for (const [name, mutate, message] of invalidCases) {
    test(`rejects ${name} with a content-free schema path`, () => {
      const value = validSetV2() as unknown as Record<string, any>;
      if (name.includes('answer threshold in passages')) {
        delete value.thresholds.minAbstentionRate;
        delete value.thresholds.maxInvalidCitationRate;
        delete value.thresholds.maxMissRate;
      }
      if (name.includes('passage threshold in answer')) value.thresholds = { minPassageRecallAt: { k: 5, min: 0.5 } };
      mutate(value);
      let thrown: unknown;
      try {
        parseRetrievalEvalSet(JSON.stringify(value));
      } catch (error) {
        thrown = error;
      }
      expect(String(thrown)).toContain(message);
      expect(String(thrown)).not.toContain('river crossing');
      expect(String(thrown)).not.toContain('plain-ledger');
    });
  }
});

describe('passage and source matching', () => {
  test('matches a quote verbatim, through Markdown, punctuation, case and accents', () => {
    expect(passageContainsQuote(QUOTE_A, `Preface. ${QUOTE_A}. Afterword.`)).toBeTrue();
    expect(passageContainsQuote(
      'The café owner said: "never again," and closed the shutters',
      '## Notes\n**the  cafe owner said** — never again — and *closed* the shutters.',
    )).toBeTrue();
  });

  test('tolerates parser noise up to the coverage rule and rejoins line-break hyphenation', () => {
    // One substituted word, one dropped word and an inserted footnote marker.
    expect(passageContainsQuote(QUOTE_A, 'the river crosing was recorded 17 in harbor ledger before the winter storms')).toBeTrue();
    expect(passageContainsQuote(QUOTE_A, 'the river cross-\ning was recorded in the harbor ledger before the winter storms')).toBeTrue();
    // Half the words changed is below 80% coverage.
    expect(passageContainsQuote(QUOTE_A, 'a lake passage was noted in the port book after the summer storms')).toBeFalse();
  });

  test('does not assemble a match from words scattered across a long passage', () => {
    const filler = Array.from({ length: 30 }, (_, index) => `filler${index}`).join(' ');
    const scattered = QUOTE_A.split(' ').map((word) => `${word} ${filler}`).join(' ');
    expect(passageContainsQuote(QUOTE_A, scattered)).toBeFalse();
  });

  test('matches sources by canonical hash, by source-path suffix, and through split parts', () => {
    expect(evidenceSourceMatches({ objectId: OBJECT_ID_A, quote: QUOTE_A }, URI_A)).toBeTrue();
    expect(evidenceSourceMatches({ objectId: OBJECT_ID_A, quote: QUOTE_A }, `gs://neutral/${HEX_A}--part1of2.pdf`)).toBeTrue();
    expect(evidenceSourceMatches({ objectId: OBJECT_ID_A, quote: QUOTE_A }, URI_C)).toBeFalse();
    expect(evidenceSourceMatches({ sourcePath: SPLIT_PATH, quote: QUOTE_SPLIT }, URI_SPLIT_PART)).toBeTrue();
    expect(evidenceSourceMatches({ sourcePath: SPLIT_PATH, quote: QUOTE_SPLIT }, `gs://neutral-bucket/${SPLIT_PATH}`)).toBeTrue();
    // A suffix must start at a path segment boundary.
    expect(evidenceSourceMatches({ sourcePath: 'ledger.pdf', quote: QUOTE_SPLIT }, `gs://neutral-bucket/${SPLIT_PATH}`)).toBeFalse();
  });
});

describe('schema 2 execution and metrics', () => {
  test('sends a passages request and an answer request per question in both mode', async () => {
    const bodies: unknown[] = [];
    const fetchImpl: RetrievalEvalFetch = async (url, init = {}) => {
      if (url.endsWith('/v1/health')) return jsonResponse({ healthy: true });
      const body = JSON.parse(String(init.body));
      if (body.tool === 'domain_library') return jsonResponse({ error: { code: 'page_library_not_configured' } }, 404);
      bodies.push(body);
      return jsonResponse(body.params.output === 'passages' ? passagesBody() : answerBody());
    };
    const set = validSetV2();
    set.questions = [set.questions[1]!];
    const execution = await executeRetrievalEvalV2(set, {
      worker: { baseUrl: 'https://worker.test' },
      fetchImpl,
      nowMs: clock([0, 40, 100, 350]),
    });

    expect(bodies).toEqual([
      { tool: 'domain_ask', params: { domain_id: 'neutral-history', question: set.questions[0]!.question, output: 'passages', corpora: ['neutral-primary'] } },
      { tool: 'domain_ask', params: { domain_id: 'neutral-history', question: set.questions[0]!.question, corpora: ['neutral-primary'] } },
    ]);
    expect(execution.questions[0]!.passages!.latency_ms).toBe(40);
    expect(execution.questions[0]!.answer!.latency_ms).toBe(250);
  });

  test('passages mode sends no answer request', async () => {
    let answerRequests = 0;
    const fetchImpl: RetrievalEvalFetch = async (url, init = {}) => {
      if (url.endsWith('/v1/health')) return jsonResponse({ healthy: true });
      if (JSON.parse(String(init.body)).tool === 'domain_library') return jsonResponse({ error: { code: 'page_library_not_configured' } }, 404);
      if (JSON.parse(String(init.body)).params.output !== 'passages') answerRequests += 1;
      return jsonResponse(passagesBody());
    };
    const execution = await executeRetrievalEvalV2(validSetV2(), {
      worker: { baseUrl: 'https://worker.test' },
      fetchImpl,
      mode: 'passages',
      nowMs: () => 0,
    });
    expect(answerRequests).toBe(0);
    expect(execution.mode).toBe('passages');
    expect(execution.questions.every((question) => question.answer === undefined)).toBeTrue();
  });

  test('a page-library domain is read through domain_library search, and only in passages mode', async () => {
    const bodies: Array<{ tool: string; params: Record<string, unknown> }> = [];
    const original = `gs://neutral/v2/book-imports/neutral-history/originals/${OBJECT_ID_A.slice('sha256:'.length)}.pdf`;
    const fetchImpl: RetrievalEvalFetch = async (url, init = {}) => {
      if (url.endsWith('/v1/health')) return jsonResponse({ healthy: true });
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      if (body.params.action === 'catalog') return jsonResponse({ books: [], total: 0, complete: true });
      return jsonResponse({ results: [{ slug: 'books/neutral-book/p0012', cite: 'A. Author, Neutral Book, p.12', source_uri: original, text: `Before it: ${QUOTE_A} After it.` }] });
    };
    const set = validSetV2();
    set.questions = [questionA()];
    set.thresholds = { minPassageRecallAt: { k: 1, min: 1 } };
    await expect(executeRetrievalEvalV2(set, { worker: { baseUrl: 'https://worker.test' }, fetchImpl, mode: 'both', nowMs: () => 0 }))
      .rejects.toThrow('passages mode');
    bodies.length = 0;
    const execution = await executeRetrievalEvalV2(set, { worker: { baseUrl: 'https://worker.test' }, fetchImpl, mode: 'passages', nowMs: () => 0 });
    expect(bodies.map((body) => body.tool)).toEqual(['domain_library', 'domain_library']);
    expect(bodies[1]!.params).toMatchObject({ action: 'search', query: questionA().question });
    const metrics = computeRetrievalEvalQuestionMetricsV2(execution.questions[0]!);
    expect(metrics.passages).toMatchObject({ first_object_hit_rank: 1, first_passage_hit_rank: 1 });
  });

  test('computes object and passage hits at each cut-off with first-hit ranks', () => {
    const passages = [
      passage(URI_C, 'unrelated neutral text about orchards'),
      passage(URI_A, 'the same book but a different page about bridges and tolls entirely'),
      passage(URI_C, 'more unrelated text'),
      passage(URI_A, `As the chronicle notes, ${QUOTE_A}.`),
    ];
    const metrics = computeRetrievalEvalQuestionMetricsV2(passagesExecution(questionA(), passages));

    expect(metrics.passages).toMatchObject({
      status: 'retrieved',
      passage_count: 4,
      distinct_source_count: 2,
      evidence_count: 1,
      evidence_found_count: 1,
      first_object_hit_rank: 2,
      first_passage_hit_rank: 4,
      object_hit_at: { at_1: false, at_3: true, at_5: true, at_10: true, at_20: true },
      passage_hit_at: { at_1: false, at_3: false, at_5: true, at_10: true, at_20: true },
    });
  });

  test('a sourcePath evidence item matches a split-part passage, and a source hit without the quote is not a passage hit', () => {
    const question = validSetV2().questions[1]!;
    const hit = computeRetrievalEvalQuestionMetricsV2(passagesExecution(question, [
      passage(URI_SPLIT_PART, `Customs records: every shipment of grain was weighed twice at the eastern gate.`),
    ]));
    expect(hit.passages!.first_passage_hit_rank).toBe(1);

    const objectOnly = computeRetrievalEvalQuestionMetricsV2(passagesExecution(question, [
      passage(URI_SPLIT_PART, 'A chapter about something else entirely, with no grain or gates.'),
    ]));
    expect(objectOnly.passages!.first_object_hit_rank).toBe(1);
    expect(objectOnly.passages!.first_passage_hit_rank).toBeNull();
    expect(objectOnly.passages!.passage_hit_at!.at_20).toBeFalse();
  });

  test('records abstention for unanswerable questions and false abstention for answerable ones', () => {
    const unanswerable = validSetV2().questions[2]!;
    expect(isAbstentionAnswer('The library does not contain any record of that treaty.')).toBeTrue();
    expect(isAbstentionAnswer("The retrieved passages don't mention a second voyage.")).toBeTrue();
    expect(isAbstentionAnswer('The treaty was signed in spring [neutral-primary:1].')).toBeFalse();

    const abstained = computeRetrievalEvalQuestionMetricsV2(answerExecution(unanswerable,
      answerBody({ answer: 'This is not in the library; the sources cover only the harbor.' })));
    expect(abstained.answer).toMatchObject({ abstained: true, expected_source_hit: null });

    const insufficient = computeRetrievalEvalQuestionMetricsV2(answerExecution(unanswerable,
      answerBody({ status: 'insufficient_context', answer: 'Anything.' })));
    expect(insufficient.answer!.abstained).toBeTrue();

    const falseAnswer = computeRetrievalEvalQuestionMetricsV2(answerExecution(unanswerable,
      answerBody({ answer: 'The treaty was signed in spring [neutral-primary:1].' })));
    expect(falseAnswer.answer!.abstained).toBeFalse();

    const falseAbstention = computeRetrievalEvalQuestionMetricsV2(answerExecution(questionA(),
      answerBody({ answer: 'I could not find this in the provided passages.' })));
    expect(falseAbstention.answer).toMatchObject({ abstained: true, expected_source_hit: true });
  });

  test('nearest-rank percentiles', () => {
    const values = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
    expect(nearestRankPercentile(values, 50)).toBe(5);
    expect(nearestRankPercentile(values, 95)).toBe(10);
    expect(nearestRankPercentile([42], 95)).toBe(42);
    expect(nearestRankPercentile([1, 2, 3, 4], 50)).toBe(2);
  });
});

describe('schema 2 receipt', () => {
  test('summarizes overall and per category, aggregates stage timings, and evaluates thresholds', () => {
    const set = validSetV2();
    const [quoteQuestion, crossBook, unanswerable] = set.questions as [RetrievalEvalQuestionV2, RetrievalEvalQuestionV2, RetrievalEvalQuestionV2];
    const receipt = createRetrievalEvalReceiptV2(
      { evalSet: set, bytes: new TextEncoder().encode(JSON.stringify(set)) },
      {
        mode: 'both',
        questions: [
          {
            question: quoteQuestion,
            passages: passagesResponse([passage(URI_A, QUOTE_A)], { retrieve_ms: 100, total_ms: 300 }, 300),
            answer: answerResponse(answerBody(), { synthesize_ms: 900, total_ms: 1200 }, 1200),
          },
          {
            question: crossBook,
            passages: passagesResponse([passage(URI_C, 'nothing relevant here at all')], { retrieve_ms: 300, total_ms: 500 }, 500),
            answer: answerResponse(answerBody({ answer: 'Unrelated [neutral-primary:9].', citations: [citation('neutral-primary:1', URI_C)] }), { synthesize_ms: 700, total_ms: 1000 }, 1000),
          },
          {
            question: unanswerable,
            passages: passagesResponse([passage(URI_C, 'nothing relevant here at all')], { retrieve_ms: 200, total_ms: 400 }, 400),
            answer: answerResponse(answerBody({ answer: 'The library does not contain that.' }), { synthesize_ms: 800, total_ms: 1100 }, 1100),
          },
        ],
      },
      'https://worker.test/runtime',
    );

    expect(receipt.questions.map((question) => question.id)).toEqual(['neutral-v2-1', 'neutral-v2-2', 'neutral-v2-3']);
    const { overall, by_category: byCategory } = receipt.summary;
    expect(overall).toMatchObject({ total: 3, answerable: 2, unanswerable: 1 });
    expect(overall.passages).toMatchObject({
      run: 3,
      errors: 0,
      answerable: 2,
      passage_recall_at: { at_1: 0.5, at_20: 0.5 },
      object_recall_at: { at_1: 0.5 },
      passage_mrr: 0.5,
      passage_miss_question_ids: ['neutral-v2-2'],
      latency_ms: { count: 3, min: 300, mean: 400, p50: 400, p95: 500, max: 500 },
      stage_timings_ms: {
        retrieve_ms: { count: 3, p50: 200, p95: 300 },
        total_ms: { count: 3, p50: 400, p95: 500 },
      },
    });
    expect(overall.answer).toMatchObject({
      run: 3,
      expected_source_hits: 1,
      recall: 0.5,
      miss_question_ids: ['neutral-v2-2'],
      miss_rate: 0.5,
      citation_marker_count: 2,
      invalid_citation_marker_count: 1,
      invalid_citation_rate: 0.5,
      abstentions: 1,
      abstention_rate: 1,
      false_answers: 0,
      false_answer_rate: 0,
      false_abstention_rate: 0,
      stage_timings_ms: { synthesize_ms: { count: 3, p50: 800, p95: 900 } },
    });
    expect(Object.keys(byCategory)).toEqual(['quote', 'cross_book', 'unanswerable']);
    expect(byCategory.quote!.passages!.passage_recall_at.at_1).toBe(1);
    expect(byCategory.cross_book!.answer!.recall).toBe(0);
    expect(byCategory.unanswerable!.passages!.passage_recall_at.at_1).toBeNull();
    expect(byCategory.unanswerable!.answer!.abstention_rate).toBe(1);
    expect(receipt.verdict).toEqual({
      min_recall: { threshold: 0.5, actual: 0.5, passed: true },
      max_invalid_citation_rate: { threshold: 0.1, actual: 0.5, passed: false },
      max_miss_rate: { threshold: 0.5, actual: 0.5, passed: true },
      min_passage_recall_at: { k: 5, threshold: 0.5, actual: 0.5, passed: true },
      min_abstention_rate: { threshold: 0.9, actual: 1, passed: true },
      skipped: [],
      passed: false,
    });
    expect(receipt.passage_match_rule).toBe('ordered-word-coverage-0.8-window-v1');
    expect(receipt.worker).toBe('https://worker.test');
  });

  test('writes a deterministic receipt free of question text, quotes, answers, paths and URIs', async () => {
    const fixture = await createCliFixture(validSetV2());
    const passageText = `PRIVATE_PASSAGE_TEXT_SENTINEL ${QUOTE_A}`;
    const answerText = 'PRIVATE_ANSWER_TEXT_SENTINEL [neutral-primary:1].';
    const token = 'PRIVATE_BEARER_TOKEN_SENTINEL';
    const fetchImpl: RetrievalEvalFetch = async (url, init = {}) => {
      if (url.endsWith('/v1/health')) return jsonResponse({ healthy: true });
      return JSON.parse(String(init.body)).params.output === 'passages'
        ? jsonResponse(passagesBody({ passages: [passage(URI_A, passageText), passage(URI_SPLIT_PART, QUOTE_SPLIT)] }))
        : jsonResponse(answerBody({ answer: answerText, citations: [citation('neutral-primary:1', URI_A)] }));
    };
    const run = (receiptPath: string) => runRetrievalEvalCli(
      ['--worker', 'https://worker.test/runtime', '--questions', fixture.questionsPath, '--receipt', receiptPath],
      { fetchImpl, env: { EXPERT_AGENTS_PARITY_CANDIDATE_TOKEN: token }, nowMs: clock(Array.from({ length: 12 }, (_, i) => i * 10)) },
    );

    const receipt = await run(fixture.receiptPath) as RetrievalEvalReceiptV2;
    await run(fixture.secondReceiptPath);
    const bytes = await readFile(fixture.receiptPath, 'utf8');

    expect(await readFile(fixture.secondReceiptPath, 'utf8')).toBe(bytes);
    expect(receipt.schemaVersion).toBe(2);
    expect(receipt.summary.overall.passages!.passage_recall_at.at_5).toBe(1);
    expect(retrievalEvalExitCode(receipt)).toBe(1);
    const set = validSetV2();
    for (const forbidden of [
      ...set.questions.map((question) => question.question),
      QUOTE_A, QUOTE_SPLIT, SPLIT_PATH, 'plain-ledger', URI_A, URI_SPLIT_PART, HEX_A,
      'PRIVATE_PASSAGE_TEXT_SENTINEL', 'PRIVATE_ANSWER_TEXT_SENTINEL', token,
      'Neutral reference answer', 'neutral private note', 'gs://',
    ]) {
      expect(bytes).not.toContain(forbidden);
    }
    expect(Object.keys(receipt.questions[0]!)).toEqual(['id', 'category', 'answerable', 'passages', 'answer']);
  });

  test('fails closed when eval content would reach the receipt', async () => {
    const set = validSetV2();
    const fixture = await createCliFixture(set);
    const fetchImpl: RetrievalEvalFetch = async (url, init = {}) => {
      if (url.endsWith('/v1/health')) return jsonResponse({ healthy: true });
      const body = JSON.parse(String(init.body));
      // A worker echoing the question into a verbatim status field.
      return jsonResponse(body.params.output === 'passages'
        ? passagesBody({ status: body.params.question })
        : answerBody());
    };
    await expect(runRetrievalEvalCli(
      ['--worker', 'https://worker.test', '--questions', fixture.questionsPath, '--receipt', fixture.receiptPath],
      { fetchImpl, env: {}, nowMs: () => 0 },
    )).rejects.toThrow('Refusing to write retrieval eval receipt because it contains eval-set content.');
    await expect(readFile(fixture.receiptPath, 'utf8')).rejects.toThrow();
  });

  test('a --mode override runs one mode and skips thresholds that need the other', async () => {
    const fixture = await createCliFixture(validSetV2());
    const fetchImpl: RetrievalEvalFetch = async (url) => (
      url.endsWith('/v1/health') ? jsonResponse({ healthy: true }) : jsonResponse(passagesBody())
    );
    const receipt = await runRetrievalEvalCli(
      ['--worker', 'https://worker.test', '--questions', fixture.questionsPath, '--receipt', fixture.receiptPath, '--mode', 'passages'],
      { fetchImpl, env: {}, nowMs: () => 0 },
    ) as RetrievalEvalReceiptV2;
    expect(receipt.mode).toBe('passages');
    expect(receipt.summary.overall.answer).toBeNull();
    expect(receipt.verdict.skipped).toEqual(['min_recall', 'max_invalid_citation_rate', 'max_miss_rate', 'min_abstention_rate']);
    expect(Object.keys(receipt.verdict)).toEqual(['min_passage_recall_at', 'skipped', 'passed']);
  });

  test('--mode is refused for a schema-1 eval set and must be a known mode', async () => {
    const fixture = await createCliFixture({
      schemaVersion: 1,
      domainId: 'neutral-history',
      thresholds: { minRecall: 0.8, maxInvalidCitationRate: 0.05, maxMissRate: 0.2 },
      questions: [{ id: 'q1', question: 'Which neutral source?', expectedObjectIds: [OBJECT_ID_A] }],
    });
    const args = ['--worker', 'https://worker.test', '--questions', fixture.questionsPath, '--receipt', fixture.receiptPath];
    await expect(runRetrievalEvalCli([...args, '--mode', 'answer'], { env: {} }))
      .rejects.toThrow('--mode requires a schema-2 eval set.');
    await expect(runRetrievalEvalCli([...args, '--mode', 'prose'], { env: {} })).rejects.toThrow('Usage:');
  });
});

function validSetV2(): RetrievalEvalSetV2 {
  return {
    schemaVersion: 2,
    domainId: 'neutral-history',
    thresholds: {
      minRecall: 0.5,
      maxInvalidCitationRate: 0.1,
      maxMissRate: 0.5,
      minPassageRecallAt: { k: 5, min: 0.5 },
      minAbstentionRate: 0.9,
    },
    mode: 'both',
    questions: [
      questionA(),
      {
        id: 'neutral-v2-2',
        question: 'How was grain checked at the neutral eastern gate?',
        category: 'cross_book',
        answerable: true,
        corpora: ['neutral-primary'],
        evidence: [{ sourcePath: SPLIT_PATH, quote: QUOTE_SPLIT, note: 'neutral private note' }],
        answer: 'Neutral reference answer about weighing.',
      },
      {
        id: 'neutral-v2-3',
        question: 'What did the neutral treaty of the northern isles say?',
        category: 'unanswerable',
        answerable: false,
      },
    ],
  };
}

function questionA(): RetrievalEvalQuestionV2 {
  return {
    id: 'neutral-v2-1',
    question: 'When was the neutral river crossing recorded?',
    category: 'quote',
    answerable: true,
    evidence: [{ objectId: OBJECT_ID_A, quote: QUOTE_A, pages: [12, 13] }],
  };
}

function passage(sourceUri: string, text: string): Record<string, unknown> {
  return {
    citation_id: 'neutral-primary:1',
    corpus_id: 'neutral-primary',
    header: '[neutral-primary:1] Neutral Source',
    text,
    source_display_name: 'Neutral Source',
    source_uri: sourceUri,
    score: 0.9,
  };
}

function citation(citationId: string, sourceUri: string): Record<string, unknown> {
  return { citation_id: citationId, corpus_id: 'neutral-primary', source_display_name: 'Neutral Source', source_uri: sourceUri, score: 0.9 };
}

function passagesBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'domain_passages',
    status: 'retrieved',
    passages: [passage(URI_A, QUOTE_A)],
    citations: [citation('neutral-primary:1', URI_A)],
    retrieved_context_count: 1,
    timings: { retrieve_ms: 120, total_ms: 200, 'Not A Safe Key': 5 },
    ...overrides,
  };
}

function answerBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'domain_answer',
    status: 'answered',
    answer: 'Recorded before the storms [neutral-primary:1].',
    citations: [citation('neutral-primary:1', URI_A)],
    retrieved_context_count: 1,
    timings: { synthesize_ms: 800, total_ms: 1000 },
    ...overrides,
  };
}

function passagesResponse(
  passages: Array<Record<string, unknown>>,
  timings: Record<string, number>,
  latency: number,
): RetrievalEvalQuestionExecutionV2['passages'] {
  return {
    kind: 'response',
    latency_ms: latency,
    passages: { kind: 'domain_passages', status: 'retrieved', passages: passages as never, retrieved_context_count: passages.length, timings },
  };
}

function answerResponse(
  body: Record<string, unknown>,
  timings: Record<string, number>,
  latency: number,
): RetrievalEvalQuestionExecutionV2['answer'] {
  return { kind: 'response', latency_ms: latency, answer: body as never, timings };
}

function passagesExecution(
  question: RetrievalEvalQuestionV2,
  passages: Array<Record<string, unknown>>,
): RetrievalEvalQuestionExecutionV2 {
  return { question, passages: passagesResponse(passages, {}, 10) };
}

function answerExecution(question: RetrievalEvalQuestionV2, body: Record<string, unknown>): RetrievalEvalQuestionExecutionV2 {
  return { question, answer: answerResponse(body, {}, 10) };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

async function createCliFixture(set: unknown): Promise<{ questionsPath: string; receiptPath: string; secondReceiptPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'expert-agents-retrieval-eval-v2-test-'));
  temporaryRoots.push(root);
  const questionsPath = join(root, 'eval-questions.json');
  await writeFile(questionsPath, `${JSON.stringify(set, null, 2)}\n`);
  return {
    questionsPath,
    receiptPath: join(root, 'receipts', 'retrieval-eval.json'),
    secondReceiptPath: join(root, 'receipts', 'retrieval-eval-second.json'),
  };
}

function clock(values: number[]): () => number {
  return () => values.shift()!;
}
