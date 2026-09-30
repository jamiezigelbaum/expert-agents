import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPayloadManifest,
  captureGitBundle,
  captureSnapshot,
  captureSnapshotPair,
  payloadManifestSha256,
  verifyGitBundleRestore,
  verifySnapshotRestore,
} from '../scripts/private-custody.ts';

const roots: string[] = [];
const fixedNow = () => new Date('2026-07-18T14:30:00.000Z');

// The snapshot and bundle tests drive real age, tar, and git subprocesses. On a
// host already running other builds they take several times their idle wall
// clock, which pushed them past bun's 5 s default and turned a passing suite
// red. The bound is deliberately generous: it is here to catch a hang, not to
// police duration.
const SUBPROCESS_TIMEOUT_MS = 60_000;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('private custody manifests', () => {
  test('produce a stable payload hash and change when content changes', async () => {
    const fixture = await createFixture();
    const first = await buildPayloadManifest(fixture.source);
    const second = await buildPayloadManifest(fixture.source);
    expect(payloadManifestSha256(first)).toBe(payloadManifestSha256(second));

    await writeFile(join(fixture.source, 'nested', 'private-note.txt'), 'changed synthetic content\n');
    const changed = await buildPayloadManifest(fixture.source);
    expect(payloadManifestSha256(changed)).not.toBe(payloadManifestSha256(first));
  });

  test('reject paths that make archive listing ambiguous', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.source, 'unsafe\nname.txt'), 'synthetic\n');
    await expect(buildPayloadManifest(fixture.source)).rejects.toThrow('safely represented');
  });
});

describe('encrypted snapshots', () => {
  test('capture and restore-verify without putting paths or names in receipts', async () => {
    const fixture = await createFixture();
    await chmod(fixture.source, 0o750);
    const result = await captureSnapshot({
      sourceRoot: fixture.source,
      destinationDir: fixture.destinationA,
      recipientFile: fixture.recipientA,
      label: 'synthetic-agent',
      storageId: 'vault-a',
    }, { ageBinary: fixture.fakeAge, now: fixedNow });

    const receiptText = await readFile(result.receiptPath, 'utf8');
    expect(receiptText).not.toContain(fixture.source);
    expect(receiptText).not.toContain('private-note.txt');
    expect(result.receipt.contentIncluded).toBeFalse();
    expect(result.receipt.plaintextPathsIncluded).toBeFalse();
    expect(result.receipt.filesystemMetadata).toEqual({
      archiveFormat: 'pax',
      rootModeAttested: true,
      aclAndXattrs: 'tar_preserved_not_manifest_attested',
    });
    expect(result.receipt.inventory).toEqual({
      entries: 3,
      files: 1,
      directories: 1,
      symlinks: 1,
      logicalBytes: 18,
    });

    const keptRestore = join(fixture.restoreParent, 'verified-copy');
    const verification = await verifySnapshotRestore({
      archivePath: result.archivePath,
      receiptPath: result.receiptPath,
      identityFile: fixture.identity,
      restoreParent: fixture.restoreParent,
      keepRestoredAt: keptRestore,
    }, { ageBinary: fixture.fakeAge, now: fixedNow });

    expect(verification.receipt.result).toBe('pass');
    expect(verification.receipt.restoredCopyRetained).toBeTrue();
    expect((await stat(keptRestore)).mode & 0o777).toBe(0o750);
    expect(await readFile(join(keptRestore, 'nested', 'private-note.txt'), 'utf8')).toBe('synthetic content\n');
    expect(await readFile(verification.receiptPath, 'utf8')).not.toContain('private-note.txt');
  }, SUBPROCESS_TIMEOUT_MS);

  test('capture a two-storage, two-recipient pair with one stable payload hash', async () => {
    const fixture = await createFixture();
    const [first, second] = await captureSnapshotPair({
      sourceRoot: fixture.source,
      label: 'expert-a-synthetic',
      first: {
        destinationDir: fixture.destinationA,
        recipientFile: fixture.recipientA,
        storageId: 'offline-a',
      },
      second: {
        destinationDir: fixture.destinationB,
        recipientFile: fixture.recipientB,
        storageId: 'offline-b',
      },
    }, { ageBinary: fixture.fakeAge, now: fixedNow });

    expect(first.receipt.label).toBe('expert-a-synthetic-a');
    expect(second.receipt.label).toBe('expert-a-synthetic-b');
    expect(first.receipt.payloadManifestSha256).toBe(second.receipt.payloadManifestSha256);
    expect(first.receipt.encryption.recipientSetSha256).not.toBe(second.receipt.encryption.recipientSetSha256);
  }, SUBPROCESS_TIMEOUT_MS);

  test('rejects the same recipient key even when SSH comments differ', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.recipientA, 'ssh-ed25519 AAAASYNTHETIC first-device\n', { mode: 0o600 });
    await writeFile(fixture.recipientB, 'ssh-ed25519 AAAASYNTHETIC second-device\n', { mode: 0o600 });
    await expect(captureSnapshotPair({
      sourceRoot: fixture.source,
      label: 'expert-a-synthetic',
      first: {
        destinationDir: fixture.destinationA,
        recipientFile: fixture.recipientA,
        storageId: 'offline-a',
      },
      second: {
        destinationDir: fixture.destinationB,
        recipientFile: fixture.recipientB,
        storageId: 'offline-b',
      },
    }, { ageBinary: fixture.fakeAge, now: fixedNow })).rejects.toThrow('disjoint');
  }, SUBPROCESS_TIMEOUT_MS);

  test('fails closed and hashes subprocess diagnostics', async () => {
    const fixture = await createFixture();
    const failingAge = join(fixture.root, 'failing-age');
    await writeFile(failingAge, '#!/bin/sh\nprintf "sensitive-name.txt" >&2\nexit 9\n', { mode: 0o700 });

    let message = '';
    try {
      await captureSnapshot({
        sourceRoot: fixture.source,
        destinationDir: fixture.destinationA,
        recipientFile: fixture.recipientA,
        label: 'synthetic-agent',
        storageId: 'vault-a',
      }, { ageBinary: failingAge, now: fixedNow });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('diagnostic_sha256=');
    expect(message).not.toContain('sensitive-name.txt');
    expect(message).not.toContain(fixture.source);
  }, SUBPROCESS_TIMEOUT_MS);
});

describe('encrypted Git bundles', () => {
  test('capture, decrypt, clone, and fsck an importable bundle', async () => {
    const fixture = await createFixture();
    const repository = join(fixture.root, 'expert-b-repository');
    await mkdir(repository, { mode: 0o700 });
    await run(['git', 'init', '-q', '-b', 'main'], repository);
    await run(['git', 'config', 'user.name', 'Custody Test'], repository);
    await run(['git', 'config', 'user.email', 'custody-test@example.invalid'], repository);
    await writeFile(join(repository, 'tracked.txt'), 'synthetic tracked content\n');
    await run(['git', 'add', 'tracked.txt'], repository);
    await run(['git', 'commit', '-q', '-m', 'Synthetic fixture'], repository);
    await writeFile(join(repository, 'untracked.txt'), 'snapshot-only synthetic state\n');

    const captured = await captureGitBundle({
      sourceRoot: repository,
      destinationDir: fixture.destinationA,
      recipientFile: fixture.recipientA,
      label: 'expert-b-synthetic',
      storageId: 'offline-a',
    }, { ageBinary: fixture.fakeAge, now: fixedNow });
    expect(captured.receipt.headCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(captured.receipt.refCount).toBeGreaterThanOrEqual(1);

    const verified = await verifyGitBundleRestore({
      archivePath: captured.archivePath,
      receiptPath: captured.receiptPath,
      identityFile: fixture.identity,
      restoreParent: fixture.restoreParent,
    }, { ageBinary: fixture.fakeAge, now: fixedNow });
    expect(verified.receipt.result).toBe('pass');
    expect(verified.receipt.payloadSha256).toBe(captured.receipt.bundleSha256);
  }, SUBPROCESS_TIMEOUT_MS);
});

async function createFixture(): Promise<{
  root: string;
  source: string;
  destinationA: string;
  destinationB: string;
  restoreParent: string;
  recipientA: string;
  recipientB: string;
  identity: string;
  fakeAge: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'expert-agents-custody-test-'));
  roots.push(root);
  await chmod(root, 0o700);
  const source = join(root, 'source');
  const destinationA = join(root, 'destination-a');
  const destinationB = join(root, 'destination-b');
  const restoreParent = join(root, 'restore');
  await Promise.all([
    mkdir(join(source, 'nested'), { recursive: true, mode: 0o700 }),
    mkdir(destinationA, { mode: 0o700 }),
    mkdir(destinationB, { mode: 0o700 }),
    mkdir(restoreParent, { mode: 0o700 }),
  ]);
  await writeFile(join(source, 'nested', 'private-note.txt'), 'synthetic content\n', { mode: 0o600 });
  await symlink('nested/private-note.txt', join(source, 'pointer'));
  const recipientA = join(root, 'recipient-a.txt');
  const recipientB = join(root, 'recipient-b.txt');
  const identity = join(root, 'identity.txt');
  await writeFile(recipientA, 'age1synthetica\n', { mode: 0o600 });
  await writeFile(recipientB, 'age1syntheticb\n', { mode: 0o600 });
  await writeFile(identity, 'AGE-SECRET-KEY-SYNTHETIC\n', { mode: 0o600 });
  const fakeAge = join(root, 'fake-age');
  await writeFile(fakeAge, `#!/bin/sh
mode=""
output=""
input=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --encrypt) mode="encrypt" ;;
    --decrypt) mode="decrypt" ;;
    --recipients-file|--identity) shift ;;
    --output) shift; output="$1" ;;
    *) input="$1" ;;
  esac
  shift
done
if [ "$mode" = "encrypt" ]; then
  if [ -n "$input" ]; then
    { printf 'FAKEAGE\\n'; cat "$input"; } > "$output"
  else
    { printf 'FAKEAGE\\n'; cat; } > "$output"
  fi
elif [ "$mode" = "decrypt" ]; then
  if [ -n "$output" ]; then
    tail -c +9 "$input" > "$output"
  else
    tail -c +9 "$input"
  fi
else
  exit 7
fi
`, { mode: 0o700 });
  return { root, source, destinationA, destinationB, restoreParent, recipientA, recipientB, identity, fakeAge };
}

async function run(command: string[], cwd: string): Promise<void> {
  const process = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stderr, code] = await Promise.all([new Response(process.stderr).text(), process.exited]);
  if (code !== 0) throw new Error(`${command[0]} fixture command failed: ${stderr}`);
}
