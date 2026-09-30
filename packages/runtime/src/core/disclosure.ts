/**
 * Disclosure enforcement for served deployments.
 *
 * The worker mediates every corpus read, which makes it the structural layer
 * for disclosure: a quote bound enforced here is a guarantee, the same rule
 * written into a prompt is a hope
 * (`docs/AGENT_REPO_CONTRACT.md`, deployment posture).
 *
 * Absence of a declared posture means no constraint is applied. An agent whose
 * routing entry carries no `disclosure` block never reaches this module, so
 * existing tracking deployments behave exactly as they did before it existed.
 *
 * The vocabulary here mirrors `AgentServingCorpus` in
 * `@expert-agents/provisioning` (`corpusId` + `disclosure`, and the same three
 * literals). The runtime does not depend on that package, so the shape is
 * restated rather than imported; it is deliberately not a parallel vocabulary.
 */

/** What a served deployment may retrieve from one library corpus. */
export const DISCLOSURE_POSTURES = ['full', 'derived', 'excluded'] as const;
export type DisclosurePosture = (typeof DISCLOSURE_POSTURES)[number];

/**
 * A corpus that declares no posture is `full`. Copyright defaults are
 * permissive by owner ruling (2026-07-28); the privacy defaults that point the
 * other way are structural file exclusions enforced at packaging time, not
 * here.
 */
export const DEFAULT_DISCLOSURE_POSTURE: DisclosurePosture = 'full';

export interface DisclosureBounds {
  /** Contiguous characters allowed in a single excerpt. */
  maxQuoteChars: number;
  /** Excerpts allowed from one source in a single response. */
  maxQuotesPerSource: number;
  /** Cumulative fraction, in (0, 1], of one source a session may be shown. */
  maxSourceCoveragePerSession: number;
  /**
   * Extent assumed for a source whose real length the retrieval layer does not
   * report, which is the common case. The coverage fraction is taken against
   * this. Lower it to tighten the cumulative bound.
   */
  assumedSourceChars: number;
}

/**
 * Owner policy values, deliberately generous pending a legal opinion. They
 * live here so a narrower answer changes a number rather than a design; they
 * must never be restated at a call site.
 */
export const DISCLOSURE_BOUND_DEFAULTS: DisclosureBounds = Object.freeze({
  maxQuoteChars: 1_500,
  maxQuotesPerSource: 5,
  maxSourceCoveragePerSession: 0.2,
  // Roughly a mid-length book. Chosen so the cumulative bound lands well above
  // a single response for the material these agents actually serve, rather
  // than collapsing onto it whenever a source's extent is unreported.
  assumedSourceChars: 150_000,
});

export interface DisclosureCorpusPosture {
  corpusId: string;
  disclosure: DisclosurePosture;
}

/**
 * One work a served deployment must never quote, even from a corpus whose
 * posture is `full`. Matched exactly against the retrieval layer's source
 * display name or source URI. This is a deny list on purpose: the owner ruled
 * (2026-09-09) that a public deployment serves the whole shared corpus by
 * default, so "everything except these" is the shape that stays small.
 */
export type DisclosureExcludedSource =
  | { displayName: string }
  | { uri: string };

export interface AgentDisclosureConfig {
  corpora?: DisclosureCorpusPosture[];
  bounds?: Partial<DisclosureBounds>;
  excludedSources?: DisclosureExcludedSource[];
}

export class DisclosureConfigError extends Error {
  readonly code = 'invalid_disclosure_config';

  constructor(message: string) {
    super(message);
    this.name = 'DisclosureConfigError';
  }
}

export const DISCLOSURE_REFUSAL_CODES = {
  corpusNotDisclosable: 'disclosure_corpus_not_disclosable',
  noDisclosableCorpus: 'disclosure_no_disclosable_corpus',
  sessionRequired: 'disclosure_session_required',
  sourceCoverageExhausted: 'disclosure_source_coverage_exhausted',
} as const;

export type DisclosureRefusalCode =
  (typeof DISCLOSURE_REFUSAL_CODES)[keyof typeof DISCLOSURE_REFUSAL_CODES];

/**
 * A refusal carries a code, a generic message, and a remediation. It never
 * carries the withheld text, a source identity, a corpus id, or a path.
 */
export interface DisclosureRefusal {
  code: DisclosureRefusalCode;
  status: number;
  message: string;
  remediation: string;
}

const REFUSALS: Readonly<Record<DisclosureRefusalCode, DisclosureRefusal>> = Object.freeze({
  [DISCLOSURE_REFUSAL_CODES.corpusNotDisclosable]: Object.freeze({
    code: DISCLOSURE_REFUSAL_CODES.corpusNotDisclosable,
    status: 403,
    message: 'The declared disclosure posture does not permit retrieval from a requested corpus.',
    remediation: 'Ask against a corpus this deployment discloses, or consult the accepted derived artifact that stands in for it.',
  }),
  [DISCLOSURE_REFUSAL_CODES.noDisclosableCorpus]: Object.freeze({
    code: DISCLOSURE_REFUSAL_CODES.noDisclosableCorpus,
    status: 403,
    message: 'No requested corpus is disclosable under the declared disclosure posture.',
    remediation: 'Ask against a corpus this deployment discloses.',
  }),
  [DISCLOSURE_REFUSAL_CODES.sessionRequired]: Object.freeze({
    code: DISCLOSURE_REFUSAL_CODES.sessionRequired,
    status: 400,
    message: 'A session id is required when a disclosure posture is declared.',
    remediation: 'Supply session_id so cumulative per-source disclosure can be bounded across the session.',
  }),
  [DISCLOSURE_REFUSAL_CODES.sourceCoverageExhausted]: Object.freeze({
    code: DISCLOSURE_REFUSAL_CODES.sourceCoverageExhausted,
    status: 403,
    message: 'Answering would cross the cumulative per-source disclosure bound for this session.',
    remediation: 'Narrow the question or begin a new session; bulk and sequential reconstruction of a source is refused rather than trimmed.',
  }),
});

export function disclosureRefusal(code: DisclosureRefusalCode): DisclosureRefusal {
  return REFUSALS[code];
}

/** A validated, resolved posture set with every default already applied. */
export interface DisclosurePolicy {
  readonly bounds: DisclosureBounds;
  readonly declared: readonly DisclosureCorpusPosture[];
  postureFor(corpusId: string): DisclosurePosture;
  /** Source keys (`uri:` or `display:` prefixed) this deployment never quotes. */
  readonly excludedSourceKeys: ReadonlySet<string>;
}

export function validateAgentDisclosureConfig(value: unknown): AgentDisclosureConfig {
  const record = requireRecord(value, 'a disclosure block must be an object');
  requireExactKeys(record, ['corpora', 'bounds', 'excludedSources'], 'a disclosure block');

  const config: AgentDisclosureConfig = {};
  if (record.corpora !== undefined) {
    if (!Array.isArray(record.corpora) || record.corpora.length === 0) {
      throw new DisclosureConfigError('a disclosure corpora list must be a non-empty array');
    }
    const seen = new Set<string>();
    config.corpora = record.corpora.map((entry) => {
      const corpus = requireRecord(entry, 'a disclosure corpus must be an object');
      requireExactKeys(corpus, ['corpusId', 'disclosure'], 'a disclosure corpus');
      const corpusId = requireNonEmptyString(corpus.corpusId, 'a disclosure corpusId');
      if (seen.has(corpusId)) {
        throw new DisclosureConfigError('a disclosure corpusId is declared more than once');
      }
      seen.add(corpusId);
      if (!isDisclosurePosture(corpus.disclosure)) {
        throw new DisclosureConfigError('a disclosure posture is not one of full, derived, or excluded');
      }
      return { corpusId, disclosure: corpus.disclosure };
    });
  }

  if (record.excludedSources !== undefined) {
    if (!Array.isArray(record.excludedSources)) {
      throw new DisclosureConfigError('disclosure excludedSources must be an array');
    }
    const seen = new Set<string>();
    config.excludedSources = record.excludedSources.map((entry) => {
      const source = requireRecord(entry, 'an excluded source must be an object');
      const keys = Object.keys(source);
      if (keys.length !== 1 || (keys[0] !== 'displayName' && keys[0] !== 'uri')) {
        throw new DisclosureConfigError('an excluded source must have exactly one of displayName or uri');
      }
      const key = keys[0] as 'displayName' | 'uri';
      const value = requireNonEmptyString(source[key], `an excluded source ${key}`);
      const sourceKey = key === 'uri' ? `uri:${value}` : `display:${value}`;
      if (seen.has(sourceKey)) {
        throw new DisclosureConfigError('an excluded source is declared more than once');
      }
      seen.add(sourceKey);
      return key === 'uri' ? { uri: value } : { displayName: value };
    });
  }

  if (record.bounds !== undefined) {
    const bounds = requireRecord(record.bounds, 'disclosure bounds must be an object');
    requireExactKeys(
      bounds,
      ['maxQuoteChars', 'maxQuotesPerSource', 'maxSourceCoveragePerSession', 'assumedSourceChars'],
      'disclosure bounds',
    );
    const overrides: Partial<DisclosureBounds> = {};
    if (bounds.maxQuoteChars !== undefined) {
      overrides.maxQuoteChars = requirePositiveInteger(bounds.maxQuoteChars, 'maxQuoteChars');
    }
    if (bounds.maxQuotesPerSource !== undefined) {
      overrides.maxQuotesPerSource = requirePositiveInteger(bounds.maxQuotesPerSource, 'maxQuotesPerSource');
    }
    if (bounds.maxSourceCoveragePerSession !== undefined) {
      overrides.maxSourceCoveragePerSession = requireCoverageFraction(bounds.maxSourceCoveragePerSession);
    }
    if (bounds.assumedSourceChars !== undefined) {
      overrides.assumedSourceChars = requirePositiveInteger(bounds.assumedSourceChars, 'assumedSourceChars');
    }
    config.bounds = overrides;
  }

  return config;
}

export function resolveDisclosurePolicy(config: AgentDisclosureConfig): DisclosurePolicy {
  const bounds: DisclosureBounds = Object.freeze({
    ...DISCLOSURE_BOUND_DEFAULTS,
    ...(config.bounds ?? {}),
  });
  const declared = Object.freeze((config.corpora ?? []).map((entry) => Object.freeze({ ...entry })));
  const byCorpus = new Map(declared.map((entry) => [entry.corpusId, entry.disclosure]));
  const excludedSourceKeys: ReadonlySet<string> = new Set((config.excludedSources ?? []).map((entry) =>
    'uri' in entry ? `uri:${entry.uri}` : `display:${entry.displayName}`));
  return Object.freeze({
    bounds,
    declared,
    postureFor: (corpusId: string) => byCorpus.get(corpusId) ?? DEFAULT_DISCLOSURE_POSTURE,
    excludedSourceKeys,
  });
}

/**
 * Cumulative characters disclosed per source within one session. The session
 * is an input: this module never invents session identity and never reads a
 * clock.
 */
export class DisclosureSessionLedger {
  private readonly disclosedChars = new Map<string, number>();

  charsDisclosed(sourceKey: string): number {
    return this.disclosedChars.get(sourceKey) ?? 0;
  }

  commit(pending: ReadonlyMap<string, number>): void {
    for (const [sourceKey, chars] of pending) {
      this.disclosedChars.set(sourceKey, this.charsDisclosed(sourceKey) + chars);
    }
  }
}

/** Bounded, least-recently-used store of per-session ledgers. */
export class DisclosureSessionStore {
  private readonly ledgers = new Map<string, DisclosureSessionLedger>();

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new DisclosureConfigError('a disclosure session store capacity must be a positive integer');
    }
  }

  get size(): number {
    return this.ledgers.size;
  }

  ledgerFor(sessionKey: string): DisclosureSessionLedger {
    const existing = this.ledgers.get(sessionKey);
    if (existing) {
      this.ledgers.delete(sessionKey);
      this.ledgers.set(sessionKey, existing);
      return existing;
    }
    const ledger = new DisclosureSessionLedger();
    this.ledgers.set(sessionKey, ledger);
    while (this.ledgers.size > this.capacity) {
      const oldest = this.ledgers.keys().next();
      if (oldest.done) break;
      this.ledgers.delete(oldest.value);
    }
    return ledger;
  }
}

export interface DisclosureExcerptCandidate {
  corpusId: string;
  /**
   * Stable, opaque source identity used for counting only. Absent means the
   * excerpt cannot be attributed, and an unattributable excerpt is withheld:
   * citation is mandatory and there is no configuration that turns it off.
   */
  sourceKey?: string;
  /**
   * Every identity the retrieval layer reported for this excerpt (URI and
   * display name), so an exclusion declared by either form matches.
   */
  sourceKeys?: readonly string[];
  text: string;
  /**
   * Total characters in the source, when the retrieval layer reports it. When
   * it is unknown the session budget falls back to one response's full
   * allowance (see `sourceSessionBudgetChars`).
   */
  sourceChars?: number;
}

export type DisclosureWithholdReason = 'uncitable' | 'quotes_per_source' | 'source_excluded';

export type DisclosureExcerptDecision =
  | { kind: 'disclosed'; text: string; chars: number; truncated: boolean }
  | { kind: 'withheld'; reason: DisclosureWithholdReason };

export interface DisclosureSummary {
  excerptsDisclosed: number;
  excerptsTruncated: number;
  excerptsWithheld: number;
}

export type DisclosureResult =
  | { status: 'refused'; refusal: DisclosureRefusal }
  | {
      status: 'disclosed';
      /** Index-aligned with the candidates that were supplied. */
      decisions: DisclosureExcerptDecision[];
      summary: DisclosureSummary;
    };

/**
 * The cumulative characters of one source a session may be shown.
 *
 * A coverage fraction needs a denominator, and the retrieval layer usually
 * cannot supply one: Vertex returns matched chunks with a URI, a display name
 * and a score, never the document's extent. When the extent IS reported it is
 * used directly, which is always the most accurate answer.
 *
 * When it is not, the fraction is taken against `assumedSourceChars`. That is
 * a policy value, not a derived one, and it is deliberately generous per the
 * owner's ruling to build generously and narrow later on a legal opinion. The
 * previous behaviour assumed the smallest extent consistent with one response
 * staying inside the bound, which was fail-closed but silently far tighter
 * than the stated 20% policy — a served session got one response's worth of
 * any source whose length we happened not to know, which is nearly all of
 * them.
 *
 * The anti-reconstruction property is preserved either way: there is always a
 * cumulative cap. What changes is where it sits. Tighten it by lowering
 * `assumedSourceChars`, or remove the guesswork entirely by reporting real
 * extents (see `sourceChars`) — the library already records `byteSize` for
 * every object it materializes.
 */
export function sourceSessionBudgetChars(bounds: DisclosureBounds, sourceChars?: number): number {
  // A reported extent is honoured exactly. No floor is applied to it: a short
  // source genuinely should yield a small budget, and raising it to one
  // response's allowance would hand out most of a short document.
  if (sourceChars !== undefined && Number.isFinite(sourceChars) && sourceChars > 0) {
    return Math.floor(sourceChars * bounds.maxSourceCoveragePerSession);
  }
  // The assumed path only. The floor keeps a misconfigured assumption from
  // refusing the very first question, which is not what a cumulative bound is
  // for; it can never loosen a bound derived from a real extent.
  return Math.max(
    Math.floor(bounds.assumedSourceChars * bounds.maxSourceCoveragePerSession),
    bounds.maxQuoteChars * bounds.maxQuotesPerSource,
  );
}

/**
 * Applies the disclosure bounds to one response's worth of candidate excerpts.
 *
 * A crossing of the cumulative per-source bound refuses the whole response and
 * commits nothing to the ledger — a refusal must not silently trim, and must
 * not spend budget either.
 */
export function discloseExcerpts(
  policy: DisclosurePolicy,
  ledger: DisclosureSessionLedger,
  candidates: readonly DisclosureExcerptCandidate[],
): DisclosureResult {
  const { bounds } = policy;
  const decisions: DisclosureExcerptDecision[] = [];
  const quotesPerSource = new Map<string, number>();
  const pendingChars = new Map<string, number>();
  const knownSourceChars = new Map<string, number>();
  let excerptsDisclosed = 0;
  let excerptsTruncated = 0;
  let excerptsWithheld = 0;

  for (const candidate of candidates) {
    const sourceKey = candidate.sourceKey;
    if (!sourceKey) {
      decisions.push({ kind: 'withheld', reason: 'uncitable' });
      excerptsWithheld += 1;
      continue;
    }
    // Exclusion is checked before any bound and spends nothing: an excluded
    // work is not a quote that ran out of budget, it is a work this
    // deployment does not serve.
    if ((candidate.sourceKeys ?? [sourceKey]).some((key) => policy.excludedSourceKeys.has(key))) {
      decisions.push({ kind: 'withheld', reason: 'source_excluded' });
      excerptsWithheld += 1;
      continue;
    }
    const used = quotesPerSource.get(sourceKey) ?? 0;
    if (used >= bounds.maxQuotesPerSource) {
      decisions.push({ kind: 'withheld', reason: 'quotes_per_source' });
      excerptsWithheld += 1;
      continue;
    }
    quotesPerSource.set(sourceKey, used + 1);
    const text = boundedExcerpt(candidate.text, bounds.maxQuoteChars);
    const truncated = text.length < candidate.text.length;
    decisions.push({ kind: 'disclosed', text, chars: text.length, truncated });
    excerptsDisclosed += 1;
    if (truncated) excerptsTruncated += 1;
    pendingChars.set(sourceKey, (pendingChars.get(sourceKey) ?? 0) + text.length);
    if (
      candidate.sourceChars !== undefined
      && Number.isFinite(candidate.sourceChars)
      && candidate.sourceChars > 0
      && !knownSourceChars.has(sourceKey)
    ) {
      knownSourceChars.set(sourceKey, candidate.sourceChars);
    }
  }

  for (const [sourceKey, chars] of pendingChars) {
    const budget = sourceSessionBudgetChars(bounds, knownSourceChars.get(sourceKey));
    if (ledger.charsDisclosed(sourceKey) + chars > budget) {
      return { status: 'refused', refusal: disclosureRefusal(DISCLOSURE_REFUSAL_CODES.sourceCoverageExhausted) };
    }
  }

  ledger.commit(pendingChars);
  return {
    status: 'disclosed',
    decisions,
    summary: { excerptsDisclosed, excerptsTruncated, excerptsWithheld },
  };
}

/**
 * Splits requested corpora into the ones a served deployment may retrieve from
 * and the ones it may not. `derived` sources never reach a served instance and
 * `excluded` corpora are absent entirely; both are decided here, before any
 * retrieval executes.
 */
export function partitionCorporaByDisclosure(
  policy: DisclosurePolicy,
  corpusIds: readonly string[],
): { disclosable: string[]; withheld: Array<{ corpusId: string; disclosure: DisclosurePosture }> } {
  const disclosable: string[] = [];
  const withheld: Array<{ corpusId: string; disclosure: DisclosurePosture }> = [];
  for (const corpusId of corpusIds) {
    const posture = policy.postureFor(corpusId);
    if (posture === 'full') disclosable.push(corpusId);
    else withheld.push({ corpusId, disclosure: posture });
  }
  return { disclosable, withheld };
}

function boundedExcerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const sliced = text.slice(0, maxChars);
  const last = sliced.charCodeAt(sliced.length - 1);
  // Never hand back a split surrogate pair.
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

function isDisclosurePosture(value: unknown): value is DisclosurePosture {
  return typeof value === 'string' && (DISCLOSURE_POSTURES as readonly string[]).includes(value);
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DisclosureConfigError(message);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, allowed: string[], name: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedSet.has(key))) {
    throw new DisclosureConfigError(`${name} contains an unknown field`);
  }
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DisclosureConfigError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new DisclosureConfigError(`${name} must be a positive integer`);
  }
  return value as number;
}

function requireCoverageFraction(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new DisclosureConfigError('maxSourceCoveragePerSession must be a fraction greater than 0 and at most 1');
  }
  return value;
}
