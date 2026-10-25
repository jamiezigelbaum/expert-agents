/**
 * Return a safe operation reference only beneath an exact trusted parent.
 * Callers establish project aliases before supplying parents; a returned name
 * must never establish its own project or corpus authority.
 */
export function validatedVertexOperationName(
  value: unknown,
  allowedParents: readonly string[],
): string | undefined {
  if (typeof value !== "string") return undefined;
  for (const parent of allowedParents) {
    // Validate the parent shape too, so a malformed configured parent cannot
    // turn an otherwise anchored comparison into a URL traversal or query.
    if (!/^projects\/[a-z0-9][a-z0-9-]*\/locations\/[a-z0-9][a-z0-9-]*(?:\/ragCorpora\/[A-Za-z0-9_-]+)?$/.test(parent)) continue;
    const prefix = `${parent}/operations/`;
    if (value.startsWith(prefix) && /^[A-Za-z0-9_-]+$/.test(value.slice(prefix.length))) return value;
  }
  return undefined;
}
