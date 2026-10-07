import { describe, expect, test } from 'bun:test';
import { domainExpertGoogleConfigFromEnv, RollingWindowPacer } from '../src/workers/domain-expert/index.ts';

// 2026-10-07: library intake held the 60/min VertexRagDataService quota at its
// ceiling, and agent reads, registry writes and cleanup all failed with 429.
describe('Vertex RAG request pacing', () => {
  test('the pacer admits at most `limit` acquisitions per rolling window, in order', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const pacer = new RollingWindowPacer(3, 60_000, () => clock, async (ms) => { sleeps.push(ms); clock += ms; });
    const admitted: number[] = [];
    await Promise.all([0, 1, 2, 3, 4].map((index) => pacer.acquire().then(() => admitted.push(index))));
    expect(admitted).toEqual([0, 1, 2, 3, 4]);
    // Three go at t=0; the fourth and fifth wait for the window to roll.
    expect(sleeps).toEqual([60_000]);
    expect(clock).toBe(60_000);
  });

  test('a slot frees as soon as its acquisition ages out', async () => {
    let clock = 0;
    const pacer = new RollingWindowPacer(2, 1_000, () => clock, async (ms) => { clock += ms; });
    await pacer.acquire();
    clock = 600;
    await pacer.acquire();
    await pacer.acquire();
    expect(clock).toBe(1_000);
  });

  test('the deployed worker paces under the default quota unless configured otherwise', () => {
    expect(domainExpertGoogleConfigFromEnv({}).vertexRagRequestsPerMinute).toBe(45);
    expect(domainExpertGoogleConfigFromEnv({ EXPERT_AGENTS_DOMAIN_EXPERT_VERTEX_RAG_REQUESTS_PER_MINUTE: '500' }).vertexRagRequestsPerMinute).toBe(500);
  });
});
