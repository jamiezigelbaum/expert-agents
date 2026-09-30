import { describe, expect, test } from 'bun:test';
import { OperationError } from '../src/core/operation-error.ts';
import { formatSecretRefLabel, isSecretRef, readSecretInput } from '../src/core/secret-input.ts';

const PATH = 'plugins.entries.expert-agents.config.domainExpert.authToken';
const CONTRACT_PATH = 'domainExpert.authToken';

describe('SecretRef narrowing, mirroring the host contract', () => {
  test('recognises exactly the canonical three-key shape', () => {
    for (const source of ['env', 'file', 'exec'] as const) {
      expect(isSecretRef({ source, provider: 'op_domain_expert', id: 'worker-bearer' })).toBe(true);
    }
  });

  test('rejects everything the host would not narrow to a ref', () => {
    const rejected: unknown[] = [
      // The host's isSecretRef counts keys, so a decorated ref is a different
      // shape, not a ref with extras.
      { source: 'exec', provider: 'op_domain_expert', id: 'worker-bearer', fallback: 'literal' },
      // The host's legacy provider-less form is coerced during config
      // migration, never handed to a plugin as-is.
      { source: 'exec', id: 'worker-bearer' },
      { source: 'vault', provider: 'op_domain_expert', id: 'worker-bearer' },
      { source: 'exec', provider: '   ', id: 'worker-bearer' },
      { source: 'exec', provider: 'op_domain_expert', id: '' },
      'fixture-worker-token',
      ['exec', 'op_domain_expert', 'worker-bearer'],
      null,
      undefined,
    ];
    for (const value of rejected) expect(isSecretRef(value)).toBe(false);
  });

  test('labels a ref by its pointer, in the host format', () => {
    expect(formatSecretRefLabel({ source: 'exec', provider: 'op_domain_expert', id: 'domain-expert/worker-bearer' }))
      .toBe('exec:op_domain_expert:domain-expert/worker-bearer');
  });
});

describe('reading a configured secret input', () => {
  test('a literal credential comes back trimmed', () => {
    expect(readSecretInput('  fixture-worker-token  ', PATH, CONTRACT_PATH)).toBe('fixture-worker-token');
  });

  test('an absent or blank credential reads as unset rather than failing', () => {
    expect(readSecretInput(undefined, PATH, CONTRACT_PATH)).toBeUndefined();
    expect(readSecretInput(null, PATH, CONTRACT_PATH)).toBeUndefined();
    expect(readSecretInput('   ', PATH, CONTRACT_PATH)).toBeUndefined();
  });

  test('an unresolved ref refuses, naming the path and the pointer', () => {
    let caught: unknown;
    try {
      readSecretInput(
        { source: 'exec', provider: 'op_domain_expert', id: 'domain-expert/worker-bearer' },
        PATH,
        CONTRACT_PATH,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OperationError);
    const error = caught as OperationError;
    expect(error.code).toBe('domain_expert_unresolved_secret_ref');
    expect(error.message).toContain(PATH);
    expect(error.message).toContain('exec:op_domain_expert:domain-expert/worker-bearer');
    expect(error.remediation).toContain(`Declare ${CONTRACT_PATH} under this plugin's configContracts.secretInputs`);
    expect(error.remediation).toContain(`Full gateway path: ${PATH}`);
    expect(error.remediation).not.toContain(`Declare ${PATH}`);
  });

  test('a non-string, non-ref credential refuses without echoing the value', () => {
    // Config that reached the plugin without host validation, or a shape the
    // schema does not describe. Reading it as "unset" would drop auth silently;
    // coercing it would put a stringified object in an Authorization header.
    let caught: unknown;
    try {
      readSecretInput({ token: 'fixture-worker-token' }, PATH, CONTRACT_PATH);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OperationError);
    const error = caught as OperationError;
    expect(error.code).toBe('domain_expert_unresolved_secret_ref');
    expect(error.message).toContain('an object');
    expect(error.message).not.toContain('fixture-worker-token');
    expect(error.message).not.toContain('[object Object]');
  });
});
