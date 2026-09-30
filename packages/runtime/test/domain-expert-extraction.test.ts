import { describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import type { ExtractionRequest } from '@expert-agents/library';
import {
  createDomainExpertWorker,
  type DomainExpertWorkerOptions,
} from '../src/workers/domain-expert/index.ts';
import { TEST_AGENT_ROUTING } from './routing-fixture.ts';

const PAGE_URL = 'https://example.com/article';
const YOUTUBE_URL = 'https://www.youtube.com/watch?v=fixture-video';
const PAGE_BYTES = '<html><head><title>Pinned Fixture</title></head><body>already fetched</body></html>';
const EXTRACTED_MARKDOWN = '# Extracted fixture\n\nPinned body.\n';
const TEMP_FILE_PREFIX = '.web-import-extraction-';
const LOCAL_HTML_EXTRACTOR = 'html-to-markdown';
const SUMMARIZE_EXTRACTOR = 'summarize --extract --format md';

describe('web_import summarize extraction inputs', () => {
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
      '#!/bin/sh\nif [ -f .env ]; then echo loaded-caller-dotenv >&2; exit 91; fi\ncase "$HOME" in /*) ;; *) echo relative-home >&2; exit 92;; esac\n[ -d "$HOME" ] || exit 93\nmkdir -p "$HOME/.summarize" || exit 94\nprintf cache > "$HOME/.summarize/cache.sqlite" || exit 95\nprintf "# Private cwd extraction\\n\\nNo caller dotenv loaded.\\n"\n',
      { mode: 0o755 },
    );
    try {
      process.chdir(fixture.base);
      process.env.HOME = inheritedHome;
      const worker = extractionWorker(fixture, { summarizeBin: './relative-summarize', dataDir: 'data' });

      const result = await webImport(worker, YOUTUBE_URL, 'private-cwd-runtime');

      expect(result).toMatchObject({
        status: 'dry_run_web_import_ready',
        url_results: [{
          handler: 'summarize-extract',
          file_count: 1,
          extraction_input_mode: 'youtube_url',
          extraction_fetch_performed_by: 'summarize',
          extractor: SUMMARIZE_EXTRACTOR,
        }],
      });
      expect(JSON.stringify(result)).not.toContain('sentinel-must-not-load');
      expect(JSON.stringify(result)).not.toContain('loaded-caller-dotenv');
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
    const pdfBytes = new Uint8Array(18_545_864);
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

      const result = await webImport(worker, 'https://osf.example/download/ev6ry/', 'osf-pdf');

      expect(extractionCalls).toBe(0);
      expect(result.source.extractor).toBe('direct-file');
      expect(result).toMatchObject({
        status: 'dry_run_web_import_ready',
        fetch_policy: {
          max_fetch_bytes: 100_000_000,
          text_default_max_processing_bytes: 10_000_000,
          pdf_max_processing_bytes: 100_000_000,
        },
        url_results: [{ handler: 'direct-file', file_count: 1 }],
        derived_files: [{
          kind: 'file',
          workspace_relative_path: 'experts/research/sources/web-imports/osf-pdf/paper-v4.pdf',
          bytes: 18_545_864,
        }],
        eligible_files: [{ upload_relative_path: 'paper-v4.pdf', bytes: 18_545_864 }],
      });
      expect(temporaryExtractionDirectories(fixture.dataDir)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  test('does not trust a PDF filename when the fetched bytes are HTML', async () => {
    const fixture = extractionFixture();
    const htmlMentioningPdf = '<!doctype html><html><head><title>PDF reference</title></head><body><p>A PDF starts with %PDF-1.7</p></body></html>';
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

      const result = await webImport(worker, 'https://example.com/not-a-pdf.pdf', 'false-pdf');

      // The pinned HTML bytes are converted in process: the .pdf filename does
      // not send them to the subprocess either.
      expect(extractionCalls).toBe(0);
      expect(result.source.extractor).toBe('html-to-markdown');
      expect(result).toMatchObject({
        url_results: [{
          handler: 'summarize-extract',
          extractor: LOCAL_HTML_EXTRACTOR,
          extraction_input_mode: 'local_input',
        }],
      });
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

      const result = await webImport(worker, PAGE_URL, 'page-local-conversion', false);

      expect(temporaryExtractionFiles(fixture.dataDir)).toEqual([]);
      expect(temporaryExtractionDirectories(fixture.dataDir)).toEqual([]);
      expect(result).toMatchObject({
        url_results: [{
          handler: 'summarize-extract',
          extractor: LOCAL_HTML_EXTRACTOR,
          extraction_input_mode: 'local_input',
          extraction_fetch_performed_by: 'domain-expert-worker',
        }],
      });
      const staged = readFileSync(join(
        fixture.workspaceRoot,
        'experts/research/sources/web-imports/page-local-conversion/converted-fixture.md',
      ), 'utf8');
      // The page's own heading and text survive the conversion.
      expect(staged).toContain('# Real Heading');
      expect(staged).toContain('Real body sentence.');
      // Honest provenance: this page never reached the summarize subprocess.
      expect(staged).toContain(`extractor: "${LOCAL_HTML_EXTRACTOR}"`);
      expect(staged).toContain('kind: "html"');
      expect(staged).toContain('title: "Converted Fixture"');
      // Scripts and styles are dropped, not staged.
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

      const result = await webImport(worker, YOUTUBE_URL, 'youtube-url-success');

      expect(request?.source).toBe(YOUTUBE_URL);
      expect(request!.env.HOME).toStartWith(`${fixture.dataDir}${sep}.extraction-runtime-`);
      expect(request!.env.HOME).not.toBe(process.env.HOME);
      expect(request!.env.XDG_CACHE_HOME).toBe(join(dirname(request!.env.HOME), 'cache'));
      expect(request!.env.XDG_CONFIG_HOME).toBe(join(dirname(request!.env.HOME), 'config'));
      expect(request!.workingDirectory).toStartWith(`${fixture.dataDir}${sep}.extraction-runtime-`);
      expect(temporaryExtractionFiles(fixture.dataDir)).toEqual([]);
      expect(temporaryExtractionDirectories(fixture.dataDir)).toEqual([]);
      expect(result).toMatchObject({
        url_results: [{
          extractor: SUMMARIZE_EXTRACTOR,
          extraction_input_mode: 'youtube_url',
          extraction_fetch_performed_by: 'summarize',
        }],
      });
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

      const result = await webImport(worker, PAGE_URL, 'page-empty');

      expect(result).toMatchObject({
        status: 'dry_run_web_import_no_importable_files',
        eligible_file_count: 0,
        derived_files: [],
        errors: [{
          handler: 'summarize-extract',
          code: 'summarize_extraction_empty',
        }],
      });
      expect(result.errors[0].message).toContain(LOCAL_HTML_EXTRACTOR);
      // The refusal names the converter, not a diagnostic it never had, and
      // repeats none of the page back.
      expect(result.errors[0].message).not.toContain('no diagnostic output');
      expect(JSON.stringify(result)).not.toContain('const tracker = 1;');
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

      const result = await webImport(worker, YOUTUBE_URL, 'youtube-extraction-failure');

      expect(result).toMatchObject({
        status: 'dry_run_web_import_no_importable_files',
        errors: [{
          handler: 'summarize-extract',
          code: 'summarize_extraction_failed',
          stderr_tail: 'fixture extraction failure\nprivate diagnostic tail',
        }],
        url_results: [{
          handler: 'summarize-extract',
          file_count: 0,
          error_count: 1,
          extractor: SUMMARIZE_EXTRACTOR,
        }],
      });
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
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function extractionWorker(
  fixture: ReturnType<typeof extractionFixture>,
  overrides: Partial<DomainExpertWorkerOptions>,
) {
  return createDomainExpertWorker({
    agentRouting: TEST_AGENT_ROUTING,
    gcpProject: 'fixture-project',
    roots: [{
      rootId: 'expert_agents_workspace',
      path: fixture.workspaceRoot,
      maxWriteBytes: 20 * 1024 * 1024,
      allowOverwrite: false,
    }],
    dataDir: fixture.dataDir,
    google: { accessToken: 'fixture-token', fetchImpl: extractionGoogleFetch },
    resolveHostImpl: async () => ['93.184.216.34'],
    webImportFetchImpl: async () => new Response(PAGE_BYTES, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
    summarizeBin: '/fixture/bin/summarize',
    ...overrides,
  });
}

const extractionGoogleFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  const pathname = new URL(url).pathname;
  if (pathname.endsWith('/ragCorpora')) {
    return new Response(JSON.stringify({
      ragCorpora: [{
        name: 'projects/fixture-project/locations/us-central1/ragCorpora/1234567890123456789',
        displayName: 'research-library',
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('/upload/storage/v1/b/')) {
    return new Response(JSON.stringify({ name: new URL(url).searchParams.get('name') ?? '' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  // A staged import lists the corpus before it submits, so the fixture answers
  // an empty list and a completed operation.
  if (method === 'GET' && pathname.endsWith('/ragFiles')) {
    return new Response(JSON.stringify({ ragFiles: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (method === 'POST' && pathname.endsWith('/ragFiles:import')) {
    return new Response(JSON.stringify({
      name: `${pathname.replace(/^\/v1\//, '').replace(/\/ragFiles:import$/, '')}/operations/import-fixture`,
      done: true,
      response: { importedRagFilesCount: '1' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (method === 'GET' && pathname.includes('/operations/')) {
    return new Response(JSON.stringify({
      name: pathname.replace(/^\/v1\//, ''),
      done: true,
      response: { importedRagFilesCount: '1' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: `unexpected fixture URL: ${url}` }), {
    status: 500,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

async function webImport(
  worker: { fetch(request: Request): Promise<Response> },
  url: string,
  batchId: string,
  dryRun = true,
): Promise<Record<string, any>> {
  const response = await worker.fetch(new Request('http://worker.test/v1/domain', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tool: 'rag_corpus',
      params: {
        action: 'web_import',
        corpus_id: '1234567890123456789',
        urls: [url],
        batch_id: batchId,
        dry_run: dryRun,
      },
    }),
  }));
  const body = await response.text();
  if (response.status !== 200) throw new Error(`web_import fixture returned ${response.status}: ${body}`);
  return JSON.parse(body) as Record<string, any>;
}

function temporaryExtractionFiles(dataDir: string): string[] {
  return readdirSync(dataDir).filter((name) => name.startsWith(TEMP_FILE_PREFIX));
}

function temporaryExtractionDirectories(dataDir: string): string[] {
  return readdirSync(dataDir).filter((name) => name.startsWith('.extraction-runtime-'));
}
