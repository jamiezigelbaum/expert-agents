import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

const CONTROL_MANIFEST = '.expert-agents-private-custody-manifest.json';
const SNAPSHOT_FORMAT = 'expert-agents-private-custody-v1';
const RECEIPT_FORMAT = 'expert-agents-content-free-receipt-v1';
const SAFE_LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type PayloadEntry =
  | {
      path: string;
      type: 'directory';
      mode: string;
      mtimeSeconds: number;
    }
  | {
      path: string;
      type: 'file';
      mode: string;
      mtimeSeconds: number;
      bytes: number;
      sha256: string;
    }
  | {
      path: string;
      type: 'symlink';
      mode: string;
      targetBytes: number;
      targetSha256: string;
    };

export interface PayloadManifest {
  schemaVersion: 1;
  rootMode: string;
  entries: PayloadEntry[];
}

interface ControlManifest {
  schemaVersion: 1;
  format: typeof SNAPSHOT_FORMAT;
  createdAt: string;
  label: string;
  storageId: string;
  sourceRootSha256: string;
  payloadManifestSha256: string;
  payload: PayloadManifest;
}

export interface SnapshotReceipt {
  schemaVersion: 1;
  format: typeof RECEIPT_FORMAT;
  kind: 'encrypted-snapshot';
  contentIncluded: false;
  plaintextPathsIncluded: false;
  label: string;
  storageId: string;
  createdAt: string;
  sourceRootSha256: string;
  payloadManifestSha256: string;
  inventory: {
    entries: number;
    files: number;
    directories: number;
    symlinks: number;
    logicalBytes: number;
  };
  filesystemMetadata: {
    archiveFormat: 'pax';
    rootModeAttested: true;
    aclAndXattrs: 'tar_preserved_not_manifest_attested';
  };
  encryption: {
    scheme: 'age-recipient-file';
    recipientSetSha256: string;
  };
  artifact: {
    fileName: string;
    bytes: number;
    sha256: string;
  };
}

export interface BundleReceipt {
  schemaVersion: 1;
  format: typeof RECEIPT_FORMAT;
  kind: 'encrypted-git-bundle';
  contentIncluded: false;
  plaintextPathsIncluded: false;
  label: string;
  storageId: string;
  createdAt: string;
  sourceRootSha256: string;
  headCommit: string;
  refCount: number;
  bundleBytes: number;
  bundleSha256: string;
  encryption: {
    scheme: 'age-recipient-file';
    recipientSetSha256: string;
  };
  artifact: {
    fileName: string;
    bytes: number;
    sha256: string;
  };
}

export interface VerificationReceipt {
  schemaVersion: 1;
  format: typeof RECEIPT_FORMAT;
  kind: 'snapshot-restore-verification' | 'git-bundle-restore-verification';
  contentIncluded: false;
  plaintextPathsIncluded: false;
  label: string;
  storageId: string;
  verifiedAt: string;
  artifactSha256: string;
  payloadSha256: string;
  result: 'pass';
  restoredCopyRetained: boolean;
}

export interface CustodyDependencies {
  ageBinary?: string;
  tarBinary?: string;
  gitBinary?: string;
  scanPayload?: (sourceRoot: string) => Promise<PayloadManifest>;
  now?: () => Date;
}

export interface SnapshotOptions {
  sourceRoot: string;
  destinationDir: string;
  recipientFile: string;
  label: string;
  storageId: string;
}

export interface SnapshotResult {
  archivePath: string;
  receiptPath: string;
  receipt: SnapshotReceipt;
}

export interface SnapshotPairOptions {
  sourceRoot: string;
  label: string;
  first: Omit<SnapshotOptions, 'sourceRoot' | 'label'>;
  second: Omit<SnapshotOptions, 'sourceRoot' | 'label'>;
}

export interface BundleOptions {
  sourceRoot: string;
  destinationDir: string;
  recipientFile: string;
  label: string;
  storageId: string;
}

export interface BundleResult {
  archivePath: string;
  receiptPath: string;
  receipt: BundleReceipt;
}

export interface VerifySnapshotOptions {
  archivePath: string;
  receiptPath: string;
  identityFile: string;
  restoreParent: string;
  keepRestoredAt?: string;
}

export interface VerifyBundleOptions extends VerifySnapshotOptions {}

class SanitizedCommandError extends Error {
  constructor(stage: string, stderrSha256: string) {
    super(`${stage} failed; diagnostic_sha256=${stderrSha256}`);
    this.name = 'SanitizedCommandError';
  }
}

export async function buildPayloadManifest(sourceRoot: string): Promise<PayloadManifest> {
  const root = await validateSourceRoot(sourceRoot);
  const rootMetadata = await lstat(root, { bigint: true });
  const rootDevice = rootMetadata.dev;
  const entries: PayloadEntry[] = [];

  async function walk(absoluteDir: string, relativeDir: string): Promise<void> {
    const children = await readdir(absoluteDir, { withFileTypes: true });
    children.sort((left, right) => compareNames(left.name, right.name));
    for (const child of children) {
      const relativePath = relativeDir ? `${relativeDir}/${child.name}` : child.name;
      assertSafeManifestPath(relativePath);
      if (relativePath === CONTROL_MANIFEST) {
        throw new Error('Source root contains the reserved custody control path.');
      }
      const absolutePath = join(absoluteDir, child.name);
      const metadata = await lstat(absolutePath, { bigint: true });
      if (metadata.dev !== rootDevice) throw new Error('Source root crosses a filesystem boundary.');
      const mode = modeString(metadata.mode);
      if (metadata.isDirectory()) {
        entries.push({
          path: relativePath,
          type: 'directory',
          mode,
          mtimeSeconds: Number(metadata.mtimeNs / 1_000_000_000n),
        });
        await walk(absolutePath, relativePath);
      } else if (metadata.isFile()) {
        if (metadata.nlink > 1n) throw new Error('Source root contains a hard-linked file that cannot be independently attested.');
        entries.push({
          path: relativePath,
          type: 'file',
          mode,
          mtimeSeconds: Number(metadata.mtimeNs / 1_000_000_000n),
          bytes: safeNumber(metadata.size, 'file size'),
          sha256: await sha256File(absolutePath),
        });
      } else if (metadata.isSymbolicLink()) {
        const target = await readlink(absolutePath, { encoding: 'buffer' });
        entries.push({
          path: relativePath,
          type: 'symlink',
          mode,
          targetBytes: target.byteLength,
          targetSha256: sha256(target),
        });
      } else {
        throw new Error('Source root contains an unsupported special filesystem entry.');
      }
    }
  }

  await walk(root, '');
  entries.sort((left, right) => compareNames(left.path, right.path));
  return { schemaVersion: 1, rootMode: modeString(rootMetadata.mode), entries };
}

export function payloadManifestSha256(manifest: PayloadManifest): string {
  validatePayloadManifest(manifest);
  return sha256(Buffer.from(canonicalJson(manifest)));
}

export async function captureSnapshot(
  options: SnapshotOptions,
  dependencies: CustodyDependencies = {},
): Promise<SnapshotResult> {
  validateLabel(options.label, 'label');
  validateLabel(options.storageId, 'storage ID');
  const sourceRoot = await validateSourceRoot(options.sourceRoot);
  const destinationDir = await validatePrivateDirectory(options.destinationDir, 'destination directory');
  const recipientFile = await validateRegularFile(options.recipientFile, 'recipient file');
  const recipientSetHash = await recipientSetSha256(recipientFile);
  const scanPayload = dependencies.scanPayload ?? buildPayloadManifest;
  const before = await scanPayload(sourceRoot);
  const beforeSha = payloadManifestSha256(before);
  const createdAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const sourceRootSha256 = sha256(Buffer.from(sourceRoot));
  const control: ControlManifest = {
    schemaVersion: 1,
    format: SNAPSHOT_FORMAT,
    createdAt,
    label: options.label,
    storageId: options.storageId,
    sourceRootSha256,
    payloadManifestSha256: beforeSha,
    payload: before,
  };
  const stamp = compactTimestamp(createdAt);
  const artifactName = `${options.label}.${stamp}.snapshot.tar.age`;
  const receiptName = `${artifactName}.receipt.json`;
  const archivePath = join(destinationDir, artifactName);
  const receiptPath = join(destinationDir, receiptName);
  const partialArchive = `${archivePath}.partial`;
  const partialReceipt = `${receiptPath}.partial`;
  await assertPathsAbsent([archivePath, receiptPath, partialArchive, partialReceipt]);
  const controlDir = await mkdtemp(join(destinationDir, '.custody-control-'));
  await chmod(controlDir, 0o700);
  const controlPath = join(controlDir, CONTROL_MANIFEST);
  await writeFile(controlPath, canonicalJson(control), { encoding: 'utf8', mode: 0o600, flag: 'wx' });

  try {
    await streamTarToAge({
      sourceRoot,
      controlDir,
      recipientFile,
      outputPath: partialArchive,
      ageBinary: dependencies.ageBinary ?? 'age',
      tarBinary: dependencies.tarBinary ?? 'tar',
    });
    await chmod(partialArchive, 0o600);
    const after = await scanPayload(sourceRoot);
    const afterSha = payloadManifestSha256(after);
    if (beforeSha !== afterSha) {
      throw new Error('Source changed during capture; no snapshot was committed.');
    }

    const archiveMetadata = await stat(partialArchive);
    const receipt: SnapshotReceipt = {
      schemaVersion: 1,
      format: RECEIPT_FORMAT,
      kind: 'encrypted-snapshot',
      contentIncluded: false,
      plaintextPathsIncluded: false,
      label: options.label,
      storageId: options.storageId,
      createdAt,
      sourceRootSha256,
      payloadManifestSha256: beforeSha,
      inventory: summarizeManifest(before),
      filesystemMetadata: {
        archiveFormat: 'pax',
        rootModeAttested: true,
        aclAndXattrs: 'tar_preserved_not_manifest_attested',
      },
      encryption: {
        scheme: 'age-recipient-file',
        recipientSetSha256: recipientSetHash,
      },
      artifact: {
        fileName: artifactName,
        bytes: archiveMetadata.size,
        sha256: await sha256File(partialArchive),
      },
    };
    await writeJsonExclusive(partialReceipt, receipt);
    await rename(partialArchive, archivePath);
    await rename(partialReceipt, receiptPath);
    return { archivePath, receiptPath, receipt };
  } catch (error) {
    await rm(partialArchive, { force: true });
    await rm(partialReceipt, { force: true });
    throw sanitizeUnexpectedError(error, 'Snapshot capture');
  } finally {
    await rm(controlDir, { recursive: true, force: true });
  }
}

export async function captureSnapshotPair(
  options: SnapshotPairOptions,
  dependencies: CustodyDependencies = {},
): Promise<[SnapshotResult, SnapshotResult]> {
  validateLabel(options.label, 'label');
  if (options.label.length > 62) throw new Error('Snapshot pair label must be at most 62 characters.');
  if (options.first.storageId === options.second.storageId) {
    throw new Error('Snapshot pair requires two distinct storage IDs.');
  }
  const firstDestination = await validatePrivateDirectory(options.first.destinationDir, 'first destination directory');
  const secondDestination = await validatePrivateDirectory(options.second.destinationDir, 'second destination directory');
  if (firstDestination === secondDestination) {
    throw new Error('Snapshot pair requires two distinct destination directories.');
  }
  const firstRecipient = await validateRegularFile(options.first.recipientFile, 'first recipient file');
  const secondRecipient = await validateRegularFile(options.second.recipientFile, 'second recipient file');
  const firstRecipients = await normalizedRecipients(firstRecipient);
  const secondRecipients = await normalizedRecipients(secondRecipient);
  if (firstRecipients.some((recipient) => secondRecipients.includes(recipient))) {
    throw new Error('Snapshot pair recipient sets must be disjoint.');
  }

  let first: SnapshotResult | undefined;
  try {
    first = await captureSnapshot({
      sourceRoot: options.sourceRoot,
      label: `${options.label}-a`,
      ...options.first,
    }, dependencies);
    const second = await captureSnapshot({
      sourceRoot: options.sourceRoot,
      label: `${options.label}-b`,
      ...options.second,
    }, dependencies);
    if (first.receipt.payloadManifestSha256 !== second.receipt.payloadManifestSha256) {
      await removeCreatedResult(first);
      await removeCreatedResult(second);
      throw new Error('Source changed between independent captures; snapshot pair was removed.');
    }
    return [first, second];
  } catch (error) {
    if (first) await removeCreatedResult(first);
    throw error;
  }
}

export async function verifySnapshotRestore(
  options: VerifySnapshotOptions,
  dependencies: CustodyDependencies = {},
): Promise<{ receiptPath: string; receipt: VerificationReceipt; restoredPath?: string }> {
  const archivePath = await validateRegularFile(options.archivePath, 'snapshot archive');
  const receiptPath = await validateRegularFile(options.receiptPath, 'snapshot receipt');
  const identityFile = await validatePrivateRegularFile(options.identityFile, 'age identity file');
  const restoreParent = await validatePrivateDirectory(options.restoreParent, 'restore parent');
  const receipt = parseSnapshotReceipt(await readFile(receiptPath, 'utf8'));
  if (receipt.artifact.fileName !== basename(archivePath)) {
    throw new Error('Encrypted snapshot filename does not match its receipt.');
  }
  if (receipt.artifact.sha256 !== await sha256File(archivePath)) {
    throw new Error('Encrypted snapshot hash does not match its receipt.');
  }
  const restoreDir = await mkdtemp(join(restoreParent, '.custody-restore-'));
  await chmod(restoreDir, 0o700);
  let retainedPath: string | undefined;
  let verificationCommitted = false;
  try {
    await validateArchiveListing({
      archivePath,
      identityFile,
      ageBinary: dependencies.ageBinary ?? 'age',
      tarBinary: dependencies.tarBinary ?? 'tar',
    });
    await decryptAndExtract({
      archivePath,
      identityFile,
      restoreDir,
      ageBinary: dependencies.ageBinary ?? 'age',
      tarBinary: dependencies.tarBinary ?? 'tar',
    });
    const controlPath = join(restoreDir, CONTROL_MANIFEST);
    const control = parseControlManifest(await readFile(controlPath, 'utf8'));
    if (control.label !== receipt.label || control.storageId !== receipt.storageId) {
      throw new Error('Encrypted snapshot control metadata does not match its receipt.');
    }
    if (control.payloadManifestSha256 !== receipt.payloadManifestSha256) {
      throw new Error('Encrypted snapshot manifest hash does not match its receipt.');
    }
    if (control.sourceRootSha256 !== receipt.sourceRootSha256) {
      throw new Error('Encrypted snapshot source identity does not match its receipt.');
    }
    if (canonicalJson(summarizeManifest(control.payload)) !== canonicalJson(receipt.inventory)) {
      throw new Error('Encrypted snapshot inventory does not match its receipt.');
    }
    await unlink(controlPath);
    const restoredManifest = await (dependencies.scanPayload ?? buildPayloadManifest)(restoreDir);
    const restoredSha = payloadManifestSha256(restoredManifest);
    if (restoredSha !== control.payloadManifestSha256) {
      throw new Error('Restored payload does not match the encrypted manifest.');
    }
    if (canonicalJson(restoredManifest) !== canonicalJson(control.payload)) {
      throw new Error('Restored payload metadata does not match the encrypted manifest.');
    }

    if (options.keepRestoredAt) {
      const requested = await canonicalizeMissingPath(options.keepRestoredAt, 'retained restore path');
      assertInsideParent(requested, restoreParent, 'retained restore path');
      await assertPathsAbsent([requested]);
      await rename(restoreDir, requested);
      retainedPath = requested;
    }
    const verification = await writeVerificationReceipt({
      baseReceiptPath: receiptPath,
      label: receipt.label,
      storageId: receipt.storageId,
      artifactSha256: receipt.artifact.sha256,
      payloadSha256: restoredSha,
      retained: Boolean(retainedPath),
      kind: 'snapshot-restore-verification',
      now: dependencies.now,
    });
    verificationCommitted = true;
    return { ...verification, ...(retainedPath ? { restoredPath: retainedPath } : {}) };
  } catch (error) {
    throw sanitizeUnexpectedError(error, 'Snapshot restore verification');
  } finally {
    if (!retainedPath) {
      await rm(restoreDir, { recursive: true, force: true });
    } else if (!verificationCommitted) {
      await rm(retainedPath, { recursive: true, force: true });
    }
  }
}

export async function captureGitBundle(
  options: BundleOptions,
  dependencies: CustodyDependencies = {},
): Promise<BundleResult> {
  validateLabel(options.label, 'label');
  validateLabel(options.storageId, 'storage ID');
  const sourceRoot = await validateGitRoot(options.sourceRoot, dependencies.gitBinary ?? 'git');
  const destinationDir = await validatePrivateDirectory(options.destinationDir, 'destination directory');
  const recipientFile = await validateRegularFile(options.recipientFile, 'recipient file');
  const recipientSetHash = await recipientSetSha256(recipientFile);
  const createdAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const stamp = compactTimestamp(createdAt);
  const artifactName = `${options.label}.${stamp}.git.bundle.age`;
  const receiptName = `${artifactName}.receipt.json`;
  const archivePath = join(destinationDir, artifactName);
  const receiptPath = join(destinationDir, receiptName);
  const partialArchive = `${archivePath}.partial`;
  const partialReceipt = `${receiptPath}.partial`;
  await assertPathsAbsent([archivePath, receiptPath, partialArchive, partialReceipt]);
  const scratch = await mkdtemp(join(destinationDir, '.custody-bundle-'));
  await chmod(scratch, 0o700);
  const bundlePath = join(scratch, 'repository.bundle');
  const gitBinary = dependencies.gitBinary ?? 'git';
  try {
    const beforeState = await gitState(sourceRoot, gitBinary);
    await runSanitized(gitBinary, ['-C', sourceRoot, 'bundle', 'create', bundlePath, '--all'], 'Git bundle creation');
    await chmod(bundlePath, 0o600);
    const afterState = await gitState(sourceRoot, gitBinary);
    if (canonicalJson(beforeState) !== canonicalJson(afterState)) {
      throw new Error('Git refs changed during bundle capture; no bundle was committed.');
    }
    await encryptFile({
      inputPath: bundlePath,
      outputPath: partialArchive,
      recipientFile,
      ageBinary: dependencies.ageBinary ?? 'age',
    });
    await chmod(partialArchive, 0o600);
    const bundleMetadata = await stat(bundlePath);
    const archiveMetadata = await stat(partialArchive);
    const receipt: BundleReceipt = {
      schemaVersion: 1,
      format: RECEIPT_FORMAT,
      kind: 'encrypted-git-bundle',
      contentIncluded: false,
      plaintextPathsIncluded: false,
      label: options.label,
      storageId: options.storageId,
      createdAt,
      sourceRootSha256: sha256(Buffer.from(sourceRoot)),
      headCommit: beforeState.headCommit,
      refCount: beforeState.refs.length,
      bundleBytes: bundleMetadata.size,
      bundleSha256: await sha256File(bundlePath),
      encryption: {
        scheme: 'age-recipient-file',
        recipientSetSha256: recipientSetHash,
      },
      artifact: {
        fileName: artifactName,
        bytes: archiveMetadata.size,
        sha256: await sha256File(partialArchive),
      },
    };
    await writeJsonExclusive(partialReceipt, receipt);
    await rename(partialArchive, archivePath);
    await rename(partialReceipt, receiptPath);
    return { archivePath, receiptPath, receipt };
  } catch (error) {
    await rm(partialArchive, { force: true });
    await rm(partialReceipt, { force: true });
    throw sanitizeUnexpectedError(error, 'Git bundle capture');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function verifyGitBundleRestore(
  options: VerifyBundleOptions,
  dependencies: CustodyDependencies = {},
): Promise<{ receiptPath: string; receipt: VerificationReceipt }> {
  const archivePath = await validateRegularFile(options.archivePath, 'bundle archive');
  const receiptPath = await validateRegularFile(options.receiptPath, 'bundle receipt');
  const identityFile = await validatePrivateRegularFile(options.identityFile, 'age identity file');
  const restoreParent = await validatePrivateDirectory(options.restoreParent, 'restore parent');
  const receipt = parseBundleReceipt(await readFile(receiptPath, 'utf8'));
  if (receipt.artifact.fileName !== basename(archivePath)) {
    throw new Error('Encrypted bundle filename does not match its receipt.');
  }
  if (receipt.artifact.sha256 !== await sha256File(archivePath)) {
    throw new Error('Encrypted bundle hash does not match its receipt.');
  }
  const scratch = await mkdtemp(join(restoreParent, '.custody-bundle-restore-'));
  await chmod(scratch, 0o700);
  const bundlePath = join(scratch, 'repository.bundle');
  const clonePath = join(scratch, 'restored.git');
  const gitBinary = dependencies.gitBinary ?? 'git';
  try {
    await decryptFile({
      inputPath: archivePath,
      outputPath: bundlePath,
      identityFile,
      ageBinary: dependencies.ageBinary ?? 'age',
    });
    await chmod(bundlePath, 0o600);
    if (receipt.bundleSha256 !== await sha256File(bundlePath)) {
      throw new Error('Decrypted Git bundle does not match its receipt.');
    }
    await runSanitized(gitBinary, ['clone', '--mirror', bundlePath, clonePath], 'Git bundle clone verification');
    await runSanitized(gitBinary, ['-C', clonePath, 'fsck', '--full'], 'Git bundle object verification');
    const restoredHead = (await runCapturedSanitized(gitBinary, ['-C', clonePath, 'rev-parse', 'HEAD'], 'Restored Git HEAD inspection')).trim();
    if (restoredHead !== receipt.headCommit) throw new Error('Restored Git HEAD does not match its receipt.');
    return writeVerificationReceipt({
      baseReceiptPath: receiptPath,
      label: receipt.label,
      storageId: receipt.storageId,
      artifactSha256: receipt.artifact.sha256,
      payloadSha256: receipt.bundleSha256,
      retained: false,
      kind: 'git-bundle-restore-verification',
      now: dependencies.now,
    });
  } catch (error) {
    throw sanitizeUnexpectedError(error, 'Git bundle restore verification');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function streamTarToAge(input: {
  sourceRoot: string;
  controlDir: string;
  recipientFile: string;
  outputPath: string;
  ageBinary: string;
  tarBinary: string;
}): Promise<void> {
  const tarFlags = await supportedTarCreateFlags(input.tarBinary);
  const tar = spawn(input.tarBinary, [
    ...tarFlags,
    '-cf',
    '-',
    '-C',
    input.sourceRoot,
    '.',
    '-C',
    input.controlDir,
    CONTROL_MANIFEST,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const age = spawn(input.ageBinary, [
    '--encrypt',
    '--recipients-file',
    input.recipientFile,
    '--output',
    input.outputPath,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  if (!tar.stdout || !tar.stderr || !age.stdin || !age.stderr) throw new Error('Custody pipeline streams were unavailable.');
  const transfer = settlePipeline(tar.stdout, age.stdin);
  const [tarErrorHash, ageErrorHash, tarCode, ageCode, transferErrorHash] = await Promise.all([
    digestStream(tar.stderr),
    digestStream(age.stderr),
    exitCode(tar),
    exitCode(age),
    transfer,
  ]);
  // The encryption process can exit before consuming stdin. Awaiting a real
  // pipeline absorbs the resulting EPIPE instead of leaving an unhandled
  // writable-stream error in Bun/Node. Prefer the encryption diagnostic when
  // both processes fail because tar may only be reporting the downstream
  // pipe closure.
  if (ageCode !== 0) throw new SanitizedCommandError('Snapshot encryption', ageErrorHash);
  if (tarCode !== 0) throw new SanitizedCommandError('Archive creation', tarErrorHash);
  if (transferErrorHash) throw new SanitizedCommandError('Snapshot stream transfer', transferErrorHash);
}

async function supportedTarCreateFlags(tarBinary: string): Promise<string[]> {
  const version = await runCapturedSanitized(tarBinary, ['--version'], 'Tar capability inspection');
  if (/GNU tar/i.test(version)) {
    return ['--format=pax', '--acls', '--xattrs', '--numeric-owner', '--one-file-system', '--sparse'];
  }
  return ['--format=pax'];
}

async function validateArchiveListing(input: {
  archivePath: string;
  identityFile: string;
  ageBinary: string;
  tarBinary: string;
}): Promise<void> {
  const age = spawn(input.ageBinary, ['--decrypt', '--identity', input.identityFile, input.archivePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tar = spawn(input.tarBinary, ['-tf', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
  if (!age.stdout || !age.stderr || !tar.stdin || !tar.stdout || !tar.stderr) throw new Error('Restore-list pipeline streams were unavailable.');
  const transfer = settlePipeline(age.stdout, tar.stdin);
  const listingPromise = collectStream(tar.stdout, 64 * 1024 * 1024);
  const [listing, ageErrorHash, tarErrorHash, ageCode, tarCode] = await Promise.all([
    listingPromise,
    digestStream(age.stderr),
    digestStream(tar.stderr),
    exitCode(age),
    exitCode(tar),
    transfer,
  ]);
  if (ageCode !== 0) throw new SanitizedCommandError('Snapshot decryption', ageErrorHash);
  if (tarCode !== 0) throw new SanitizedCommandError('Archive listing', tarErrorHash);
  // Child-process stdin can report a benign premature close after both tools
  // exit successfully. The listing is validated below and the subsequent
  // extraction performs the full manifest/hash proof, so process failures
  // remain authoritative here.
  const members = listing.split('\n').filter(Boolean);
  if (!members.includes(CONTROL_MANIFEST) && !members.includes(`./${CONTROL_MANIFEST}`)) {
    throw new Error('Archive is missing its custody control manifest.');
  }
  for (const member of members) {
    if (member === '.' || member === './') continue;
    const normalized = member.replace(/^\.\//, '');
    if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..') || /[\0\r]/.test(normalized)) {
      throw new Error('Archive contains an unsafe member path.');
    }
  }
}

async function decryptAndExtract(input: {
  archivePath: string;
  identityFile: string;
  restoreDir: string;
  ageBinary: string;
  tarBinary: string;
}): Promise<void> {
  const tarFlags = await supportedTarExtractFlags(input.tarBinary);
  const age = spawn(input.ageBinary, ['--decrypt', '--identity', input.identityFile, input.archivePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tar = spawn(input.tarBinary, [...tarFlags, '-xf', '-', '-C', input.restoreDir], { stdio: ['pipe', 'ignore', 'pipe'] });
  if (!age.stdout || !age.stderr || !tar.stdin || !tar.stderr) throw new Error('Restore pipeline streams were unavailable.');
  const transfer = settlePipeline(age.stdout, tar.stdin);
  const [ageErrorHash, tarErrorHash, ageCode, tarCode] = await Promise.all([
    digestStream(age.stderr),
    digestStream(tar.stderr),
    exitCode(age),
    exitCode(tar),
    transfer,
  ]);
  if (ageCode !== 0) throw new SanitizedCommandError('Snapshot decryption', ageErrorHash);
  if (tarCode !== 0) throw new SanitizedCommandError('Archive extraction', tarErrorHash);
  // As above, a successful decrypt+extract is proved again by the complete
  // restored manifest. Keep the settled pipeline only to absorb EPIPE safely.
}

async function supportedTarExtractFlags(tarBinary: string): Promise<string[]> {
  const version = await runCapturedSanitized(tarBinary, ['--version'], 'Tar capability inspection');
  if (/GNU tar/i.test(version)) return ['--same-permissions', '--acls', '--xattrs'];
  return ['-p'];
}

async function encryptFile(input: {
  inputPath: string;
  outputPath: string;
  recipientFile: string;
  ageBinary: string;
}): Promise<void> {
  await runSanitized(input.ageBinary, [
    '--encrypt',
    '--recipients-file',
    input.recipientFile,
    '--output',
    input.outputPath,
    input.inputPath,
  ], 'File encryption');
}

async function decryptFile(input: {
  inputPath: string;
  outputPath: string;
  identityFile: string;
  ageBinary: string;
}): Promise<void> {
  await runSanitized(input.ageBinary, [
    '--decrypt',
    '--identity',
    input.identityFile,
    '--output',
    input.outputPath,
    input.inputPath,
  ], 'File decryption');
}

async function validateSourceRoot(path: string): Promise<string> {
  const absolute = validateAbsolutePath(path, 'source root');
  const metadata = await lstat(absolute);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Source root must be a real directory, not a symlink.');
  }
  return realpath(absolute);
}

async function validatePrivateDirectory(path: string, label: string): Promise<string> {
  const absolute = validateAbsolutePath(path, label);
  const metadata = await lstat(absolute);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
  if ((metadata.mode & 0o077) !== 0) throw new Error(`${label} must not grant group or world permissions.`);
  return realpath(absolute);
}

async function validateRegularFile(path: string, label: string): Promise<string> {
  const absolute = validateAbsolutePath(path, label);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
  return realpath(absolute);
}

async function validatePrivateRegularFile(path: string, label: string): Promise<string> {
  const absolute = await validateRegularFile(path, label);
  const metadata = await stat(absolute);
  if ((metadata.mode & 0o077) !== 0) throw new Error(`${label} must not grant group or world permissions.`);
  return absolute;
}

async function validateGitRoot(path: string, gitBinary: string): Promise<string> {
  const root = await validateSourceRoot(path);
  const top = (await runCapturedSanitized(gitBinary, ['-C', root, 'rev-parse', '--show-toplevel'], 'Git root inspection')).trim();
  if (await realpath(top) !== root) throw new Error('Git bundle source must be the repository root.');
  return root;
}

function validateAbsolutePath(path: string, label: string): string {
  if (!path || !isAbsolute(path)) throw new Error(`${label} must be an absolute path.`);
  return resolve(path);
}

async function canonicalizeMissingPath(path: string, label: string): Promise<string> {
  const absolute = validateAbsolutePath(path, label);
  const parent = await realpath(dirname(absolute));
  return join(parent, basename(absolute));
}

function assertInsideParent(path: string, parent: string, label: string): void {
  if (path === parent || !path.startsWith(`${parent}${sep}`)) throw new Error(`${label} must be a child of the restore parent.`);
}

function validateLabel(value: string, label: string): void {
  if (!SAFE_LABEL.test(value)) throw new Error(`${label} must be 1-64 lowercase safe characters.`);
}

function assertSafeManifestPath(path: string): void {
  if (!path || path.startsWith('/') || path.split('/').includes('..') || /[\0\n\r]/.test(path)) {
    throw new Error('Source contains a path that cannot be safely represented in a custody manifest.');
  }
}

function validatePayloadManifest(value: PayloadManifest): void {
  if (value.schemaVersion !== 1 || !Array.isArray(value.entries)) throw new Error('Invalid payload manifest.');
  if (!/^[0-7]{4}$/.test(value.rootMode)) throw new Error('Payload manifest contains an invalid root mode.');
  let previous = '';
  for (const entry of value.entries) {
    assertSafeManifestPath(entry.path);
    if (previous && compareNames(previous, entry.path) >= 0) throw new Error('Payload manifest paths must be uniquely sorted.');
    previous = entry.path;
    if (!/^[0-7]{4}$/.test(entry.mode)) throw new Error('Payload manifest contains an invalid mode.');
    if (entry.type === 'file' && (!SHA256.test(entry.sha256) || entry.bytes < 0)) throw new Error('Payload manifest contains an invalid file receipt.');
    if (entry.type === 'symlink' && (!SHA256.test(entry.targetSha256) || entry.targetBytes < 0)) throw new Error('Payload manifest contains an invalid symlink receipt.');
  }
}

function parseControlManifest(text: string): ControlManifest {
  const value = JSON.parse(text) as ControlManifest;
  if (value.schemaVersion !== 1 || value.format !== SNAPSHOT_FORMAT) throw new Error('Invalid custody control manifest.');
  validateLabel(value.label, 'control label');
  validateLabel(value.storageId, 'control storage ID');
  if (!SHA256.test(value.sourceRootSha256) || !SHA256.test(value.payloadManifestSha256)) throw new Error('Invalid custody manifest hashes.');
  validatePayloadManifest(value.payload);
  if (payloadManifestSha256(value.payload) !== value.payloadManifestSha256) throw new Error('Custody control manifest hash mismatch.');
  return value;
}

function parseSnapshotReceipt(text: string): SnapshotReceipt {
  const value = JSON.parse(text) as SnapshotReceipt;
  if (value.schemaVersion !== 1 || value.format !== RECEIPT_FORMAT || value.kind !== 'encrypted-snapshot') {
    throw new Error('Invalid snapshot receipt.');
  }
  validateReceiptCommon(value);
  if (!SHA256.test(value.payloadManifestSha256)) throw new Error('Invalid snapshot payload hash.');
  if (value.filesystemMetadata?.archiveFormat !== 'pax'
    || value.filesystemMetadata.rootModeAttested !== true
    || value.filesystemMetadata.aclAndXattrs !== 'tar_preserved_not_manifest_attested') {
    throw new Error('Invalid snapshot filesystem-metadata receipt.');
  }
  return value;
}

function parseBundleReceipt(text: string): BundleReceipt {
  const value = JSON.parse(text) as BundleReceipt;
  if (value.schemaVersion !== 1 || value.format !== RECEIPT_FORMAT || value.kind !== 'encrypted-git-bundle') {
    throw new Error('Invalid Git bundle receipt.');
  }
  validateReceiptCommon(value);
  if (!SHA256.test(value.bundleSha256) || !/^[a-f0-9]{40,64}$/.test(value.headCommit)) throw new Error('Invalid Git bundle payload receipt.');
  return value;
}

function validateReceiptCommon(value: SnapshotReceipt | BundleReceipt): void {
  if (value.contentIncluded !== false || value.plaintextPathsIncluded !== false) throw new Error('Receipt is not content-free.');
  validateLabel(value.label, 'receipt label');
  validateLabel(value.storageId, 'receipt storage ID');
  if (!SHA256.test(value.sourceRootSha256) || !SHA256.test(value.artifact.sha256)) throw new Error('Invalid receipt hashes.');
  if (!SHA256.test(value.encryption.recipientSetSha256)) throw new Error('Invalid recipient-set receipt hash.');
  if (basename(value.artifact.fileName) !== value.artifact.fileName) throw new Error('Invalid artifact file name in receipt.');
}

function summarizeManifest(manifest: PayloadManifest): SnapshotReceipt['inventory'] {
  let files = 0;
  let directories = 0;
  let symlinks = 0;
  let logicalBytes = 0;
  for (const entry of manifest.entries) {
    if (entry.type === 'file') {
      files += 1;
      logicalBytes += entry.bytes;
    } else if (entry.type === 'directory') {
      directories += 1;
    } else {
      symlinks += 1;
    }
  }
  return { entries: manifest.entries.length, files, directories, symlinks, logicalBytes };
}

async function writeVerificationReceipt(input: {
  baseReceiptPath: string;
  label: string;
  storageId: string;
  artifactSha256: string;
  payloadSha256: string;
  retained: boolean;
  kind: VerificationReceipt['kind'];
  now?: () => Date;
}): Promise<{ receiptPath: string; receipt: VerificationReceipt }> {
  const verifiedAt = (input.now ?? (() => new Date()))().toISOString();
  const receipt: VerificationReceipt = {
    schemaVersion: 1,
    format: RECEIPT_FORMAT,
    kind: input.kind,
    contentIncluded: false,
    plaintextPathsIncluded: false,
    label: input.label,
    storageId: input.storageId,
    verifiedAt,
    artifactSha256: input.artifactSha256,
    payloadSha256: input.payloadSha256,
    result: 'pass',
    restoredCopyRetained: input.retained,
  };
  const receiptPath = `${input.baseReceiptPath}.${compactTimestamp(verifiedAt)}.verify.json`;
  await writeJsonExclusive(receiptPath, receipt);
  return { receiptPath, receipt };
}

async function removeCreatedResult(result: SnapshotResult): Promise<void> {
  await rm(result.archivePath, { force: true });
  await rm(result.receiptPath, { force: true });
}

async function assertPathsAbsent(paths: string[]): Promise<void> {
  for (const path of paths) {
    const handle = await open(path, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw new Error('Custody output path already exists.');
      throw error;
    });
    await handle.close();
    await unlink(path);
  }
}

async function writeJsonExclusive(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) digest.update(chunk as Buffer);
  return digest.digest('hex');
}

async function normalizedRecipients(path: string): Promise<string[]> {
  const text = await readFile(path, 'utf8');
  const recipients = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      if (line.startsWith('AGE-SECRET-KEY-')) throw new Error('Recipient file must not contain a private age identity.');
      if (/^ssh-(?:ed25519|rsa|ecdsa-[^\s]+)\s+/i.test(line)) {
        const [kind, value] = line.split(/\s+/, 3);
        if (!kind || !value) throw new Error('Recipient file contains an invalid SSH recipient.');
        return `${kind} ${value}`;
      }
      const [recipient] = line.split(/\s+/, 1);
      if (!recipient || !/^age1[0-9a-z]+$/i.test(recipient)) throw new Error('Recipient file contains an unsupported recipient.');
      return recipient;
    });
  const unique = [...new Set(recipients)].sort(compareNames);
  if (unique.length === 0) throw new Error('Recipient file contains no recipients.');
  return unique;
}

async function recipientSetSha256(path: string): Promise<string> {
  return sha256(Buffer.from(`${(await normalizedRecipients(path)).join('\n')}\n`));
}

async function gitState(sourceRoot: string, gitBinary: string): Promise<{ headCommit: string; refs: string[] }> {
  const headCommit = (await runCapturedSanitized(gitBinary, ['-C', sourceRoot, 'rev-parse', 'HEAD'], 'Git HEAD inspection')).trim();
  if (!/^[a-f0-9]{40,64}$/.test(headCommit)) throw new Error('Git repository has no valid HEAD commit.');
  const refs = (await runCapturedSanitized(
    gitBinary,
    ['-C', sourceRoot, 'for-each-ref', '--format=%(refname)%00%(objectname)'],
    'Git ref inspection',
  )).split('\n').filter(Boolean).sort(compareNames);
  return { headCommit, refs };
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function modeString(mode: bigint): string {
  return Number(mode & 0o7777n).toString(8).padStart(4, '0');
}

function safeNumber(value: bigint, label: string): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error(`${label} is outside the supported range.`);
  return numeric;
}

function compareNames(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function compactTimestamp(iso: string): string {
  return iso.replace(/[-:.]/g, '').replace('Z', 'Z');
}

function sanitizeUnexpectedError(error: unknown, stage: string): Error {
  if (error instanceof SanitizedCommandError) return error;
  if (error instanceof Error && [
    'Source changed during capture; no snapshot was committed.',
    'Encrypted snapshot hash does not match its receipt.',
    'Encrypted snapshot control metadata does not match its receipt.',
    'Encrypted snapshot manifest hash does not match its receipt.',
    'Restored payload does not match the encrypted manifest.',
    'Restored payload metadata does not match the encrypted manifest.',
    'Decrypted Git bundle does not match its receipt.',
    'Restored Git HEAD does not match its receipt.',
  ].includes(error.message)) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${stage} failed; diagnostic_sha256=${sha256(Buffer.from(detail))}`);
}

async function digestStream(stream: NodeJS.ReadableStream): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of stream) digest.update(chunk as Buffer);
  return digest.digest('hex');
}

async function settlePipeline(
  source: NodeJS.ReadableStream,
  destination: NodeJS.WritableStream,
): Promise<string | undefined> {
  try {
    await pipeline(source, destination);
    return undefined;
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}:${error.message}` : String(error);
    return sha256(Buffer.from(detail));
  }
}

async function collectStream(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw new Error('Archive listing exceeds the bounded verification limit.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function exitCode(process: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    process.once('error', rejectPromise);
    process.once('close', (code) => resolvePromise(code ?? 1));
  });
}

async function runSanitized(command: string, args: string[], stage: string, cwd?: string): Promise<void> {
  const process = spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
  if (!process.stderr) throw new Error(`${stage} did not expose a diagnostic stream.`);
  const [stderrHash, code] = await Promise.all([digestStream(process.stderr), exitCode(process)]);
  if (code !== 0) throw new SanitizedCommandError(stage, stderrHash);
}

async function runCapturedSanitized(command: string, args: string[], stage: string, cwd?: string): Promise<string> {
  const process = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!process.stdout || !process.stderr) throw new Error(`${stage} did not expose command streams.`);
  const [stdout, stderrHash, code] = await Promise.all([
    collectStream(process.stdout, 16 * 1024 * 1024),
    digestStream(process.stderr),
    exitCode(process),
  ]);
  if (code !== 0) throw new SanitizedCommandError(stage, stderrHash);
  return stdout;
}

function usage(): never {
  console.error([
    'Usage:',
    '  bun scripts/private-custody.ts snapshot --source <abs> --destination <abs> --recipient-file <abs> --label <id> --storage-id <id>',
    '  bun scripts/private-custody.ts snapshot-pair --source <abs> --label <id> --destination-a <abs> --recipient-file-a <abs> --storage-id-a <id> --destination-b <abs> --recipient-file-b <abs> --storage-id-b <id>',
    '  bun scripts/private-custody.ts verify-snapshot --archive <abs> --receipt <abs> --identity-file <abs> --restore-parent <abs> [--keep-restored-at <abs>]',
    '  bun scripts/private-custody.ts git-bundle --source <abs> --destination <abs> --recipient-file <abs> --label <id> --storage-id <id>',
    '  bun scripts/private-custody.ts verify-git-bundle --archive <abs> --receipt <abs> --identity-file <abs> --restore-parent <abs>',
  ].join('\n'));
  process.exit(2);
}

function parseArgs(argv: string[]): { command: string; values: Map<string, string> } {
  const [command, ...rest] = argv;
  if (!command) usage();
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--') || values.has(key)) usage();
    values.set(key, value);
  }
  return { command, values };
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) usage();
  return value;
}

function assertOnlyArgs(values: Map<string, string>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if ([...values.keys()].some((key) => !allowedSet.has(key))) usage();
}

async function main(argv: string[]): Promise<void> {
  const { command, values } = parseArgs(argv);
  if (command === 'snapshot') {
    assertOnlyArgs(values, ['--source', '--destination', '--recipient-file', '--label', '--storage-id']);
    const result = await captureSnapshot({
      sourceRoot: required(values, '--source'),
      destinationDir: required(values, '--destination'),
      recipientFile: required(values, '--recipient-file'),
      label: required(values, '--label'),
      storageId: required(values, '--storage-id'),
    });
    console.log(JSON.stringify({ ok: true, kind: result.receipt.kind, label: result.receipt.label, storageId: result.receipt.storageId, artifact: basename(result.archivePath), receipt: basename(result.receiptPath), payloadManifestSha256: result.receipt.payloadManifestSha256 }));
    return;
  }
  if (command === 'snapshot-pair') {
    assertOnlyArgs(values, ['--source', '--label', '--destination-a', '--recipient-file-a', '--storage-id-a', '--destination-b', '--recipient-file-b', '--storage-id-b']);
    const [first, second] = await captureSnapshotPair({
      sourceRoot: required(values, '--source'),
      label: required(values, '--label'),
      first: {
        destinationDir: required(values, '--destination-a'),
        recipientFile: required(values, '--recipient-file-a'),
        storageId: required(values, '--storage-id-a'),
      },
      second: {
        destinationDir: required(values, '--destination-b'),
        recipientFile: required(values, '--recipient-file-b'),
        storageId: required(values, '--storage-id-b'),
      },
    });
    console.log(JSON.stringify({ ok: true, kind: 'encrypted-snapshot-pair', payloadManifestSha256: first.receipt.payloadManifestSha256, artifacts: [basename(first.archivePath), basename(second.archivePath)] }));
    return;
  }
  if (command === 'verify-snapshot') {
    assertOnlyArgs(values, ['--archive', '--receipt', '--identity-file', '--restore-parent', '--keep-restored-at']);
    const result = await verifySnapshotRestore({
      archivePath: required(values, '--archive'),
      receiptPath: required(values, '--receipt'),
      identityFile: required(values, '--identity-file'),
      restoreParent: required(values, '--restore-parent'),
      ...(values.get('--keep-restored-at') ? { keepRestoredAt: values.get('--keep-restored-at') } : {}),
    });
    console.log(JSON.stringify({ ok: true, kind: result.receipt.kind, result: result.receipt.result, receipt: basename(result.receiptPath), restoredCopyRetained: result.receipt.restoredCopyRetained }));
    return;
  }
  if (command === 'git-bundle') {
    assertOnlyArgs(values, ['--source', '--destination', '--recipient-file', '--label', '--storage-id']);
    const result = await captureGitBundle({
      sourceRoot: required(values, '--source'),
      destinationDir: required(values, '--destination'),
      recipientFile: required(values, '--recipient-file'),
      label: required(values, '--label'),
      storageId: required(values, '--storage-id'),
    });
    console.log(JSON.stringify({ ok: true, kind: result.receipt.kind, label: result.receipt.label, storageId: result.receipt.storageId, artifact: basename(result.archivePath), receipt: basename(result.receiptPath), bundleSha256: result.receipt.bundleSha256 }));
    return;
  }
  if (command === 'verify-git-bundle') {
    assertOnlyArgs(values, ['--archive', '--receipt', '--identity-file', '--restore-parent']);
    const result = await verifyGitBundleRestore({
      archivePath: required(values, '--archive'),
      receiptPath: required(values, '--receipt'),
      identityFile: required(values, '--identity-file'),
      restoreParent: required(values, '--restore-parent'),
    });
    console.log(JSON.stringify({ ok: true, kind: result.receipt.kind, result: result.receipt.result, receipt: basename(result.receiptPath) }));
    return;
  }
  usage();
}

if (import.meta.main) {
  await main(process.argv.slice(2)).catch((error) => {
    const safe = sanitizeUnexpectedError(error, 'Private custody command');
    console.error(safe.message);
    process.exit(1);
  });
}
