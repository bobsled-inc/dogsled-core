import { sanitizeUrlForError } from '@bobsled-inc/extractor/core';

import { createPipelineRedactor } from '../../pipeline/redaction.js';
import { escapeRegExp } from '../regex.js';

const MAX_PROVIDER_MESSAGE_CHARS = 300;
const MIN_REQUEST_CREDENTIAL_CHARS = 4;
const REDACTED = '[REDACTED]';
const CREDENTIAL_GAP_PATTERN = '[\\s\\p{Cc}\\p{Cf}]*';
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

function credentialPattern(compactVariant: string): RegExp {
  const characters = [...compactVariant.matchAll(/%[0-9a-f]{2}|./giu)].flatMap(([part]) =>
    Array.from(part, (character) =>
      part.length === 3 && /[a-f]/i.test(character)
        ? `[${character.toLowerCase()}${character.toUpperCase()}]`
        : escapeRegExp(character)
    )
  );
  return new RegExp(characters.join(CREDENTIAL_GAP_PATTERN), 'gu');
}

function credentialSpans(text: string, patterns: readonly RegExp[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      spans.push([match.index, match.index + match[0].length]);
      pattern.lastIndex = match.index + (text.codePointAt(match.index)! > 0xffff ? 2 : 1);
    }
  }
  return spans.sort((left, right) => left[0] - right[0]);
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

/**
 * Build a redactor for provider text from the credential values an Action could
 * send. Each value matches in raw, URL-, form- and JSON-encoded forms, with
 * whitespace, control and formatting characters ignored inside a match. All
 * matches are found in the same text and replaced together, so replacing one
 * value cannot hide or assemble another.
 */
export function createActionSecretRedactor(
  values: Iterable<string | undefined>
): (value: string) => string {
  const variants = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const variant of secretRedactionVariants(value)) {
      const compact = compactCredentialText(variant);
      if (compact) variants.add(compact);
    }
  }
  const patterns = [...variants].map(credentialPattern);
  return (value: string): string =>
    redactCredentialShapes(redactSpans(value, credentialSpans(value, patterns)));
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
  return value.replace(/https?:\/\/[^\s"'<>)\]]+/gi, (url) => sanitizeUrlForError(url));
}

/**
 * Normalize provider prose, sanitize URLs, then redact as the last content
 * change. URL parsing can rewrite a hostname, so text is redacted both before
 * and after it. Only the length cap follows, and truncating to a prefix cannot
 * reassemble a redacted value.
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
