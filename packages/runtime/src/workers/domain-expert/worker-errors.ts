// The worker's typed error and the upstream-response size guard.


export class DomainExpertWorkerError extends Error {
  status: number;
  code: string;
  suggestion?: string;
  stderrTail?: string;
  googleErrorBody?: unknown;

  constructor(status: number, code: string, message: string, suggestion?: string) {
    super(message);
    this.status = status;
    this.code = code;
    if (suggestion !== undefined) this.suggestion = suggestion;
  }
}

export class UpstreamResponseSizeLimitError extends DomainExpertWorkerError {
  constructor(contentKind: 'JSON' | 'HTML', maxBytes: number) {
    super(
      502,
      'upstream_response_size_limit_exceeded',
      `Upstream ${contentKind} response exceeded the ${maxBytes} byte limit.`,
    );
    this.name = 'UpstreamResponseSizeLimitError';
  }
}

interface UpstreamResponseContext {
  signal: AbortSignal;
  timeoutError: () => DomainExpertWorkerError;
  sensitiveValues: string[];
}

export const upstreamResponseContexts = new WeakMap<Response, UpstreamResponseContext>();
