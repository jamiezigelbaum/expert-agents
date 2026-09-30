import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, basename } from 'node:path';

/** Persist a newly created directory's name before publishing an external side effect. */
export function ensureDurableDirectory(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      ensureDurableDirectory(dirname(path));
      try { mkdirSync(path, { mode: 0o700 }); }
      catch (retry) { if ((retry as NodeJS.ErrnoException).code !== 'EEXIST') throw retry; }
    } else if (code !== 'EEXIST') throw error;
  }
  if (!statSync(path).isDirectory()) throw new Error('durable destination is not a directory');
  syncDirectory(path);
  syncDirectory(dirname(path));
}

/** An exclusive receipt must survive a host crash before its non-idempotent request is sent. */
export function writeExclusiveDurably(path: string, contents: string): void {
  ensureDurableDirectory(dirname(path));
  const file = openSync(path, 'wx', 0o600);
  try { writeFileSync(file, contents); fsyncSync(file); }
  finally { closeSync(file); }
  syncDirectory(dirname(path));
}

export function replaceDurably(path: string, contents: string): void {
  ensureDurableDirectory(dirname(path));
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeExclusiveDurably(temporary, contents);
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function syncDirectory(path: string): void {
  const directory = openSync(path, 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
