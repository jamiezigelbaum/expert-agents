export interface DomainExpertClientConfig {
  enabled: boolean;
  baseUrl: string;
  requestTimeoutSeconds: number;
  authToken?: string;
  defaultDomainId?: string;
}

export interface ExpertAgentsConfig {
  domainExpert: DomainExpertClientConfig;
}
