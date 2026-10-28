const SECRET_KEY_RE =
  /(?:api[_-]?key|authorization|bearer|client[_-]?secret|password|secret|token)/i;
const SECRET_VALUE_RE =
  /\b(?:Bearer\s+)?(?:sk|pk|pat|ghp|xox[baprs]?)[_-][A-Za-z0-9_-]{8,}\b|[A-Za-z0-9_-]{32,}/g;
const GENERIC_BEARER_RE = /\bBearer\s+[^\s"',;}\]]+/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

export function redactSensitiveValues(value: unknown): unknown {
  return redactSensitiveValuesInternal(value, new WeakSet<object>());
}

function redactSensitiveValuesInternal(value: unknown, visited: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    if (visited.has(value)) {
      return '[CIRCULAR]';
    }
    visited.add(value);
    return value.map((entry) => redactSensitiveValuesInternal(entry, visited));
  }

  if (value && typeof value === 'object') {
    if (visited.has(value)) {
      return '[CIRCULAR]';
    }
    visited.add(value);
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      redacted[key] = SECRET_KEY_RE.test(key)
        ? '[REDACTED]'
        : redactSensitiveValuesInternal(entry, visited);
    }
    return redacted;
  }

  return value;
}

export function redactErrorMessage(message: string): string {
  return redactString(message);
}

function redactString(value: string): string {
  return value
    .replace(EMAIL_RE, '[REDACTED_EMAIL]')
    .replace(GENERIC_BEARER_RE, 'Bearer [REDACTED]')
    .replace(SECRET_VALUE_RE, '[REDACTED]');
}
