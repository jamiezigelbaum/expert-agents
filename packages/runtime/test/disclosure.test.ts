import { describe, expect, test } from 'bun:test';
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
  resolveDisclosurePolicy,
  sourceSessionBudgetChars,
  validateAgentDisclosureConfig,
  type DisclosureExcerptCandidate,
} from '../src/core/disclosure.ts';

const DISCLOSED_CORPUS = 'disclosed-library';
const LIBRARY = { bucket: 'fixture-shared-library', prefix: 'v1' };

/**
 * A routing entry whose disclosure block is present. Every corpus posture the
 * tests need is declared explicitly so nothing depends on an implicit default
 * except where a test says so.
 */
function servedRouting(options: {
  corpora?: Array<{ corpusId: string; disclosure: 'full' | 'derived' | 'excluded' }>;
  bounds?: Record<string, number>;
} = {}) {
  return validateAgentRoutingConfig({
    served: {
      library: LIBRARY,
      pageLibrary: { sourceId: 'served' },
      disclosure: {
        ...(options.corpora ? { corpora: options.corpora } : {}),
        ...(options.bounds ? { bounds: options.bounds } : {}),
      },
    },
  });
}

/** The same agent with the disclosure block removed: today's behaviour. */
function unservedRouting() {
  return validateAgentRoutingConfig({
    served: { library: LIBRARY, pageLibrary: { sourceId: 'served' } },
  });
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
        library: LIBRARY,
        pageLibrary: { sourceId: 'served' },
        disclosure: { corpora: [{ corpusId: 'a', disclosure: 'nonsense' }] },
      },
    })).toThrow(AgentRoutingConfigError);
    expect(servedRouting().served?.disclosure).toEqual({});
  });

  test('a routing entry with no disclosure block leaves the posture undeclared', () => {
    expect(unservedRouting().served).not.toHaveProperty('disclosure');
  });

  test('the session budget is the coverage fraction of a known extent', () => {
    expect(sourceSessionBudgetChars(DISCLOSURE_BOUND_DEFAULTS, 100_000)).toBe(20_000);
  });

  test('an unreported extent falls back to the assumed extent, not to one response', () => {
    // 20% of the assumed 150k, which is the common path: no extent is reported
    // for the document, and collapsing onto one response's allowance there
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
