export const HIGH_CONFIDENCE_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[opsu]_[A-Za-z0-9]{32,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
  // Telegram bot token: `<numeric bot id>:<secret>`, whose secret half always
  // begins "AA". Managed-bot provisioning writes these to token files, so the
  // shape needs a gate the moment one could be pasted into a tracked file.
  /\b\d{6,12}:AA[A-Za-z0-9_-]{30,}\b/,
];

export function containsHighConfidenceSecret(text: string): boolean {
  return HIGH_CONFIDENCE_SECRET_PATTERNS.some((pattern) => pattern.test(text));
}
