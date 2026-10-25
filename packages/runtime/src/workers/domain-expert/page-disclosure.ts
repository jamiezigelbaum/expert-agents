// Disclosure bounds for the page library: the configured bounds
// (core/disclosure.ts) applied to page units. Every passage that leaves the
// worker is one excerpt of one book: search and grep hits are bounded and
// counted, read and read_range are bounded and counted, and view_page counts
// its page's full text because an image cannot be cut. A book is the source:
// its coverage budget is a fraction of its real extent, the characters of its
// page or section units.
import {
  discloseExcerpts,
  disclosureRefusal,
  DISCLOSURE_REFUSAL_CODES,
  type DisclosureExcerptCandidate,
  type DisclosurePolicy,
  type DisclosureRefusal,
  type DisclosureSessionLedger,
  type DisclosureSummary,
} from '../../core/disclosure.ts';
import { parseUnitSlug } from '@expert-agents/library';
import type { PageExcerpt, PageLibrary, PageLibraryParams } from './page-library.ts';

export class PageDisclosureRefusal extends Error {
  constructor(readonly refusal: DisclosureRefusal) { super(refusal.message); }
}

function refuse(code: DisclosureRefusal['code']): never {
  throw new PageDisclosureRefusal(disclosureRefusal(code));
}

export async function runDisclosedPageLibrary(
  library: PageLibrary,
  params: PageLibraryParams,
  policy: DisclosurePolicy,
  ledger: DisclosureSessionLedger,
  sourceId: string,
): Promise<Record<string, unknown>> {
  if (policy.postureFor(sourceId) !== 'full') refuse(DISCLOSURE_REFUSAL_CODES.corpusNotDisclosable);
  const excluded = async (book: string) => {
    const id = await library.bookIdentity(book);
    return [`book:${book}`, `display:${id.title}`, ...id.sources.map((s) => `uri:${s}`)].some((key) => policy.excludedSourceKeys.has(key));
  };
  const bookOf = (slug: string) => parseUnitSlug(slug)?.book;
  const candidates = async (excerpts: readonly PageExcerpt[], indivisible = false): Promise<DisclosureExcerptCandidate[]> => {
    const out: DisclosureExcerptCandidate[] = [];
    for (const excerpt of excerpts) {
      const book = bookOf(excerpt.slug);
      if (!book) { out.push({ corpusId: sourceId, text: excerpt.text }); continue; }
      const info = await library.bookInfo(book);
      out.push({
        corpusId: sourceId,
        sourceKey: `book:${book}`,
        sourceKeys: [`book:${book}`, `display:${info.title}`, ...info.sources.map((s) => `uri:${s}`)],
        text: excerpt.text,
        ...(info.chars > 0 ? { sourceChars: info.chars } : {}),
        ...(indivisible ? { indivisible: true } : {}),
      });
    }
    return out;
  };
  const bound = async (excerpts: readonly PageExcerpt[], indivisible = false) => {
    const result = discloseExcerpts(policy, ledger, await candidates(excerpts, indivisible));
    if (result.status === 'refused') throw new PageDisclosureRefusal(result.refusal);
    return { decisions: result.decisions, summary: result.summary };
  };
  const report = (summary: DisclosureSummary) => ({
    disclosure: {
      posture_declared: true,
      citation_required: true,
      bounds: {
        max_quote_chars: policy.bounds.maxQuoteChars,
        max_quotes_per_source: policy.bounds.maxQuotesPerSource,
        max_source_coverage_per_session: policy.bounds.maxSourceCoveragePerSession,
      },
      excerpts_disclosed: summary.excerptsDisclosed,
      excerpts_truncated: summary.excerptsTruncated,
      excerpts_withheld: summary.excerptsWithheld,
    },
  });
  const none: DisclosureSummary = { excerptsDisclosed: 0, excerptsTruncated: 0, excerptsWithheld: 0 };

  switch (params.action) {
    case 'catalog': {
      const result = await library.catalog(params.query);
      const books = [];
      for (const row of result.books as Array<{ book: string }>) if (!(await excluded(row.book))) books.push(row);
      return { ...result, books, total: books.length, ...report(none) };
    }
    case 'search':
    case 'grep': {
      if (params.book && await excluded(params.book)) refuse(DISCLOSURE_REFUSAL_CODES.sourceExcluded);
      const search = params.action === 'search';
      const result = search
        ? await library.search(params.query!, params.k ?? 10, params.book)
        : await library.grep(params.pattern!, params.book, params.max_hits ?? 30);
      const rows = (search ? result.results : result.hits) as Array<{ slug: string; cite: string; text?: string; line?: string }>;
      const field = search ? 'text' : 'line';
      const { decisions, summary } = await bound(rows.map((r) => ({ slug: r.slug, cite: r.cite, text: r[field] ?? '' })));
      const kept = rows.flatMap((row, i) => {
        const d = decisions[i]!;
        return d.kind === 'disclosed' ? [{ ...row, [field]: d.text, ...(d.truncated ? { excerpt_truncated: true } : {}) }] : [];
      });
      return { ...result, [search ? 'results' : 'hits']: kept, ...report(summary) };
    }
    case 'read': {
      const unit = await library.unitText(params.slug!);
      const { decisions, summary } = await bound([unit]);
      const d = decisions[0]!;
      if (d.kind !== 'disclosed') refuse(DISCLOSURE_REFUSAL_CODES.sourceExcluded);
      return { slug: unit.slug, cite: unit.cite, text: d.text, truncated: d.truncated, ...report(summary) };
    }
    case 'read_range': {
      if (await excluded(params.book!)) refuse(DISCLOSURE_REFUSAL_CODES.sourceExcluded);
      const range = await library.rangeParts(params.book!, params.from_unit!, params.to_unit!);
      // Only the leading units within the per-response quote bound are read;
      // the rest are not spent, and next_unit resumes from the first of them.
      const parts = range.parts.slice(0, policy.bounds.maxQuotesPerSource);
      const { decisions, summary } = await bound(parts);
      const kept = parts.flatMap((part, i) => {
        const d = decisions[i]!;
        return d.kind === 'disclosed' ? [{ ...part, text: d.text, truncated: d.truncated }] : [];
      });
      const next = parts.length < range.parts.length ? parseUnitSlug(range.parts[parts.length]!.slug)!.unit : range.next_unit;
      return {
        units: kept.map((p) => p.slug),
        text: kept.map((p) => `[${p.slug} | ${p.cite}]\n${p.text}`).join('\n\n'),
        ...(kept.some((p) => p.truncated) ? { excerpt_truncated: true } : {}),
        ...(next ? { next_unit: next } : {}),
        note: `under this deployment's disclosure policy: at most ${policy.bounds.maxQuotesPerSource} units of ${policy.bounds.maxQuoteChars} characters per call; continue from next_unit`,
        ...report(summary),
      };
    }
    case 'view_page': {
      const unit = await library.unitText(params.slug!);
      if (await excluded(bookOf(unit.slug)!)) refuse(DISCLOSURE_REFUSAL_CODES.sourceExcluded);
      // Render first: a page that cannot be shown must not spend budget.
      const view = await library.viewPage(params.slug!);
      const { decisions, summary } = await bound([unit], true);
      if (decisions[0]!.kind !== 'disclosed') refuse(DISCLOSURE_REFUSAL_CODES.sourceExcluded);
      return { ...view, ...report(summary) };
    }
  }
}
