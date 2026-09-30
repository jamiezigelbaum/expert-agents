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

export interface LoadedRetrievalEvalSet {
  evalSet: RetrievalEvalSet;
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
}

const SHA256_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CLI_USAGE = `Usage: bun run retrieval:eval -- --worker <base-url> --questions <path> --receipt <path>

An optional bearer token is read only from EXPERT_AGENTS_PARITY_CANDIDATE_TOKEN.`;

export function parseRetrievalEvalSet(text: string): RetrievalEvalSet {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Invalid retrieval eval set: expected valid JSON.');
  }
  return validateRetrievalEvalSet(value);
}

export function validateRetrievalEvalSet(value: unknown): RetrievalEvalSet {
  const evalSet = requireRecord(value, '$');
  requireExactKeys(evalSet, ['schemaVersion', 'domainId', 'thresholds', 'questions'], '$');
  if (evalSet.schemaVersion !== 1) {
    throw new Error('Invalid retrieval eval set at $.schemaVersion: expected 1.');
  }

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

export async function loadRetrievalEvalSet(path: string): Promise<LoadedRetrievalEvalSet> {
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

export async function runRetrievalEval(options: RunRetrievalEvalOptions): Promise<RetrievalEvalReceipt> {
  const loaded = await loadRetrievalEvalSet(options.questionsPath);
  const execution = await executeRetrievalEval(loaded.evalSet, options);
  const receipt = createRetrievalEvalReceipt(loaded, execution, options.worker.baseUrl);
  await writeRetrievalEvalReceipt(
    options.receiptPath,
    receipt,
    options.worker.token ? [options.worker.token] : [],
  );
  return receipt;
}

export function parseRetrievalEvalCliArguments(args: string[]): RetrievalEvalCliArguments {
  const values = new Map<string, string>();
  const allowed = new Set(['--worker', '--questions', '--receipt']);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag || !allowed.has(flag)) throw new Error(CLI_USAGE);
    const value = args[index + 1];
    if (!value || value.startsWith('--') || values.has(flag)) throw new Error(CLI_USAGE);
    values.set(flag, value);
  }
  if (values.size !== allowed.size) throw new Error(CLI_USAGE);
  return {
    workerUrl: values.get('--worker')!,
    questionsPath: values.get('--questions')!,
    receiptPath: values.get('--receipt')!,
  };
}

export async function runRetrievalEvalCli(
  args: string[],
  dependencies: RetrievalEvalCliDependencies = {},
): Promise<RetrievalEvalReceipt> {
  const parsed = parseRetrievalEvalCliArguments(args);
  const env = dependencies.env ?? process.env;
  const token = env.EXPERT_AGENTS_PARITY_CANDIDATE_TOKEN;
  return runRetrievalEval({
    questionsPath: parsed.questionsPath,
    receiptPath: parsed.receiptPath,
    worker: {
      baseUrl: parsed.workerUrl,
      ...(token ? { token } : {}),
    },
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
    ...(dependencies.nowMs ? { nowMs: dependencies.nowMs } : {}),
  });
}

export function retrievalEvalExitCode(receipt: RetrievalEvalReceipt): 0 | 1 {
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
  const startedAt = nowMs();
  let response: Response;
  try {
    response = await fetchImpl(`${worker.baseUrl}/v1/domain`, {
      method: 'POST',
      headers: requestHeaders(worker.token, true),
      body: JSON.stringify({
        tool: 'domain_ask',
        params: {
          domain_id: domainId,
          question: question.question,
          ...(question.corpora === undefined ? {} : { corpora: question.corpora }),
        },
      }),
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

  const answer = parseDomainAnswer(body);
  return answer
    ? { kind: 'response', latency_ms, answer }
    : { kind: 'error', error: 'invalid_response', latency_ms, http_status: response.status };
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

if (import.meta.main) {
  try {
    const receipt = await runRetrievalEvalCli(process.argv.slice(2));
    console.log(
      `Retrieval eval complete: ${receipt.summary.expected_source_hits}/${receipt.summary.total} expected-source hits; gate ${receipt.verdict.passed ? 'passed' : 'failed'}.`,
    );
    process.exitCode = retrievalEvalExitCode(receipt);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Retrieval eval failed.');
    process.exitCode = 1;
  }
}
