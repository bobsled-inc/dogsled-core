import { escapeRegExp } from '../lib/regex.js';

const REDACTED = '[REDACTED]';

/**
 * Build a boundary redactor for values supplied programmatically by a caller.
 * Exact-value replacement is supplemented by common credential-bearing
 * message shapes for errors raised below the subprocess boundary.
 */
export function createPipelineRedactor(
  values: Iterable<string | undefined>
): (value: string) => string {
  const secrets = [
    ...new Set([...values].filter((value): value is string => Boolean(value && value.length > 0))),
  ].sort((left, right) => right.length - left.length);
  const exactPatterns = secrets.map((secret) => new RegExp(escapeRegExp(secret), 'g'));

  return (value: string): string => {
    let redacted = value;
    for (const pattern of exactPatterns) redacted = redacted.replace(pattern, REDACTED);
    return redacted
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
      .replace(
        /([A-Za-z0-9_.-]*(?:api[_ -]?key|private[_ -]?key|token|passphrase|password|secret))\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
        `$1$2${REDACTED}`
      )
      .replace(/([a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)[^@\s]+@/gi, `$1${REDACTED}@`);
  };
}
