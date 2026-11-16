import { describe, expect, it } from 'vitest';
import {
  translateOssieDocument,
  validateOssieDocument,
  logicalTypeForSqlType,
} from '../../src/ossie/index.js';

const ext = (data: unknown) => [{ vendor_name: 'BOBSLED', data: JSON.stringify(data) }];
function fixture() {
  return {
    version: '0.2.0.dev0',
    name: 'sales',
    datasets: [
      {
        name: 'orders',
        description: 'One row per order',
        source: 'analytics.sales.orders',
        primary_key: ['id'],
        fields: [
          {
            name: 'id',
            datatype: 'Integer',
            expression: { dialects: [{ dialect: 'ANSI_SQL', expression: 'id' }] },
            custom_extensions: ext({ build_expression: 'id', sql_type: 'BIGINT' }),
          },
        ],
        custom_extensions: ext({
          extension_version: '1',
          kind: 'derived',
          grain: ['id'],
          build: { source: { ref: 'warehouse.raw_orders' }, materialization: { type: 'table' } },
        }),
      },
    ],
  };
}
describe('pinned Ossie authoring translator', () => {
  it('uses field build expressions and explicit grain while retaining native materialization settings', () => {
    const doc = fixture();
    doc.datasets[0]!.custom_extensions = ext({
      extension_version: '1',
      kind: 'derived',
      grain: ['id'],
      build: {
        source: { ref: 'warehouse.raw_orders' },
        where: 'id > 0',
        materialization: { type: 'incremental', strategy: 'merge', unique_key: 'id' },
      },
    });
    const result = translateOssieDocument(doc, 'sales.yml');
    expect(result.entries[0]?.document).toMatchObject({
      type: 'model',
      grain: ['id'],
      where: 'id > 0',
      columns: [{ name: 'id', expr: 'id', type: 'BIGINT', primary_key: true }],
      materialization: { type: 'incremental', strategy: 'merge', unique_key: 'id' },
    });
    expect(result.origins[0]?.document).toBe(doc);
  });
  it('reads dataset and field ai_context synonyms as native synonyms', () => {
    const doc = fixture();
    const dataset = doc.datasets[0]! as Record<string, unknown>;
    dataset['ai_context'] = { synonyms: ['purchases', 'Purchases'] };
    (dataset['fields'] as Array<Record<string, unknown>>)[0]!['ai_context'] = {
      synonyms: ['order number'],
    };
    expect(translateOssieDocument(doc, 'sales.yml').entries[0]?.document).toMatchObject({
      synonyms: ['purchases'],
      columns: [{ name: 'id', synonyms: ['order number'] }],
    });
  });
  it('keeps standard metadata and foreign extensions in the authored document', () => {
    const doc = fixture();
    doc.datasets[0]!.custom_extensions.push({ vendor_name: 'OTHER', data: 'opaque payload' });
    expect(translateOssieDocument(doc, 'sales.yml').origins[0]?.document).toEqual(doc);
  });
  it.each([
    [
      'unsupported version',
      (d: ReturnType<typeof fixture>) => {
        d.version = '0.1.1';
      },
      /Invalid Ossie/,
    ],
    [
      'nonstandard root marker',
      (d: ReturnType<typeof fixture>) => {
        Object.assign(d, { format: 'ossie' });
      },
      /Invalid Ossie/,
    ],
    [
      'missing grain',
      (d: ReturnType<typeof fixture>) => {
        d.datasets[0]!.custom_extensions = ext({
          extension_version: '1',
          kind: 'derived',
          build: { source: { ref: 'warehouse.raw' }, materialization: { type: 'table' } },
        });
      },
      /grain/,
    ],
    [
      'wildcard output',
      (d: ReturnType<typeof fixture>) => {
        d.datasets[0]!.custom_extensions = ext({
          extension_version: '1',
          kind: 'derived',
          grain: ['id'],
          build: {
            source: { ref: 'warehouse.raw' },
            include_all_columns: true,
            materialization: { type: 'table' },
          },
        });
      },
      /include_all_columns/,
    ],
    [
      'unknown setting',
      (d: ReturnType<typeof fixture>) => {
        d.datasets[0]!.custom_extensions = ext({
          extension_version: '1',
          kind: 'derived',
          grain: ['id'],
          build: {
            source: { ref: 'warehouse.raw' },
            matrialization: { type: 'table' },
            materialization: { type: 'table' },
          },
        });
      },
      /Unsupported BOBSLED property/,
    ],
    [
      'type conflict',
      (d: ReturnType<typeof fixture>) => {
        d.datasets[0]!.fields[0]!.datatype = 'String';
      },
      /conflicts/,
    ],
    [
      'malformed extension',
      (d: ReturnType<typeof fixture>) => {
        d.datasets[0]!.custom_extensions[0]!.data = '{';
      },
      /JSON object/,
    ],
    [
      'build expression in standard field',
      (d: ReturnType<typeof fixture>) => {
        d.datasets[0]!.fields[0]!.expression.dialects[0]!.expression = 'id + 1';
      },
      /finished column/,
    ],
    [
      'duplicate field',
      (d: ReturnType<typeof fixture>) => {
        d.datasets[0]!.fields.push({ ...d.datasets[0]!.fields[0]!, name: 'ID' });
      },
      /Duplicate field/,
    ],
  ])('rejects %s', (_name, mutate, pattern) => {
    const doc = fixture();
    mutate(doc);
    expect(() => translateOssieDocument(doc, 'sales.yml')).toThrow(pattern);
  });
  it('keeps schema validity distinct from Bobsled Core execution support', () => {
    const doc = fixture();
    doc.datasets[0]!.custom_extensions = [];
    expect(() => validateOssieDocument(doc, 'sales.yml')).not.toThrow();
    expect(() => translateOssieDocument(doc, 'sales.yml')).toThrow(/BOBSLED extension required/);
  });
  it('uses project-local ephemeral references without inventing a table', () => {
    const doc = fixture();
    doc.datasets[0]!.source = 'bobsled://models/orders';
    doc.datasets[0]!.custom_extensions = ext({
      extension_version: '1',
      kind: 'derived',
      grain: ['id'],
      build: { source: { ref: 'warehouse.raw' }, materialization: { type: 'ephemeral' } },
    });
    expect(translateOssieDocument(doc, 'sales.yml').entries[0]?.document).toMatchObject({
      materialization: { type: 'ephemeral' },
    });
    doc.datasets[0]!.source = 'analytics.sales.orders';
    expect(() => translateOssieDocument(doc, 'sales.yml')).toThrow(/Ephemeral/);
  });
  it('requires exact source types and translates the existing connection', () => {
    const doc = fixture();
    doc.datasets[0]!.custom_extensions = ext({
      extension_version: '1',
      kind: 'source',
      connection: 'warehouse',
    });
    doc.datasets[0]!.fields[0]!.custom_extensions = ext({ sql_type: 'BIGINT' });
    expect(translateOssieDocument(doc, 'sales.yml').entries[0]?.document).toMatchObject({
      type: 'source',
      connection: 'warehouse',
      table: 'analytics.sales.orders',
      schema: { columns: [{ name: 'id', type: 'BIGINT' }] },
    });
    doc.datasets[0]!.fields[0]!.custom_extensions = [];
    expect(() => translateOssieDocument(doc, 'sales.yml')).toThrow(/sql_type/);
  });
  it.each([
    ['DECIMAL(18,2)', 'Decimal'],
    ['BIGINT', 'Integer'],
    ['TIMESTAMP_NTZ', 'DateTime'],
    ['TIMESTAMP WITH TIME ZONE', 'DateTimeTz'],
    ['VECTOR', 'Opaque'],
  ])('maps %s to %s', (sql, logical) => {
    expect(logicalTypeForSqlType(sql)).toBe(logical);
  });
  it('translates qualified metrics and many-to-one relationship metadata', () => {
    const doc = fixture();
    doc.datasets.push({
      ...doc.datasets[0]!,
      name: 'customers',
      source: 'analytics.sales.customers',
    });
    Object.assign(doc, {
      metrics: [
        {
          name: 'orders_count',
          expression: { dialects: [{ dialect: 'ANSI_SQL', expression: 'COUNT(orders.id)' }] },
        },
      ],
      relationships: [
        {
          name: 'order_customer',
          from: 'orders',
          to: 'customers',
          from_columns: ['id'],
          to_columns: ['id'],
        },
      ],
    });
    const result = translateOssieDocument(doc, 'sales.yml');
    expect(result.entries.find((e) => e.kind === 'metric')?.document).toMatchObject({
      models: ['orders'],
      expression: 'COUNT(orders.id)',
    });
    expect(result.entries.find((e) => e.kind === 'relationship')?.document).toMatchObject({
      relationship_type: 'many_to_one',
      join_columns: [{ left: 'id', right: 'id' }],
    });
  });
  it('does not read dotted string literals as metric references', () => {
    const doc = fixture();
    Object.assign(doc, {
      metrics: [
        {
          name: 'conditional_count',
          expression: {
            dialects: [
              {
                dialect: 'ANSI_SQL',
                expression: "SUM(CASE WHEN orders.id > 0 THEN 1 ELSE LENGTH('other.field') END)",
              },
            ],
          },
        },
      ],
    });
    expect(
      translateOssieDocument(doc, 'sales.yml').entries.find((e) => e.kind === 'metric')?.document
    ).toMatchObject({ models: ['orders'] });
  });
  it('treats arrays as opaque and refuses a false scalar declaration', () => {
    expect(logicalTypeForSqlType('BIGINT[]')).toBe('Opaque');
    const doc = fixture();
    doc.datasets[0]!.fields[0]!.custom_extensions = ext({
      build_expression: 'id',
      sql_type: 'BIGINT[]',
    });
    expect(() => translateOssieDocument(doc, 'sales.yml')).toThrow(/conflicts/);
  });
  it('rejects output-shape changes until their final fields can be mapped', () => {
    const doc = fixture();
    doc.datasets[0]!.custom_extensions = ext({
      extension_version: '1',
      kind: 'derived',
      grain: ['id'],
      build: {
        source: { ref: 'warehouse.raw' },
        materialization: { type: 'table' },
        unpivot: { value_column: 'value' },
      },
    });
    expect(() => translateOssieDocument(doc, 'sales.yml')).toThrow(/final-output field mapping/);
  });
});
