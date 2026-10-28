import { describe, expect, it } from 'vitest';

import { generateExpectationSql } from '../../../src/compiler/expect/codegen.js';
import { collectModelExpectations } from '../../../src/compiler/expect/parser.js';

import type { SupportedDialect } from '../../../src/compiler/dialect.js';
import type { ResolvedTransformSpec } from '../../../src/compiler/parser.js';

const REGEX_TOKENS: Record<SupportedDialect, string> = {
  snowflake: 'REGEXP_LIKE',
  bigquery: 'REGEXP_CONTAINS',
  postgres: ' ~ ',
  pgvector: ' ~ ',
  redshift: ' ~ ',
  databricks: ' RLIKE ',
  mysql: ' REGEXP ',
  duckdb: 'regexp_matches',
};

const STRING_CAST_TOKENS: Record<SupportedDialect, string> = {
  snowflake: 'AS STRING',
  bigquery: 'AS STRING',
  postgres: 'AS VARCHAR',
  pgvector: 'AS VARCHAR',
  redshift: 'AS VARCHAR',
  databricks: 'AS STRING',
  mysql: 'AS CHAR',
  duckdb: 'AS VARCHAR',
};

describe('expectation SQL codegen', () => {
  it('generates sentinel SQL for primary_key, non_null, and unique checks', () => {
    const statements = generateExpectationSql({
      modelName: 'stg_customers',
      tableName: 'analytics.stg_customers',
      dialect: 'postgres',
      outputColumns: ['customer_id', 'email'],
      expectations: [
        { kind: 'primary_key', columns: ['customer_id'] },
        { kind: 'non_null', column: 'email' },
        { kind: 'unique', columns: ['email'] },
      ],
    });

    expect(statements).toHaveLength(3);
    expect(statements[0]!.sql).toContain("'primary_key' AS kind");
    expect(statements[0]!.sql).toContain('"customer_id" IS NULL');
    expect(statements[0]!.sql).toContain('HAVING COUNT(*) > 1');
    expect(statements[1]!.sql).toContain('"email" IS NULL');
    expect(statements[2]!.sql).toContain('GROUP BY "email"');
  });

  it('generates deterministic schema_contains sentinel SQL without warehouse access', () => {
    const [statement] = generateExpectationSql({
      modelName: 'stg_customers',
      tableName: 'analytics.stg_customers',
      dialect: 'duckdb',
      outputColumns: ['customer_id'],
      expectations: [{ kind: 'schema_contains', columns: ['customer_id', 'email'] }],
    });

    expect(statement!.sql).toContain("'schema_contains' AS kind");
    expect(statement!.sql).toContain('1 AS violation_count');
    expect(statement!.sql).not.toContain('FROM');
  });

  it('generates dialect-specific regex and row count checks', () => {
    const statements = generateExpectationSql({
      modelName: 'stg_customers',
      tableName: 'analytics.stg_customers',
      dialect: 'bigquery',
      outputColumns: ['email'],
      expectations: [
        { kind: 'regex', column: 'email', pattern: '^.+@.+$' },
        { kind: 'row_count_between', min: 1, max: 100 },
      ],
    });

    expect(statements[0]!.sql).toContain('REGEXP_CONTAINS');
    expect(statements[0]!.sql).toContain('CAST(`email` AS STRING)');
    expect(statements[1]!.sql).toContain('COUNT(*) < 1 OR COUNT(*) > 100');
  });

  it('rejects row_count_between without min or max before emitting SQL', () => {
    expect(() =>
      generateExpectationSql({
        modelName: 'stg_customers',
        tableName: 'analytics.stg_customers',
        dialect: 'postgres',
        outputColumns: ['customer_id'],
        expectations: [{ kind: 'row_count_between' } as never],
      })
    ).toThrow('row_count_between expectation requires at least one of min or max');
  });

  it('collects expectation output columns from inherited, projected, and derived fields', () => {
    const parsed = collectModelExpectations(
      {
        name: 'stg_events',
        columns: [
          { name: 'event_id', expr: 'id' },
          { name: 'INTERNAL_ID', expr: 'internal_id' },
        ],
        derivedColumns: [{ name: 'event_day', expr: 'DATE_TRUNC(event_ts, DAY)' }],
        excludeColumns: ['internal_id'],
        expect: [],
      } as ResolvedTransformSpec,
      'analytics.stg_events',
      ['event_id', 'internal_id']
    );

    expect(parsed.outputColumns).toEqual(['event_id', 'event_day']);
  });

  it('uses MySQL-compatible string casts for regex checks', () => {
    const [statement] = generateExpectationSql({
      modelName: 'stg_customers',
      tableName: 'analytics.stg_customers',
      dialect: 'mysql',
      outputColumns: ['email'],
      expectations: [{ kind: 'regex', column: 'email', pattern: '^.+@.+$' }],
    });

    expect(statement!.sql).toContain('CAST(`email` AS CHAR) REGEXP');
    expect(statement!.sql).not.toContain('AS VARCHAR');
  });

  it.each<{
    dialect: SupportedDialect;
    columnRef: string;
    tableRef: string;
  }>([
    { dialect: 'snowflake', columnRef: '"STATUS"', tableRef: '"ANALYTICS"."STG_CUSTOMERS"' },
    { dialect: 'bigquery', columnRef: '`status`', tableRef: '`analytics`.`stg_customers`' },
    { dialect: 'postgres', columnRef: '"status"', tableRef: '"analytics"."stg_customers"' },
    { dialect: 'duckdb', columnRef: '"status"', tableRef: '"analytics"."stg_customers"' },
  ])('generates accepted_values, expression, and custom SQL for $dialect', (testCase) => {
    const statements = generateExpectationSql({
      modelName: 'stg_customers',
      tableName: 'analytics.stg_customers',
      dialect: testCase.dialect,
      outputColumns: ['customer_id', 'status', 'age'],
      expectations: [
        {
          kind: 'accepted_values',
          column: 'status',
          values: ['active', 'inactive', 42, true],
          severity: 'warn',
        },
        { kind: 'expression', expression: 'age >= 18' },
        {
          kind: 'custom',
          sql: 'SELECT COUNT(*) AS violation_count FROM {model} WHERE age < 0',
          description: 'No negative ages',
        },
      ],
    });

    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatchObject({
      kind: 'accepted_values',
      target: 'status',
      severity: 'warn',
    });
    expect(statements[0]!.sql).toContain(`${testCase.columnRef} IS NOT NULL`);
    expect(statements[0]!.sql).toContain(
      `${testCase.columnRef} NOT IN ('active', 'inactive', 42, TRUE)`
    );
    expect(statements[1]).toMatchObject({
      kind: 'expression',
      target: 'age >= 18',
      severity: 'error',
    });
    expect(statements[1]!.sql).toContain('WHERE NOT (age >= 18)');
    expect(statements[2]).toMatchObject({
      kind: 'custom',
      target: 'No negative ages',
      severity: 'error',
    });
    expect(statements[2]!.sql).toContain('SELECT violation_count');
    expect(statements[2]!.sql).toContain(`FROM ${testCase.tableRef} WHERE age < 0`);
  });

  it.each<SupportedDialect>([
    'snowflake',
    'bigquery',
    'postgres',
    'pgvector',
    'redshift',
    'databricks',
    'mysql',
    'duckdb',
  ])('generates expectation SQL for %s', (dialect) => {
    const statements = generateExpectationSql({
      modelName: 'stg_customers',
      tableName: 'analytics.stg_customers',
      dialect,
      outputColumns: ['customer_id', 'email'],
      expectations: [
        { kind: 'primary_key', columns: ['customer_id'] },
        { kind: 'non_null', column: 'email' },
        { kind: 'unique', columns: ['email'] },
        { kind: 'regex', column: 'email', pattern: '^.+@.+$' },
        { kind: 'schema_contains', columns: ['customer_id', 'email'] },
        { kind: 'row_count_between', min: 1, max: 100 },
      ],
    });

    expect(statements).toHaveLength(6);
    expect(statements.map((statement) => statement.kind)).toEqual([
      'primary_key',
      'non_null',
      'unique',
      'regex',
      'schema_contains',
      'row_count_between',
    ]);
    expect(statements[3]!.sql).toContain(REGEX_TOKENS[dialect]);
    expect(statements[3]!.sql).toContain(STRING_CAST_TOKENS[dialect]);
    expect(statements[4]!.sql).not.toContain('FROM');
    expect(statements[5]!.sql).toContain('COUNT(*) < 1 OR COUNT(*) > 100');
  });
});
