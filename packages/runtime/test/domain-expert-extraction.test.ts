import { describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import type { CatalogEntry, ExtractionRequest } from '@expert-agents/library';
import { validateAgentRoutingConfig } from '../src/core/agent-routing.ts';
import {
  createDomainExpertWorker,
  type DomainExpertWorkerOptions,
} from '../src/workers/domain-expert/index.ts';
import type { PageIndexWriter } from '../src/workers/domain-expert/page-ingest.ts';

// How library_ingest fetches and extracts a URL: the pinned bytes, the summarize
// subprocess for media, and what is left behind afterwards.

const PAGE_URL = 'https://example.com/article';
const YOUTUBE_URL = 'https://www.youtube.com/watch?v=fixture-video';
const PAGE_BYTES = '<html><head><title>Pinned Fixture</title></head><body>already fetched</body></html>';
const EXTRACTED_MARKDOWN = `# Extracted fixture\n\nPinned body. ${Array.from({ length: 120 }, (_, i) => `word${i % 9}`).join(' ')}\n`;
const TEMP_FILE_PREFIX = '.web-import-extraction-';

describe('library_ingest URL extraction inputs', () => {
  test('YouTube URLs run the real extractor with a private writable summarize cache outside the caller home and cwd', async () => {
    const fixture = extractionFixture();
    const priorCwd = process.cwd();
    const priorHome = process.env.HOME;
    const inheritedHome = join(fixture.base, 'read-only-service-home');
    const extractor = join(fixture.base, 'relative-summarize');
    mkdirSync(inheritedHome, { mode: 0o500 });
    writeFileSync(join(fixture.base, '.env'), 'OPENAI_API_KEY=sentinel-must-not-load\n');
    writeFileSync(
      extractor,
      `#!/bin/sh\nif [ -f .env ]; then echo loaded-caller-dotenv >&2; exit 91; fi\ncase "$HOME" in /*) ;; *) echo relative-home >&2; exit 92;; esac\n[ -d "$HOME" ] || exit 93\nmkdir -p "$HOME/.summarize" || exit 94\nprintf cache > "$HOME/.summarize/cache.sqlite" || exit 95\nprintf "# Private cwd extraction\\n\\nNo caller dotenv loaded. ${'filler '.repeat(120)}\\n"\n`,
      { mode: 0o755 },
    );
    try {
      process.chdir(fixture.base);
      process.env.HOME = inheritedHome;
      const worker = extractionWorker(fixture, { summarizeBin: './relative-summarize', dataDir: 'data' });

      const job = await ingestUrl(worker, YOUTUBE_URL);

      expect(job.sources[0]).toMatchObject({ state: 'parsed', kind: 'sections' });
      const read = await call(worker, 'domain_library', { action: 'read', slug: `books/${job.sources[0].book}/s0001` });
      expect(String(read.body.text)).toContain('No caller dotenv loaded.');
      expect(JSON.stringify(job)).not.toContain('sentinel-must-not-load');
      expect(JSON.stringify(job)).not.toContain('loaded-caller-dotenv');
      expect(readdirSync(inheritedHome)).toEqual([]);
      expect(temporaryExtractionDirectories(fixture.dataDir)).toEqual([]);
      expect(temporaryExtractionFiles(fixture.dataDir)).toEqual([]);
    } finally {
      process.chdir(priorCwd);
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      fixture.cleanup();
    }
  });

  test('recognizes an OSF-style octet-stream PDF by magic and disposition without invoking summarize', async () => {
    const fixture = extractionFixture();
    const pdfBytes = new Uint8Array(1_000_000);
    pdfBytes.fill(0x20);
    pdfBytes.set(new TextEncoder().encode([
      '%PDF-1.3\n',
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
      '2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n',
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n',
      'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
    ].join('')));
    let extractionCalls = 0;
    try {
      const worker = extractionWorker(fixture, {
        webImportFetchImpl: async () => new Response(pdfBytes, {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="Paper v4.pdf"',
          },
        }),
        summarizeExtract: async () => {
          extractionCalls += 1;
          return { exitCode: 0, stdout: EXTRACTED_MARKDOWN, stderr: '' };
        },
      });

      await ingestUrl(worker, 'https://osf.example/download/ev6ry/');

      expect(extractionCalls).toBe(0);
      // It was taken as a PDF: stored as an original under its content hash.
      expect(fixture.uploads).toEqual([expect.stringMatching(/\/originals\/[0-9a-f]{64}\.pdf$/)]);
      expect(temporaryExtractionDirectories(fixture.dataDir)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  test('does not trust a PDF filename when the fetched bytes are HTML', async () => {
    const fixture = extractionFixture();
    const htmlMentioningPdf = `<!doctype html><html><head><title>PDF reference</title></head><body><article><h1>PDF reference</h1><p>A PDF starts with %PDF-1.7</p><p>${'prose '.repeat(150)}</p></article></body></html>`;
    let extractionCalls = 0;
    try {
      const worker = extractionWorker(fixture, {
        webImportFetchImpl: async () => new Response(htmlMentioningPdf, {
          status: 200,
          headers: {
            'content-type': 'text/html',
            'content-disposition': 'attachment; filename="not-a-pdf.pdf"',
          },
        }),
        summarizeExtract: async () => {
          extractionCalls += 1;
          return { exitCode: 0, stdout: EXTRACTED_MARKDOWN, stderr: '' };
        },
      });

      const job = await ingestUrl(worker, 'https://example.com/not-a-pdf.pdf');

      // The pinned HTML bytes are converted in process: the .pdf filename does
      // not send them to the subprocess either, and nothing is stored as a PDF.
      expect(extractionCalls).toBe(0);
      expect(fixture.uploads).toEqual([]);
      expect(job.sources[0]).toMatchObject({ state: 'parsed', kind: 'sections', title: 'PDF reference' });
    } finally {
      fixture.cleanup();
    }
  });

  test('a web page is converted from the pinned bytes without invoking summarize or leaving temp artifacts', async () => {
    const fixture = extractionFixture();
    const page = [
      '<!doctype html><html><head><title>Converted Fixture</title>',
      '<style>body { color: red; }</style></head><body>',
      '<h1>Real Heading</h1>',
      '<p>Real body sentence.</p>',
      `<p>${'filler '.repeat(150)}</p>`,
      '<script>window.tracker = "script-payload-must-not-survive";</script>',
      '<style>.hidden { display: none; }</style>',
      '</body></html>',
    ].join('');
    try {
      // No summarizeExtract override and a binary that does not exist: the page
      // lane must not need the subprocess at all.
      const worker = extractionWorker(fixture, {
        webImportFetchImpl: async () => new Response(page, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      });

      const job = await ingestUrl(worker, PAGE_URL);

      expect(temporaryExtractionFiles(fixture.dataDir)).toEqual([]);
      expect(temporaryExtractionDirectories(fixture.dataDir)).toEqual([]);
      const [source] = job.sources;
      expect(source).toMatchObject({ state: 'parsed', title: 'Converted Fixture', kind: 'sections' });
      const read = await call(worker, 'domain_library', { action: 'read', slug: `books/${source.book}/s0001` });
      const staged = String(read.body.text);
      // The page's own text survives the conversion.
      expect(staged).toContain('Real body sentence.');
      // Scripts and styles are dropped, not stored.
      expect(staged).not.toContain('script-payload-must-not-survive');
      expect(staged).not.toContain('color: red');
      expect(staged).not.toContain('display: none');
    } finally {
      fixture.cleanup();
    }
  });

  test('YouTube sources stay in URL mode and get a private HOME and cache inside the worker data dir', async () => {
    const fixture = extractionFixture();
    let request: ExtractionRequest | undefined;
    try {
      const worker = extractionWorker(fixture, {
        summarizeExtract: async (value) => {
          request = value;
          return { exitCode: 0, stdout: EXTRACTED_MARKDOWN, stderr: '' };
        },
      });

      const job = await ingestUrl(worker, YOUTUBE_URL);

      expect(request?.source).toBe(YOUTUBE_URL);
      expect(request!.env.HOME).toStartWith(`${fixture.dataDir}${sep}.extraction-runtime-`);
      expect(request!.env.HOME).not.toBe(process.env.HOME);
      expect(request!.env.XDG_CACHE_HOME).toBe(join(dirname(request!.env.HOME), 'cache'));
      expect(request!.env.XDG_CONFIG_HOME).toBe(join(dirname(request!.env.HOME), 'config'));
      expect(request!.workingDirectory).toStartWith(`${fixture.dataDir}${sep}.extraction-runtime-`);
      expect(temporaryExtractionFiles(fixture.dataDir)).toEqual([]);
      expect(temporaryExtractionDirectories(fixture.dataDir)).toEqual([]);
      expect(job.sources[0]).toMatchObject({ state: 'parsed' });
    } finally {
      fixture.cleanup();
    }
  });

  test('a page with no convertible text is refused with the empty-extraction code', async () => {
    const fixture = extractionFixture();
    const emptyPage = '<html><head><title>Empty Fixture</title><style>body{}</style></head><body><script>const tracker = 1;</script>   </body></html>';
    try {
      const worker = extractionWorker(fixture, {
        webImportFetchImpl: async () => new Response(emptyPage, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      });

      const job = await ingestUrl(worker, PAGE_URL);

      expect(job.state).toBe('done_with_failures');
      expect(job.sources[0]).toMatchObject({ state: 'failed', error: expect.stringContaining('html-to-markdown produced no text') });
      // The refusal names the converter, not a diagnostic it never had, and
      // repeats none of the page back.
      expect(String(job.sources[0].error)).not.toContain('no diagnostic output');
      expect(JSON.stringify(job)).not.toContain('const tracker = 1;');
      expect(temporaryExtractionFiles(fixture.dataDir)).toEqual([]);
      expect(temporaryExtractionDirectories(fixture.dataDir)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  test('YouTube extraction failures keep the typed error and remove the private runtime directory', async () => {
    const fixture = extractionFixture();
    try {
      const worker = extractionWorker(fixture, {
        summarizeExtract: async (request) => {
          expect(request.source).toBe(YOUTUBE_URL);
          return { exitCode: 7, stdout: '', stderr: 'fixture extraction failure\nprivate diagnostic tail' };
        },
      });

      const job = await ingestUrl(worker, YOUTUBE_URL);

      expect(job.state).toBe('done_with_failures');
      expect(job.sources[0]).toMatchObject({ state: 'failed', error: expect.stringContaining('fixture extraction failure') });
      expect(temporaryExtractionFiles(fixture.dataDir)).toEqual([]);
      expect(temporaryExtractionDirectories(fixture.dataDir)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });
});

function extractionFixture(): {
  base: string;
  workspaceRoot: string;
  dataDir: string;
  tree: string;
  uploads: string[];
  cleanup(): void;
} {
  const base = mkdtempSync(join(tmpdir(), 'domain-expert-extraction-'));
  const workspaceRoot = join(base, 'workspace');
  const dataDir = join(base, 'data');
  mkdirSync(workspaceRoot);
  return {
    base,
    workspaceRoot,
    dataDir,
    tree: join(base, 'tree'),
    uploads: [],
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function recordingWriter(): PageIndexWriter {
  let books: CatalogEntry[] = [];
  return {
    async importUnits(_source, units) {
      return { units: units.length, inserted: units.length, updated: 0, unchanged: 0, deleted: 0, chunks: units.length, reusedVectors: 0 };
    },
    async embedPending() { return { embedded: 0, tokens: 0 }; },
    async pendingEmbeddings() { return 0; },
    async catalog() { return books; },
    async replaceBooks(_source, entries, opts) { books = [...books.filter((b) => !opts.books.includes(b.book)), ...entries]; return {}; },
  };
}

function extractionWorker(
  fixture: ReturnType<typeof extractionFixture>,
  overrides: Partial<DomainExpertWorkerOptions>,
) {
  return createDomainExpertWorker({
    agentRouting: validateAgentRoutingConfig({ research: {
      library: { bucket: 'neutral-library', prefix: 'factory/research' },
      pageLibrary: { root: fixture.tree, sourceId: 'research' },
    } }),
    roots: [{
      rootId: 'expert_agents_workspace',
      path: fixture.workspaceRoot,
      maxWriteBytes: 20 * 1024 * 1024,
      allowOverwrite: false,
    }],
    dataDir: fixture.dataDir,
    annas: { importGcsPrefix: 'gs://neutral-acquisitions/imports/' },
    pageIndexWriter: recordingWriter(),
    pageSearch: async () => [],
    google: {
      accessToken: 'fixture-token',
      fetchImpl: (async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes('/upload/storage/v1/b/')) {
          fixture.uploads.push(decodeURIComponent(new URL(url).searchParams.get('name') ?? ''));
          return Response.json({ name: 'ok', generation: '1' });
        }
        return Response.json({ error: `unexpected fixture URL: ${url}` }, { status: 500 });
      }) as typeof fetch,
    },
    resolveHostImpl: async () => ['93.184.216.34'],
    webImportFetchImpl: async () => new Response(PAGE_BYTES, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
    summarizeBin: '/fixture/bin/summarize',
    ...overrides,
  });
}

async function call(
  worker: { fetch(request: Request): Promise<Response> },
  tool: string,
  params: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await worker.fetch(new Request('http://worker.test/v1/domain', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool, params: { domain_id: 'research', ...params } }),
  }));
  return { status: response.status, body: await response.json() as Record<string, any> };
}

/** Starts a library_ingest job for one URL and waits for it to finish. */
async function ingestUrl(
  worker: { fetch(request: Request): Promise<Response> },
  url: string,
): Promise<Record<string, any>> {
  const started = await call(worker, 'library_ingest', { action: 'start', urls: [url], dry_run: false, approval_id: 'owner-1' });
  if (started.status !== 200) throw new Error(`library_ingest start returned ${started.status}: ${JSON.stringify(started.body)}`);
  for (let i = 0; i < 400; i++) {
    const status = await call(worker, 'library_ingest', { action: 'status', job_id: started.body.job.job_id });
    if (['done', 'done_with_failures', 'failed'].includes(status.body.job?.state)) return status.body.job;
    await Bun.sleep(25);
  }
  throw new Error('ingest job did not finish');
}

function temporaryExtractionFiles(dataDir: string): string[] {
  return readdirSync(dataDir).filter((name) => name.startsWith(TEMP_FILE_PREFIX));
}

function temporaryExtractionDirectories(dataDir: string): string[] {
  return readdirSync(dataDir).filter((name) => name.startsWith('.extraction-runtime-'));
}
