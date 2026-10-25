import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, open, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { LibraryReadError } from './library-reader.ts';

/**
 * Where the worker keeps library objects: originals, acquisitions, manifests
 * and ledgers, addressed as a bucket and an object name (the `gs://bucket/name`
 * references in routing and in the page index). Google Cloud Storage is one
 * store; a local directory is the other, so a deployment can hold its
 * originals on its own disk.
 */
export interface LibraryObjectStore {
  /** Writes the object; `ifGenerationMatch: '0'` creates only, and a 412 means it already exists. */
  uploadGcsObject(bucket: string, objectName: string, bytes: Uint8Array, options?: { ifGenerationMatch?: string }): Promise<unknown>;
  readGcsObjectHead(bucket: string, objectName: string, length: number): Promise<Uint8Array | null>;
  getGcsObjectMetadata(bucket: string, objectName: string): Promise<LibraryObjectMetadata | null>;
  downloadGcsObject(bucket: string, objectName: string): Promise<Uint8Array | null>;
  listLibraryObjectNames(bucket: string, prefix: string, timeoutMs: number): Promise<string[]>;
  downloadLibraryObject(bucket: string, objectName: string, maxBytes: number, timeoutMs: number): Promise<Uint8Array | null>;
  downloadGcsText(bucket: string, objectName: string, maxBytes: number, timeoutMs: number): Promise<string | null>;
}

export interface LibraryObjectMetadata {
  generation?: string;
  size?: string;
  md5Hash?: string;
  crc32c?: string;
}

/** A create-only write found the object already there (GCS answers 412). */
export class LibraryObjectExistsError extends Error {
  readonly status = 412;
  constructor(bucket: string, objectName: string) { super(`The object ${bucket}/${objectName} already exists.`); }
}

const LIST_LIMIT = 10_000;
const BUCKET_NAME = /^[a-z0-9][a-z0-9._-]{1,221}[a-z0-9]$/;
const TEMP_MARKER = '.tmp-';

/** Library objects as files: `<root>/<bucket>/<object name>`. */
export class LocalLibraryObjects implements LibraryObjectStore {
  constructor(readonly root: string) {}

  async uploadGcsObject(bucket: string, objectName: string, bytes: Uint8Array, options: { ifGenerationMatch?: string } = {}): Promise<unknown> {
    const path = this.path(bucket, objectName);
    await mkdir(dirname(path), { recursive: true });
    const temp = join(dirname(path), `.${randomUUID()}${TEMP_MARKER}`);
    await writeFile(temp, bytes, { flag: 'wx' });
    try {
      if (options.ifGenerationMatch === '0') {
        // A hard link fails when the name is taken, so a concurrent writer
        // that got there first is never overwritten.
        try { await link(temp, path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new LibraryObjectExistsError(bucket, objectName);
          throw error;
        }
      } else if (options.ifGenerationMatch !== undefined) {
        throw new Error('Only create-only (generation 0) preconditions are supported for local library objects.');
      } else {
        await rename(temp, path);
        return { bucket, name: objectName };
      }
    } finally {
      await unlink(temp).catch(() => {});
    }
    return { bucket, name: objectName };
  }

  async readGcsObjectHead(bucket: string, objectName: string, length: number): Promise<Uint8Array | null> {
    const handle = await open(this.path(bucket, objectName), 'r').catch(missing);
    if (!handle) return null;
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return new Uint8Array(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  async getGcsObjectMetadata(bucket: string, objectName: string): Promise<LibraryObjectMetadata | null> {
    const path = this.path(bucket, objectName);
    const info = await stat(path, { bigint: true }).catch(missing);
    if (!info?.isFile()) return null;
    const md5 = createHash('md5');
    for await (const chunk of createReadStream(path)) md5.update(chunk as Buffer);
    return { generation: info.mtimeNs.toString(), size: info.size.toString(), md5Hash: md5.digest('base64') };
  }

  async downloadGcsObject(bucket: string, objectName: string): Promise<Uint8Array | null> {
    return this.read(bucket, objectName, Number.MAX_SAFE_INTEGER, () => new Error('unreachable'));
  }

  async listLibraryObjectNames(bucket: string, prefix: string, _timeoutMs?: number): Promise<string[]> {
    const bucketRoot = this.bucketRoot(bucket);
    // Like a GCS prefix, the last segment may end mid-name: walk its directory.
    const start = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '';
    const names: string[] = [];
    const walk = async (relative: string): Promise<void> => {
      const entries = await readdir(join(bucketRoot, ...relative.split('/').filter(Boolean)), { withFileTypes: true }).catch(missing);
      for (const entry of (entries ?? []).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (names.length >= LIST_LIMIT) return;
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (prefix.startsWith(`${name}/`) || name.startsWith(prefix)) await walk(name);
        } else if (entry.isFile() && !entry.name.includes(TEMP_MARKER) && name.startsWith(prefix)) {
          names.push(name);
        }
      }
    };
    await walk(start);
    return names;
  }

  async downloadLibraryObject(bucket: string, objectName: string, maxBytes: number, _timeoutMs?: number): Promise<Uint8Array | null> {
    return this.read(bucket, objectName, maxBytes,
      () => new LibraryReadError('library_source_too_large', 'The source exceeds the direct-reading size limit.', 413));
  }

  async downloadGcsText(bucket: string, objectName: string, maxBytes: number, _timeoutMs?: number): Promise<string | null> {
    const bytes = await this.read(bucket, objectName, maxBytes, () => new Error('source text exceeds the completion read limit'));
    return bytes ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : null;
  }

  private async read(bucket: string, objectName: string, maxBytes: number, tooLarge: () => Error): Promise<Uint8Array | null> {
    const path = this.path(bucket, objectName);
    const info = await stat(path).catch(missing);
    if (!info?.isFile()) return null;
    if (info.size > maxBytes) throw tooLarge();
    const handle = await open(path, 'r');
    try {
      const bytes = new Uint8Array(await handle.readFile());
      if (bytes.byteLength > maxBytes) throw tooLarge();
      return bytes;
    } finally {
      await handle.close();
    }
  }

  private bucketRoot(bucket: string): string {
    if (!BUCKET_NAME.test(bucket)) throw new Error(`Not a library bucket name: ${JSON.stringify(bucket)}.`);
    return join(this.root, bucket);
  }

  private path(bucket: string, objectName: string): string {
    const segments = objectName.split('/');
    if (!objectName || objectName.includes('\0') || objectName.includes(sep === '/' ? '\\' : '/')
      || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes(TEMP_MARKER))) {
      throw new Error(`Not a library object name: ${JSON.stringify(objectName)}.`);
    }
    return join(this.bucketRoot(bucket), ...segments);
  }
}

function missing(error: unknown): null {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
  throw error;
}

/** The local library-object root, when this deployment keeps its originals on disk. */
export function libraryObjectsRootFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = env.EXPERT_AGENTS_DOMAIN_EXPERT_LIBRARY_OBJECTS_ROOT?.trim();
  return root || undefined;
}
