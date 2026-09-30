import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ownerWordsIn } from '../packages/provisioning/src/owner-names.ts';
import { HIGH_CONFIDENCE_SECRET_PATTERNS } from '../packages/provisioning/src/secret-patterns.ts';

const tracked = (await run(['git', 'ls-files', '-z'])).split('\0').filter(Boolean);
const failures: string[] = [];
const forbiddenTracked = /(^|\/)(\.env|\.secrets?|node_modules|\.next|out|cache|data|episodes)(\/|$)|\.(db|sqlite3?|log|journal)$/i;
const activePrefixes = ['.github/', 'packages/', 'skills/', 'src/', 'scripts/'];
const secretPatterns = HIGH_CONFIDENCE_SECRET_PATTERNS;
// Owner agents, hosts, people and private products never enter this public
// repository: fixtures and examples use neutral names (example, expert-a,
// research, governance). The LICENSE copyright line is the one sanctioned place
// for the owner's name.
const ownerNameAllowed = new Set(['LICENSE']);
const homePathPattern = /(?:\/Users|\/home)\/[A-Za-z0-9._-]+\/(?:Code|Library|Documents|Dropbox|\.)/;

for (const path of tracked) {
  if (forbiddenTracked.test(path)) failures.push(`${path}: forbidden data/secret/runtime artifact path`);
  const text = await readFile(path, 'utf8').catch(() => '');
  if (secretPatterns.some((pattern) => pattern.test(text))) failures.push(`${path}: high-confidence secret pattern`);
  // A raw control character in source compiles fine and is invisible in most
  // editors, but it makes the file binary to file(1), grep, and review tooling
  // — a NUL used as a template-literal delimiter cost a review pass here.
  // Write them as escape sequences instead, so the source stays searchable.
  if (path.endsWith('.ts') && /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text)) {
    failures.push(`${path}: raw control character in source; write it as an escape sequence`);
  }
  const active = activePrefixes.some((prefix) => path.startsWith(prefix)) && path !== 'scripts/verify-boundaries.ts';
  if (active && /['"]@?olympus(?:\/|['"])/i.test(text)) {
    failures.push(`${path}: active code depends on another project's private modules`);
  }
  const ownerWords = ownerNameAllowed.has(path) ? [] : ownerWordsIn(text);
  if (ownerWords.length > 0) {
    failures.push(`${path}: owner-specific agent, host, person or product name (${ownerWords.join(', ')}); use a neutral name`);
  }
  if (path !== 'scripts/verify-boundaries.ts' && homePathPattern.test(text)) {
    failures.push(`${path}: absolute home-directory path`);
  }
}

// Documentation must not link to moved or deleted files.
for (const path of tracked.filter((p) => p.endsWith('.md'))) {
  const text = await readFile(path, 'utf8');
  for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    if (!existsSync(resolve(dirname(path), target))) failures.push(`${path}: broken relative link ${target}`);
  }
}

for (const required of ['LICENSE', 'openclaw.plugin.json', 'skills/manifest.json']) {
  if (!tracked.includes(required)) failures.push(`${required}: required gate file is not tracked`);
}
const license = await readFile('LICENSE', 'utf8').catch(() => '');
if (!license.startsWith('MIT License')) failures.push('LICENSE: expected the MIT license text');
for (const manifest of tracked.filter((path) => path === 'package.json' || /^packages\/[^/]+\/package\.json$/.test(path))) {
  const declared = JSON.parse(await readFile(manifest, 'utf8')).license;
  if (declared !== 'MIT') failures.push(`${manifest}: license must be "MIT", found ${JSON.stringify(declared)}`);
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`boundary scan passed for ${tracked.length} tracked paths`);

async function run(command: string[]): Promise<string> {
  const proc = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${command.join(' ')} failed: ${stderr}`);
  return stdout;
}
