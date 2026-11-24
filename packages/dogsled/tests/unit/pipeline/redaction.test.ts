import { describe, expect, it } from 'vitest';

import { createPipelineRedactor } from '../../../src/pipeline/redaction.js';

/** The credential shapes as single patterns, as a reference for the output. */
function referenceRedact(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(
      /([A-Za-z0-9_.-]*(?:api[_ -]?key|private[_ -]?key|token|passphrase|password|secret))\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1$2[REDACTED]'
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)[^@\s]+@/gi, '$1[REDACTED]@');
}

/** Deterministic pseudo-random numbers, so a failure reproduces. */
function sequence(seed: number): (limit: number) => number {
  let state = seed;
  return (limit) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return Math.floor((state / 2 ** 32) * limit);
  };
}

describe('createPipelineRedactor', () => {
  const redact = createPipelineRedactor([]);

  it.each([
    ['Authorization: Bearer abc.def-123', 'Authorization: Bearer [REDACTED]'],
    ['my.client_secret = "two words" kept', 'my.client_secret = [REDACTED] kept'],
    ["x-api key: 'two words', kept", 'x-api key: [REDACTED], kept'],
    ['postgresql+ssl://user:p:w@host/db', 'postgresql+ssl://user:[REDACTED]@host/db'],
    ['a://b:c@d://e:f@g', 'a://b:[REDACTED]@d://e:[REDACTED]@g'],
    ['see https://example.com:8443/path', 'see https://example.com:8443/path'],
    ['tokenizer=kept token', 'tokenizer=kept token'],
  ])('redacts %j', (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('redacts exactly what the backtracking patterns redact', () => {
    const parts = [
      ...['token', 'api key', 'api_key', 'apikey', 'private-key', 'key', 'api', 'secret'],
      ...['password', 'passphrase', 'Bearer', 'Basic', 'a', 'x1', '1', '.', '-', '_', '+', ' '],
      ...['  ', '\n', '\t', ':', '=', '"', "'", ',', ';', '://', '/', '@', 'http', 'a://b:c@d'],
      ...['\u00e9', '\u017f', '\u212a', '%'],
    ];
    const next = sequence(20_261_123);
    let redactedInputs = 0;
    for (let round = 0; round < 20_000; round += 1) {
      const input = Array.from({ length: 1 + next(18) }, () => parts[next(parts.length)]!).join('');
      const expected = referenceRedact(input);
      if (expected !== input) redactedInputs += 1;
      expect(redact(input), JSON.stringify(input)).toBe(expected);
    }
    expect(redactedInputs).toBeGreaterThan(2_000);
  });

  it.each([
    ['one long word', 'a'.repeat(64 * 1024)],
    ['a word of credential names', 'token.'.repeat(12 * 1024)],
    ['URL prefixes without a password', 'a://b:'.repeat(32 * 1024)],
    ['a long scheme and a long user', `${'a'.repeat(32 * 1024)}://${'b'.repeat(32 * 1024)}`],
    ['a scheme without a letter', `${'1'.repeat(32 * 1024)}://b:${'c'.repeat(32 * 1024)}@`],
    ['unclosed quotes', `token='"`.repeat(8 * 1024)],
    ['an assignment without a value', `token${' '.repeat(32 * 1024)}:${' '.repeat(32 * 1024)}`],
  ])('bounds the work for %s in a long log line', { timeout: 120_000 }, (_label, text) => {
    const started = performance.now();
    redact(text);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
