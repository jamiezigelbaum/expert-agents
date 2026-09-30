export class OperationError extends Error {
  readonly code: string;
  readonly remediation?: string;
  readonly suggestion?: string;

  constructor(code: string, message: string, remediation?: string) {
    super(message);
    this.name = 'OperationError';
    this.code = code;
    this.remediation = remediation;
    this.suggestion = remediation;
  }
}
