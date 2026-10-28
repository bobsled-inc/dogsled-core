import { describe, expect, it } from 'vitest';

import {
  buildRowCountSql,
  buildSampleSql,
  formatTableReference,
} from '../../../src/profiler/sql.js';

describe('profiler SQL helpers', () => {
  it('quotes dotted table identifiers per dialect', () => {
    expect(formatTableReference('raw.customers', 'snowflake')).toBe('"RAW"."CUSTOMERS"');
    expect(formatTableReference('raw.customers', 'duckdb')).toBe('"raw"."customers"');
    expect(formatTableReference('raw.customers', 'postgres')).toBe('"raw"."customers"');
    expect(formatTableReference('project.dataset.customers', 'bigquery')).toBe(
      '`project`.`dataset`.`customers`'
    );
    expect(formatTableReference('db.customers', 'mysql')).toBe('`db`.`customers`');
    expect(formatTableReference('catalog.schema.customers', 'databricks')).toBe(
      '`catalog`.`schema`.`customers`'
    );
  });

  it('builds count and bounded sample SQL', () => {
    expect(buildRowCountSql('raw.customers', 'snowflake')).toBe(
      'SELECT COUNT(*) AS "ROW_COUNT" FROM "RAW"."CUSTOMERS"'
    );
    expect(buildSampleSql('raw.customers', 'snowflake', 25)).toBe(
      'SELECT * FROM "RAW"."CUSTOMERS" LIMIT 25'
    );
    expect(buildRowCountSql('raw.customers', 'duckdb')).toBe(
      'SELECT COUNT(*) AS "row_count" FROM "raw"."customers"'
    );
    expect(buildSampleSql('raw.customers', 'duckdb', 25)).toBe(
      'SELECT * FROM "raw"."customers" LIMIT 25'
    );
    expect(buildRowCountSql('raw.customers', 'postgres')).toBe(
      'SELECT COUNT(*) AS "row_count" FROM "raw"."customers"'
    );
    expect(buildSampleSql('raw.customers', 'postgres', 25)).toBe(
      'SELECT * FROM "raw"."customers" LIMIT 25'
    );
    expect(buildRowCountSql('project.dataset.customers', 'bigquery')).toBe(
      'SELECT COUNT(*) AS `row_count` FROM `project`.`dataset`.`customers`'
    );
    expect(buildSampleSql('project.dataset.customers', 'bigquery', 25)).toBe(
      'SELECT * FROM `project`.`dataset`.`customers` LIMIT 25'
    );
    expect(buildRowCountSql('db.customers', 'mysql')).toBe(
      'SELECT COUNT(*) AS `row_count` FROM `db`.`customers`'
    );
    expect(buildSampleSql('db.customers', 'mysql', 25)).toBe(
      'SELECT * FROM `db`.`customers` LIMIT 25'
    );
    expect(buildRowCountSql('catalog.schema.customers', 'databricks')).toBe(
      'SELECT COUNT(*) AS `row_count` FROM `catalog`.`schema`.`customers`'
    );
    expect(buildSampleSql('catalog.schema.customers', 'databricks', 25)).toBe(
      'SELECT * FROM `catalog`.`schema`.`customers` LIMIT 25'
    );
  });

  it('rejects unsafe table references', () => {
    expect(() => formatTableReference('raw.customers;drop', 'duckdb')).toThrow(
      'Unsafe table identifier'
    );
  });

  it('caps sample sizes to avoid accidental full scans', () => {
    expect(() => buildSampleSql('raw.customers', 'duckdb', 100_001)).toThrow(
      '--sample-size must be at most 100000'
    );
  });
});
