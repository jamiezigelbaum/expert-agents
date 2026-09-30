import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ParityBatteryQuestion {
  id: string;
  domain_id: string;
  question: string;
  corpora?: string[];
}

export interface ParityBattery {
  schemaVersion: 1;
  questions: ParityBatteryQuestion[];
}

export interface LoadedParityBattery {
  battery: ParityBattery;
  bytes: Uint8Array;
}

export interface ParityRuntimeTarget {
  baseUrl: string;
  token?: string;
}

export type ParityFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface RuntimeHttpResult {
  kind: 'response';
  httpStatus: number;
  body: unknown;
}

export interface RuntimeRequestErrorResult {
  kind: 'request_error';
  error: 'unreachable' | 'invalid_json';
}

export type RuntimeQuestionResult = RuntimeHttpResult | RuntimeRequestErrorResult;

export interface ParityQuestionExecution {
  question: ParityBatteryQuestion;
  baseline: RuntimeQuestionResult;
  candidate: RuntimeQuestionResult;
}

export interface ParityBatteryExecution {
  questions: ParityQuestionExecution[];
}

export interface ExecuteParityBatteryOptions {
  baseline: ParityRuntimeTarget;
  candidate: ParityRuntimeTarget;
  fetchImpl?: ParityFetch;
}

export type ParityVerdict = 'parity' | 'divergence' | 'error';

export interface CorpusMappingPair {
  corpus_id: string;
  resource_name: string;
}

export interface CitationSourcePair {
  corpus_id: string;
  source_uri: string;
}

export interface ComparableDomainAnswer {
  kind: 'domain_answer';
  status: string;
  answer: string;
  resolved_corpora: CorpusMappingPair[];
  citations: CitationSourcePair[];
  retrieved_context_count: number;
  retrieval_plan: unknown;
  // Contract shape, not content: the response's top-level key set and the
  // policy object callers validate before accepting a response. A renamed
  // contract field can hide behind matching citations — comparing the shape
  // makes it a divergence on every question instead.
  contract_keys: string[];
  policy: unknown;
}

export interface ComparableRuntimeError {
  kind: 'error';
  error: 'unreachable' | 'invalid_json' | 'http_error' | 'invalid_response';
  http_status?: number;
  error_code?: string;
}

export type ComparableRuntimeSide = ComparableDomainAnswer | ComparableRuntimeError;

export interface ParityDifferences {
  status: boolean;
  resolved_corpora: boolean;
  citations: boolean;
  retrieved_context_count: boolean;
  retrieval_plan_paths: string[];
  contract_keys: boolean;
  policy_paths: string[];
}

export interface ParityQuestionComparison {
  id: string;
  verdict: ParityVerdict;
  baseline: ComparableRuntimeSide;
  candidate: ComparableRuntimeSide;
  citation_overlap_fraction: number | null;
  differences: ParityDifferences;
}

export interface ParityAnswerEvidence {
  sha256: string;
  characters: number;
}

export interface ParityReceiptAnswerSide {
  kind: 'domain_answer';
  status: string;
  answer: ParityAnswerEvidence;
  resolved_corpora: CorpusMappingPair[];
  citations: CitationSourcePair[];
  retrieved_context_count: number;
  contract_keys: string[];
  policy: unknown;
}

export type ParityReceiptSide = ParityReceiptAnswerSide | ComparableRuntimeError;

export interface ParityReceiptQuestion {
  id: string;
  domain_id: string;
  question: string;
  corpora?: string[];
  verdict: ParityVerdict;
  baseline: ParityReceiptSide;
  candidate: ParityReceiptSide;
  citation_overlap_fraction: number | null;
  differences: ParityDifferences;
}

export interface ParityReceipt {
  schemaVersion: 1;
  battery: {
    sha256: string;
    bytes: number;
  };
  endpoints: {
    baseline: string;
    candidate: string;
  };
  questions: ParityReceiptQuestion[];
  summary: {
    total: number;
    parity: number;
    divergence: number;
    error: number;
  };
}

export interface RunParityBatteryOptions extends ExecuteParityBatteryOptions {
  batteryPath: string;
  outputPath: string;
}

export interface ParityCliDependencies {
  fetchImpl?: ParityFetch;
  env?: Record<string, string | undefined>;
}

interface ParityCliArguments {
  batteryPath: string;
  baselineUrl: string;
  candidateUrl: string;
  outputPath: string;
}

const CLI_USAGE = `Usage: bun run parity:battery -- --battery <path> --baseline <url> --candidate <url> --output <path>

Bearer tokens are read only from EXPERT_AGENTS_PARITY_BASELINE_TOKEN and
EXPERT_AGENTS_PARITY_CANDIDATE_TOKEN.`;

export function parseParityBattery(text: string): ParityBattery {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Invalid parity battery JSON: the file must contain valid JSON.');
  }
  return validateParityBattery(value);
}

export function validateParityBattery(value: unknown): ParityBattery {
  const battery = requireRecord(value, 'battery');
  if (battery.schemaVersion !== 1) {
    throw new Error('Invalid parity battery at schemaVersion: expected 1.');
  }
  if (!Array.isArray(battery.questions) || battery.questions.length === 0) {
    throw new Error('Invalid parity battery at questions: expected a non-empty array.');
  }

  const ids = new Set<string>();
  const questions = battery.questions.map((value, index) => {
    const path = `questions[${index}]`;
    const question = requireRecord(value, path);
    const id = requireNonEmptyString(question.id, `${path}.id`);
    if (ids.has(id)) throw new Error(`Invalid parity battery at ${path}.id: duplicate id "${id}".`);
    ids.add(id);

    const parsed: ParityBatteryQuestion = {
      id,
      domain_id: requireNonEmptyString(question.domain_id, `${path}.domain_id`),
      question: requireNonEmptyString(question.question, `${path}.question`),
    };
    if (question.corpora !== undefined) {
      if (!Array.isArray(question.corpora)) {
        throw new Error(`Invalid parity battery at ${path}.corpora: expected an array of non-empty strings.`);
      }
      parsed.corpora = question.corpora.map((corpus, corpusIndex) => (
        requireNonEmptyString(corpus, `${path}.corpora[${corpusIndex}]`)
      ));
    }
    return parsed;
  });

  return { schemaVersion: 1, questions };
}

export async function loadParityBattery(path: string): Promise<LoadedParityBattery> {
  const bytes = await readFile(path);
  return { battery: parseParityBattery(bytes.toString('utf8')), bytes };
}

export async function executeParityBattery(
  battery: ParityBattery,
  options: ExecuteParityBatteryOptions,
): Promise<ParityBatteryExecution> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseline = normalizeTarget(options.baseline, 'baseline');
  const candidate = normalizeTarget(options.candidate, 'candidate');

  await Promise.all([
    assertHealthy('baseline', baseline, fetchImpl),
    assertHealthy('candidate', candidate, fetchImpl),
  ]);

  const questions: ParityQuestionExecution[] = [];
  for (const question of battery.questions) {
    const [baselineResult, candidateResult] = await Promise.all([
      askQuestion(baseline, question, fetchImpl),
      askQuestion(candidate, question, fetchImpl),
    ]);
    questions.push({ question, baseline: baselineResult, candidate: candidateResult });
  }
  return { questions };
}

export function compareParityQuestion(execution: ParityQuestionExecution): ParityQuestionComparison {
  const baseline = comparableSide(execution.baseline);
  const candidate = comparableSide(execution.candidate);
  const emptyDifferences: ParityDifferences = {
    status: false,
    resolved_corpora: false,
    citations: false,
    retrieved_context_count: false,
    retrieval_plan_paths: [],
    contract_keys: false,
    policy_paths: [],
  };
  if (baseline.kind === 'error' || candidate.kind === 'error') {
    return {
      id: execution.question.id,
      verdict: 'error',
      baseline,
      candidate,
      citation_overlap_fraction: null,
      differences: emptyDifferences,
    };
  }

  const differences: ParityDifferences = {
    status: baseline.status !== candidate.status,
    resolved_corpora: !deepEqual(baseline.resolved_corpora, candidate.resolved_corpora),
    citations: !deepEqual(baseline.citations, candidate.citations),
    retrieved_context_count: baseline.retrieved_context_count !== candidate.retrieved_context_count,
    retrieval_plan_paths: differingJsonPaths(baseline.retrieval_plan, candidate.retrieval_plan),
    contract_keys: !deepEqual(baseline.contract_keys, candidate.contract_keys),
    policy_paths: differingJsonPaths(baseline.policy, candidate.policy),
  };
  const divergent = differences.status
    || differences.resolved_corpora
    || differences.citations
    || differences.retrieved_context_count
    || differences.retrieval_plan_paths.length > 0
    || differences.contract_keys
    || differences.policy_paths.length > 0;

  return {
    id: execution.question.id,
    verdict: divergent ? 'divergence' : 'parity',
    baseline,
    candidate,
    citation_overlap_fraction: setOverlapFraction(baseline.citations, candidate.citations),
    differences,
  };
}

export function compareParityExecution(execution: ParityBatteryExecution): ParityQuestionComparison[] {
  return execution.questions.map(compareParityQuestion);
}

export function differingJsonPaths(baseline: unknown, candidate: unknown): string[] {
  const paths: string[] = [];
  collectDifferingJsonPaths(sortJsonKeys(baseline), sortJsonKeys(candidate), '$', paths);
  return paths;
}

export function createParityReceipt(
  battery: LoadedParityBattery,
  execution: ParityBatteryExecution,
  endpoints: { baseline: string; candidate: string },
): ParityReceipt {
  const comparisons = compareParityExecution(execution);
  const comparisonById = new Map(comparisons.map((comparison) => [comparison.id, comparison]));
  const questions = execution.questions.map((item): ParityReceiptQuestion => {
    const comparison = comparisonById.get(item.question.id);
    if (!comparison) throw new Error(`Missing parity comparison for question "${item.question.id}".`);
    return {
      id: item.question.id,
      domain_id: item.question.domain_id,
      question: item.question.question,
      ...(item.question.corpora !== undefined ? { corpora: [...item.question.corpora] } : {}),
      verdict: comparison.verdict,
      baseline: receiptSide(comparison.baseline),
      candidate: receiptSide(comparison.candidate),
      citation_overlap_fraction: comparison.citation_overlap_fraction,
      differences: comparison.differences,
    };
  }).sort((left, right) => compareStrings(left.id, right.id));

  return {
    schemaVersion: 1,
    battery: {
      sha256: sha256(battery.bytes),
      bytes: battery.bytes.byteLength,
    },
    endpoints: {
      baseline: endpointOrigin(endpoints.baseline),
      candidate: endpointOrigin(endpoints.candidate),
    },
    questions,
    summary: {
      total: questions.length,
      parity: questions.filter((question) => question.verdict === 'parity').length,
      divergence: questions.filter((question) => question.verdict === 'divergence').length,
      error: questions.filter((question) => question.verdict === 'error').length,
    },
  };
}

export function serializeParityReceipt(receipt: ParityReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

export async function writeParityReceipt(
  path: string,
  receipt: ParityReceipt,
  forbiddenValues: string[] = [],
): Promise<void> {
  const serialized = serializeParityReceipt(receipt);
  if (forbiddenValues.some((value) => value !== '' && serialized.includes(value))) {
    throw new Error('Refusing to write parity receipt because it contains a bearer token.');
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialized, 'utf8');
}

export async function runParityBattery(options: RunParityBatteryOptions): Promise<ParityReceipt> {
  const loaded = await loadParityBattery(options.batteryPath);
  const execution = await executeParityBattery(loaded.battery, options);
  const receipt = createParityReceipt(loaded, execution, {
    baseline: options.baseline.baseUrl,
    candidate: options.candidate.baseUrl,
  });
  await writeParityReceipt(
    options.outputPath,
    receipt,
    [options.baseline.token, options.candidate.token].filter((value): value is string => Boolean(value)),
  );
  return receipt;
}

export function parseParityCliArguments(args: string[]): ParityCliArguments {
  const values = new Map<string, string>();
  const allowed = new Set(['--battery', '--baseline', '--candidate', '--output']);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag || !allowed.has(flag)) throw new Error(CLI_USAGE);
    const value = args[index + 1];
    if (!value || value.startsWith('--') || values.has(flag)) throw new Error(CLI_USAGE);
    values.set(flag, value);
  }
  if (values.size !== allowed.size) throw new Error(CLI_USAGE);
  return {
    batteryPath: values.get('--battery')!,
    baselineUrl: values.get('--baseline')!,
    candidateUrl: values.get('--candidate')!,
    outputPath: values.get('--output')!,
  };
}

export async function runParityBatteryCli(
  args: string[],
  dependencies: ParityCliDependencies = {},
): Promise<ParityReceipt> {
  const parsed = parseParityCliArguments(args);
  const env = dependencies.env ?? process.env;
  return runParityBattery({
    batteryPath: parsed.batteryPath,
    outputPath: parsed.outputPath,
    baseline: {
      baseUrl: parsed.baselineUrl,
      ...(env.EXPERT_AGENTS_PARITY_BASELINE_TOKEN
        ? { token: env.EXPERT_AGENTS_PARITY_BASELINE_TOKEN }
        : {}),
    },
    candidate: {
      baseUrl: parsed.candidateUrl,
      ...(env.EXPERT_AGENTS_PARITY_CANDIDATE_TOKEN
        ? { token: env.EXPERT_AGENTS_PARITY_CANDIDATE_TOKEN }
        : {}),
    },
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
  });
}

function normalizeTarget(target: ParityRuntimeTarget, label: string): ParityRuntimeTarget {
  let parsed: URL;
  try {
    parsed = new URL(target.baseUrl);
  } catch {
    throw new Error(`Invalid ${label} endpoint: expected an absolute HTTP(S) URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid ${label} endpoint: expected an HTTP(S) URL.`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`Invalid ${label} endpoint: credentials, query strings, and fragments are not allowed.`);
  }
  return { baseUrl: target.baseUrl.replace(/\/+$/, ''), ...(target.token ? { token: target.token } : {}) };
}

async function assertHealthy(
  label: 'baseline' | 'candidate',
  target: ParityRuntimeTarget,
  fetchImpl: ParityFetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(`${target.baseUrl}/v1/health`, {
      method: 'GET',
      headers: requestHeaders(target.token),
    });
  } catch {
    throw new Error(`${label} runtime is unreachable at ${new URL(target.baseUrl).origin}.`);
  }
  if (!response.ok) {
    throw new Error(`${label} runtime health check failed with HTTP ${response.status} at ${new URL(target.baseUrl).origin}.`);
  }
}

async function askQuestion(
  target: ParityRuntimeTarget,
  question: ParityBatteryQuestion,
  fetchImpl: ParityFetch,
): Promise<RuntimeQuestionResult> {
  const params: Record<string, unknown> = {
    domain_id: question.domain_id,
    question: question.question,
    ...(question.corpora !== undefined ? { corpora: question.corpora } : {}),
  };
  let response: Response;
  try {
    response = await fetchImpl(`${target.baseUrl}/v1/domain`, {
      method: 'POST',
      headers: requestHeaders(target.token, true),
      body: JSON.stringify({ tool: 'domain_ask', params }),
    });
  } catch {
    return { kind: 'request_error', error: 'unreachable' };
  }

  try {
    return { kind: 'response', httpStatus: response.status, body: await response.json() };
  } catch {
    return { kind: 'request_error', error: 'invalid_json' };
  }
}

function requestHeaders(token: string | undefined, json = false): HeadersInit {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function receiptSide(side: ComparableRuntimeSide): ParityReceiptSide {
  if (side.kind === 'error') return side;
  return {
    kind: 'domain_answer',
    status: side.status,
    answer: {
      sha256: sha256(side.answer),
      characters: [...side.answer].length,
    },
    resolved_corpora: side.resolved_corpora,
    citations: side.citations,
    retrieved_context_count: side.retrieved_context_count,
    contract_keys: side.contract_keys,
    policy: side.policy,
  };
}

function endpointOrigin(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol');
    return parsed.origin;
  } catch {
    throw new Error('Invalid parity endpoint: expected an absolute HTTP(S) URL.');
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function comparableSide(result: RuntimeQuestionResult): ComparableRuntimeSide {
  if (result.kind === 'request_error') return { kind: 'error', error: result.error };

  const body = asRecord(result.body);
  if (!isSuccessStatus(result.httpStatus)) {
    const error = asRecord(body?.error);
    return {
      kind: 'error',
      error: 'http_error',
      http_status: result.httpStatus,
      ...(typeof error?.code === 'string' ? { error_code: error.code } : {}),
    };
  }
  if (
    body?.kind !== 'domain_answer'
    || typeof body.status !== 'string'
    || typeof body.answer !== 'string'
    || !Array.isArray(body.resolved_corpora)
    || !Array.isArray(body.citations)
    || !Number.isInteger(body.retrieved_context_count)
    || typeof body.retrieved_context_count !== 'number'
    || body.retrieved_context_count < 0
    || !Object.hasOwn(body, 'retrieval_plan')
  ) {
    return { kind: 'error', error: 'invalid_response', http_status: result.httpStatus };
  }

  const resolvedCorpora = parsePairSet(body.resolved_corpora, 'corpus_id', 'resource_name');
  const citations = parsePairSet(body.citations, 'corpus_id', 'source_uri');
  if (!resolvedCorpora || !citations) {
    return { kind: 'error', error: 'invalid_response', http_status: result.httpStatus };
  }
  return {
    kind: 'domain_answer',
    status: body.status,
    answer: body.answer,
    resolved_corpora: resolvedCorpora,
    citations,
    retrieved_context_count: body.retrieved_context_count,
    retrieval_plan: sortJsonKeys(body.retrieval_plan),
    contract_keys: Object.keys(body).sort(),
    policy: sortJsonKeys(body.policy),
  };
}

function parsePairSet<First extends string, Second extends string>(
  values: unknown[],
  first: First,
  second: Second,
): Array<Record<First | Second, string>> | undefined {
  const unique = new Map<string, Record<First | Second, string>>();
  for (const value of values) {
    const record = asRecord(value);
    if (typeof record?.[first] !== 'string' || typeof record[second] !== 'string') return undefined;
    const pair = { [first]: record[first], [second]: record[second] } as Record<First | Second, string>;
    unique.set(`${record[first]}\0${record[second]}`, pair);
  }
  return [...unique.entries()].sort(([left], [right]) => compareStrings(left, right)).map(([, pair]) => pair);
}

function setOverlapFraction(baseline: CitationSourcePair[], candidate: CitationSourcePair[]): number {
  const baselineKeys = new Set(baseline.map(citationPairKey));
  const candidateKeys = new Set(candidate.map(citationPairKey));
  const union = new Set([...baselineKeys, ...candidateKeys]);
  if (union.size === 0) return 1;
  let intersectionSize = 0;
  for (const key of baselineKeys) if (candidateKeys.has(key)) intersectionSize += 1;
  return intersectionSize / union.size;
}

function citationPairKey(value: CitationSourcePair): string {
  return `${value.corpus_id}\0${value.source_uri}`;
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortJsonKeys(record[key])]));
}

function collectDifferingJsonPaths(
  baseline: unknown,
  candidate: unknown,
  path: string,
  paths: string[],
): void {
  if (deepEqual(baseline, candidate)) return;
  if (Array.isArray(baseline) && Array.isArray(candidate)) {
    const length = Math.max(baseline.length, candidate.length);
    for (let index = 0; index < length; index += 1) {
      if (index >= baseline.length || index >= candidate.length) paths.push(`${path}[${index}]`);
      else collectDifferingJsonPaths(baseline[index], candidate[index], `${path}[${index}]`, paths);
    }
    return;
  }
  const baselineRecord = asRecord(baseline);
  const candidateRecord = asRecord(candidate);
  if (baselineRecord && candidateRecord) {
    const keys = [...new Set([...Object.keys(baselineRecord), ...Object.keys(candidateRecord)])].sort();
    for (const key of keys) {
      const childPath = jsonChildPath(path, key);
      if (!Object.hasOwn(baselineRecord, key) || !Object.hasOwn(candidateRecord, key)) paths.push(childPath);
      else collectDifferingJsonPaths(baselineRecord[key], candidateRecord[key], childPath, paths);
    }
    return;
  }
  paths.push(path);
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function jsonChildPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
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
    throw new Error(`Invalid parity battery at ${path}: expected an object.`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid parity battery at ${path}: expected a non-empty string.`);
  }
  return value;
}

if (import.meta.main) {
  try {
    const receipt = await runParityBatteryCli(process.argv.slice(2));
    console.log(`Parity battery complete: ${receipt.summary.parity} parity, ${receipt.summary.divergence} divergence, ${receipt.summary.error} error.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Parity battery failed.');
    process.exitCode = 1;
  }
}
