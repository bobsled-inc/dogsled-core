import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { generateSelectSql, generateSql } from '../../../src/compiler/codegen.js';
import {
  buildSourceRegistry,
  parseTransformSpec,
  parseTransformSpecFromParsed,
} from '../../../src/compiler/parser.js';
import { TransformSpecSchema } from '../../../src/compiler/schemas.js';

import type { SupportedDialect } from '../../../src/compiler/dialect.js';
import type {
  ResolvedFlattenJson,
  ResolvedTransformSpec,
  SourceEntryRegistry,
} from '../../../src/compiler/parser.js';

const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/specs');
const SOURCES_DIR = path.join(FIXTURES_DIR, 'sources');
const MODELS_DIR = path.join(FIXTURES_DIR, 'models');

// Build registry once
const registryResult = buildSourceRegistry(SOURCES_DIR);
if (!registryResult.ok) {
  throw new Error('Failed to build source registry for tests');
}
const registry = registryResult.registry;

type FlattenJsonOverride = ResolvedTransformSpec['flattenJson'] | ResolvedFlattenJson | undefined;

type FlattenSpecOverrides = Partial<Omit<ResolvedTransformSpec, 'flattenJson'>> & {
  flattenJson?: FlattenJsonOverride;
};

function normalizeFlattenJson(
  flattenJson: FlattenJsonOverride
): ResolvedTransformSpec['flattenJson'] {
  if (!flattenJson) {
    return undefined;
  }
  return Array.isArray(flattenJson) ? flattenJson : [flattenJson];
}

describe('generateSql', () => {
  it('generates CREATE VIEW for stg_orders (simple model)', () => {
    const parseResult = parseTransformSpec(path.join(MODELS_DIR, 'stg_orders.yml'), registry);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    const sql = generateSql(parseResult.spec, 'DOGSLED_WORKSPACE');

    // Verify DDL wrapper
    expect(sql).toContain(
      'CREATE OR REPLACE VIEW "DOGSLED_WORKSPACE"."STG_ORDERS" COPY GRANTS AS ('
    );
    expect(sql).toMatch(/\);$/);

    // Verify column aliases
    expect(sql).toContain('AS ORDER_ID');
    expect(sql).toContain('AS SUBTOTAL');
    expect(sql).toContain('AS ORDERED_AT');

    // Single-source queries without alias references no longer emit a redundant t0 alias.
    expect(sql).toContain('FROM RAW.RAW_ORDERS');
    expect(sql).not.toContain('RAW.RAW_ORDERS AS T0');

    // Verify expression handling
    expect(sql).toContain('CAST(SUBTOTAL / 100.0 AS DECIMAL(16, 2))');
    expect(sql).toContain("DATE_TRUNC('DAY', ORDERED_AT)");
  });

  it('generates CREATE VIEW for order_items (join model)', () => {
    const parseResult = parseTransformSpec(path.join(MODELS_DIR, 'order_items.yml'), registry);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    const sql = generateSql(parseResult.spec, 'DOGSLED_WORKSPACE');

    // Verify DDL wrapper
    expect(sql).toContain(
      'CREATE OR REPLACE VIEW "DOGSLED_WORKSPACE"."ORDER_ITEMS" COPY GRANTS AS ('
    );
    expect(sql).toMatch(/\);$/);

    // Verify column aliases
    expect(sql).toContain('AS ORDER_ITEM_ID');
    expect(sql).toContain('AS ORDER_ID');
    expect(sql).toContain('AS PRODUCT_NAME');
    expect(sql).toContain('AS QUANTITY');
    expect(sql).toContain('AS LINE_TOTAL');

    // Verify JOIN structure with auto-generated aliases
    expect(sql).toContain('LEFT JOIN');
    expect(sql).toContain('RAW.RAW_ORDER_ITEMS AS T0');
    expect(sql).toContain('RAW.RAW_PRODUCTS AS T1');
    expect(sql).toContain('T0.PRODUCT_ID = T1.ID');
  });

  it('generates CREATE VIEW for stg_customers (simple column renames)', () => {
    const parseResult = parseTransformSpec(path.join(MODELS_DIR, 'stg_customers.yml'), registry);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    const sql = generateSql(parseResult.spec, 'DOGSLED_WORKSPACE');

    expect(sql).toContain(
      'CREATE OR REPLACE VIEW "DOGSLED_WORKSPACE"."STG_CUSTOMERS" COPY GRANTS AS ('
    );
    expect(sql).toContain('AS CUSTOMER_ID');
    expect(sql).toContain('AS CUSTOMER_NAME');
    expect(sql).toContain('FROM RAW.RAW_CUSTOMERS');
    expect(sql).not.toContain('RAW.RAW_CUSTOMERS AS T0');
  });

  it('generates WHERE clause for simple model with filter', () => {
    const parseResult = parseTransformSpec(
      path.join(MODELS_DIR, 'stg_active_orders.yml'),
      registry
    );
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    const sql = generateSql(parseResult.spec, 'DOGSLED_WORKSPACE');

    expect(sql).toContain(
      'CREATE OR REPLACE VIEW "DOGSLED_WORKSPACE"."STG_ACTIVE_ORDERS" COPY GRANTS AS ('
    );
    // polyglot normalizes != to <>
    expect(sql).toContain("STATUS <> 'cancelled'");
    expect(sql).toContain('WHERE');
  });

  it('generates WHERE clause for join model with filter', () => {
    const spec: ResolvedTransformSpec = {
      name: 'filtered_join',
      description: 'Filtered join model.',
      grain: 'order_item_id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_order_items',
      source: { fqTableName: 'RAW.RAW_ORDER_ITEMS', alias: 't0', filter: 't0.QUANTITY > 0' },
      joins: [
        {
          fqTableName: 'RAW.RAW_PRODUCTS',
          ref: 'ecom.raw_products',
          alias: 't1',
          type: 'left',
          on: 't0.PRODUCT_ID = t1.ID',
        },
      ],
      columns: [
        { name: 'ORDER_ITEM_ID', expr: 't0.ID' },
        { name: 'PRODUCT_NAME', expr: 't1.NAME' },
      ],
      materialization: 'view',
    };

    const sql = generateSql(spec, 'DOGSLED_WORKSPACE');
    expect(sql).toContain('WHERE');
    expect(sql).toContain('T0.QUANTITY > 0');
  });

  it('generates no WHERE clause without filter (backward compat)', () => {
    const parseResult = parseTransformSpec(path.join(MODELS_DIR, 'stg_orders.yml'), registry);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    const sql = generateSql(parseResult.spec, 'DOGSLED_WORKSPACE');
    expect(sql).not.toContain('WHERE');
  });

  it('generates correct FROM for model-to-model ref', () => {
    const spec: ResolvedTransformSpec = {
      name: 'fct_orders',
      description: 'Order fact table.',
      grain: 'order_id',
      trustTier: 'bronze',
      sourceRef: 'stg_orders',
      source: { fqTableName: 'DOGSLED_WORKSPACE.STG_ORDERS', alias: 't0' },
      joins: [
        {
          fqTableName: 'DOGSLED_WORKSPACE.STG_CUSTOMERS',
          ref: 'stg_customers',
          alias: 't1',
          type: 'left',
          on: 't0.CUSTOMER_ID = t1.CUSTOMER_ID',
        },
      ],
      columns: [
        { name: 'ORDER_ID', expr: 't0.ORDER_ID' },
        { name: 'CUSTOMER_NAME', expr: 't1.CUSTOMER_NAME' },
      ],
      materialization: 'view',
    };

    const sql = generateSql(spec, 'DOGSLED_WORKSPACE');

    expect(sql).toContain(
      'CREATE OR REPLACE VIEW "DOGSLED_WORKSPACE"."FCT_ORDERS" COPY GRANTS AS ('
    );
    expect(sql).toContain('DOGSLED_WORKSPACE.STG_ORDERS AS T0');
    expect(sql).toContain('LEFT JOIN');
    expect(sql).toContain('DOGSLED_WORKSPACE.STG_CUSTOMERS AS T1');
  });

  it('uses custom target schema', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_model',
      description: 'Test model.',
      grain: 'col',
      trustTier: 'bronze',
      sourceRef: 'db.table',
      source: { fqTableName: 'DB.TABLE', alias: 't0' },
      joins: [],
      columns: [{ name: 'col', expr: 'col' }],
      materialization: 'view',
    };

    const sql = generateSql(spec, 'MY_SCHEMA');
    expect(sql).toContain('"MY_SCHEMA"."TEST_MODEL"');
  });

  it('generates metadata header with Model line', () => {
    const spec: ResolvedTransformSpec = {
      name: 'stg_orders',
      description: 'Staging orders.',
      grain: 'order_id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: 'view',
    };

    const sql = generateSql(spec, 'DOGSLED_WORKSPACE');
    expect(sql).toMatch(/^-- Model: stg_orders\n/);
  });

  it('includes Trust tier in metadata header', () => {
    const spec: ResolvedTransformSpec = {
      name: 'stg_orders',
      description: 'Staging orders.',
      grain: 'order_id',
      trustTier: 'silver',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: 'view',
    };

    const sql = generateSql(spec, 'DOGSLED_WORKSPACE');
    expect(sql).toContain('-- Trust: silver');
  });

  it('includes description and grain in header when present', () => {
    const spec: ResolvedTransformSpec = {
      name: 'fct_orders',
      description: 'Order fact table.',
      grain: 'order_id',
      trustTier: 'bronze',
      sourceRef: 'stg_orders',
      source: { fqTableName: 'SCHEMA.STG_ORDERS', alias: 't0' },
      joins: [],
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: 'view',
    };

    const sql = generateSql(spec, 'DOGSLED_WORKSPACE');
    expect(sql).toContain('-- Description: Order fact table.');
    expect(sql).toContain('-- Grain: order_id');
  });

  it('includes grain array as comma-separated', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test',
      description: 'Test model.',
      grain: ['order_id', 'line_id'],
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.TABLE', alias: 't0' },
      joins: [],
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: 'view',
    };

    const sql = generateSql(spec, 'DOGSLED_WORKSPACE');
    expect(sql).toContain('-- Grain: order_id, line_id');
  });

  it('lists refs in header', () => {
    const spec: ResolvedTransformSpec = {
      name: 'fct_orders',
      description: 'Order fact table.',
      grain: 'order_id',
      trustTier: 'bronze',
      sourceRef: 'stg_orders',
      source: { fqTableName: 'SCHEMA.STG_ORDERS', alias: 't0' },
      joins: [
        {
          fqTableName: 'SCHEMA.STG_CUSTOMERS',
          ref: 'stg_customers',
          alias: 't1',
          type: 'left',
          on: 't0.ID = t1.ID',
        },
      ],
      columns: [{ name: 'ID', expr: 't0.ID' }],
      materialization: 'view',
    };

    const sql = generateSql(spec, 'DOGSLED_WORKSPACE');
    expect(sql).toContain('-- Refs: stg_orders, stg_customers');
  });

  it('always includes description and grain in header', () => {
    const spec: ResolvedTransformSpec = {
      name: 'minimal',
      description: 'Minimal model.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.TABLE', alias: 't0' },
      joins: [],
      columns: [{ name: 'ID', expr: 'ID' }],
      materialization: 'view',
    };

    const sql = generateSql(spec, 'DOGSLED_WORKSPACE');
    expect(sql).toContain('-- Model: minimal');
    expect(sql).toContain('-- Description: Minimal model.');
    expect(sql).toContain('-- Grain: id');
    expect(sql).toContain('-- Trust: bronze');
  });

  it('throws on transpile failure for join query', () => {
    const spec: ResolvedTransformSpec = {
      name: 'bad_model',
      description: 'Bad model.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.ORDERS', alias: 't0' },
      joins: [
        {
          fqTableName: 'RAW.ITEMS',
          ref: 'ecom.raw_items',
          alias: 't1',
          type: 'left',
          // Intentionally malformed ON clause to trigger transpile failure
          on: '!!!INVALID SQL!!!',
        },
      ],
      columns: [{ name: 'ID', expr: 't0.ID' }],
      materialization: 'view',
    };

    expect(() => generateSql(spec, 'DOGSLED_WORKSPACE')).toThrow(
      'SQL transpilation failed for model "bad_model"'
    );
  });
});

describe('generateSql multi-dialect', () => {
  function expectNoRedundantRootAlias(
    sql: string,
    fromFragment: string,
    aliasedFragment: string
  ): void {
    expect(sql).toContain(fromFragment);
    expect(sql).not.toContain(aliasedFragment);
  }

  const spec: ResolvedTransformSpec = {
    name: 'test_model',
    description: 'Test model.',
    grain: 'col',
    trustTier: 'bronze',
    sourceRef: 'db.table',
    source: { fqTableName: 'RAW.TABLE', alias: 't0' },
    joins: [],
    columns: [{ name: 'col', expr: 'col' }],
    materialization: 'view',
  };

  it('snowflake: uppercased identifiers with double quotes', () => {
    const sql = generateSql(spec, 'MY_SCHEMA', 'snowflake');
    expect(sql).toContain('"MY_SCHEMA"."TEST_MODEL"');
    expect(sql).toContain('AS COL');
    expectNoRedundantRootAlias(sql, 'FROM RAW.TABLE', 'RAW.TABLE AS T0');
  });

  it('bigquery: lowercased identifiers with backticks', () => {
    const sql = generateSql(spec, 'my_schema', 'bigquery');
    expect(sql).toContain('`my_schema`.`test_model`');
    expect(sql).toContain('AS col');
    expectNoRedundantRootAlias(sql, 'FROM raw.table', 'raw.table AS t0');
  });

  it('postgres: lowercased identifiers with double quotes', () => {
    const sql = generateSql(spec, 'my_schema', 'postgres');
    expect(sql).toContain('"my_schema"."test_model"');
    expect(sql).toContain('AS col');
    expectNoRedundantRootAlias(sql, 'FROM raw.table', 'raw.table AS t0');
  });

  it('databricks: lowercased identifiers with backticks', () => {
    const sql = generateSql(spec, 'my_schema', 'databricks');
    expect(sql).toContain('`my_schema`.`test_model`');
    expect(sql).toContain('AS col');
    expectNoRedundantRootAlias(sql, 'FROM raw.table', 'raw.table AS t0');
  });

  it('defaults to snowflake when no dialect specified', () => {
    const sql = generateSql(spec, 'MY_SCHEMA');
    expect(sql).toContain('"MY_SCHEMA"."TEST_MODEL"');
  });

  const dialects: SupportedDialect[] = ['snowflake', 'bigquery', 'postgres', 'databricks'];

  for (const dialect of dialects) {
    it(`${dialect}: generates valid CREATE VIEW statement`, () => {
      const sql = generateSql(spec, 'schema', dialect);
      expect(sql).toContain('CREATE OR REPLACE VIEW');
      if (dialect === 'snowflake') {
        expect(sql).toContain('COPY GRANTS');
      } else {
        expect(sql).not.toContain('COPY GRANTS');
      }
      expect(sql).toMatch(/\);$/);
    });
  }
});

describe('generateSelectSql with ephemeral CTEs', () => {
  it('inlines ephemeral source as CTE with WITH clause', () => {
    const cteMap = new Map([['SCHEMA.EPHEMERAL_SOURCE', 'SELECT id, name FROM RAW.RAW_DATA']]);

    const spec: ResolvedTransformSpec = {
      name: 'downstream_model',
      description: 'Downstream model.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ephemeral_source',
      source: { fqTableName: 'SCHEMA.EPHEMERAL_SOURCE', alias: 't0' },
      joins: [],
      columns: [
        { name: 'ID', expr: 't0.id' },
        { name: 'NAME', expr: 't0.name' },
      ],
      materialization: 'view',
    };

    const sql = generateSelectSql(spec, 'snowflake', cteMap);
    expect(sql).toContain('WITH');
    expect(sql).toContain('__CTE_EPHEMERAL_SOURCE');
    expect(sql).toContain('SELECT id, name FROM RAW.RAW_DATA');
  });

  it('inlines ephemeral join as CTE', () => {
    const cteMap = new Map([['SCHEMA.EPHEMERAL_JOIN', 'SELECT id, value FROM RAW.RAW_LOOKUP']]);

    const spec: ResolvedTransformSpec = {
      name: 'join_model',
      description: 'Join model.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'main_source',
      source: { fqTableName: 'RAW.MAIN_TABLE', alias: 't0' },
      joins: [
        {
          fqTableName: 'SCHEMA.EPHEMERAL_JOIN',
          ref: 'ephemeral_join',
          alias: 't1',
          type: 'left',
          on: 't0.id = t1.id',
        },
      ],
      columns: [
        { name: 'ID', expr: 't0.id' },
        { name: 'VALUE', expr: 't1.value' },
      ],
      materialization: 'view',
    };

    const sql = generateSelectSql(spec, 'snowflake', cteMap);
    expect(sql).toContain('WITH');
    expect(sql).toContain('__CTE_EPHEMERAL_JOIN');
    expect(sql).toContain('SELECT id, value FROM RAW.RAW_LOOKUP');
    expect(sql).toContain('LEFT JOIN');
  });

  it('handles multiple ephemeral refs as multiple CTEs', () => {
    const cteMap = new Map([
      ['SCHEMA.EPH_A', 'SELECT id FROM RAW.A'],
      ['SCHEMA.EPH_B', 'SELECT id, val FROM RAW.B'],
    ]);

    const spec: ResolvedTransformSpec = {
      name: 'multi_cte_model',
      description: 'Multi CTE model.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'eph_a',
      source: { fqTableName: 'SCHEMA.EPH_A', alias: 't0' },
      joins: [
        {
          fqTableName: 'SCHEMA.EPH_B',
          ref: 'eph_b',
          alias: 't1',
          type: 'left',
          on: 't0.id = t1.id',
        },
      ],
      columns: [
        { name: 'ID', expr: 't0.id' },
        { name: 'VAL', expr: 't1.val' },
      ],
      materialization: 'view',
    };

    const sql = generateSelectSql(spec, 'snowflake', cteMap);
    expect(sql).toContain('WITH');
    expect(sql).toContain('__CTE_EPH_A');
    expect(sql).toContain('__CTE_EPH_B');
  });

  it('hoists nested CTEs from ephemeral→ephemeral chains', () => {
    // Simulate: _transfer_events_base is ephemeral, _transfer_aggregates depends on it
    // and was compiled with its own WITH clause. The outer model refs both.
    const innerCteSelect =
      'SELECT transfer_id, MIN(timestamp) AS first_event FROM RAW.EVENTS GROUP BY transfer_id';
    const nestedCteSql = `WITH __CTE_TRANSFER_EVENTS_BASE AS (SELECT * FROM RAW.AUDIT_LOGS WHERE entity = 'TRANSFER') ${innerCteSelect}`;

    const cteMap = new Map([
      ['SCHEMA.TRANSFER_EVENTS_BASE', "SELECT * FROM RAW.AUDIT_LOGS WHERE entity = 'TRANSFER'"],
      ['SCHEMA.TRANSFER_AGGREGATES', nestedCteSql],
    ]);

    const spec: ResolvedTransformSpec = {
      name: 'transfer_summary',
      description: 'Transfer summary with nested ephemeral deps.',
      grain: 'transfer_id',
      trustTier: 'bronze',
      sourceRef: 'transfer_events_base',
      source: { fqTableName: 'SCHEMA.TRANSFER_EVENTS_BASE', alias: 't0', filter: 'rn = 1' },
      joins: [
        {
          ref: 'transfer_aggregates',
          fqTableName: 'SCHEMA.TRANSFER_AGGREGATES',
          alias: 't1',
          type: 'inner',
          on: 't0.transfer_id = t1.transfer_id',
        },
      ],
      columns: [
        { name: 'transfer_id', expr: 't0.transfer_id' },
        { name: 'first_event', expr: 't1.first_event' },
      ],
      materialization: 'view',
    };

    const sql = generateSelectSql(spec, 'snowflake', cteMap);

    // Should have a single top-level WITH clause, no nesting
    const withCount = (sql.match(/\bWITH\b/gi) || []).length;
    expect(withCount).toBe(1);

    // Both CTEs should be at the top level
    expect(sql).toContain('__CTE_TRANSFER_EVENTS_BASE');
    expect(sql).toContain('__CTE_TRANSFER_AGGREGATES');

    // The aggregates CTE body should NOT contain its own WITH clause
    const aggCteStart = sql.indexOf('__CTE_TRANSFER_AGGREGATES AS (');
    const aggCteBody = sql.slice(aggCteStart);
    expect(aggCteBody).not.toMatch(/AS \(WITH /i);
  });

  it('deduplicates CTEs when the same ephemeral is referenced by multiple paths', () => {
    // Both source and join reference the same ephemeral
    const cteMap = new Map([['SCHEMA.SHARED_EPH', 'SELECT id FROM RAW.DATA']]);

    const spec: ResolvedTransformSpec = {
      name: 'dedup_model',
      description: 'Model that deduplicates CTEs.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'shared_eph',
      source: { fqTableName: 'SCHEMA.SHARED_EPH', alias: 't0' },
      joins: [
        {
          ref: 'shared_eph',
          fqTableName: 'SCHEMA.SHARED_EPH',
          alias: 't1',
          type: 'left',
          on: 't0.id = t1.id',
        },
      ],
      columns: [{ name: 'id', expr: 't0.id' }],
      materialization: 'view',
    };

    const sql = generateSelectSql(spec, 'snowflake', cteMap);

    // CTE name should appear exactly once in the WITH definitions
    const cteMatches = sql.match(/__CTE_SHARED_EPH AS \(/g) || [];
    expect(cteMatches.length).toBe(1);
  });

  it('does not add WITH clause when no refs match cteMap', () => {
    const cteMap = new Map([['SCHEMA.UNRELATED', 'SELECT 1']]);

    const spec: ResolvedTransformSpec = {
      name: 'normal_model',
      description: 'Normal model.',
      grain: 'col',
      trustTier: 'bronze',
      sourceRef: 'db.table',
      source: { fqTableName: 'RAW.TABLE', alias: 't0' },
      joins: [],
      columns: [{ name: 'col', expr: 'col' }],
      materialization: 'view',
    };

    const sql = generateSelectSql(spec, 'snowflake', cteMap);
    expect(sql).not.toContain('WITH');
  });

  it('works without cteMap (backward compatible)', () => {
    const spec: ResolvedTransformSpec = {
      name: 'normal_model',
      description: 'Normal model.',
      grain: 'col',
      trustTier: 'bronze',
      sourceRef: 'db.table',
      source: { fqTableName: 'RAW.TABLE', alias: 't0' },
      joins: [],
      columns: [{ name: 'col', expr: 'col' }],
      materialization: 'view',
    };

    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).not.toContain('WITH');
    expect(sql).toContain('SELECT');
  });

  it('handles nested ephemerals via pass-through (A→eph_B→eph_C)', () => {
    // eph_C's SQL was already built (topological order), and eph_B's SQL
    // already contains eph_C's CTE. When model_A references eph_B,
    // eph_B's full SQL (including its own WITH) becomes a CTE.
    const ephCSql = 'SELECT id FROM RAW.C';
    const ephBSql = `WITH __CTE_EPH_C AS (${ephCSql}) SELECT id, val FROM __CTE_EPH_C`;

    const cteMap = new Map([['SCHEMA.EPH_B', ephBSql]]);

    const spec: ResolvedTransformSpec = {
      name: 'model_a',
      description: 'Model A.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'eph_b',
      source: { fqTableName: 'SCHEMA.EPH_B', alias: 't0' },
      joins: [],
      columns: [
        { name: 'ID', expr: 't0.id' },
        { name: 'VAL', expr: 't0.val' },
      ],
      materialization: 'view',
    };

    const sql = generateSelectSql(spec, 'snowflake', cteMap);
    expect(sql).toContain('WITH');
    expect(sql).toContain('__CTE_EPH_B');
    // The nested CTE SQL should be present inside the outer CTE
    expect(sql).toContain('__CTE_EPH_C');
  });

  const dialects: SupportedDialect[] = ['snowflake', 'bigquery', 'postgres', 'databricks'];

  for (const dialect of dialects) {
    it(`${dialect}: ephemeral CTE names follow dialect casing`, () => {
      const cteMap = new Map([['SCHEMA.EPH_MODEL', 'SELECT id FROM RAW.DATA']]);

      const spec: ResolvedTransformSpec = {
        name: 'test',
        description: 'Test model.',
        grain: 'id',
        trustTier: 'bronze',
        sourceRef: 'eph_model',
        source: { fqTableName: 'SCHEMA.EPH_MODEL', alias: 't0' },
        joins: [],
        columns: [{ name: 'id', expr: 't0.id' }],
        materialization: 'view',
      };

      const sql = generateSelectSql(spec, dialect, cteMap);
      expect(sql).toContain('WITH');

      if (dialect === 'snowflake') {
        expect(sql).toContain('__CTE_EPH_MODEL');
      } else {
        expect(sql).toContain('__cte_eph_model');
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Flatten JSON
// ---------------------------------------------------------------------------

describe('generateSelectSql — flatten_json', () => {
  const makeSpec = (overrides: FlattenSpecOverrides = {}): ResolvedTransformSpec => ({
    name: 'test_flatten',
    description: 'Test flatten.',
    grain: 'id',
    trustTier: 'bronze',
    sourceRef: 'ecom.raw_events',
    source: { fqTableName: 'RAW.RAW_EVENTS', alias: 't0' },
    joins: [],
    columns: [{ name: 'event_id', expr: 't0.EVENT_ID' }],
    materialization: 'view',
    ...overrides,
    flattenJson: normalizeFlattenJson(overrides.flattenJson),
  });

  it('snowflake: LATERAL FLATTEN without path', () => {
    const sql = generateSelectSql(makeSpec({ flattenJson: { column: 'PAYLOAD' } }), 'snowflake');
    expect(sql).toContain('LATERAL FLATTEN');
    expect(sql).toContain('INPUT => T0.PAYLOAD');
    expect(sql).toContain('FLATTENED');
  });

  it('snowflake: LATERAL FLATTEN with path', () => {
    const sql = generateSelectSql(
      makeSpec({ flattenJson: { column: 'PAYLOAD', path: 'items' } }),
      'snowflake'
    );
    expect(sql).toContain("PATH => 'items'");
  });

  it('snowflake: LATERAL FLATTEN with custom alias', () => {
    const sql = generateSelectSql(
      makeSpec({ flattenJson: { column: 'PAYLOAD', alias: 'my_flat' } }),
      'snowflake'
    );
    expect(sql).toContain('MY_FLAT');
  });

  it('bigquery: UNNEST(JSON_EXTRACT_ARRAY)', () => {
    const sql = generateSelectSql(makeSpec({ flattenJson: { column: 'PAYLOAD' } }), 'bigquery');
    expect(sql).toContain('UNNEST');
    expect(sql).toContain('JSON_EXTRACT_ARRAY');
  });

  it('bigquery: with path', () => {
    const sql = generateSelectSql(
      makeSpec({ flattenJson: { column: 'PAYLOAD', path: 'items' } }),
      'bigquery'
    );
    expect(sql).toContain("'$.items'");
  });

  it('postgres: json_array_elements without path', () => {
    const sql = generateSelectSql(makeSpec({ flattenJson: { column: 'payload' } }), 'postgres');
    expect(sql.toLowerCase()).toContain('json_array_elements');
  });

  it('postgres: json_array_elements with dotted path', () => {
    const sql = generateSelectSql(
      makeSpec({ flattenJson: { column: 'payload', path: 'data.items' } }),
      'postgres'
    );
    expect(sql).toContain("'data'");
    expect(sql).toContain("'items'");
    expect(sql).toContain('->');
  });

  it('databricks: LATERAL VIEW EXPLODE without path', () => {
    const sql = generateSelectSql(makeSpec({ flattenJson: { column: 'PAYLOAD' } }), 'databricks');
    expect(sql).toContain('LATERAL VIEW EXPLODE');
    expect(sql).not.toContain(', LATERAL VIEW');
    expect(sql).toContain('flattened');
  });

  it('databricks: LATERAL VIEW EXPLODE with path', () => {
    const sql = generateSelectSql(
      makeSpec({ flattenJson: { column: 'PAYLOAD', path: 'data.items' } }),
      'databricks'
    );
    expect(sql).toContain('LATERAL VIEW EXPLODE');
    expect(sql).toContain('.data.items');
    expect(sql).toContain('flattened');
  });

  it('mysql: JSON_TABLE without path', () => {
    const sql = generateSelectSql(makeSpec({ flattenJson: { column: 'payload' } }), 'mysql');
    expect(sql).toContain('JSON_TABLE');
    expect(sql).toContain("'$[*]'");
  });

  it('mysql: JSON_TABLE with path', () => {
    const sql = generateSelectSql(
      makeSpec({ flattenJson: { column: 'payload', path: 'data.items' } }),
      'mysql'
    );
    expect(sql).toContain('JSON_TABLE');
    expect(sql).toContain("'$.data.items[*]'");
  });

  it('duckdb: UNNEST without path', () => {
    const sql = generateSelectSql(makeSpec({ flattenJson: { column: 'payload' } }), 'duckdb');
    expect(sql).toContain('UNNEST');
    expect(sql.toLowerCase()).not.toContain('json_extract_array');
  });

  it('duckdb: UNNEST with path uses json_extract (-> operator)', () => {
    const sql = generateSelectSql(
      makeSpec({ flattenJson: { column: 'payload', path: 'data.items' } }),
      'duckdb'
    );
    expect(sql.toLowerCase()).toContain('unnest');
    expect(sql).toContain('$.data.items');
    expect(sql).toContain('->');
  });

  it('snowflake: outer: true adds OUTER => TRUE', () => {
    const sql = generateSelectSql(
      makeSpec({ flattenJson: { column: 'PAYLOAD', outer: true } }),
      'snowflake'
    );
    expect(sql).toContain('OUTER => TRUE');
  });

  it('bigquery: outer: true uses LEFT JOIN UNNEST', () => {
    const sql = generateSelectSql(
      makeSpec({ flattenJson: { column: 'PAYLOAD', outer: true } }),
      'bigquery'
    );
    expect(sql).toContain('LEFT JOIN UNNEST');
  });

  it('postgres: outer: true uses LEFT JOIN LATERAL', () => {
    const sql = generateSelectSql(
      makeSpec({ flattenJson: { column: 'payload', outer: true } }),
      'postgres'
    );
    expect(sql.toUpperCase()).toContain('LEFT JOIN LATERAL');
    expect(sql.toLowerCase()).toContain('json_array_elements');
    expect(sql.toLowerCase()).toContain('on true');
  });

  it('databricks: outer: true uses EXPLODE_OUTER', () => {
    const sql = generateSelectSql(
      makeSpec({ flattenJson: { column: 'PAYLOAD', outer: true } }),
      'databricks'
    );
    expect(sql).toContain('EXPLODE_OUTER');
  });

  it('databricks: flatten clause uses LATERAL VIEW syntax (no comma)', () => {
    const sql = generateSelectSql(makeSpec({ flattenJson: { column: 'PAYLOAD' } }), 'databricks');
    expect(sql).toContain('LATERAL VIEW EXPLODE');
    expect(sql).not.toMatch(/,\s*LATERAL VIEW/);
  });

  it('duckdb: outer: true throws unsupported error', () => {
    expect(() =>
      generateSelectSql(makeSpec({ flattenJson: { column: 'payload', outer: true } }), 'duckdb')
    ).toThrow(/not supported.*duckdb/i);
  });

  it('mysql: outer: true throws unsupported error', () => {
    expect(() =>
      generateSelectSql(makeSpec({ flattenJson: { column: 'payload', outer: true } }), 'mysql')
    ).toThrow(/not supported.*mysql/i);
  });

  it('redshift: flatten_json throws unsupported feature error', () => {
    expect(() =>
      generateSelectSql(makeSpec({ flattenJson: { column: 'payload' } }), 'redshift')
    ).toThrow(/unsupported_feature:flattenJson/i);
  });

  it.each([
    {
      dialect: 'databricks',
      column: 'PAYLOAD',
      expectedSnippets: ['LATERAL VIEW EXPLODE', '.data.items', 'flattened'],
    },
    { dialect: 'mysql', column: 'payload', expectedSnippets: ['JSON_TABLE', "$.data.items[*]'"] },
    {
      dialect: 'duckdb',
      column: 'payload',
      expectedSnippets: ['unnest', '$.data.items', '->'],
      toLowerCase: true,
    },
  ])('$dialect: with path parameter', ({ dialect, column, expectedSnippets, toLowerCase }) => {
    const sql = generateSelectSql(
      makeSpec({ flattenJson: { column, path: 'data.items' } }),
      dialect
    );
    for (const snippet of expectedSnippets) {
      if (toLowerCase) {
        expect(sql.toLowerCase()).toContain(snippet.toLowerCase());
      } else {
        expect(sql).toContain(snippet);
      }
    }
  });

  it.each([
    {
      dialect: 'snowflake',
      expectedSnippets: [
        "LATERAL FLATTEN(INPUT => T0.DATA, PATH => 'workspaces') AS WS",
        "LATERAL FLATTEN(INPUT => GET_PATH(WS.VALUE, 'members')) AS MEM",
        "CAST(GET_PATH(MEM.VALUE, 'id') AS VARCHAR) AS MEMBER_ID",
      ],
    },
    {
      dialect: 'bigquery',
      expectedSnippets: [
        "CROSS JOIN UNNEST(JSON_EXTRACT_ARRAY(t0.data, '$.workspaces')) AS ws",
        "CROSS JOIN UNNEST(JSON_EXTRACT_ARRAY(JSON_QUERY(ws, '$.members'))) AS mem",
        "CAST(JSON_VALUE(mem, '$.id') AS STRING) AS member_id",
      ],
    },
    {
      dialect: 'postgres',
      expectedSnippets: [
        "JSON_ARRAY_ELEMENTS(t0.data -> 'workspaces') AS ws",
        "JSON_ARRAY_ELEMENTS(ws.value -> 'members') AS mem",
        "CAST((mem.value ->> 'id') AS TEXT) AS member_id",
      ],
    },
    {
      dialect: 'databricks',
      expectedSnippets: [
        'LATERAL VIEW EXPLODE(t0.data.workspaces) AS ws',
        'LATERAL VIEW EXPLODE(ws.members) AS mem',
        'TRY_CAST(mem.id AS STRING) AS member_id',
      ],
    },
    {
      dialect: 'mysql',
      expectedSnippets: [
        "JSON_TABLE(t0.data, '$.workspaces[*]' COLUMNS(value JSON PATH '$')) AS ws",
        "JSON_TABLE(JSON_EXTRACT(ws.value, '$.members'), '$[*]' COLUMNS(value JSON PATH '$')) AS mem",
        "CAST(JSON_UNQUOTE(JSON_EXTRACT(mem.value, '$.id')) AS CHAR) AS member_id",
      ],
    },
    {
      dialect: 'duckdb',
      expectedSnippets: [
        "JOIN UNNEST(t0.data -> '$.workspaces') AS ws ON TRUE",
        "JOIN UNNEST(ws -> '$.members') AS mem ON TRUE",
        "CAST((mem ->> '$.id') AS TEXT) AS member_id",
      ],
    },
  ] as const)(
    '$dialect: chains multi-level flatten input and native json paths',
    ({ dialect, expectedSnippets }) => {
      const sql = generateSelectSql(
        makeSpec({
          flattenJson: [
            { column: 'DATA', path: 'workspaces', alias: 'ws' },
            { input: 'ws.VALUE:members', alias: 'mem' },
          ],
          columns: [{ name: 'member_id', expr: 'mem.VALUE:id::STRING' }],
        }),
        dialect
      );

      for (const snippet of expectedSnippets) {
        expect(sql).toContain(snippet);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Flatten JSON — feature interactions
// ---------------------------------------------------------------------------

describe('generateSelectSql — flatten_json feature interactions', () => {
  const makeSpec = (overrides: FlattenSpecOverrides = {}): ResolvedTransformSpec => ({
    name: 'test_flatten_interact',
    description: 'Test flatten feature interactions.',
    grain: 'id',
    trustTier: 'bronze',
    sourceRef: 'ecom.raw_events',
    source: { fqTableName: 'RAW.RAW_EVENTS', alias: 't0' },
    joins: [],
    columns: [{ name: 'event_id', expr: 't0.EVENT_ID' }],
    materialization: 'view',
    ...overrides,
    flattenJson: normalizeFlattenJson(overrides.flattenJson),
  });

  it('flatten + GROUP BY', () => {
    const sql = generateSelectSql(
      makeSpec({
        flattenJson: { column: 'PAYLOAD', alias: 'f' },
        groupBy: ['REGION'],
        columns: [
          { name: 'region', expr: 't0.REGION' },
          { name: 'item_value', expr: 'raw_sql(F.VALUE::STRING)' },
          { name: 'total', expr: 'COUNT(*)' },
        ],
      }),
      'snowflake'
    );
    expect(sql).toContain('LATERAL FLATTEN');
    expect(sql).toContain('GROUP BY');
    expect(sql).toContain('REGION');
  });

  it('flatten + WHERE referencing flatten alias', () => {
    const sql = generateSelectSql(
      makeSpec({
        flattenJson: { column: 'PAYLOAD', alias: 'f' },
        where: 'F.VALUE IS NOT NULL',
        columns: [
          { name: 'event_id', expr: 't0.EVENT_ID' },
          { name: 'item_value', expr: 'raw_sql(F.VALUE::STRING)' },
        ],
      }),
      'snowflake'
    );
    expect(sql).toContain('LATERAL FLATTEN');
    expect(sql).toContain('WHERE');
    expect(sql).toContain('F.VALUE');
  });

  it('flatten + PIVOT', () => {
    const sql = generateSelectSql(
      makeSpec({
        flattenJson: { column: 'PAYLOAD', alias: 'f' },
        pivot: {
          column: 'STATUS',
          values: ['active', 'closed'],
          aggregate: 'sum',
          value_column: 'AMOUNT',
        },
        columns: [
          { name: 'event_id', expr: 't0.EVENT_ID' },
          { name: 'active_amt', expr: 'raw_sql(SUM(F.AMOUNT))' },
        ],
      }),
      'snowflake'
    );
    expect(sql).toContain('LATERAL FLATTEN');
    expect(sql).toContain('PIVOT');
  });

  it('flatten + UNION', () => {
    const sql = generateSelectSql(
      makeSpec({
        flattenJson: { column: 'PAYLOAD', alias: 'f' },
        union: [{ fqTableName: 'RAW.ARCHIVED_EVENTS' }],
        columns: [
          { name: 'event_id', expr: 't0.EVENT_ID' },
          { name: 'item_value', expr: 'raw_sql(F.VALUE::STRING)' },
        ],
      }),
      'snowflake'
    );
    expect(sql).toContain('LATERAL FLATTEN');
    expect(sql).toContain('UNION ALL');
  });

  it('flatten + derived_columns', () => {
    const sql = generateSelectSql(
      makeSpec({
        flattenJson: { column: 'PAYLOAD', alias: 'f' },
        derivedColumns: [{ name: 'doubled', expr: 'event_id * 2' }],
        columns: [
          { name: 'event_id', expr: 't0.EVENT_ID' },
          { name: 'item_value', expr: 'raw_sql(F.VALUE::STRING)' },
        ],
      }),
      'snowflake'
    );
    expect(sql).toContain('LATERAL FLATTEN');
    expect(sql).toContain('__base');
    expect(sql).toContain('DOUBLED');
  });

  it('postgres: parse_json + flatten', () => {
    const sql = generateSelectSql(
      makeSpec({
        source: { fqTableName: 'RAW.RAW_EVENTS', alias: 't0' },
        columns: [
          { name: 'event_id', expr: 't0.EVENT_ID' },
          { name: 'item_value', expr: 't0.PAYLOAD' },
        ],
        flattenJson: { column: 'payload', alias: 'f' },
      }),
      'postgres'
    );
    expect(sql.toLowerCase()).toContain('json_array_elements');
  });
});

// ---------------------------------------------------------------------------
// Pivot
// ---------------------------------------------------------------------------

describe('generateSelectSql — pivot', () => {
  const makeSpec = (overrides: Partial<ResolvedTransformSpec> = {}): ResolvedTransformSpec => ({
    name: 'test_pivot',
    description: 'Test pivot.',
    grain: 'id',
    trustTier: 'bronze',
    sourceRef: 'ecom.raw_orders',
    source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
    joins: [],
    columns: [
      { name: 'order_id', expr: 't0.ORDER_ID' },
      { name: 'amount', expr: 't0.AMOUNT' },
    ],
    materialization: 'view',
    ...overrides,
  });

  it('snowflake: native PIVOT syntax', () => {
    const sql = generateSelectSql(
      makeSpec({
        pivot: {
          column: 'STATUS',
          values: ['active', 'closed'],
          aggregate: 'sum',
          value_column: 'AMOUNT',
        },
      }),
      'snowflake'
    );
    expect(sql).toContain('PIVOT');
    expect(sql).toContain('SUM');
    expect(sql).toContain("'active'");
    expect(sql).toContain("'closed'");
  });

  it('databricks: native PIVOT syntax', () => {
    const sql = generateSelectSql(
      makeSpec({
        pivot: { column: 'STATUS', values: ['active'], aggregate: 'count', value_column: 'AMOUNT' },
      }),
      'databricks'
    );
    expect(sql).toContain('PIVOT');
    expect(sql).toContain('COUNT');
  });

  it('postgres: conditional aggregation fallback with subquery', () => {
    const sql = generateSelectSql(
      makeSpec({
        pivot: {
          column: 'status',
          values: ['active', 'closed'],
          aggregate: 'sum',
          value_column: 'amount',
        },
      }),
      'postgres'
    );
    expect(sql).toContain('CASE WHEN');
    expect(sql).toContain('__pivot_src');
    expect(sql).not.toContain('PIVOT(');
  });

  it('bigquery: conditional aggregation fallback', () => {
    const sql = generateSelectSql(
      makeSpec({
        pivot: { column: 'STATUS', values: [1, 2, 3], aggregate: 'sum', value_column: 'AMOUNT' },
      }),
      'bigquery'
    );
    expect(sql).toContain('CASE WHEN');
    expect(sql).toContain('__pivot_src');
  });

  it('escapes single quotes in pivot string values', () => {
    const sql = generateSelectSql(
      makeSpec({
        pivot: { column: 'STATUS', values: ["it's"], aggregate: 'sum', value_column: 'AMOUNT' },
      }),
      'snowflake'
    );
    // Transpiler may use either '' or \' escaping depending on dialect
    expect(sql).toMatch(/it(?:''|\\')s/);
  });
});

// ---------------------------------------------------------------------------
// Unpivot
// ---------------------------------------------------------------------------

describe('generateSelectSql — unpivot', () => {
  const makeSpec = (overrides: Partial<ResolvedTransformSpec> = {}): ResolvedTransformSpec => ({
    name: 'test_unpivot',
    description: 'Test unpivot.',
    grain: 'id',
    trustTier: 'bronze',
    sourceRef: 'ecom.raw_orders',
    source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
    joins: [],
    columns: [
      { name: 'order_id', expr: 't0.ORDER_ID' },
      { name: 'jan_amount', expr: 't0.JAN_AMOUNT' },
      { name: 'feb_amount', expr: 't0.FEB_AMOUNT' },
      { name: 'mar_amount', expr: 't0.MAR_AMOUNT' },
      { name: 'region', expr: 't0.REGION' },
    ],
    materialization: 'view',
    ...overrides,
  });

  it('snowflake: native UNPIVOT syntax', () => {
    const sql = generateSelectSql(
      makeSpec({
        unpivot: {
          columns: ['jan_amount', 'feb_amount', 'mar_amount'],
          exclude: ['order_id', 'region'],
          field_name: 'month',
          value_name: 'amount',
        },
      }),
      'snowflake'
    );
    expect(sql).toContain('UNPIVOT');
    expect(sql).toContain('AMOUNT FOR MONTH IN');
  });

  it('databricks: native UNPIVOT syntax', () => {
    const sql = generateSelectSql(
      makeSpec({
        unpivot: {
          columns: ['jan_amount', 'feb_amount', 'mar_amount'],
          field_name: 'month',
          value_name: 'amount',
        },
      }),
      'databricks'
    );
    expect(sql).toContain('UNPIVOT');
  });

  it('duckdb: native UNPIVOT syntax', () => {
    const sql = generateSelectSql(
      makeSpec({
        unpivot: {
          columns: ['jan_amount', 'feb_amount', 'mar_amount'],
          field_name: 'month',
          value_name: 'amount',
        },
      }),
      'duckdb'
    );
    expect(sql).toContain('UNPIVOT');
  });

  it('bigquery: UNION ALL fallback', () => {
    const sql = generateSelectSql(
      makeSpec({
        unpivot: {
          columns: ['jan_amount', 'feb_amount'],
          field_name: 'month',
          value_name: 'amount',
        },
      }),
      'bigquery'
    );
    expect(sql).toContain('UNION ALL');
    expect(sql).not.toContain('UNPIVOT');
    expect(sql).toMatch(/'jan_amount'\s+AS\s+month/i);
    expect(sql).toMatch(/jan_amount\s+AS\s+amount/i);
  });

  it('postgres: UNION ALL fallback', () => {
    const sql = generateSelectSql(
      makeSpec({
        unpivot: {
          columns: ['jan_amount', 'feb_amount', 'mar_amount'],
          field_name: 'month',
          value_name: 'amount',
        },
      }),
      'postgres'
    );
    expect(sql).toContain('UNION ALL');
    expect(sql).not.toContain('UNPIVOT');
    expect(sql).toMatch(/'jan_amount'\s+AS\s+month/i);
    expect(sql).toMatch(/jan_amount\s+AS\s+amount/i);
  });

  it('mysql: UNION ALL fallback', () => {
    const sql = generateSelectSql(
      makeSpec({
        unpivot: {
          columns: ['jan_amount', 'feb_amount'],
          field_name: 'month',
          value_name: 'amount',
        },
      }),
      'mysql'
    );
    expect(sql).toContain('UNION ALL');
    expect(sql).not.toContain('UNPIVOT');
    expect(sql).toMatch(/'jan_amount'\s+AS\s+month/i);
    expect(sql).toMatch(/jan_amount\s+AS\s+amount/i);
  });

  it('with cast_to type', () => {
    const sql = generateSelectSql(
      makeSpec({
        unpivot: {
          columns: ['jan_amount', 'feb_amount'],
          field_name: 'month',
          value_name: 'amount',
          cast_to: 'VARCHAR',
        },
      }),
      'snowflake'
    );
    expect(sql).toContain('UNION ALL');
    expect(sql).toContain('CAST');
    expect(sql).toContain('VARCHAR');
    expect(sql).toMatch(/'jan_amount'\s+AS\s+month/i);
  });

  it('custom field_name and value_name', () => {
    const sql = generateSelectSql(
      makeSpec({
        unpivot: {
          columns: ['jan_amount', 'feb_amount'],
          field_name: 'metric_name',
          value_name: 'metric_value',
        },
      }),
      'snowflake'
    );
    expect(sql).toContain('METRIC_VALUE FOR METRIC_NAME');
  });

  it('unpivot + where interaction', () => {
    const sql = generateSelectSql(
      makeSpec({
        where: "region = 'APAC'",
        unpivot: {
          columns: ['jan_amount', 'feb_amount'],
          field_name: 'month',
          value_name: 'amount',
        },
      }),
      'snowflake'
    );
    expect(sql).toContain('WHERE');
    expect(sql).toContain('UNPIVOT');
  });
});

// ---------------------------------------------------------------------------
// Union branches
// ---------------------------------------------------------------------------

describe('generateSelectSql — union', () => {
  const makeSpec = (overrides: Partial<ResolvedTransformSpec> = {}): ResolvedTransformSpec => ({
    name: 'test_union',
    description: 'Test union.',
    grain: 'id',
    trustTier: 'bronze',
    sourceRef: 'ecom.raw_orders',
    source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
    joins: [],
    columns: [{ name: 'order_id', expr: 't0.ORDER_ID' }],
    materialization: 'view',
    ...overrides,
  });

  it('appends UNION ALL with default columns', () => {
    const sql = generateSelectSql(
      makeSpec({
        union: [{ fqTableName: 'RAW.ARCHIVED_ORDERS' }],
      }),
      'snowflake'
    );
    expect(sql).toContain('UNION ALL');
    expect(sql).toContain('RAW.ARCHIVED_ORDERS');
  });

  it('uses custom columns for union branch', () => {
    const sql = generateSelectSql(
      makeSpec({
        union: [
          {
            fqTableName: 'RAW.ARCHIVED_ORDERS',
            columns: [{ name: 'order_id', expr: 'LEGACY_ID' }],
          },
        ],
      }),
      'snowflake'
    );
    expect(sql).toContain('UNION ALL');
    expect(sql).toContain('LEGACY_ID AS ORDER_ID');
  });

  it('parenthesizes union branch filter', () => {
    const sql = generateSelectSql(
      makeSpec({
        union: [
          {
            fqTableName: 'RAW.ARCHIVED_ORDERS',
            filter: "REGION = 'US' OR REGION = 'EU'",
          },
        ],
      }),
      'snowflake'
    );
    expect(sql).toContain("WHERE (REGION = 'US' OR REGION = 'EU')");
  });

  it('supports multiple union branches', () => {
    const sql = generateSelectSql(
      makeSpec({
        union: [{ fqTableName: 'RAW.ARCHIVED_ORDERS' }, { fqTableName: 'RAW.LEGACY_ORDERS' }],
      }),
      'snowflake'
    );
    const unionCount = (sql.match(/UNION ALL/g) || []).length;
    expect(unionCount).toBe(2);
  });

  it('emits INTERSECT for operation: intersect', () => {
    const sql = generateSelectSql(
      makeSpec({
        union: [{ fqTableName: 'RAW.ARCHIVED_ORDERS', operation: 'intersect' }],
      }),
      'snowflake'
    );
    expect(sql).toContain('INTERSECT');
    expect(sql).not.toContain('UNION');
  });

  it('emits EXCEPT for operation: except', () => {
    const sql = generateSelectSql(
      makeSpec({
        union: [{ fqTableName: 'RAW.ARCHIVED_ORDERS', operation: 'except' }],
      }),
      'snowflake'
    );
    expect(sql).toContain('EXCEPT');
    expect(sql).not.toContain('UNION');
  });

  it('emits EXCEPT for operation: minus (alias)', () => {
    const sql = generateSelectSql(
      makeSpec({
        union: [{ fqTableName: 'RAW.ARCHIVED_ORDERS', operation: 'minus' }],
      }),
      'snowflake'
    );
    expect(sql).toContain('EXCEPT');
    expect(sql).not.toContain('MINUS');
  });

  it('emits UNION (deduplicated) for operation: union', () => {
    const sql = generateSelectSql(
      makeSpec({
        union: [{ fqTableName: 'RAW.ARCHIVED_ORDERS', operation: 'union' }],
      }),
      'snowflake'
    );
    expect(sql).toMatch(/\bUNION\b/);
    expect(sql).not.toContain('UNION ALL');
  });

  it('defaults to UNION ALL when operation is omitted', () => {
    const sql = generateSelectSql(
      makeSpec({
        union: [{ fqTableName: 'RAW.ARCHIVED_ORDERS' }],
      }),
      'snowflake'
    );
    expect(sql).toContain('UNION ALL');
  });

  it('supports mixed set operations in one query', () => {
    const sql = generateSelectSql(
      makeSpec({
        union: [
          { fqTableName: 'RAW.ARCHIVED_ORDERS', operation: 'intersect' },
          { fqTableName: 'RAW.LEGACY_ORDERS', operation: 'except' },
        ],
      }),
      'snowflake'
    );
    expect(sql).toContain('INTERSECT');
    expect(sql).toContain('EXCEPT');
    expect(sql).not.toContain('UNION');
  });

  it.each(['bigquery', 'postgres', 'databricks', 'mysql', 'duckdb'] as const)(
    '%s: emits INTERSECT for operation: intersect',
    (dialect) => {
      const sql = generateSelectSql(
        makeSpec({
          union: [{ fqTableName: 'RAW.ARCHIVED_ORDERS', operation: 'intersect' }],
        }),
        dialect
      );
      expect(sql.toUpperCase()).toContain('INTERSECT');
    }
  );

  it.each(['bigquery', 'postgres', 'databricks', 'mysql', 'duckdb'] as const)(
    '%s: emits EXCEPT for operation: except',
    (dialect) => {
      const sql = generateSelectSql(
        makeSpec({
          union: [{ fqTableName: 'RAW.ARCHIVED_ORDERS', operation: 'except' }],
        }),
        dialect
      );
      expect(sql.toUpperCase()).toContain('EXCEPT');
    }
  );

  it('emits `*` per branch when branch sets include_all_columns', () => {
    const sql = generateSelectSql(
      makeSpec({
        includeAllColumns: true,
        columns: [],
        union: [{ fqTableName: 'RAW.ARCHIVED_ORDERS', includeAllColumns: true }],
      }),
      'snowflake'
    );
    // Each arm gets its own `*` — not the main's rendered column list.
    expect(sql).toMatch(/SELECT \* FROM RAW\.RAW_ORDERS/);
    expect(sql).toMatch(/UNION ALL SELECT \* FROM RAW\.ARCHIVED_ORDERS/);
  });

  it('appends branch columns after `*` when both are set', () => {
    const sql = generateSelectSql(
      makeSpec({
        includeAllColumns: true,
        columns: [{ name: 'customer_id', expr: "'acme'" }],
        union: [
          {
            fqTableName: 'RAW.ARCHIVED_ORDERS',
            includeAllColumns: true,
            columns: [{ name: 'customer_id', expr: "'globex'" }],
          },
        ],
      }),
      'snowflake'
    );
    // Same column order in both arms — positional UNION ALL alignment.
    expect(sql).toContain(`SELECT *, 'acme' AS CUSTOMER_ID FROM RAW.RAW_ORDERS`);
    expect(sql).toContain(`UNION ALL SELECT *, 'globex' AS CUSTOMER_ID FROM RAW.ARCHIVED_ORDERS`);
  });

  it('honors per-branch exclude_columns with include_all_columns', () => {
    const sql = generateSelectSql(
      makeSpec({
        includeAllColumns: true,
        columns: [],
        union: [
          {
            fqTableName: 'RAW.ARCHIVED_ORDERS',
            includeAllColumns: true,
            excludeColumns: ['INTERNAL_DEBUG'],
          },
        ],
      }),
      'snowflake'
    );
    expect(sql).toContain('UNION ALL SELECT * EXCLUDE (INTERNAL_DEBUG) FROM RAW.ARCHIVED_ORDERS');
  });

  it('aliases the fallback branch table so reused t0 references resolve', () => {
    const sql = generateSelectSql(
      makeSpec({
        union: [{ fqTableName: 'RAW.ARCHIVED_ORDERS' }],
      }),
      'snowflake'
    );
    // Default-branch fallback reuses main columnsSql (which references t0).
    // Aliasing the branch table as T0 makes those refs resolve against the
    // branch table.
    expect(sql).toContain(
      'UNION ALL SELECT T0.ORDER_ID AS ORDER_ID FROM RAW.ARCHIVED_ORDERS AS T0'
    );
  });

  it('bigquery: renders canonical SAFE_CAST projections for schema-drifted UNION ALL arms', () => {
    const spec = makeSpec({
      sourceRef: 'tenant_a.raw_accounts',
      source: {
        fqTableName: 'raw.raw_tenant_a_accounts',
        alias: 't0',
        refKey: 'tenant_a.raw_accounts',
      },
      includeAllColumns: true,
      columns: [{ name: 'source_system', expr: "'tenant_a'", type: 'STRING' }],
      union: [
        {
          ref: 'tenant_b.raw_accounts',
          fqTableName: 'raw.raw_tenant_b_accounts',
          includeAllColumns: true,
          columns: [{ name: 'source_system', expr: "'tenant_b'" }],
        },
      ],
    });
    const entryRegistry: SourceEntryRegistry = new Map([
      [
        'tenant_a.raw_accounts',
        {
          kind: 'warehouse_table',
          fqRef: 'raw.raw_tenant_a_accounts',
          connection: 'tenant_a',
          columns: [
            { name: 'account_id', sqlType: 'STRING', type: 'string' },
            { name: 'created_at', sqlType: 'TIMESTAMP', type: 'timestamp' },
            { name: 'seat_count', sqlType: 'INT64', type: 'integer' },
          ],
        },
      ],
      [
        'tenant_b.raw_accounts',
        {
          kind: 'warehouse_table',
          fqRef: 'raw.raw_tenant_b_accounts',
          connection: 'tenant_b',
          columns: [
            { name: 'account_id', sqlType: 'INT64', type: 'integer' },
            { name: 'created_at', sqlType: 'STRING', type: 'string' },
            { name: 'tenant_b_extra', sqlType: 'STRING', type: 'string' },
          ],
        },
      ],
    ]);

    const sql = generateSelectSql(spec, 'bigquery', undefined, { entryRegistry });

    expect(sql).not.toContain('SELECT *');
    expect(sql).toContain('SAFE_CAST(t0.account_id AS STRING) AS account_id');
    expect(sql).toContain('SAFE_CAST(t0.created_at AS TIMESTAMP) AS created_at');
    expect(sql).toContain('SAFE_CAST(t0.seat_count AS INT64) AS seat_count');
    expect(sql).toContain("SAFE_CAST('tenant_a' AS STRING) AS source_system");
    expect(sql).toContain('UNION ALL SELECT SAFE_CAST(t0.account_id AS STRING) AS account_id');
    expect(sql).toContain('SAFE_CAST(t0.created_at AS TIMESTAMP) AS created_at');
    expect(sql).toContain('CAST(NULL AS INT64) AS seat_count');
    expect(sql).toContain("SAFE_CAST('tenant_b' AS STRING) AS source_system");
    expect(sql).not.toContain('tenant_b_extra');
    // Canonical projection emits `t0.<col>` refs even when the user's spec
    // never names the alias; the FROM clause must bind it so the SQL is valid.
    expect(sql).toMatch(/FROM\s+raw\.raw_tenant_a_accounts\s+AS\s+t0/i);
    expect(sql).toMatch(/FROM\s+raw\.raw_tenant_b_accounts\s+AS\s+t0/i);
  });

  it('bigquery: renders typed NULLs for direct model columns omitted by a UNION ALL arm', () => {
    const spec = makeSpec({
      sourceRef: 'tenant_a.raw_accounts',
      source: {
        fqTableName: 'raw.raw_tenant_a_accounts',
        alias: 't0',
        refKey: 'tenant_a.raw_accounts',
      },
      columns: [
        { name: 'account_id', expr: 't0.account_id', type: 'STRING' },
        { name: 'deleted_at', expr: 't0.deleted_at', type: 'TIMESTAMP' },
      ],
      union: [
        {
          ref: 'tenant_b.raw_accounts',
          fqTableName: 'raw.raw_tenant_b_accounts',
        },
      ],
    });
    const entryRegistry: SourceEntryRegistry = new Map([
      [
        'tenant_a.raw_accounts',
        {
          kind: 'warehouse_table',
          fqRef: 'raw.raw_tenant_a_accounts',
          connection: 'tenant_a',
          columns: [
            { name: 'account_id', sqlType: 'STRING', type: 'string' },
            { name: 'deleted_at', sqlType: 'TIMESTAMP', type: 'timestamp' },
          ],
        },
      ],
      [
        'tenant_b.raw_accounts',
        {
          kind: 'warehouse_table',
          fqRef: 'raw.raw_tenant_b_accounts',
          connection: 'tenant_b',
          columns: [{ name: 'account_id', sqlType: 'STRING', type: 'string' }],
        },
      ],
    ]);

    const sql = generateSelectSql(spec, 'bigquery', undefined, { entryRegistry });

    expect(sql).toContain('SAFE_CAST(t0.account_id AS STRING) AS account_id');
    expect(sql).toContain('SAFE_CAST(t0.deleted_at AS TIMESTAMP) AS deleted_at');
    expect(sql).toContain('UNION ALL SELECT SAFE_CAST(t0.account_id AS STRING) AS account_id');
    expect(sql).toContain('CAST(NULL AS TIMESTAMP) AS deleted_at');
    expect(sql).toMatch(/FROM\s+raw\.raw_tenant_a_accounts\s+AS\s+t0/i);
    expect(sql).toMatch(/FROM\s+raw\.raw_tenant_b_accounts\s+AS\s+t0/i);
  });

  it('bigquery: locks canonical projection column order across UNION arms', () => {
    const spec = makeSpec({
      sourceRef: 'tenant_a.raw_accounts',
      source: {
        fqTableName: 'raw.raw_tenant_a_accounts',
        alias: 't0',
        refKey: 'tenant_a.raw_accounts',
      },
      includeAllColumns: true,
      columns: [{ name: 'source_system', expr: "'tenant_a'", type: 'STRING' }],
      union: [
        {
          ref: 'tenant_b.raw_accounts',
          fqTableName: 'raw.raw_tenant_b_accounts',
          includeAllColumns: true,
          columns: [{ name: 'source_system', expr: "'tenant_b'" }],
        },
      ],
    });
    const entryRegistry: SourceEntryRegistry = new Map([
      [
        'tenant_a.raw_accounts',
        {
          kind: 'warehouse_table',
          fqRef: 'raw.raw_tenant_a_accounts',
          connection: 'tenant_a',
          columns: [
            { name: 'account_id', sqlType: 'STRING', type: 'string' },
            { name: 'created_at', sqlType: 'TIMESTAMP', type: 'timestamp' },
            { name: 'seat_count', sqlType: 'INT64', type: 'integer' },
          ],
        },
      ],
      [
        'tenant_b.raw_accounts',
        {
          kind: 'warehouse_table',
          fqRef: 'raw.raw_tenant_b_accounts',
          connection: 'tenant_b',
          columns: [{ name: 'account_id', sqlType: 'STRING', type: 'string' }],
        },
      ],
    ]);

    const sql = generateSelectSql(spec, 'bigquery', undefined, { entryRegistry });

    // UNION ALL is positional — both arms must render columns in identical
    // order. A snapshot of the projection list guards against silent reorders
    // that would corrupt downstream physical-storage column positions.
    const anchorIdx = sql.indexOf('FROM raw.raw_tenant_a_accounts');
    const branchIdx = sql.indexOf('FROM raw.raw_tenant_b_accounts');
    expect(anchorIdx).toBeGreaterThan(-1);
    expect(branchIdx).toBeGreaterThan(anchorIdx);
    const anchorProjection = sql.slice(0, anchorIdx);
    const branchProjection = sql.slice(anchorIdx, branchIdx);

    // Same column sequence in both arms: account_id, created_at, seat_count, source_system.
    expect(anchorProjection.indexOf('account_id') < anchorProjection.indexOf('created_at')).toBe(
      true
    );
    expect(anchorProjection.indexOf('created_at') < anchorProjection.indexOf('seat_count')).toBe(
      true
    );
    expect(anchorProjection.indexOf('seat_count') < anchorProjection.indexOf('source_system')).toBe(
      true
    );
    expect(branchProjection.indexOf('account_id') < branchProjection.indexOf('created_at')).toBe(
      true
    );
    expect(branchProjection.indexOf('created_at') < branchProjection.indexOf('seat_count')).toBe(
      true
    );
    expect(branchProjection.indexOf('seat_count') < branchProjection.indexOf('source_system')).toBe(
      true
    );
  });

  it('bigquery: throws when include_all_columns lacks a source registry entry', () => {
    const spec = makeSpec({
      sourceRef: 'tenant_a.raw_accounts',
      source: {
        fqTableName: 'raw.raw_tenant_a_accounts',
        alias: 't0',
        refKey: 'tenant_a.raw_accounts',
      },
      includeAllColumns: true,
      union: [
        {
          ref: 'tenant_b.raw_accounts',
          fqTableName: 'raw.raw_tenant_b_accounts',
        },
      ],
    });

    // No entryRegistry means we cannot enumerate the canonical column set —
    // falling back to SELECT * would re-introduce the positional drift bug the
    // canonical projection exists to prevent.
    expect(() => generateSelectSql(spec, 'bigquery')).toThrow(/bigquery_union_drift_guard/);
  });

  it('bigquery: maps BYTES/GEOGRAPHY/INTERVAL source types through canonical projection', () => {
    const spec = makeSpec({
      sourceRef: 'tenant_a.raw_payload',
      source: {
        fqTableName: 'raw.raw_payload_a',
        alias: 't0',
        refKey: 'tenant_a.raw_payload',
      },
      includeAllColumns: true,
      columns: [],
      union: [
        {
          ref: 'tenant_b.raw_payload',
          fqTableName: 'raw.raw_payload_b',
          includeAllColumns: true,
        },
      ],
    });
    const entryRegistry: SourceEntryRegistry = new Map([
      [
        'tenant_a.raw_payload',
        {
          kind: 'warehouse_table',
          fqRef: 'raw.raw_payload_a',
          connection: 'tenant_a',
          columns: [
            { name: 'payload', sqlType: 'BYTES', type: 'string' },
            { name: 'location', sqlType: 'GEOGRAPHY', type: 'object' },
            { name: 'duration', sqlType: 'INTERVAL', type: 'string' },
          ],
        },
      ],
      [
        'tenant_b.raw_payload',
        {
          kind: 'warehouse_table',
          fqRef: 'raw.raw_payload_b',
          connection: 'tenant_b',
          columns: [{ name: 'payload', sqlType: 'VARBINARY', type: 'string' }],
        },
      ],
    ]);

    const sql = generateSelectSql(spec, 'bigquery', undefined, { entryRegistry });

    expect(sql).toContain('SAFE_CAST(t0.payload AS BYTES) AS payload');
    expect(sql).toContain('SAFE_CAST(t0.location AS GEOGRAPHY) AS location');
    expect(sql).toContain('SAFE_CAST(t0.duration AS INTERVAL) AS duration');
    expect(sql).toContain('CAST(NULL AS INTERVAL) AS duration');
  });

  it('bigquery: falls GEOMETRY back to STRING (SAFE_CAST AS GEOGRAPHY is rejected by BQ)', () => {
    const spec = makeSpec({
      sourceRef: 'tenant_a.raw_geo',
      source: {
        fqTableName: 'raw.raw_geo_a',
        alias: 't0',
        refKey: 'tenant_a.raw_geo',
      },
      includeAllColumns: true,
      columns: [],
      union: [
        {
          ref: 'tenant_b.raw_geo',
          fqTableName: 'raw.raw_geo_b',
          includeAllColumns: true,
        },
      ],
    });
    const entryRegistry: SourceEntryRegistry = new Map([
      [
        'tenant_a.raw_geo',
        {
          kind: 'warehouse_table',
          fqRef: 'raw.raw_geo_a',
          connection: 'tenant_a',
          columns: [{ name: 'shape', sqlType: 'GEOMETRY', type: 'object' }],
        },
      ],
      [
        'tenant_b.raw_geo',
        {
          kind: 'warehouse_table',
          fqRef: 'raw.raw_geo_b',
          connection: 'tenant_b',
          columns: [{ name: 'shape', sqlType: 'GEOMETRY', type: 'object' }],
        },
      ],
    ]);

    const sql = generateSelectSql(spec, 'bigquery', undefined, { entryRegistry });

    // GEOMETRY must NOT route through SAFE_CAST(... AS GEOGRAPHY) — BigQuery
    // rejects that conversion during query analysis. Fall back to STRING.
    expect(sql).toContain('SAFE_CAST(t0.shape AS STRING) AS shape');
    expect(sql).not.toContain('SAFE_CAST(t0.shape AS GEOGRAPHY)');
  });
});

// ---------------------------------------------------------------------------
// Derived columns
// ---------------------------------------------------------------------------

describe('generateSelectSql — derived_columns', () => {
  it('wraps inner SQL with outer SELECT for derived columns', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_derived',
      description: 'Test derived.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [
        { name: 'order_id', expr: 't0.ORDER_ID' },
        { name: 'amount', expr: 't0.AMOUNT' },
      ],
      materialization: 'view',
      derivedColumns: [{ name: 'doubled', expr: 'amount * 2' }],
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).toContain('__base');
    expect(sql).toContain('DOUBLED');
    expect(sql).toContain('AMOUNT * 2');
  });

  it('includes all base columns plus derived in outer SELECT', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_derived2',
      description: 'Test derived.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [
        { name: 'a', expr: 't0.A' },
        { name: 'b', expr: 't0.B' },
      ],
      materialization: 'view',
      derivedColumns: [
        { name: 'c', expr: 'a + b' },
        { name: 'd', expr: 'a - b' },
      ],
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).toContain('SELECT A, B, A + B AS C, A - B AS D FROM');
  });
});

// ---------------------------------------------------------------------------
// Pre-aggregate CTE on joins
// ---------------------------------------------------------------------------

describe('generateSelectSql — pre-aggregate CTE', () => {
  it('generates CTE for join with pre_aggregate', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_preagg',
      description: 'Test pre-aggregate.',
      grain: 'order_id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [
        {
          ref: 'ecom.raw_items',
          fqTableName: 'RAW.RAW_ITEMS',
          alias: 't1',
          type: 'left',
          on: 't0.ORDER_ID = t1.ORDER_ID',
          preAggregate: {
            group_by: ['ORDER_ID'],
            columns: [{ name: 'total_qty', expr: 'SUM(QTY)' }],
          },
        },
      ],
      columns: [
        { name: 'order_id', expr: 't0.ORDER_ID' },
        { name: 'total_qty', expr: 't1.TOTAL_QTY' },
      ],
      materialization: 'view',
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).toContain('WITH');
    expect(sql).toContain('__PA_T1');
    expect(sql).toContain('GROUP BY ORDER_ID');
    expect(sql).toContain('SUM(QTY) AS TOTAL_QTY');
  });
});

// ---------------------------------------------------------------------------
// GROUP BY
// ---------------------------------------------------------------------------

describe('generateSelectSql — GROUP BY', () => {
  it('appends GROUP BY clause', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_groupby',
      description: 'Test group by.',
      grain: 'region',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [
        { name: 'region', expr: 't0.REGION' },
        { name: 'total', expr: 'SUM(t0.AMOUNT)' },
      ],
      materialization: 'view',
      groupBy: ['REGION'],
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).toContain('GROUP BY REGION');
  });

  it('handles GROUP BY with WHERE', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_groupby2',
      description: 'Test group by with filter.',
      grain: 'region',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0', filter: "STATUS = 'active'" },
      joins: [],
      columns: [
        { name: 'region', expr: 't0.REGION' },
        { name: 'total', expr: 'SUM(t0.AMOUNT)' },
      ],
      materialization: 'view',
      groupBy: ['REGION'],
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).toContain('WHERE');
    expect(sql).toContain('GROUP BY REGION');
  });

  it('generates qualified GROUP BY columns with join aliases', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_qualified_groupby',
      description: 'Test qualified group by with joins.',
      grain: ['event_id', 'season'],
      trustTier: 'bronze',
      sourceRef: 'stg_scorecards',
      source: { fqTableName: '"__preview__"."STG_SCORECARDS"', alias: 't0' },
      joins: [
        {
          ref: 'stg_events',
          fqTableName: '"__preview__"."STG_EVENTS"',
          alias: 't1',
          type: 'left',
          on: 't0."EVENT_ID" = t1."EVENT_ID"',
        },
      ],
      columns: [
        { name: 'event_id', expr: 't0."EVENT_ID"' },
        { name: 'season', expr: 't0."SEASON"' },
        { name: 'event_name', expr: 't1."EVENT_NAME"' },
        { name: 'total_rounds', expr: 'COUNT(*)' },
      ],
      groupBy: ['t0."EVENT_ID"', 't0."SEASON"', 't1."EVENT_NAME"'],
      materialization: 'view',
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).toContain('GROUP BY');
    // GROUP BY should preserve qualified references (t0, t1 aliases)
    const groupByMatch = sql.match(
      /GROUP BY\s+(.*?)(?:\s+HAVING|\s+ORDER|\s+QUALIFY|\s+LIMIT|\s*$)/is
    );
    expect(groupByMatch).toBeTruthy();
    const groupByClause = groupByMatch![1]!;
    // Snowflake uppercases aliases
    expect(groupByClause.toUpperCase()).toContain('T0');
    expect(groupByClause.toUpperCase()).toContain('T1');
  });

  it('resolves bare group_by names to column expressions in joins (prevents ambiguous columns)', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_bare_groupby_resolve',
      description: 'Test bare group_by resolution against column expressions.',
      grain: ['event_id', 'season'],
      trustTier: 'bronze',
      sourceRef: 'stg_scorecards',
      source: { fqTableName: '"__preview__"."STG_SCORECARDS"', alias: 't0' },
      joins: [
        {
          ref: 'stg_events',
          fqTableName: '"__preview__"."STG_EVENTS"',
          alias: 't1',
          type: 'left',
          on: 't0."EVENT_ID" = t1."EVENT_ID"',
        },
      ],
      columns: [
        { name: 'event_id', expr: 't0."EVENT_ID"' },
        { name: 'season', expr: 't0."SEASON"' },
        { name: 'event_name', expr: 't1."EVENT_NAME"' },
        { name: 'total_rounds', expr: 'COUNT(*)' },
      ],
      // Bare names — the compiler should resolve these to column expressions
      groupBy: ['event_id', 'season', 'event_name'],
      materialization: 'view',
    };
    const sql = generateSelectSql(spec, 'snowflake');
    const groupByMatch = sql.match(
      /GROUP BY\s+(.*?)(?:\s+HAVING|\s+ORDER|\s+QUALIFY|\s+LIMIT|\s*$)/is
    );
    expect(groupByMatch).toBeTruthy();
    const groupByClause = groupByMatch![1]!;
    // Should use the column expressions (t0/t1 qualified), not bare EVENT_ID
    expect(groupByClause).toContain('t0."EVENT_ID"');
    expect(groupByClause).toContain('t0."SEASON"');
    expect(groupByClause).toContain('t1."EVENT_NAME"');
  });

  it('does not resolve group_by against columns when there are no joins', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_no_join_groupby',
      description: 'No joins — bare group_by should stay as-is.',
      grain: 'region',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [
        { name: 'region', expr: 't0.REGION' },
        { name: 'total', expr: 'SUM(t0.AMOUNT)' },
      ],
      groupBy: ['REGION'],
      materialization: 'view',
    };
    const sql = generateSelectSql(spec, 'snowflake');
    // No joins → bare REGION is fine, no need for column expression resolution
    expect(sql).toContain('GROUP BY REGION');
  });
});

// ---------------------------------------------------------------------------
// Incremental filter composition
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WHERE clause (top-level)
// ---------------------------------------------------------------------------

describe('generateSelectSql — top-level WHERE', () => {
  it('generates WHERE clause from spec.where', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_where',
      description: 'Test where clause.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [{ name: 'id', expr: 't0.ID' }],
      materialization: 'view',
      where: 'status = 1',
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).toContain('WHERE');
    expect(sql).toContain('STATUS = 1');
  });

  it('combines source.filter AND spec.where', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_where_combined',
      description: 'Test where combined with filter.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0', filter: "REGION = 'US'" },
      joins: [],
      columns: [{ name: 'id', expr: 't0.ID' }],
      materialization: 'view',
      where: 'amount > 0',
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).toContain('WHERE');
    expect(sql).toContain("(REGION = 'US')");
    expect(sql).toContain('(AMOUNT > 0)');
    expect(sql).toContain('AND');
  });

  it('does not add WHERE when spec.where is absent', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_no_where',
      description: 'No where clause.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [{ name: 'id', expr: 't0.ID' }],
      materialization: 'view',
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).not.toContain('WHERE');
  });
});

// ---------------------------------------------------------------------------
// HAVING clause
// ---------------------------------------------------------------------------

describe('generateSelectSql — HAVING', () => {
  it('generates HAVING clause after GROUP BY', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_having',
      description: 'Test having clause.',
      grain: 'dept',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [
        { name: 'dept', expr: 't0.DEPT' },
        { name: 'total', expr: 'SUM(t0.AMOUNT)' },
      ],
      materialization: 'view',
      groupBy: ['DEPT'],
      having: 'COUNT(*) > 0',
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).toContain('GROUP BY');
    expect(sql).toContain('HAVING');
    expect(sql).toContain('COUNT(*)');
  });

  it('generates HAVING with SUM aggregate', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_having_sum',
      description: 'Test having with SUM.',
      grain: 'region',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [
        { name: 'region', expr: 't0.REGION' },
        { name: 'total', expr: 'SUM(t0.AMOUNT)' },
      ],
      materialization: 'view',
      groupBy: ['REGION'],
      having: 'SUM(t0.AMOUNT) >= 100',
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).toContain('HAVING');
    expect(sql).toContain('SUM');
  });

  it('does not add HAVING when absent', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_no_having',
      description: 'No having clause.',
      grain: 'dept',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [
        { name: 'dept', expr: 't0.DEPT' },
        { name: 'total', expr: 'SUM(t0.AMOUNT)' },
      ],
      materialization: 'view',
      groupBy: ['DEPT'],
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).not.toContain('HAVING');
  });
});

// ---------------------------------------------------------------------------
// ORDER BY clause
// ---------------------------------------------------------------------------

describe('generateSelectSql — ORDER BY', () => {
  it('generates ORDER BY with DESC direction', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_orderby',
      description: 'Test order by.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [{ name: 'name', expr: 't0.NAME' }],
      materialization: 'view',
      orderBy: [{ column: 'name', direction: 'desc' }],
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).toContain('ORDER BY');
    expect(sql).toContain('DESC');
  });

  it('generates ORDER BY with ASC direction', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_orderby_asc',
      description: 'Test order by asc.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [{ name: 'name', expr: 't0.NAME' }],
      materialization: 'view',
      orderBy: [{ column: 'name', direction: 'asc' }],
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).toContain('ORDER BY');
    expect(sql).toContain('ASC');
  });

  it('generates ORDER BY without direction', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_orderby_nodir',
      description: 'Test order by no direction.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [{ name: 'name', expr: 't0.NAME' }],
      materialization: 'view',
      orderBy: [{ column: 'name' }],
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).toContain('ORDER BY');
    expect(sql).toContain('NAME');
  });

  it('generates ORDER BY with multiple columns', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_orderby_multi',
      description: 'Test order by multi.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [
        { name: 'name', expr: 't0.NAME' },
        { name: 'age', expr: 't0.AGE' },
      ],
      materialization: 'view',
      orderBy: [
        { column: 'name', direction: 'asc' },
        { column: 'age', direction: 'desc' },
      ],
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).toContain('ORDER BY');
    expect(sql).toContain('NAME ASC');
    expect(sql).toContain('AGE DESC');
  });

  it('does not add ORDER BY when absent', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_no_orderby',
      description: 'No order by.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [{ name: 'id', expr: 't0.ID' }],
      materialization: 'view',
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).not.toContain('ORDER BY');
  });

  it('combines WHERE, GROUP BY, HAVING, and ORDER BY', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_all_clauses',
      description: 'Test all SQL clauses.',
      grain: 'region',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [
        { name: 'region', expr: 't0.REGION' },
        { name: 'total', expr: 'SUM(t0.AMOUNT)' },
      ],
      materialization: 'view',
      where: "t0.STATUS = 'active'",
      groupBy: ['REGION'],
      having: 'SUM(t0.AMOUNT) > 100',
      orderBy: [{ column: 'region', direction: 'asc' }],
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).toContain('WHERE');
    expect(sql).toContain('GROUP BY');
    expect(sql).toContain('HAVING');
    expect(sql).toContain('ORDER BY');

    // Verify correct clause ordering: WHERE before GROUP BY before HAVING before ORDER BY
    const whereIdx = sql.indexOf('WHERE');
    const groupByIdx = sql.indexOf('GROUP BY');
    const havingIdx = sql.indexOf('HAVING');
    const orderByIdx = sql.indexOf('ORDER BY');
    expect(whereIdx).toBeLessThan(groupByIdx);
    expect(groupByIdx).toBeLessThan(havingIdx);
    expect(havingIdx).toBeLessThan(orderByIdx);
  });
});

// ---------------------------------------------------------------------------
// SELECT * (include_all_columns) and SELECT * EXCEPT (exclude_columns)
// ---------------------------------------------------------------------------

describe('generateSelectSql — SELECT *', () => {
  it('generates SELECT * when includeAllColumns is true and columns is empty', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_star',
      description: 'Test select star.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [],
      includeAllColumns: true,
      materialization: 'view',
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).toContain('SELECT *');
    expect(sql).toContain('FROM');
  });

  it('generates SELECT *, col AS alias when includeAllColumns is true with extra columns', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_star_extra',
      description: 'Test select star with extra columns.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [{ name: 'DOUBLED', expr: 'AMOUNT * 2' }],
      includeAllColumns: true,
      materialization: 'view',
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).toContain('*');
    expect(sql).toContain('AS DOUBLED');
  });

  it('generates SELECT * EXCLUDE for Snowflake when excludeColumns is set', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_star_exclude',
      description: 'Test select star exclude.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [],
      includeAllColumns: true,
      excludeColumns: ['INTERNAL_ID', 'CREATED_BY'],
      materialization: 'view',
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).toContain('* EXCLUDE');
    expect(sql).toContain('INTERNAL_ID');
    expect(sql).toContain('CREATED_BY');
  });

  it('generates SELECT * EXCEPT for BigQuery when excludeColumns is set', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_star_except',
      description: 'Test select star except.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [],
      includeAllColumns: true,
      excludeColumns: ['internal_id'],
      materialization: 'view',
    };
    const sql = generateSelectSql(spec, 'bigquery');
    expect(sql).toContain('* EXCEPT');
    expect(sql).toContain('internal_id');
  });

  it('throws for redshift when excludeColumns is set', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_star_redshift',
      description: 'Test select star redshift.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [],
      includeAllColumns: true,
      excludeColumns: ['internal_id'],
      materialization: 'view',
    };
    expect(() => generateSelectSql(spec, 'redshift')).toThrow(
      /unsupported_feature:selectStarExcept/i
    );
  });
});

// ---------------------------------------------------------------------------
// SELECT DISTINCT
// ---------------------------------------------------------------------------

describe('generateSelectSql — SELECT DISTINCT', () => {
  it('generates SELECT DISTINCT when distinct is true', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_distinct',
      description: 'Test distinct.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [{ name: 'region', expr: 't0.REGION' }],
      distinct: true,
      materialization: 'view',
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).toContain('SELECT DISTINCT');
  });

  it('generates normal SELECT when distinct is false', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_no_distinct',
      description: 'Test no distinct.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [{ name: 'region', expr: 't0.REGION' }],
      distinct: false,
      materialization: 'view',
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).not.toContain('DISTINCT');
  });

  it('generates normal SELECT when distinct is absent', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_no_distinct_absent',
      description: 'Test no distinct absent.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [{ name: 'region', expr: 't0.REGION' }],
      materialization: 'view',
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).not.toContain('DISTINCT');
  });
});

// ---------------------------------------------------------------------------
// QUALIFY clause
// ---------------------------------------------------------------------------

describe('generateSelectSql — QUALIFY', () => {
  it('throws for postgres dialect', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_qualify_pg',
      description: 'Test qualify postgres.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [{ name: 'id', expr: 't0.ID' }],
      materialization: 'view',
      qualify: 'ROW_NUMBER() OVER (ORDER BY id) = 1',
    };
    // Postgres has no QUALIFY clause, so the predicate's window expression is
    // hoisted into the SELECT list and filtered from a wrapping subquery.
    const sql = generateSelectSql(spec, 'postgres');
    expect(sql).not.toContain('QUALIFY');
    expect(sql).toMatch(/ROW_NUMBER\(\) OVER \(ORDER BY id\) AS __bms_qualify_0/i);
    expect(sql).toMatch(/\) AS __bms_qualified WHERE __bms_qualify_0 = 1/i);
  });

  it('keeps a native QUALIFY for redshift instead of the transpiler rewrite', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_qualify_redshift',
      description: 'Test qualify redshift.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [{ name: 'id', expr: 't0.ID' }],
      materialization: 'view',
      qualify: 'ROW_NUMBER() OVER (ORDER BY id) = 1',
    };
    // Redshift has supported QUALIFY since 2023. The normalisation pass maps it
    // through the Postgres dialect and rewrites the clause into a subquery, and
    // that rewrite moves LIMIT inside the filter, so it returns rows taken
    // before the window filter rather than after. The emitted clause is kept.
    const sql = generateSelectSql(spec, 'redshift');
    expect(sql).toContain('ROW_NUMBER()');
    expect(sql).toMatch(/\bQUALIFY\b/);
    expect(sql).not.toContain('WHERE _w = 1');
  });

  it('keeps the redshift QUALIFY filter ahead of LIMIT', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_qualify_redshift_limit',
      description: 'Test qualify redshift with limit.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [{ name: 'id', expr: 't0.ID' }],
      materialization: 'view',
      qualify: 'ROW_NUMBER() OVER (ORDER BY id) = 1',
      limit: 2,
    };
    const sql = generateSelectSql(spec, 'redshift');
    expect(sql.indexOf('QUALIFY')).toBeLessThan(sql.indexOf('LIMIT'));
  });
});

// ---------------------------------------------------------------------------
// LIMIT / OFFSET
// ---------------------------------------------------------------------------

describe('generateSelectSql — LIMIT / OFFSET', () => {
  it('generates LIMIT clause', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_limit',
      description: 'Test limit.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [{ name: 'id', expr: 't0.ID' }],
      materialization: 'view',
      limit: 100,
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).toContain('LIMIT 100');
  });

  it('generates LIMIT with OFFSET', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_limit_offset',
      description: 'Test limit offset.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [{ name: 'id', expr: 't0.ID' }],
      materialization: 'view',
      limit: 50,
      offset: 10,
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).toContain('LIMIT 50');
    expect(sql).toContain('OFFSET 10');
  });

  it('does not add LIMIT when absent', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_no_limit',
      description: 'Test no limit.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [{ name: 'id', expr: 't0.ID' }],
      materialization: 'view',
    };
    const sql = generateSelectSql(spec, 'snowflake');
    expect(sql).not.toContain('LIMIT');
  });
});

// ---------------------------------------------------------------------------
// Incremental self-reference
// ---------------------------------------------------------------------------

describe('generateSelectSql — incremental self-reference', () => {
  it('resolves self reference in incremental filter when targetSchema is provided', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_self_ref',
      description: 'Test self reference.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [{ name: 'id', expr: 't0.ID' }],
      materialization: 'incremental',
      materializationConfig: {
        strategy: 'append',
        incremental_filter: 'CREATED_AT > (SELECT MAX(CREATED_AT) FROM self)',
      },
    };
    const sql = generateSelectSql(spec, 'snowflake', undefined, {
      targetSchema: 'MY_SCHEMA',
    });
    expect(sql).toContain('"MY_SCHEMA"."TEST_SELF_REF"');
    expect(sql).not.toContain('self');
  });

  it('fully qualifies self reference with database when targetDatabase is provided (Snowflake)', () => {
    const spec: ResolvedTransformSpec = {
      name: 'ecom_orders_enriched',
      description: 'Test self reference with database.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [{ name: 'id', expr: 't0.ID' }],
      materialization: 'incremental',
      materializationConfig: {
        strategy: 'append',
        incremental_filter: 'CREATED_AT > (SELECT MAX(CREATED_AT) FROM self)',
      },
    };
    const sql = generateSelectSql(spec, 'snowflake', undefined, {
      targetSchema: 'PUBLIC',
      targetDatabase: 'DEMO_ANALYTICS',
    });
    expect(sql).toContain('"DEMO_ANALYTICS"."PUBLIC"."ECOM_ORDERS_ENRICHED"');
    expect(sql).not.toContain('self');
  });

  it('fully qualifies self reference with project/dataset on BigQuery', () => {
    const spec: ResolvedTransformSpec = {
      name: 'ecom_orders_enriched',
      description: 'Test self reference with project.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'raw.raw_orders', alias: 't0' },
      joins: [],
      columns: [{ name: 'id', expr: 't0.id' }],
      materialization: 'incremental',
      materializationConfig: {
        strategy: 'append',
        incremental_filter: 'created_at > (SELECT MAX(created_at) FROM self)',
      },
    };
    const sql = generateSelectSql(spec, 'bigquery', undefined, {
      targetSchema: 'analytics',
      targetDatabase: 'my-project',
    });
    expect(sql).toContain('`my-project`.`analytics`.`ecom_orders_enriched`');
    expect(sql).not.toContain('self');
  });

  it('fully qualifies self reference with catalog/schema on Databricks', () => {
    const spec: ResolvedTransformSpec = {
      name: 'ecom_orders_enriched',
      description: 'Test self reference with catalog.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'raw.raw_orders', alias: 't0' },
      joins: [],
      columns: [{ name: 'id', expr: 't0.id' }],
      materialization: 'incremental',
      materializationConfig: {
        strategy: 'append',
        incremental_filter: 'created_at > (SELECT MAX(created_at) FROM self)',
      },
    };
    const sql = generateSelectSql(spec, 'databricks', undefined, {
      targetSchema: 'analytics',
      targetDatabase: 'main_catalog',
    });
    expect(sql).toContain('`main_catalog`.`analytics`.`ecom_orders_enriched`');
    expect(sql).not.toContain('self');
  });

  it('does not modify filter when no self reference exists', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_no_self',
      description: 'Test no self reference.',
      grain: 'id',
      trustTier: 'bronze',
      sourceRef: 'ecom.raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      joins: [],
      columns: [{ name: 'id', expr: 't0.ID' }],
      materialization: 'incremental',
      materializationConfig: {
        strategy: 'append',
        incremental_filter: "CREATED_AT > '2024-01-01'",
      },
    };
    const sql = generateSelectSql(spec, 'snowflake', undefined, {
      targetSchema: 'MY_SCHEMA',
    });
    expect(sql).toContain("CREATED_AT > '2024-01-01'");
    expect(sql).not.toContain('MY_SCHEMA');
  });
});

// ---------------------------------------------------------------------------
// Incremental filter composition
// ---------------------------------------------------------------------------

describe('generateSelectSql — incremental filter', () => {
  const makeSpec = (overrides: Partial<ResolvedTransformSpec> = {}): ResolvedTransformSpec => ({
    name: 'test_inc',
    description: 'Test incremental.',
    grain: 'id',
    trustTier: 'bronze',
    sourceRef: 'ecom.raw_orders',
    source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
    joins: [],
    columns: [{ name: 'id', expr: 't0.ID' }],
    materialization: 'incremental',
    materializationConfig: { strategy: 'append', incremental_filter: "CREATED_AT > '2024-01-01'" },
    ...overrides,
  });

  it('combines source.filter AND incremental_filter', () => {
    const sql = generateSelectSql(
      makeSpec({
        source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0', filter: "REGION = 'US'" },
      }),
      'snowflake'
    );
    expect(sql).toContain("(REGION = 'US')");
    expect(sql).toContain("(CREATED_AT > '2024-01-01')");
    expect(sql).toContain('AND');
  });

  it('skips incremental_filter on full refresh', () => {
    const sql = generateSelectSql(makeSpec(), 'snowflake', undefined, { isFullRefresh: true });
    expect(sql).not.toContain('CREATED_AT');
  });

  it('only incremental_filter when no source.filter', () => {
    const sql = generateSelectSql(makeSpec(), 'snowflake');
    expect(sql).toContain("(CREATED_AT > '2024-01-01')");
    expect(sql).not.toContain(' AND ');
  });

  it('retains the source alias when incremental_filter references it', () => {
    const sql = generateSelectSql(
      makeSpec({
        columns: [{ name: 'id', expr: 'ID' }],
        materializationConfig: {
          strategy: 'append',
          incremental_filter: "t0.CREATED_AT > '2024-01-01'",
        },
      }),
      'snowflake'
    );

    expect(sql).toContain('FROM RAW.RAW_ORDERS AS T0');
    expect(sql).toContain("(T0.CREATED_AT > '2024-01-01')");
  });
});

describe('compile warnings', () => {
  it('collects warning when expression falls back to raw_sql', () => {
    const warnings: string[] = [];
    const spec: ResolvedTransformSpec = {
      name: 'test_warnings',
      description: 'test',
      grain: 'id',
      trustTier: 'bronze',
      materialization: 'view',
      sourceRef: 'raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 'o' },
      columns: [
        { name: 'id', expr: 'o.id' },
        // This expression uses $ which is not parseable by DSL
        { name: 'custom', expr: 'SOME_UDF($$body$$)' },
      ],
      joins: [],
      includeAllColumns: false,
    };
    generateSelectSql(spec, 'snowflake', undefined, { warnings });
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes('raw_sql'))).toBe(true);
  });

  it('no warnings for parseable expressions', () => {
    const warnings: string[] = [];
    const spec: ResolvedTransformSpec = {
      name: 'test_no_warnings',
      description: 'test',
      grain: 'id',
      trustTier: 'bronze',
      materialization: 'view',
      sourceRef: 'raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 'o' },
      columns: [
        { name: 'id', expr: 'o.id' },
        { name: 'total', expr: 'sum(amount)' },
      ],
      joins: [],
      includeAllColumns: false,
    };
    generateSelectSql(spec, 'snowflake', undefined, { warnings });
    expect(warnings).toHaveLength(0);
  });
});

describe('strict mode', () => {
  it('rejects unparseable expression in strict mode', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_strict',
      description: 'test strict mode',
      grain: 'id',
      trustTier: 'bronze',
      materialization: 'view',
      sourceRef: 'raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      columns: [
        { name: 'id', expr: 'ID' },
        // This expression uses a SQL keyword pattern that will fall back to raw_sql
        { name: 'val', expr: 'SELECT 1 FROM dual' },
      ],
      joins: [],
      includeAllColumns: false,
    };
    expect(() => {
      generateSelectSql(spec, 'snowflake', undefined, { strict: true });
    }).toThrow('Strict mode: expression could not be parsed');
  });

  it('allows explicit raw_sql() in strict mode', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_explicit',
      description: 'test explicit raw_sql',
      grain: 'id',
      trustTier: 'bronze',
      materialization: 'view',
      sourceRef: 'raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      columns: [
        { name: 'id', expr: 'ID' },
        { name: 'custom', expr: 'raw_sql(1 + 1)' },
      ],
      joins: [],
      includeAllColumns: false,
    };
    // Should NOT throw even in strict mode
    const result = generateSelectSql(spec, 'snowflake', undefined, { strict: true });
    expect(result).toContain('1 + 1');
  });

  it('does not throw for parseable expressions in strict mode', () => {
    const spec: ResolvedTransformSpec = {
      name: 'test_parseable',
      description: 'test parseable strict',
      grain: 'id',
      trustTier: 'bronze',
      materialization: 'view',
      sourceRef: 'raw_orders',
      source: { fqTableName: 'RAW.RAW_ORDERS', alias: 't0' },
      columns: [
        { name: 'id', expr: 'ID' },
        { name: 'total', expr: 'COALESCE(amount, 0)' },
      ],
      joins: [],
      includeAllColumns: false,
    };
    // Should not throw
    const result = generateSelectSql(spec, 'snowflake', undefined, { strict: true });
    expect(result).toContain('COALESCE');
  });
});

describe('read_mode is inert in compilation (mixed-model authoring metadata)', () => {
  // Build a join + union model two ways — with and without read_mode on every
  // reference — and assert the compiled SQL is byte-identical. This is the
  // load-bearing guarantee: read_mode is pass-through authoring metadata that the
  // host query runtime interprets; the compiler must never let it affect emitted SQL.
  const baseSpec = {
    spec_version: '0.2' as const,
    name: 'mm_order_items',
    type: 'model' as const,
    description: 'Order items joined with products, unioned with returns.',
    grain: 'order_item_id',
    include_all_columns: true,
    source: { ref: 'ecom.raw_order_items' },
    joins: [
      {
        ref: 'ecom.raw_products',
        type: 'left' as const,
        on: 'ecom.raw_order_items.PRODUCT_ID = ecom.raw_products.ID',
      },
    ],
    union: [{ ref: 'ecom.raw_order_items', include_all_columns: true }],
    columns: [{ name: 'PRODUCT_NAME', expr: 'ecom.raw_products.NAME' }],
    materialization: { type: 'view' as const },
  };

  const withReadMode = {
    ...baseSpec,
    source: { ...baseSpec.source, read_mode: 'lazy' as const },
    joins: [{ ...baseSpec.joins[0]!, read_mode: 'live' as const }],
    union: [{ ...baseSpec.union[0]!, read_mode: 'lazy' as const }],
  };

  function compile(raw: unknown): string {
    const parsed = TransformSpecSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('spec failed to parse');
    const resolved = parseTransformSpecFromParsed(parsed.data, registry);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.error);
    return generateSql(resolved.spec, 'DOGSLED_WORKSPACE');
  }

  it('compiles byte-identically with and without read_mode on every ref site', () => {
    expect(compile(withReadMode)).toBe(compile(baseSpec));
  });
});
