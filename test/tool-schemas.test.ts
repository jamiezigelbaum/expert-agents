import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
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
  { tool: 'domain_agent', params: { action: 'register', domain_id: 'new-expert', display_name: 'New Expert', library: { bucket: 'fixture-library', prefix: 'shared/new-expert' }, target_corpus_display_name: 'new-expert-library', dry_run: true } },
  { tool: 'domain_ask', params: { question: 'What evidence supports this claim?', corpora: ['research-library'], max_results: 12, retrieval_mode: 'history', output: 'passages', session_id: 'fixture-session' } },
  { tool: 'domain_source', params: { action: 'add', domain_id: 'research', kind: 'pdf', title: 'Fixture Paper', relative_path: 'inbox/paper.pdf', copyright_posture: 'owner-provided', dry_run: true } },
  { tool: 'rag_corpus', params: { action: 'ensure', domain_id: 'research', corpus_id: 'research-library', dry_run: true } },
  { tool: 'rag_corpus', params: { action: 'stage_import', domain_id: 'research', workspace_relative_path: 'inbox/paper.pdf', batch_id: 'fixture-batch', approval_id: 'fixture-approval', dry_run: false } },
  { tool: 'rag_corpus', params: { action: 'notion_import', domain_id: 'research', page_ids: ['fixture-page'], database_ids: ['fixture-database'], include_media: true, dry_run: true } },
  { tool: 'domain_doc', params: { action: 'visual_replace', document_id: 'fixture-document', text: 'Replacement text', range_start: 1, range_end: 5, comment: 'Explanation', dry_run: true } },
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
    expect(researchToolSchemas.domain_source.description).toContain('does not ingest');
    expect(researchToolSchemas.rag_corpus.description).toContain('stage_import needs workspace_relative_path');
    expect(researchToolSchemas.rag_corpus.properties.transcript_mode!.description).toContain('does not change');
    expect(researchToolSchemas.domain_doc.description).toContain('range_start and range_end');
    expect(researchToolSchemas.domain_ask.properties.domain_id!.description).toContain('provides a default');
    expect(researchToolSchemas.annas_archive_import.required).toContain('copyright_posture');
  });

  test('advertised registration, corpus, registry, document, and acquisition plans reach the worker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'expert-tool-schemas-'));
    try {
      const worker = createDomainExpertWorker({
        dataDir: directory,
        gcpProject: 'fixture-project',
        agentRouting: validateAgentRoutingConfig({ research: {
          library: { bucket: 'fixture-library', prefix: 'shared' },
          targetCorpusDisplayName: 'research-library',
        } }),
        registrationLibrary: { bucket: 'fixture-library', prefix: 'shared' },
        roots: [{ rootId: 'expert_agents_workspace', path: directory, maxWriteBytes: 100_000, allowOverwrite: false }],
        fetchImpl: (async () => { throw new Error('Schema dry-run fixtures must never contact an upstream'); }) as unknown as typeof fetch,
      });
      const plans = examples.filter(({ tool, params }) => params.dry_run === true &&
        (tool !== 'rag_corpus' || params.action === 'ensure'));
      expect(plans).toHaveLength(5);
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
