import { describe, expect, it } from 'vitest';

import {
  describeNetworkFailure,
  isTransientNetworkFailure,
} from '../../src/runtime/request-failure.js';

/** The shapes undici raises: the code sits on the cause of a TypeError. */
function undiciFailure(code: string, message: string, summary = 'fetch failed'): TypeError {
  return new TypeError(summary, { cause: Object.assign(new Error(message), { code }) });
}

describe('isTransientNetworkFailure', () => {
  it.each([
    'ECONNRESET',
    'EPIPE',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
  ])('accepts %s on the cause of a fetch failure and of a body failure', (code) => {
    expect(isTransientNetworkFailure(undiciFailure(code, 'x'))).toBe(true);
    expect(isTransientNetworkFailure(undiciFailure(code, 'x', 'terminated'))).toBe(true);
  });

  it('accepts a code on the error itself', () => {
    expect(
      isTransientNetworkFailure(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
    ).toBe(true);
  });

  it.each([
    ['a bare fetch failure', new TypeError('fetch failed')],
    ['a bare terminated body', new TypeError('terminated')],
    ['a refused connection', undiciFailure('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:443')],
    ['a TLS certificate error', undiciFailure('CERT_HAS_EXPIRED', 'certificate has expired')],
    ['an HTTP parser error', undiciFailure('HPE_INVALID_CONSTANT', 'Expected HTTP/')],
    [
      'the refusal of a private address',
      new TypeError('fetch failed', {
        cause: new Error('Request URL hostname "internal" resolves to private address 10.0.0.5.'),
      }),
    ],
    ['an error with a numeric code', Object.assign(new Error('x'), { code: 23 })],
    ['a plain error', new Error('ECONNRESET')],
  ])('rejects %s', (_name, error) => {
    expect(isTransientNetworkFailure(error)).toBe(false);
  });
});

describe('describeNetworkFailure', () => {
  it('names the innermost cause and the code', () => {
    expect(describeNetworkFailure(undiciFailure('UND_ERR_SOCKET', 'other side closed'))).toBe(
      'other side closed (UND_ERR_SOCKET)'
    );
  });

  it('does not repeat a code that the message already holds', () => {
    expect(describeNetworkFailure(undiciFailure('ECONNRESET', 'read ECONNRESET'))).toBe(
      'read ECONNRESET'
    );
  });

  it('reads through a longer chain of causes', () => {
    const error = new TypeError('fetch failed', {
      cause: new Error('connect failed', {
        cause: Object.assign(new Error('Connect Timeout Error'), {
          code: 'UND_ERR_CONNECT_TIMEOUT',
        }),
      }),
    });

    expect(describeNetworkFailure(error)).toBe('Connect Timeout Error (UND_ERR_CONNECT_TIMEOUT)');
  });

  it('falls back to the code when the cause has no message', () => {
    expect(describeNetworkFailure(undiciFailure('EPIPE', ''))).toBe('EPIPE');
  });

  it('keeps a long message short and on one line', () => {
    const described = describeNetworkFailure(
      undiciFailure('ETIMEDOUT', `connect ETIMEDOUT\n${'detail '.repeat(100)}`)
    );

    expect(described).not.toContain('\n');
    expect(described.length).toBeLessThanOrEqual(201);
    expect(described.endsWith('…')).toBe(true);
  });
});
