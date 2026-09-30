import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentRoutingConfigError,
  validateAgentRoutingConfig,
} from '../src/core/agent-routing.ts';
import {
  DISCLOSURE_BOUND_DEFAULTS,
  DISCLOSURE_REFUSAL_CODES,
  DisclosureConfigError,
  DisclosureSessionLedger,
  DisclosureSessionStore,
  discloseExcerpts,
  disclosureRefusal,
  partitionCorporaByDisclosure,
  resolveDisclosurePolicy,
  sourceSessionBudgetChars,
  validateAgentDisclosureConfig,
  type DisclosureExcerptCandidate,
} from '../src/core/disclosure.ts';
import {
  createDomainExpertWorker,
  type DomainExpertWorkerOptions,
} from '../src/workers/domain-expert/index.ts';

const CORPUS_RESOURCE = 'projects/fixture-project/locations/us-central1/ragCorpora/2002';
const DISCLOSED_CORPUS = 'disclosed-library';

interface CapturedCall {
  url: string;
  method: string;
  body: string;
}

/**
 * A routing entry whose disclosure block is present. Every corpus posture the
 * tests need is declared explicitly so nothing depends on an implicit default
 * except where a test says so.
 */
function servedRouting(options: {
  corpora?: Array<{ corpusId: string; disclosure: 'full' | 'derived' | 'excluded' }>;
  bounds?: Record<string, number>;
  targetCorpusDisplayName?: string;
} = {}) {
  return validateAgentRoutingConfig({
    served: {
      library: { bucket: 'fixture-shared-library', prefix: 'v1' },
      targetCorpusDisplayName: options.targetCorpusDisplayName ?? DISCLOSED_CORPUS,
      retrieval: { multiQuery: false, reranker: 'off' },
      disclosure: {
        ...(options.corpora ? { corpora: options.corpora } : {}),
        ...(options.bounds ? { bounds: options.bounds } : {}),
      },
    },
  });
}

/** The same agent with the disclosure block removed: today's behaviour. */
function unservedRouting(targetCorpusDisplayName: string = DISCLOSED_CORPUS) {
  return validateAgentRoutingConfig({
    served: {
      library: { bucket: 'fixture-shared-library', prefix: 'v1' },
      targetCorpusDisplayName,
      retrieval: { multiQuery: false, reranker: 'off' },
    },
  });
}

function makeWorker(
  routing: ReturnType<typeof validateAgentRoutingConfig>,
  calls: CapturedCall[],
  contexts: Array<Record<string, unknown>>,
  extra: DomainExpertWorkerOptions = {},
) {
  return createDomainExpertWorker({
    agentRouting: routing,
    gcpProject: 'fixture-project',
    dataDir: mkdtempSync(join(tmpdir(), 'expert-agents-disclosure-')),
    google: {
      accessToken: 'fixture-google-token',
      fetchImpl: fakeGoogleFetch(calls, contexts, routing),
    },
    ...extra,
  });
}

function fakeGoogleFetch(
  calls: CapturedCall[],
  contexts: Array<Record<string, unknown>>,
  routing: ReturnType<typeof validateAgentRoutingConfig>,
): typeof fetch {
  const displayName = routing.served!.targetCorpusDisplayName;
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? await new Response(init.body as BodyInit).text() : '';
    calls.push({ url, method, body });

    if (url.endsWith(':retrieveContexts')) {
      return jsonResponse({ contexts: { contexts } });
    }
    if (url.includes(':generateContent')) {
      return jsonResponse({ candidates: [{ content: { parts: [{ text: 'Fixture answer.' }] } }] });
    }
    if (method === 'GET' && new URL(url).pathname.endsWith('/ragFiles')) {
      return jsonResponse({
        ragFiles: [
          { name: `${CORPUS_RESOURCE}/ragFiles/1`, displayName: 'Neutral Holding One' },
          { name: `${CORPUS_RESOURCE}/ragFiles/2`, displayName: 'Neutral Holding Two' },
        ],
      });
    }
    if (method === 'GET' && new URL(url).pathname.endsWith('/ragCorpora')) {
      return jsonResponse({ ragCorpora: [{ name: CORPUS_RESOURCE, displayName }] });
    }
    if (method === 'GET' && new URL(url).pathname.includes('/ragCorpora/')) {
      return jsonResponse({ name: CORPUS_RESOURCE, displayName });
    }
    return jsonResponse({ error: 'unexpected fixture URL' }, 500);
  }) as typeof fetch;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function context(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `fixture-context-${Math.random().toString(36).slice(2)}`,
    text: 'neutral fixture evidence',
    sourceUri: 'gs://fixture-shared-library/neutral-source.pdf',
    sourceDisplayName: 'Neutral Fixture Source',
    score: 0.9,
    ...overrides,
  };
}

function ask(
  worker: { fetch(request: Request): Promise<Response> },
  params: Record<string, unknown>,
): Promise<Response> {
  return worker.fetch(new Request('http://worker.test/v1/domain', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'domain_ask', params: { domain_id: 'served', ...params } }),
  }));
}

async function askJson(
  worker: { fetch(request: Request): Promise<Response> },
  params: Record<string, unknown>,
): Promise<Record<string, any>> {
  const response = await ask(worker, params);
  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, any>>;
}

function generateAnswerPrompt(calls: CapturedCall[]): string {
  const call = calls.filter((entry) => entry.url.includes(':generateContent')).at(-1);
  return JSON.parse(call!.body).contents[0].parts[0].text as string;
}

describe('disclosure configuration', () => {
  test('excerpt bounds default to the owner policy values', () => {
    expect(DISCLOSURE_BOUND_DEFAULTS).toEqual({
      maxQuoteChars: 1500,
      maxQuotesPerSource: 5,
      maxSourceCoveragePerSession: 0.2,
      assumedSourceChars: 150_000,
    });
    expect(resolveDisclosurePolicy({}).bounds).toEqual(DISCLOSURE_BOUND_DEFAULTS);
  });

  test('a declared bound overrides only itself and leaves the other policy values intact', () => {
    const policy = resolveDisclosurePolicy({ bounds: { maxQuoteChars: 400 } });
    expect(policy.bounds).toEqual({
      maxQuoteChars: 400,
      maxQuotesPerSource: 5,
      maxSourceCoveragePerSession: 0.2,
      assumedSourceChars: 150_000,
    });
  });

  test('a corpus that declares no posture defaults to full', () => {
    const policy = resolveDisclosurePolicy({
      corpora: [{ corpusId: 'held-back', disclosure: 'derived' }],
    });
    expect(policy.postureFor('held-back')).toBe('derived');
    expect(policy.postureFor('undeclared-corpus')).toBe('full');
  });

  test('disclosure config rejects duplicate corpus ids, unknown postures, unknown fields, and bad bounds', () => {
    expect(() => validateAgentDisclosureConfig({
      corpora: [
        { corpusId: 'a', disclosure: 'full' },
        { corpusId: 'a', disclosure: 'derived' },
      ],
    })).toThrow(DisclosureConfigError);
    expect(() => validateAgentDisclosureConfig({
      corpora: [{ corpusId: 'a', disclosure: 'partial' }],
    })).toThrow(DisclosureConfigError);
    expect(() => validateAgentDisclosureConfig({ corpora: [] })).toThrow(DisclosureConfigError);
    expect(() => validateAgentDisclosureConfig({ unknown: true })).toThrow(DisclosureConfigError);
    expect(() => validateAgentDisclosureConfig({ bounds: { maxQuoteChars: 0 } })).toThrow(DisclosureConfigError);
    expect(() => validateAgentDisclosureConfig({ bounds: { maxSourceCoveragePerSession: 1.5 } }))
      .toThrow(DisclosureConfigError);
  });

  test('routing rejects an invalid disclosure block and accepts a well-formed one', () => {
    expect(() => validateAgentRoutingConfig({
      served: {
        library: { bucket: 'fixture-shared-library', prefix: 'v1' },
        targetCorpusDisplayName: DISCLOSED_CORPUS,
        disclosure: { corpora: [{ corpusId: 'a', disclosure: 'nonsense' }] },
      },
    })).toThrow(AgentRoutingConfigError);
    expect(servedRouting().served?.disclosure).toEqual({});
  });

  test('a routing entry with no disclosure block leaves the posture undeclared', () => {
    expect(unservedRouting().served).not.toHaveProperty('disclosure');
  });

  test('partitioning separates disclosable corpora from derived and excluded ones', () => {
    const policy = resolveDisclosurePolicy({
      corpora: [
        { corpusId: 'held-back', disclosure: 'derived' },
        { corpusId: 'absent', disclosure: 'excluded' },
      ],
    });
    expect(partitionCorporaByDisclosure(policy, ['open', 'held-back', 'absent'])).toEqual({
      disclosable: ['open'],
      withheld: [
        { corpusId: 'held-back', disclosure: 'derived' },
        { corpusId: 'absent', disclosure: 'excluded' },
      ],
    });
  });

  test('the session budget is the coverage fraction of a known extent', () => {
    expect(sourceSessionBudgetChars(DISCLOSURE_BOUND_DEFAULTS, 100_000)).toBe(20_000);
  });

  test('an unreported extent falls back to the assumed extent, not to one response', () => {
    // 20% of the assumed 150k, which is the common path: Vertex reports no
    // document extent, and collapsing onto one response's allowance there
    // would be far tighter than the stated coverage policy.
    expect(sourceSessionBudgetChars(DISCLOSURE_BOUND_DEFAULTS)).toBe(30_000);
    expect(sourceSessionBudgetChars(DISCLOSURE_BOUND_DEFAULTS, 0)).toBe(30_000);
    expect(sourceSessionBudgetChars({ ...DISCLOSURE_BOUND_DEFAULTS, assumedSourceChars: 50_000 })).toBe(10_000);
  });

  test('a misconfigured assumption cannot refuse the very first question', () => {
    const oneResponse = DISCLOSURE_BOUND_DEFAULTS.maxQuoteChars * DISCLOSURE_BOUND_DEFAULTS.maxQuotesPerSource;
    expect(sourceSessionBudgetChars({ ...DISCLOSURE_BOUND_DEFAULTS, assumedSourceChars: 1_000 })).toBe(oneResponse);
  });

  test('the floor never loosens a bound derived from a real extent', () => {
    // A short KNOWN source must still yield a small budget. Raising it to one
    // response's allowance would hand out most of a short document.
    expect(sourceSessionBudgetChars(DISCLOSURE_BOUND_DEFAULTS, 10_000)).toBe(2_000);
    expect(sourceSessionBudgetChars(DISCLOSURE_BOUND_DEFAULTS, 100)).toBe(20);
  });

  test('the session store evicts least-recently-used ledgers at its capacity', () => {
    const store = new DisclosureSessionStore(2);
    const first = store.ledgerFor('one');
    store.ledgerFor('two');
    store.ledgerFor('one');
    store.ledgerFor('three');
    expect(store.size).toBe(2);
    expect(store.ledgerFor('one')).toBe(first);
    expect(store.ledgerFor('three')).not.toBe(first);
  });
});

describe('disclosure excerpt bounds', () => {
  const policy = resolveDisclosurePolicy({});
  // A pinned assumed extent so the coverage tests exercise the refusal
  // mechanism at a known budget rather than tracking whatever the current
  // owner policy value happens to be. 37,500 x 0.2 = 7,500.
  const tightCoveragePolicy = resolveDisclosurePolicy({ bounds: { assumedSourceChars: 37_500 } });

  function candidate(overrides: Partial<DisclosureExcerptCandidate> = {}): DisclosureExcerptCandidate {
    return { corpusId: DISCLOSED_CORPUS, sourceKey: 'uri:one', text: 'x', ...overrides };
  }

  test('an excluded work is withheld by display name or uri, spends no budget, and everything else still serves', () => {
    const excluding = resolveDisclosurePolicy({ excludedSources: [{ displayName: 'Withheld Work' }, { uri: 'gs://lib/private.pdf' }] });
    const ledger = new DisclosureSessionLedger();
    const result = discloseExcerpts(excluding, ledger, [
      candidate({ sourceKey: 'uri:gs://lib/open.pdf', sourceKeys: ['uri:gs://lib/open.pdf', 'display:Open Work'], text: 'served' }),
      candidate({ sourceKey: 'uri:gs://lib/w.pdf', sourceKeys: ['uri:gs://lib/w.pdf', 'display:Withheld Work'], text: 'hidden' }),
      candidate({ sourceKey: 'uri:gs://lib/private.pdf', sourceKeys: ['uri:gs://lib/private.pdf'], text: 'hidden' }),
    ]);
    expect(result.status).toBe('disclosed');
    if (result.status !== 'disclosed') return;
    expect(result.decisions.map((decision) => decision.kind)).toEqual(['disclosed', 'withheld', 'withheld']);
    expect(result.decisions[1]).toEqual({ kind: 'withheld', reason: 'source_excluded' });
    expect(result.summary).toEqual({ excerptsDisclosed: 1, excerptsTruncated: 0, excerptsWithheld: 2 });
    expect(ledger.charsDisclosed('uri:gs://lib/w.pdf')).toBe(0);
    // The default policy excludes nothing: the whole shelf serves.
    expect(policy.excludedSourceKeys.size).toBe(0);
  });

  test('excludedSources config rejects malformed and duplicate entries', () => {
    expect(() => validateAgentDisclosureConfig({ excludedSources: 'x' })).toThrow(DisclosureConfigError);
    expect(() => validateAgentDisclosureConfig({ excludedSources: [{ displayName: 'a', uri: 'b' }] })).toThrow(DisclosureConfigError);
    expect(() => validateAgentDisclosureConfig({ excludedSources: [{ title: 'a' }] })).toThrow(DisclosureConfigError);
    expect(() => validateAgentDisclosureConfig({ excludedSources: [{ uri: 'a' }, { uri: 'a' }] })).toThrow(DisclosureConfigError);
    expect(validateAgentDisclosureConfig({ excludedSources: [{ uri: 'a' }, { displayName: 'b' }] }).excludedSources)
      .toEqual([{ uri: 'a' }, { displayName: 'b' }]);
  });

  test('a quote exactly at the character bound is untouched and one character over is bounded', () => {
    const ledger = new DisclosureSessionLedger();
    const atBound = discloseExcerpts(policy, ledger, [candidate({ text: 'a'.repeat(1500) })]);
    expect(atBound.status).toBe('disclosed');
    expect(atBound.status === 'disclosed' && atBound.decisions[0]).toEqual({
      kind: 'disclosed',
      text: 'a'.repeat(1500),
      chars: 1500,
      truncated: false,
    });

    const overBound = discloseExcerpts(resolveDisclosurePolicy({}), new DisclosureSessionLedger(), [
      candidate({ text: 'a'.repeat(1501) }),
    ]);
    expect(overBound.status === 'disclosed' && overBound.decisions[0]).toEqual({
      kind: 'disclosed',
      text: 'a'.repeat(1500),
      chars: 1500,
      truncated: true,
    });
    expect(overBound.status === 'disclosed' && overBound.summary.excerptsTruncated).toBe(1);
  });

  test('the fifth quote from one source is disclosed and the sixth is withheld', () => {
    const result = discloseExcerpts(
      policy,
      new DisclosureSessionLedger(),
      Array.from({ length: 6 }, () => candidate({ text: 'evidence' })),
    );
    expect(result.status).toBe('disclosed');
    if (result.status !== 'disclosed') return;
    expect(result.decisions.filter((decision) => decision.kind === 'disclosed')).toHaveLength(5);
    expect(result.decisions[5]).toEqual({ kind: 'withheld', reason: 'quotes_per_source' });
    expect(result.summary).toEqual({ excerptsDisclosed: 5, excerptsTruncated: 0, excerptsWithheld: 1 });
  });

  test('the quotes-per-source bound is counted per source, not per response', () => {
    const result = discloseExcerpts(policy, new DisclosureSessionLedger(), [
      ...Array.from({ length: 5 }, () => candidate({ sourceKey: 'uri:one' })),
      ...Array.from({ length: 5 }, () => candidate({ sourceKey: 'uri:two' })),
    ]);
    expect(result.status === 'disclosed' && result.summary.excerptsDisclosed).toBe(10);
    expect(result.status === 'disclosed' && result.summary.excerptsWithheld).toBe(0);
  });

  test('an excerpt with no attributable source is withheld because citation is mandatory', () => {
    const result = discloseExcerpts(policy, new DisclosureSessionLedger(), [
      { corpusId: DISCLOSED_CORPUS, text: 'unattributable evidence' },
    ]);
    expect(result.status === 'disclosed' && result.decisions[0]).toEqual({
      kind: 'withheld',
      reason: 'uncitable',
    });
  });

  test('cumulative coverage refuses at the bound and the refusal spends no session budget', () => {
    const ledger = new DisclosureSessionLedger();
    const first = discloseExcerpts(tightCoveragePolicy, ledger, [candidate({ text: 'a'.repeat(1500) })]);
    expect(first.status).toBe('disclosed');
    expect(ledger.charsDisclosed('uri:one')).toBe(1500);

    // Unknown extent against the pinned 37,500 assumption: budget is 7,500.
    const upToBound = discloseExcerpts(tightCoveragePolicy, ledger, [
      candidate({ text: 'a'.repeat(1500) }),
      candidate({ text: 'a'.repeat(1500) }),
      candidate({ text: 'a'.repeat(1500) }),
      candidate({ text: 'a'.repeat(1500) }),
    ]);
    expect(upToBound.status).toBe('disclosed');
    expect(ledger.charsDisclosed('uri:one')).toBe(7500);

    const crossed = discloseExcerpts(tightCoveragePolicy, ledger, [candidate({ text: 'a' })]);
    expect(crossed.status).toBe('refused');
    expect(crossed.status === 'refused' && crossed.refusal.code)
      .toBe(DISCLOSURE_REFUSAL_CODES.sourceCoverageExhausted);
    expect(ledger.charsDisclosed('uri:one')).toBe(7500);
  });

  test('a known source extent bounds the session at the configured coverage fraction', () => {
    const ledger = new DisclosureSessionLedger();
    const within = discloseExcerpts(policy, ledger, [
      candidate({ text: 'a'.repeat(1000), sourceChars: 10_000 }),
      candidate({ text: 'a'.repeat(1000), sourceChars: 10_000 }),
    ]);
    expect(within.status).toBe('disclosed');
    expect(ledger.charsDisclosed('uri:one')).toBe(2000);

    const crossed = discloseExcerpts(policy, ledger, [
      candidate({ text: 'a', sourceChars: 10_000 }),
    ]);
    expect(crossed.status).toBe('refused');
  });

  test('a refusal for one source does not commit the response for any other source', () => {
    const ledger = new DisclosureSessionLedger();
    ledger.commit(new Map([['uri:one', 7500]]));
    const result = discloseExcerpts(tightCoveragePolicy, ledger, [
      candidate({ sourceKey: 'uri:two', text: 'other evidence' }),
      candidate({ sourceKey: 'uri:one', text: 'more of the same source' }),
    ]);
    expect(result.status).toBe('refused');
    expect(ledger.charsDisclosed('uri:two')).toBe(0);
  });

  test('every refusal is typed and carries no content, source identity, or path', () => {
    for (const code of Object.values(DISCLOSURE_REFUSAL_CODES)) {
      const refusal = disclosureRefusal(code);
      expect(refusal.code).toBe(code);
      expect(refusal.message.length).toBeGreaterThan(0);
      const text = `${refusal.message} ${refusal.remediation}`;
      expect(text).not.toMatch(/gs:\/\/|https?:\/\/|\/Users\/|[A-Za-z]:\\/);
      expect(text).not.toContain(DISCLOSED_CORPUS);
    }
  });
});

describe('disclosure enforcement on the served retrieval path', () => {
  test('domain_ask refuses without a session id when a posture is declared', async () => {
    const calls: CapturedCall[] = [];
    const worker = makeWorker(servedRouting(), calls, [context()]);
    const response = await ask(worker, { question: 'What does the library hold?' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: DISCLOSURE_REFUSAL_CODES.sessionRequired },
    });
    expect(calls.filter((call) => call.url.endsWith(':retrieveContexts'))).toHaveLength(0);
  });

  test('an explicitly requested derived corpus is refused before retrieval executes', async () => {
    const calls: CapturedCall[] = [];
    const worker = makeWorker(
      servedRouting({ corpora: [{ corpusId: DISCLOSED_CORPUS, disclosure: 'derived' }] }),
      calls,
      [context()],
    );
    const response = await ask(worker, {
      question: 'Quote the held-back sources.',
      corpus_id: DISCLOSED_CORPUS,
      session_id: 'fixture-session',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: DISCLOSURE_REFUSAL_CODES.corpusNotDisclosable },
    });
    expect(calls).toHaveLength(0);
  });

  test('an excluded corpus is absent from the default corpus set before retrieval executes', async () => {
    const calls: CapturedCall[] = [];
    const worker = makeWorker(
      servedRouting({ corpora: [{ corpusId: DISCLOSED_CORPUS, disclosure: 'excluded' }] }),
      calls,
      [context()],
    );
    const response = await ask(worker, {
      question: 'What is in the library?',
      session_id: 'fixture-session',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: DISCLOSURE_REFUSAL_CODES.noDisclosableCorpus },
    });
    expect(calls).toHaveLength(0);
  });

  test('a derived corpus is unreachable from every corpus-scoped surface, not only domain_ask', async () => {
    const calls: CapturedCall[] = [];
    const worker = makeWorker(
      servedRouting({ corpora: [{ corpusId: DISCLOSED_CORPUS, disclosure: 'derived' }] }),
      calls,
      [context()],
    );
    const response = await worker.fetch(new Request('http://worker.test/v1/domain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tool: 'rag_corpus',
        params: { domain_id: 'served', action: 'list_files', corpus_id: DISCLOSED_CORPUS },
      }),
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: DISCLOSURE_REFUSAL_CODES.corpusNotDisclosable },
    });
    expect(calls).toHaveLength(0);
  });

  // The posture is declared against a display name, but a caller may spell the
  // same corpus as a numeric id or a full resource name. Those spellings once
  // resolved to a posture of their own — the default, `full` — and so walked
  // straight past a derived corpus.
  for (const spelling of [
    { name: 'numeric id', corpusId: '2002' },
    { name: 'full resource name', corpusId: CORPUS_RESOURCE },
  ]) {
    test(`a derived corpus is still refused when it is named by its ${spelling.name}`, async () => {
      const calls: CapturedCall[] = [];
      const worker = makeWorker(
        servedRouting({ corpora: [{ corpusId: DISCLOSED_CORPUS, disclosure: 'derived' }] }),
        calls,
        [context()],
      );
      const response = await ask(worker, {
        question: 'Quote the held-back sources.',
        corpus_id: spelling.corpusId,
        session_id: 'fixture-session',
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: DISCLOSURE_REFUSAL_CODES.corpusNotDisclosable },
      });
      // Identifying the corpus is allowed to cost a lookup; reading it is not.
      expect(calls.filter((call) => call.url.endsWith(':retrieveContexts'))).toHaveLength(0);
    });
  }

  test('holdings listing stays permitted and truthful for a disclosed corpus', async () => {
    const calls: CapturedCall[] = [];
    const worker = makeWorker(servedRouting(), calls, [context()]);
    const response = await worker.fetch(new Request('http://worker.test/v1/domain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tool: 'rag_corpus',
        params: { domain_id: 'served', action: 'list_files', corpus_id: DISCLOSED_CORPUS },
      }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    expect(body.kind).toBe('rag_corpus_files');
    expect(body.files.map((file: Record<string, unknown>) => file.displayName))
      .toEqual(['Neutral Holding One', 'Neutral Holding Two']);
  });

  test('a served answer bounds each quote, cites every excerpt, and reports the bounds it applied', async () => {
    const calls: CapturedCall[] = [];
    const worker = makeWorker(servedRouting(), calls, [
      context({ id: 'c1', text: 'a'.repeat(4000) }),
      context({ id: 'c2', text: 'b'.repeat(1500) }),
    ]);
    const body = await askJson(worker, {
      question: 'Summarize the disclosed corpus.',
      session_id: 'fixture-session',
    });

    expect(body.disclosure).toEqual({
      posture_declared: true,
      citation_required: true,
      bounds: {
        max_quote_chars: 1500,
        max_quotes_per_source: 5,
        max_source_coverage_per_session: 0.2,
      },
      corpora: [{ corpus_id: DISCLOSED_CORPUS, disclosure: 'full' }],
      withheld_corpus_count: 0,
      excerpts_disclosed: 2,
      excerpts_truncated: 1,
      excerpts_withheld: 0,
    });
    // The plan echo is narrowed to what was disclosable, never to what was asked for.
    expect(body.retrieval_plan.corpora).toEqual([DISCLOSED_CORPUS]);
    expect(body.citations).toHaveLength(2);
    for (const citation of body.citations) {
      expect(citation.citation_id).toBeTruthy();
      expect(citation.source_display_name || citation.source_uri).toBeTruthy();
    }
    const prompt = generateAnswerPrompt(calls);
    expect(prompt).not.toContain('a'.repeat(1501));
    expect(prompt).toContain('a'.repeat(1500));
  });

  test('a served answer withholds the sixth excerpt from one source and reports the count', async () => {
    const calls: CapturedCall[] = [];
    const worker = makeWorker(
      servedRouting(),
      calls,
      Array.from({ length: 6 }, (_unused, index) => context({ id: `c${index}`, text: 'evidence' })),
    );
    const body = await askJson(worker, {
      question: 'Give me everything from that source.',
      session_id: 'fixture-session',
    });
    expect(body.retrieved_context_count).toBe(5);
    expect(body.disclosure.excerpts_disclosed).toBe(5);
    expect(body.disclosure.excerpts_withheld).toBe(1);
  });

  test('a served answer withholds an excerpt that cannot be cited', async () => {
    const calls: CapturedCall[] = [];
    const worker = makeWorker(servedRouting(), calls, [
      context({ id: 'cited', text: 'attributable evidence' }),
      { id: 'uncited', text: 'unattributable evidence', score: 0.5 },
    ]);
    const body = await askJson(worker, {
      question: 'What is known?',
      session_id: 'fixture-session',
    });
    expect(body.disclosure.excerpts_withheld).toBe(1);
    expect(body.citations).toHaveLength(1);
    expect(generateAnswerPrompt(calls)).not.toContain('unattributable evidence');
  });

  test('cumulative per-source coverage refuses a later question in the same session', async () => {
    const calls: CapturedCall[] = [];
    const worker = makeWorker(
      servedRouting({ bounds: { assumedSourceChars: 37_500 } }),
      calls,
      Array.from({ length: 5 }, (_unused, index) => context({ id: `c${index}`, text: 'a'.repeat(1500) })),
    );
    const first = await askJson(worker, {
      question: 'First question.',
      session_id: 'walker',
    });
    expect(first.disclosure.excerpts_disclosed).toBe(5);

    const second = await ask(worker, { question: 'Keep going.', session_id: 'walker' });
    expect(second.status).toBe(403);
    const refusal = await second.json() as Record<string, any>;
    expect(refusal.error.code).toBe(DISCLOSURE_REFUSAL_CODES.sourceCoverageExhausted);
    expect(JSON.stringify(refusal)).not.toContain('aaaa');
    expect(JSON.stringify(refusal)).not.toContain('gs://');
    expect(JSON.stringify(refusal)).not.toContain('Neutral Fixture Source');

    // A different session starts with its own budget: the bound is per session.
    const other = await askJson(worker, { question: 'Fresh engagement.', session_id: 'other' });
    expect(other.disclosure.excerpts_disclosed).toBe(5);
  });

  test('a coverage refusal spends no budget, so a narrower question in the same session still answers', async () => {
    const calls: CapturedCall[] = [];
    const worker = makeWorker(
      servedRouting({ bounds: { maxQuoteChars: 100, maxQuotesPerSource: 2, assumedSourceChars: 1_000 } }),
      calls,
      [context({ id: 'c1', text: 'a'.repeat(100) }), context({ id: 'c2', text: 'b'.repeat(100) })],
    );
    // Budget for an unknown extent is maxQuoteChars * maxQuotesPerSource = 200.
    const first = await askJson(worker, { question: 'One.', session_id: 'narrow' });
    expect(first.disclosure.excerpts_disclosed).toBe(2);
    const refused = await ask(worker, { question: 'Two.', session_id: 'narrow' });
    expect(refused.status).toBe(403);
    const fresh = await askJson(worker, { question: 'Three.', session_id: 'narrow-2' });
    expect(fresh.disclosure.excerpts_disclosed).toBe(2);
  });

  test('a reported source extent widens the session budget to the configured coverage fraction', async () => {
    const calls: CapturedCall[] = [];
    const worker = makeWorker(servedRouting(), calls, [
      context({ id: 'c1', text: 'a'.repeat(1500), sourceCharCount: 1_000_000 }),
    ]);
    for (const question of ['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.']) {
      const body = await askJson(worker, { question, session_id: 'long-source' });
      expect(body.disclosure.excerpts_disclosed).toBe(1);
    }
  });
});

describe('disclosure parity for an agent with no declared posture', () => {
  const legacyContexts = [
    context({
      id: 'legacy-1',
      text: 'a'.repeat(9000),
      sourceUri: 'gs://fixture-shared-library/neutral-source.pdf',
      sourceDisplayName: 'Neutral Fixture Source',
    }),
  ];

  test('parity: the domain_ask response is exactly the pre-disclosure shape, with no added key', async () => {
    const calls: CapturedCall[] = [];
    const worker = makeWorker(unservedRouting(), calls, legacyContexts);
    const body = await askJson(worker, { question: 'What is in the library?' });

    expect(body).toEqual({
      kind: 'domain_answer',
      status: 'answered',
      domain_id: 'served',
      question: 'What is in the library?',
      answer: 'Fixture answer.',
      citations: [{
        citation_id: `${DISCLOSED_CORPUS}:1`,
        corpus_id: DISCLOSED_CORPUS,
        source_display_name: 'Neutral Fixture Source',
        source_uri: 'gs://fixture-shared-library/neutral-source.pdf',
        score: 0.9,
      }],
      retrieved_context_count: 1,
      resolved_corpora: [{
        requested: DISCLOSED_CORPUS,
        corpus_id: '2002',
        resource_name: CORPUS_RESOURCE,
        display_name: DISCLOSED_CORPUS,
      }],
      retrieval_plan: {
        backend: 'vertex-rag',
        configuration_required: true,
        gcp_project: 'fixture-project',
        location: 'us-central1',
        corpora: [DISCLOSED_CORPUS],
        candidate_top_k: 30,
        synthesis_context_limit: 12,
        reranker: { mode: 'off', model: 'semantic-ranker-default@latest' },
        multi_query: { enabled: false, max_queries: 3 },
        cross_corpus_retrieval: true,
      },
      policy: {
        expert_agents_control_plane_only: true,
        backend: 'gemini_enterprise_rag_engine',
        host_source_contracts_unchanged: true,
        per_question_answer_logic_in_runtime: false,
        raw_runtime_secrets_exposed: false,
        cloud_corpus_requires_source_review: true,
        direct_google_doc_edits_require_approval: true,
      },
    });
    expect(Object.keys(body)).not.toContain('disclosure');
  });

  test('parity: no bound is applied to quote length, quote count, or cumulative session volume', async () => {
    const calls: CapturedCall[] = [];
    const worker = makeWorker(
      unservedRouting(),
      calls,
      Array.from({ length: 12 }, (_unused, index) => context({
        id: `legacy-${index}`,
        text: `${index}`.padEnd(5000, 'z'),
      })),
    );

    for (const question of ['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.']) {
      const body = await askJson(worker, { question });
      // answerContextLimit caps at 12; nothing is withheld by disclosure.
      expect(body.retrieved_context_count).toBe(12);
      expect(body).not.toHaveProperty('disclosure');
      const prompt = generateAnswerPrompt(calls);
      // generateAnswer's own pre-existing 4000-character slice still applies;
      // the disclosure bound of 1500 does not.
      expect(prompt).toContain('z'.repeat(3000));
    }
  });

  test('parity: a session id is ignored and changes neither the response nor the Google calls', async () => {
    const withoutSession: CapturedCall[] = [];
    const withSession: CapturedCall[] = [];
    const plainWorker = makeWorker(unservedRouting(), withoutSession, legacyContexts);
    const sessionWorker = makeWorker(unservedRouting(), withSession, legacyContexts);

    const plain = await askJson(plainWorker, { question: 'Identical question.' });
    const withId = await askJson(sessionWorker, {
      question: 'Identical question.',
      session_id: 'ignored-when-no-posture-is-declared',
    });

    expect(withId).toEqual(plain);
    expect(withSession.map((call) => ({ url: call.url, method: call.method, body: call.body })))
      .toEqual(withoutSession.map((call) => ({ url: call.url, method: call.method, body: call.body })));
  });

  test('parity: an unconfigured corpus id fails as an authorization refusal, never as a disclosure refusal', async () => {
    const calls: CapturedCall[] = [];
    const worker = makeWorker(unservedRouting(), calls, legacyContexts);
    const response = await ask(worker, {
      question: 'Ask a corpus this domain is not routed to.',
      corpus_id: 'absent-library',
    });
    expect(response.status).toBe(403);
    const body = await response.json() as Record<string, any>;
    expect(body).toMatchObject({ error: { code: 'rag_corpus_not_configured_for_domain' } });
    // The parity that matters: an agent with no declared posture never sees a
    // disclosure code, and the refusal costs no cloud call.
    expect(body.error.code).not.toStartWith('disclosure_');
    expect(calls).toHaveLength(0);
  });

  test('parity: no disclosure session ledger is created for an agent without a posture', async () => {
    const calls: CapturedCall[] = [];
    const worker = makeWorker(unservedRouting(), calls, legacyContexts);
    for (const question of ['One.', 'Two.', 'Three.']) {
      await askJson(worker, { question, session_id: 'unused' });
    }
    // Reaching here without a refusal is the assertion: an undeclared posture
    // never consults, and never fills, a session ledger.
    expect(calls.filter((call) => call.url.endsWith(':retrieveContexts'))).toHaveLength(3);
  });
});
