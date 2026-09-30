import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureDurableDirectory, replaceDurably, writeExclusiveDurably } from '../src/core/durable-file.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), 'durable-receipt-')); roots.push(root); return root; }

test('exclusive intent refuses a second publisher and retains the first receipt', () => {
  const root = fixture(); const path = join(root, 'new-parent', 'receipts', 'operation.json');
  writeExclusiveDurably(path, '{"status":"pending"}\n');
  expect(() => writeExclusiveDurably(path, '{"status":"another-request"}\n')).toThrow();
  expect(readFileSync(path, 'utf8')).toBe('{"status":"pending"}\n');
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test('a terminal result replaces the intent without leaving temporary state', () => {
  const root = fixture(); const path = join(root, 'receipts', 'operation.json');
  writeExclusiveDurably(path, '{"status":"pending"}\n');
  replaceDurably(path, '{"status":"failed"}\n');
  expect(JSON.parse(readFileSync(path, 'utf8')).status).toBe('failed');
  expect(readdirSync(join(root, 'receipts'))).toEqual(['operation.json']);
});

test('invalid directory destinations refuse instead of pretending to persist an intent', () => {
  const root = fixture(); const file = join(root, 'file'); writeFileSync(file, 'preserve');
  expect(() => ensureDurableDirectory(file)).toThrow();
  expect(() => writeExclusiveDurably(join(file, 'receipt'), 'never')).toThrow();
  expect(readFileSync(file, 'utf8')).toBe('preserve');
});
