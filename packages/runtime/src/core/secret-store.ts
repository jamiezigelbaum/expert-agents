export interface SecretStore {
  get(key: string): string | undefined | Promise<string | undefined>;
  set(key: string, value: string): void | Promise<void>;
}

class UnconfiguredSecretStore implements SecretStore {
  get(): never {
    throw new Error('No credential store adapter is configured. Inject a task-scoped SecretStore; raw credentials are never persisted by the runtime.');
  }

  set(): never {
    throw new Error('No credential store adapter is configured. Inject a task-scoped SecretStore; raw credentials are never persisted by the runtime.');
  }
}

export function createDefaultSecretStore(): SecretStore {
  return new UnconfiguredSecretStore();
}

export function isSafeSecretKey(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value);
}
