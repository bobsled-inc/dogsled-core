import { describe, expect, it } from 'vitest';

import { generateTestSql } from '../../../src/compiler/tests.js';

import type { SupportedDialect } from '../../../src/compiler/dialect.js';
import type { ResolvedColumn } from '../../../src/compiler/parser.js';
import type { TestSpec } from '../../../src/compiler/tests.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const basicColumns: ResolvedColumn[] = [
  { name: 'order_id', expr: 'o.ID', primary_key: true },
  { name: 'status', expr: 'o.STATUS' },
  { name: 'amount', expr: 'o.AMOUNT' },
];

const noPkColumns: ResolvedColumn[] = [
  { name: 'status', expr: 'o.STATUS' },
  { name: 'amount', expr: 'o.AMOUNT' },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateTestSql', () => {
  it('generates not_null test SQL', () => {
    const tests: TestSpec[] = [{ type: 'not_null', column: 'status' }];
    const results = generateTestSql(
      'stg_orders',
      'BOBSLED_CORE_WORKSPACE',
      tests,
      noPkColumns,
      'snowflake'
    );

    const notNull = results.find((r) => r.testName === 'status_not_null');
    expect(notNull).toBeDefined();
    expect(notNull!.sql).toBe(
      'SELECT * FROM "BOBSLED_CORE_WORKSPACE"."STG_ORDERS" WHERE STATUS IS NULL;'
    );
    expect(notNull!.modelName).toBe('stg_orders');
  });

  it('generates unique test SQL', () => {
    const tests: TestSpec[] = [{ type: 'unique', column: 'order_id' }];
    const results = generateTestSql(
      'stg_orders',
      'BOBSLED_CORE_WORKSPACE',
      tests,
      noPkColumns,
      'snowflake'
    );

    const unique = results.find((r) => r.testName === 'order_id_unique');
    expect(unique).toBeDefined();
    expect(unique!.sql).toBe(
      'SELECT ORDER_ID, COUNT(*) AS __count FROM "BOBSLED_CORE_WORKSPACE"."STG_ORDERS" GROUP BY ORDER_ID HAVING COUNT(*) > 1;'
    );
  });

  it('generates accepted_values test SQL', () => {
    const tests: TestSpec[] = [
      { type: 'accepted_values', column: 'status', values: ['active', 'inactive', 'pending'] },
    ];
    const results = generateTestSql(
      'stg_orders',
      'BOBSLED_CORE_WORKSPACE',
      tests,
      noPkColumns,
      'snowflake'
    );

    const av = results.find((r) => r.testName === 'status_accepted_values');
    expect(av).toBeDefined();
    expect(av!.sql).toBe(
      "SELECT * FROM \"BOBSLED_CORE_WORKSPACE\".\"STG_ORDERS\" WHERE STATUS NOT IN ('active', 'inactive', 'pending');"
    );
  });

  it('generates accepted_values with numeric values', () => {
    const tests: TestSpec[] = [{ type: 'accepted_values', column: 'tier', values: [1, 2, 3] }];
    const results = generateTestSql('model', 'SCHEMA', tests, noPkColumns, 'snowflake');

    const av = results.find((r) => r.testName === 'tier_accepted_values');
    expect(av).toBeDefined();
    expect(av!.sql).toContain('NOT IN (1, 2, 3)');
  });

  it('passes custom SQL through', () => {
    const tests: TestSpec[] = [
      { type: 'custom', sql: 'SELECT 1 WHERE (SELECT COUNT(*) FROM t) = 0' },
    ];
    const results = generateTestSql('my_model', 'SCHEMA', tests, noPkColumns, 'snowflake');

    const custom = results.find((r) => r.testName === 'my_model_custom_1');
    expect(custom).toBeDefined();
    expect(custom!.sql).toBe('SELECT 1 WHERE (SELECT COUNT(*) FROM t) = 0;');
  });

  it('does not append extra semicolon to custom SQL that already has one', () => {
    const tests: TestSpec[] = [{ type: 'custom', sql: 'SELECT 1;' }];
    const results = generateTestSql('m', 'S', tests, noPkColumns, 'snowflake');

    expect(results[0]!.sql).toBe('SELECT 1;');
  });

  it('auto-generates not_null + unique for primary_key columns', () => {
    const results = generateTestSql(
      'stg_orders',
      'BOBSLED_CORE_WORKSPACE',
      [],
      basicColumns,
      'snowflake'
    );

    expect(results).toHaveLength(2);

    const notNull = results.find((r) => r.testName === 'order_id_not_null');
    expect(notNull).toBeDefined();
    expect(notNull!.sql).toContain('IS NULL');

    const unique = results.find((r) => r.testName === 'order_id_unique');
    expect(unique).toBeDefined();
    expect(unique!.sql).toContain('HAVING COUNT(*) > 1');
  });

  it('returns empty array when no tests defined and no primary keys', () => {
    const results = generateTestSql('model', 'SCHEMA', [], noPkColumns, 'snowflake');
    expect(results).toEqual([]);
  });

  it('skips not_null test when column is missing', () => {
    const tests: TestSpec[] = [{ type: 'not_null' }];
    const results = generateTestSql('m', 'S', tests, noPkColumns, 'snowflake');
    expect(results).toEqual([]);
  });

  it('skips unique test when column is missing', () => {
    const tests: TestSpec[] = [{ type: 'unique' }];
    const results = generateTestSql('m', 'S', tests, noPkColumns, 'snowflake');
    expect(results).toEqual([]);
  });

  it('skips accepted_values when column or values missing', () => {
    const tests: TestSpec[] = [
      { type: 'accepted_values', column: 'col' },
      { type: 'accepted_values', values: ['a'] },
    ];
    const results = generateTestSql('m', 'S', tests, noPkColumns, 'snowflake');
    expect(results).toEqual([]);
  });

  it('skips accepted_values when values is empty', () => {
    const tests: TestSpec[] = [{ type: 'accepted_values', column: 'status', values: [] }];
    const results = generateTestSql('m', 'S', tests, noPkColumns, 'snowflake');
    expect(results).toEqual([]);
  });

  it('skips custom test when sql is missing', () => {
    const tests: TestSpec[] = [{ type: 'custom' }];
    const results = generateTestSql('m', 'S', tests, noPkColumns, 'snowflake');
    expect(results).toEqual([]);
  });

  it('auto-generates not_null test for columns with not_null: true', () => {
    const columns: ResolvedColumn[] = [
      { name: 'order_id', expr: 'o.ID' },
      { name: 'status', expr: 'o.STATUS', not_null: true },
    ];
    const results = generateTestSql(
      'stg_orders',
      'BOBSLED_CORE_WORKSPACE',
      [],
      columns,
      'snowflake'
    );

    expect(results).toHaveLength(1);
    const notNull = results.find((r) => r.testName === 'status_not_null');
    expect(notNull).toBeDefined();
    expect(notNull!.sql).toContain('STATUS IS NULL');
  });

  it('does not duplicate not_null test when column has both primary_key and not_null', () => {
    const columns: ResolvedColumn[] = [
      { name: 'order_id', expr: 'o.ID', primary_key: true, not_null: true },
    ];
    const results = generateTestSql(
      'stg_orders',
      'BOBSLED_CORE_WORKSPACE',
      [],
      columns,
      'snowflake'
    );

    // primary_key generates not_null + unique; not_null skips because primary_key is true
    const notNullTests = results.filter((r) => r.testName === 'order_id_not_null');
    expect(notNullTests).toHaveLength(1);
  });

  it('expands {name} template in custom test SQL', () => {
    const tests: TestSpec[] = [
      { type: 'custom', sql: 'SELECT COUNT(*) FROM {name} WHERE amount < 0' },
    ];
    const results = generateTestSql('my_model', 'MY_SCHEMA', tests, noPkColumns, 'snowflake');

    const custom = results.find((r) => r.testName === 'my_model_custom_1');
    expect(custom).toBeDefined();
    expect(custom!.sql).toBe('SELECT COUNT(*) FROM "MY_SCHEMA"."MY_MODEL" WHERE amount < 0;');
  });
});

describe('generateTestSql multi-dialect', () => {
  it('snowflake: uppercase column and quoted identifiers', () => {
    const tests: TestSpec[] = [{ type: 'not_null', column: 'status' }];
    const results = generateTestSql('orders', 'my_schema', tests, noPkColumns, 'snowflake');

    expect(results[0]!.sql).toBe('SELECT * FROM "MY_SCHEMA"."ORDERS" WHERE STATUS IS NULL;');
  });

  it('bigquery: lowercase column and backtick-quoted identifiers', () => {
    const tests: TestSpec[] = [{ type: 'not_null', column: 'STATUS' }];
    const results = generateTestSql('orders', 'my_schema', tests, noPkColumns, 'bigquery');

    expect(results[0]!.sql).toBe('SELECT * FROM `my_schema`.`orders` WHERE status IS NULL;');
  });

  it('postgres: lowercase column and double-quoted identifiers', () => {
    const tests: TestSpec[] = [{ type: 'not_null', column: 'STATUS' }];
    const results = generateTestSql('orders', 'my_schema', tests, noPkColumns, 'postgres');

    expect(results[0]!.sql).toBe('SELECT * FROM "my_schema"."orders" WHERE status IS NULL;');
  });

  it('primary_key auto-tests respect dialect casing', () => {
    const columns: ResolvedColumn[] = [{ name: 'order_id', expr: 'ID', primary_key: true }];
    const results = generateTestSql('orders', 'schema', [], columns, 'bigquery');

    expect(results).toHaveLength(2);
    expect(results[0]!.sql).toContain('`schema`.`orders`');
    expect(results[0]!.sql).toContain('order_id IS NULL');
    expect(results[1]!.sql).toContain('order_id, COUNT(*)');
  });

  const dialects: SupportedDialect[] = [
    'snowflake',
    'bigquery',
    'postgres',
    'databricks',
    'mysql',
    'duckdb',
  ];

  for (const dialect of dialects) {
    it(`${dialect}: generates valid test SQL`, () => {
      const tests: TestSpec[] = [{ type: 'unique', column: 'id' }];
      const results = generateTestSql('model', 'schema', tests, noPkColumns, dialect);
      expect(results).toHaveLength(1);
      expect(results[0]!.sql).toContain('HAVING COUNT(*) > 1');
      expect(results[0]!.sql).toMatch(/;$/);
    });
  }
});
