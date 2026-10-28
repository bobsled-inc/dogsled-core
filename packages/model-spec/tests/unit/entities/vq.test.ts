import { describe, expect, it } from 'vitest';

import { extractVqSqlTokens, VqSpecSchema } from '../../../src/entities/vq.js';

describe('VqSpecSchema', () => {
  const base = {
    spec_version: '0.2' as const,
    type: 'vq' as const,
    name: 'top_customers_last_30_days',
    nlq: 'Who are our top 10 customers by revenue in the last 30 days?',
    sql: 'SELECT * FROM {fct_orders} LIMIT 10',
  };

  it('accepts a minimal VQ', () => {
    const parsed = VqSpecSchema.parse(base);
    expect(parsed.name).toBe('top_customers_last_30_days');
  });

  it('accepts parameters + connection + tags', () => {
    const parsed = VqSpecSchema.parse({
      ...base,
      parameters: [
        { name: 'limit', type: 'integer', required: false, default: 10 },
        { name: 'since', type: 'date' },
      ],
      connection: 'snowflake_prod',
      tags: ['customer360', 'gold'],
    });
    expect(parsed.parameters).toHaveLength(2);
    expect(parsed.parameters?.[0]?.required).toBe(false);
    // `required: true` default applied on the parameter without `required`.
    expect(parsed.parameters?.[1]?.required).toBe(true);
    expect(parsed.connection).toBe('snowflake_prod');
  });

  it('rejects empty nlq', () => {
    expect(() => VqSpecSchema.parse({ ...base, nlq: '' })).toThrow();
  });

  it('rejects empty sql', () => {
    expect(() => VqSpecSchema.parse({ ...base, sql: '' })).toThrow();
  });

  it('rejects invalid parameter type', () => {
    expect(() =>
      VqSpecSchema.parse({
        ...base,
        parameters: [{ name: 'limit', type: 'bigint' }],
      })
    ).toThrow();
  });

  it('rejects non-identifier connection handle', () => {
    expect(() => VqSpecSchema.parse({ ...base, connection: 'not an ident' })).toThrow();
  });
});

describe('extractVqSqlTokens', () => {
  it('extracts model-only tokens', () => {
    expect(extractVqSqlTokens('SELECT * FROM {fct_orders}')).toEqual([
      { raw: '{fct_orders}', segments: ['fct_orders'] },
    ]);
  });

  it('extracts connection.source tokens', () => {
    expect(extractVqSqlTokens('SELECT * FROM {ecom.raw_orders}')).toEqual([
      { raw: '{ecom.raw_orders}', segments: ['ecom', 'raw_orders'] },
    ]);
  });

  it('extracts multiple tokens in appearance order', () => {
    const tokens = extractVqSqlTokens(
      'SELECT a.id FROM {fct_orders} a JOIN {dim_customers} b ON a.cid = b.id'
    );
    expect(tokens.map((t) => t.raw)).toEqual(['{fct_orders}', '{dim_customers}']);
  });

  it('returns empty array on no tokens', () => {
    expect(extractVqSqlTokens('SELECT 1')).toEqual([]);
  });

  it('does not extract tokens with more than two dotted segments', () => {
    expect(extractVqSqlTokens('{a.b.c}')).toEqual([]);
  });

  it('does not extract tokens that start with a digit', () => {
    expect(extractVqSqlTokens('{1foo}')).toEqual([]);
  });
});
