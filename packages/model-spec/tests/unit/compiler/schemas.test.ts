import { describe, expect, it } from 'vitest';

import { SourceSpecSchema, TransformSpecSchema } from '../../../src/compiler/schemas.js';

describe('SourceSpecSchema', () => {
  it('parses a valid source spec', () => {
    const input = {
      spec_version: '0.2',
      name: 'raw_orders',
      type: 'source',
      source_type: 'warehouse_table',
      connection: 'ecom',
      table: 'RAW.RAW_ORDERS',
      schema: {
        columns: [
          { name: 'ID', type: 'NUMBER' },
          { name: 'SUBTOTAL', type: 'NUMBER' },
        ],
      },
    };

    const result = SourceSpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('raw_orders');
      expect(result.data.connection).toBe('ecom');
      expect(result.data.table).toBe('RAW.RAW_ORDERS');
      expect(result.data.schema.columns).toHaveLength(2);
    }
  });

  it('accepts canonical FieldMetadata fields on source columns', () => {
    const input = {
      spec_version: '0.2',
      name: 'raw_customers',
      type: 'source',
      source_type: 'warehouse_table',
      connection: 'ecom',
      table: 'RAW.RAW_CUSTOMERS',
      schema: {
        columns: [
          {
            name: 'EMAIL',
            type: 'STRING',
            description: 'Customer email address',
            semantic_role: 'email',
            pii: true,
            format: 'rfc5322',
            examples: ['buyer@example.com'],
            embedding_candidate: false,
          },
        ],
      },
    };

    const result = SourceSpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schema.columns[0]!.semantic_role).toBe('email');
      expect(result.data.schema.columns[0]!.pii).toBe(true);
    }
  });

  it('accepts Ossie semantic metadata on a source and its fields', () => {
    const input = {
      spec_version: '0.2',
      name: 'raw_orders',
      type: 'source',
      source_type: 'warehouse_table',
      connection: 'warehouse',
      table: 'RAW.ORDERS',
      ai_context: { instructions: 'Use for order history questions.' },
      schema: {
        columns: [
          {
            name: 'ORDERED_AT',
            type: 'TIMESTAMP_TZ',
            primary_key: true,
            is_time: true,
            semantic_expression: {
              dialects: [{ dialect: 'ANSI_SQL', expression: 'ordered_at' }],
            },
            ai_context: 'Prefer this field for order dates.',
          },
        ],
      },
      interchange: {
        ossie: {
          custom_extensions: [{ vendor_name: 'DBT', data: '{"relation":"orders"}' }],
        },
      },
    };

    expect(SourceSpecSchema.parse(input)).toMatchObject(input);
  });

  it('rejects a source spec with wrong version', () => {
    const input = {
      spec_version: '0.1',
      name: 'raw_orders',
      type: 'source',
      source_type: 'warehouse_table',
      connection: 'ecom',
      table: 'RAW.RAW_ORDERS',
      schema: { columns: [{ name: 'ID', type: 'NUMBER' }] },
    };

    const result = SourceSpecSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects a source spec with no columns', () => {
    const input = {
      spec_version: '0.2',
      name: 'raw_orders',
      type: 'source',
      source_type: 'warehouse_table',
      connection: 'ecom',
      table: 'RAW.RAW_ORDERS',
      schema: { columns: [] },
    };

    const result = SourceSpecSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects a source spec with missing name', () => {
    const input = {
      spec_version: '0.2',
      name: '',
      type: 'source',
      source_type: 'warehouse_table',
      connection: 'ecom',
      table: 'RAW.RAW_ORDERS',
      schema: { columns: [{ name: 'ID', type: 'NUMBER' }] },
    };

    const result = SourceSpecSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe('TransformSpecSchema', () => {
  it('parses a valid transform spec without joins', () => {
    const input = {
      spec_version: '0.2',
      name: 'stg_orders',
      type: 'model',
      description: 'Staging orders model.',
      grain: 'order_id',
      source: { ref: 'ecom.raw_orders' },
      columns: [
        { name: 'ORDER_ID', expr: 'ID' },
        { name: 'SUBTOTAL', expr: 'CAST(SUBTOTAL / 100.0 AS NUMERIC(16, 2))' },
      ],
      materialization: { type: 'view' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('stg_orders');
      expect(result.data.joins).toEqual([]);
      expect(result.data.columns).toHaveLength(2);
    }
  });

  it('accepts Ossie semantic metadata on a model and its fields', () => {
    const input = {
      spec_version: '0.2',
      name: 'orders',
      type: 'model',
      description: 'Orders.',
      grain: 'order_id',
      source: { ref: 'warehouse.raw_orders' },
      ai_context: 'Use for completed-order analysis.',
      columns: [
        {
          name: 'ORDER_ID',
          expr: 'order_id',
          semantic_expression: {
            dialects: [{ dialect: 'ANSI_SQL', expression: 'order_id' }],
          },
          is_time: false,
          ai_context: { synonyms: ['order key'] },
        },
      ],
      materialization: { type: 'view' },
    };

    expect(TransformSpecSchema.parse(input)).toMatchObject(input);
  });

  it('parses a valid transform spec with joins', () => {
    const input = {
      spec_version: '0.2',
      name: 'order_items',
      type: 'model',
      description: 'Order items with product details.',
      grain: 'order_item_id',
      source: { ref: 'ecom.raw_order_items' },
      joins: [
        {
          ref: 'ecom.raw_products',
          type: 'left',
          on: 'ecom.raw_order_items.PRODUCT_ID = ecom.raw_products.ID',
        },
      ],
      columns: [
        { name: 'ORDER_ITEM_ID', expr: 'ecom.raw_order_items.ID' },
        { name: 'PRODUCT_NAME', expr: 'ecom.raw_products.NAME' },
      ],
      materialization: { type: 'view' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.joins).toHaveLength(1);
      expect(result.data.joins[0]!.type).toBe('left');
    }
  });

  it('rejects a transform spec with invalid join type', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      joins: [{ ref: 'ecom.raw_products', type: 'right', on: 'a = b' }],
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'view' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects a transform spec with no columns', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [],
      materialization: { type: 'view' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('accepts spec with all metadata fields', () => {
    const input = {
      spec_version: '0.2',
      name: 'fct_orders',
      type: 'model',
      description: 'Order fact table.',
      grain: 'order_id',
      tags: ['finance', 'core'],
      owner: 'data-team',
      source: { ref: 'ecom.raw_orders', filter: "STATUS != 'cancelled'" },
      columns: [
        {
          name: 'ORDER_ID',
          expr: 'ID',
          description: 'Primary order identifier',
          type: 'NUMBER',
          primary_key: true,
          semantic_role: 'entity_id',
          references: 'stg_customers.customer_id',
          tags: ['pii'],
          business_rule: 'Derived from raw ID',
          quality_notes: 'No nulls expected',
          owner: 'alice',
          deprecated: false,
          pii: false,
          unit: 'orders',
          format: 'snowflake_number',
          enum_values: ['known'],
          examples: [123],
          embedding_candidate: true,
        },
      ],
      materialization: { type: 'view' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe('Order fact table.');
      expect(result.data.grain).toBe('order_id');
      expect(result.data.tags).toEqual(['finance', 'core']);
      expect(result.data.owner).toBe('data-team');
      expect(result.data.source.filter).toBe("STATUS != 'cancelled'");
      expect(result.data.columns[0]!.primary_key).toBe(true);
      expect(result.data.columns[0]!.semantic_role).toBe('entity_id');
      expect(result.data.columns[0]!.embedding_candidate).toBe(true);
    }
  });

  it('accepts expanded semantic_role vocabulary', () => {
    for (const role of [
      'identifier',
      'name',
      'address',
      'email',
      'phone',
      'url',
      'currency',
      'count',
      'rate',
    ]) {
      const input = {
        spec_version: '0.2',
        name: `test_${role}`,
        type: 'model',
        description: 'Test model.',
        grain: 'id',
        source: { ref: 'ecom.raw_orders' },
        columns: [{ name: 'ID', expr: 'ID', semantic_role: role }],
        materialization: { type: 'view' },
      };

      expect(TransformSpecSchema.safeParse(input).success).toBe(true);
    }
  });

  it('rejects spec without required description', () => {
    const input = {
      spec_version: '0.2',
      name: 'stg_orders',
      type: 'model',
      grain: 'order_id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ORDER_ID', expr: 'ID' }],
      materialization: { type: 'view' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects spec without required grain', () => {
    const input = {
      spec_version: '0.2',
      name: 'stg_orders',
      type: 'model',
      description: 'A staging model.',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ORDER_ID', expr: 'ID' }],
      materialization: { type: 'view' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('accepts spec with optional metadata but no tags', () => {
    const input = {
      spec_version: '0.2',
      name: 'stg_orders',
      type: 'model',
      description: 'Staging orders.',
      grain: 'order_id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ORDER_ID', expr: 'ID' }],
      materialization: { type: 'view' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toBeUndefined();
    }
  });

  it('accepts grain as string and as array', () => {
    const base = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'view' },
    };

    const stringResult = TransformSpecSchema.safeParse({ ...base, grain: 'order_id' });
    expect(stringResult.success).toBe(true);
    if (stringResult.success) {
      expect(stringResult.data.grain).toBe('order_id');
    }

    const arrayResult = TransformSpecSchema.safeParse({ ...base, grain: ['order_id', 'line_id'] });
    expect(arrayResult.success).toBe(true);
    if (arrayResult.success) {
      expect(arrayResult.data.grain).toEqual(['order_id', 'line_id']);
    }
  });

  it('accepts source.filter', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders', filter: "STATUS = 'active'" },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'view' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source.filter).toBe("STATUS = 'active'");
    }
  });

  it('rejects invalid semantic_role value', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID', semantic_role: 'invalid_role' }],
      materialization: { type: 'view' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Materialization types
  // -----------------------------------------------------------------------

  it('accepts materialization type: table', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'table' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.materialization.type).toBe('table');
    }
  });

  it('accepts materialization type: incremental with merge and unique_key', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'incremental', strategy: 'merge', unique_key: 'id' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.materialization.type).toBe('incremental');
    }
  });

  it('rejects incremental merge without unique_key', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'incremental', strategy: 'merge' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects incremental delete_insert without unique_key', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'incremental', strategy: 'delete_insert' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('warns on incremental append without incremental_filter', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'incremental', strategy: 'append' },
    };

    const result = TransformSpecSchema.safeParse(input);
    // superRefine emits a validation warning for append without incremental_filter
    expect(result.success).toBe(false);
  });

  it('accepts incremental append with incremental_filter', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: {
        type: 'incremental',
        strategy: 'append',
        incremental_filter: "created_at > '2024-01-01'",
      },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('accepts materialization type: ephemeral', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'ephemeral' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.materialization.type).toBe('ephemeral');
    }
  });

  it('accepts pre_hook and post_hook arrays with safe SQL', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'view' },
      pre_hook: ['CALL refresh_cache({schema}, {name})'],
      post_hook: ['CALL notify_complete({schema}, {name})'],
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pre_hook).toEqual(['CALL refresh_cache({schema}, {name})']);
      expect(result.data.post_hook).toEqual(['CALL notify_complete({schema}, {name})']);
    }
  });

  it('accepts hooks using CALL, EXEC, CREATE, INSERT (allowed in hooks)', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'view' },
      pre_hook: [
        'CALL refresh_cache({schema}, {name})',
        'EXEC sp_update()',
        'CREATE TABLE IF NOT EXISTS staging.tmp AS SELECT 1',
      ],
      post_hook: ['INSERT INTO audit_log VALUES (CURRENT_TIMESTAMP)'],
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('rejects hooks containing destructive DDL (DROP, TRUNCATE)', () => {
    for (const hook of [
      'DROP TABLE users',
      'TRUNCATE TABLE orders',
      'DELETE FROM logs',
      'GRANT ALL ON users',
    ]) {
      const input = {
        spec_version: '0.2',
        name: 'test',
        type: 'model',
        description: 'Test model.',
        grain: 'id',
        source: { ref: 'ecom.raw_orders' },
        columns: [{ name: 'ID', expr: 'ID' }],
        materialization: { type: 'view' },
        pre_hook: [hook],
      };
      const result = TransformSpecSchema.safeParse(input);
      expect(result.success).toBe(false);
    }
  });

  it('rejects hooks containing dangerous SQL', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'view' },
      pre_hook: ['DROP TABLE users'],
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('accepts tests array', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'view' },
      tests: [
        { type: 'not_null', column: 'ID' },
        { type: 'unique', column: 'ID' },
        { type: 'accepted_values', column: 'STATUS', values: ['active', 'inactive'] },
        { type: 'custom', sql: 'SELECT COUNT(*) FROM {name} WHERE amount < 0' },
      ],
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tests).toHaveLength(4);
    }
  });

  it('accepts expect block', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [
        { name: 'ID', expr: 'ID' },
        { name: 'EMAIL', expr: 'EMAIL' },
        { name: 'AGE', expr: 'AGE' },
        { name: 'STATUS', expr: 'STATUS' },
      ],
      materialization: { type: 'view' },
      expect: [
        { kind: 'primary_key', columns: ['ID'] },
        { kind: 'non_null', column: 'EMAIL', severity: 'warn' },
        { kind: 'unique', columns: ['EMAIL'] },
        { kind: 'in_range', column: 'AGE', min: 0, max: 150 },
        { kind: 'regex', column: 'EMAIL', pattern: '^.+@.+$' },
        { kind: 'schema_contains', columns: ['ID', 'EMAIL'] },
        { kind: 'row_count_between', min: 1, max: 1000 },
        { kind: 'accepted_values', column: 'STATUS', values: ['active', 'inactive', true] },
        { kind: 'expression', expression: 'AGE >= 0' },
        {
          kind: 'custom',
          sql: 'SELECT COUNT(*) AS violation_count FROM {model} WHERE AGE < 0',
        },
      ],
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.expect).toHaveLength(10);
      expect(result.data.expect[0]!.severity).toBe('error');
      expect(result.data.expect[1]!.severity).toBe('warn');
    }
  });

  it('rejects invalid expectation severity', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'view' },
      expect: [{ kind: 'non_null', column: 'ID', severity: 'info' }],
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects dangerous expression expectations', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'view' },
      expect: [{ kind: 'expression', expression: 'ID > 0; DROP TABLE users' }],
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects custom expectations without violation_count alias', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'view' },
      expect: [{ kind: 'custom', sql: 'SELECT COUNT(*) FROM {model}' }],
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('parses column with all metadata fields', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [
        {
          name: 'AMOUNT',
          expr: 'TOTAL',
          description: 'Total amount',
          type: 'NUMERIC(16,2)',
          primary_key: false,
          semantic_role: 'measure',
          references: 'dim_currency.id',
          tags: ['financial'],
          business_rule: 'Sum of line items',
          quality_notes: 'May contain nulls for draft orders',
          owner: 'finance-team',
          deprecated: true,
        },
      ],
      materialization: { type: 'view' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      const col = result.data.columns[0]!;
      expect(col.description).toBe('Total amount');
      expect(col.semantic_role).toBe('measure');
      expect(col.deprecated).toBe(true);
      expect(col.tags).toEqual(['financial']);
    }
  });

  it('defaults trust_tier to bronze', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'view' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trust_tier).toBe('bronze');
    }
  });

  it('accepts explicit trust_tier', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      trust_tier: 'gold',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'view' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trust_tier).toBe('gold');
    }
  });

  it('accepts trust_config', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      trust_config: {
        promotion_tests: [{ type: 'backtest', query: 'SELECT 1' }],
        demotion_triggers: ['test_failure'],
      },
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'view' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trust_config).toBeDefined();
      expect(result.data.trust_config!.promotion_tests).toHaveLength(1);
    }
  });

  it('accepts not_null on columns', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID', not_null: true }],
      materialization: { type: 'view' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.columns[0]!.not_null).toBe(true);
    }
  });

  it('accepts materialization type: dynamic_table', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'dynamic_table' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.materialization.type).toBe('dynamic_table');
    }
  });

  it('rejects unknown dynamic_table materialization options', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'dynamic_table', warehoues: 'TRANSFORM_WH' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('accepts materialization type: materialized_view', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'materialized_view' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.materialization.type).toBe('materialized_view');
    }
  });

  it('rejects unknown materialized_view materialization options', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'materialized_view', max_stalness: '1 hour' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('accepts group_by', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      group_by: ['ID'],
      materialization: { type: 'view' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.group_by).toEqual(['ID']);
    }
  });

  it('accepts derived_columns', () => {
    const input = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      derived_columns: [{ name: 'doubled_id', expr: 'ID * 2' }],
      materialization: { type: 'view' },
    };

    const result = TransformSpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.derived_columns).toHaveLength(1);
    }
  });

  // -----------------------------------------------------------------------
  // flatten_json validation
  // -----------------------------------------------------------------------

  describe('flatten_json validation', () => {
    const base = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'view' },
    };

    it.each(['items', 'data.items', 'data[0].name', 'nested.deep.path'])(
      'accepts valid flatten_json path: %s',
      (path) => {
        const result = TransformSpecSchema.safeParse({
          ...base,
          flatten_json: { column: 'PAYLOAD', path },
        });
        expect(result.success).toBe(true);
      }
    );

    it.each(['path with spaces', 'path;injection', "path'quote"])(
      'rejects invalid flatten_json path: %s',
      (path) => {
        const result = TransformSpecSchema.safeParse({
          ...base,
          flatten_json: { column: 'PAYLOAD', path },
        });
        expect(result.success).toBe(false);
      }
    );

    it('rejects column that fails identifierRegex', () => {
      const result = TransformSpecSchema.safeParse({ ...base, flatten_json: { column: '1bad' } });
      expect(result.success).toBe(false);
    });

    it('rejects alias that fails identifierRegex', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        flatten_json: { column: 'PAYLOAD', alias: 'has space' },
      });
      expect(result.success).toBe(false);
    });

    it('accepts valid alias', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        flatten_json: { column: 'PAYLOAD', alias: 'flat_data' },
      });
      expect(result.success).toBe(true);
    });

    it.each(['t0', 'T0', 't1', 'T1', 't2', 'T2', 't10', 'T10', 't999', 'T999'])(
      'rejects alias that matches auto-generated source alias: %s',
      (alias) => {
        const result = TransformSpecSchema.safeParse({
          ...base,
          flatten_json: { column: 'PAYLOAD', alias },
        });
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues).toContainEqual(
            expect.objectContaining({
              message: expect.stringContaining('auto-generated'),
            })
          );
        }
      }
    );

    it('rejects a step that sets both column and input', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        flatten_json: { column: 'PAYLOAD', input: 'outer_f.value' },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            message: expect.stringContaining('not both'),
          })
        );
      }
    });

    it('rejects a step that sets neither column nor input', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        flatten_json: { path: 'items' },
      });
      expect(result.success).toBe(false);
    });

    it('accepts a chained flatten_json array', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        flatten_json: [
          { column: 'PAYLOAD', alias: 'outer_f' },
          { input: 'outer_f.value', alias: 'inner_f' },
        ],
      });
      expect(result.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Pivot aggregate allowlist
  // -----------------------------------------------------------------------

  describe('pivot aggregate validation', () => {
    const base = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'view' },
    };
    const pivotBase = { column: 'STATUS', values: ['a', 'b'], value_column: 'AMOUNT' };

    it.each([
      'sum',
      'SUM',
      'count',
      'avg',
      'min',
      'max',
      'array_agg',
      'string_agg',
      'count_if',
      'approx_count_distinct',
    ])('accepts aggregate: %s', (aggregate) => {
      const result = TransformSpecSchema.safeParse({ ...base, pivot: { ...pivotBase, aggregate } });
      expect(result.success).toBe(true);
    });

    it.each(['DROP TABLE', 'invalid_func', '1; DROP'])(
      'rejects invalid aggregate: %s',
      (aggregate) => {
        const result = TransformSpecSchema.safeParse({
          ...base,
          pivot: { ...pivotBase, aggregate },
        });
        expect(result.success).toBe(false);
      }
    );

    it('rejects pivot column that fails identifierRegex', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        pivot: { ...pivotBase, aggregate: 'sum', column: '123bad' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects pivot value_column that fails identifierRegex', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        pivot: { ...pivotBase, aggregate: 'sum', value_column: 'has space' },
      });
      expect(result.success).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // unpivot
  // -----------------------------------------------------------------------

  describe('unpivot', () => {
    const base = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'view' },
    };

    const unpivotBase = {
      columns: ['jan_amount', 'feb_amount'],
      field_name: 'month',
      value_name: 'amount',
    };

    it('accepts valid unpivot', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        unpivot: unpivotBase,
      });
      expect(result.success).toBe(true);
    });

    it('accepts unpivot with optional exclude', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        unpivot: { ...unpivotBase, exclude: ['order_id'] },
      });
      expect(result.success).toBe(true);
    });

    it('accepts unpivot with optional cast_to', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        unpivot: { ...unpivotBase, cast_to: 'VARCHAR' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects unpivot with malicious cast_to', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        unpivot: { ...unpivotBase, cast_to: 'VARCHAR); DROP TABLE x;--' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects unpivot columns that fails identifierRegex', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        unpivot: { columns: ['123bad'], field_name: 'month', value_name: 'amount' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty unpivot columns', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        unpivot: { columns: [], field_name: 'month', value_name: 'amount' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects when both pivot and unpivot are specified', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        pivot: { column: 'STATUS', values: ['a', 'b'], aggregate: 'sum', value_column: 'AMOUNT' },
        unpivot: unpivotBase,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((issue) => issue.message.includes('pivot and unpivot'))
        ).toBe(true);
      }
    });
  });

  // -----------------------------------------------------------------------
  // group_by identifierRegex
  // -----------------------------------------------------------------------

  describe('group_by identifier validation', () => {
    const base = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'view' },
    };

    it('accepts valid group_by identifiers', () => {
      const result = TransformSpecSchema.safeParse({ ...base, group_by: ['user_id', 'status'] });
      expect(result.success).toBe(true);
    });

    it.each([['1invalid'], ['has space'], ['semi;colon']])(
      'rejects invalid group_by identifier: %s',
      (invalid) => {
        const result = TransformSpecSchema.safeParse({ ...base, group_by: [invalid] });
        expect(result.success).toBe(false);
      }
    );

    it('accepts qualified (dotted) group_by identifiers for join disambiguation', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        group_by: ['orders.customer_id', 'status', 'customers.name'],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.group_by).toEqual(['orders.customer_id', 'status', 'customers.name']);
      }
    });

    it('accepts multi-part dotted group_by identifiers for source refs', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        group_by: ['ecom.raw_orders.customer_id', 'status'],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.group_by).toEqual(['ecom.raw_orders.customer_id', 'status']);
      }
    });

    it.each([['orders.'], ['.column'], ['orders..col']])(
      'rejects invalid dotted group_by identifier: %s',
      (invalid) => {
        const result = TransformSpecSchema.safeParse({ ...base, group_by: [invalid] });
        expect(result.success).toBe(false);
      }
    );
  });

  // -----------------------------------------------------------------------
  // pre_aggregate.group_by identifierRegex
  // -----------------------------------------------------------------------

  describe('pre_aggregate.group_by validation', () => {
    const base = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'view' },
    };

    it('accepts valid pre_aggregate group_by', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        joins: [
          {
            ref: 'ecom.raw_items',
            type: 'left',
            on: 'a = b',
            pre_aggregate: {
              group_by: ['order_id'],
              columns: [{ name: 'TOTAL', expr: 'SUM(AMOUNT)' }],
            },
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid pre_aggregate group_by', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        joins: [
          {
            ref: 'ecom.raw_items',
            type: 'left',
            on: 'a = b',
            pre_aggregate: {
              group_by: ['123bad'],
              columns: [{ name: 'TOTAL', expr: 'SUM(AMOUNT)' }],
            },
          },
        ],
      });
      expect(result.success).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Union branch validation
  // -----------------------------------------------------------------------

  describe('union branch validation', () => {
    const base = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'view' },
    };

    it('accepts union branch with ref only', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        union: [{ ref: 'ecom.other_orders' }],
      });
      expect(result.success).toBe(true);
    });

    it('rejects union branch without ref', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        union: [{ filter: "STATUS = 'active'" }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects union branch with empty ref', () => {
      const result = TransformSpecSchema.safeParse({ ...base, union: [{ ref: '' }] });
      expect(result.success).toBe(false);
    });

    it('rejects union branch column name failing identifierRegex', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        union: [{ ref: 'ecom.other', columns: [{ name: '1bad', expr: 'ID' }] }],
      });
      expect(result.success).toBe(false);
    });

    it('accepts union branch with include_all_columns', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        union: [{ ref: 'ecom.other_orders', include_all_columns: true }],
      });
      expect(result.success).toBe(true);
    });

    it('accepts union branch with include_all_columns + exclude_columns + columns', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        union: [
          {
            ref: 'ecom.other_orders',
            include_all_columns: true,
            exclude_columns: ['INTERNAL'],
            columns: [{ name: 'CUSTOMER_ID', expr: "'partner'" }],
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('rejects union branch with exclude_columns but no include_all_columns', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        union: [{ ref: 'ecom.other_orders', exclude_columns: ['INTERNAL'] }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects union branch with empty columns array', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        union: [{ ref: 'ecom.other_orders', columns: [] }],
      });
      expect(result.success).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Trust tier + trust_config
  // -----------------------------------------------------------------------

  describe('trust_tier and trust_config', () => {
    const base = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: { type: 'view' },
    };

    it.each(['bronze', 'silver', 'gold'])('accepts trust_tier: %s', (tier) => {
      const result = TransformSpecSchema.safeParse({ ...base, trust_tier: tier });
      expect(result.success).toBe(true);
    });

    it('rejects invalid trust_tier', () => {
      const result = TransformSpecSchema.safeParse({ ...base, trust_tier: 'platinum' });
      expect(result.success).toBe(false);
    });

    it('accepts canary promotion test with mode', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        trust_config: { promotion_tests: [{ type: 'canary', mode: 'delta', query: 'SELECT 1' }] },
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid demotion_triggers', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        trust_config: {
          demotion_triggers: ['source_schema_change', 'test_failure', 'canary_failure'],
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid demotion_trigger', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        trust_config: { demotion_triggers: ['invalid_trigger'] },
      });
      expect(result.success).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Materialization type validation
  // -----------------------------------------------------------------------

  describe('materialization types', () => {
    const base = {
      spec_version: '0.2',
      name: 'test',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'ID', expr: 'ID' }],
    };

    it('rejects unknown materialization type', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        materialization: { type: 'snapshot' },
      });
      expect(result.success).toBe(false);
    });

    it('accepts merge with array unique_key', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        materialization: {
          type: 'incremental',
          strategy: 'merge',
          unique_key: ['order_id', 'line_id'],
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts delete_insert with single unique_key', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        materialization: { type: 'incremental', strategy: 'delete_insert', unique_key: 'order_id' },
      });
      expect(result.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // New DSL features: variables, where, having, order_by
  // -----------------------------------------------------------------------

  describe('variables', () => {
    const base = {
      spec_version: '0.2',
      name: 'test_model',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'test_source' },
      columns: [{ name: 'id', expr: 'id' }],
      materialization: { type: 'view' },
    };

    it('accepts numeric variables', () => {
      const result = TransformSpecSchema.safeParse({ ...base, variables: { limit: 100 } });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.variables).toEqual({ limit: 100 });
      }
    });

    it('accepts string variables', () => {
      const result = TransformSpecSchema.safeParse({ ...base, variables: { status: 'active' } });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.variables).toEqual({ status: 'active' });
      }
    });

    it('accepts boolean variables', () => {
      const result = TransformSpecSchema.safeParse({ ...base, variables: { enabled: true } });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.variables).toEqual({ enabled: true });
      }
    });

    it('accepts mixed variable types', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        variables: { count: 42, name: 'test', active: false },
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid variable names (starting with digit)', () => {
      const result = TransformSpecSchema.safeParse({ ...base, variables: { '123bad': 1 } });
      expect(result.success).toBe(false);
    });

    it('rejects invalid variable names (contains spaces)', () => {
      const result = TransformSpecSchema.safeParse({ ...base, variables: { 'bad name': 1 } });
      expect(result.success).toBe(false);
    });

    it('accepts empty variables object', () => {
      const result = TransformSpecSchema.safeParse({ ...base, variables: {} });
      expect(result.success).toBe(true);
    });

    it('omits variables when not provided', () => {
      const result = TransformSpecSchema.safeParse(base);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.variables).toBeUndefined();
      }
    });
  });

  describe('where clause', () => {
    const base = {
      spec_version: '0.2',
      name: 'test_model',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'test_source' },
      columns: [{ name: 'id', expr: 'id' }],
      materialization: { type: 'view' },
    };

    it('accepts a valid where clause', () => {
      const result = TransformSpecSchema.safeParse({ ...base, where: 'status = 1' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.where).toBe('status = 1');
      }
    });

    it('accepts where with string comparison', () => {
      const result = TransformSpecSchema.safeParse({ ...base, where: "region = 'US'" });
      expect(result.success).toBe(true);
    });

    it('accepts where with AND/OR', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        where: "status = 'active' AND amount > 0",
      });
      expect(result.success).toBe(true);
    });

    it('rejects dangerous SQL in where (DROP)', () => {
      const result = TransformSpecSchema.safeParse({ ...base, where: 'DROP TABLE users' });
      expect(result.success).toBe(false);
    });

    it('rejects dangerous SQL in where (DELETE)', () => {
      const result = TransformSpecSchema.safeParse({ ...base, where: 'DELETE FROM users' });
      expect(result.success).toBe(false);
    });

    it('rejects semicolons in where', () => {
      const result = TransformSpecSchema.safeParse({ ...base, where: 'status = 1; DROP TABLE x' });
      expect(result.success).toBe(false);
    });

    it.each([
      'EXEC sp_test',
      'EXECUTE sp_test',
      'CALL my_proc()',
      'COPY INTO t',
      'LOAD DATA',
      'UNLOAD TO s3',
    ])('rejects dangerous command in where: %s', (dangerous) => {
      const result = TransformSpecSchema.safeParse({ ...base, where: dangerous });
      expect(result.success).toBe(false);
    });

    it.each([
      'x = 1 UNION SELECT secret FROM credentials',
      'x = 1 UNION ALL SELECT secret FROM credentials',
      'x = 1 EXCEPT SELECT id FROM public_ids',
      'x = 1 INTERSECT SELECT id FROM other',
      'x = 1 EXCEPT ALL SELECT id FROM public_ids',
      'x = 1 INTERSECT ALL SELECT id FROM other',
    ])('rejects UNION/EXCEPT/INTERSECT injection in where: %s', (dangerous) => {
      const result = TransformSpecSchema.safeParse({ ...base, where: dangerous });
      expect(result.success).toBe(false);
    });

    it('omits where when not provided', () => {
      const result = TransformSpecSchema.safeParse(base);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.where).toBeUndefined();
      }
    });
  });

  describe('having clause', () => {
    const base = {
      spec_version: '0.2',
      name: 'test_model',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'test_source' },
      columns: [{ name: 'id', expr: 'id' }],
      materialization: { type: 'view' },
    };

    it('accepts a valid having clause', () => {
      const result = TransformSpecSchema.safeParse({ ...base, having: 'COUNT(*) > 0' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.having).toBe('COUNT(*) > 0');
      }
    });

    it('accepts having with SUM', () => {
      const result = TransformSpecSchema.safeParse({ ...base, having: 'SUM(amount) >= 100' });
      expect(result.success).toBe(true);
    });

    it('rejects dangerous SQL in having', () => {
      const result = TransformSpecSchema.safeParse({ ...base, having: 'DROP TABLE users' });
      expect(result.success).toBe(false);
    });

    it('omits having when not provided', () => {
      const result = TransformSpecSchema.safeParse(base);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.having).toBeUndefined();
      }
    });
  });

  describe('order_by clause', () => {
    const base = {
      spec_version: '0.2',
      name: 'test_model',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'test_source' },
      columns: [{ name: 'id', expr: 'id' }],
      materialization: { type: 'view' },
    };

    it('accepts order_by with column and direction', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        order_by: [{ column: 'name', direction: 'desc' }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.order_by).toHaveLength(1);
        expect(result.data.order_by![0]!.column).toBe('name');
        expect(result.data.order_by![0]!.direction).toBe('desc');
      }
    });

    it('accepts order_by without direction', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        order_by: [{ column: 'name' }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.order_by![0]!.direction).toBeUndefined();
      }
    });

    it('accepts order_by with asc direction', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        order_by: [{ column: 'name', direction: 'asc' }],
      });
      expect(result.success).toBe(true);
    });

    it('accepts multiple order_by entries', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        order_by: [
          { column: 'name', direction: 'asc' },
          { column: 'age', direction: 'desc' },
          { column: 'id' },
        ],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.order_by).toHaveLength(3);
      }
    });

    it('rejects invalid direction', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        order_by: [{ column: 'name', direction: 'invalid' }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid column name', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        order_by: [{ column: '123bad' }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty column name', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        order_by: [{ column: '' }],
      });
      expect(result.success).toBe(false);
    });

    it('omits order_by when not provided', () => {
      const result = TransformSpecSchema.safeParse(base);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.order_by).toBeUndefined();
      }
    });
  });

  // -----------------------------------------------------------------------
  // include_all_columns + exclude_columns
  // -----------------------------------------------------------------------

  describe('include_all_columns and exclude_columns', () => {
    const base = {
      spec_version: '0.2',
      name: 'test_model',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'test_source' },
      materialization: { type: 'view' },
    };

    it('accepts include_all_columns: true with no columns', () => {
      const result = TransformSpecSchema.safeParse({ ...base, include_all_columns: true });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.include_all_columns).toBe(true);
        expect(result.data.columns).toEqual([]);
      }
    });

    it('accepts include_all_columns: true with additional columns', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        include_all_columns: true,
        columns: [{ name: 'EXTRA', expr: 'SOME_EXPR' }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.include_all_columns).toBe(true);
        expect(result.data.columns).toHaveLength(1);
      }
    });

    it('rejects empty columns when include_all_columns is not set', () => {
      const result = TransformSpecSchema.safeParse({ ...base });
      expect(result.success).toBe(false);
    });

    it('accepts exclude_columns with include_all_columns', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        include_all_columns: true,
        exclude_columns: ['INTERNAL_ID', 'CREATED_BY'],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.exclude_columns).toEqual(['INTERNAL_ID', 'CREATED_BY']);
      }
    });

    it('rejects exclude_columns without include_all_columns', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        columns: [{ name: 'ID', expr: 'ID' }],
        exclude_columns: ['INTERNAL_ID'],
      });
      expect(result.success).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // distinct
  // -----------------------------------------------------------------------

  describe('distinct', () => {
    const base = {
      spec_version: '0.2',
      name: 'test_model',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'test_source' },
      columns: [{ name: 'id', expr: 'id' }],
      materialization: { type: 'view' },
    };

    it('accepts distinct: true', () => {
      const result = TransformSpecSchema.safeParse({ ...base, distinct: true });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.distinct).toBe(true);
      }
    });

    it('accepts distinct: false', () => {
      const result = TransformSpecSchema.safeParse({ ...base, distinct: false });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.distinct).toBe(false);
      }
    });

    it('omits distinct when not provided', () => {
      const result = TransformSpecSchema.safeParse(base);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.distinct).toBeUndefined();
      }
    });
  });

  // -----------------------------------------------------------------------
  // qualify clause
  // -----------------------------------------------------------------------

  describe('qualify clause', () => {
    const base = {
      spec_version: '0.2',
      name: 'test_model',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'test_source' },
      columns: [{ name: 'id', expr: 'id' }],
      materialization: { type: 'view' },
    };

    it('accepts valid qualify expression', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        qualify: 'ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) = 1',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.qualify).toBe(
          'ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) = 1'
        );
      }
    });

    it('rejects dangerous SQL in qualify (DROP)', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        qualify: 'DROP TABLE users',
      });
      expect(result.success).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // limit / offset
  // -----------------------------------------------------------------------

  describe('limit and offset', () => {
    const base = {
      spec_version: '0.2',
      name: 'test_model',
      type: 'model',
      description: 'Test model.',
      grain: 'id',
      source: { ref: 'test_source' },
      columns: [{ name: 'id', expr: 'id' }],
      materialization: { type: 'view' },
    };

    it('accepts limit only', () => {
      const result = TransformSpecSchema.safeParse({ ...base, limit: 100 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(100);
      }
    });

    it('accepts limit with offset', () => {
      const result = TransformSpecSchema.safeParse({ ...base, limit: 50, offset: 10 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(50);
        expect(result.data.offset).toBe(10);
      }
    });

    it('rejects offset without limit', () => {
      const result = TransformSpecSchema.safeParse({ ...base, offset: 10 });
      expect(result.success).toBe(false);
    });

    it('rejects negative limit', () => {
      const result = TransformSpecSchema.safeParse({ ...base, limit: -5 });
      expect(result.success).toBe(false);
    });

    it('rejects non-integer limit', () => {
      const result = TransformSpecSchema.safeParse({ ...base, limit: 10.5 });
      expect(result.success).toBe(false);
    });
  });

  describe('grain validation', () => {
    const grainBase = {
      spec_version: '0.2' as const,
      name: 'test_model',
      type: 'model' as const,
      description: 'Test model for grain validation.',
      source: { ref: 'ecom.raw_orders' },
      materialization: { type: 'view' as const },
    };

    it('accepts valid grain identifiers', () => {
      const result = TransformSpecSchema.safeParse({
        ...grainBase,
        grain: 'order_id',
        columns: [{ name: 'order_id', expr: 'ID' }],
      });
      expect(result.success).toBe(true);
    });

    it('accepts composite grain as array of identifiers', () => {
      const result = TransformSpecSchema.safeParse({
        ...grainBase,
        grain: ['order_id', 'line_id'],
        columns: [
          { name: 'order_id', expr: 'ID' },
          { name: 'line_id', expr: 'LINE_ID' },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid grain identifier with spaces', () => {
      const result = TransformSpecSchema.safeParse({
        ...grainBase,
        grain: 'has spaces',
        columns: [{ name: 'order_id', expr: 'ID' }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid grain identifier with dashes', () => {
      const result = TransformSpecSchema.safeParse({
        ...grainBase,
        grain: ['valid_id', 'has-dashes'],
        columns: [{ name: 'valid_id', expr: 'ID' }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid grain identifier starting with number', () => {
      const result = TransformSpecSchema.safeParse({
        ...grainBase,
        grain: '123invalid',
        columns: [{ name: 'order_id', expr: 'ID' }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('target_schema and target_database', () => {
    const base = {
      spec_version: '0.2' as const,
      name: 'my_model',
      type: 'model' as const,
      description: 'test model',
      grain: 'id',
      source: { ref: 'ecom.raw_orders' },
      columns: [{ name: 'id', expr: 'ID' }],
      materialization: { type: 'view' as const },
    };

    it('accepts valid target_schema', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        target_schema: 'analytics_schema',
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid target_database', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        target_database: 'prod_db',
      });
      expect(result.success).toBe(true);
    });

    it('accepts both target_schema and target_database', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        target_schema: 'analytics',
        target_database: 'prod_db',
      });
      expect(result.success).toBe(true);
    });

    it('rejects target_schema with invalid identifier', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        target_schema: 'invalid-schema',
      });
      expect(result.success).toBe(false);
    });

    it('rejects target_database with invalid identifier', () => {
      const result = TransformSpecSchema.safeParse({
        ...base,
        target_database: '123invalid',
      });
      expect(result.success).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Snapshot materialization schema validation
  // -----------------------------------------------------------------------

  describe('snapshot materialization', () => {
    const snapshotBase = {
      spec_version: '0.2' as const,
      name: 'scd_customers',
      type: 'model' as const,
      description: 'SCD Type 2 customers.',
      grain: 'customer_id',
      source: { ref: 'ecom.raw_customers' },
      columns: [
        { name: 'customer_id', expr: 'ID' },
        { name: 'name', expr: 'NAME' },
        { name: 'status', expr: 'STATUS' },
      ],
    };

    it('validates with required unique_key', () => {
      const result = TransformSpecSchema.safeParse({
        ...snapshotBase,
        materialization: { type: 'snapshot', unique_key: 'customer_id' },
      });
      expect(result.success).toBe(true);
    });

    it('validates with array unique_key', () => {
      const result = TransformSpecSchema.safeParse({
        ...snapshotBase,
        materialization: { type: 'snapshot', unique_key: ['customer_id', 'region'] },
      });
      expect(result.success).toBe(true);
    });

    it('rejects without unique_key', () => {
      const result = TransformSpecSchema.safeParse({
        ...snapshotBase,
        materialization: { type: 'snapshot' },
      });
      expect(result.success).toBe(false);
    });

    it('accepts optional tracked_columns', () => {
      const result = TransformSpecSchema.safeParse({
        ...snapshotBase,
        materialization: {
          type: 'snapshot',
          unique_key: 'customer_id',
          tracked_columns: ['name', 'status'],
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts optional valid_from_column and valid_to_column', () => {
      const result = TransformSpecSchema.safeParse({
        ...snapshotBase,
        materialization: {
          type: 'snapshot',
          unique_key: 'customer_id',
          valid_from_column: 'effective_start',
          valid_to_column: 'effective_end',
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects tracked_columns overlapping with unique_key', () => {
      const result = TransformSpecSchema.safeParse({
        ...snapshotBase,
        materialization: {
          type: 'snapshot',
          unique_key: 'customer_id',
          tracked_columns: ['customer_id', 'name'],
        },
      });
      expect(result.success).toBe(false);
    });

    it('rejects tracked_columns overlapping with array unique_key', () => {
      const result = TransformSpecSchema.safeParse({
        ...snapshotBase,
        materialization: {
          type: 'snapshot',
          unique_key: ['customer_id', 'region'],
          tracked_columns: ['region', 'name'],
        },
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('per-reference read_mode (mixed-model authoring metadata)', () => {
  const base = {
    spec_version: '0.2',
    name: 'mm_accounts',
    type: 'model',
    description: 'Mixed model joining a live API source with a warehouse leaf.',
    grain: 'id',
    source: { ref: 'crm.accounts' },
    columns: [{ name: 'ID', expr: 'crm.accounts.ID' }],
    materialization: { type: 'view' },
  } as const;

  it('accepts read_mode on the primary source', () => {
    const result = TransformSpecSchema.safeParse({
      ...base,
      source: { ref: 'crm.accounts', read_mode: 'lazy' },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.source.read_mode).toBe('lazy');
  });

  it('accepts read_mode on a joins[] entry', () => {
    const result = TransformSpecSchema.safeParse({
      ...base,
      joins: [
        {
          ref: 'wh.budgets',
          type: 'left',
          on: 'crm.accounts.ID = wh.budgets.ACCOUNT_ID',
          read_mode: 'live',
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.joins[0]?.read_mode).toBe('live');
  });

  it('accepts read_mode on a union[] branch', () => {
    const result = TransformSpecSchema.safeParse({
      ...base,
      include_all_columns: true,
      union: [{ ref: 'wh.accounts_eu', read_mode: 'lazy', include_all_columns: true }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const branch = result.data.union?.[0] as { read_mode?: string } | undefined;
      expect(branch?.read_mode).toBe('lazy');
    }
  });

  it('treats read_mode as optional — omitting it leaves it undefined', () => {
    const result = TransformSpecSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.source.read_mode).toBeUndefined();
  });

  it('rejects a read_mode outside the live|lazy enum', () => {
    const result = TransformSpecSchema.safeParse({
      ...base,
      source: { ref: 'crm.accounts', read_mode: 'cached' },
    });
    expect(result.success).toBe(false);
  });
});
