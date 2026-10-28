import { DogsledRuntimeError, type DogsledRuntimeErrorOptions } from '@bobsled-inc/protocol';
import { describe, expect, it } from 'vitest';

import { classifyTransportError } from '../../../src/lib/transports/shared.js';

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
    [403, 'auth_error', false],
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
    ).toMatchObject({ code: 'rate_limited', retryable: true });
  });
});
