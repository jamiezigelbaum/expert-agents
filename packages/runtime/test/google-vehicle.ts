import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAgentRoutingConfig } from '../src/core/agent-routing.ts';
import { createDomainExpertWorker, type DomainExpertGoogleConfig } from '../src/workers/domain-expert/index.ts';
import type { PageIndexWriter } from '../src/workers/domain-expert/page-ingest.ts';
import { scanAndFigurePdf } from '../../library/test/pdf-fixture.ts';

/**
 * A worker whose only Google traffic is the Cloud Storage upload of an acquired
 * original (annas_archive_import with ingest), so the Google client's transport
 * behaviour (token, error contract, size cap, redaction) can be observed through
 * the blocked-ingest record that upload failure produces.
 */
export function googleUploadVehicle(google: DomainExpertGoogleConfig) {
  const base = mkdtempSync(join(tmpdir(), 'google-vehicle-'));
  const booksRoot = join(base, 'books');
  mkdirSync(booksRoot);
  const pdf = scanAndFigurePdf();
  const writer: PageIndexWriter = {
    async importUnits(_source, units) {
      return { units: units.length, inserted: units.length, updated: 0, unchanged: 0, deleted: 0, chunks: units.length, reusedVectors: 0 };
    },
    async embedPending() { return { embedded: 0, tokens: 0 }; },
    async pendingEmbeddings() { return 0; },
    async catalog() { return []; },
    async replaceBooks() { return {}; },
  };
  const worker = createDomainExpertWorker({
    dataDir: join(base, 'data'),
    agentRouting: validateAgentRoutingConfig({ research: {
      library: { bucket: 'neutral-library', prefix: 'factory/research' },
      pageLibrary: { root: join(base, 'tree'), sourceId: 'research' },
    } }),
    annas: { importGcsPrefix: 'gs://neutral-acquisitions/imports/', apiKey: 'fixture-acquisition-token', baseUrl: 'https://annas.example', booksRoot, minPdfPages: 0 },
    fetchImpl: (async (input: RequestInfo | URL) => String(input).startsWith('https://annas.example/download/')
      ? new Response(new Blob([pdf.slice().buffer as ArrayBuffer]), { headers: { 'content-type': 'application/pdf' } })
      : new Response('unexpected', { status: 500 })) as typeof fetch,
    pageIndexWriter: writer,
    pageSearch: async () => [],
    google,
  });
  return {
    worker,
    /** Runs the acquisition; the Google upload happens inside it. */
    async run(): Promise<{ status: number; body: Record<string, any> }> {
      const response = await worker.fetch(new Request('http://worker.test/v1/domain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool: 'annas_archive_import', params: {
          domain_id: 'research', annas_archive_id: 'book-one', title: 'Fixture Book', author: 'A. Writer', format: 'pdf',
          approval_id: 'owner-1', copyright_posture: 'owner_library', ingest: true, dry_run: false,
        } }),
      }));
      return { status: response.status, body: await response.json() as Record<string, any> };
    },
  };
}
