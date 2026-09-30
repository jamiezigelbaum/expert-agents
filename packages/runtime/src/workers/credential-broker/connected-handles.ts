import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ConnectedHandle {
  handle: string;
  provider: string;
  accountRole: string;
  trustDomain: string;
  allowedCapabilities: string[];
  scopes: string[];
  tokenSecretRefs: string[];
  connectedAt: string;
  providerAccountId: string;
}

export function defaultHandleRegistryPath(env: Record<string, string | undefined> = process.env): string {
  const root = env.EXPERT_AGENTS_DATA_DIR?.trim() || join(homedir(), '.local', 'share', 'expert-agents');
  return join(root, 'connected-handles.json');
}

export function upsertConnectedHandle(handle: ConnectedHandle, path: string): void {
  const existing = readRegistry(path);
  const next = existing.filter((entry) => entry.handle !== handle.handle);
  next.push(handle);
  next.sort((a, b) => a.handle.localeCompare(b.handle));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, handles: next }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function readRegistry(path: string): ConnectedHandle[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { handles?: unknown };
    return Array.isArray(parsed.handles)
      ? parsed.handles.filter(isConnectedHandle)
      : [];
  } catch {
    return [];
  }
}

function isConnectedHandle(value: unknown): value is ConnectedHandle {
  return !!value && typeof value === 'object' && typeof (value as { handle?: unknown }).handle === 'string';
}
