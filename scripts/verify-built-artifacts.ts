import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ownerWordsIn } from '../packages/provisioning/src/owner-names.ts';
import { HIGH_CONFIDENCE_SECRET_PATTERNS } from '../packages/provisioning/src/secret-patterns.ts';

// Post-build half of the truth-string gate. The test-suite half scans sources,
// but tests run before build and dist/ is untracked, so on a clean checkout no
// test ever sees the artifacts that actually ship. This script runs last in
// `verify`, after build and both packaging steps, so a green verify proves the
// shipped bytes — not just the sources — are tenant-neutral and secret-free.
// A missing artifact root is a failure, not a skip: a vacuous pass here is the
// exact hole this gate exists to close.

// Patterns are split so this file passes the scans it mirrors.
const nonexistentConnectCommandPattern = new RegExp(
  `expert-agents ${'con'}nect\\s+(?:g${'cp'}|not${'ion'})`,
  'i',
);
const ownerPathPattern = /(?:\/Users|\/home)\/[A-Za-z0-9._-]+\/(?:Code|Library|Documents|Dropbox|\.)/;
const retiredProductPattern = new RegExp(`\\bolym${'pus'}\\b|olym${'pus'}_control_plane_only`, 'i');

// Each expected output is its own root so a packaging step that silently
// produced nothing fails as "missing", never as a smaller clean scan.
const artifactRoots: string[] = ['dist/plugin-package', 'dist/deploy-package'];
const artifactFiles: string[] = ['dist/plugin.js', 'dist/factory.js'];
for (const entry of await readdir('packages', { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packageJson = await readFile(join('packages', entry.name, 'package.json'), 'utf8').catch(() => '');
  if (!packageJson) continue;
  if ('build' in (JSON.parse(packageJson).scripts ?? {})) {
    artifactRoots.push(join('packages', entry.name, 'dist'));
  }
}

const failures: string[] = [];
let scanned = 0;
for (const root of artifactRoots) {
  if (!(await stat(root).catch(() => undefined))?.isDirectory()) {
    failures.push(`${root}: expected built output is missing; run build and packaging before this scan`);
    continue;
  }
  const files = await collectFiles(root);
  if (files.length === 0) {
    failures.push(`${root}: expected built output is empty; run build and packaging before this scan`);
    continue;
  }
  for (const path of files) await scanFile(path);
}
for (const path of artifactFiles) {
  if (!(await stat(path).catch(() => undefined))?.isFile()) {
    failures.push(`${path}: expected built output is missing; run build and packaging before this scan`);
    continue;
  }
  await scanFile(path);
}

async function scanFile(path: string): Promise<void> {
  scanned += 1;
  const text = await readFile(path, 'utf8');
  const ownerWords = ownerWordsIn(text);
  if (ownerWords.length > 0) failures.push(`${path}: built artifact contains an owner-specific name (${ownerWords.join(', ')})`);
  if (nonexistentConnectCommandPattern.test(text)) failures.push(`${path}: built artifact names a nonexistent connect command`);
  if (ownerPathPattern.test(text)) failures.push(`${path}: built artifact contains an owner-specific path`);
  if (retiredProductPattern.test(text)) failures.push(`${path}: built artifact contains a retired product dependency or response contract`);
  if (HIGH_CONFIDENCE_SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    failures.push(`${path}: built artifact matches a high-confidence secret pattern`);
  }
}

if (scanned === 0) failures.push('no built artifact files were scanned');
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`built-artifact scan passed for ${scanned} files across ${artifactRoots.length} roots`);

async function collectFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort();
}
