import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DogsledRuntimeError, type DogsledRuntimeErrorOptions } from '@bobsled-inc/protocol';
import { describe, expect, it } from 'vitest';

import {
  createActionSecretRedactor,
  providerMessageFromBody,
  redactCredentialValues,
  requestCredentialValues,
} from '../../../src/lib/transports/provider-message.js';
import {
  classifyTransportError,
  mapStatusToError,
  safeTransportErrorMessage,
  toActionResultError,
} from '../../../src/lib/transports/shared.js';

const API_STATUS_PATTERN = /API request failed: (\d{3})/;

function runtimeError(
  options: Pick<DogsledRuntimeErrorOptions, 'kind'> & Partial<DogsledRuntimeErrorOptions>
): DogsledRuntimeError {
  return new DogsledRuntimeError({
    code: 'EXTRACTOR_HTTP_STATUS_FAILURE',
    operation: 'extractor.http.request',
    retryable: false,
    ...options,
  });
}

function bundledRuntimeError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error('The provider could not complete the operation.'), {
    name: 'DogsledRuntimeError',
    ...fields,
  });
}

describe('classifyTransportError', () => {
  it('classifies abort errors as timeouts', () => {
    const result = classifyTransportError(
      Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
    );

    expect(result).toMatchObject({
      code: 'timeout',
      retryable: true,
    });
  });

  it('classifies nested Node network error codes without substring matching', () => {
    const result = classifyTransportError(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        }),
      })
    );

    expect(result).toMatchObject({
      code: 'network_error',
      retryable: true,
    });
  });

  it('does not misclassify arbitrary messages that happen to contain network-like words', () => {
    const result = classifyTransportError(
      new Error('Missing mapped.request_timeout referenced in webhook.url')
    );

    expect(result).toMatchObject({
      code: 'unknown',
      retryable: false,
    });
  });

  it.each([
    [400, 'validation_error', false],
    [401, 'auth_error', false],
    [403, 'permission_denied', false],
    [404, 'not_found', false],
    [409, 'conflict', false],
    [422, 'validation_error', false],
    [429, 'rate_limited', true],
    [500, 'server_error', true],
    [503, 'server_error', true],
    [418, 'unknown', false],
  ] as const)('maps a runtime provider status %i to %s', (providerStatus, code, retryable) => {
    const error = runtimeError({
      kind: 'provider',
      providerStatus,
      cause: Object.assign(new Error(`API request failed: ${providerStatus} - [url]`), {
        status: providerStatus,
      }),
    });

    expect(classifyTransportError(error, API_STATUS_PATTERN)).toEqual({
      code,
      message: 'The provider could not complete the operation.',
      retryable,
      providerStatus,
    });
  });

  it('keeps a runtime auth failure without a status an auth error', () => {
    expect(classifyTransportError(runtimeError({ kind: 'auth' }))).toEqual({
      code: 'auth_error',
      message: 'Dogsled could not authenticate with the provider.',
      retryable: false,
    });
  });

  it('finds a runtime failure anywhere in the cause chain', () => {
    const error = new Error('Action failed', {
      cause: new Error('Wrapped', {
        cause: runtimeError({ kind: 'provider', providerStatus: 404 }),
      }),
    });

    expect(classifyTransportError(error)).toMatchObject({
      code: 'not_found',
      message: 'Action failed',
      retryable: false,
    });
  });

  it('recognizes a runtime failure by its contract fields when the class is a bundled copy', () => {
    const error = new Error('Action failed', {
      cause: bundledRuntimeError({ kind: 'provider', providerStatus: 429, retryable: false }),
    });

    expect(classifyTransportError(error)).toMatchObject({ code: 'rate_limited', retryable: true });
  });

  it('lets the provider status decide over the runtime failure kind', () => {
    expect(
      classifyTransportError(runtimeError({ kind: 'validation', providerStatus: 409 }))
    ).toMatchObject({ code: 'conflict', retryable: false });
  });

  it.each([
    ['auth', 'auth_error', false],
    ['timeout', 'timeout', true],
    ['cancellation', 'cancelled', false],
  ] as const)('maps a runtime %s failure without a status to %s', (kind, code, retryable) => {
    expect(classifyTransportError(runtimeError({ kind }))).toMatchObject({ code, retryable });
  });

  it('classifies a runtime cancellation caused by a deadline as a timeout', () => {
    const error = runtimeError({
      kind: 'cancellation',
      cause: new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    });

    expect(classifyTransportError(error)).toMatchObject({ code: 'timeout', retryable: true });
  });

  it('falls back to native network codes for a runtime provider failure without a status', () => {
    const error = runtimeError({
      kind: 'provider',
      retryable: true,
      cause: Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      }),
    });

    expect(classifyTransportError(error)).toMatchObject({
      code: 'network_error',
      retryable: true,
    });
  });

  it.each(['validation', 'internal'] as const)(
    'keeps a runtime %s failure without a status unknown',
    (kind) => {
      expect(classifyTransportError(runtimeError({ kind }), API_STATUS_PATTERN)).toMatchObject({
        code: 'unknown',
        retryable: false,
      });
    }
  );

  it.each([
    ['the retired error name', { name: 'TrackRuntimeError', kind: 'auth', providerStatus: 401 }],
    ['an unknown kind', { kind: 'billing', providerStatus: 404 }],
    ['an out-of-range status', { kind: 'internal', providerStatus: 1404 }],
    ['a non-integer status', { kind: 'internal', providerStatus: '404' }],
  ])('ignores a runtime-shaped error with %s', (_label, fields) => {
    expect(classifyTransportError(bundledRuntimeError(fields))).toMatchObject({
      code: 'unknown',
      retryable: false,
    });
  });

  it('keeps classifying legacy status messages', () => {
    expect(
      classifyTransportError(
        new Error('API request failed: 429 Too Many Requests - [url]'),
        API_STATUS_PATTERN
      )
    ).toMatchObject({ code: 'rate_limited', retryable: true, providerStatus: 429 });
  });

  it('classifies a legacy 403 status message as permission denied', () => {
    expect(
      classifyTransportError(
        new Error('API request failed: 403 Forbidden - [url]'),
        API_STATUS_PATTERN
      )
    ).toMatchObject({ code: 'permission_denied', retryable: false, providerStatus: 403 });
  });
});

describe('mapStatusToError', () => {
  it('separates rejected credentials from a refused Action', () => {
    expect(mapStatusToError(401)).toEqual({ code: 'auth_error', retryable: false });
    expect(mapStatusToError(403)).toEqual({ code: 'permission_denied', retryable: false });
    expect(safeTransportErrorMessage('permission_denied')).toBe(
      'The external service refused the Action.'
    );
  });
});

describe('providerMessageFromBody', () => {
  const noRedaction = (value: string): string => value;

  it.each([
    ['error.message', { error: { code: 'Busy', message: 'From error.message' }, message: 'x' }],
    ['message', { message: 'From message', error: 'x', detail: 'x' }],
    ['error string', { error: 'From error', detail: 'x' }],
    ['detail', { detail: 'From detail', errors: [{ message: 'x' }] }],
    ['errors[0].message', { errors: [{ message: 'From errors' }], error_description: 'x' }],
    ['error_description', { error: { code: 'invalid' }, error_description: 'From description' }],
  ])('reads %s first', (_field, body) => {
    expect(providerMessageFromBody(JSON.stringify(body), noRedaction)).toMatch(/^From /);
  });

  it.each([
    ['HTML', '<html><body>Forbidden</body></html>'],
    ['plain text', 'Forbidden'],
    ['a JSON string', JSON.stringify('Forbidden')],
    ['a JSON array', JSON.stringify([{ message: 'Forbidden' }])],
    ['non-string fields', JSON.stringify({ message: 42, detail: [{ msg: 'x' }], error: {} })],
    ['blank prose', JSON.stringify({ message: ' \n\t ' })],
    ['an unknown field', JSON.stringify({ reason: 'Forbidden' })],
  ])('returns nothing for %s', (_label, body) => {
    expect(providerMessageFromBody(body, noRedaction)).toBeUndefined();
  });

  it('collapses whitespace and strips control and formatting characters', () => {
    const body = JSON.stringify({
      message: '  Pause\n\tthe\u0000 automation\u202e  first.\u0007 ',
    });

    expect(providerMessageFromBody(body, noRedaction)).toBe('Pause the automation first.');
  });

  it('caps the message at 300 characters', () => {
    const message = providerMessageFromBody(
      JSON.stringify({ message: `Refused ${'because '.repeat(100)}` }),
      noRedaction
    );

    expect(Array.from(message!)).toHaveLength(300);
    expect(message!.endsWith('…')).toBe(true);
  });

  it('redacts declared values, their encoded forms, credentials, and URL queries', () => {
    const secret = 'p@ss  word/1"x\ty';
    const redact = createActionSecretRedactor([secret]);
    const body = JSON.stringify({
      error: {
        message: [
          `raw ${secret}`,
          `url ${encodeURIComponent(secret)}`,
          `form ${new URLSearchParams({ q: secret }).toString().slice(2)}`,
          `json ${JSON.stringify(secret)}`,
          'Bearer abc.def-123',
          'https://files.example.com/export.csv?sig=signed-value',
        ].join(' | '),
      },
    });

    const message = providerMessageFromBody(body, redact)!;

    expect(message).toBe(
      'raw [REDACTED] | url [REDACTED] | form [REDACTED] | json "[REDACTED]" | ' +
        'Bearer [REDACTED] | https://files.example.com/export.csv?[redacted]'
    );
  });

  it.each([
    ['a formatting character', 'split-secret\u200b-value'],
    ['a line break', 'split-secret-\r\nvalue'],
    ['a control character', 'split-secret\u0000-value'],
  ])('redacts a credential split by %s', (_label, echoed) => {
    const message = providerMessageFromBody(
      JSON.stringify({ message: `Refused ${echoed}.` }),
      createActionSecretRedactor(['split-secret-value'])
    );

    expect(message).toBe('Refused [REDACTED].');
  });

  it('redacts a multi-line credential after its whitespace is collapsed', () => {
    const secret = 'line-one\nline-two';
    const message = providerMessageFromBody(
      JSON.stringify({ message: 'Refused line-one\r\n\tline-two.' }),
      createActionSecretRedactor([secret])
    );

    expect(message).toBe('Refused [REDACTED].');
  });

  it('redacts a credential that URL sanitizing rewrites into its plain form', () => {
    const message = providerMessageFromBody(
      JSON.stringify({
        message:
          'See https://SIGNED-HOST-VALUE.example.com/a?x=1 or https://%73igned-host-value.example.com/b',
      }),
      createActionSecretRedactor(['signed-host-value'])
    );

    expect(message).toBe(
      'See https://[REDACTED].example.com/a?[redacted] or https://[REDACTED].example.com/b'
    );
  });

  it('redacts overlapping credentials as one span', () => {
    const message = providerMessageFromBody(
      JSON.stringify({ message: 'Refused overlap-left-part-right now.' }),
      createActionSecretRedactor(['overlap-left-part', 'left-part-right'])
    );

    expect(message).toBe('Refused [REDACTED] now.');
  });

  it('redacts every occurrence of a credential that starts with an astral character', () => {
    const message = providerMessageFromBody(
      JSON.stringify({ message: 'a \u{1F511}astral-key \u{1F511}astral-key b' }),
      createActionSecretRedactor(['\u{1F511}astral-key'])
    );

    expect(message).toBe('a [REDACTED] [REDACTED] b');
  });

  it('redacts a credential that contains an unpaired surrogate', () => {
    const message = providerMessageFromBody(
      JSON.stringify({ message: 'a broken\ud800-value b' }),
      createActionSecretRedactor(['broken\ud800-value'])
    );

    expect(message).toBe('a [REDACTED] b');
  });

  it('redacts lowercase percent-encoded and slash-escaped JSON forms', () => {
    const secret = 'enc/oded+value';
    const message = providerMessageFromBody(
      JSON.stringify({ message: 'a enc%2foded%2bvalue b enc\\/oded+value c' }),
      createActionSecretRedactor([secret])
    );

    expect(message).toBe('a [REDACTED] b [REDACTED] c');
  });

  it('matches mixed-case percent escapes while preserving literal character case', () => {
    const secret = 'Case/ÿ+Token';
    const message = providerMessageFromBody(
      JSON.stringify({
        message: 'Refused Case%2f%c3%bF%2BToken but case%2f%c3%bF%2BToken is different.',
      }),
      createActionSecretRedactor([secret])
    );

    expect(message).toBe('Refused [REDACTED] but case%2f%c3%bF%2BToken is different.');
  });

  it('redacts before capping so a secret that crosses the cap leaves no prefix', () => {
    const secret = 'cap-boundary-secret-value';
    const message = providerMessageFromBody(
      JSON.stringify({ message: `${'x'.repeat(290)} ${secret}` }),
      createActionSecretRedactor([secret])
    )!;

    expect(message).not.toContain('cap-boundary');
    expect(message).toContain('[REDACTED]'.slice(0, 5));
  });
});

describe('providerMessageFromBody with long bodies', () => {
  const bodyBytes = 64 * 1024;
  const fill = (unit: string, length = bodyBytes) =>
    unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
  const message = (text: string, secrets: string[] = ['declared-secret-value']) =>
    providerMessageFromBody(
      JSON.stringify({ message: text }),
      createActionSecretRedactor(secrets)
    ) ?? '';

  // Redaction time must stay proportional to the text. These take
  // milliseconds, and the bound leaves room for a busy CI runner.
  it.each([
    ['one long word', fill('a')],
    ['a word of credential names', fill('token.')],
    ['a word of punctuation', fill('-')],
    ['URL prefixes without a password', fill('a://b:')],
    ['URL prefixes before an at sign', `${fill('a://b:')}@`],
    ['a long scheme and a long user', `${fill('a', 32_000)}://${fill('b', 32_000)}`],
    ['a long scheme, user and password', `${fill('a', 30_000)}://b:${fill('c', 30_000)}@d`],
    [
      'one long international host',
      `https://${Array.from({ length: 20_000 }, (_, index) => String.fromCodePoint(0x4e00 + index)).join('')}`,
    ],
  ])('bounds the work for %s', { timeout: 120_000 }, (_label, text) => {
    const started = performance.now();
    const result = message(text);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(result.length).toBeLessThanOrEqual(300);
  });

  it.each([1, 10, 150, 285, 290, 295, 298, 299, 300, 301, 4_000, 4_096, 8_192, 65_000])(
    'leaves no part of a declared credential that starts at character %i',
    (offset) => {
      const secret = 'Zq7Wk2Xv9Rt4Hn6Bm1Yp';
      const result = message(`${fill('. ', offset)}${secret} after`, [secret]);

      for (let start = 0; start + 4 <= secret.length; start += 1) {
        expect(result).not.toContain(secret.slice(start, start + 4));
      }
    }
  );

  const longSecret = (length: number) => fill('Zq7Wk2Xv9', length);

  it.each([301, 1_500])('redacts a declared credential of %i characters', (length) => {
    const result = message(`Refused ${longSecret(length)} now`, [longSecret(length)]);
    expect(result).toBe('Refused [REDACTED] now');
  });

  it.each([
    ['Bearer ', '', 301],
    ['Basic ', '', 4_097],
    ['api_key=', '', 20_000],
    ['client_secret: "', '"', 60_000],
    ['postgres://user:', '@db.example.com/main', 60_000],
  ])('redacts an undeclared long credential after "%s"', (prefix, suffix, length) => {
    const result = message(`Refused ${prefix}${longSecret(length)}${suffix} now`);
    expect(result).not.toContain('Zq7W');
    expect(result).toMatch(/^Refused .*\[REDACTED\].* now$/);
  });

  it.each(['Bearer ', 'api_key=', 'Password: ', 'https://user:', 'redis://user:'])(
    'redacts an undeclared credential after "%s" that straddles the cap',
    (prefix) => {
      for (let offset = 260; offset <= 300; offset += 1) {
        const result = message(`${fill('x', offset - 1)} ${prefix}Zq7Wk2Xv9Rt4@host tail`);
        expect(result).not.toMatch(/Zq7|Wk2|Xv9|Rt4/);
      }
    }
  );
});

describe('provider message URLs', () => {
  const login = (password: string) => `user:${password}@`;

  it.each([
    [`https://${login('declared-value')}example.com/a?b=c`, 'https://example.com/a?[redacted]'],
    [`https://${login('other')}example.com/a?b=c`, 'https://example.com/a?[redacted]'],
    ['https://declared-value.example.com/a?b=c', '[invalid-url]'],
    ['https://example.com/declared-value/a?b=c', 'https://example.com/[REDACTED]/a?[redacted]'],
    [`https://${login('other')}[::1]:8443/a?b=c`, 'https://[::1]:8443/a?[redacted]'],
    ['[https://example.com/a?b=c]', '[https://example.com/a?[redacted]]'],
    ['(https://example.com/a?b=c)', '(https://example.com/a?[redacted])'],
  ])('keeps no login or query from %s', (url, expected) => {
    expect(
      providerMessageFromBody(
        JSON.stringify({ message: `see ${url} now` }),
        createActionSecretRedactor(['declared-value'])
      )
    ).toBe(`see ${expected} now`);
  });

  it('sanitizes international and encoded hosts in a separate process', { timeout: 60_000 }, () => {
    const script = `
      import { createActionSecretRedactor, providerMessageFromBody } from ${JSON.stringify(
        new URL('../../../src/lib/transports/provider-message.ts', import.meta.url).href
      )};
      const parts = ['xn--', '\\u00e9', 'x', '-', '%C3%A9', '.', '\\u00ad', '\\u4e2d', '1'];
      const redact = createActionSecretRedactor(['declared-value']);
      const leaks = [];
      let count = 0;
      for (const a of parts) for (const b of parts) for (const c of parts) for (const d of parts) {
        const url = 'https://userpart:passpart@' + a + b + c + d + '/path?key=querypart';
        const message = providerMessageFromBody(JSON.stringify({ message: 'see ' + url }), redact);
        if (/userpart|passpart|querypart/.test(message)) leaks.push(url);
        count += 1;
      }
      process.stdout.write(JSON.stringify({ count, leaks }));
    `;
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx/esm', '--input-type=module', '--eval', script],
      {
        cwd: fileURLToPath(new URL('../../..', import.meta.url)),
        encoding: 'utf8',
        timeout: 50_000,
      }
    );
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr.slice(0, 500)).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ count: 6_561, leaks: [] });
  });
});

describe('createActionSecretRedactor matching', () => {
  const IGNORED = '[\\s\\p{Cc}\\p{Cf}]*';

  /** One pattern per credential form: correct, but only usable for short credentials. */
  function referencePattern(credential: string): RegExp {
    const characters = [...credential.matchAll(/%[0-9a-f]{2}|./giu)].flatMap(([part]) =>
      Array.from(part, (character) =>
        part.length === 3 && /[a-f]/i.test(character)
          ? `[${character.toLowerCase()}${character.toUpperCase()}]`
          : character.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
      )
    );
    return new RegExp(characters.join(IGNORED), 'gu');
  }

  function referenceRedact(text: string, credential: string): string {
    const json = JSON.stringify(credential).slice(1, -1);
    const forms = [
      credential,
      encodeURIComponent(credential),
      new URLSearchParams({ q: credential }).toString().slice(2),
      json,
      json.replaceAll('/', '\\/'),
    ].map((form) => form.replace(/[\p{Cf}\p{Cc}\s]+/gu, ''));
    const covered = new Array<boolean>(text.length + 1).fill(false);
    for (const pattern of new Set(forms.filter(Boolean).map(referencePattern))) {
      for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        covered.fill(true, match.index, match.index + match[0].length);
        pattern.lastIndex = match.index + (text.codePointAt(match.index)! > 0xffff ? 2 : 1);
      }
    }
    return Array.from({ length: text.length }, (_, index) => {
      if (!covered[index]) return text[index]!;
      return covered[index - 1] ? '' : '[REDACTED]';
    }).join('');
  }

  it('redacts exactly what one pattern per credential form redacts', { timeout: 60_000 }, () => {
    const alphabets = [
      ['a', 'b'],
      ['a', 'f', 'F', 'c', 'C', '2', '%', '%2f', '%2F', '%cf', '%CF'],
      ['a', '/', '+', '"', '\\', '\u00e9', ' ', '\u200b', '\n'],
      ['x', '\u{1F511}', '\u00ad', '%f0%9f%94%91', '\u{e0001}'],
      ['A', 'a', '.', '*', '(', '[', '$', '^', '|', '?', '-'],
    ];
    let state = 20_261_123;
    const next = (limit: number): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return Math.floor((state / 2 ** 32) * limit);
    };
    let redactedInputs = 0;
    for (let round = 0; round < 400; round += 1) {
      const alphabet = alphabets[next(alphabets.length)]!;
      const word = (length: number) =>
        Array.from({ length: 1 + next(length) }, () => alphabet[next(alphabet.length)]!).join('');
      const credential = word(8);
      const forms = [
        credential,
        encodeURIComponent(credential),
        encodeURIComponent(credential).replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()),
        Array.from(credential).join('\u200b'),
        JSON.stringify(credential).slice(1, -1),
      ];
      const text = Array.from({ length: 1 + next(4) }, () =>
        next(2) === 0 ? forms[next(forms.length)]! : word(6)
      ).join('');
      const expected = referenceRedact(text, credential);
      if (expected !== text) redactedInputs += 1;
      expect(
        createActionSecretRedactor([credential])(text),
        JSON.stringify({ credential, text })
      ).toBe(expected);
    }
    expect(redactedInputs).toBeGreaterThan(200);
  });

  it.each([
    ['abXXYYzz', '%abXXYYzz', '%[REDACTED]'],
    ['bXXYYzz', '%abXXYYzz', '%a[REDACTED]'],
    ['XXYYzz%a', 'XXYYzz%ab', '[REDACTED]b'],
    ['XXYYzz%', 'XXYYzz%ab', '[REDACTED]ab'],
  ])('redacts %s where an escape in %s crosses its edge', (credential, text, expected) => {
    expect(createActionSecretRedactor([credential])(text)).toBe(expected);
  });

  it.each([1_000, 4_000, 8_000, 32_000])(
    'redacts overlapping credentials that cover %i characters as one span',
    (length) => {
      const text = Array.from({ length }, (_, index) => ((index * 7_919) % 36).toString(36)).join(
        ''
      );
      const third = Math.floor(length / 3);
      const redact = createActionSecretRedactor([text.slice(0, 2 * third), text.slice(third)]);
      expect(redact(`before ${text} after`)).toBe('before [REDACTED] after');
    }
  );

  it.each([1_000, 32_000])(
    'bounds the work for a repetitive credential of %i characters',
    { timeout: 120_000 },
    (length) => {
      const repetitive = 'a'.repeat(length);
      const text = 'a'.repeat(64 * 1024);
      const started = performance.now();
      expect(createActionSecretRedactor([repetitive])(text)).toBe('[REDACTED]');
      expect(createActionSecretRedactor([`${repetitive}b`])(text)).toBe(text);
      expect(createActionSecretRedactor([`b${repetitive}`])(text)).toBe(text);
      expect(performance.now() - started).toBeLessThan(2_000);
    }
  );
});

describe('redactCredentialValues', () => {
  it('counts only the characters that are matched', () => {
    const message = 'Webhook request failed: 415 1 11';
    for (const value of ['1', '415', '   1', '\u200b1\u200b1\u200b', ' 4\n1\t5 ']) {
      expect(redactCredentialValues(message, [value])).toBe(message);
    }
    expect(redactCredentialValues(message, [' fa iled '])).toBe(
      'Webhook request [REDACTED]: 415 1 11'
    );
  });
});

describe('requestCredentialValues', () => {
  it('adds each credential without its scheme and the decoded Basic credential', () => {
    const payload = Buffer.from('acme-user:basic-pass-1').toString('base64');

    expect(
      requestCredentialValues([
        'Bearer bearer-value-1',
        `Basic ${payload}`,
        'Token custom-value-1',
        'application/json',
      ])
    ).toEqual([
      'Bearer bearer-value-1',
      'bearer-value-1',
      `Basic ${payload}`,
      payload,
      'acme-user:basic-pass-1',
      'basic-pass-1',
      'Token custom-value-1',
      'custom-value-1',
      'application/json',
    ]);
  });

  it('skips values and parts too short to be credentials', () => {
    expect(requestCredentialValues(['abc', 'Key abc', 'Basic Og==', 'Basic not-base64!'])).toEqual([
      'Key abc',
      'Basic Og==',
      'Og==',
      'Basic not-base64!',
      'not-base64!',
    ]);
  });
});

describe('toActionResultError', () => {
  const providerBody = JSON.stringify({
    error: {
      code: 'AutomationIsActive',
      message: 'Token acme-secret-1 cannot update an active automation.',
    },
  });

  it('keeps the safe message and adds the provider status and redacted message for a 4xx', () => {
    expect(
      toActionResultError(
        {
          ...mapStatusToError(403),
          message: 'API request failed: 403 Forbidden',
          providerStatus: 403,
          providerBody,
        },
        { safeErrors: true, secrets: { ACME_TOKEN: 'acme-secret-1' } },
        ['ACME_TOKEN']
      )
    ).toEqual({
      code: 'permission_denied',
      message: 'The external service refused the Action.',
      retryable: false,
      provider_status: 403,
      provider_message: 'Token [REDACTED] cannot update an active automation.',
    });
  });

  it('redacts request-scoped secrets only when their names are declared', () => {
    const classification = {
      ...mapStatusToError(403),
      message: 'failed',
      providerStatus: 403,
      providerBody,
    };
    const secrets = { ACME_TOKEN: 'acme-secret-1' };

    expect(
      toActionResultError(classification, { secrets, declaredSecretNames: ['ACME_TOKEN'] }, [])
        .provider_message
    ).toBe('Token [REDACTED] cannot update an active automation.');
    expect(
      toActionResultError(classification, undefined, [], ['acme-secret-1']).provider_message
    ).toBe('Token [REDACTED] cannot update an active automation.');
  });

  it.each([500, 503, 302])('omits the provider message for a %i response', (status) => {
    expect(
      toActionResultError(
        { ...mapStatusToError(status), message: 'failed', providerStatus: status, providerBody },
        { safeErrors: true },
        []
      )
    ).not.toHaveProperty('provider_message');
  });

  it('omits both provider fields when the failure has no HTTP status', () => {
    expect(
      toActionResultError(
        { code: 'network_error', message: 'fetch failed', retryable: true, providerBody },
        { safeErrors: true },
        []
      )
    ).toEqual({
      code: 'network_error',
      message: 'The external service could not be reached.',
      retryable: true,
    });
  });
});
