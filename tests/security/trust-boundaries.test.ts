import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { assertSafeDirName, assertSafeHandle } from '../../packages/connections/src/fs/shared.js';
import { redactErrorMessage } from '../../packages/extractor/src/commands/mcp/redaction.js';
import {
  isPrivateHost,
  sanitizeUrlForError,
} from '../../packages/extractor/src/framework/core/shared.js';
import { parseRequiredStdoutMessage } from '../../packages/protocol/src/parse.js';

const propertyOptions = { numRuns: 100, seed: 20_260_727 };

describe('fixed-seed security properties', () => {
  it('classifies generated private and loopback IPv4 addresses as non-public', () => {
    const octet = fc.integer({ min: 0, max: 255 });
    const privateAddress = fc.oneof(
      fc.tuple(octet, octet, octet).map(([a, b, c]) => `10.${a}.${b}.${c}`),
      fc
        .tuple(fc.integer({ min: 16, max: 31 }), octet, octet)
        .map(([a, b, c]) => `172.${a}.${b}.${c}`),
      fc.tuple(octet, octet).map(([a, b]) => `192.168.${a}.${b}`),
      fc.tuple(octet, octet, octet).map(([a, b, c]) => `127.${a}.${b}.${c}`)
    );
    fc.assert(
      fc.property(privateAddress, (address) => {
        expect(isPrivateHost(address)).toBe(true);
      }),
      propertyOptions
    );
  });

  it('redacts arbitrary query values and bearer credentials from diagnostics', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 80 }),
        fc.stringMatching(/^[A-Za-z0-9_-]{4,40}$/),
        (querySecret, bearerSecret) => {
          const encoded = encodeURIComponent(querySecret);
          const sanitized = sanitizeUrlForError(
            `https://example.test/resource?token=${encoded}&safe=value`
          );
          expect(new URL(sanitized).search).not.toContain('token=');
          expect(sanitized).toContain('[redacted]');

          const redacted = redactErrorMessage(`Bearer ${bearerSecret}`);
          expect(redacted).not.toContain(bearerSecret);
        }
      ),
      propertyOptions
    );
  });

  it('rejects generated traversal-shaped handles and directory names', () => {
    const segment = fc.stringMatching(/^[a-z][a-z0-9_]{0,20}$/);
    fc.assert(
      fc.property(segment, (value) => {
        expect(() => assertSafeHandle(`../${value}`)).toThrow();
        expect(() => assertSafeHandle(`${value}/${value}`)).toThrow();
        expect(() => assertSafeDirName(`config/../${value}`)).toThrow();
        expect(() => assertSafeDirName(`/${value}`)).toThrow();
      }),
      propertyOptions
    );
  });

  it('rejects generated oversized protocol identifiers', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 301, maxLength: 500 }), (stream) => {
        expect(() =>
          parseRequiredStdoutMessage({
            _v: 1,
            type: 'RECORD',
            stream,
            record: {},
          })
        ).toThrow('exceeds 300 characters');
      }),
      propertyOptions
    );
  });
});
