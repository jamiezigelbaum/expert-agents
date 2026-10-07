import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAgentRoutingConfig } from '../src/core/agent-routing.ts';
import { vertexImportSubmissionReceipt } from '../src/core/vertex-import-submission.ts';
import { createDomainExpertWorker } from '../src/workers/domain-expert/index.ts';

const corpus = 'projects/neutral-project/locations/us-central1/ragCorpora/123';
const operation = `${corpus}/operations/import-1`;

describe('runtime import submission custody', () => {
  test('receipt retains only safe operation metadata, never provider/source content or ACTIVE proof', () => {
    const receipt = vertexImportSubmissionReceipt({ name: operation, done: true, error: { message: 'private provider data' } }, corpus);
    expect(receipt).toEqual({ status: 'import_requested', corpus_resource_name: corpus, operation_name: operation, operation_done: true, operation_error: true });
    expect(JSON.stringify(receipt)).not.toContain('private');
    expect(vertexImportSubmissionReceipt({ name: `${corpus}/operations/../foreign` }, corpus)).toBeUndefined();
  });

  function fixture(sink: 'client' | 'gcs' | undefined, effect?: 'foreign' | 'network' | 'post_write_failure', options: {
    operationName?: string; aliasResponseName?: string; aliasLookupStatus?: number; dynamic?: boolean;
  } = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'vertex-import-custody-'));
    const dataDir = join(directory, 'data');
    const root = join(directory, 'workspace');
    mkdirSync(join(root, 'sources'), { recursive: true });
    writeFileSync(join(root, 'sources', 'note.md'), 'private source content');
    const calls: Array<{ url: string; method: string; body: string }> = [];
    const receiptsPath = join(dataDir, 'import-submissions');
    const pendingReceipt = () => readdirSync(receiptsPath).map(file => JSON.parse(readFileSync(join(receiptsPath, file), 'utf8')))
      .find(receipt => receipt.status === 'submission_pending');
    let registered = !options.dynamic;
    const createWorker = () => createDomainExpertWorker({
      dataDir, gcpProject: 'neutral-project',
      // These tests pin submission custody; a zero poll budget reports the
      // accepted operation without reading it back for an outcome.
      annas: { importPollTimeoutMs: 0 },
      ...(options.dynamic ? { registrationLibrary: { bucket: 'neutral-library', prefix: 'shared' } } : {}),
      roots: [{ rootId: 'expert_agents_workspace', path: root, maxWriteBytes: 1_000_000, allowOverwrite: false }],
      agentRouting: validateAgentRoutingConfig(options.dynamic ? {} : { research: {
        library: { bucket: 'neutral-library', prefix: 'shared' }, targetCorpusDisplayName: 'neutral-library',
        ...(sink ? { ingestion: { importResultSink: sink } } : {}),
      } }),
      google: { accessToken: 'synthetic-token', fetchImpl: (async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const body = init?.body ? await new Response(init.body).text() : '';
        calls.push({ url, method, body });
        if (url.endsWith('/ragCorpora')) return Response.json({ ragCorpora: registered ? [{ name: corpus, displayName: 'neutral-library' }] : [] });
        if (url.endsWith('/ragFiles')) return Response.json({ ragFiles: [] });
        if (url.includes('/upload/storage/')) return Response.json({});
        if (url.endsWith('/ragFiles:import')) {
          const pending = pendingReceipt();
          expect(pending.status).toBe('submission_pending');
          if (effect === 'network') throw new Error('synthetic network timeout');
          if (effect === 'post_write_failure') { rmSync(receiptsPath, { recursive: true }); writeFileSync(receiptsPath, 'blocked'); }
          return Response.json({ name: options.operationName ?? (effect === 'foreign' ? 'projects/foreign/locations/us-central1/ragCorpora/123/operations/import-1' : operation) });
        }
        if (url.includes('/operations/')) {
          const pending = pendingReceipt();
          expect(pending.status).toBe('submission_pending');
          expect(pending.operation_name_candidate).toBe(options.operationName);
          expect(pending.operation_name).toBeUndefined();
          return options.aliasLookupStatus && options.aliasLookupStatus !== 200
            ? Response.json({ error: { message: 'synthetic private alias lookup failure', details: [{
              '@type': 'type.googleapis.com/google.rpc.ResourceInfo', resourceType: 'aiplatform.googleapis.com/RagCorpus', resourceName: corpus,
            }] } }, { status: options.aliasLookupStatus })
            : Response.json({ name: options.aliasResponseName ?? options.operationName });
        }
        throw new Error(`Unexpected request ${method}`);
      }) as typeof fetch },
    });
    let worker = createWorker();
    return {
      dataDir, calls, receiptsPath,
      restart() { worker = createWorker(); },
      async register() {
        const response = await worker.fetch(new Request('http://worker.test/v1/domain', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tool: 'domain_agent', params: { action: 'register', domain_id: 'research',
            library: { bucket: 'neutral-library', prefix: 'shared' }, target_corpus_display_name: 'neutral-library',
            approval_id: 'synthetic-registration', dry_run: false } }),
        }));
        expect(response.status).toBe(200);
        registered = true;
      },
      async request(stage = false) {
        const response = await worker.fetch(new Request('http://worker.test/v1/domain', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tool: 'rag_corpus', params: {
            action: stage ? 'stage_import' : 'import', domain_id: 'research', corpus_id: 'neutral-library', dry_run: false,
            ...(stage ? { workspace_relative_path: 'sources', batch_id: 'synthetic-batch' } : { gcs_uri: 'gs://neutral-library/shared/source.md' }),
          } }),
        }));
        return { status: response.status, body: await response.json() as Record<string, any> };
      },
      cleanup() { rmSync(directory, { recursive: true, force: true }); },
    };
  }

  test.each([true, false])('client-managed sink omits provider destination and saves submission for staged=%s', async (stage) => {
    const f = fixture('client');
    try {
      const result = await f.request(stage);
      expect(result.status).toBe(200);
      expect(result.body).not.toHaveProperty('import_result_sink');
      expect(result.body.submission_receipt.operation_name).toBe(operation);
      expect(result.body.submission_receipt.status).toBe('import_requested');
      const request = f.calls.find((call) => call.url.endsWith('/ragFiles:import'))!;
      expect(JSON.parse(request.body).importRagFilesConfig).not.toHaveProperty('importResultGcsSink');
      const receipt = readFileSync(join(f.receiptsPath, readdirSync(f.receiptsPath)[0]!), 'utf8');
      expect(JSON.parse(receipt)).toEqual(result.body.submission_receipt);
      expect(receipt).not.toContain('private source content');
      expect(receipt).not.toContain('gs://');
    } finally { f.cleanup(); }
  });

  test.each([true, false])('numeric import alias is verified only through the canonical project path for staged=%s', async stage => {
    const numericOperation = operation.replace('neutral-project', '987654321');
    const f = fixture('client', undefined, { operationName: numericOperation });
    try {
      const result = await f.request(stage);
      expect(result.status).toBe(200);
      expect(result.body.submission_receipt.operation_name).toBe(numericOperation);
      expect(result.body.submission_receipt.operation_name_candidate).toBeUndefined();
      const reads = f.calls.filter(call => call.url.includes('/operations/'));
      expect(reads.map(call => [call.method, call.url])).toEqual([['GET', `https://us-central1-aiplatform.googleapis.com/v1/${operation}`]]);
      expect(f.calls.some(call => call.url.includes('/projects/987654321/'))).toBe(false);
      const saved = JSON.parse(readFileSync(join(f.receiptsPath, readdirSync(f.receiptsPath)[0]!), 'utf8'));
      expect(saved).toEqual(result.body.submission_receipt);
      expect(f.calls.filter(call => call.url.endsWith('/ragFiles:import'))).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  test.each([
    { aliasLookupStatus: 403 },
    { aliasLookupStatus: 404 },
    { aliasResponseName: operation },
    { aliasResponseName: operation.replace('neutral-project', '123456789') },
    { aliasResponseName: operation.replace('/123/', '/456/').replace('neutral-project', '987654321') },
  ])('keeps only a private candidate when canonical alias proof fails: %j', async options => {
    const numericOperation = operation.replace('neutral-project', '987654321');
    const f = fixture('client', undefined, { operationName: numericOperation, ...options });
    try {
      const result = await f.request();
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.body.submission_receipt).toBeUndefined();
      if ('aliasLookupStatus' in options) expect(result.body.error.code).toBe('rag_import_operation_reconciliation_required');
      const saved = readFileSync(join(f.receiptsPath, readdirSync(f.receiptsPath)[0]!), 'utf8');
      expect(JSON.parse(saved).operation_name_candidate).toBe(numericOperation);
      expect(JSON.parse(saved).operation_name).toBeUndefined();
      expect(saved).not.toContain('synthetic private');
      expect(f.calls.filter(call => call.url.includes('/operations/')).map(call => call.url)).toEqual([`https://us-central1-aiplatform.googleapis.com/v1/${operation}`]);
      expect(f.calls.filter(call => call.url.endsWith('/ragFiles:import'))).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  test.each([
    operation.replace('neutral-project', 'foreign-project'),
    operation.replace('neutral-project', '987654321').replace('us-central1', 'us-east1'),
    operation.replace('neutral-project', '987654321').replace('/123/', '/456/'),
    operation.replace('neutral-project', '987654321').replace('/ragCorpora/123', ''),
    `${operation.replace('neutral-project', '987654321')}?token=synthetic`,
    `${operation.replace('neutral-project', '987654321')}/../foreign`,
    `${operation.replace('neutral-project', '987654321')}${'a'.repeat(512)}`,
  ])('rejects an out-of-scope or malformed candidate before lookup: %s', async operationName => {
    const f = fixture('client', undefined, { operationName });
    try {
      const result = await f.request();
      expect(result.body.error.code).toBe('rag_import_operation_scope_invalid');
      const saved = JSON.parse(readFileSync(join(f.receiptsPath, readdirSync(f.receiptsPath)[0]!), 'utf8'));
      expect(saved.operation_name_candidate).toBeUndefined();
      expect(f.calls.filter(call => call.url.includes('/operations/'))).toHaveLength(0);
      expect(f.calls.filter(call => call.url.endsWith('/ragFiles:import'))).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  test('candidate persistence failure prevents the alias lookup after submission', async () => {
    const f = fixture('client', 'post_write_failure', { operationName: operation.replace('neutral-project', '987654321') });
    try {
      expect((await f.request()).status).toBeGreaterThanOrEqual(400);
      expect(f.calls.filter(call => call.url.includes('/operations/'))).toHaveLength(0);
      expect(f.calls.filter(call => call.url.endsWith('/ragFiles:import'))).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  test.each([true, false])('dynamic registrations use client receipts before and after restart for staged=%s', async stage => {
    const f = fixture(undefined, undefined, { dynamic: true });
    try {
      await f.register();
      expect((await f.request(stage)).status).toBe(200);
      f.restart();
      expect((await f.request(stage)).status).toBe(200);
      const requests = f.calls.filter(call => call.url.endsWith('/ragFiles:import'));
      expect(requests).toHaveLength(2);
      for (const request of requests) expect(JSON.parse(request.body).importRagFilesConfig).not.toHaveProperty('importResultGcsSink');
      expect(JSON.parse(readFileSync(join(f.dataDir, 'agent-registrations', 'research.json'), 'utf8'))).not.toHaveProperty('ingestion');
    } finally { f.cleanup(); }
  });

  test.each([undefined, 'gcs'] as const)('default and explicit GCS sink remain available: %s', async (sink) => {
    const f = fixture(sink);
    try {
      expect((await f.request()).status).toBe(200);
      const request = f.calls.find((call) => call.url.endsWith('/ragFiles:import'))!;
      expect(JSON.parse(request.body).importRagFilesConfig.importResultGcsSink.outputUriPrefix).toStartWith('gs://neutral-library/shared/import-results/');
    } finally { f.cleanup(); }
  });

  test.each(['foreign', 'network'] as const)('retains intent and never replays or polls after %s response', async (effect) => {
    const f = fixture('client', effect);
    try {
      expect((await f.request()).status).toBeGreaterThanOrEqual(400);
      expect(f.calls.filter((call) => call.url.endsWith('/ragFiles:import'))).toHaveLength(1);
      expect(f.calls.filter((call) => call.url.includes('/operations/'))).toHaveLength(0);
      expect(readdirSync(f.receiptsPath)).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  test('intent write failure prevents the import POST', async () => {
    const f = fixture('client');
    try {
      writeFileSync(f.receiptsPath, 'blocked');
      expect((await f.request()).status).toBeGreaterThanOrEqual(400);
      expect(f.calls.filter((call) => call.url.endsWith('/ragFiles:import'))).toHaveLength(0);
    } finally { f.cleanup(); }
  });

  test('post-submission persistence failure returns the validated operation handle', async () => {
    const f = fixture('client', 'post_write_failure');
    try {
      const result = await f.request();
      expect(result.status).toBe(500);
      expect(JSON.stringify(result.body)).toContain(operation);
      expect(f.calls.filter((call) => call.url.endsWith('/ragFiles:import'))).toHaveLength(1);
    } finally { f.cleanup(); }
  });
});
