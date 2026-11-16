import { BobsledRuntimeError, type BobsledRuntimeErrorOptions } from '@bobsled-inc/protocol';
import { describe, expect, it } from 'vitest';

import {
  createActionSecretRedactor,
  providerMessageFromBody,
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
  options: Pick<BobsledRuntimeErrorOptions, 'kind'> & Partial<BobsledRuntimeErrorOptions>
): BobsledRuntimeError {
  return new BobsledRuntimeError({
    code: 'EXTRACTOR_HTTP_STATUS_FAILURE',
    operation: 'extractor.http.request',
    retryable: false,
    ...options,
  });
}

function bundledRuntimeError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error('The provider could not complete the operation.'), {
    name: 'BobsledRuntimeError',
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
