import { sanitizeUrlForError } from '@bobsled-inc/extractor/core';

import { createPipelineRedactor } from '../../pipeline/redaction.js';

const MAX_PROVIDER_MESSAGE_CHARS = 300;
const MIN_REQUEST_CREDENTIAL_CHARS = 4;
/** Longer URL authorities, far beyond any host name, are replaced instead of parsed. */
const MAX_URL_AUTHORITY_CHARS = 1_024;
const URL_AUTHORITY_RE = /^https?:[\\/]*[^\\/?#]*/i;
const REDACTED = '[REDACTED]';
/** A closing bracket ends a URL in prose, unless it closes a redaction marker or an IPv6 host. */
const PROVIDER_URL_RE =
  /https?:\/\/[^\s"'<>)\]]+(?:(?<=\[(?:REDACTED|[\da-f:.]+))\][^\s"'<>)\]]*)*/gi;
const PERCENT_ESCAPE_RE = /%[0-9a-f]{2}/gi;
/** A percent escape holds at most this many characters on either side of a credential's edge. */
const ESCAPE_EDGE_CHARS = 2;
const AUTH_SCHEME_VALUE_RE = /^([A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*)\s+(\S.*)$/;
const BASE64_PAYLOAD_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const redactCredentialShapes = createPipelineRedactor([]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeProviderText(value: string): string {
  return value
    .replace(/\p{Cf}+/gu, '')
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim();
}

function compactCredentialText(value: string): string {
  return value.replace(/[\p{Cf}\p{Cc}\s]+/gu, '');
}

function secretRedactionVariants(value: string): string[] {
  const json = JSON.stringify(value).slice(1, -1);
  return [
    value,
    encodeURIComponent(value.replace(/\p{Cs}/gu, '\uFFFD')),
    new URLSearchParams({ value }).toString().slice('value='.length),
    json,
    json.replaceAll('/', '\\/'),
  ];
}

/** The text without ignored characters, and where each remaining character was. */
function compactWithOffsets(text: string): { compact: string; offsets: number[] } {
  const parts: string[] = [];
  const offsets: number[] = [];
  for (const { 0: part, index } of text.matchAll(/[^\p{Cf}\p{Cc}\s]+/gu)) {
    parts.push(part);
    for (let unit = 0; unit < part.length; unit += 1) offsets.push(index + unit);
  }
  return { compact: parts.join(''), offsets };
}

function foldPercentEscapes(value: string): string {
  return value.replace(PERCENT_ESCAPE_RE, (escape) => escape.toUpperCase());
}

interface CredentialMatcher {
  value: string;
  /** Positions of hex digits in the value's own percent escapes, which match in either case. */
  hexDigits: ReadonlySet<number>;
  /** The folded value without its edges. */
  core: string;
  /** For each core prefix, the length of its longest proper prefix that is also its suffix. */
  borders: Int32Array;
  /** Positions outside the core. */
  edges: number[];
}

function credentialMatcher(value: string): CredentialMatcher {
  const hexDigits = new Set<number>();
  for (const { index } of value.matchAll(PERCENT_ESCAPE_RE)) {
    hexDigits.add(index + 1).add(index + 2);
  }
  const core = foldPercentEscapes(value).slice(ESCAPE_EDGE_CHARS, -ESCAPE_EDGE_CHARS);
  const borders = new Int32Array(core.length);
  for (let index = 1, length = 0; index < core.length; index += 1) {
    while (length > 0 && core[index] !== core[length]) length = borders[length - 1]!;
    if (core[index] === core[length]) length += 1;
    borders[index] = length;
  }
  const edges = Array.from({ length: value.length }, (_, index) => index).filter(
    (index) => index < ESCAPE_EDGE_CHARS || index >= ESCAPE_EDGE_CHARS + core.length
  );
  return { value, hexDigits, core, borders, edges };
}

/**
 * Start of every occurrence, overlapping ones included, in one pass. Folding can differ from an
 * exact comparison only where an escape in the text crosses an edge of the credential, so the
 * edges are compared exactly.
 */
function credentialStarts(
  compact: string,
  folded: string,
  { value, hexDigits, core, borders, edges }: CredentialMatcher
): number[] {
  const starts: number[] = [];
  const addIfEdgesMatch = (start: number): void => {
    if (start < 0 || start + value.length > compact.length) return;
    const matches = edges.every((edge) => {
      const actual = compact[start + edge]!;
      const expected = value[edge]!;
      return (
        actual === expected ||
        (hexDigits.has(edge) && actual.toLowerCase() === expected.toLowerCase())
      );
    });
    if (matches) starts.push(start);
  };
  if (core.length === 0) {
    for (let start = 0; start + value.length <= compact.length; start += 1) addIfEdgesMatch(start);
    return starts;
  }
  for (let index = 0, length = 0; index < folded.length; index += 1) {
    while (length > 0 && folded[index] !== core[length]) length = borders[length - 1]!;
    if (folded[index] === core[length]) length += 1;
    if (length < core.length) continue;
    addIfEdgesMatch(index + 1 - core.length - ESCAPE_EDGE_CHARS);
    length = borders[length - 1]!;
  }
  return starts;
}

function credentialSpans(
  text: string,
  matchers: readonly CredentialMatcher[]
): Array<[number, number]> {
  if (matchers.length === 0) return [];
  const { compact, offsets } = compactWithOffsets(text);
  const folded = foldPercentEscapes(compact);
  return matchers
    .flatMap((matcher) =>
      credentialStarts(compact, folded, matcher).map((start): [number, number] => [
        offsets[start]!,
        offsets[start + matcher.value.length - 1]! + 1,
      ])
    )
    .sort((left, right) => left[0] - right[0]);
}

function redactSpans(text: string, spans: ReadonlyArray<readonly [number, number]>): string {
  let redacted = '';
  let cursor = 0;
  for (let index = 0; index < spans.length;) {
    const start = spans[index]![0];
    let end = spans[index]![1];
    for (index += 1; index < spans.length && spans[index]![0] <= end; index += 1) {
      end = Math.max(end, spans[index]![1]);
    }
    redacted += `${text.slice(cursor, start)}${REDACTED}`;
    cursor = end;
  }
  return redacted + text.slice(cursor);
}

function createCredentialRedactor(values: Iterable<string | undefined>): (value: string) => string {
  const variants = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const variant of secretRedactionVariants(value)) {
      const compact = compactCredentialText(variant);
      if (compact) variants.add(compact);
    }
  }
  const matchers = [...variants].map(credentialMatcher);
  return (value: string): string => redactSpans(value, credentialSpans(value, matchers));
}

/**
 * Build a redactor for provider text from the credential values an Action could
 * send. Each value matches in raw, URL-, form- and JSON-encoded forms, with
 * whitespace, control and formatting characters ignored inside a match. All
 * matches are found in the same text and replaced together, so replacing one
 * value cannot hide or assemble another. The work is linear in the text and in
 * the values.
 */
export function createActionSecretRedactor(
  values: Iterable<string | undefined>
): (value: string) => string {
  const redactCredentials = createCredentialRedactor(values);
  return (value: string): string => redactCredentialShapes(redactCredentials(value));
}

/**
 * Redact credential values from an error message raised while sending a request. Values
 * with fewer than four matched characters are kept, because they would match ordinary prose and
 * statuses.
 */
export function redactCredentialValues(message: string, values: Iterable<string>): string {
  const credentials = [...values].filter(
    (value) => compactCredentialText(value).length >= MIN_REQUEST_CREDENTIAL_CHARS
  );
  return createCredentialRedactor(credentials)(message);
}

function basicCredentialValues(payload: string): string[] {
  if (!BASE64_PAYLOAD_RE.test(payload)) return [];
  const decoded = Buffer.from(payload, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  return separator < 0 ? [] : [decoded, decoded.slice(separator + 1)];
}

/**
 * Expand values sent with a request into the forms a provider could reflect:
 * each value, its credential without an authentication scheme, and for Basic
 * the decoded `user:password` and password. Values shorter than four
 * characters are skipped; declared credentials are redacted separately.
 */
export function requestCredentialValues(values: Iterable<string>): string[] {
  const credentials = new Set<string>();
  const add = (value: string): void => {
    if (value.length >= MIN_REQUEST_CREDENTIAL_CHARS) credentials.add(value);
  };
  for (const value of values) {
    add(value);
    const match = AUTH_SCHEME_VALUE_RE.exec(value.trim());
    if (!match) continue;
    const credential = match[2]!.trim();
    add(credential);
    if (match[1]!.toLowerCase() !== 'basic') continue;
    for (const decoded of basicCredentialValues(credential)) add(decoded);
  }
  return [...credentials];
}

function sanitizeProviderUrls(value: string): string {
  return value.replace(PROVIDER_URL_RE, (url) =>
    URL_AUTHORITY_RE.exec(url)![0].length > MAX_URL_AUTHORITY_CHARS
      ? '[invalid-url]'
      : sanitizeUrlForError(url)
  );
}

/**
 * Normalize provider prose, sanitize URLs, then redact as the last content
 * change. URL parsing can rewrite a hostname, so text is redacted both before
 * and after it. The whole text is redacted, however long, and only the length cap
 * follows, so a cut can neither split a credential before it is redacted nor
 * reassemble a redacted one.
 */
function boundProviderMessage(
  value: string,
  redact: (value: string) => string
): string | undefined {
  const normalized = normalizeProviderText(value);
  if (!normalized) return undefined;
  const redacted = redact(sanitizeProviderUrls(redact(normalized)));
  const characters = Array.from(redacted);
  return characters.length > MAX_PROVIDER_MESSAGE_CHARS
    ? `${characters.slice(0, MAX_PROVIDER_MESSAGE_CHARS - 1).join('')}…`
    : redacted;
}

/**
 * Extract the error prose from a JSON provider error body. Only well-known
 * message fields are read; the raw body is never returned.
 */
export function providerMessageFromBody(
  body: string,
  redact: (value: string) => string
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const { error, errors } = parsed;
  const candidates = [
    isRecord(error) ? error['message'] : undefined,
    parsed['message'],
    error,
    parsed['detail'],
    Array.isArray(errors) && isRecord(errors[0]) ? errors[0]['message'] : undefined,
    parsed['error_description'],
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const message = boundProviderMessage(candidate, redact);
    if (message) return message;
  }
  return undefined;
}
