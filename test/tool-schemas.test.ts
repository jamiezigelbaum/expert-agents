import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { researchToolSchemas } from '../src/tool-schemas.ts';
import type { DomainExpertTool } from '../packages/runtime/src/core/domain-expert-client.ts';
import { createDomainExpertWorker } from '../packages/runtime/src/workers/domain-expert/index.ts';
import { validateAgentRoutingConfig } from '../packages/runtime/src/core/agent-routing.ts';

// User-facing examples exercise wire names, action-dependent fields, and
// default-domain compatibility. Checking only whether a schema exists would
// let the previous empty object schema pass without teaching a model anything.
const examples: Array<{ tool: DomainExpertTool; params: Record<string, unknown> }> = [
  { tool: 'domain_library', params: { action: 'search', query: 'fixture topic', k: 10, book: 'fixture-book-abc123' } },
  { tool: 'domain_library', params: { action: 'grep', pattern: 'exact phrase', max_hits: 20 } },
  { tool: 'domain_library', params: { action: 'read_range', book: 'fixture-book-abc123', from_unit: 'p0012', to_unit: 'p0020' } },
  { tool: 'domain_library', params: { action: 'view_page', slug: 'books/fixture-book-abc123/p0012' } },
  { tool: 'domain_agent', params: { action: 'register', domain_id: 'new-expert', display_name: 'New Expert', library: { bucket: 'fixture-library', prefix: 'shared/new-expert' }, page_library: {}, dry_run: true } },
  { tool: 'library_ingest', params: { action: 'start', domain_id: 'research', source_id: 'research', workspace_relative_path: 'inbox/paper.pdf', title: 'Fixture Paper', creator: 'Fixture Author', dry_run: true } },
  { tool: 'library_ingest', params: { action: 'start', domain_id: 'research', source_id: 'research', urls: ['https://example.invalid/paper'], dry_run: true } },
  { tool: 'library_ingest', params: { action: 'start', domain_id: 'research', source_id: 'research', notion: ['fixture-page'] } },
  { tool: 'annas_archive_search', params: { query: 'fixture research', top_n: 3, max_results: 10, format_preference: 'text_rag' } },
  { tool: 'annas_archive_import', params: { annas_archive_id: 'fixture-item', format: 'pdf', copyright_posture: 'public-domain', file_size_bytes: 2000, allow_short_artifact: true, ingest: false, dry_run: true } },
];

describe('research tool schema guidance', () => {
  test('publishes typed wire fields for representative research and provisioning requests', () => {
    for (const { tool, params } of examples) {
      const schema = researchToolSchemas[tool];
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(true);
      expect(schema.required ?? []).not.toContain('domain_id');
      for (const required of schema.required ?? []) expect(params).toHaveProperty(required);
      for (const [name, value] of Object.entries(params)) {
        const field = schema.properties[name];
        expect(field, `${tool}.${name} must be visible to the model`).toBeDefined();
        expect(typeof field!.description).toBe('string');
        const valueType = Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
        expect(field!.type, `${tool}.${name}`).toBe(valueType);
        if (Array.isArray(field!.enum)) expect(field!.enum).toContain(value);
      }
    }
  });

  test('describes important conditional and runtime-only constraints', () => {
    expect(researchToolSchemas.library_ingest.description).toContain('a live start needs approval_id');
    expect(researchToolSchemas.library_ingest.properties.source_id!.description).toContain('there is no default');
    expect(researchToolSchemas.domain_library.description).toContain('Refused for a domain without a page library');
    expect(researchToolSchemas.annas_archive_import.required).toContain('copyright_posture');
    expect(researchToolSchemas.annas_archive_import.properties.source_id!.description).toContain('more than one library');
  });

  test('no removed Vertex-era tool or parameter is advertised', () => {
    expect(Object.keys(researchToolSchemas).sort()).toEqual([
      'annas_archive_import', 'annas_archive_search', 'domain_agent', 'domain_library', 'library_ingest',
    ]);
    const advertised = JSON.stringify(researchToolSchemas);
    for (const removed of ['corpus_id', 'target_corpus_display_name', 'domain_ask', 'domain_read', 'domain_source', 'rag_corpus']) {
      expect(advertised, removed).not.toContain(removed);
    }
  });

  test('advertised registration, ingest, and acquisition plans reach the worker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'expert-tool-schemas-'));
    try {
      await mkdir(join(directory, 'inbox'));
      await writeFile(join(directory, 'inbox', 'paper.pdf'), '%PDF-1.4 fixture');
      const worker = createDomainExpertWorker({
        dataDir: directory,
        agentRouting: validateAgentRoutingConfig({ research: {
          library: { bucket: 'fixture-library', prefix: 'shared' },
          pageLibrary: { sourceId: 'research' },
        } }),
        registrationLibrary: { bucket: 'fixture-library', prefix: 'shared' },
        roots: [{ rootId: 'expert_agents_workspace', path: directory, maxWriteBytes: 100_000, allowOverwrite: false }],
        fetchImpl: (async () => { throw new Error('Schema dry-run fixtures must never contact an upstream'); }) as unknown as typeof fetch,
      });
      // The Notion example is schema-only: its plan needs deployment credentials.
      const plans = examples.filter(({ params }) => params.dry_run === true);
      expect(plans).toHaveLength(4);
      for (const { tool, params } of plans) {
        const response = await worker.fetch(new Request('http://fixture.invalid/v1/domain', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool, params }),
        }));
        const result = await response.json() as Record<string, unknown>;
        expect(response.status, `${tool}: ${JSON.stringify(result)}`).toBe(200);
        expect(result).not.toHaveProperty('error');
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
