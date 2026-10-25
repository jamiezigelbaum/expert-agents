import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDomainExpertWorker } from '../src/workers/domain-expert/index.ts';
import { TEST_AGENT_ROUTING } from './routing-fixture.ts';

function fixture(): { base: string; workspace: string; dataDir: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'expert-agents-domain-fs-'));
  const workspace = join(base, 'workspace');
  const dataDir = join(base, 'data');
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(dataDir, { mode: 0o700 });
  return {
    base,
    workspace,
    dataDir,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function workerFor(input: {
  workspace: string;
  dataDir: string;
  annas?: { booksRoot: string; fetchImpl: typeof fetch };
}) {
  return createDomainExpertWorker({
    agentRouting: TEST_AGENT_ROUTING,
    dataDir: input.dataDir,
    roots: [{
      rootId: 'expert_agents_workspace',
      path: input.workspace,
      maxWriteBytes: 20 * 1024 * 1024,
      allowOverwrite: false,
    }],
    ...(input.annas ? {
      annas: {
        apiKey: 'fixture-acquisition-token',
        baseUrl: 'https://annas.example',
        booksRoot: input.annas.booksRoot,
      },
      fetchImpl: input.annas.fetchImpl,
    } : {}),
  });
}

async function postDomain(
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

describe('domain expert filesystem hardening', () => {
  test('workspace writes reject a preplanted symlink below the configured root', async () => {
    const testFixture = fixture();
    try {
      const outside = join(testFixture.base, 'outside');
      mkdirSync(outside, { mode: 0o700 });
      symlinkSync(outside, join(testFixture.workspace, 'experts'));
      const worker = workerFor(testFixture);

      const response = await postDomain(worker, 'domain_agent', {
        action: 'bootstrap',
        domain_id: 'research',
        dry_run: false,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'path_escape_denied' } });
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      testFixture.cleanup();
    }
  });

  test('book writes reject a preplanted symlink below the configured books root', async () => {
    const testFixture = fixture();
    try {
      const booksRoot = join(testFixture.base, 'books');
      const outside = join(testFixture.base, 'outside-books');
      mkdirSync(booksRoot, { mode: 0o700 });
      mkdirSync(outside, { mode: 0o700 });
      // The worker slugifies the topic (safeObjectName lowercases), so the
      // planted symlink must sit at the slug the code writes — a capitalized
      // plant only matched on case-insensitive filesystems and let the test
      // pass locally while missing the guard on Linux.
      symlinkSync(outside, join(booksRoot, 'research'));
      let fetches = 0;
      const worker = workerFor({
        ...testFixture,
        annas: {
          booksRoot,
          fetchImpl: (async () => {
            fetches += 1;
            return new Response('fixture-book-bytes', { status: 200 });
          }) as unknown as typeof fetch,
        },
      });

      const response = await postDomain(worker, 'annas_archive_import', {
        annas_archive_id: 'book-one',
        title: 'Fixture Book',
        author: 'Example Author',
        topic: 'Research',
        format: 'epub',
        copyright_posture: 'approved_fixture_use',
        approval_id: 'approval-fixture',
        dry_run: false,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'path_escape_denied' } });
      expect(fetches).toBe(0);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      testFixture.cleanup();
    }
  });

  test('worker startup rejects a group- or world-writable data directory', () => {
    const testFixture = fixture();
    try {
      chmodSync(testFixture.dataDir, 0o777);
      expect(() => createDomainExpertWorker({ dataDir: testFixture.dataDir })).toThrow(
        /must not be group- or world-writable/,
      );
    } finally {
      testFixture.cleanup();
    }
  });
});
