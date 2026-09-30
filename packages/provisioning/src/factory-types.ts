export interface FactoryConfig {
  enabled: boolean;
  /** Pre-created private directories, separate from the machinery and each other. */
  rootDir: string;
  tokenDirectory: string;
  managerTokenFile: string;
  ownerTelegramUserId: number;
  libraryBucket: string;
  libraryPrefix: string;
  openclawBin: string;
  /** A deployment-owned, no-argument activation wrapper; never supplied by a tool call. */
  activationCommand?: string;
  model?: string;
  /** Optional remote history wiring: an https://, ssh:// or file:// URL containing `{agentId}` exactly once. */
  remoteUrlTemplate?: string;
  /** Optional deployment-owned executable that creates the remote idempotently; invoked with the agent id and resolved URL only. */
  remoteCreateCommand?: string;
}

export interface FactoryRequest {
  action: 'create' | 'resume' | 'status';
  agent_id: string;
  apply?: boolean;
  display_name?: string;
  purpose?: string;
  telegram_username?: string;
  soul?: string;
}

export interface FactorySpec {
  agentId: string;
  displayName: string;
  purpose: string;
  telegramUsername: string;
  soul: string;
}

export interface FactoryState {
  schemaVersion: 1;
  spec: FactorySpec;
  configFingerprint: string;
  operationId: string;
  phase: string;
  scaffolded?: boolean;
  commit?: string;
  domainRegistered?: boolean;
  corpusReady?: boolean;
  botId?: number;
  tokenInstalled?: boolean;
  botUsername?: string;
  /** The requested username when the owner created the bot under a different name. */
  renamedFrom?: string;
  /** Highest manager update id seen before the confirmation link was issued. */
  updateWatermark?: number;
  deepLink?: string;
  gatewayConfigured?: boolean;
  activationAttempted?: boolean;
  remoteUrl?: string;
  remotePushed?: boolean;
}

/** Public output deliberately excludes purpose, soul, raw provider and CLI responses. */
export interface FactoryResult {
  kind: 'expert_factory';
  agent_id: string;
  status: string;
  repository_path?: string;
  commit?: string;
  repository_remote?: string;
  domain_id?: string;
  corpus_ready?: boolean;
  telegram_url?: string;
  telegram_username_changed_from?: string;
  confirmation_url?: string;
  next_action: string;
}
