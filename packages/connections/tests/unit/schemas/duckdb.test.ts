import { describe, expect, it } from 'vitest';

import { DuckDbAuthSchema, DuckDbConnectionSchema } from '../../../src/schemas/duckdb.js';

describe('DuckDbConnectionSchema', () => {
  it('accepts empty object', () => {
    expect(DuckDbConnectionSchema.parse({})).toEqual({});
  });

  it('accepts optional schema default', () => {
    expect(DuckDbConnectionSchema.parse({ schema: 'main' })).toEqual({ schema: 'main' });
  });

  it('rejects unknown field', () => {
    expect(() => DuckDbConnectionSchema.parse({ unknown: 'x' })).toThrow();
  });
});

describe('DuckDbAuthSchema', () => {
  it('parses file auth with path', () => {
    expect(DuckDbAuthSchema.parse({ type: 'file', path: '/tmp/warehouse.duckdb' })).toMatchObject({
      type: 'file',
      path: '/tmp/warehouse.duckdb',
      read_only: false,
    });
  });

  it('parses file auth with explicit read_only', () => {
    expect(
      DuckDbAuthSchema.parse({ type: 'file', path: '/tmp/w.duckdb', read_only: true })
    ).toMatchObject({ read_only: true });
  });

  it('rejects file auth missing path', () => {
    expect(() => DuckDbAuthSchema.parse({ type: 'file' })).toThrow();
  });

  it('parses memory auth', () => {
    expect(DuckDbAuthSchema.parse({ type: 'memory' })).toEqual({ type: 'memory' });
  });

  it('rejects memory auth with extra fields', () => {
    expect(() => DuckDbAuthSchema.parse({ type: 'memory', path: '/tmp/x' })).toThrow();
  });

  it('rejects unknown type', () => {
    expect(() => DuckDbAuthSchema.parse({ type: 'pat', token: 'x' })).toThrow();
  });
});
