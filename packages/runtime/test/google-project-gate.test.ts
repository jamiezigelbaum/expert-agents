import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDomainExpertWorker } from '../src/workers/domain-expert/index.ts';
import { TEST_AGENT_ROUTING } from './routing-fixture.ts';

describe('explicit Google project boundary', () => {
  test.each(['project-not-configured', '<project-id>', '123456789', 'projects/foreign-project', 'Uppercase Project'])('rejects invalid project %s before every Vertex request', async gcpProject => {
    const dataDir = mkdtempSync(join(tmpdir(), 'google-project-gate-'));
    let requests = 0;
    try {
      const worker = createDomainExpertWorker({ dataDir, gcpProject, agentRouting: TEST_AGENT_ROUTING,
        google: { accessToken: 'synthetic-token', fetchImpl: (async () => { requests++; return Response.json({}); }) as unknown as typeof fetch },
      });
      const health = await (await worker.fetch(new Request('http://worker.test/v1/health'))).json() as Record<string, any>;
      expect(health.configured.google).toBe(false);
      expect(health.configuration_status.google).toBe('project_not_configured');
      expect(health.configuration_status.google_credentials).toBe('ready');
      const operations = [
        { tool: 'domain_ask', params: { question: 'fixture question', corpus_id: 'research-library' } },
        { tool: 'domain_ask', params: { question: 'fixture question', corpus_id: 'projects/fixture-project/locations/us-central1/ragCorpora/123' } },
        { tool: 'rag_corpus', params: { action: 'create', corpus_id: 'research-library', dry_run: false } },
        { tool: 'rag_corpus', params: { action: 'list_files', corpus_id: 'research-library' } },
        { tool: 'rag_corpus', params: { action: 'status', corpus_id: 'research-library', dry_run: false } },
        { tool: 'rag_corpus', params: { action: 'import', corpus_id: 'research-library', gcs_uri: 'gs://fixture-shared-library/v1/note.md', dry_run: false } },
      ];
      for (const operation of operations) {
        const response = await worker.fetch(new Request('http://worker.test/v1/domain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...operation, params: { domain_id: 'research', ...operation.params } }) }));
        expect(response.status).toBe(503);
        expect((await response.json() as Record<string, any>).error.code).toBe('gcp_project_not_configured');
      }
      expect(requests).toBe(0);
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
});
