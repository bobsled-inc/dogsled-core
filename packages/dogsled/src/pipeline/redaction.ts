import { escapeRegExp } from '../lib/regex.js';

const REDACTED = '[REDACTED]';
const AUTH_SCHEME_VALUE_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
/**
 * The match starts at the keyword, not at the word that contains it: the text before the
 * keyword is kept either way.
 */
const CREDENTIAL_ASSIGNMENT_RE =
  /(api[_ -]?key|private[_ -]?key|token|passphrase|password|secret)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi;
/** The scheme is checked backward from `://`, so each word is scanned for it once. */
const URL_PASSWORD_RE = /(:\/\/(?<=[a-z][a-z0-9+.-]*:\/\/)[^:/\s]+:)[^@\s]+@/gi;

/** Only text before a word's last `@` can match, so no match attempt scans past it and fails. */
function redactUrlPasswords(value: string): string {
  return value.replace(/\S+/g, (word) => {
    const end = word.lastIndexOf('@') + 1;
    return end === 0
      ? word
      : word.slice(0, end).replace(URL_PASSWORD_RE, `$1${REDACTED}@`) + word.slice(end);
  });
}

/**
 * Build a boundary redactor for values supplied programmatically by a caller.
 * Exact-value replacement is supplemented by common credential-bearing
 * message shapes for errors raised below the subprocess boundary. Every pass is
 * linear in the text, so the whole text is redacted and never cut first.
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
    return redactUrlPasswords(
      redacted
        .replace(AUTH_SCHEME_VALUE_RE, `$1 ${REDACTED}`)
        .replace(CREDENTIAL_ASSIGNMENT_RE, `$1$2${REDACTED}`)
    );
  };
}
