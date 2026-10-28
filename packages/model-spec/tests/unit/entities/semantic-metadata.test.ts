import { describe, expect, it } from 'vitest';

import {
  AiContextSchema,
  DatasetReferenceSchema,
  OssieLogicalDataTypeSchema,
  SemanticExpressionSchema,
} from '../../../src/entities/semantic-metadata.js';
import { EntityInterchangeSchema, InterchangeSchema } from '../../../src/interchange/storage.js';

describe('native semantic metadata schemas', () => {
  it('accepts string and open-object AI context but rejects arrays and oversized data', () => {
    expect(AiContextSchema.parse('Use this field for calendar reporting.')).toBeTypeOf('string');
    expect(
      AiContextSchema.parse({
        instructions: 'Prefer completed orders.',
        synonyms: ['bookings'],
        custom_key: { enabled: true },
      })
    ).toMatchObject({ custom_key: { enabled: true } });

    expect(AiContextSchema.safeParse(['not', 'an', 'object']).success).toBe(false);
    expect(AiContextSchema.safeParse({ value: 'x'.repeat(1_000_001) }).success).toBe(false);
  });

  it('preserves ordered semantic expression dialects', () => {
    const expression = {
      dialects: [
        { dialect: 'ANSI_SQL', expression: 'SUM(amount)' },
        { dialect: 'SNOWFLAKE', expression: 'SUM(amount)::NUMBER' },
      ],
    };

    expect(SemanticExpressionSchema.parse(expression)).toEqual(expression);
    expect(SemanticExpressionSchema.safeParse({ dialects: [] }).success).toBe(false);
  });

  it('accepts the pinned Ossie logical datatypes', () => {
    for (const datatype of [
      'String',
      'Integer',
      'Decimal',
      'Float',
      'Boolean',
      'Date',
      'Time',
      'DateTime',
      'DateTimeTz',
      'Opaque',
    ]) {
      expect(OssieLogicalDataTypeSchema.parse(datatype)).toBe(datatype);
    }
    expect(OssieLogicalDataTypeSchema.safeParse('NUMBER(18,2)').success).toBe(false);
  });

  it('distinguishes bare model names from two-part qualified source keys', () => {
    expect(DatasetReferenceSchema.parse('customers')).toBe('customers');
    expect(DatasetReferenceSchema.parse('warehouse.customers')).toBe('warehouse.customers');
    expect(DatasetReferenceSchema.safeParse('database.schema.customers').success).toBe(false);
    expect(DatasetReferenceSchema.safeParse('warehouse.customer orders').success).toBe(false);
  });
});

describe('native Ossie interchange storage', () => {
  const foreignExtension = { vendor_name: 'DBT', data: '{"relation_name":"orders"}' };

  it('stores foreign extensions directly on metric and relationship owners', () => {
    const value = { ossie: { custom_extensions: [foreignExtension] } };
    expect(EntityInterchangeSchema.parse(value)).toEqual(value);
  });

  it('stores dataset and field extensions without document membership', () => {
    const value = {
      ossie: {
        custom_extensions: [foreignExtension],
        fields: [
          {
            origin_id: 'field-amount',
            field: 'amount',
            custom_extensions: [{ vendor_name: 'COMMON', data: '{"format":"currency"}' }],
          },
        ],
      },
    };

    expect(InterchangeSchema.parse(value)).toEqual(value);
    expect(value.ossie).not.toHaveProperty('document_id');
  });

  it('rejects legacy storage version 1 records', () => {
    const legacy = {
      ossie: {
        storage_version: 1,
        profile_revision: 'legacy-revision',
        document_id: 'sales',
        dataset_id: 'orders',
        original_name: 'orders',
        original_source: 'analytics.orders',
        dataset_metadata: {},
        fields: [],
      },
    };

    expect(InterchangeSchema.safeParse(legacy).success).toBe(false);
  });

  it('rejects malformed opaque extensions', () => {
    expect(
      EntityInterchangeSchema.safeParse({
        ossie: { custom_extensions: [{ vendor_name: '', data: '{}' }] },
      }).success
    ).toBe(false);
    expect(
      EntityInterchangeSchema.safeParse({
        ossie: { custom_extensions: [{ vendor_name: 'DBT', data: 'x'.repeat(1_000_001) }] },
      }).success
    ).toBe(false);
  });
});
