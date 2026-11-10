// Bounded reads and redaction of upstream (Google, Anna's Archive, Notion) responses.
import { upstreamResponseContexts, UpstreamResponseSizeLimitError } from './worker-errors.ts';
import { readWebImportChunk } from './network-guard.ts';

const UPSTREAM_JSON_MAX_BYTES = 8 * 1024 * 1024;
const UPSTREAM_HTML_MAX_BYTES = 4 * 1024 * 1024;
export const UPSTREAM_ERROR_TEXT_MAX_CHARACTERS = 2_000;
export const ANNAS_REDACTED = 'redacted';

export async function responseTextOrJson(response: Response): Promise<unknown> {
  const contentKind = response.headers.get('content-type')?.toLowerCase().includes('html') ? 'HTML' : 'JSON';
  const maxBytes = contentKind === 'HTML' ? UPSTREAM_HTML_MAX_BYTES : UPSTREAM_JSON_MAX_BYTES;
  const text = await readCappedUpstreamText(response, contentKind, maxBytes);
  if (!text) return {};
  try {
    return redactConfiguredValuesInUpstreamBody(
      JSON.parse(text),
      upstreamResponseContexts.get(response)?.sensitiveValues ?? [],
    );
  } catch {
    return {
      text: redactConfiguredValues(
        text,
        upstreamResponseContexts.get(response)?.sensitiveValues ?? [],
      ),
    };
  }
}

async function readCappedUpstreamText(
  response: Response,
  contentKind: 'JSON' | 'HTML',
  maxBytes: number,
): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new UpstreamResponseSizeLimitError(contentKind, maxBytes);
  }
  if (!response.body) return '';
  const context = upstreamResponseContexts.get(response);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const pieces: string[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = context ? await readWebImportChunk(reader, context.signal) : await reader.read();
      if (result.done) break;
      if (!result.value) continue;
      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new UpstreamResponseSizeLimitError(contentKind, maxBytes);
      }
      pieces.push(decoder.decode(result.value, { stream: true }));
    }
    pieces.push(decoder.decode());
    return pieces.join('');
  } catch (error) {
    if (context?.signal.aborted) {
      await reader.cancel().catch(() => {});
      throw context.timeoutError();
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function redactConfiguredValuesInUpstreamBody(value: unknown, sensitiveValues: string[]): unknown {
  if (typeof value === 'string') return redactConfiguredValues(value, sensitiveValues);
  if (Array.isArray(value)) return value.map((item) => redactConfiguredValuesInUpstreamBody(item, sensitiveValues));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    redactConfiguredValuesInUpstreamBody(item, sensitiveValues),
  ]));
}

function redactConfiguredValues(value: string, sensitiveValues: string[]): string {
  let redacted = value;
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue) redacted = redacted.replaceAll(sensitiveValue, ANNAS_REDACTED);
  }
  return redacted;
}

export function sanitizeUpstreamText(value: string, sensitiveValues: string[], maxCharacters: number): string {
  return redactConfiguredValues(value, sensitiveValues)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, maxCharacters);
}
