import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface RetrievalEvalThresholds {
  minRecall: number;
  maxInvalidCitationRate: number;
  maxMissRate: number;
}

export interface RetrievalEvalQuestion {
  id: string;
  question: string;
  expectedObjectIds: string[];
  corpora?: string[];
}

export interface RetrievalEvalSet {
  schemaVersion: 1;
  domainId: string;
  thresholds: RetrievalEvalThresholds;
  questions: RetrievalEvalQuestion[];
}

export interface LoadedRetrievalEvalSet<T extends AnyRetrievalEvalSet = RetrievalEvalSet> {
  evalSet: T;
  bytes: Uint8Array;
}

export interface RetrievalEvalWorkerTarget {
  baseUrl: string;
  token?: string;
}

export type RetrievalEvalFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface RetrievalEvalCitation {
  citation_id: string;
  source_uri: string;
}

export interface RetrievalEvalDomainAnswer {
  kind: 'domain_answer';
  status: string;
  answer: string;
  citations: RetrievalEvalCitation[];
  retrieved_context_count: number;
}

export interface RetrievalEvalResponseResult {
  kind: 'response';
  latency_ms: number;
  answer: RetrievalEvalDomainAnswer;
}

export interface RetrievalEvalErrorResult {
  kind: 'error';
  error: 'unreachable' | 'invalid_json' | 'http_error' | 'invalid_response';
  latency_ms: number;
  http_status?: number;
  error_code?: string;
}

export type RetrievalEvalQuestionResult = RetrievalEvalResponseResult | RetrievalEvalErrorResult;

export interface RetrievalEvalQuestionExecution {
  question: RetrievalEvalQuestion;
  result: RetrievalEvalQuestionResult;
}

export interface RetrievalEvalExecution {
  questions: RetrievalEvalQuestionExecution[];
}

export interface ExecuteRetrievalEvalOptions {
  worker: RetrievalEvalWorkerTarget;
  fetchImpl?: RetrievalEvalFetch;
  nowMs?: () => number;
}

export interface RetrievalEvalQuestionMetrics {
  id: string;
  status: string | null;
  expected_source_hit: boolean;
  first_expected_hit_rank: number | null;
  citation_marker_count: number;
  invalid_citation_marker_count: number;
  distinct_cited_source_count: number;
  retrieved_context_count: number;
  latency_ms: number;
}

export interface RetrievalEvalThresholdVerdict {
  threshold: number;
  actual: number;
  passed: boolean;
}

export interface RetrievalEvalReceipt {
  schemaVersion: 1;
  eval_set: {
    sha256: string;
    bytes: number;
  };
  worker: string;
  questions: RetrievalEvalQuestionMetrics[];
  summary: {
    total: number;
    expected_source_hits: number;
    recall: number;
    miss_question_ids: string[];
    miss_rate: number;
    citation_marker_count: number;
    invalid_citation_marker_count: number;
    invalid_citation_rate: number;
    latency_ms: {
      min: number;
      mean: number;
      max: number;
    };
  };
  verdict: {
    min_recall: RetrievalEvalThresholdVerdict;
    max_invalid_citation_rate: RetrievalEvalThresholdVerdict;
    max_miss_rate: RetrievalEvalThresholdVerdict;
    passed: boolean;
  };
}

export interface RunRetrievalEvalOptions extends ExecuteRetrievalEvalOptions {
  questionsPath: string;
  receiptPath: string;
  /** Overrides a schema-2 eval set's mode; refused for schema 1. */
  mode?: RetrievalEvalMode;
}

export interface RetrievalEvalCliDependencies {
  fetchImpl?: RetrievalEvalFetch;
  nowMs?: () => number;
  env?: Record<string, string | undefined>;
}

interface RetrievalEvalCliArguments {
  workerUrl: string;
  questionsPath: string;
  receiptPath: string;
  mode?: RetrievalEvalMode;
}

const SHA256_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CLI_USAGE = `Usage: bun run retrieval:eval -- --worker <base-url> --questions <path> --receipt <path> [--mode passages|answer|both]

--mode applies only to schema-2 eval sets and overrides the file's mode.

An optional bearer token is read only from EXPERT_AGENTS_PARITY_CANDIDATE_TOKEN.`;

export function parseRetrievalEvalSet(text: string): AnyRetrievalEvalSet {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Invalid retrieval eval set: expected valid JSON.');
  }
  return validateRetrievalEvalSet(value);
}

export function validateRetrievalEvalSet(value: unknown): AnyRetrievalEvalSet {
  const evalSet = requireRecord(value, '$');
  if (evalSet.schemaVersion === 2) return validateRetrievalEvalSetV2(evalSet);
  if (evalSet.schemaVersion !== 1) {
    throw new Error('Invalid retrieval eval set at $.schemaVersion: expected 1 or 2.');
  }
  requireExactKeys(evalSet, ['schemaVersion', 'domainId', 'thresholds', 'questions'], '$');

  const thresholdsValue = requireRecord(evalSet.thresholds, '$.thresholds');
  requireExactKeys(
    thresholdsValue,
    ['minRecall', 'maxInvalidCitationRate', 'maxMissRate'],
    '$.thresholds',
  );
  const thresholds: RetrievalEvalThresholds = {
    minRecall: requireRate(thresholdsValue.minRecall, '$.thresholds.minRecall'),
    maxInvalidCitationRate: requireRate(
      thresholdsValue.maxInvalidCitationRate,
      '$.thresholds.maxInvalidCitationRate',
    ),
    maxMissRate: requireRate(thresholdsValue.maxMissRate, '$.thresholds.maxMissRate'),
  };

  if (!Array.isArray(evalSet.questions) || evalSet.questions.length === 0) {
    throw new Error('Invalid retrieval eval set at $.questions: expected a non-empty array.');
  }
  const ids = new Set<string>();
  const questions = evalSet.questions.map((value, index): RetrievalEvalQuestion => {
    const path = `$.questions[${index}]`;
    const question = requireRecord(value, path);
    requireExactKeys(question, ['id', 'question', 'expectedObjectIds'], path, ['corpora']);
    const id = requireNonEmptyString(question.id, `${path}.id`);
    if (ids.has(id)) {
      throw new Error(`Invalid retrieval eval set at ${path}.id: expected a unique id.`);
    }
    ids.add(id);

    const expectedObjectIdsValue = question.expectedObjectIds;
    if (!Array.isArray(expectedObjectIdsValue) || expectedObjectIdsValue.length === 0) {
      throw new Error(
        `Invalid retrieval eval set at ${path}.expectedObjectIds: expected a non-empty array.`,
      );
    }
    const expectedObjectIds = expectedObjectIdsValue.map((objectId, objectIndex) => {
      const objectPath = `${path}.expectedObjectIds[${objectIndex}]`;
      if (typeof objectId !== 'string' || !SHA256_ID_PATTERN.test(objectId)) {
        throw new Error(
          `Invalid retrieval eval set at ${objectPath}: expected a lowercase sha256 id.`,
        );
      }
      if (expectedObjectIdsValue.slice(0, objectIndex).includes(objectId)) {
        throw new Error(`Invalid retrieval eval set at ${objectPath}: expected a unique object id.`);
      }
      return objectId;
    });

    return {
      id,
      question: requireNonEmptyString(question.question, `${path}.question`),
      expectedObjectIds,
      ...(question.corpora === undefined
        ? {}
        : { corpora: requireStringArray(question.corpora, `${path}.corpora`) }),
    };
  });

  return {
    schemaVersion: 1,
    domainId: requireNonEmptyString(evalSet.domainId, '$.domainId'),
    thresholds,
    questions,
  };
}

export async function loadRetrievalEvalSet(path: string): Promise<LoadedRetrievalEvalSet<AnyRetrievalEvalSet>> {
  const bytes = await readFile(path);
  return { evalSet: parseRetrievalEvalSet(bytes.toString('utf8')), bytes };
}

export async function executeRetrievalEval(
  evalSet: RetrievalEvalSet,
  options: ExecuteRetrievalEvalOptions,
): Promise<RetrievalEvalExecution> {
  const worker = normalizeWorkerTarget(options.worker);
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowMs = options.nowMs ?? Date.now;
  await assertWorkerHealthy(worker, fetchImpl);
  if (await readsPageLibrary(evalSet.domainId, worker, fetchImpl)) {
    throw new Error(
      `Retrieval eval: ${evalSet.domainId} reads a page library, which the worker does not answer from. `
      + 'Use a schema-2 eval set in passages mode; answers are evaluated through the agent.',
    );
  }

  const questions: RetrievalEvalQuestionExecution[] = [];
  for (const question of evalSet.questions) {
    questions.push({
      question,
      result: await askRetrievalEvalQuestion(evalSet.domainId, question, worker, fetchImpl, nowMs),
    });
  }
  return { questions };
}

export function computeRetrievalEvalQuestionMetrics(
  execution: RetrievalEvalQuestionExecution,
): RetrievalEvalQuestionMetrics {
  const { question, result } = execution;
  if (result.kind === 'error') {
    return {
      id: question.id,
      status: null,
      expected_source_hit: false,
      first_expected_hit_rank: null,
      citation_marker_count: 0,
      invalid_citation_marker_count: 0,
      distinct_cited_source_count: 0,
      retrieved_context_count: 0,
      latency_ms: result.latency_ms,
    };
  }

  const markers = extractCitationMarkers(result.answer.answer);
  const citationIds = new Set(result.answer.citations.map((citation) => citation.citation_id));
  const expectedHexes = new Set(
    question.expectedObjectIds.map((objectId) => objectId.slice('sha256:'.length)),
  );
  const expectedRank = result.answer.citations.findIndex((citation) => {
    const hash = canonicalObjectHash(citation.source_uri);
    return hash !== undefined && expectedHexes.has(hash);
  });
  const answered = result.answer.status === 'answered';

  return {
    id: question.id,
    status: result.answer.status,
    expected_source_hit: answered && expectedRank >= 0,
    first_expected_hit_rank: answered && expectedRank >= 0 ? expectedRank + 1 : null,
    citation_marker_count: markers.length,
    invalid_citation_marker_count: markers.filter((marker) => !citationIds.has(marker)).length,
    distinct_cited_source_count: new Set(
      result.answer.citations.map((citation) => citation.source_uri),
    ).size,
    retrieved_context_count: result.answer.retrieved_context_count,
    latency_ms: result.latency_ms,
  };
}

export function computeRetrievalEvalMetrics(
  execution: RetrievalEvalExecution,
): RetrievalEvalQuestionMetrics[] {
  return execution.questions.map(computeRetrievalEvalQuestionMetrics);
}

export function extractCitationMarkers(answer: string): string[] {
  const markers: string[] = [];
  for (const match of answer.matchAll(/\[([^\[\]]+)]/g)) {
    for (const member of match[1]!.split(',')) {
      const marker = member.trim();
      if (/^.+:\d+$/.test(marker)) markers.push(marker);
    }
  }
  return markers;
}

export function createRetrievalEvalReceipt(
  loaded: LoadedRetrievalEvalSet,
  execution: RetrievalEvalExecution,
  workerUrl: string,
): RetrievalEvalReceipt {
  const questions = computeRetrievalEvalMetrics(execution)
    .sort((left, right) => compareStrings(left.id, right.id));
  const total = questions.length;
  const expectedSourceHits = questions.filter((question) => question.expected_source_hit).length;
  const misses = questions
    .filter((question) => !question.expected_source_hit)
    .map((question) => question.id);
  const citationMarkerCount = sum(questions.map((question) => question.citation_marker_count));
  const invalidCitationMarkerCount = sum(
    questions.map((question) => question.invalid_citation_marker_count),
  );
  const latencies = questions.map((question) => question.latency_ms);
  const recall = expectedSourceHits / total;
  const missRate = misses.length / total;
  const invalidCitationRate = citationMarkerCount === 0
    ? 0
    : invalidCitationMarkerCount / citationMarkerCount;
  const thresholds = loaded.evalSet.thresholds;
  const minRecall = thresholdVerdict(thresholds.minRecall, recall, 'min');
  const maxInvalidCitationRate = thresholdVerdict(
    thresholds.maxInvalidCitationRate,
    invalidCitationRate,
    'max',
  );
  const maxMissRate = thresholdVerdict(thresholds.maxMissRate, missRate, 'max');

  return {
    schemaVersion: 1,
    eval_set: {
      sha256: sha256(loaded.bytes),
      bytes: loaded.bytes.byteLength,
    },
    worker: endpointOrigin(workerUrl),
    questions,
    summary: {
      total,
      expected_source_hits: expectedSourceHits,
      recall,
      miss_question_ids: misses,
      miss_rate: missRate,
      citation_marker_count: citationMarkerCount,
      invalid_citation_marker_count: invalidCitationMarkerCount,
      invalid_citation_rate: invalidCitationRate,
      latency_ms: {
        min: Math.min(...latencies),
        mean: sum(latencies) / total,
        max: Math.max(...latencies),
      },
    },
    verdict: {
      min_recall: minRecall,
      max_invalid_citation_rate: maxInvalidCitationRate,
      max_miss_rate: maxMissRate,
      passed: minRecall.passed && maxInvalidCitationRate.passed && maxMissRate.passed,
    },
  };
}

export function serializeRetrievalEvalReceipt(receipt: RetrievalEvalReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

export async function writeRetrievalEvalReceipt(
  path: string,
  receipt: RetrievalEvalReceipt,
  forbiddenValues: string[] = [],
): Promise<void> {
  const serialized = serializeRetrievalEvalReceipt(receipt);
  if (forbiddenValues.some((value) => value !== '' && serialized.includes(value))) {
    throw new Error('Refusing to write retrieval eval receipt because it contains a bearer token.');
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialized, 'utf8');
}

export async function runRetrievalEval(options: RunRetrievalEvalOptions): Promise<AnyRetrievalEvalReceipt> {
  const loaded = await loadRetrievalEvalSet(options.questionsPath);
  if (loaded.evalSet.schemaVersion === 2) {
    const evalSet = loaded.evalSet;
    const mode = options.mode ?? evalSet.mode;
    const execution = await executeRetrievalEvalV2(evalSet, { ...options, mode });
    const receipt = createRetrievalEvalReceiptV2(
      { evalSet, bytes: loaded.bytes },
      execution,
      options.worker.baseUrl,
    );
    await writeRetrievalEvalReceiptV2(options.receiptPath, receipt, {
      token: options.worker.token,
      content: retrievalEvalV2ContentValues(evalSet),
    });
    return receipt;
  }
  if (options.mode !== undefined) {
    throw new Error('Invalid retrieval eval arguments: --mode requires a schema-2 eval set.');
  }
  const execution = await executeRetrievalEval(loaded.evalSet, options);
  const receipt = createRetrievalEvalReceipt(
    { evalSet: loaded.evalSet, bytes: loaded.bytes },
    execution,
    options.worker.baseUrl,
  );
  await writeRetrievalEvalReceipt(
    options.receiptPath,
    receipt,
    options.worker.token ? [options.worker.token] : [],
  );
  return receipt;
}

export function parseRetrievalEvalCliArguments(args: string[]): RetrievalEvalCliArguments {
  const values = new Map<string, string>();
  const required = ['--worker', '--questions', '--receipt'];
  const allowed = new Set([...required, '--mode']);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag || !allowed.has(flag)) throw new Error(CLI_USAGE);
    const value = args[index + 1];
    if (!value || value.startsWith('--') || values.has(flag)) throw new Error(CLI_USAGE);
    values.set(flag, value);
  }
  if (required.some((flag) => !values.has(flag))) throw new Error(CLI_USAGE);
  const mode = values.get('--mode');
  if (mode !== undefined && !RETRIEVAL_EVAL_MODES.includes(mode as RetrievalEvalMode)) {
    throw new Error(CLI_USAGE);
  }
  return {
    workerUrl: values.get('--worker')!,
    questionsPath: values.get('--questions')!,
    receiptPath: values.get('--receipt')!,
    ...(mode === undefined ? {} : { mode: mode as RetrievalEvalMode }),
  };
}

export async function runRetrievalEvalCli(
  args: string[],
  dependencies: RetrievalEvalCliDependencies = {},
): Promise<AnyRetrievalEvalReceipt> {
  const parsed = parseRetrievalEvalCliArguments(args);
  const env = dependencies.env ?? process.env;
  const token = env.EXPERT_AGENTS_PARITY_CANDIDATE_TOKEN;
  return runRetrievalEval({
    questionsPath: parsed.questionsPath,
    receiptPath: parsed.receiptPath,
    ...(parsed.mode ? { mode: parsed.mode } : {}),
    worker: {
      baseUrl: parsed.workerUrl,
      ...(token ? { token } : {}),
    },
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
    ...(dependencies.nowMs ? { nowMs: dependencies.nowMs } : {}),
  });
}

export function retrievalEvalExitCode(receipt: AnyRetrievalEvalReceipt): 0 | 1 {
  return receipt.verdict.passed ? 0 : 1;
}

function normalizeWorkerTarget(target: RetrievalEvalWorkerTarget): RetrievalEvalWorkerTarget {
  let parsed: URL;
  try {
    parsed = new URL(target.baseUrl);
  } catch {
    throw new Error('Invalid retrieval eval worker endpoint: expected an absolute HTTP(S) URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid retrieval eval worker endpoint: expected an HTTP(S) URL.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      'Invalid retrieval eval worker endpoint: credentials, query strings, and fragments are not allowed.',
    );
  }
  return {
    baseUrl: target.baseUrl.replace(/\/+$/, ''),
    ...(target.token ? { token: target.token } : {}),
  };
}

async function assertWorkerHealthy(
  worker: RetrievalEvalWorkerTarget,
  fetchImpl: RetrievalEvalFetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(`${worker.baseUrl}/v1/health`, {
      method: 'GET',
      headers: requestHeaders(worker.token),
    });
  } catch {
    throw new Error(`Retrieval eval worker is unreachable at ${new URL(worker.baseUrl).origin}.`);
  }
  if (!response.ok) {
    throw new Error(
      `Retrieval eval worker health check failed with HTTP ${response.status} at ${new URL(worker.baseUrl).origin}.`,
    );
  }
}

async function askRetrievalEvalQuestion(
  domainId: string,
  question: RetrievalEvalQuestion,
  worker: RetrievalEvalWorkerTarget,
  fetchImpl: RetrievalEvalFetch,
  nowMs: () => number,
): Promise<RetrievalEvalQuestionResult> {
  const raw = await postDomainAsk(domainId, question, undefined, worker, fetchImpl, nowMs);
  if (raw.kind === 'error') return raw;
  const answer = parseDomainAnswer(raw.body);
  return answer
    ? { kind: 'response', latency_ms: raw.latency_ms, answer }
    : { kind: 'error', error: 'invalid_response', latency_ms: raw.latency_ms, http_status: raw.http_status };
}

type DomainAskRawResult =
  | { kind: 'body'; latency_ms: number; http_status: number; body: unknown }
  | RetrievalEvalErrorResult;

async function postDomainAsk(
  domainId: string,
  question: { question: string; corpora?: string[] },
  output: 'passages' | undefined,
  worker: RetrievalEvalWorkerTarget,
  fetchImpl: RetrievalEvalFetch,
  nowMs: () => number,
): Promise<DomainAskRawResult> {
  return postWorkerTool('domain_ask', {
    domain_id: domainId,
    question: question.question,
    ...(output === undefined ? {} : { output }),
    ...(question.corpora === undefined ? {} : { corpora: question.corpora }),
  }, worker, fetchImpl, nowMs);
}

async function postWorkerTool(
  tool: string,
  params: Record<string, unknown>,
  worker: RetrievalEvalWorkerTarget,
  fetchImpl: RetrievalEvalFetch,
  nowMs: () => number,
): Promise<DomainAskRawResult> {
  const startedAt = nowMs();
  let response: Response;
  try {
    response = await fetchImpl(`${worker.baseUrl}/v1/domain`, {
      method: 'POST',
      headers: requestHeaders(worker.token, true),
      body: JSON.stringify({ tool, params }),
    });
  } catch {
    return { kind: 'error', error: 'unreachable', latency_ms: elapsedMs(startedAt, nowMs()) };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: 'error', error: 'invalid_json', latency_ms: elapsedMs(startedAt, nowMs()) };
  }
  const latency_ms = elapsedMs(startedAt, nowMs());
  if (!response.ok) {
    const error = asRecord(asRecord(body)?.error);
    return {
      kind: 'error',
      error: 'http_error',
      latency_ms,
      http_status: response.status,
      ...(typeof error?.code === 'string' ? { error_code: error.code } : {}),
    };
  }
  return { kind: 'body', latency_ms, http_status: response.status, body };
}

function parseDomainAnswer(value: unknown): RetrievalEvalDomainAnswer | undefined {
  const body = asRecord(value);
  if (
    body?.kind !== 'domain_answer'
    || typeof body.status !== 'string'
    || typeof body.answer !== 'string'
    || !Array.isArray(body.citations)
    || !Number.isInteger(body.retrieved_context_count)
    || typeof body.retrieved_context_count !== 'number'
    || body.retrieved_context_count < 0
  ) {
    return undefined;
  }

  const citations: RetrievalEvalCitation[] = [];
  for (const value of body.citations) {
    const citation = asRecord(value);
    if (typeof citation?.citation_id !== 'string' || typeof citation.source_uri !== 'string') {
      return undefined;
    }
    citations.push({ citation_id: citation.citation_id, source_uri: citation.source_uri });
  }
  return {
    kind: 'domain_answer',
    status: body.status,
    answer: body.answer,
    citations,
    retrieved_context_count: body.retrieved_context_count,
  };
}

function requestHeaders(token: string | undefined, json = false): HeadersInit {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function elapsedMs(startedAt: number, endedAt: number): number {
  return Math.max(0, Math.round(endedAt - startedAt));
}

function canonicalObjectHash(sourceUri: string): string | undefined {
  return sourceUri.match(/\/([a-f0-9]{64})\.[^/.]+$/)?.[1];
}

function thresholdVerdict(
  threshold: number,
  actual: number,
  direction: 'min' | 'max',
): RetrievalEvalThresholdVerdict {
  return {
    threshold,
    actual,
    passed: direction === 'min' ? actual >= threshold : actual <= threshold,
  };
}

function endpointOrigin(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
    return parsed.origin;
  } catch {
    throw new Error('Invalid retrieval eval worker endpoint: expected an absolute HTTP(S) URL.');
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid retrieval eval set at ${path}: expected an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  required: string[],
  path: string,
  optional: string[] = [],
): void {
  const requiredSet = new Set(required);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`Invalid retrieval eval set at ${path}: expected all required fields.`);
  }
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`Invalid retrieval eval set at ${path}: unexpected field.`);
  }
  if (Object.keys(value).filter((key) => requiredSet.has(key)).length !== required.length) {
    throw new Error(`Invalid retrieval eval set at ${path}: expected all required fields.`);
  }
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid retrieval eval set at ${path}: expected a non-empty string.`);
  }
  return value;
}

function requireRate(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid retrieval eval set at ${path}: expected a number from 0 through 1.`);
  }
  return value;
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid retrieval eval set at ${path}: expected an array of non-empty strings.`);
  }
  return value.map((item, index) => requireNonEmptyString(item, `${path}[${index}]`));
}

// ---------------------------------------------------------------------------
// Schema version 2: passage-level recall, categories, abstention, timings.
// ---------------------------------------------------------------------------

export const RETRIEVAL_EVAL_CATEGORIES = [
  'exact_term',
  'quote',
  'conceptual',
  'multi_hop',
  'cross_book',
  'figure',
  'unanswerable',
] as const;
export type RetrievalEvalCategory = typeof RETRIEVAL_EVAL_CATEGORIES[number];

export const RETRIEVAL_EVAL_MODES = ['passages', 'answer', 'both'] as const;
export type RetrievalEvalMode = typeof RETRIEVAL_EVAL_MODES[number];

/** Every rank cut-off reported for object and passage hits. */
export const RETRIEVAL_EVAL_HIT_KS = [1, 3, 5, 10, 20] as const;
export type RetrievalEvalHitK = typeof RETRIEVAL_EVAL_HIT_KS[number];

/** A passage matches a quote when this share of the quote's words aligns in order. */
export const PASSAGE_QUOTE_MIN_COVERAGE = 0.8;
/** Identifies the matching rule in receipts so runs are compared like for like. */
export const PASSAGE_MATCH_RULE = 'ordered-word-coverage-0.8-window-v1';

const QUOTE_MIN_WORDS = 6;
const QUOTE_MAX_WORDS = 40;
const SAFE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const RECEIPT_CONTENT_MIN_LENGTH = 8;

export interface RetrievalEvalEvidence {
  objectId?: string;
  sourcePath?: string;
  quote: string;
  pages?: [number, number];
  note?: string;
}

export interface RetrievalEvalQuestionV2 {
  id: string;
  question: string;
  category: RetrievalEvalCategory;
  answerable: boolean;
  corpora?: string[];
  evidence?: RetrievalEvalEvidence[];
  answer?: string;
}

export interface RetrievalEvalThresholdsV2 {
  minRecall?: number;
  maxInvalidCitationRate?: number;
  maxMissRate?: number;
  minPassageRecallAt?: { k: RetrievalEvalHitK; min: number };
  minAbstentionRate?: number;
}

export interface RetrievalEvalSetV2 {
  schemaVersion: 2;
  domainId: string;
  thresholds: RetrievalEvalThresholdsV2;
  mode: RetrievalEvalMode;
  questions: RetrievalEvalQuestionV2[];
}

export type AnyRetrievalEvalSet = RetrievalEvalSet | RetrievalEvalSetV2;

export type RetrievalEvalTimings = Record<string, number>;

export interface RetrievalEvalPassage {
  source_uri: string;
  text: string;
}

export interface RetrievalEvalDomainPassages {
  kind: 'domain_passages';
  status: string;
  passages: RetrievalEvalPassage[];
  retrieved_context_count: number;
  timings?: RetrievalEvalTimings;
}

export type RetrievalEvalPassagesResult =
  | { kind: 'response'; latency_ms: number; passages: RetrievalEvalDomainPassages }
  | RetrievalEvalErrorResult;

export type RetrievalEvalAnswerResultV2 =
  | { kind: 'response'; latency_ms: number; answer: RetrievalEvalDomainAnswer; timings?: RetrievalEvalTimings }
  | RetrievalEvalErrorResult;

export interface RetrievalEvalQuestionExecutionV2 {
  question: RetrievalEvalQuestionV2;
  passages?: RetrievalEvalPassagesResult;
  answer?: RetrievalEvalAnswerResultV2;
}

export interface RetrievalEvalExecutionV2 {
  mode: RetrievalEvalMode;
  questions: RetrievalEvalQuestionExecutionV2[];
}

export interface ExecuteRetrievalEvalV2Options extends ExecuteRetrievalEvalOptions {
  mode?: RetrievalEvalMode;
}

export type RetrievalEvalHitTable = Record<`at_${RetrievalEvalHitK}`, boolean>;
export type RetrievalEvalRateTable = Record<`at_${RetrievalEvalHitK}`, number | null>;

export interface RetrievalEvalPassageMetrics {
  status: string | null;
  error: string | null;
  passage_count: number;
  distinct_source_count: number;
  retrieved_context_count: number;
  evidence_count: number;
  evidence_found_count: number;
  object_hit_at: RetrievalEvalHitTable | null;
  passage_hit_at: RetrievalEvalHitTable | null;
  first_object_hit_rank: number | null;
  first_passage_hit_rank: number | null;
  latency_ms: number;
  timings: RetrievalEvalTimings | null;
}

export interface RetrievalEvalAnswerMetricsV2 {
  status: string | null;
  error: string | null;
  expected_source_hit: boolean | null;
  first_expected_hit_rank: number | null;
  citation_marker_count: number;
  invalid_citation_marker_count: number;
  distinct_cited_source_count: number;
  retrieved_context_count: number;
  abstained: boolean;
  latency_ms: number;
  timings: RetrievalEvalTimings | null;
}

export interface RetrievalEvalQuestionMetricsV2 {
  id: string;
  category: RetrievalEvalCategory;
  answerable: boolean;
  passages: RetrievalEvalPassageMetrics | null;
  answer: RetrievalEvalAnswerMetricsV2 | null;
}

export interface RetrievalEvalLatencySummary {
  count: number;
  min: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

export interface RetrievalEvalStageSummary {
  count: number;
  p50: number;
  p95: number;
}

export interface RetrievalEvalPassageSummary {
  run: number;
  errors: number;
  answerable: number;
  object_recall_at: RetrievalEvalRateTable;
  passage_recall_at: RetrievalEvalRateTable;
  object_mrr: number | null;
  passage_mrr: number | null;
  passage_miss_question_ids: string[];
  latency_ms: RetrievalEvalLatencySummary | null;
  stage_timings_ms: Record<string, RetrievalEvalStageSummary>;
}

export interface RetrievalEvalAnswerSummaryV2 {
  run: number;
  errors: number;
  answerable: number;
  unanswerable: number;
  expected_source_hits: number;
  recall: number | null;
  miss_question_ids: string[];
  miss_rate: number | null;
  citation_marker_count: number;
  invalid_citation_marker_count: number;
  invalid_citation_rate: number;
  abstentions: number;
  abstention_rate: number | null;
  false_answers: number;
  false_answer_rate: number | null;
  false_abstentions: number;
  false_abstention_rate: number | null;
  latency_ms: RetrievalEvalLatencySummary | null;
  stage_timings_ms: Record<string, RetrievalEvalStageSummary>;
}

export interface RetrievalEvalSummaryV2 {
  total: number;
  answerable: number;
  unanswerable: number;
  passages: RetrievalEvalPassageSummary | null;
  answer: RetrievalEvalAnswerSummaryV2 | null;
}

export interface RetrievalEvalReceiptV2 {
  schemaVersion: 2;
  eval_set: {
    sha256: string;
    bytes: number;
  };
  worker: string;
  mode: RetrievalEvalMode;
  passage_match_rule: string;
  questions: RetrievalEvalQuestionMetricsV2[];
  summary: {
    overall: RetrievalEvalSummaryV2;
    by_category: Partial<Record<RetrievalEvalCategory, RetrievalEvalSummaryV2>>;
  };
  verdict: {
    min_recall?: RetrievalEvalThresholdVerdict;
    max_invalid_citation_rate?: RetrievalEvalThresholdVerdict;
    max_miss_rate?: RetrievalEvalThresholdVerdict;
    min_passage_recall_at?: RetrievalEvalThresholdVerdict & { k: RetrievalEvalHitK };
    min_abstention_rate?: RetrievalEvalThresholdVerdict;
    skipped: string[];
    passed: boolean;
  };
}

export type AnyRetrievalEvalReceipt = RetrievalEvalReceipt | RetrievalEvalReceiptV2;

/**
 * Answer prose the worker writes when the library does not hold the answer.
 * The worker has no structured abstention status today (it answers with
 * status "answered" and says what is missing), so abstention is also read
 * from these documented phrases. Matching is case-insensitive.
 */
export const ABSTENTION_PATTERNS: readonly RegExp[] = [
  /\bnot\s+(?:in|within)\s+the\s+(?:library|corpus|collection)\b/i,
  /\b(?:library|corpus|collection|sources?|context|passages|excerpts)\s+(?:does|do)\s*(?:not|n['’]t)\s+(?:contain|cover|address|discuss|mention|include|hold|say|provide|answer)\b/i,
  /\b(?:not|never)\s+(?:found|covered|addressed|discussed|mentioned|included|contained)\s+(?:in|by|within)\s+(?:the\s+)?(?:library|corpus|collection|provided|retrieved|available|sources?|context|passages|excerpts)\b/i,
  /\b(?:no|insufficient|not\s+enough)\s+(?:relevant\s+|specific\s+|direct\s+)?(?:information|evidence|context|material|passages?|sources?)\s+(?:in|from|within|on|about|to)\b/i,
  /\b(?:the\s+)?(?:retrieved|provided|available)\s+(?:context|passages|sources|excerpts)\s+(?:is|are)\s+(?:insufficient|silent)\b/i,
  /\b(?:i|we)\s+(?:could|can|was|were|am|are)\s*(?:not|n['’]t|unable\s+to)\s+(?:find|locate|answer|determine)\b/i,
  /\bunable\s+to\s+(?:find|locate|answer|determine)\b/i,
];

export function isAbstentionAnswer(answer: string): boolean {
  return ABSTENTION_PATTERNS.some((pattern) => pattern.test(answer));
}

export function validateRetrievalEvalSetV2(value: unknown): RetrievalEvalSetV2 {
  const evalSet = requireRecord(value, '$');
  requireExactKeys(evalSet, ['schemaVersion', 'domainId', 'questions'], '$', ['thresholds', 'mode']);
  const mode = evalSet.mode === undefined ? 'both' : evalSet.mode;
  if (!RETRIEVAL_EVAL_MODES.includes(mode as RetrievalEvalMode)) {
    throw new Error('Invalid retrieval eval set at $.mode: expected passages, answer, or both.');
  }
  const thresholds = evalSet.thresholds === undefined
    ? {}
    : validateThresholdsV2(evalSet.thresholds);

  if (!Array.isArray(evalSet.questions) || evalSet.questions.length === 0) {
    throw new Error('Invalid retrieval eval set at $.questions: expected a non-empty array.');
  }
  const ids = new Set<string>();
  const questions = evalSet.questions.map((item, index): RetrievalEvalQuestionV2 => {
    const path = `$.questions[${index}]`;
    const question = requireRecord(item, path);
    requireExactKeys(
      question,
      ['id', 'question', 'category', 'answerable'],
      path,
      ['corpora', 'evidence', 'answer'],
    );
    const id = requireNonEmptyString(question.id, `${path}.id`);
    if (ids.has(id)) {
      throw new Error(`Invalid retrieval eval set at ${path}.id: expected a unique id.`);
    }
    ids.add(id);
    if (!RETRIEVAL_EVAL_CATEGORIES.includes(question.category as RetrievalEvalCategory)) {
      throw new Error(`Invalid retrieval eval set at ${path}.category: expected a known category.`);
    }
    if (typeof question.answerable !== 'boolean') {
      throw new Error(`Invalid retrieval eval set at ${path}.answerable: expected a boolean.`);
    }
    const evidence = question.evidence === undefined
      ? []
      : validateEvidenceList(question.evidence, `${path}.evidence`);
    if (question.answerable && evidence.length === 0) {
      throw new Error(
        `Invalid retrieval eval set at ${path}.evidence: expected at least one evidence item for an answerable question.`,
      );
    }
    if (!question.answerable && evidence.length > 0) {
      throw new Error(
        `Invalid retrieval eval set at ${path}.evidence: expected no evidence for an unanswerable question.`,
      );
    }
    return {
      id,
      question: requireNonEmptyString(question.question, `${path}.question`),
      category: question.category as RetrievalEvalCategory,
      answerable: question.answerable,
      ...(question.corpora === undefined
        ? {}
        : { corpora: requireStringArray(question.corpora, `${path}.corpora`) }),
      ...(question.evidence === undefined ? {} : { evidence }),
      ...(question.answer === undefined
        ? {}
        : { answer: requireNonEmptyString(question.answer, `${path}.answer`) }),
    };
  });

  const answerable = questions.filter((question) => question.answerable).length;
  const unanswerable = questions.length - answerable;
  const runsPassages = mode !== 'answer';
  const runsAnswers = mode !== 'passages';
  const requirement = (
    key: keyof RetrievalEvalThresholdsV2,
    needsMode: boolean,
    modeName: string,
    needsQuestions: boolean,
    questionKind: string,
  ) => {
    if (thresholds[key] === undefined) return;
    if (!needsMode) {
      throw new Error(`Invalid retrieval eval set at $.thresholds.${key}: requires ${modeName} mode.`);
    }
    if (!needsQuestions) {
      throw new Error(
        `Invalid retrieval eval set at $.thresholds.${key}: requires at least one ${questionKind} question.`,
      );
    }
  };
  requirement('minRecall', runsAnswers, 'answer', answerable > 0, 'answerable');
  requirement('maxMissRate', runsAnswers, 'answer', answerable > 0, 'answerable');
  requirement('maxInvalidCitationRate', runsAnswers, 'answer', true, 'answerable');
  requirement('minPassageRecallAt', runsPassages, 'passages', answerable > 0, 'answerable');
  requirement('minAbstentionRate', runsAnswers, 'answer', unanswerable > 0, 'unanswerable');

  return {
    schemaVersion: 2,
    domainId: requireNonEmptyString(evalSet.domainId, '$.domainId'),
    thresholds,
    mode: mode as RetrievalEvalMode,
    questions,
  };
}

function validateThresholdsV2(value: unknown): RetrievalEvalThresholdsV2 {
  const thresholds = requireRecord(value, '$.thresholds');
  requireExactKeys(thresholds, [], '$.thresholds', [
    'minRecall',
    'maxInvalidCitationRate',
    'maxMissRate',
    'minPassageRecallAt',
    'minAbstentionRate',
  ]);
  const result: RetrievalEvalThresholdsV2 = {};
  for (const key of ['minRecall', 'maxInvalidCitationRate', 'maxMissRate', 'minAbstentionRate'] as const) {
    if (thresholds[key] !== undefined) result[key] = requireRate(thresholds[key], `$.thresholds.${key}`);
  }
  if (thresholds.minPassageRecallAt !== undefined) {
    const path = '$.thresholds.minPassageRecallAt';
    const recallAt = requireRecord(thresholds.minPassageRecallAt, path);
    requireExactKeys(recallAt, ['k', 'min'], path);
    if (!RETRIEVAL_EVAL_HIT_KS.includes(recallAt.k as RetrievalEvalHitK)) {
      throw new Error(`Invalid retrieval eval set at ${path}.k: expected one of 1, 3, 5, 10, 20.`);
    }
    result.minPassageRecallAt = {
      k: recallAt.k as RetrievalEvalHitK,
      min: requireRate(recallAt.min, `${path}.min`),
    };
  }
  return result;
}

function validateEvidenceList(value: unknown, path: string): RetrievalEvalEvidence[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid retrieval eval set at ${path}: expected an array.`);
  }
  return value.map((item, index): RetrievalEvalEvidence => {
    const itemPath = `${path}[${index}]`;
    const evidence = requireRecord(item, itemPath);
    requireExactKeys(evidence, ['quote'], itemPath, ['objectId', 'sourcePath', 'pages', 'note']);
    if (evidence.objectId === undefined && evidence.sourcePath === undefined) {
      throw new Error(
        `Invalid retrieval eval set at ${itemPath}: expected an objectId or a sourcePath.`,
      );
    }
    if (
      evidence.objectId !== undefined
      && (typeof evidence.objectId !== 'string' || !SHA256_ID_PATTERN.test(evidence.objectId))
    ) {
      throw new Error(`Invalid retrieval eval set at ${itemPath}.objectId: expected a lowercase sha256 id.`);
    }
    const sourcePath = evidence.sourcePath === undefined
      ? undefined
      : requireNonEmptyString(evidence.sourcePath, `${itemPath}.sourcePath`);
    if (sourcePath !== undefined && (sourcePath.trim() !== sourcePath || sourcePath.endsWith('/'))) {
      throw new Error(
        `Invalid retrieval eval set at ${itemPath}.sourcePath: expected an object path without surrounding whitespace or a trailing slash.`,
      );
    }
    const quote = requireNonEmptyString(evidence.quote, `${itemPath}.quote`);
    const quoteWords = normalizeEvidenceWords(quote).length;
    if (quoteWords < QUOTE_MIN_WORDS || quoteWords > QUOTE_MAX_WORDS) {
      throw new Error(
        `Invalid retrieval eval set at ${itemPath}.quote: expected ${QUOTE_MIN_WORDS} through ${QUOTE_MAX_WORDS} words.`,
      );
    }
    let pages: [number, number] | undefined;
    if (evidence.pages !== undefined) {
      const range = evidence.pages;
      if (
        !Array.isArray(range)
        || range.length !== 2
        || !range.every((page) => Number.isInteger(page) && (page as number) >= 1)
        || (range[0] as number) > (range[1] as number)
      ) {
        throw new Error(
          `Invalid retrieval eval set at ${itemPath}.pages: expected [start, end] positive integers with start <= end.`,
        );
      }
      pages = [range[0] as number, range[1] as number];
    }
    return {
      ...(evidence.objectId === undefined ? {} : { objectId: evidence.objectId as string }),
      ...(sourcePath === undefined ? {} : { sourcePath }),
      quote,
      ...(pages === undefined ? {} : { pages }),
      ...(evidence.note === undefined
        ? {}
        : { note: requireNonEmptyString(evidence.note, `${itemPath}.note`) }),
    };
  });
}

export async function executeRetrievalEvalV2(
  evalSet: RetrievalEvalSetV2,
  options: ExecuteRetrievalEvalV2Options,
): Promise<RetrievalEvalExecutionV2> {
  const worker = normalizeWorkerTarget(options.worker);
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowMs = options.nowMs ?? Date.now;
  const mode = options.mode ?? evalSet.mode;
  await assertWorkerHealthy(worker, fetchImpl);
  const pageLibrary = await readsPageLibrary(evalSet.domainId, worker, fetchImpl);
  if (pageLibrary && mode !== 'passages') {
    throw new Error(
      `Retrieval eval: ${evalSet.domainId} reads a page library, which the worker does not answer from. `
      + 'Run it in passages mode (--mode passages); answers are evaluated through the agent.',
    );
  }

  const questions: RetrievalEvalQuestionExecutionV2[] = [];
  for (const question of evalSet.questions) {
    const execution: RetrievalEvalQuestionExecutionV2 = { question };
    if (mode !== 'answer') {
      if (pageLibrary) {
        const raw = await postWorkerTool('domain_library', {
          domain_id: evalSet.domainId, action: 'search', query: question.question, k: PAGE_SEARCH_EVAL_K,
        }, worker, fetchImpl, nowMs);
        execution.passages = raw.kind === 'error' ? raw : pageSearchResult(raw);
      } else {
        const raw = await postDomainAsk(evalSet.domainId, question, 'passages', worker, fetchImpl, nowMs);
        execution.passages = raw.kind === 'error' ? raw : passagesResult(raw);
      }
    }
    if (mode !== 'passages') {
      const raw = await postDomainAsk(evalSet.domainId, question, undefined, worker, fetchImpl, nowMs);
      execution.answer = raw.kind === 'error' ? raw : answerResultV2(raw);
    }
    questions.push(execution);
  }
  return { mode, questions };
}

/** The most hits one page-library search returns, so recall is measured at every cut-off up to 20. */
const PAGE_SEARCH_EVAL_K = 25;

/**
 * Whether the domain's route reads a page library: only a catalog answer says so. Any refusal
 * (page_library_not_configured, or a worker without domain_library) leaves it on domain_ask.
 */
async function readsPageLibrary(
  domainId: string,
  worker: RetrievalEvalWorkerTarget,
  fetchImpl: RetrievalEvalFetch,
): Promise<boolean> {
  const raw = await postWorkerTool('domain_library', { domain_id: domainId, action: 'catalog' }, worker, fetchImpl, Date.now);
  return raw.kind === 'body' && Array.isArray(asRecord(raw.body)?.books);
}

/** Page-library search hits as passages: each names its book's stored original, as domain_ask passages do. */
function pageSearchResult(raw: Extract<DomainAskRawResult, { kind: 'body' }>): RetrievalEvalPassagesResult {
  const results = asRecord(raw.body)?.results;
  const passages: RetrievalEvalPassage[] = [];
  if (Array.isArray(results)) {
    for (const item of results) {
      const hit = asRecord(item);
      if (typeof hit?.slug !== 'string' || typeof hit.text !== 'string') { passages.length = 0; break; }
      passages.push({ source_uri: typeof hit.source_uri === 'string' ? hit.source_uri : hit.slug, text: hit.text });
    }
  }
  return Array.isArray(results) && passages.length === results.length
    ? { kind: 'response', latency_ms: raw.latency_ms, passages: { kind: 'domain_passages', status: passages.length ? 'retrieved' : 'no_results', passages, retrieved_context_count: passages.length } }
    : { kind: 'error', error: 'invalid_response', latency_ms: raw.latency_ms, http_status: raw.http_status };
}

function passagesResult(raw: Extract<DomainAskRawResult, { kind: 'body' }>): RetrievalEvalPassagesResult {
  const passages = parseDomainPassages(raw.body);
  return passages
    ? { kind: 'response', latency_ms: raw.latency_ms, passages }
    : { kind: 'error', error: 'invalid_response', latency_ms: raw.latency_ms, http_status: raw.http_status };
}

function answerResultV2(raw: Extract<DomainAskRawResult, { kind: 'body' }>): RetrievalEvalAnswerResultV2 {
  const answer = parseDomainAnswer(raw.body);
  if (!answer) {
    return { kind: 'error', error: 'invalid_response', latency_ms: raw.latency_ms, http_status: raw.http_status };
  }
  const timings = parseTimings(asRecord(raw.body)?.timings);
  return { kind: 'response', latency_ms: raw.latency_ms, answer, ...(timings ? { timings } : {}) };
}

function parseDomainPassages(value: unknown): RetrievalEvalDomainPassages | undefined {
  const body = asRecord(value);
  if (
    body?.kind !== 'domain_passages'
    || typeof body.status !== 'string'
    || !Array.isArray(body.passages)
  ) {
    return undefined;
  }
  const passages: RetrievalEvalPassage[] = [];
  for (const item of body.passages) {
    const passage = asRecord(item);
    if (typeof passage?.source_uri !== 'string' || typeof passage.text !== 'string') return undefined;
    passages.push({ source_uri: passage.source_uri, text: passage.text });
  }
  const count = body.retrieved_context_count;
  const timings = parseTimings(body.timings);
  return {
    kind: 'domain_passages',
    status: body.status,
    passages,
    retrieved_context_count: typeof count === 'number' && Number.isInteger(count) && count >= 0
      ? count
      : passages.length,
    ...(timings ? { timings } : {}),
  };
}

/** Keeps only stage names that are plain identifiers with non-negative numeric values. */
function parseTimings(value: unknown): RetrievalEvalTimings | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const timings: RetrievalEvalTimings = {};
  for (const key of Object.keys(record).sort(compareStrings)) {
    const stage = record[key];
    if (SAFE_KEY_PATTERN.test(key) && typeof stage === 'number' && Number.isFinite(stage) && stage >= 0) {
      timings[key] = stage;
    }
  }
  return Object.keys(timings).length ? timings : undefined;
}

/**
 * Normalizes text to comparable words: Unicode compatibility decomposition
 * with combining marks removed, lowercase, words hyphenated across a line
 * break rejoined, and every punctuation or symbol character (which covers
 * Markdown emphasis, headings, quotes and dashes) treated as a word break.
 */
export function normalizeEvidenceWords(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/(\p{L})-[ \t]*\r?\n\s*(\p{L})/gu, '$1$2')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * True when the passage holds the quote, allowing for parser noise. The rule:
 * some run of `n + max(4, ceil(n / 2))` consecutive passage words (n = quote
 * words) has a longest common word subsequence with the quote covering at
 * least 80% of the quote's words. In-order alignment tolerates dropped,
 * changed and inserted words (OCR slips, footnote markers, running heads)
 * while the bounded window stops words scattered across a long passage from
 * adding up to a match.
 */
export function passageContainsQuote(quote: string, passageText: string): boolean {
  return wordsContainQuote(normalizeEvidenceWords(quote), normalizeEvidenceWords(passageText));
}

function wordsContainQuote(quoteWords: string[], passageWords: string[]): boolean {
  const n = quoteWords.length;
  if (n === 0 || passageWords.length === 0) return false;
  const needed = Math.ceil(n * PASSAGE_QUOTE_MIN_COVERAGE);
  const window = n + Math.max(4, Math.ceil(n / 2));
  // An alignment covering `needed` words starts at one of the first
  // n - needed + 1 quote words, so only those can anchor a window.
  const anchors = new Set(quoteWords.slice(0, n - needed + 1));
  for (let start = 0; start < passageWords.length; start += 1) {
    if (!anchors.has(passageWords[start]!)) continue;
    const span = passageWords.slice(start, start + window);
    if (span.length < needed) break;
    if (longestCommonSubsequence(quoteWords, span) >= needed) return true;
  }
  return false;
}

function longestCommonSubsequence(left: string[], right: string[]): number {
  let previous = new Array<number>(right.length + 1).fill(0);
  let current = new Array<number>(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1]
        ? previous[j - 1]! + 1
        : Math.max(previous[j]!, current[j - 1]!);
    }
    [previous, current] = [current, previous];
  }
  return previous[right.length]!;
}

/**
 * True when a returned source URI is the evidence's source. A canonical
 * object matches by the hash in `/<64-hex>.<ext>`; a `sourcePath` matches as
 * a whole-segment suffix of the URI. Either side may carry a split-import part
 * suffix (`--part<i>of<n>` before the extension), so evidence naming a whole
 * book matches each of its parts.
 */
export function evidenceSourceMatches(evidence: RetrievalEvalEvidence, sourceUri: string): boolean {
  const uri = stripPartSuffix(sourceUri);
  if (evidence.objectId !== undefined) {
    const hash = uri.match(/\/([a-f0-9]{64})\.[^/.]+$/)?.[1];
    if (hash === evidence.objectId.slice('sha256:'.length)) return true;
  }
  if (evidence.sourcePath !== undefined) {
    const path = stripPartSuffix(evidence.sourcePath.replace(/^\/+/, ''));
    if (path !== '' && (uri === path || uri.endsWith(`/${path}`))) return true;
  }
  return false;
}

function stripPartSuffix(path: string): string {
  return path.replace(/--part\d+of\d+(\.[^/.]+)$/, '$1');
}

function hitTable(rank: number | null): RetrievalEvalHitTable {
  const table = {} as RetrievalEvalHitTable;
  for (const k of RETRIEVAL_EVAL_HIT_KS) table[`at_${k}`] = rank !== null && rank <= k;
  return table;
}

export function computeRetrievalEvalQuestionMetricsV2(
  execution: RetrievalEvalQuestionExecutionV2,
): RetrievalEvalQuestionMetricsV2 {
  const { question } = execution;
  return {
    id: question.id,
    category: question.category,
    answerable: question.answerable,
    passages: execution.passages ? passageMetrics(question, execution.passages) : null,
    answer: execution.answer ? answerMetricsV2(question, execution.answer) : null,
  };
}

function passageMetrics(
  question: RetrievalEvalQuestionV2,
  result: RetrievalEvalPassagesResult,
): RetrievalEvalPassageMetrics {
  const evidence = question.evidence ?? [];
  if (result.kind === 'error') {
    return {
      status: null,
      error: result.error,
      passage_count: 0,
      distinct_source_count: 0,
      retrieved_context_count: 0,
      evidence_count: evidence.length,
      evidence_found_count: 0,
      object_hit_at: question.answerable ? hitTable(null) : null,
      passage_hit_at: question.answerable ? hitTable(null) : null,
      first_object_hit_rank: null,
      first_passage_hit_rank: null,
      latency_ms: result.latency_ms,
      timings: null,
    };
  }
  const { passages } = result;
  const scored = passages.status === 'retrieved' && question.answerable;
  let firstObject: number | null = null;
  let firstPassage: number | null = null;
  const found = new Set<number>();
  if (scored) {
    const quoteWords = evidence.map((item) => normalizeEvidenceWords(item.quote));
    passages.passages.forEach((passage, index) => {
      const matchingSources = evidence
        .map((item, evidenceIndex) => ({ item, evidenceIndex }))
        .filter(({ item }) => evidenceSourceMatches(item, passage.source_uri));
      if (matchingSources.length === 0) return;
      firstObject ??= index + 1;
      const passageWords = normalizeEvidenceWords(passage.text);
      for (const { evidenceIndex } of matchingSources) {
        if (wordsContainQuote(quoteWords[evidenceIndex]!, passageWords)) {
          found.add(evidenceIndex);
          firstPassage ??= index + 1;
        }
      }
    });
  }
  return {
    status: passages.status,
    error: null,
    passage_count: passages.passages.length,
    distinct_source_count: new Set(passages.passages.map((passage) => passage.source_uri)).size,
    retrieved_context_count: passages.retrieved_context_count,
    evidence_count: evidence.length,
    evidence_found_count: found.size,
    object_hit_at: question.answerable ? hitTable(firstObject) : null,
    passage_hit_at: question.answerable ? hitTable(firstPassage) : null,
    first_object_hit_rank: firstObject,
    first_passage_hit_rank: firstPassage,
    latency_ms: result.latency_ms,
    timings: passages.timings ?? null,
  };
}

function answerMetricsV2(
  question: RetrievalEvalQuestionV2,
  result: RetrievalEvalAnswerResultV2,
): RetrievalEvalAnswerMetricsV2 {
  if (result.kind === 'error') {
    return {
      status: null,
      error: result.error,
      expected_source_hit: question.answerable ? false : null,
      first_expected_hit_rank: null,
      citation_marker_count: 0,
      invalid_citation_marker_count: 0,
      distinct_cited_source_count: 0,
      retrieved_context_count: 0,
      abstained: false,
      latency_ms: result.latency_ms,
      timings: null,
    };
  }
  const { answer } = result;
  const markers = extractCitationMarkers(answer.answer);
  const citationIds = new Set(answer.citations.map((citation) => citation.citation_id));
  const answered = answer.status === 'answered';
  const evidence = question.evidence ?? [];
  const rank = answer.citations.findIndex((citation) =>
    evidence.some((item) => evidenceSourceMatches(item, citation.source_uri)));
  const hit = question.answerable && answered && rank >= 0;
  return {
    status: answer.status,
    error: null,
    expected_source_hit: question.answerable ? hit : null,
    first_expected_hit_rank: hit ? rank + 1 : null,
    citation_marker_count: markers.length,
    invalid_citation_marker_count: markers.filter((marker) => !citationIds.has(marker)).length,
    distinct_cited_source_count: new Set(answer.citations.map((citation) => citation.source_uri)).size,
    retrieved_context_count: answer.retrieved_context_count,
    abstained: !answered || isAbstentionAnswer(answer.answer),
    latency_ms: result.latency_ms,
    timings: result.timings ?? null,
  };
}

/** Nearest-rank percentile: the value at 1-based rank ceil(p/100 * n) of the sorted values. */
export function nearestRankPercentile(values: number[], percentile: number): number {
  if (values.length === 0) throw new Error('A percentile needs at least one value.');
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

function latencySummary(values: number[]): RetrievalEvalLatencySummary | null {
  if (values.length === 0) return null;
  return {
    count: values.length,
    min: Math.min(...values),
    mean: sum(values) / values.length,
    p50: nearestRankPercentile(values, 50),
    p95: nearestRankPercentile(values, 95),
    max: Math.max(...values),
  };
}

function stageSummary(timings: Array<RetrievalEvalTimings | null>): Record<string, RetrievalEvalStageSummary> {
  const byStage = new Map<string, number[]>();
  for (const entry of timings) {
    for (const [stage, value] of Object.entries(entry ?? {})) {
      byStage.set(stage, [...(byStage.get(stage) ?? []), value]);
    }
  }
  const summary: Record<string, RetrievalEvalStageSummary> = {};
  for (const stage of [...byStage.keys()].sort(compareStrings)) {
    const values = byStage.get(stage)!;
    summary[stage] = {
      count: values.length,
      p50: nearestRankPercentile(values, 50),
      p95: nearestRankPercentile(values, 95),
    };
  }
  return summary;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function meanReciprocalRank(ranks: Array<number | null>): number | null {
  return ranks.length === 0 ? null : sum(ranks.map((rank) => (rank === null ? 0 : 1 / rank))) / ranks.length;
}

function summarizeV2(questions: RetrievalEvalQuestionMetricsV2[]): RetrievalEvalSummaryV2 {
  const answerable = questions.filter((question) => question.answerable);
  const unanswerable = questions.filter((question) => !question.answerable);
  const withPassages = questions.filter((question) => question.passages !== null);
  const withAnswers = questions.filter((question) => question.answer !== null);

  let passages: RetrievalEvalPassageSummary | null = null;
  if (withPassages.length) {
    const scored = withPassages.filter((question) => question.answerable).map((question) => question.passages!);
    const objectRecall = {} as RetrievalEvalRateTable;
    const passageRecall = {} as RetrievalEvalRateTable;
    for (const k of RETRIEVAL_EVAL_HIT_KS) {
      const key = `at_${k}` as const;
      objectRecall[key] = rate(scored.filter((metrics) => metrics.object_hit_at![key]).length, scored.length);
      passageRecall[key] = rate(scored.filter((metrics) => metrics.passage_hit_at![key]).length, scored.length);
    }
    passages = {
      run: withPassages.length,
      errors: withPassages.filter((question) => question.passages!.error !== null).length,
      answerable: scored.length,
      object_recall_at: objectRecall,
      passage_recall_at: passageRecall,
      object_mrr: meanReciprocalRank(scored.map((metrics) => metrics.first_object_hit_rank)),
      passage_mrr: meanReciprocalRank(scored.map((metrics) => metrics.first_passage_hit_rank)),
      passage_miss_question_ids: withPassages
        .filter((question) => question.answerable && question.passages!.first_passage_hit_rank === null)
        .map((question) => question.id),
      latency_ms: latencySummary(withPassages.map((question) => question.passages!.latency_ms)),
      stage_timings_ms: stageSummary(withPassages.map((question) => question.passages!.timings)),
    };
  }

  let answer: RetrievalEvalAnswerSummaryV2 | null = null;
  if (withAnswers.length) {
    const answerableRuns = withAnswers.filter((question) => question.answerable);
    const unanswerableRuns = withAnswers.filter((question) => !question.answerable);
    const hits = answerableRuns.filter((question) => question.answer!.expected_source_hit === true).length;
    const misses = answerableRuns
      .filter((question) => question.answer!.expected_source_hit !== true)
      .map((question) => question.id);
    const markerCount = sum(withAnswers.map((question) => question.answer!.citation_marker_count));
    const invalidCount = sum(withAnswers.map((question) => question.answer!.invalid_citation_marker_count));
    const abstentions = unanswerableRuns.filter((question) => question.answer!.abstained).length;
    const falseAnswers = unanswerableRuns
      .filter((question) => question.answer!.error === null && !question.answer!.abstained).length;
    const falseAbstentions = answerableRuns
      .filter((question) => question.answer!.error === null && question.answer!.abstained).length;
    answer = {
      run: withAnswers.length,
      errors: withAnswers.filter((question) => question.answer!.error !== null).length,
      answerable: answerableRuns.length,
      unanswerable: unanswerableRuns.length,
      expected_source_hits: hits,
      recall: rate(hits, answerableRuns.length),
      miss_question_ids: misses,
      miss_rate: rate(misses.length, answerableRuns.length),
      citation_marker_count: markerCount,
      invalid_citation_marker_count: invalidCount,
      invalid_citation_rate: markerCount === 0 ? 0 : invalidCount / markerCount,
      abstentions,
      abstention_rate: rate(abstentions, unanswerableRuns.length),
      false_answers: falseAnswers,
      false_answer_rate: rate(falseAnswers, unanswerableRuns.length),
      false_abstentions: falseAbstentions,
      false_abstention_rate: rate(falseAbstentions, answerableRuns.length),
      latency_ms: latencySummary(withAnswers.map((question) => question.answer!.latency_ms)),
      stage_timings_ms: stageSummary(withAnswers.map((question) => question.answer!.timings)),
    };
  }

  return {
    total: questions.length,
    answerable: answerable.length,
    unanswerable: unanswerable.length,
    passages,
    answer,
  };
}

export function createRetrievalEvalReceiptV2(
  loaded: LoadedRetrievalEvalSet<RetrievalEvalSetV2>,
  execution: RetrievalEvalExecutionV2,
  workerUrl: string,
): RetrievalEvalReceiptV2 {
  const questions = execution.questions
    .map(computeRetrievalEvalQuestionMetricsV2)
    .sort((left, right) => compareStrings(left.id, right.id));
  const overall = summarizeV2(questions);
  const byCategory: Partial<Record<RetrievalEvalCategory, RetrievalEvalSummaryV2>> = {};
  for (const category of RETRIEVAL_EVAL_CATEGORIES) {
    const members = questions.filter((question) => question.category === category);
    if (members.length) byCategory[category] = summarizeV2(members);
  }

  const thresholds = loaded.evalSet.thresholds;
  const verdict: RetrievalEvalReceiptV2['verdict'] = { skipped: [], passed: true };
  const record = <K extends 'min_recall' | 'max_invalid_citation_rate' | 'max_miss_rate' | 'min_abstention_rate'>(
    name: K,
    threshold: number | undefined,
    actual: number | null | undefined,
    direction: 'min' | 'max',
  ) => {
    if (threshold === undefined) return;
    if (actual === undefined) {
      verdict.skipped.push(name);
      return;
    }
    verdict[name] = actual === null
      ? { threshold, actual: 0, passed: false }
      : thresholdVerdict(threshold, actual, direction);
  };
  const answerSummary = overall.answer ?? undefined;
  record('min_recall', thresholds.minRecall, answerSummary?.recall, 'min');
  record('max_invalid_citation_rate', thresholds.maxInvalidCitationRate, answerSummary?.invalid_citation_rate, 'max');
  record('max_miss_rate', thresholds.maxMissRate, answerSummary?.miss_rate, 'max');
  if (thresholds.minPassageRecallAt !== undefined) {
    const { k, min } = thresholds.minPassageRecallAt;
    const actual = overall.passages?.passage_recall_at[`at_${k}`];
    if (actual === undefined) {
      verdict.skipped.push('min_passage_recall_at');
    } else {
      verdict.min_passage_recall_at = {
        k,
        ...(actual === null ? { threshold: min, actual: 0, passed: false } : thresholdVerdict(min, actual, 'min')),
      };
    }
  }
  record('min_abstention_rate', thresholds.minAbstentionRate, answerSummary?.abstention_rate, 'min');
  verdict.passed = (['min_recall', 'max_invalid_citation_rate', 'max_miss_rate', 'min_passage_recall_at', 'min_abstention_rate'] as const)
    .every((name) => verdict[name] === undefined || verdict[name]!.passed);
  // Keep a fixed key order so receipts serialize identically on every run.
  const ordered: RetrievalEvalReceiptV2['verdict'] = {
    ...(verdict.min_recall ? { min_recall: verdict.min_recall } : {}),
    ...(verdict.max_invalid_citation_rate ? { max_invalid_citation_rate: verdict.max_invalid_citation_rate } : {}),
    ...(verdict.max_miss_rate ? { max_miss_rate: verdict.max_miss_rate } : {}),
    ...(verdict.min_passage_recall_at ? { min_passage_recall_at: verdict.min_passage_recall_at } : {}),
    ...(verdict.min_abstention_rate ? { min_abstention_rate: verdict.min_abstention_rate } : {}),
    skipped: verdict.skipped,
    passed: verdict.passed,
  };

  return {
    schemaVersion: 2,
    eval_set: {
      sha256: sha256(loaded.bytes),
      bytes: loaded.bytes.byteLength,
    },
    worker: endpointOrigin(workerUrl),
    mode: execution.mode,
    passage_match_rule: PASSAGE_MATCH_RULE,
    questions,
    summary: { overall, by_category: byCategory },
    verdict: ordered,
  };
}

/** Eval content that must never reach a receipt: question text, quotes, source paths, notes, reference answers. */
export function retrievalEvalV2ContentValues(evalSet: RetrievalEvalSetV2): string[] {
  const values: string[] = [];
  for (const question of evalSet.questions) {
    values.push(question.question);
    if (question.answer !== undefined) values.push(question.answer);
    for (const evidence of question.evidence ?? []) {
      values.push(evidence.quote);
      if (evidence.sourcePath !== undefined) values.push(evidence.sourcePath);
      if (evidence.note !== undefined) values.push(evidence.note);
    }
  }
  return values;
}

export async function writeRetrievalEvalReceiptV2(
  path: string,
  receipt: RetrievalEvalReceiptV2,
  forbidden: { token?: string; content?: string[] } = {},
): Promise<void> {
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  if (forbidden.token && serialized.includes(forbidden.token)) {
    throw new Error('Refusing to write retrieval eval receipt because it contains a bearer token.');
  }
  // Short strings are skipped: an id or status could legitimately equal them.
  if ((forbidden.content ?? []).some((value) => value.length >= RECEIPT_CONTENT_MIN_LENGTH
    && (serialized.includes(value) || serialized.includes(JSON.stringify(value).slice(1, -1))))) {
    throw new Error('Refusing to write retrieval eval receipt because it contains eval-set content.');
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialized, 'utf8');
}

function formatRate(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(3);
}

if (import.meta.main) {
  try {
    const receipt = await runRetrievalEvalCli(process.argv.slice(2));
    if (receipt.schemaVersion === 2) {
      const { overall } = receipt.summary;
      const parts = [
        ...(overall.passages
          ? [`passage recall@5 ${formatRate(overall.passages.passage_recall_at.at_5)}`]
          : []),
        ...(overall.answer
          ? [`answer recall ${formatRate(overall.answer.recall)}`, `abstention ${formatRate(overall.answer.abstention_rate)}`]
          : []),
      ];
      console.log(
        `Retrieval eval complete (${receipt.mode}, ${overall.total} questions): ${parts.join('; ')}; gate ${receipt.verdict.passed ? 'passed' : 'failed'}.`,
      );
    } else {
      console.log(
        `Retrieval eval complete: ${receipt.summary.expected_source_hits}/${receipt.summary.total} expected-source hits; gate ${receipt.verdict.passed ? 'passed' : 'failed'}.`,
      );
    }
    process.exitCode = retrievalEvalExitCode(receipt);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Retrieval eval failed.');
    process.exitCode = 1;
  }
}
