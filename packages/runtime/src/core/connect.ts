export interface ConnectResult {
  ok: boolean;
  source: string;
  handles: string[];
  registryPath: string;
  secretRefs: string[];
  next: string;
  messages: string[];
}
