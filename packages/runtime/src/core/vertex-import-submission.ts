import { validatedVertexOperationName } from '@expert-agents/library';

/** Submission custody only: neither a done LRO nor this receipt proves ACTIVE files. */
export function vertexImportSubmissionReceipt(operation: unknown, corpusResourceName: string, verifiedCorpusAlias?: string): {
  status: 'import_requested';
  corpus_resource_name: string;
  operation_name: string;
  operation_done: boolean;
  operation_error: boolean;
} | undefined {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return undefined;
  const record = operation as Record<string, unknown>;
  // Only a caller's canonical-project scoped GET can establish this alias.
  const name = validatedVertexOperationName(record.name, [corpusResourceName, ...(verifiedCorpusAlias ? [verifiedCorpusAlias] : [])]);
  if (name === undefined) return undefined;
  return {
    status: 'import_requested', corpus_resource_name: corpusResourceName,
    operation_name: name, operation_done: record.done === true,
    operation_error: record.error !== undefined,
  };
}

/** Bounded recovery metadata only; a candidate never authorizes a foreign-project GET. */
export function vertexImportOperationCandidate(operation: unknown, scope: { project: string; location: string; corpusName: string }): {
  name: string;
  canonicalName: string;
  corpusAlias: string;
} | undefined {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return undefined;
  const name = (operation as Record<string, unknown>).name;
  const corpus = scope.corpusName.length <= 512
    ? /^projects\/([a-z0-9-]+)\/locations\/([a-z0-9-]+)\/ragCorpora\/([A-Za-z0-9_-]+)$/.exec(scope.corpusName) : null;
  const candidate = typeof name === 'string' && name.length <= 512
    ? /^projects\/([a-z0-9-]+)\/locations\/([a-z0-9-]+)\/ragCorpora\/([A-Za-z0-9_-]+)\/operations\/([A-Za-z0-9_-]+)$/.exec(name) : null;
  const permittedSpelling = (project: string) => project === scope.project || /^[1-9][0-9]*$/.test(project);
  if (!corpus || !candidate || !permittedSpelling(corpus[1]!) || !permittedSpelling(candidate[1]!)
    || corpus[2] !== scope.location || candidate[2] !== scope.location || candidate[3] !== corpus[3]) return undefined;
  return {
    name: name as string,
    canonicalName: `projects/${scope.project}/locations/${scope.location}/ragCorpora/${corpus[3]}/operations/${candidate[4]}`,
    corpusAlias: `projects/${candidate[1]}/locations/${scope.location}/ragCorpora/${corpus[3]}`,
  };
}
