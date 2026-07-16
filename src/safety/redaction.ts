const REDACTED = "[REDACTED]";

const SECRET_NAME = String.raw`(?:api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret|password|passwd|secret|token)`;

const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [/(\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss):\/\/)[^\s/@:]+(?::[^\s/@]*)?@/giu, `$1${REDACTED}@`],
  [/(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/giu, `$1${REDACTED}@`],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/giu, `$1${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, REDACTED],
  [/\b(?:napi|sbp)_[A-Za-z0-9_-]{12,}\b/gu, REDACTED],
  [new RegExp(`(\\b${SECRET_NAME}\\b\\s*=\\s*)([^\\s'\"]+|\"[^\"]*\"|'[^']*')`, "giu"), `$1${REDACTED}`],
  [new RegExp(`(\"${SECRET_NAME}\"\\s*:\\s*)\"[^\"]*\"`, "giu"), `$1\"${REDACTED}\"`],
];

export function redactSensitiveText(value: string): string {
  return REDACTION_PATTERNS.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement),
    value,
  );
}
