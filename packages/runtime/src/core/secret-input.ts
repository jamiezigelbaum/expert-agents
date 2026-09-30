import { OperationError } from './operation-error.ts';

/**
 * The three secret sources OpenClaw recognises, from `isSecretRef` in the
 * installed host's `src/config/types.secrets.ts`. A SecretRef there is a record
 * with exactly three keys — `source`, `provider`, `id` — where source is one of
 * these and provider and id are non-empty strings. Anything else is not a ref
 * to the host, so it must not be one here either.
 */
export const SECRET_REF_SOURCES = ['env', 'file', 'exec'] as const;

export type SecretRefSource = (typeof SECRET_REF_SOURCES)[number];

export interface SecretRef {
  source: SecretRefSource;
  provider: string;
  id: string;
}

export function isSecretRef(value: unknown): value is SecretRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  // Exactly three keys, matching the host's own narrowing: a record carrying
  // extra keys is a different shape, not a ref with decoration.
  if (Object.keys(record).length !== 3) return false;
  return (
    SECRET_REF_SOURCES.includes(record.source as SecretRefSource) &&
    isNonEmptyString(record.provider) &&
    isNonEmptyString(record.id)
  );
}

/**
 * The host's `source:provider:id` label. Every part of it is a pointer the
 * operator wrote into gateway config — a provider alias and a lookup id — never
 * the credential behind it, which is what makes it safe to name in an error an
 * operator has to read.
 */
export function formatSecretRefLabel(ref: SecretRef): string {
  return `${ref.source}:${ref.provider}:${ref.id}`;
}

/**
 * Read one secret-shaped config field into a literal credential.
 *
 * OpenClaw resolves SecretRefs in plugin config only at the paths a plugin
 * declares in `configContracts.secretInputs`, and only while that plugin is
 * enabled; every other path is handed through verbatim. So a ref object
 * reaching this function means resolution did not run, and the only safe
 * answers are a literal string or a refusal. Returning `undefined` for a ref
 * would be the worst of the three: the request would go out unauthenticated
 * and fail at the worker with nothing pointing back at the real cause.
 *
 * No branch here puts `value` in its message. A literal credential is never
 * echoed, and the ref branch names the pointer instead.
 */
export function readSecretInput(
  value: unknown,
  diagnosticPath: string,
  contractPath: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  if (isSecretRef(value)) {
    throw new OperationError(
      'domain_expert_unresolved_secret_ref',
      `${diagnosticPath} is still an unresolved SecretRef (${formatSecretRefLabel(value)}).`,
      `Declare ${contractPath} under this plugin's configContracts.secretInputs so the gateway resolves it, confirm the plugin is enabled, and confirm the named secret provider resolves on this gateway. Full gateway path: ${diagnosticPath}.`,
    );
  }
  throw new OperationError(
    'domain_expert_unresolved_secret_ref',
    `${diagnosticPath} must be a literal string or a { source, provider, id } SecretRef; received ${describeType(value)}.`,
    'Set a literal credential or a SecretRef the gateway can resolve.',
  );
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Names the shape of a rejected value without ever quoting the value itself. */
function describeType(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  const type = typeof value;
  return type === 'object' ? 'an object' : `a ${type}`;
}
