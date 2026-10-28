import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { snakeCaseHandleSchema, validateDualShapeFields } from '../../../src/schemas/shared.js';

describe('snakeCaseHandleSchema', () => {
  it('accepts snake_case', () => {
    expect(snakeCaseHandleSchema.parse('snowflake_prod')).toBe('snowflake_prod');
    expect(snakeCaseHandleSchema.parse('a')).toBe('a');
    expect(snakeCaseHandleSchema.parse('a1_b2_c3')).toBe('a1_b2_c3');
  });

  it('rejects uppercase', () => {
    expect(() => snakeCaseHandleSchema.parse('Snowflake')).toThrow();
    expect(() => snakeCaseHandleSchema.parse('SNOWFLAKE')).toThrow();
  });

  it('rejects leading digits', () => {
    expect(() => snakeCaseHandleSchema.parse('1sf')).toThrow();
  });

  it('rejects path separators / traversal chars', () => {
    expect(() => snakeCaseHandleSchema.parse('sf/prod')).toThrow();
    expect(() => snakeCaseHandleSchema.parse('../etc')).toThrow();
    expect(() => snakeCaseHandleSchema.parse('sf.prod')).toThrow();
    expect(() => snakeCaseHandleSchema.parse('sf-prod')).toThrow();
  });

  it('rejects empty string', () => {
    expect(() => snakeCaseHandleSchema.parse('')).toThrow();
  });
});

describe('validateDualShapeFields', () => {
  const schema = z
    .object({
      token: z.string().optional(),
      token_env: z.string().optional(),
      passphrase: z.string().optional(),
      passphrase_env: z.string().optional(),
    })
    .superRefine((val, ctx) => {
      validateDualShapeFields(val, ctx, [
        { newField: 'token', legacyField: 'token_env', required: true },
        { newField: 'passphrase', legacyField: 'passphrase_env', required: false },
      ]);
    });

  it('accepts new-style only', () => {
    expect(schema.parse({ token: 'abc' })).toEqual({ token: 'abc' });
  });

  it('accepts legacy-style only', () => {
    expect(schema.parse({ token_env: 'MY_TOKEN' })).toEqual({ token_env: 'MY_TOKEN' });
  });

  it('rejects both styles for the same field', () => {
    expect(() => schema.parse({ token: 'abc', token_env: 'X' })).toThrow(/Cannot set both/);
  });

  it('rejects required pair being absent', () => {
    expect(() => schema.parse({})).toThrow(/must be set/);
  });

  it('permits optional pair being both absent', () => {
    expect(schema.parse({ token: 'abc' })).toEqual({ token: 'abc' });
  });
});
