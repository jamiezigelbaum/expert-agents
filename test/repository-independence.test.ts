import { expect, test } from 'bun:test';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dir, '..');
const retiredProduct = 'olym' + 'pus';

// Owns the regression where extraction appeared complete while a build or
// deployment dependency could still reach the old product or inert archive.
// Keep this inexpensive source/manifest check until the module boundary is
// enforced by a replacement package resolver with equivalent coverage.
function forbiddenDependency(value: string): boolean {
  return new RegExp(`(?:^|[/@:])${retiredProduct}(?:$|[/\\s#.:])`, 'i').test(value)
    || /(?:^|\/)(?:archive|migration)(?:\/|$)/.test(value);
}

test('independence policy catches package, sibling, and preserved-source dependencies', () => {
  for (const value of [
    retiredProduct, `@${retiredProduct}/core`, `../${retiredProduct}/src/index.ts`,
    `file:../${retiredProduct}`, '../../archive/runtime.ts', '../migration/shadow.ts',
  ]) expect(forbiddenDependency(value)).toBe(true);
  expect(forbiddenDependency('@expert-agents/library')).toBe(false);
  expect(forbiddenDependency('node:fs/promises')).toBe(false);
});

test('active modules resolve inside this repository and never load preserved implementations', async () => {
  const failures: string[] = [];
  for (const directory of ['src', 'packages', 'scripts']) {
    for (const path of await filesUnder(join(root, directory))) {
      if (!path.endsWith('.ts') || path.endsWith('.d.ts') || /[/\\]test[/\\]/.test(path)) continue;
      const tree = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
      const specifiers: string[] = [];
      function visit(node: ts.Node): void {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
          && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          specifiers.push(node.moduleSpecifier.text);
        }
        if (ts.isCallExpression(node)
          && (node.expression.kind === ts.SyntaxKind.ImportKeyword
            || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
          && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
          specifiers.push(node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
      }
      visit(tree);
      for (const specifier of specifiers) {
        if (forbiddenDependency(specifier)) failures.push(`${relative(root, path)}: ${specifier}`);
        if (!specifier.startsWith('.') && !isAbsolute(specifier)) continue;
        const target = resolve(dirname(path), specifier);
        const resolved = await realpath(target).catch(() => target);
        const relativePath = relative(root, resolved);
        if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
          failures.push(`${relative(root, path)}: dependency leaves repository: ${specifier}`);
        }
      }
    }
  }
  expect(failures).toEqual([]);
});

test('package manifests declare no retired product or archive dependencies', async () => {
  const manifests = [join(root, 'package.json'), ...(await filesUnder(join(root, 'packages')))
    .filter((path) => path.endsWith('/package.json'))];
  const failures: string[] = [];
  for (const path of manifests) {
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'scripts']) {
      for (const [name, value] of Object.entries(manifest[section] ?? {})) {
        if (forbiddenDependency(name) || forbiddenDependency(String(value))) {
          failures.push(`${relative(root, path)}: ${section}.${name}`);
        }
      }
    }
  }
  expect(failures).toEqual([]);
});

async function filesUnder(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
