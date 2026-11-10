// Small shared helpers for the domain-expert worker.
import { createHash, randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { extname } from 'node:path';
import { ANNAS_ARCHIVE_FORMATS } from '../../core/domain-expert.ts';
import { DomainExpertWorkerError } from './worker-errors.ts';

export function isHttpsUrl(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('https://');
}

export function currentUid(): number {
  return process.getuid?.() ?? userInfo().uid;
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export function stripHtmlTags(value: string): string {
  return value.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ');
}

// Anna Archive publishes sizes in binary units and the search parser reads them
// that way, so the rationale reports them back in the units the operator saw.
export function humanByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function extensionFormat(value: string): string {
  const ext = extname(new URL(value, 'https://example.test').pathname).replace('.', '').toLowerCase();
  return ANNAS_ARCHIVE_FORMATS.includes(ext as any) && ext !== 'unknown' ? ext : 'pdf';
}

const SAFE_OBJECT_NAME_MAX_LENGTH = 80;

export function safeObjectName(value: string): string {
  return sanitizeObjectName(value).slice(0, SAFE_OBJECT_NAME_MAX_LENGTH) || randomUUID();
}

function sanitizeObjectName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function indentMarkdown(value: string, prefix: string): string {
  return value.split('\n').map((line) => `${prefix}${line}`).join('\n');
}

export function yamlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => yamlValue(entry)).join(', ')}]`;
  if (typeof value === 'string') return JSON.stringify(value);
  return JSON.stringify(value);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function retryAfterMs(value: string | null): number {
  if (!value) return 250;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5_000);
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? 250 : Math.min(Math.max(0, dateMs - Date.now()), 5_000);
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function safeDecodeURIComponent(value: string): string {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

export function frontmatter(values: Record<string, unknown>): string {
  const lines = Object.entries(values).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `---\n${lines.join('\n')}\n---\n\n`;
}

export function utf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function decodeUtf8Bytes(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}



export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, ' ');
}

export function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new DomainExpertWorkerError(400, 'invalid_config', 'Expected a positive integer.');
  return parsed;
}

// Zero-tolerant twin of normalizePositiveInteger, for a bound whose documented
// off switch is 0 (the PDF page floor) rather than an absent value.
export function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new DomainExpertWorkerError(400, 'invalid_config', 'Expected a non-negative integer.');
  return parsed;
}

export function optionalStringField<T extends string>(value: unknown, key: T): { [K in T]?: string } {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string') {
    const fieldName = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    throw new DomainExpertWorkerError(400, 'invalid_params', `${fieldName} must be a string.`);
  }
  return { [key]: value } as { [K in T]?: string };
}

export function optionalBooleanField<T extends string>(value: unknown, key: T): { [K in T]?: boolean } {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'boolean') return { [key]: value } as { [K in T]?: boolean };
  if (value === 'true' || value === '1' || value === 'yes') return { [key]: true } as { [K in T]?: boolean };
  if (value === 'false' || value === '0' || value === 'no') return { [key]: false } as { [K in T]?: boolean };
  throw new DomainExpertWorkerError(400, 'invalid_params', `${key} must be true or false.`);
}

export function optionalNumberField<T extends string>(value: unknown, key: T): { [K in T]?: number } {
  if (value === undefined || value === null || value === '') return {};
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new DomainExpertWorkerError(400, 'invalid_params', `${key} must be a number.`);
  return { [key]: parsed } as { [K in T]?: number };
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainExpertWorkerError(400, 'invalid_params', `${name} must be a non-empty string.`);
  }
  return value.trim();
}

export function requireApprovalId(value: string | undefined, action: string): string {
  if (!value?.trim()) {
    throw new DomainExpertWorkerError(403, 'approval_required', `${action} requires approval_id.`);
  }
  return value.trim();
}

export function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainExpertWorkerError(400, 'invalid_params', `${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed.replace(/\/+$/g, '') : `/${trimmed.replace(/\/+$/g, '')}`;
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, '');
}

export function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
