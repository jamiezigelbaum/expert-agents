import { readdir, readFile, stat } from 'node:fs/promises';

const packageDirs = (await readdir('packages', { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => `packages/${entry.name}`)
  .sort();

const required = {
  typecheck: { operation: 'tsc', pattern: /(?:^|&&|\|\||;|\|)\s*tsc(?:\s|$)/ },
  test: { operation: 'bun test', pattern: /(?:^|&&|\|\||;|\|)\s*bun\s+test(?:\s|$)/ },
  build: { operation: 'bun build', pattern: /(?:^|&&|\|\||;|\|)\s*bun\s+build(?:\s|$)/ },
} as const;
const failures: string[] = [];
for (const dir of packageDirs) {
  const manifest = JSON.parse(await readFile(`${dir}/package.json`, 'utf8')) as { name?: string; scripts?: Record<string, string> };
  if (!manifest.name?.startsWith('@expert-agents/')) failures.push(`${dir}: package name must use @expert-agents/*`);
  const packageName = manifest.name ?? dir;
  for (const [script, approved] of Object.entries(required)) {
    const command = manifest.scripts?.[script]?.trim();
    if (!command) {
      failures.push(`${packageName}: missing required ${script} script`);
    } else if (/\b(skip|echo)\b/i.test(command) || !approved.pattern.test(command)) {
      failures.push(`${packageName}: ${script} script must invoke ${approved.operation}`);
    }
  }
}

// Root operator commands: every `bun scripts/<file>` entry must name a script
// that exists, so a renamed or deleted operator CLI fails here rather than at
// the moment an operator reaches for it.
const rootManifestText = await readFile('package.json', 'utf8').catch((error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return undefined;
  throw error;
});
const rootManifest = rootManifestText === undefined ? {} : JSON.parse(rootManifestText) as { scripts?: Record<string, string> };
for (const [script, command] of Object.entries(rootManifest.scripts ?? {})) {
  const match = /^bun\s+(scripts\/[A-Za-z0-9_.-]+\.ts)(?:\s|$)/.exec(command.trim());
  if (match === null) continue;
  const target = match[1]!;
  const exists = await stat(target).then((entry) => entry.isFile()).catch(() => false);
  if (!exists) failures.push(`root: ${script} script names a missing file ${target}`);
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`verified required scripts for ${packageDirs.length} packages`);
