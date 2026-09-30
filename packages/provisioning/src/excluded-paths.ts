/**
 * Path classes that may never reach a served deployment.
 *
 * The three structural exclusions are non-negotiable. They are checked twice:
 * once when a `serving` block is declared, and again after directory prefixes
 * expand at packaging time. The second check is the real gate, because a
 * lexically innocent prefix such as `notes/` can still expand onto an excluded
 * file.
 *
 * The excluded-class refusals are derived from the scaffolded agent-repository
 * `.gitignore` rather than duplicated as literals, so a new excluded-class
 * pattern only has to be added in one place.
 *
 * Contract-file class is deliberately absent from every list here. The agent
 * manifest's `avatar` is the clearest case: it is public-safe presentation, so
 * it ships whenever the serving set names it, and the only rule it inherits
 * from this module is that it may not hide inside an excluded path.
 */

import { AGENT_REPO_GITIGNORE } from '@expert-agents/library';

export { AGENT_REPO_GITIGNORE } from '@expert-agents/library';

/** Workspace paths a served deployment may never receive, under any posture. */
export const STRUCTURAL_SERVING_EXCLUSIONS = ["USER.md", "MEMORY.md", "memory/"] as const;

export type ServingExclusionReason = "structural" | "excluded_class";

interface GitignorePattern {
  /** Pattern segments, each possibly containing `*`. */
  segments: string[];
  /** The pattern ended in `/` and therefore names a directory. */
  directoryOnly: boolean;
  /** The pattern contained a `/` and therefore anchors at the repository root. */
  anchored: boolean;
}

const EXCLUDED_CLASS_PATTERNS = parseGitignore(AGENT_REPO_GITIGNORE);
const STRUCTURAL_FILE_NAMES = new Set(["USER.md", "MEMORY.md"]);
const STRUCTURAL_DIRECTORY_SEGMENT = "memory";

/**
 * Why a repo-relative serving-set entry may never ship, or `null` when it is
 * allowed. The entry may be an exact file path or a `/`-terminated directory
 * prefix; its shape is validated separately.
 */
export function servingExclusionReason(entry: string): ServingExclusionReason | null {
  const isDirectoryPrefix = entry.endsWith("/");
  const body = isDirectoryPrefix ? entry.slice(0, -1) : entry;
  const segments = body.split("/");
  if (segments.some((segment) => segment === STRUCTURAL_DIRECTORY_SEGMENT)) return "structural";
  if (STRUCTURAL_FILE_NAMES.has(segments[segments.length - 1] ?? "")) return "structural";
  const excludedClass = EXCLUDED_CLASS_PATTERNS.some(
    (pattern) => matchesPattern(pattern, segments, isDirectoryPrefix),
  );
  return excludedClass ? "excluded_class" : null;
}

function parseGitignore(gitignore: string): GitignorePattern[] {
  return gitignore
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const directoryOnly = line.endsWith("/");
      const body = directoryOnly ? line.slice(0, -1) : line;
      return { segments: body.split("/"), directoryOnly, anchored: body.includes("/") };
    });
}

function matchesPattern(
  pattern: GitignorePattern,
  segments: string[],
  isDirectoryPrefix: boolean,
): boolean {
  if (pattern.anchored) {
    if (segments.length < pattern.segments.length) return false;
    const matchesPrefix = pattern.segments.every(
      (patternSegment, index) => matchesSegment(patternSegment, segments[index]!),
    );
    if (!matchesPrefix) return false;
    if (segments.length > pattern.segments.length) return true;
    return !pattern.directoryOnly || isDirectoryPrefix;
  }
  const patternSegment = pattern.segments[0]!;
  return segments.some((segment, index) => {
    if (!matchesSegment(patternSegment, segment)) return false;
    if (!pattern.directoryOnly) return true;
    return index < segments.length - 1 || isDirectoryPrefix;
  });
}

function matchesSegment(patternSegment: string, segment: string): boolean {
  const source = patternSegment
    .split("*")
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${source}$`).test(segment);
}
