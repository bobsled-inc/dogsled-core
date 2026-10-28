import { describe, it, expect } from 'vitest';

import { SafeHeaderNameSchema, SafeHeaderValueSchema } from '../../../src/framework/core/shared.js';

describe('Header Injection Protection', () => {
  describe('SafeHeaderNameSchema', () => {
    it('accepts valid header names', () => {
      expect(SafeHeaderNameSchema.safeParse('X-Custom-Header').success).toBe(true);
      expect(SafeHeaderNameSchema.safeParse('Accept').success).toBe(true);
      expect(SafeHeaderNameSchema.safeParse('Content-Type').success).toBe(true);
      expect(SafeHeaderNameSchema.safeParse('X-Api-Key').success).toBe(true);
    });

    it('rejects names with invalid characters', () => {
      expect(SafeHeaderNameSchema.safeParse('Header\r\nEvil').success).toBe(false);
      expect(SafeHeaderNameSchema.safeParse('Header Name').success).toBe(false);
      expect(SafeHeaderNameSchema.safeParse('Header:Name').success).toBe(false);
      expect(SafeHeaderNameSchema.safeParse('123-Header').success).toBe(false);
    });

    it('rejects restricted headers', () => {
      expect(SafeHeaderNameSchema.safeParse('host').success).toBe(false);
      expect(SafeHeaderNameSchema.safeParse('Host').success).toBe(false);
      expect(SafeHeaderNameSchema.safeParse('content-length').success).toBe(false);
      expect(SafeHeaderNameSchema.safeParse('authorization').success).toBe(false);
      expect(SafeHeaderNameSchema.safeParse('transfer-encoding').success).toBe(false);
      expect(SafeHeaderNameSchema.safeParse('connection').success).toBe(false);
    });
  });

  describe('SafeHeaderValueSchema', () => {
    it('accepts normal ASCII strings', () => {
      expect(SafeHeaderValueSchema.safeParse('Bearer token123').success).toBe(true);
      expect(SafeHeaderValueSchema.safeParse('application/json').success).toBe(true);
    });

    it('rejects values with control characters', () => {
      expect(SafeHeaderValueSchema.safeParse('value\r\nevil').success).toBe(false);
      expect(SafeHeaderValueSchema.safeParse('value\x00evil').success).toBe(false);
      expect(SafeHeaderValueSchema.safeParse('value\x7fevil').success).toBe(false);
      expect(SafeHeaderValueSchema.safeParse('value\nevil').success).toBe(false);
      expect(SafeHeaderValueSchema.safeParse('value\revil').success).toBe(false);
    });
  });
});
