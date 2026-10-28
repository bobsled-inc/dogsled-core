import { describe, expect, it } from 'vitest';

import { RelationshipSpecSchema } from '../../../src/entities/relationship.js';

describe('RelationshipSpecSchema', () => {
  const base = {
    spec_version: '0.2' as const,
    type: 'relationship' as const,
    name: 'orders_to_customers',
    left_model: 'fct_orders',
    right_model: 'dim_customers',
    join_columns: [{ left: 'customer_id', right: 'id' }],
    relationship_type: 'many_to_one' as const,
  };

  it('accepts a minimal single-column relationship', () => {
    const parsed = RelationshipSpecSchema.parse(base);
    expect(parsed.join_type).toBe('inner'); // default
    expect(parsed.join_columns).toHaveLength(1);
  });

  it('accepts a multi-column relationship', () => {
    const parsed = RelationshipSpecSchema.parse({
      ...base,
      join_columns: [
        { left: 'a', right: 'x' },
        { left: 'b', right: 'y' },
      ],
    });
    expect(parsed.join_columns).toHaveLength(2);
  });

  it('accepts explicit join_type', () => {
    expect(RelationshipSpecSchema.parse({ ...base, join_type: 'left' }).join_type).toBe('left');
  });

  it('rejects invalid join_type', () => {
    expect(() => RelationshipSpecSchema.parse({ ...base, join_type: 'right' })).toThrow();
    expect(() => RelationshipSpecSchema.parse({ ...base, join_type: 'full' })).toThrow();
  });

  it('accepts all four relationship_type cardinalities', () => {
    for (const card of ['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many'] as const) {
      expect(
        RelationshipSpecSchema.parse({ ...base, relationship_type: card }).relationship_type
      ).toBe(card);
    }
  });

  it('accepts source references and Ossie metadata', () => {
    const input = {
      ...base,
      left_model: 'warehouse.raw_orders',
      ai_context: 'Use this relationship for customer order analysis.',
      interchange: {
        ossie: {
          custom_extensions: [{ vendor_name: 'DBT', data: '{"relationship":"orders"}' }],
        },
      },
    } as const;

    expect(RelationshipSpecSchema.parse(input)).toMatchObject(input);
  });

  it('rejects missing join_columns', () => {
    expect(() => RelationshipSpecSchema.parse({ ...base, join_columns: [] })).toThrow();
  });

  it('accepts self-relationships', () => {
    expect(
      RelationshipSpecSchema.parse({ ...base, right_model: base.left_model }).right_model
    ).toBe(base.left_model);
  });

  it('rejects non-identifier model names', () => {
    expect(() => RelationshipSpecSchema.parse({ ...base, left_model: 'fct orders' })).toThrow();
  });

  it('rejects wrong type discriminator', () => {
    expect(() => RelationshipSpecSchema.parse({ ...base, type: 'metric' })).toThrow();
  });

  it('rejects unknown top-level fields', () => {
    expect(() => RelationshipSpecSchema.parse({ ...base, unknown: 'x' })).toThrow();
  });
});
