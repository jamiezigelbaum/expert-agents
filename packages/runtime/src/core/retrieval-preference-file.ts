import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { parseRetrievalPreferenceProfile, type RetrievalPreferenceProfile } from '@expert-agents/library';

export const RETRIEVAL_PREFERENCE_MAX_BYTES = 2 * 1024 * 1024;

export interface LoadedRetrievalPreference {
  profile: RetrievalPreferenceProfile;
  sha256: string;
  bytes: number;
}

/** Operator configuration, never a caller-supplied source path. No content-bearing errors. */
export async function loadRetrievalPreferenceFile(path: string): Promise<LoadedRetrievalPreference> {
  if (!isAbsolute(path)) throw new Error('Configured retrieval preference file is invalid');
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.size > RETRIEVAL_PREFERENCE_MAX_BYTES) throw new Error('invalid file');
    const buffer = Buffer.alloc(RETRIEVAL_PREFERENCE_MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const read = await handle.read(buffer, total, buffer.length - total, total);
      if (read.bytesRead === 0) break;
      total += read.bytesRead;
    }
    const after = await handle.stat();
    if (total > RETRIEVAL_PREFERENCE_MAX_BYTES || before.size !== total || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('unstable file');
    const bytes = buffer.subarray(0, total);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return {
      profile: parseRetrievalPreferenceProfile(JSON.parse(text)),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: total,
    };
  } catch {
    throw new Error('Configured retrieval preference file could not be read or validated');
  } finally {
    await handle?.close();
  }
}
