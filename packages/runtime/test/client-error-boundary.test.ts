import { describe, expect, test } from 'bun:test';
import { DirectHttpDomainExpertTransport } from '../src/core/domain-expert-client.ts';

const privateText = 'synthetic-token /private/worker/source.txt source holding';

describe('worker client error boundary', () => {
  test.each(['invalid_params', 'gcp_project_not_configured', 'unknown_code'])('never forwards provider message or remediation for %s', async code => {
    const transport = new DirectHttpDomainExpertTransport(async () => Response.json({
      error: { code, message: privateText, suggestion: privateText, remediation: privateText },
    }, { status: 500 }));
    try {
      await transport.requestJson('http://worker.test/v1/domain', {});
      throw new Error('expected failure');
    } catch (error) {
      expect(String(error)).not.toContain(privateText);
      expect(JSON.stringify(error)).not.toContain(privateText);
      expect((error as { code: string }).code).toBe(code === 'unknown_code' ? 'domain_expert_error' : code);
    }
  });

  test('oversized streamed failures are cancelled without retaining raw response content', async () => {
    let cancelled = false;
    const transport = new DirectHttpDomainExpertTransport(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(privateText.repeat(1000))); },
      cancel() { cancelled = true; },
    }), { status: 502 }));
    await expect(transport.requestJson('http://worker.test/v1/domain', {})).rejects.toMatchObject({ code: 'domain_expert_error' });
    expect(cancelled).toBe(true);
  });

  test('a stalled error body cannot hold the caller indefinitely', async () => {
    let cancelled = false;
    const transport = new DirectHttpDomainExpertTransport(async () => new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { status: 502 }), undefined, 10);
    await expect(transport.requestJson('http://worker.test/v1/domain', {})).rejects.toMatchObject({ code: 'domain_expert_error' });
    expect(cancelled).toBe(true);
  });

  test('fetch exceptions do not expose credential or URL details', async () => {
    const transport = new DirectHttpDomainExpertTransport(async () => { throw new Error(privateText); });
    try { await transport.requestJson(`http://worker.test/?token=${privateText}`, {}); }
    catch (error) {
      expect(String(error)).not.toContain(privateText);
      expect(JSON.stringify(error)).not.toContain(privateText);
    }
  });
});
