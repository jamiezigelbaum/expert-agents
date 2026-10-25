import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  LIBRARY_SCHEMA_VERSION,
  SCOPE_SCHEMA_VERSION,
  canonicalJson,
  canonicalObjectRelativePath,
  finalizeMasterManifest,
  serializeMasterManifest,
  serializeScopeManifest,
  type LibraryObject,
  type Sha256Id,
} from '@expert-agents/library';
import { validateAgentRoutingConfig } from '../src/core/agent-routing.ts';
import {
  ALLOW_UNAUTHENTICATED_ENV,
  warnIfWorkerAuthDisabled,
  withWorkerBearerAuth,
} from '../src/workers/http.ts';
import {
  assertAllowedGcsDestination,
  createDomainExpertWorker as createRawDomainExpertWorker,
  type DomainExpertWorkerOptions,
  parseLibgenSearchHtml,
} from '../src/workers/domain-expert/index.ts';
import { pdfPartStem, planPdfParts, qpdfPageCount, splitPdf, stripPdfPartSuffix } from '@expert-agents/library';
import type { PageStore } from '../src/workers/domain-expert/page-store.ts';
import { TEST_AGENT_ROUTING } from './routing-fixture.ts';
import { buildEpub } from '../../library/test/epub-fixture.ts';

const FIXTURE_EPUB = buildEpub({ title: 'The Fixture Book', creator: 'Example Author' });

function createDomainExpertWorker(options: DomainExpertWorkerOptions = {}) {
  return createRawDomainExpertWorker({
    agentRouting: TEST_AGENT_ROUTING,
    dataDir: mkdtempSync(join(tmpdir(), 'expert-agents-worker-data-')),
    ...options,
  });
}

interface CapturedCall {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
}


describe('ported acquisition regressions', () => {
  test('ported: live acquisition requires explicit approval', async () => {
    const worker = createDomainExpertWorker({
      annas: { apiKey: 'fixture-acquisition-token', baseUrl: 'https://annas.example' },
    });

    const response = await postDomainResponse(worker, 'annas_archive_import', {
      annas_archive_id: 'book-one',
      copyright_posture: 'approved_fixture_use',
      dry_run: false,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'approval_required' } });
  });

  test('ported: duplicate acquisition skips a second download', async () => {
    const fixture = workspaceFixture();
    const calls: CapturedCall[] = [];
    try {
      const booksRoot = join(fixture.base, 'books');
      mkdirSync(booksRoot);
      const worker = createDomainExpertWorker({
        annas: {
          apiKey: 'fixture-acquisition-token',
          baseUrl: 'https://annas.example',
          booksRoot,
        },
        fetchImpl: fakeAcquisitionFetch(calls),
      });
      const params = {
        annas_archive_id: 'book-one',
        title: 'Fixture Book',
        author: 'Example Author',
        topic: 'Research',
        format: 'epub',
        copyright_posture: 'approved_fixture_use',
        approval_id: 'approval-fixture',
        dry_run: false,
      };

      const first = await postDomain(worker, 'annas_archive_import', params);
      const second = await postDomain(worker, 'annas_archive_import', params);

      expect(first).toMatchObject({ status: 'downloaded', download: { status: 'downloaded' } });
      expect(second).toMatchObject({
        status: 'skipped_duplicate',
        download: { status: 'skipped_duplicate', reason: 'target_path_exists' },
      });
      expect(calls.filter((call) => call.url.startsWith('https://annas.example/download/book-one'))).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  test('a duplicate acquisition without ingest still skips and does not download again', async () => {
    const fixture = workspaceFixture();
    const annasCalls: CapturedCall[] = [];
    try {
      const booksRoot = join(fixture.base, 'books');
      mkdirSync(booksRoot);
      const worker = createDomainExpertWorker({
        annas: {
          apiKey: 'fixture-acquisition-token',
          baseUrl: 'https://annas.example',
          booksRoot,
        },
        fetchImpl: fakeAcquisitionFetch(annasCalls),
      });
      const params = {
        domain_id: 'research',
        annas_archive_id: 'book-one',
        title: 'The Fixture Book',
        author: 'Example Author',
        topic: 'Research',
        format: 'epub',
        copyright_posture: 'approved_fixture_use',
        approval_id: 'approval-fixture',
        dry_run: false,
      };

      await postDomain(worker, 'annas_archive_import', params);
      const second = await postDomain(worker, 'annas_archive_import', params);

      expect(second).toMatchObject({
        status: 'skipped_duplicate',
        download: { status: 'skipped_duplicate', reason: 'target_path_exists' },
        rag_ingest: { status: 'not_requested' },
      });
      expect(annasCalls.filter((call) => call.url.startsWith('https://annas.example/download/book-one'))).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  test('ported: acquisition enforces the configured bounded download size', async () => {
    const fixture = workspaceFixture();
    try {
      const booksRoot = join(fixture.base, 'books');
      mkdirSync(booksRoot);
      const worker = createDomainExpertWorker({
        annas: {
          apiKey: 'fixture-acquisition-token',
          baseUrl: 'https://annas.example',
          booksRoot,
          maxDownloadBytes: 4,
        },
        fetchImpl: (async () => new Response('12345', {
          status: 200,
          headers: { 'content-type': 'application/pdf', 'content-length': '5' },
        })) as unknown as typeof fetch,
      });

      const response = await postDomainResponse(worker, 'annas_archive_import', {
        url: 'https://annas.example/download/large.pdf',
        format: 'pdf',
        copyright_posture: 'approved_fixture_use',
        approval_id: 'approval-fixture',
        dry_run: false,
      });

      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ error: { code: 'annas_archive_download_size_limit_exceeded' } });
    } finally {
      fixture.cleanup();
    }
  });
});
// A 2026-07-29 acquisition advertised a 512-page monograph and delivered a
// 36-page pamphlet; metadata, bytes and sha256 were all consistent with the lie
// because nothing measured what was inside the file. These cover the gate that
// now measures it: a measurably short PDF never reaches the page library, and
// an unmeasurable one is recorded as unmeasured rather than punished.
describe('book-scale sanity gate on acquisition ingest', () => {
  const PDF_IMPORT_PARAMS = {
    domain_id: 'research',
    annas_archive_id: 'scale-fixture',
    title: 'The Fixture Monograph',
    author: 'Example Author',
    year: '1989',
    topic: 'Research',
    format: 'pdf',
    copyright_posture: 'approved_fixture_use',
    approval_id: 'approval-fixture',
    dry_run: false,
  };
  // A domain with no page library: the measurement and audit still happen, the ingest is blocked.
  const UNROUTED_PARAMS = { ...PDF_IMPORT_PARAMS, domain_id: 'unrouted' };

  function scaleGateFixture(bytes: Uint8Array, annas: { minPdfPages?: number } = {}, contentType = 'application/pdf') {
    const fixture = workspaceFixture();
    const booksRoot = join(fixture.base, 'books');
    mkdirSync(booksRoot);
    const annasCalls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      annas: {
        apiKey: 'fixture-acquisition-token',
        baseUrl: 'https://annas.example',
        booksRoot,
        ...annas,
      },
      fetchImpl: fakeAnnasArtifactFetch(annasCalls, bytes, contentType),
    });
    return { worker, booksRoot, annasCalls, cleanup: fixture.cleanup };
  }

  test('a plausible book-scale PDF is measured and audited, and a domain without a page library keeps the download', async () => {
    const gate = scaleGateFixture(syntheticPdfBytes(64));
    try {
      const response = await postDomain(gate.worker, 'annas_archive_import', { ...UNROUTED_PARAMS, ingest: true });

      expect(response).toMatchObject({
        status: 'downloaded_ingest_blocked',
        download: { status: 'downloaded' },
        rag_ingest: { status: 'blocked', error: { code: 'page_library_not_configured' } },
      });
      expect(existsSync(response.download.path)).toBe(true);

      // The default floor is the one under test here: 64 pages clears 60.
      const audit = annasAuditRecords(gate.booksRoot);
      expect(audit.map((record) => record.action)).toEqual(['downloaded']);
      expect(audit[0]!.scale).toMatchObject({
        measured: true,
        format: 'pdf',
        pages: 64,
        page_signal: 'page_tree_count',
        min_pdf_pages: 60,
      });
      expect(audit[0]!.scale.below_min_pdf_pages).toBeUndefined();
      expect(audit[0]!.scale.content_bytes_per_page).toBeGreaterThan(0);
    } finally {
      gate.cleanup();
    }
  });

  test('a measurably short PDF blocks the ingest and stays on disk', async () => {
    const gate = scaleGateFixture(syntheticPdfBytes(36));
    try {
      const response = await postDomain(gate.worker, 'annas_archive_import', { ...PDF_IMPORT_PARAMS, ingest: true });

      expect(response).toMatchObject({
        status: 'downloaded_ingest_blocked',
        download: { status: 'downloaded' },
        rag_ingest: {
          status: 'blocked',
          target: 'page_library',
          error: { code: 'annas_artifact_scale_implausible' },
          scale: { measured: true, format: 'pdf', pages: 36, min_pdf_pages: 60, below_min_pdf_pages: true },
        },
      });
      expect(response.rag_ingest.error.message).toContain('36 page');
      expect(response.rag_ingest.error.suggestion).toContain('allow_short_artifact');
      expect(existsSync(response.download.path)).toBe(true);

      const audit = annasAuditRecords(gate.booksRoot);
      expect(audit[0]!.scale).toMatchObject({ measured: true, pages: 36, below_min_pdf_pages: true });
      expect(audit[0]!.scale.short_artifact_override).toBeUndefined();
    } finally {
      gate.cleanup();
    }
  });

  test('allow_short_artifact gets past the scale gate and records the bypass', async () => {
    const gate = scaleGateFixture(syntheticPdfBytes(36));
    try {
      const response = await postDomain(gate.worker, 'annas_archive_import', {
        ...PDF_IMPORT_PARAMS,
        ingest: true,
        allow_short_artifact: true,
      });

      expect(response.rag_ingest.error?.code).not.toBe('annas_artifact_scale_implausible');
      const audit = annasAuditRecords(gate.booksRoot);
      expect(audit[0]!.scale).toMatchObject({
        measured: true,
        pages: 36,
        min_pdf_pages: 60,
        below_min_pdf_pages: true,
        short_artifact_override: true,
      });
    } finally {
      gate.cleanup();
    }
  });

  test('re-ingesting a short PDF already on disk blocks too, and the audit carries the scale', async () => {
    const gate = scaleGateFixture(syntheticPdfBytes(12), { minPdfPages: 20 });
    try {
      const downloaded = await postDomain(gate.worker, 'annas_archive_import', PDF_IMPORT_PARAMS);
      const reingested = await postDomain(gate.worker, 'annas_archive_import', { ...PDF_IMPORT_PARAMS, ingest: true });

      expect(downloaded).toMatchObject({ status: 'downloaded', rag_ingest: { status: 'not_requested' } });
      expect(reingested).toMatchObject({
        status: 'skipped_duplicate_ingest_blocked',
        rag_ingest: { status: 'blocked', error: { code: 'annas_artifact_scale_implausible' } },
      });
      expect(existsSync(downloaded.download.path)).toBe(true);

      const audit = annasAuditRecords(gate.booksRoot);
      expect(audit.map((record) => record.action)).toEqual(['downloaded', 'ingested_existing']);
      for (const record of audit) {
        expect(record.scale).toMatchObject({ measured: true, pages: 12, min_pdf_pages: 20, below_min_pdf_pages: true });
      }
      expect(audit[1]!.rag_ingest_status).toBe('blocked');
    } finally {
      gate.cleanup();
    }
  });

  test('a duplicate acquisition asked to ingest reports the ingest from the file already on disk', async () => {
    const gate = scaleGateFixture(syntheticPdfBytes(64));
    try {
      const downloaded = await postDomain(gate.worker, 'annas_archive_import', UNROUTED_PARAMS);
      const reingested = await postDomain(gate.worker, 'annas_archive_import', { ...UNROUTED_PARAMS, ingest: true });

      expect(downloaded.status).toBe('downloaded');
      expect(reingested).toMatchObject({
        status: 'skipped_duplicate_ingest_blocked',
        download: { status: 'skipped_duplicate', reason: 'target_path_exists', sha256: downloaded.download.sha256 },
        rag_ingest: { status: 'blocked', error: { code: 'page_library_not_configured' } },
      });
      expect(gate.annasCalls.filter((call) => call.url.startsWith('https://annas.example/download/'))).toHaveLength(1);
      expect(annasAuditRecords(gate.booksRoot).map((record) => record.action)).toEqual(['downloaded', 'ingested_existing']);
    } finally {
      gate.cleanup();
    }
  });

  // The scale gate does not refuse what it cannot measure.
  test('an artifact whose scale cannot be measured is recorded as unmeasured, not refused by the gate', async () => {
    const gate = scaleGateFixture(new TextEncoder().encode('this is not a PDF at all'));
    try {
      await postDomain(gate.worker, 'annas_archive_import', { ...UNROUTED_PARAMS, ingest: true });

      const audit = annasAuditRecords(gate.booksRoot);
      expect(audit[0]!.scale).toMatchObject({ measured: false, format: 'pdf', reason: 'pdf_header_not_found' });
      expect(audit[0]!.scale.pages).toBeUndefined();
      expect(audit[0]!.scale.below_min_pdf_pages).toBeUndefined();
    } finally {
      gate.cleanup();
    }
  });

  test('a truncated PDF is unmeasured rather than refused by the scale gate, and a zero floor disables the gate', async () => {
    const truncated = syntheticPdfBytes(36).slice(0, 12);
    const unmeasurable = scaleGateFixture(truncated);
    try {
      const response = await postDomain(unmeasurable.worker, 'annas_archive_import', { ...PDF_IMPORT_PARAMS, ingest: true });
      expect(response.rag_ingest.error?.code).not.toBe('annas_artifact_scale_implausible');
      expect(annasAuditRecords(unmeasurable.booksRoot)[0]!.scale)
        .toMatchObject({ measured: false, reason: 'pdf_page_signal_not_found' });
    } finally {
      unmeasurable.cleanup();
    }

    const disabled = scaleGateFixture(syntheticPdfBytes(3), { minPdfPages: 0 });
    try {
      const response = await postDomain(disabled.worker, 'annas_archive_import', { ...PDF_IMPORT_PARAMS, ingest: true });
      expect(response.rag_ingest.error?.code).not.toBe('annas_artifact_scale_implausible');
      const scale = annasAuditRecords(disabled.booksRoot)[0]!.scale;
      expect(scale).toMatchObject({ measured: true, pages: 3 });
      expect(scale.min_pdf_pages).toBeUndefined();
      expect(scale.below_min_pdf_pages).toBeUndefined();
    } finally {
      disabled.cleanup();
    }
  });

  test('page objects hidden in a compressed object stream still measure as pages', async () => {
    const gate = scaleGateFixture(syntheticObjectStreamPdfBytes(72));
    try {
      await postDomain(gate.worker, 'annas_archive_import', { ...UNROUTED_PARAMS, ingest: true });
      expect(annasAuditRecords(gate.booksRoot)[0]!.scale)
        .toMatchObject({ measured: true, pages: 72, page_signal: 'page_objects' });
    } finally {
      gate.cleanup();
    }
  });

  test('an EPUB reports its text scale from the archive directory, and never hits the page floor', async () => {
    const gate = scaleGateFixture(syntheticEpubBytes(['ch1.xhtml', 'ch2.xhtml', 'toc.ncx']), {}, 'application/epub+zip');
    try {
      const response = await postDomain(gate.worker, 'annas_archive_import', {
        ...UNROUTED_PARAMS,
        format: 'epub',
        ingest: true,
      });

      expect(response.rag_ingest.error?.code).not.toBe('annas_artifact_scale_implausible');
      const scale = annasAuditRecords(gate.booksRoot)[0]!.scale;
      expect(scale).toMatchObject({ measured: true, format: 'epub', text_documents: 2 });
      expect(scale.text_bytes).toBeGreaterThan(0);
      expect(scale.min_pdf_pages).toBeUndefined();
      expect(scale.below_min_pdf_pages).toBeUndefined();
    } finally {
      gate.cleanup();
    }
  });
});

// The page library reads PDF, EPUB, Markdown and text. Any other format is
// refused before ingest with a typed code, and the download stays on disk.
describe('acquisition ingest refuses formats the page library cannot read', () => {
  for (const [format, contentType, body] of [
    ['mobi', 'application/x-mobipocket-ebook', 'BOOKMOBI fixture bytes'],
    ['djvu', 'image/vnd.djvu', 'AT&TFORM fixture'],
  ] as const) {
    test(`a ${format.toUpperCase()} is blocked with a typed code and stays on disk`, async () => {
      const fixture = workspaceFixture();
      const booksRoot = join(fixture.base, 'books');
      mkdirSync(booksRoot);
      try {
        const worker = createDomainExpertWorker({
          annas: { apiKey: 'fixture-acquisition-token', baseUrl: 'https://annas.example', booksRoot },
          fetchImpl: fakeAnnasArtifactFetch([], new TextEncoder().encode(body), contentType),
        });
        const response = await postDomain(worker, 'annas_archive_import', {
          domain_id: 'research',
          annas_archive_id: 'format-fixture',
          title: 'The Fixture Book',
          author: 'Example Author',
          year: '2005',
          topic: 'Research',
          format,
          copyright_posture: 'approved_fixture_use',
          approval_id: 'approval-fixture',
          dry_run: false,
          ingest: true,
        });

        expect(response).toMatchObject({
          status: 'downloaded_ingest_blocked',
          download: { status: 'downloaded', format },
          rag_ingest: { status: 'blocked', target: 'page_library', error: { code: 'page_ingest_format_unsupported' } },
        });
        expect(response.rag_ingest.error.message).toContain('still on disk');
        expect(existsSync(response.download.path)).toBe(true);
      } finally {
        fixture.cleanup();
      }
    });
  }
});

describe('search ranks for ingestibility when the caller intends to ingest', () => {
  const RECORDS = [
    { md5: '11111111111111111111111111111111', title: 'Ranking Fixture', author: 'Example, Ada', metadata: 'English [en] · MOBI · 1.5MB · 2011' },
    { md5: '22222222222222222222222222222222', title: 'Ranking Fixture', author: 'Example, Ada', metadata: 'English [en] · EPUB · 1.5MB · 2011' },
    { md5: '33333333333333333333333333333333', title: 'Ranking Fixture', author: 'Example, Ada', metadata: 'English [en] · DJVU · 1.5MB · 2011' },
    { md5: '44444444444444444444444444444444', title: 'Ranking Fixture', author: 'Example, Ada', metadata: 'English [en] · PDF · 1.5MB · 2011' },
  ];

  function searchWorker() {
    return createDomainExpertWorker({
      annas: { apiKey: 'fixture-acquisition-token', baseUrl: 'https://annas.example' },
      fetchImpl: fakeSearchPageFetch([], annasSearchPageHtml(RECORDS)),
    });
  }

  test('with ingest_intent, EPUB leads, PDF follows, and DJVU and MOBI trail and say why', async () => {
    const result = await postDomain(searchWorker(), 'annas_archive_search', {
      query: 'ranking fixture',
      format_preference: 'text_rag',
      ingest_intent: true,
    });

    expect(result.search).toMatchObject({ format_preference: 'text_rag', ingest_intent: true });
    const byFormat = Object.fromEntries(result.candidates.map((candidate: Record<string, any>) => [candidate.format, candidate]));
    expect(byFormat.epub.score).toBeGreaterThan(byFormat.pdf.score);
    expect(byFormat.pdf.score).toBeGreaterThan(byFormat.djvu.score);
    expect(byFormat.pdf.score).toBeGreaterThan(byFormat.mobi.score);
    expect(result.candidates.slice(0, 2).map((candidate: Record<string, any>) => candidate.format)).toEqual(['epub', 'pdf']);
    expect(byFormat.mobi.rationale).toContain('not ingestible: the page library does not read MOBI');
    expect(byFormat.djvu.rationale).toContain('not ingestible: the page library does not read DJVU');
    expect(byFormat.epub.rationale).toContain('preferred: the page library reads EPUB text directly');
    expect(byFormat.pdf.rationale).toEqual(expect.arrayContaining([expect.stringContaining('the page library reads PDF pages')]));
  });

  test('without ingest_intent the reading preference still decides, so EPUB leads text_rag', async () => {
    const result = await postDomain(searchWorker(), 'annas_archive_search', {
      query: 'ranking fixture',
      format_preference: 'text_rag',
    });

    expect(result.search.ingest_intent).toBeUndefined();
    expect(result.candidates[0].format).toBe('epub');
    expect(result.candidates[0].rationale).toContain('EPUB preferred for text-first reading/RAG');
    expect(result.candidates.every((candidate: Record<string, any>) => !candidate.rationale.some((line: string) => line.includes('ingestible')))).toBe(true);
  });
});

describe('Anna Archive direct membership adapter', () => {
  const ACQUISITION_KEY = 'fixture-acquisition-token';
  const FIXTURE_MD5 = 'aaaaaaaabbbbbbbbccccccccdddddddd';
  const IMPORT_PARAMS = {
    annas_archive_id: FIXTURE_MD5,
    md5: FIXTURE_MD5,
    title: 'Fixture Book',
    author: 'Example Author',
    topic: 'Research',
    format: 'epub',
    copyright_posture: 'approved_fixture_use',
    approval_id: 'approval-fixture',
    dry_run: false,
  };

  test('search parses the HTML result page into ranked candidates', async () => {
    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      annas: { apiKey: ACQUISITION_KEY, baseUrl: 'https://annas.example' },
      fetchImpl: fakeSearchPageFetch(calls, annasSearchPageHtml([
        {
          md5: '11111111111111111111111111111111',
          title: 'Bounded Rationality &amp; Choice',
          author: 'Example, Ada',
          metadata: 'English [en] · EPUB · 1.5MB · 2011 · Book (non-fiction)',
        },
        {
          md5: '22222222222222222222222222222222',
          title: 'Rationality Field Notes',
          author: 'Second, Bo',
          metadata: 'German [de] · PDF · 12.0MB · Book (unknown)',
        },
      ])),
    });

    const result = await postDomain(worker, 'annas_archive_search', {
      query: 'bounded rationality',
      top_n: 5,
      format_preference: 'text_rag',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://annas.example/search?q=bounded+rationality');
    expect(result).toMatchObject({ status: 'candidates_ready' });
    expect(result.candidates).toEqual([
      expect.objectContaining({
        annas_archive_id: '11111111111111111111111111111111',
        md5: '11111111111111111111111111111111',
        stable_locator: 'md5:11111111111111111111111111111111',
        title: 'Bounded Rationality & Choice',
        author: 'Example, Ada',
        format: 'epub',
        language: 'English [en]',
        year: '2011',
        file_size_bytes: 1572864,
      }),
      expect.objectContaining({
        md5: '22222222222222222222222222222222',
        title: 'Rationality Field Notes',
        author: 'Second, Bo',
        format: 'pdf',
        language: 'German [de]',
        file_size_bytes: 12582912,
      }),
    ]);
    expect(result.candidates[0].year).toBe('2011');
    expect(result.candidates[1].year).toBeUndefined();
  });

  // Two editions of one title came back from a single live search with identical
  // titles, authors, years and scores; one was the book and one was a pamphlet.
  // Size is stated and the outlier is named, but neither changes the score: a
  // bigger-is-better bonus would prefer bulky scans over clean text layers.
  test('search states file size in human units and names a same-title size outlier', async () => {
    const worker = createDomainExpertWorker({
      annas: { apiKey: ACQUISITION_KEY, baseUrl: 'https://annas.example' },
      fetchImpl: fakeSearchPageFetch([], annasSearchPageHtml([
        {
          md5: '44444444444444444444444444444444',
          title: 'The Fixture Path of Knowledge',
          author: 'Example, Ada',
          metadata: 'English [en] · PDF · 4.0MB · 1989 · Book (non-fiction)',
        },
        {
          md5: '55555555555555555555555555555555',
          title: 'The Fixture Path of Knowledge',
          author: 'Example, Ada',
          metadata: 'English [en] · PDF · 33.0MB · 1989 · Book (non-fiction)',
        },
      ])),
    });

    const result = await postDomain(worker, 'annas_archive_search', { query: 'fixture path of knowledge' });

    const small = result.candidates.find((candidate: Record<string, any>) => candidate.md5.startsWith('4'));
    const large = result.candidates.find((candidate: Record<string, any>) => candidate.md5.startsWith('5'));
    expect(small.rationale).toContain('file size 4.0 MB');
    expect(large.rationale).toContain('file size 33.0 MB');
    // The 2026-07-29 spread exactly: two editions, 8x apart. A median that
    // included the candidate itself would need 9x and would say nothing here.
    expect(small.rationale).toContain(
      'unusually small vs other editions of this title (4.0 MB vs 33.0 MB median) — verify page count before ingest',
    );
    expect(large.rationale.some((line: string) => line.includes('unusually small'))).toBe(false);
    expect(small.score).toBe(large.score);
  });

  test('search reports no candidates when the page only offers partial matches', async () => {
    const worker = createDomainExpertWorker({
      annas: { apiKey: ACQUISITION_KEY, baseUrl: 'https://annas.example' },
      fetchImpl: fakeSearchPageFetch([], annasSearchPageHtml([], [
        {
          md5: '33333333333333333333333333333333',
          title: 'Unrelated Fuzzy Match',
          author: 'Third, Cy',
          metadata: 'English [en] · EPUB · 0.2MB · 1999',
        },
      ])),
    });

    const result = await postDomain(worker, 'annas_archive_search', { query: 'no such title anywhere' });

    expect(result).toMatchObject({ status: 'candidates_ready', candidates: [] });
  });

  // An unconfigured backend used to answer a live search with planning text,
  // which reads like progress while nothing was searched. That is the shape
  // that let a plugin own no tools and still look healthy, so it is asserted
  // gone rather than left to a reviewer to notice.
  test('search refuses when the backend is unconfigured instead of answering with a plan', async () => {
    for (const annas of [
      { baseUrl: 'https://annas.example' },
      { apiKey: ACQUISITION_KEY },
    ]) {
      const worker = createDomainExpertWorker({
        annas,
        fetchImpl: (() => {
          throw new Error('an unconfigured search must refuse before any fetch');
        }) as unknown as typeof fetch,
      });

      const response = await postDomainResponse(worker, 'annas_archive_search', { query: 'bounded rationality' });
      const body = await response.json() as Record<string, any>;

      expect(response.status).toBe(503);
      expect(body).toMatchObject({ error: { code: 'annas_archive_not_configured' } });
      expect(JSON.stringify(body)).not.toContain('requires_runtime_secret_and_api_worker');
    }
  });

  const LIBGEN_ROW_HTML = `<tr>
<td><a data-toggle="tooltip" data-html="true" title="Add/Edit : 2022-01-01/2022-01-02; ID: 11110001<br>Field_Notes" href="edition.php?id=11110002">FIELD NOTES FOR A LIVING: how to read the tides <i></i></a>
<nobr><span class="badge badge-primary"><a data-toggle="tooltip" title="Book">b</a></span> <span class="badge badge-secondary"">l 1111003</span></nobr></td>
<td>Lee  Alpha, Andrew Beta, Mark Gamma</td>
<td></td>
<td><nobr></nobr></td>
<td>English</td>
<td>0</td>
<td><nobr><a href="/file.php?id=11110001">1 MB</a></nobr></td>
<td>epub</td>
<td><nobr><a title="libgen" href="/ads.php?md5=0123456789abcdef0123456789abcdef"><span class="badge badge-primary">1</span></a> <a title="anna's archive" href="https://annas.example/md5/0123456789abcdef0123456789abcdef"><span>3</span></a></nobr></td>
</tr>
<tr>
<td><a href="edition.php?id=1">Reading the Tides &amp; Beyond <i></i></a></td>
<td>Riley Example</td>
<td>Example Press</td>
<td><nobr>2000</nobr></td>
<td>English</td>
<td>240</td>
<td><nobr><a href="/file.php?id=2">1.5 MB</a></nobr></td>
<td>pdf</td>
<td><nobr><a title="libgen" href="/ads.php?md5=E340BC03A0F1E340BC03A0F1E340BC03"><span>1</span></a></nobr></td>
</tr>`;
  const LIBGEN_PAGE_HTML = `<html><head><title>Library Genesis</title></head><body><table>
<tr><td><div class="custom-control"><input type="checkbox" id="covers"><script>$("input[id=covers]")</script></div></td></tr>
<tr><th scope="col">ID Title</th><th scope="col">Author(s)</th><th>Publisher</th><th>Year</th><th>Language</th><th>Pages</th><th>Size</th><th>Ext</th><th>Mirrors</th></tr>
${LIBGEN_ROW_HTML}
</table></body></html>`;

  function routedFetch(calls: CapturedCall[], routes: Record<string, () => Response | Promise<Response>>): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, method: init?.method ?? 'GET', body: '', headers: headersRecord(init?.headers) });
      const route = Object.entries(routes).find(([origin]) => url.startsWith(origin));
      if (!route) throw new Error(`unexpected fetch ${url}`);
      return route[1]();
    }) as typeof fetch;
  }

  test('libgen result table parses into md5-keyed records and skips control rows', () => {
    expect(parseLibgenSearchHtml(LIBGEN_PAGE_HTML)).toEqual([
      { id: '0123456789abcdef0123456789abcdef', md5: '0123456789abcdef0123456789abcdef', title: 'FIELD NOTES FOR A LIVING: how to read the tides', source: 'libgen',
        author: 'Lee Alpha, Andrew Beta, Mark Gamma', language: 'English', format: 'epub', file_size_bytes: 1048576 },
      { id: 'e340bc03a0f1e340bc03a0f1e340bc03', md5: 'e340bc03a0f1e340bc03a0f1e340bc03', title: 'Reading the Tides & Beyond', source: 'libgen',
        author: 'Riley Example', publisher: 'Example Press', year: '2000', language: 'English', format: 'pdf', file_size_bytes: 1572864 },
    ]);
  });

  test('search falls back to Library Genesis only when Anna Archive search fails, and says so', async () => {
    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      annas: { apiKey: ACQUISITION_KEY, baseUrl: 'https://annas.example', libgenBaseUrl: 'https://libgen.example' },
      fetchImpl: routedFetch(calls, {
        'https://annas.example': () => new Response('<html>check</html>', { status: 403, headers: { 'content-type': 'text/html' } }),
        'https://libgen.example': () => new Response(LIBGEN_PAGE_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
      }),
    });
    const result = await postDomain(worker, 'annas_archive_search', { query: 'reading the tides', top_n: 5 });
    expect(calls.map((call) => call.url)).toEqual([
      'https://annas.example/search?q=reading+the+tides',
      'https://annas.example/account/',
      'https://libgen.example/index.php?req=reading+the+tides&res=25&filesuns=all&columns%5B%5D=t&columns%5B%5D=a&objects%5B%5D=f&topics%5B%5D=l',
    ]);
    expect(calls[2]?.headers).not.toHaveProperty('authorization');
    expect(JSON.stringify(calls[2])).not.toContain(ACQUISITION_KEY);
    expect(result).toMatchObject({ status: 'candidates_ready', search: { backend: 'libgen_fallback' } });
    expect(result.warnings).toEqual([expect.stringContaining('HTTP 403')]);
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ md5: 'e340bc03a0f1e340bc03a0f1e340bc03', stable_locator: 'md5:e340bc03a0f1e340bc03a0f1e340bc03', title: 'Reading the Tides & Beyond', author: 'Riley Example', format: 'pdf', year: '2000' }),
    ]));
    expect(result.approval_gate).toMatchObject({ required_before_download: true });
  });

  describe('Anna Archive member session for search', () => {
    const MEMBER_SESSION = 'fixture-member-session';
    const RESULTS_HTML = annasSearchPageHtml([{ md5: '11111111111111111111111111111111', title: 'Bounded Rationality', author: 'Example, Ada', metadata: 'English [en] · EPUB · 1.5MB · 2011 · Book (non-fiction)' }]);

    // Plays the upstream: anonymous searches hit the browser check, the account
    // form issues a session for the member key, and a session cookie unlocks search.
    function memberGatedFetch(calls: CapturedCall[], options: { issueSession?: boolean; acceptSession?: () => boolean; resultsHtml?: string; signInLocation?: string; searchAfterSignIn?: () => Response } = {}): typeof fetch {
      return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = input instanceof Request ? input.url : String(input);
        const headers = headersRecord(init?.headers);
        calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : '', headers });
        if (url.startsWith('https://libgen.example')) return new Response(LIBGEN_PAGE_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
        if (url === 'https://annas.example/account/') {
          if (options.issueSession === false) return new Response('', { status: 200 });
          return new Response('', {
            status: 302,
            headers: { location: options.signInLocation ?? '/account/', 'set-cookie': `aa_account_id2=${MEMBER_SESSION}; Domain=annas.example; Max-Age=7776000; Secure; HttpOnly; Path=/; SameSite=Lax` },
          });
        }
        if (url.startsWith('https://annas.example/search')) {
          const signedIn = headers.cookie === `aa_account_id2=${MEMBER_SESSION}`;
          if (signedIn && options.searchAfterSignIn) return options.searchAfterSignIn();
          return signedIn && (options.acceptSession?.() ?? true)
            ? new Response(options.resultsHtml ?? RESULTS_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
            : new Response('<html>check</html>', { status: 403, headers: { 'content-type': 'text/html' } });
        }
        throw new Error(`unexpected fetch ${url}`);
      }) as typeof fetch;
    }

    const annas = { apiKey: ACQUISITION_KEY, baseUrl: 'https://annas.example', libgenBaseUrl: 'https://libgen.example' };

    test('a browser-checked search signs in with the member key and retries with the session', async () => {
      const calls: CapturedCall[] = [];
      const worker = createDomainExpertWorker({ annas, fetchImpl: memberGatedFetch(calls) });
      const result = await postDomain(worker, 'annas_archive_search', { query: 'bounded rationality' });
      expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
        'GET https://annas.example/search?q=bounded+rationality',
        'POST https://annas.example/account/',
        'GET https://annas.example/search?q=bounded+rationality',
      ]);
      expect(calls[1]?.body).toBe(`key=${ACQUISITION_KEY}`);
      expect(calls[2]?.headers.cookie).toBe(`aa_account_id2=${MEMBER_SESSION}`);
      expect(result).toMatchObject({ status: 'candidates_ready', search: { backend: 'annas_archive' } });
      expect(result).not.toHaveProperty('warnings');
      expect(JSON.stringify(result)).not.toContain(MEMBER_SESSION);
      expect(JSON.stringify(result)).not.toContain(ACQUISITION_KEY);
    });

    test('the session is reused across searches without signing in again', async () => {
      const calls: CapturedCall[] = [];
      const worker = createDomainExpertWorker({ annas, fetchImpl: memberGatedFetch(calls) });
      await postDomain(worker, 'annas_archive_search', { query: 'bounded rationality' });
      calls.length = 0;
      const result = await postDomain(worker, 'annas_archive_search', { query: 'bounded rationality' });
      expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET https://annas.example/search?q=bounded+rationality']);
      expect(calls[0]?.headers.cookie).toBe(`aa_account_id2=${MEMBER_SESSION}`);
      expect(result).toMatchObject({ search: { backend: 'annas_archive' } });
    });

    test('a refused session is replaced by signing in once more', async () => {
      const calls: CapturedCall[] = [];
      let refuseNext = false;
      const worker = createDomainExpertWorker({
        annas,
        fetchImpl: memberGatedFetch(calls, { acceptSession: () => { const accept = !refuseNext; refuseNext = false; return accept; } }),
      });
      await postDomain(worker, 'annas_archive_search', { query: 'bounded rationality' });
      calls.length = 0;
      refuseNext = true;
      const result = await postDomain(worker, 'annas_archive_search', { query: 'bounded rationality' });
      expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
        'GET https://annas.example/search?q=bounded+rationality',
        'POST https://annas.example/account/',
        'GET https://annas.example/search?q=bounded+rationality',
      ]);
      expect(result).toMatchObject({ search: { backend: 'annas_archive' } });
    });

    test('a sign-in that issues no session falls back to Library Genesis as before', async () => {
      const calls: CapturedCall[] = [];
      const worker = createDomainExpertWorker({ annas, fetchImpl: memberGatedFetch(calls, { issueSession: false }) });
      const result = await postDomain(worker, 'annas_archive_search', { query: 'bounded rationality' });
      expect(calls.map((call) => `${call.method} ${new URL(call.url).origin}`)).toEqual([
        'GET https://annas.example',
        'POST https://annas.example',
        'GET https://libgen.example',
      ]);
      expect(result).toMatchObject({ search: { backend: 'libgen_fallback' } });
      expect(result.warnings).toEqual([expect.stringContaining('HTTP 403')]);
    });

    test('a redirect in reply to the sign-in is never followed, so the key stays on the configured origin', async () => {
      const calls: CapturedCall[] = [];
      const worker = createDomainExpertWorker({ annas, fetchImpl: memberGatedFetch(calls, { signInLocation: 'https://impostor.example/account/' }) });
      const result = await postDomain(worker, 'annas_archive_search', { query: 'bounded rationality' });
      expect(calls.every((call) => call.url.startsWith('https://annas.example/'))).toBe(true);
      expect(calls.filter((call) => call.method === 'POST').map((call) => call.url)).toEqual(['https://annas.example/account/']);
      expect(result).toMatchObject({ search: { backend: 'annas_archive' } });
    });

    test('the bare session value is redacted when the upstream echoes it', async () => {
      const worker = createDomainExpertWorker({
        annas,
        fetchImpl: memberGatedFetch([], { resultsHtml: annasSearchPageHtml([{ md5: '11111111111111111111111111111111', title: `Echo ${MEMBER_SESSION}`, author: 'Example, Ada', metadata: 'English [en] · EPUB · 1.5MB · 2011 · Book (non-fiction)' }]) }),
      });
      const result = await postDomain(worker, 'annas_archive_search', { query: 'bounded rationality' });
      expect(result).toMatchObject({ search: { backend: 'annas_archive' } });
      expect(JSON.stringify(result)).not.toContain(MEMBER_SESSION);
    });

    test('only a 403 triggers a sign-in; other failures go straight to the fallback', async () => {
      const calls: CapturedCall[] = [];
      const worker = createDomainExpertWorker({
        annas,
        fetchImpl: routedFetch(calls, {
          'https://annas.example': () => new Response('', { status: 500 }),
          'https://libgen.example': () => new Response(LIBGEN_PAGE_HTML, { status: 200, headers: { 'content-type': 'text/html' } }),
        }),
      });
      const result = await postDomain(worker, 'annas_archive_search', { query: 'bounded rationality' });
      expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
      expect(result.warnings).toEqual([expect.stringContaining('HTTP 500')]);
    });

    test('after a sign-in that does not get search through, the key is not sent again until the backoff passes', async () => {
      const calls: CapturedCall[] = [];
      const worker = createDomainExpertWorker({ annas, fetchImpl: memberGatedFetch(calls, { issueSession: false }) });
      await postDomain(worker, 'annas_archive_search', { query: 'bounded rationality' });
      calls.length = 0;
      const result = await postDomain(worker, 'annas_archive_search', { query: 'bounded rationality' });
      expect(calls.map((call) => `${call.method} ${new URL(call.url).origin}`)).toEqual(['GET https://annas.example', 'GET https://libgen.example']);
      expect(result).toMatchObject({ search: { backend: 'libgen_fallback' } });
    });

    test('a retry that throws still reports the original refusal', async () => {
      const worker = createDomainExpertWorker({
        annas,
        fetchImpl: memberGatedFetch([], { searchAfterSignIn: () => { throw new TypeError('fetch failed'); } }),
      });
      const result = await postDomain(worker, 'annas_archive_search', { query: 'bounded rationality' });
      expect(result).toMatchObject({ search: { backend: 'libgen_fallback' } });
      expect(result.warnings).toEqual([expect.stringContaining('HTTP 403')]);
    });

    test('a search refused after another search already signed in uses that session instead of signing in again', async () => {
      const calls: CapturedCall[] = [];
      let releaseSlow!: () => void;
      const slowRefusal = new Promise<void>((resolve) => { releaseSlow = resolve; });
      let first = true;
      const gated = memberGatedFetch(calls);
      const worker = createDomainExpertWorker({
        annas,
        fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : String(input);
          if (first && url.startsWith('https://annas.example/search')) {
            first = false;
            await slowRefusal;
            calls.push({ url, method: 'GET', body: '', headers: headersRecord(init?.headers) });
            return new Response('<html>check</html>', { status: 403 });
          }
          return gated(input, init);
        }) as typeof fetch,
      });
      const slow = postDomain(worker, 'annas_archive_search', { query: 'bounded rationality' });
      await postDomain(worker, 'annas_archive_search', { query: 'bounded rationality' });
      releaseSlow();
      const result = await slow;
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
      expect(result).toMatchObject({ search: { backend: 'annas_archive' } });
    });

    test('concurrent refused searches share one sign-in', async () => {
      const calls: CapturedCall[] = [];
      const worker = createDomainExpertWorker({ annas, fetchImpl: memberGatedFetch(calls) });
      const results = await Promise.all([1, 2, 3].map(() => postDomain(worker, 'annas_archive_search', { query: 'bounded rationality' })));
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
      for (const result of results) expect(result).toMatchObject({ search: { backend: 'annas_archive' } });
    });
  });

  test('search never consults Library Genesis while Anna Archive answers', async () => {
    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      annas: { apiKey: ACQUISITION_KEY, baseUrl: 'https://annas.example', libgenBaseUrl: 'https://libgen.example' },
      fetchImpl: routedFetch(calls, {
        'https://annas.example': () => new Response(annasSearchPageHtml([{ md5: '11111111111111111111111111111111', title: 'Bounded Rationality', author: 'Example, Ada', metadata: 'English [en] · EPUB · 1.5MB · 2011 · Book (non-fiction)' }]), { status: 200, headers: { 'content-type': 'text/html' } }),
        'https://libgen.example': () => { throw new Error('libgen must not be consulted'); },
      }),
    });
    const result = await postDomain(worker, 'annas_archive_search', { query: 'bounded rationality' });
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ status: 'candidates_ready', search: { backend: 'annas_archive' } });
    expect(result).not.toHaveProperty('warnings');
  });

  test('a network failure at Anna Archive also falls back, and both failing reports the original error with both reasons', async () => {
    const calls: CapturedCall[] = [];
    const worker = createDomainExpertWorker({
      annas: { apiKey: ACQUISITION_KEY, baseUrl: 'https://annas.example', libgenBaseUrl: 'https://libgen.example' },
      fetchImpl: routedFetch(calls, {
        'https://annas.example': () => { throw new TypeError('fetch failed'); },
        'https://libgen.example': () => new Response(LIBGEN_PAGE_HTML, { status: 200, headers: { 'content-type': 'text/html' } }),
      }),
    });
    const result = await postDomain(worker, 'annas_archive_search', { query: 'reading the tides' });
    expect(result).toMatchObject({ status: 'candidates_ready', search: { backend: 'libgen_fallback' } });
    expect(result.warnings).toEqual([expect.stringContaining('network failure')]);

    const both = createDomainExpertWorker({
      annas: { apiKey: ACQUISITION_KEY, baseUrl: 'https://annas.example', libgenBaseUrl: 'https://libgen.example' },
      fetchImpl: routedFetch([], {
        'https://annas.example': () => new Response('', { status: 403 }),
        'https://libgen.example': () => new Response('', { status: 502 }),
      }),
    });
    const response = await postDomainResponse(both, 'annas_archive_search', { query: 'reading the tides' });
    const body = await response.json() as Record<string, any>;
    expect(response.status).toBe(403);
    expect(body).toMatchObject({ error: { code: 'annas_archive_error' } });
    expect(JSON.stringify(body)).toContain('HTTP 502');
  });

  test('without a Library Genesis origin an Anna Archive failure is reported unchanged', async () => {
    const worker = createDomainExpertWorker({
      annas: { apiKey: ACQUISITION_KEY, baseUrl: 'https://annas.example' },
      fetchImpl: routedFetch([], { 'https://annas.example': () => new Response('', { status: 403 }) }),
    });
    const response = await postDomainResponse(worker, 'annas_archive_search', { query: 'reading the tides' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'annas_archive_error' } });
  });

  test('fast download resolves through the member API and fetches partner bytes uncredentialed', async () => {
    const fixture = workspaceFixture();
    const calls: CapturedCall[] = [];
    const pinned: string[][] = [];
    try {
      const booksRoot = join(fixture.base, 'books');
      mkdirSync(booksRoot);
      const worker = createDomainExpertWorker({
        annas: { apiKey: ACQUISITION_KEY, baseUrl: 'https://annas.example', fastDownload: true, booksRoot },
        fetchImpl: fakeFastDownloadFetch(calls, { downloadUrl: 'https://partner.example/files/fixture.epub' }),
        resolveHostImpl: async () => ['93.184.216.34'],
        webImportFetchImpl: fakePartnerFetch(calls, {
          'https://partner.example/files/fixture.epub': partnerBytesResponse,
        }, pinned),
      });

      const result = await postDomain(worker, 'annas_archive_import', IMPORT_PARAMS);

      expect(result).toMatchObject({ status: 'downloaded', download: { status: 'downloaded', format: 'epub' } });
      expect(calls).toHaveLength(2);
      expect(calls[0]?.url).toBe(`https://annas.example/dyn/api/fast_download.json?md5=${FIXTURE_MD5}&key=${ACQUISITION_KEY}`);
      expect(calls[0]?.headers.authorization).toBe(`Bearer ${ACQUISITION_KEY}`);
      expect(calls[1]?.url).toBe('https://partner.example/files/fixture.epub');
      expect(calls[1]?.headers.authorization).toBeUndefined();
      expect(calls[1]?.headers['x-api-key']).toBeUndefined();
      expect(JSON.stringify(calls[1])).not.toContain(ACQUISITION_KEY);
      // The partner hop connects to the address the guard validated, not to a name the
      // transport is free to resolve again.
      expect(pinned).toEqual([['93.184.216.34']]);
      expect(readFileSync(result.download.path, 'utf8')).toBe('fixture-book-bytes');
    } finally {
      fixture.cleanup();
    }
  });

  describe('partner downloads take the guarded destination resolution', () => {
    async function importFromPartner(options: {
      downloadUrl: string;
      resolve?: (hostname: string) => string[];
      routes?: Record<string, () => Response>;
    }): Promise<{ response: Response; partnerCalls: CapturedCall[]; booksRoot: string; cleanup: () => void }> {
      const fixture = workspaceFixture();
      const booksRoot = join(fixture.base, 'books');
      mkdirSync(booksRoot);
      const partnerCalls: CapturedCall[] = [];
      const worker = createDomainExpertWorker({
        annas: { apiKey: ACQUISITION_KEY, baseUrl: 'https://annas.example', fastDownload: true, booksRoot },
        fetchImpl: fakeFastDownloadFetch([], { downloadUrl: options.downloadUrl }),
        resolveHostImpl: async (hostname) => (options.resolve ?? (() => ['93.184.216.34']))(hostname),
        webImportFetchImpl: fakePartnerFetch(partnerCalls, options.routes ?? {}),
      });
      const response = await postDomainResponse(worker, 'annas_archive_import', IMPORT_PARAMS);
      return { response, partnerCalls, booksRoot, cleanup: fixture.cleanup };
    }

    // A hostile or compromised member API picks the partner URL, so each of these is a
    // download_url the worker would otherwise have fetched on the upstream's say-so.
    const denied: Array<{ name: string; downloadUrl: string; resolve?: (hostname: string) => string[] }> = [
      { name: 'a literal private IPv4 address', downloadUrl: 'https://10.1.2.3/files/fixture.epub' },
      { name: 'IPv6 loopback', downloadUrl: 'https://[::1]/files/fixture.epub' },
      { name: 'an IPv6 link-local address', downloadUrl: 'https://[fe80::1]/files/fixture.epub' },
      {
        name: 'a public hostname that resolves into private space',
        downloadUrl: 'https://partner.example/files/fixture.epub',
        resolve: () => ['127.0.0.1'],
      },
    ];

    for (const scenario of denied) {
      test(`refuses ${scenario.name}`, async () => {
        const run = await importFromPartner({
          downloadUrl: scenario.downloadUrl,
          ...(scenario.resolve ? { resolve: scenario.resolve } : {}),
          routes: { [scenario.downloadUrl]: partnerBytesResponse },
        });
        try {
          expect(run.response.status).toBe(403);
          expect(await run.response.json()).toMatchObject({
            error: { code: 'annas_archive_partner_address_denied' },
          });
          expect(run.partnerCalls).toEqual([]);
          expect(existsSync(join(run.booksRoot, 'Research'))).toBe(false);
        } finally {
          run.cleanup();
        }
      });
    }

    test('refuses a redirect that leaves public space', async () => {
      const run = await importFromPartner({
        downloadUrl: 'https://partner.example/files/fixture.epub',
        resolve: (hostname) => (hostname === 'partner.example' ? ['93.184.216.34'] : ['10.0.0.7']),
        routes: {
          'https://partner.example/files/fixture.epub': () => partnerRedirectResponse('https://internal.example/secrets'),
          'https://internal.example/secrets': partnerBytesResponse,
        },
      });
      try {
        expect(run.response.status).toBe(403);
        expect(await run.response.json()).toMatchObject({
          error: { code: 'annas_archive_partner_address_denied' },
        });
        // The first hop is legitimate; the redirect target is never fetched.
        expect(run.partnerCalls.map((call) => call.url)).toEqual(['https://partner.example/files/fixture.epub']);
        expect(existsSync(join(run.booksRoot, 'Research'))).toBe(false);
      } finally {
        run.cleanup();
      }
    });

    test('refuses a partner host that does not resolve', async () => {
      const run = await importFromPartner({
        downloadUrl: 'https://partner.example/files/fixture.epub',
        resolve: () => [],
        routes: { 'https://partner.example/files/fixture.epub': partnerBytesResponse },
      });
      try {
        expect(run.response.status).toBe(502);
        expect(await run.response.json()).toMatchObject({
          error: { code: 'annas_archive_partner_host_unresolved' },
        });
        expect(run.partnerCalls).toEqual([]);
      } finally {
        run.cleanup();
      }
    });
  });

  test('an exhausted fast download quota fails honestly instead of saving the envelope', async () => {
    const fixture = workspaceFixture();
    try {
      const booksRoot = join(fixture.base, 'books');
      mkdirSync(booksRoot);
      const worker = createDomainExpertWorker({
        annas: { apiKey: ACQUISITION_KEY, baseUrl: 'https://annas.example', fastDownload: true, booksRoot },
        fetchImpl: fakeFastDownloadFetch([], { status: 429, error: 'Too many fast downloads' }),
      });

      const response = await postDomainResponse(worker, 'annas_archive_import', IMPORT_PARAMS);
      const body = await response.json() as Record<string, any>;

      expect(response.status).toBe(429);
      expect(body.error.code).toBe('annas_archive_fast_download_unavailable');
      expect(body.error.message).toContain('Too many fast downloads');
      expect(existsSync(join(booksRoot, 'Research'))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test('fast download requires an md5 rather than guessing a download path', async () => {
    const fixture = workspaceFixture();
    try {
      const booksRoot = join(fixture.base, 'books');
      mkdirSync(booksRoot);
      const worker = createDomainExpertWorker({
        annas: { apiKey: ACQUISITION_KEY, baseUrl: 'https://annas.example', fastDownload: true, booksRoot },
        fetchImpl: fakeFastDownloadFetch([], { downloadUrl: 'https://partner.example/files/fixture.epub' }),
      });

      const response = await postDomainResponse(worker, 'annas_archive_import', {
        ...IMPORT_PARAMS,
        annas_archive_id: 'not-an-md5',
        md5: undefined,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'annas_archive_md5_required' } });
    } finally {
      fixture.cleanup();
    }
  });

  test('the account key never reaches error messages or partner hosts', async () => {
    const fixture = workspaceFixture();
    try {
      const booksRoot = join(fixture.base, 'books');
      mkdirSync(booksRoot);
      const envelopeWorker = createDomainExpertWorker({
        annas: { apiKey: ACQUISITION_KEY, baseUrl: 'https://annas.example', fastDownload: true, booksRoot },
        fetchImpl: fakeFastDownloadFetch([], { status: 403, error: `Invalid secret key ${ACQUISITION_KEY}` }),
      });
      const envelope = await (await postDomainResponse(envelopeWorker, 'annas_archive_import', IMPORT_PARAMS)).text();

      expect(envelope).toContain('Invalid secret key');
      expect(envelope).not.toContain(ACQUISITION_KEY);

      const sizeWorker = createDomainExpertWorker({
        annas: { apiKey: ACQUISITION_KEY, baseUrl: 'https://annas.example', booksRoot, maxDownloadBytes: 4 },
        fetchImpl: (async () => new Response('12345', {
          status: 200,
          headers: { 'content-type': 'application/epub+zip', 'content-length': '5' },
        })) as unknown as typeof fetch,
      });
      const sized = await (await postDomainResponse(sizeWorker, 'annas_archive_import', {
        ...IMPORT_PARAMS,
        url: `https://annas.example/download/large.epub?key=${ACQUISITION_KEY}`,
      })).text();

      expect(sized).toContain('annas_archive_download_size_limit_exceeded');
      expect(sized).toContain('key=redacted');
      expect(sized).not.toContain(ACQUISITION_KEY);
    } finally {
      fixture.cleanup();
    }
  });

  test('credential egress stays pinned to the configured origin and partner URLs stay HTTPS', async () => {
    const fixture = workspaceFixture();
    try {
      const booksRoot = join(fixture.base, 'books');
      mkdirSync(booksRoot);
      const templateWorker = createDomainExpertWorker({
        annas: { apiKey: ACQUISITION_KEY, baseUrl: 'https://annas.example', booksRoot },
        fetchImpl: (async () => new Response('never-reached', { status: 200 })) as unknown as typeof fetch,
      });
      const offOrigin = await postDomainResponse(templateWorker, 'annas_archive_import', {
        ...IMPORT_PARAMS,
        url: 'https://elsewhere.example/download/fixture.epub',
      });

      expect(offOrigin.status).toBe(403);
      expect(await offOrigin.json()).toMatchObject({ error: { code: 'annas_archive_url_not_allowed' } });

      const downgradeWorker = createDomainExpertWorker({
        annas: { apiKey: ACQUISITION_KEY, baseUrl: 'https://annas.example', fastDownload: true, booksRoot },
        fetchImpl: fakeFastDownloadFetch([], { downloadUrl: 'http://partner.example/files/fixture.epub' }),
      });
      const downgrade = await postDomainResponse(downgradeWorker, 'annas_archive_import', IMPORT_PARAMS);

      expect(downgrade.status).toBe(403);
      expect(await downgrade.json()).toMatchObject({ error: { code: 'annas_archive_url_not_allowed' } });
    } finally {
      fixture.cleanup();
    }
  });

  test('health reports fast download separately from search reachability', async () => {
    const searchOnly = await getHealth(createDomainExpertWorker({
      annas: { apiKey: ACQUISITION_KEY, baseUrl: 'https://annas.example' },
    }));
    const fast = await getHealth(createDomainExpertWorker({
      annas: { apiKey: ACQUISITION_KEY, baseUrl: 'https://annas.example', fastDownload: true },
    }));

    expect(searchOnly.configured).toMatchObject({ annas_archive: true, annas_archive_fast_download: false });
    expect(fast.configured).toMatchObject({ annas_archive: true, annas_archive_fast_download: true });
  });

  test('health reports the books root only when the directory actually exists', async () => {
    const fixture = workspaceFixture();
    try {
      const missingRoot = join(fixture.base, 'books-not-created');
      const realRoot = join(fixture.base, 'books');
      mkdirSync(realRoot);

      const missing = await getHealth(createDomainExpertWorker({
        annas: { apiKey: ACQUISITION_KEY, baseUrl: 'https://annas.example', booksRoot: missingRoot },
      }));
      const present = await getHealth(createDomainExpertWorker({
        annas: { apiKey: ACQUISITION_KEY, baseUrl: 'https://annas.example', booksRoot: realRoot },
      }));

      expect(missing.configured).toMatchObject({ annas_books_root: false });
      expect(present.configured).toMatchObject({ annas_books_root: true });
    } finally {
      fixture.cleanup();
    }
  });
});

describe('error contract regressions', () => {
  test('unhandled handler errors return the content-free JSON 500 contract', async () => {
    const sensitiveErrorText = '/private/credential/path contained fixture-secret';
    const logged: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };

    try {
      const worker = createDomainExpertWorker({
        pageSearch: async () => [],
        pageStore: () => ({
          kind: 'database',
          catalog: async () => {
            throw new Error(sensitiveErrorText);
          },
          unit: async () => undefined,
          units: async function* () {},
        }) as unknown as PageStore,
      });

      const response = await postDomainResponse(worker, 'domain_library', {
        action: 'catalog',
        domain_id: 'research',
      });
      const responseText = await response.text();
      const body = JSON.parse(responseText) as Record<string, any>;

      expect(response.status).toBe(500);
      expect(response.headers.get('content-type')).toStartWith('application/json');
      expect(body).toEqual({
        error: {
          code: 'internal_error',
          message: 'The domain expert worker encountered an internal error.',
        },
        policy: expect.any(Object),
      });
      expect(responseText).not.toContain(sensitiveErrorText);
      expect(logged).toHaveLength(1);
      expect(JSON.stringify(logged)).not.toContain(sensitiveErrorText);
    } finally {
      console.error = originalConsoleError;
    }
  });
});

describe('domain_agent catalog', () => {
  test('returns selected holdings sorted by display with title fallback and ledger-keyed materialization', async () => {
    const fixture = workspaceFixture();
    const scopePath = join(fixture.base, 'scope.json');
    const objectIdA = `sha256:${'a'.repeat(64)}` as Sha256Id;
    const objectIdB = `sha256:${'b'.repeat(64)}` as Sha256Id;
    const objectA = catalogObject(objectIdA, {
      sourceLocators: ['https://example.invalid/library/alpha-notes.txt'],
      byteSize: 101,
      trustTier: 'reviewed-a',
    });
    const objectB = catalogObject(objectIdB, {
      title: 'Zulu Work',
      creator: 'Neutral Creator',
      sourceLocators: ['https://example.invalid/library/unshown-slug.txt'],
      byteSize: 202,
      trustTier: 'reviewed-b',
    });
    const master = finalizeMasterManifest({
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      revision: 3,
      ingestionCursor: null,
      objects: [objectA, objectB],
      tombstones: [],
    });
    writeFileSync(scopePath, serializeScopeManifest({
      agentId: 'neutral-agent',
      schemaVersion: SCOPE_SCHEMA_VERSION,
      selection: { objectIds: [objectIdA, objectIdB] },
      targetCorpusDisplayName: 'neutral-catalog',
      masterRevision: 3,
    }));
    const ledger = canonicalJson({
      schemaVersion: 1,
      revision: 1,
      entries: [{
        objectId: objectIdB,
        ragFileId: 'rag-files/zulu',
        targetCorpusDisplayName: 'neutral-catalog',
        corpusResourceName: 'projects/fixture/locations/us-central1/ragCorpora/1',
        importedAtRevision: 3,
      }],
    });
    const calls: CapturedCall[] = [];
    const worker = createRawDomainExpertWorker({
      agentRouting: validateAgentRoutingConfig({
        neutral: {
          library: { bucket: 'neutral-bucket', prefix: 'shared/library' },
          pageLibrary: { sourceId: 'neutral' },
          scopeManifestPath: scopePath,
        },
      }),
      google: {
        accessToken: 'fixture-google-token',
        fetchImpl: fakeGoogleFetch(calls, {
          gcsObjects: {
            'shared/library/manifest/master.json': serializeMasterManifest(master),
            'shared/library/ledgers/neutral-agent.json': ledger,
          },
        }),
      },
    });

    try {
      const result = await postDomain(worker, 'domain_agent', { action: 'catalog', domain_id: 'neutral' });
      expect(result).toMatchObject({
        kind: 'domain_agent_catalog',
        domainId: 'neutral',
        targetCorpusDisplayName: 'neutral-catalog',
        objects: [
          {
            objectId: objectIdA,
            display: 'Alpha Notes',
            byteSize: 101,
            trustTier: 'reviewed-a',
            materialized: false,
          },
          {
            objectId: objectIdB,
            display: 'Zulu Work',
            creator: 'Neutral Creator',
            byteSize: 202,
            trustTier: 'reviewed-b',
            materialized: true,
          },
        ],
        summary: {
          libraryRevision: 3,
          totalObjects: 2,
          tombstones: 0,
          selected: 2,
          materialized: 1,
          unmaterializedIds: [objectIdA],
        },
      });
      expect(JSON.stringify(result)).not.toContain('example.invalid');
      expect(calls).toHaveLength(2);
      expect(calls.every((call) => call.method === 'GET')).toBeTrue();
    } finally {
      fixture.cleanup();
    }
  });

  test('refuses catalog reads for an unconfigured domain with agent_not_configured', async () => {
    const worker = createRawDomainExpertWorker({ agentRouting: {} });
    const response = await postDomainResponse(worker, 'domain_agent', {
      action: 'catalog',
      domain_id: 'neutral',
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'agent_not_configured' } });
  });

  test('returns a typed content-free error for an unreadable master manifest', async () => {
    const fixture = workspaceFixture();
    const scopePath = join(fixture.base, 'scope.json');
    writeFileSync(scopePath, serializeScopeManifest({
      agentId: 'neutral-agent',
      schemaVersion: SCOPE_SCHEMA_VERSION,
      selection: { objectIds: [] },
      targetCorpusDisplayName: 'neutral-catalog',
      masterRevision: 0,
    }));
    const sensitiveFixture = 'private-source-text-must-not-escape';
    const worker = createRawDomainExpertWorker({
      agentRouting: validateAgentRoutingConfig({
        neutral: {
          library: { bucket: 'neutral-bucket', prefix: 'shared/library' },
          pageLibrary: { sourceId: 'neutral' },
          scopeManifestPath: scopePath,
        },
      }),
      google: {
        accessToken: 'fixture-google-token',
        fetchImpl: fakeGoogleFetch([], {
          gcsObjects: { 'shared/library/manifest/master.json': sensitiveFixture },
        }),
      },
    });

    try {
      const response = await postDomainResponse(worker, 'domain_agent', {
        action: 'catalog',
        domain_id: 'neutral',
      });
      const bodyText = await response.text();
      expect(response.status).toBe(502);
      expect(JSON.parse(bodyText)).toMatchObject({ error: { code: 'library_catalog_unreadable' } });
      expect(bodyText).not.toContain(sensitiveFixture);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('Google credential health', () => {
  test('readable service-account fixture reports Google ready without a network call', async () => {
    const fixture = workspaceFixture();
    let networkCalls = 0;
    const credentialPath = join(fixture.base, 'service-account.json');
    writeFileSync(credentialPath, JSON.stringify({
      client_email: 'fixture@example.test',
      private_key: 'fixture-private-key',
    }));

    try {
      const worker = createDomainExpertWorker({
        google: {
          serviceAccountJsonPath: credentialPath,
          fetchImpl: Object.assign(
            async () => {
              networkCalls += 1;
              return new Response('{}');
            },
            { preconnect: () => undefined },
          ),
        },
      });

      const health = await getHealth(worker);
      expect(health).toMatchObject({
        configured: { google: true },
        configuration_status: { google: 'ready' },
      });
      expect(networkCalls).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  test('service-account credential with a non-https token_uri reports Google unreadable', async () => {
    const worker = createDomainExpertWorker({
      google: {
        serviceAccountJson: JSON.stringify({
          client_email: 'fixture@example.test',
          private_key: 'fixture-private-key',
          token_uri: 'http://token-sink.example.invalid/token',
        }),
      },
    });

    expect(await getHealth(worker)).toMatchObject({
      configured: { google: false },
      configuration_status: { google: 'unreadable' },
    });
  });

  test('service-account credential with an https token_uri reports Google ready', async () => {
    const worker = createDomainExpertWorker({
      google: {
        serviceAccountJson: JSON.stringify({
          client_email: 'fixture@example.test',
          private_key: 'fixture-private-key',
          token_uri: 'https://oauth2.example.invalid/token',
        }),
      },
    });

    expect(await getHealth(worker)).toMatchObject({
      configured: { google: true },
      configuration_status: { google: 'ready' },
    });
  });

  test('unreadable service-account path reports Google unreadable', async () => {
    const fixture = workspaceFixture();
    try {
      const worker = createDomainExpertWorker({
        google: { serviceAccountJsonPath: join(fixture.base, 'missing-service-account.json') },
      });

      expect(await getHealth(worker)).toMatchObject({
        configured: { google: false },
        configuration_status: { google: 'unreadable' },
      });
    } finally {
      fixture.cleanup();
    }
  });

  test('inline service-account JSON must parse and contain required fields', async () => {
    const readyWorker = createDomainExpertWorker({
      google: {
        serviceAccountJson: JSON.stringify({
          client_email: 'fixture@example.test',
          private_key: 'fixture-private-key',
        }),
      },
    });
    const invalidWorker = createDomainExpertWorker({
      google: { serviceAccountJson: '{"client_email":' },
    });
    const incompleteWorker = createDomainExpertWorker({
      google: { serviceAccountJson: JSON.stringify({ client_email: 'fixture@example.test' }) },
    });

    expect(await getHealth(readyWorker)).toMatchObject({
      configured: { google: true },
      configuration_status: { google: 'ready' },
    });
    expect(await getHealth(invalidWorker)).toMatchObject({
      configured: { google: false },
      configuration_status: { google: 'unreadable' },
    });
    expect(await getHealth(incompleteWorker)).toMatchObject({
      configured: { google: false },
      configuration_status: { google: 'unreadable' },
    });
  });

  test('access token reports Google ready', async () => {
    const worker = createDomainExpertWorker({ google: { accessToken: 'fixture-google-token' } });

    expect(await getHealth(worker)).toMatchObject({
      configured: { google: true },
      configuration_status: { google: 'ready' },
    });
  });

  test('absent Google credentials report not configured', async () => {
    const worker = createDomainExpertWorker();

    expect(await getHealth(worker)).toMatchObject({
      configured: { google: false },
      configuration_status: { google: 'not_configured' },
    });
  });
});

function workspaceFixture(): {
  base: string;
  workspaceRoot: string;
  cleanup: () => void;
} {
  const base = mkdtempSync(join(tmpdir(), 'expert-agents-worker-'));
  const workspaceRoot = join(base, 'workspace');
  mkdirSync(workspaceRoot);
  return {
    base,
    workspaceRoot,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

async function postDomain(
  worker: { fetch(request: Request): Promise<Response> },
  tool: string,
  params: Record<string, unknown>,
): Promise<Record<string, any>> {
  const response = await postDomainResponse(worker, tool, params);
  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, any>>;
}

function postDomainResponse(
  worker: { fetch(request: Request): Promise<Response> },
  tool: string,
  params: Record<string, unknown>,
): Promise<Response> {
  return worker.fetch(new Request('http://worker.test/v1/domain', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool, params }),
  }));
}

async function getHealth(
  worker: { fetch(request: Request): Promise<Response> },
): Promise<Record<string, any>> {
  const response = await worker.fetch(new Request('http://worker.test/v1/health'));
  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, any>>;
}

function fakeGoogleFetch(
  calls: CapturedCall[],
  options: { gcsObjects?: Record<string, string> } = {},
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const body = init?.body ? await new Response(init.body as BodyInit).text() : '';
    const headers = headersRecord(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    calls.push({ url, method, body, headers });

    if (method === 'GET' && new URL(url).pathname.includes('/storage/v1/b/')) {
      const encodedName = new URL(url).pathname.split('/o/')[1];
      const objectName = encodedName === undefined ? '' : decodeURIComponent(encodedName);
      const value = options.gcsObjects?.[objectName];
      if (value === undefined) return jsonResponse({ error: 'fixture object not found' }, 404);
      // A metadata read answers as GCS does; any other read answers the object.
      if (new URL(url).searchParams.get('fields')?.includes('md5Hash')) {
        return jsonResponse({ generation: '1', size: String(Buffer.byteLength(value)), md5Hash: createHash('md5').update(value).digest('base64') });
      }
      return new Response(value);
    }
    return jsonResponse({ error: `unexpected Google fixture URL: ${url}` }, 500);
  }) as typeof fetch;
}

function catalogObject(id: Sha256Id, overrides: Partial<LibraryObject> = {}): LibraryObject {
  const mediaType = overrides.mediaType ?? 'text/plain';
  return {
    id,
    sourceLocators: ['https://example.invalid/library/neutral-object.txt'],
    mediaType,
    derivativeKind: null,
    byteSize: 10,
    provenance: {
      acquiredBy: 'neutral-fixture',
      acquiredAt: '2026-01-02T03:04:05.000Z',
      acquisitionMethod: 'offline-fixture',
    },
    trustTier: 'reviewed',
    copyrightPosture: 'fixture-only',
    lineage: { supersedes: [], supersededBy: [] },
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T03:04:05.000Z',
    relativePath: canonicalObjectRelativePath(id, mediaType),
    ...overrides,
  };
}

function fakeAcquisitionFetch(calls: CapturedCall[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    calls.push({
      url,
      method,
      body: init?.body ? await new Response(init.body as BodyInit).text() : '',
      headers: headersRecord(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
    });
    if (url.startsWith('https://annas.example/download/book-one')) {
      return new Response(bytesBody(FIXTURE_EPUB), { status: 200, headers: { 'content-type': 'application/epub+zip' } });
    }
    return jsonResponse({ error: `unexpected acquisition fixture URL: ${url}` }, 500);
  }) as typeof fetch;
}

function fakeAnnasArtifactFetch(calls: CapturedCall[], bytes: Uint8Array, contentType: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({
      url,
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      body: init?.body ? await new Response(init.body as BodyInit).text() : '',
      headers: headersRecord(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
    });
    if (url.startsWith('https://annas.example/download/')) {
      return new Response(bytesBody(bytes), { status: 200, headers: { 'content-type': contentType } });
    }
    return jsonResponse({ error: `unexpected acquisition fixture URL: ${url}` }, 500);
  }) as typeof fetch;
}

function annasAuditRecords(booksRoot: string): Array<Record<string, any>> {
  return readFileSync(join(booksRoot, '.expert-agents-annas-audit.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

// PDF skeletons built in-test — no binary fixture files, no network, and a page
// count the caller chooses. This is the plain shape: a page tree whose /Count
// states the total, plus one page object per page.
function syntheticPdfBytes(pages: number): Uint8Array {
  const kids = Array.from({ length: pages }, (_, index) => `${index + 3} 0 R`).join(' ');
  const pageObjects = Array.from({ length: pages }, (_, index) =>
    `${index + 3} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n`).join('');
  return new TextEncoder().encode([
    '%PDF-1.7\n',
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    `2 0 obj\n<< /Type /Pages /Count ${pages} /Kids [${kids}] >>\nendobj\n`,
    pageObjects,
    'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
  ].join(''));
}

// The shape a modern writer emits: the page objects live inside a FlateDecode
// object stream, and deflate Huffman-codes them, so no page marker is visible in
// the file's plain bytes at all.
function syntheticObjectStreamPdfBytes(pages: number): Uint8Array {
  const packed = Array.from({ length: pages }, () => '<< /Type /Page /MediaBox [0 0 612 792] >>').join('\n');
  const compressed = new Uint8Array(deflateSync(Buffer.from(packed, 'latin1')));
  return concatBytes([
    new TextEncoder().encode([
      '%PDF-1.7\n',
      '1 0 obj\n<< /Type /Catalog >>\nendobj\n',
      `2 0 obj\n<< /Type /ObjStm /N ${pages} /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`,
    ].join('')),
    compressed,
    new TextEncoder().encode('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'),
  ]);
}

// A stored (uncompressed) ZIP, which is all the EPUB measure needs: it reads the
// uncompressed sizes out of the central directory and inflates nothing.
function syntheticEpubBytes(names: string[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const name of names) {
    const nameBytes = encoder.encode(name);
    const content = encoder.encode(`<html><body>${name} body text</body></html>`);
    const local = new Uint8Array(30 + nameBytes.length + content.length);
    const localFields = new DataView(local.buffer);
    localFields.setUint32(0, 0x04034b50, true);
    localFields.setUint16(4, 20, true);
    localFields.setUint32(18, content.length, true);
    localFields.setUint32(22, content.length, true);
    localFields.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(content, 30 + nameBytes.length);
    locals.push(local);

    const header = new Uint8Array(46 + nameBytes.length);
    const headerFields = new DataView(header.buffer);
    headerFields.setUint32(0, 0x02014b50, true);
    headerFields.setUint32(20, content.length, true);
    headerFields.setUint32(24, content.length, true);
    headerFields.setUint16(28, nameBytes.length, true);
    headerFields.setUint32(42, offset, true);
    header.set(nameBytes, 46);
    central.push(header);
    offset += local.length;
  }
  const directory = concatBytes(central);
  const eocd = new Uint8Array(22);
  const eocdFields = new DataView(eocd.buffer);
  eocdFields.setUint32(0, 0x06054b50, true);
  eocdFields.setUint16(8, names.length, true);
  eocdFields.setUint16(10, names.length, true);
  eocdFields.setUint32(12, directory.length, true);
  eocdFields.setUint32(16, offset, true);
  return concatBytes([...locals, directory, eocd]);
}

// Response bodies want an owned ArrayBuffer, and these fixtures carry real binary
// (a deflate stream, a ZIP directory) that a string body would mangle.
function bytesBody(bytes: Uint8Array): ArrayBuffer {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return body;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}

interface AnnasSearchFixtureRecord {
  md5: string;
  title: string;
  author: string;
  metadata: string;
}

// Mirrors the live result markup closely enough to exercise the parser: a cover link and a
// title link to the same /md5/ record, an author link marked by the user-edit icon, and one
// interpunct-separated metadata line. Partial matches sit behind the js-partial-matches
// container the site uses when the query itself matched nothing.
function annasSearchPageHtml(records: AnnasSearchFixtureRecord[], partial: AnnasSearchFixtureRecord[] = []): string {
  const item = (record: AnnasSearchFixtureRecord) => [
    '<div class="flex pt-3 pb-3 border-b">',
    `<a href="/md5/${record.md5}" class="custom-a block mr-2 hover:opacity-80">`,
    `<div id="list_cover_aarecord_id__md5:${record.md5}" class="w-20 rounded shadow">`,
    `<div class="font-bold text-violet-900" data-content="${record.title}"></div>`,
    '</div></a>',
    '<div class="max-w-full overflow-hidden flex flex-col">',
    `<div class="text-[9px] text-gray-500 font-mono">lgli/fixture/${record.md5}.epub</div>`,
    `<a href="/md5/${record.md5}" class="js-vim-focus custom-a font-semibold text-lg">${record.title}</a>`,
    `<a href="/search?q=${encodeURIComponent(record.author)}" class="custom-a text-sm">`,
    `<span class="icon-[mdi--user-edit] text-base align-sub"></span> ${record.author}</a>`,
    `<div class="text-gray-800 font-semibold text-sm mt-2">${record.metadata} · `,
    '<a href="#" class="custom-a">Save</a></div>',
    '</div></div>',
  ].join('\n');
  const partialBlock = partial.length
    ? `<div class="js-partial-matches-show"><div class="js-aarecord-list-outer">${partial.map(item).join('\n')}</div></div>`
    : '';
  return [
    '<html><body><div class="js-aarecord-list-outer">',
    records.map(item).join('\n'),
    '</div>',
    partialBlock,
    '</body></html>',
  ].join('\n');
}

function fakeSearchPageFetch(calls: CapturedCall[], html: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? 'GET',
      body: '',
      headers: headersRecord(init?.headers),
    });
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }) as typeof fetch;
}

function fakeFastDownloadFetch(
  calls: CapturedCall[],
  envelope: { downloadUrl?: string; error?: string; status?: number },
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: '',
      headers: headersRecord(init?.headers),
    });
    if (url.includes('/dyn/api/fast_download.json')) {
      return jsonResponse(
        { download_url: envelope.downloadUrl ?? null, ...(envelope.error ? { error: envelope.error } : {}) },
        envelope.status ?? 200,
      );
    }
    if (envelope.downloadUrl && url === envelope.downloadUrl) {
      return new Response('fixture-book-bytes', { status: 200, headers: { 'content-type': 'application/epub+zip' } });
    }
    return jsonResponse({ error: `unexpected fast download fixture URL: ${url}` }, 500);
  }) as typeof fetch;
}

type PinnedFetchImpl = NonNullable<DomainExpertWorkerOptions['webImportFetchImpl']>;

// The partner hop runs on the pinned transport, so a fixture stands in for it rather
// than for a generic fetch. It records into the same call log as the member-API fake
// so the "no credential reaches the partner host" assertions still see both hops, and
// it captures the addresses the guard validated so pinning can be asserted.
function fakePartnerFetch(
  calls: CapturedCall[],
  routes: Record<string, () => Response>,
  pinned: string[][] = [],
): PinnedFetchImpl {
  return async (url, options) => {
    calls.push({ url: url.toString(), method: 'GET', body: '', headers: {} });
    pinned.push([...options.validatedAddresses]);
    const route = routes[url.toString()];
    if (!route) return jsonResponse({ error: `unexpected partner fixture URL: ${url.toString()}` }, 500);
    return route();
  };
}

function partnerBytesResponse(): Response {
  return new Response('fixture-book-bytes', { status: 200, headers: { 'content-type': 'application/epub+zip' } });
}

function partnerRedirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  new Headers(headers).forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// A live ingest walks corpus resolution, a GCS media upload and the corpus import in one
// call, so the stub answers all three with the resolved corpus the request asked for.
// The display name is the one the `research` fixture domain is routed to, because an
// ingest may only reach a corpus that domain is configured for.
describe('acquisition directory allowlist', () => {
  const IMPORT_PREFIX = 'gs://fixture-shared-library/v1/book-imports/';
  // A library narrower than the shared version root, so the import prefix is not covered by it.
  const ROUTING = validateAgentRoutingConfig({
    research: { library: { bucket: 'fixture-shared-library', prefix: 'v1/factory/research' }, pageLibrary: { sourceId: 'research' } },
  });
  const worker = () => createDomainExpertWorker({
    agentRouting: ROUTING,
    annas: { apiKey: 'fixture-acquisition-token', baseUrl: 'https://annas.example', importGcsPrefix: IMPORT_PREFIX },
  });

  test('library_ingest reads from the domain library and its own acquisition directory only', async () => {
    const w = worker();
    for (const gcsUri of ['gs://fixture-shared-library/v1/factory/research/a.pdf', `${IMPORT_PREFIX}research/a.pdf`]) {
      const plan = await postDomain(w, 'library_ingest', { action: 'start', domain_id: 'research', gcs_uri: gcsUri });
      expect(plan).toMatchObject({ status: 'dry_run', sources: [{ gcs_uri: gcsUri }] });
    }
    // Another domain's acquisitions, a sibling name sharing the prefix, the shared root and dot segments stay outside.
    for (const gcsUri of [
      `${IMPORT_PREFIX}history/a.pdf`,
      `${IMPORT_PREFIX}research-other/a.pdf`,
      `${IMPORT_PREFIX}a.pdf`,
      `${IMPORT_PREFIX}research/../history/a.pdf`,
    ]) {
      const refused = await postDomainResponse(w, 'library_ingest', { action: 'start', domain_id: 'research', gcs_uri: gcsUri });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: { code: 'gcs_source_not_allowed' } });
    }
  });

  test('without a configured import prefix only the library is readable', async () => {
    const w = createDomainExpertWorker({ agentRouting: ROUTING });
    const refused = await postDomainResponse(w, 'library_ingest', { action: 'start', domain_id: 'research', gcs_uri: `${IMPORT_PREFIX}research/a.pdf` });
    expect(refused.status).toBe(403);
  });
});

describe('acquisition GCS destinations', () => {
  const PREFIX = 'gs://fixture-shared-library/v1/book-imports/';

  test('a dot segment cannot walk out of an allowed directory', () => {
    expect(() => assertAllowedGcsDestination(`${PREFIX}research/../history/a.pdf`, [`${PREFIX}research`])).toThrow('path segments');
    expect(() => assertAllowedGcsDestination(`${PREFIX}research/./a.pdf`, [`${PREFIX}research`])).toThrow('path segments');
    expect(() => assertAllowedGcsDestination(`${PREFIX}research/a..b.pdf`, [`${PREFIX}research`])).not.toThrow();
  });
});

describe('worker authentication posture', () => {
  test('refuses to start on loopback without a token', () => {
    expect(() => warnIfWorkerAuthDisabled('test worker', undefined, '127.0.0.1', {}))
      .toThrow(/refuses to start without EXPERT_AGENTS_DOMAIN_EXPERT_AUTH_TOKEN/);
  });

  test('refuses to start on a non-loopback host without a token', () => {
    expect(() => warnIfWorkerAuthDisabled('test worker', undefined, '0.0.0.0', {}))
      .toThrow(/cannot bind to a non-loopback host/);
  });

  test('allows an explicit unauthenticated loopback opt-out for local development', () => {
    expect(() => warnIfWorkerAuthDisabled('test worker', undefined, '127.0.0.1', {
      [ALLOW_UNAUTHENTICATED_ENV]: '1',
    })).not.toThrow();
  });

  test('the opt-out does not apply to a non-loopback host', () => {
    expect(() => warnIfWorkerAuthDisabled('test worker', undefined, '0.0.0.0', {
      [ALLOW_UNAUTHENTICATED_ENV]: '1',
    })).toThrow(/cannot bind to a non-loopback host/);
  });

  test('a configured token satisfies the guard on any host', () => {
    expect(() => warnIfWorkerAuthDisabled('test worker', 'fixture-token', '0.0.0.0', {})).not.toThrow();
  });

  test('bearer auth rejects a mismatched token and accepts the expected one', async () => {
    const handler = withWorkerBearerAuth(async () => new Response('ok'), { authToken: 'fixture-token' });
    const rejected = await handler(new Request('http://127.0.0.1/v1/health', {
      headers: { Authorization: 'Bearer wrong-token' },
    }));
    expect(rejected.status).toBe(401);
    const accepted = await handler(new Request('http://127.0.0.1/v1/health', {
      headers: { Authorization: 'Bearer fixture-token' },
    }));
    expect(accepted.status).toBe(200);
  });
});

function textPdfBytes(pages: number, blankPages: ReadonlySet<number> = new Set()): Uint8Array {
  const kids = Array.from({ length: pages }, (_, index) => `${4 + 2 * index} 0 R`).join(' ');
  const body = Array.from({ length: pages }, (_, index) => {
    const stream = blankPages.has(index + 1) ? '' : `BT /F1 12 Tf 72 720 Td (Fixture page ${index + 1}) Tj ET`;
    return `${4 + 2 * index} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * index} 0 R >>\nendobj\n`
      + `${5 + 2 * index} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`;
  }).join('');
  return new TextEncoder().encode([
    '%PDF-1.7\n',
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    `2 0 obj\n<< /Type /Pages /Count ${pages} /Kids [${kids}] >>\nendobj\n`,
    '3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    body,
    'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
  ].join(''));
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('PDF part planning', () => {
  test('parts are balanced, contiguous, at most the split size, and cover every page once', () => {
    expect(planPdfParts(508, 200).map((part) => [part.firstPage, part.lastPage])).toEqual([[1, 170], [171, 339], [340, 508]]);
    expect(planPdfParts(334, 200).map((part) => part.pages)).toEqual([167, 167]);
    expect(planPdfParts(201, 200).map((part) => part.pages)).toEqual([101, 100]);
    expect(planPdfParts(200, 200)).toEqual([{ index: 1, of: 1, firstPage: 1, lastPage: 200, pages: 200 }]);
    for (const pages of [201, 399, 400, 401, 1234]) {
      const plan = planPdfParts(pages, 200);
      expect(plan.every((part) => part.pages <= 200 && part.of === plan.length)).toBe(true);
      expect(plan.reduce((total, part) => total + part.pages, 0)).toBe(pages);
      plan.forEach((part, index) => expect(part.firstPage).toBe(index === 0 ? 1 : plan[index - 1]!.lastPage + 1));
    }
    expect(() => planPdfParts(0, 200)).toThrow();
    expect(() => planPdfParts(10, 0)).toThrow();
  });

  test('part names follow <stem>--partNofM and strip back to the book stem', () => {
    expect(pdfPartStem('riker - liberalism (1982)', { index: 2, of: 3 })).toBe('riker - liberalism (1982)--part2of3');
    expect(stripPdfPartSuffix('riker - liberalism (1982)--part2of3')).toBe('riker - liberalism (1982)');
    expect(stripPdfPartSuffix('riker - liberalism (1982)')).toBe('riker - liberalism (1982)');
  });

  test('qpdf splits a PDF into parts holding exactly the planned pages, identically on every run', async () => {
    const qpdf = Bun.which('qpdf');
    expect(qpdf, 'qpdf must be installed for the PDF split tests').toBeTruthy();
    const bytes = textPdfBytes(9);
    expect(await qpdfPageCount(qpdf!, bytes)).toBe(9);
    const plan = planPdfParts(9, 4);
    const parts = await splitPdf(qpdf!, bytes, plan);
    expect(await Promise.all(parts.map((part) => qpdfPageCount(qpdf!, part.bytes)))).toEqual([3, 3, 3]);
    const again = await splitPdf(qpdf!, bytes, plan);
    expect(again.map((part) => sha256Hex(part.bytes))).toEqual(parts.map((part) => sha256Hex(part.bytes)));
  });
});

test('qpdf finishing with warnings (exit 3) still yields the parts', async () => {
  const qpdf = Bun.which('qpdf');
  expect(qpdf, 'qpdf must be installed for the PDF split tests').toBeTruthy();
  const directory = mkdtempSync(join(tmpdir(), 'expert-qpdf-warn-'));
  try {
    const shim = join(directory, 'qpdf-warns');
    writeFileSync(shim, `#!/bin/sh\n"${qpdf}" "$@"\nstatus=$?\n[ $status -eq 0 ] && { echo "WARNING: fixture warning" >&2; exit 3; }\nexit $status\n`, { mode: 0o755 });
    const parts = await splitPdf(shim, textPdfBytes(6), planPdfParts(6, 4));
    expect(parts.map((part) => part.pages)).toEqual([3, 3]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
