import { indexProjectFiles } from '@bobsled-inc/project-index';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { indexedRelationshipKeyWarnings } from '../../../src/api/relationship-keys.js';
import { relationshipKeyWarnings } from '../../../src/entities/relationship-keys.js';
import {
  RelationshipSpecSchema,
  type RelationshipType,
} from '../../../src/entities/relationship.js';

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

describe('relationshipKeyWarnings', () => {
  const keys: Record<string, string[]> = {
    fct_orders: ['order_id'],
    dim_customers: ['customer_id'],
    dim_accounts: [],
    fct_order_items: ['tenant_id', 'order_id', 'line_number'],
    fct_tenant_orders: ['Tenant_ID', 'ORDER_ID'],
  };
  const primaryKeyOf = (dataset: string) => keys[dataset];
  const relationship = (
    relationship_type: RelationshipType,
    left_model: string,
    right_model: string,
    join_columns: Array<{ left: string; right: string }>
  ) => ({ name: 'orders_link', relationship_type, left_model, right_model, join_columns });
  const codes = (warnings: ReturnType<typeof relationshipKeyWarnings>) =>
    warnings.map((warning) => [warning.code, warning.side, warning.dataset]);

  it('warns when the one side of a many_to_one declares no primary key', () => {
    const warnings = relationshipKeyWarnings(
      relationship('many_to_one', 'fct_orders', 'dim_accounts', [
        { left: 'account_id', right: 'account_id' },
      ]),
      primaryKeyOf
    );
    expect(warnings).toEqual([
      {
        code: 'relationship_target_key_missing',
        relationship: 'orders_link',
        side: 'right',
        dataset: 'dim_accounts',
        primaryKey: [],
        joinColumns: ['account_id'],
        message:
          'Relationship orders_link is many_to_one, so dim_accounts must be unique on its join columns (account_id), but dim_accounts declares no primary key.',
        remedy:
          'Mark the columns that identify each dim_accounts row with primary_key: true, and join on them.',
      },
    ]);
  });

  it('warns when the one side joins on columns other than its primary key', () => {
    const [warning] = relationshipKeyWarnings(
      relationship('many_to_one', 'fct_orders', 'dim_customers', [
        { left: 'customer_email', right: 'email' },
      ]),
      primaryKeyOf
    );
    expect(warning).toMatchObject({
      code: 'relationship_target_key_mismatch',
      side: 'right',
      dataset: 'dim_customers',
      primaryKey: ['customer_id'],
      joinColumns: ['email'],
      message:
        'Relationship orders_link is many_to_one, so dim_customers must be unique on its join columns (email), but its declared primary key is customer_id.',
      remedy: 'Join on customer_id, or correct the primary_key columns of dim_customers.',
    });
  });

  it('accepts a one side that joins on its primary key', () => {
    expect(
      relationshipKeyWarnings(
        relationship('many_to_one', 'fct_orders', 'dim_customers', [
          { left: 'customer_id', right: 'customer_id' },
        ]),
        primaryKeyOf
      )
    ).toEqual([]);
  });

  it('checks the left dataset of a one_to_many relationship', () => {
    const warnings = relationshipKeyWarnings(
      relationship('one_to_many', 'dim_customers', 'fct_orders', [
        { left: 'email', right: 'order_id' },
      ]),
      primaryKeyOf
    );
    expect(codes(warnings)).toEqual([
      ['relationship_target_key_mismatch', 'left', 'dim_customers'],
    ]);
  });

  it('checks both datasets of a one_to_one relationship', () => {
    const warnings = relationshipKeyWarnings(
      relationship('one_to_one', 'dim_accounts', 'dim_customers', [
        { left: 'account_id', right: 'account_id' },
      ]),
      primaryKeyOf
    );
    expect(codes(warnings)).toEqual([
      ['relationship_target_key_missing', 'left', 'dim_accounts'],
      ['relationship_target_key_mismatch', 'right', 'dim_customers'],
    ]);
  });

  it('skips many_to_many relationships and datasets it cannot resolve', () => {
    const join = [{ left: 'account_id', right: 'account_id' }];
    expect(
      relationshipKeyWarnings(
        relationship('many_to_many', 'dim_accounts', 'dim_accounts', join),
        primaryKeyOf
      )
    ).toEqual([]);
    expect(
      relationshipKeyWarnings(
        relationship('many_to_one', 'fct_orders', 'unknown', join),
        primaryKeyOf
      )
    ).toEqual([]);
  });

  it('compares composite keys as sets, ignoring order and case', () => {
    const join = [
      { left: 'order_id', right: 'order_id' },
      { left: 'tenant_id', right: 'tenant_id' },
    ];
    expect(
      relationshipKeyWarnings(
        relationship('many_to_one', 'fct_order_items', 'fct_tenant_orders', join),
        primaryKeyOf
      )
    ).toEqual([]);
    expect(
      codes(
        relationshipKeyWarnings(
          relationship('one_to_many', 'fct_order_items', 'fct_tenant_orders', join),
          primaryKeyOf
        )
      )
    ).toEqual([['relationship_target_key_mismatch', 'left', 'fct_order_items']]);
  });
});

describe('indexedRelationshipKeyWarnings', () => {
  const file = (path: string, document: Record<string, unknown>) => ({
    path,
    content: stringify({ spec_version: '0.2', ...document }),
  });
  const relationshipFile = (name: string, rightModel: string, right: string) =>
    file(`relationships/${name}.yml`, {
      type: 'relationship',
      name,
      left_model: 'orders',
      right_model: rightModel,
      join_columns: [{ left: 'customer_id', right }],
      relationship_type: 'many_to_one',
    });

  it('resolves sources, models and agentic grains ignoring case, and names the relationship file', () => {
    const index = indexProjectFiles([
      file('sources/customers.yml', {
        type: 'source',
        source_type: 'warehouse_table',
        name: 'customers',
        connection: 'warehouse',
        table: 'ANALYTICS.RAW.CUSTOMERS',
        schema: {
          columns: [
            { name: 'id', type: 'BIGINT', primary_key: true },
            { name: 'email', type: 'VARCHAR' },
          ],
        },
      }),
      file('models/accounts.yml', {
        type: 'model',
        name: 'accounts',
        description: 'Accounts',
        grain: ['account_id'],
        source: { ref: 'warehouse.customers' },
        materialization: { type: 'view' },
        columns: [{ name: 'account_id', expr: 'customers.id' }],
      }),
      file('models/researched_customers.yml', {
        type: 'model',
        model_kind: 'agentic',
        name: 'researched_customers',
        description: 'Customers researched by an agent',
        grain: ['customer_id'],
        sources: { customers: { ref: 'warehouse.customers' } },
        llm: { profile: 'review' },
        plan: {
          steps: [
            {
              id: 'research',
              source: { ref: 'customers' },
              execution: { mode: 'llm_call' },
              instructions: 'Summarize the customer.',
              map: { over: 'customers', group_by: ['customer_id'] },
              columns: [
                { name: 'customer_id', type: 'integer', nullable: false },
                { name: 'segment', type: 'string', nullable: true },
              ],
            },
          ],
        },
        output: { from: 'research' },
        materialization: {
          type: 'table',
          strategy: 'replace_processed_keys',
          keys: ['customer_id'],
        },
      }),
      relationshipFile('orders_to_customers', 'warehouse.customers', 'id'),
      relationshipFile('orders_to_customer_emails', 'Warehouse.Customers', 'email'),
      relationshipFile('orders_to_accounts', 'ACCOUNTS', 'account_id'),
      relationshipFile('orders_to_missing', 'missing', 'id'),
      relationshipFile('orders_to_research', 'researched_customers', 'customer_id'),
      relationshipFile('orders_to_segments', 'researched_customers', 'segment'),
    ]);

    expect(
      indexedRelationshipKeyWarnings(index).map(({ code, path, dataset, primaryKey }) => [
        code,
        path,
        dataset,
        primaryKey,
      ])
    ).toEqual([
      ['relationship_target_key_missing', 'relationships/orders_to_accounts.yml', 'ACCOUNTS', []],
      [
        'relationship_target_key_mismatch',
        'relationships/orders_to_customer_emails.yml',
        'Warehouse.Customers',
        ['id'],
      ],
      [
        'relationship_target_key_mismatch',
        'relationships/orders_to_segments.yml',
        'researched_customers',
        ['customer_id'],
      ],
    ]);
  });
});
