// Workspace seeding, stage-import file collection and path containment for domain workspaces.
import { appendFile, lstat, mkdir, open, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { domainManifest } from '../../core/domain-expert.ts';
import { AGENT_REPO_GITIGNORE, parseScopeManifest } from '@expert-agents/library';
import type { DomainExpertWorkspaceRootPolicy } from './worker-config.ts';
import { DomainExpertWorkerError } from './worker-errors.ts';
import { sha256 } from './worker-util.ts';

export async function writeWorkspaceSeedFiles(
  root: DomainExpertWorkspaceRootPolicy,
  rootPath: string,
  manifest: ReturnType<typeof domainManifest>,
): Promise<Array<Record<string, unknown>>> {
  const rootRel = manifest.workspace_relative_path;
  const files: Array<[string, string]> = [
    [`${rootRel}/.gitignore`, AGENT_REPO_GITIGNORE],
    [`${rootRel}/PROPOSAL.md`, proposalContent(manifest)],
    [`${rootRel}/domain.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`],
    [`${rootRel}/references/ingest-log.md`, `# Ingest Log\n\nCreated ${new Date().toISOString()}.\n`],
    [`${rootRel}/references/reading-map.md`, `# ${manifest.display_name} Reading Map\n`],
    [`${rootRel}/references/retrieval-craft.md`, retrievalCraftContent()],
    [`${rootRel}/templates/source-card.md`, `# Source Card\n\n- Title:\n- Author:\n- Book:\n- Status:\n- Notes:\n`],
    [`${rootRel}/templates/research-brief.md`, '# Research Brief\n\n## Question\n\n## Evidence\n\n## Answer\n\n## Gaps\n'],
    [`${rootRel}/templates/literature-review.md`, '# Literature Review\n\n## Sources\n\n## Themes\n\n## Disagreements\n'],
    [`${rootRel}/templates/disagreement-map.md`, '# Disagreement Map\n\n## Claims\n\n## Tradeoffs\n\n## Open Questions\n'],
    [`${rootRel}/eval/questions.jsonl`, `${JSON.stringify({
      id: `${manifest.domain_id}-example-1`,
      question: `What are the central open questions in the ${manifest.display_name} library?`,
      expected_sources: [],
      tags: ['example'],
      notes: 'Example format: id, question, expected_sources, tags, notes. Replace or extend this row; every persistent retrieval miss becomes an eval case.',
    })}\n`],
  ];
  const results = [];
  for (const [relativePath, content] of files) {
    const target = await resolveWritePathInside(rootPath, relativePath);
    const bytes = new TextEncoder().encode(content);
    if (bytes.byteLength > root.maxWriteBytes) {
      throw new DomainExpertWorkerError(413, 'content_too_large', `${relativePath} exceeds the root write limit.`);
    }
    await mkdir(dirname(target), { recursive: true });
    const existed = await exists(target);
    if (!existed) {
      const file = await open(target, 'wx', 0o600);
      try {
        await file.writeFile(bytes);
      } finally {
        await file.close();
      }
    } else if (root.allowOverwrite) {
      await writeFile(target, bytes, { mode: 0o600 });
    }
    results.push({
      relative_path: relativePath,
      status: existed ? (root.allowOverwrite ? 'overwritten' : 'skipped_existing') : 'created',
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
  return results;
}

function retrievalCraftContent(): string {
  return [
    '# Retrieval Craft',
    '',
    'Use these practices when you call `domain_library`:',
    '',
    '- Start with `catalog` to see which books you hold; name the book (`book`) when you know it.',
    '- `search` with several short, focused queries from different angles; one topic per query.',
    "- When results are weak, search again in the source's own vocabulary, or `grep` for the exact term.",
    '- `read` the unit a hit came from before relying on it, and `read_range` to follow an argument across pages.',
    '- Use `view_page` for figures, tables and diagrams; the text of a page may not describe them.',
    '- Cite every claim with the citation label the tool returned. Never cite or imply support from a passage you did not read.',
    '- When the library is silent, say so and stop; do not answer from memory.',
    '- When a source you expect keeps missing, tell your owner. Retrieval misses become eval cases: record the miss in `eval/questions.jsonl` so it cannot silently regress.',
    '',
  ].join('\n');
}

function proposalContent(manifest: ReturnType<typeof domainManifest>): string {
  return [
    `# ${manifest.display_name}`,
    '',
    '## Core Role',
    '',
    `You are the ${manifest.display_name}. Answer from the curated ${manifest.domain_id} library, cite source-backed claims, and name gaps plainly.`,
    '',
    '## Source Hierarchy',
    '',
    '- Owner-authored docs and approved working notes',
    '- Canonical books, PDFs, papers, and source texts',
    '- Public web essays and blog posts',
    '',
    '## Workflow',
    '',
    'Use library_ingest to add approved sources and domain_library for grounded answers with page citations.',
    '',
  ].join('\n');
}

export async function checkedRootPath(root: DomainExpertWorkspaceRootPolicy): Promise<string> {
  const rootPath = resolve(root.path);
  const info = await stat(rootPath).catch(() => undefined);
  if (!info?.isDirectory()) throw new DomainExpertWorkerError(400, 'root_not_directory', 'Configured domain workspace root is not a directory.');
  return rootPath;
}

export function resolveInside(rootPath: string, relativePath: string): string {
  if (relativePath.startsWith('/') || relativePath.includes('\0')) {
    throw new DomainExpertWorkerError(400, 'path_escape_denied', 'Use relative paths inside the domain workspace root.');
  }
  const target = resolve(rootPath, relativePath);
  if (!(target === rootPath || target.startsWith(`${rootPath}${sep}`))) {
    throw new DomainExpertWorkerError(400, 'path_escape_denied', 'relative_path escapes the domain workspace root.');
  }
  return target;
}

export async function resolveWritePathInside(
  rootPath: string,
  relativePath: string,
  containmentMessage = 'relative_path escapes the domain workspace root.',
): Promise<string> {
  const target = resolveInside(rootPath, relativePath);
  const relativeTarget = relative(rootPath, target);
  let component = rootPath;
  for (const segment of relativeTarget.split(sep).filter(Boolean)) {
    component = join(component, segment);
    const info = await lstat(component).catch((error) => {
      if (isFileSystemError(error, 'ENOENT')) return undefined;
      throw error;
    });
    if (!info) break;
    if (info.isSymbolicLink()) {
      throw new DomainExpertWorkerError(400, 'path_escape_denied', containmentMessage);
    }
  }

  const canonicalRoot = await realpath(rootPath);
  let existingAncestor = target;
  while (true) {
    try {
      const canonicalAncestor = await realpath(existingAncestor);
      if (!(canonicalAncestor === canonicalRoot || canonicalAncestor.startsWith(`${canonicalRoot}${sep}`))) {
        throw new DomainExpertWorkerError(400, 'path_escape_denied', containmentMessage);
      }
      break;
    } catch (error) {
      if (!isFileSystemError(error, 'ENOENT')) throw error;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      existingAncestor = parent;
    }
  }

  return target;
}

function isFileSystemError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === code);
}

export async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

export async function audit(root: DomainExpertWorkspaceRootPolicy, record: Record<string, unknown>): Promise<void> {
  if (!root.auditPath) return;
  await mkdir(dirname(root.auditPath), { recursive: true });
  await appendFile(root.auditPath, `${JSON.stringify(record)}\n`, 'utf8');
}

export async function inspectConfiguredScopeManifest(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
    return {
      configured: true,
      present: !missing,
      parseable: false,
    };
  }

  try {
    const scope = parseScopeManifest(text);
    return {
      configured: true,
      present: true,
      parseable: true,
      agent_id: scope.agentId,
      selected_object_count: scope.selection.objectIds.length,
    };
  } catch {
    return {
      configured: true,
      present: true,
      parseable: false,
    };
  }
}

export function isJunkStageImportPath(workspaceRelativePath: string): boolean {
  return workspaceRelativePath.split('/').some((segment) => (
    segment === '.DS_Store'
    || segment.startsWith('._')
    || (segment.startsWith('.') && segment.length > 1)
  ));
}

export async function collectStageImportFiles(
  rootPath: string,
  targetPath: string,
): Promise<Array<{
  workspaceRelativePath: string;
  uploadRelativePath: string;
  absolutePath: string;
  bytes: number;
}>> {
  const targetInfo = await stat(targetPath).catch(() => undefined);
  if (!targetInfo) throw new DomainExpertWorkerError(404, 'workspace_path_not_found', 'workspace_relative_path does not exist.');
  const rootRealPath = await realpath(rootPath);
  const targetRealPath = await realpath(targetPath);
  const targetIsDirectory = targetInfo.isDirectory();
  const paths = targetIsDirectory
    ? await collectFilesRecursively(rootRealPath, targetRealPath)
    : [targetRealPath];
  const files = [];
  for (const absolutePath of paths) {
    await assertRealPathInside(rootRealPath, absolutePath, 'workspace_relative_path escapes the domain workspace root.');
    const info = await stat(absolutePath);
    if (!info.isFile()) continue;
    const workspaceRelativePath = toPortableRelativePath(rootRealPath, absolutePath);
    const uploadRelativePath = targetIsDirectory
      ? toPortableRelativePath(targetRealPath, absolutePath)
      : basename(absolutePath);
    files.push({
      workspaceRelativePath,
      uploadRelativePath,
      absolutePath,
      bytes: info.size,
    });
  }
  return files.sort((left, right) => left.workspaceRelativePath.localeCompare(right.workspaceRelativePath));
}

async function collectFilesRecursively(rootRealPath: string, directoryPath: string): Promise<string[]> {
  await assertRealPathInside(rootRealPath, directoryPath, 'workspace_relative_path escapes the domain workspace root.');
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(directoryPath, entry.name);
    const info = await stat(absolutePath);
    if (info.isDirectory()) {
      files.push(...await collectFilesRecursively(rootRealPath, await realpath(absolutePath)));
    } else if (info.isFile()) {
      files.push(await realpath(absolutePath));
    }
  }
  return files.sort();
}

async function assertRealPathInside(rootPath: string, targetPath: string, message: string): Promise<void> {
  const rootRealPath = await realpath(rootPath);
  const targetRealPath = await realpath(targetPath);
  if (!(targetRealPath === rootRealPath || targetRealPath.startsWith(`${rootRealPath}${sep}`))) {
    throw new DomainExpertWorkerError(400, 'path_escape_denied', message);
  }
}

function toPortableRelativePath(rootPath: string, targetPath: string): string {
  return relative(rootPath, targetPath).split(sep).join('/');
}
