import { describe, expect, it } from 'vitest';

import { MetricSpecSchema } from '../../../src/entities/metric.js';

describe('MetricSpecSchema', () => {
  const base = {
    spec_version: '0.2' as const,
    type: 'metric' as const,
    name: 'orders_total',
    expression: 'SUM(amount)',
  };

  it('accepts a single-model metric', () => {
    expect(MetricSpecSchema.parse({ ...base, model: 'fct_orders' })).toMatchObject({
      name: 'orders_total',
      model: 'fct_orders',
    });
  });

  it('accepts a multi-model metric', () => {
    expect(
      MetricSpecSchema.parse({ ...base, models: ['fct_orders', 'fct_returns'] })
    ).toMatchObject({ models: ['fct_orders', 'fct_returns'] });
  });

  it('accepts description + synonyms + tags', () => {
    const parsed = MetricSpecSchema.parse({
      ...base,
      model: 'fct_orders',
      description: 'Total order volume',
      synonyms: ['revenue', 'gross bookings'],
      tags: ['finance', 'gold'],
    });
    expect(parsed.description).toBe('Total order volume');
    expect(parsed.synonyms).toEqual(['revenue', 'gross bookings']);
    expect(parsed.tags).toEqual(['finance', 'gold']);
  });

  it('accepts source references and Ossie semantic metadata', () => {
    const input = {
      ...base,
      model: 'warehouse.raw_orders',
      datatype: 'Decimal',
      semantic_expression: {
        dialects: [{ dialect: 'ANSI_SQL', expression: 'SUM(amount)' }],
      },
      ai_context: { instructions: 'Use for revenue questions.' },
      interchange: {
        ossie: {
          custom_extensions: [{ vendor_name: 'DBT', data: '{"metric":"orders_total"}' }],
        },
      },
    } as const;

    expect(MetricSpecSchema.parse(input)).toMatchObject(input);
  });

  it('rejects when neither model nor models is set', () => {
    // Zod v4 serialises refine() issues as JSON; the message substring is
    // present but the escape sequence breaks a raw-regex match.
    expect(() => MetricSpecSchema.parse(base)).toThrow(/model.*or.*models/);
  });

  it('rejects an empty models array', () => {
    expect(() => MetricSpecSchema.parse({ ...base, models: [] })).toThrow();
  });

  it('rejects a non-identifier name', () => {
    expect(() => MetricSpecSchema.parse({ ...base, name: 'orders total', model: 'm' })).toThrow();
  });

  it('rejects an empty expression', () => {
    expect(() => MetricSpecSchema.parse({ ...base, model: 'm', expression: '' })).toThrow();
  });

  it('rejects wrong spec_version', () => {
    expect(() => MetricSpecSchema.parse({ ...base, spec_version: '0.1', model: 'm' })).toThrow();
  });

  it('rejects wrong type discriminator', () => {
    expect(() => MetricSpecSchema.parse({ ...base, type: 'relationship', model: 'm' })).toThrow();
  });

  it('rejects unknown top-level fields', () => {
    expect(() => MetricSpecSchema.parse({ ...base, model: 'm', unknown: 'x' })).toThrow();
  });
});
