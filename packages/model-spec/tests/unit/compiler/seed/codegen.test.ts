import { describe, expect, it } from 'vitest';

import {
  generateSeedSql,
  generateSeedStatements,
  SEED_BATCH_MAX_BYTES,
  seedValueLiteral,
} from '../../../../src/compiler/seed/codegen.js';
import { readCsv } from '../../../../src/compiler/seed/csv-reader.js';

import type { SupportedDialect } from '../../../../src/compiler/dialect.js';
import type { ParsedSeedSpec } from '../../../../src/compiler/seed/parser.js';

const COLUMNS = [
  { name: 'id', type: 'INTEGER' },
  { name: 'amount', type: 'DOUBLE' },
  { name: 'price', type: 'DECIMAL' },
  { name: 'active', type: 'BOOLEAN' },
  { name: 'order_date', type: 'DATE' },
  { name: 'note', type: 'STRING' },
];

const CSV = [
  'id,amount,price,active,order_date,note',
  "1,10,1.50,true,2025-01-01,it's",
  '2,-0.5,2,no,2025-01-02,',
  '007,1e3,3.25,1,2025-01-03,plain',
].join('\n');

function seed(onConflict: 'replace' | 'skip' = 'replace'): ParsedSeedSpec {
  return {
    name: 'orders',
    filePath: 'seeds/orders.yml',
    csvPath: 'seeds/data/orders.csv',
    spec: {
      spec_version: '0.2',
      type: 'seed',
      name: 'orders',
      payload: { format: 'csv', path: 'data/orders.csv' },
      schema: { columns: COLUMNS },
      materialization: { type: 'table', on_conflict: onConflict },
      validation: onConflict === 'skip' ? { unique_columns: ['id'] } : undefined,
    } as ParsedSeedSpec['spec'],
  };
}

function csv() {
  return readCsv(CSV, { delimiter: ',', expectedColumns: COLUMNS.map((column) => column.name) });
}

const statements = (dialect: SupportedDialect, onConflict: 'replace' | 'skip' = 'replace') =>
  generateSeedStatements(seed(onConflict), csv(), dialect, 'shop');

describe('seed codegen on strictly typed warehouses', () => {
  it('emits BigQuery types and typed literals', () => {
    const [create, insert] = statements('bigquery');

    expect(create).toContain('`id` INT64');
    expect(create).toContain('`amount` FLOAT64');
    expect(create).toContain('`price` NUMERIC');
    expect(create).toContain('`active` BOOL');
    expect(create).toContain('`order_date` DATE');
    expect(create).toContain('`note` STRING');
    expect(insert).toContain(
      "(1, 10, CAST('1.50' AS NUMERIC), TRUE, CAST('2025-01-01' AS DATE), 'it\\'s')"
    );
    expect(insert).toContain(
      "(2, -0.5, CAST('2' AS NUMERIC), FALSE, CAST('2025-01-02' AS DATE), NULL)"
    );
    expect(insert).toContain(
      "(7, 1e3, CAST('3.25' AS NUMERIC), TRUE, CAST('2025-01-03' AS DATE), 'plain')"
    );
  });

  it('maps DOUBLE and FLOAT to a real floating type on Snowflake', () => {
    const [create, insert] = statements('snowflake');

    expect(create).toContain('"AMOUNT" FLOAT');
    expect(create).toContain('"ID" INTEGER');
    expect(insert).toContain(
      "(1, 10, CAST('1.50' AS DECIMAL(38, 9)), TRUE, CAST('2025-01-01' AS DATE)"
    );
  });

  it('keeps Postgres and DuckDB types and accepts typed literals', () => {
    const [pgDrop, pgCreate, pgInsert] = statements('postgres');
    // Postgres has no CREATE OR REPLACE TABLE.
    expect(pgDrop).toBe('DROP TABLE IF EXISTS "shop"."orders"');
    expect(pgCreate).toMatch(/^CREATE TABLE "shop"\."orders" \(/);
    expect(pgCreate).toContain('"amount" DOUBLE PRECISION');
    expect(pgCreate).toContain('"note" VARCHAR(4096)');
    expect(pgInsert).toContain(
      "(1, 10, CAST('1.50' AS DECIMAL), TRUE, CAST('2025-01-01' AS DATE), 'it''s')"
    );

    const [duckCreate, duckInsert] = statements('duckdb');
    expect(duckCreate).toContain('"amount" DOUBLE PRECISION');
    expect(duckInsert).toContain('(2, -0.5,');
  });

  it('drops and recreates the table on MySQL', () => {
    const [drop, create] = statements('mysql');
    expect(drop).toMatch(/^DROP TABLE IF EXISTS /);
    expect(create).toMatch(/^CREATE TABLE /);
    expect(create).toContain('DOUBLE');
  });

  it('returns one statement per CREATE and INSERT batch, without semicolons', () => {
    const result = statements('snowflake');

    expect(result).toHaveLength(2);
    expect(result[0]).toMatch(/^CREATE OR REPLACE TABLE/);
    expect(result[1]).toMatch(/^INSERT INTO/);
    expect(result.every((statement) => !statement.trimEnd().endsWith(';'))).toBe(true);
    expect(generateSeedSql(seed(), csv(), 'snowflake', 'shop')).toBe(
      result.map((statement) => `${statement};`).join('\n\n')
    );
  });

  it('types the on_conflict: skip SELECT the same way', () => {
    const [, insert] = statements('bigquery', 'skip');

    expect(insert).toContain('SELECT 1 AS `id`, 10 AS `amount`');
    expect(insert).toContain('TRUE AS `active`');
    expect(insert).toContain('WHERE NOT EXISTS');
  });
});

describe('seedValueLiteral', () => {
  it('never splices a malformed value unquoted', () => {
    expect(seedValueLiteral("1; DROP TABLE x --'", 'INTEGER', 'bigquery')).toBe(
      "CAST('1; DROP TABLE x --\\'' AS INT64)"
    );
    expect(seedValueLiteral('1 OR 1=1', 'DOUBLE', 'postgres')).toBe(
      "CAST('1 OR 1=1' AS DOUBLE PRECISION)"
    );
    expect(seedValueLiteral('maybe', 'BOOLEAN', 'snowflake')).toBe("CAST('maybe' AS BOOLEAN)");
  });

  it('loads blanks and whitespace-only non-text cells as NULL', () => {
    expect(seedValueLiteral('', 'INTEGER', 'bigquery')).toBe('NULL');
    expect(seedValueLiteral('   ', 'INTEGER', 'bigquery')).toBe('NULL');
    expect(seedValueLiteral(undefined, 'DATE', 'snowflake')).toBe('NULL');
    expect(seedValueLiteral('  ', 'STRING', 'snowflake')).toBe("'  '");
  });

  it('rejects an unsupported type instead of quoting it', () => {
    expect(() => seedValueLiteral('x', 'GEOGRAPHY', 'bigquery')).toThrow(
      'Unsupported seed column type "GEOGRAPHY"'
    );
  });

  it('casts a malformed MySQL integer to SIGNED', () => {
    expect(seedValueLiteral('1x', 'BIGINT', 'mysql')).toBe("CAST('1x' AS SIGNED)");
  });

  it('keeps large integers exact', () => {
    expect(seedValueLiteral('9007199254740993', 'INTEGER', 'bigquery')).toBe('9007199254740993');
  });
});

describe('seed types keep fractions and map aliases', () => {
  const sqlType = (type: string, dialect: SupportedDialect): string =>
    generateSeedStatements(
      { ...seed(), spec: { ...seed().spec, schema: { columns: [{ name: 'v', type }] } } },
      readCsv('v\n1\n', { delimiter: ',', expectedColumns: ['v'] }),
      dialect,
      'shop'
    ).find((statement) => statement.includes('CREATE'))!;

  it('gives DECIMAL an explicit scale wherever the default would round', () => {
    expect(sqlType('DECIMAL', 'snowflake')).toContain('DECIMAL(38, 9)');
    expect(sqlType('DECIMAL', 'mysql')).toContain('DECIMAL(38, 9)');
    expect(sqlType('DECIMAL', 'databricks')).toContain('DECIMAL(38, 9)');
    expect(sqlType('DECIMAL', 'duckdb')).toContain('DECIMAL(38, 9)');
    expect(sqlType('DECIMAL', 'bigquery')).toContain('NUMERIC');
    expect(sqlType('DECIMAL', 'clickhouse')).toContain('Nullable(Decimal(38, 9))');
    expect(sqlType('DECIMAL', 'postgres')).toMatch(/"v" DECIMAL\n/);
    expect(sqlType('NUMERIC', 'snowflake')).toContain('NUMERIC(38, 9)');
  });

  it('stores Snowflake NUMBER as FLOAT, like every other dialect', () => {
    expect(sqlType('NUMBER', 'snowflake')).toContain('"V" FLOAT');
    expect(sqlType('NUMBER(10, 2)', 'snowflake')).toContain('"V" NUMBER(10, 2)');
  });

  it('maps common aliases and parameterized types on BigQuery', () => {
    expect(sqlType('INT', 'bigquery')).toContain('`v` INT64');
    expect(sqlType('BIGINT', 'bigquery')).toContain('`v` INT64');
    expect(sqlType('SMALLINT', 'bigquery')).toContain('`v` INT64');
    expect(sqlType('NUMERIC(10,2)', 'bigquery')).toContain('`v` NUMERIC(10, 2)');
    expect(sqlType('decimal(40, 12)', 'bigquery')).toContain('`v` BIGNUMERIC(40, 12)');
    expect(sqlType('STRING(20)', 'bigquery')).toContain('`v` STRING(20)');
    expect(sqlType('VARCHAR(50)', 'bigquery')).toContain('`v` STRING(50)');
    expect(sqlType('DOUBLE PRECISION', 'bigquery')).toContain('`v` FLOAT64');
    expect(sqlType('TIMESTAMP_NTZ', 'bigquery')).toContain('`v` DATETIME');
    expect(seedValueLiteral('0005', 'BIGINT', 'bigquery')).toBe('5');
    // BigQuery rejects parameterized types in CAST; the column applies them.
    expect(seedValueLiteral('1.50', 'NUMERIC(10,2)', 'bigquery')).toBe("CAST('1.50' AS NUMERIC)");
    expect(seedValueLiteral('1.50', 'NUMERIC(10,2)', 'snowflake')).toBe(
      "CAST('1.50' AS NUMERIC(10, 2))"
    );
  });

  it('keeps aliases as written on other dialects', () => {
    expect(sqlType('BIGINT', 'postgres')).toContain('"v" BIGINT');
    expect(sqlType('VARCHAR(50)', 'snowflake')).toContain('"V" VARCHAR(50)');
  });

  it('rejects an unknown type with the seed, column and type named', () => {
    expect(() => sqlType('GEOGRAPHY', 'bigquery')).toThrow(
      'Seed orders column "v" has unsupported type "GEOGRAPHY".'
    );
    expect(() => sqlType('INTEGER(5)', 'snowflake')).toThrow('unsupported type "INTEGER(5)"');
  });
});

describe('seed INSERT batching', () => {
  it('closes a batch at the byte limit as well as the row limit', () => {
    const rows = Array.from({ length: 1500 }, (_, i) => `${i + 1},${'x'.repeat(1000)}`);
    const csvText = ['id,body', ...rows].join('\n');
    const statements = generateSeedStatements(
      {
        ...seed(),
        spec: {
          ...seed().spec,
          schema: {
            columns: [
              { name: 'id', type: 'INTEGER' },
              { name: 'body', type: 'STRING' },
            ],
          },
        },
      },
      readCsv(csvText, { delimiter: ',', expectedColumns: ['id', 'body'] }),
      'bigquery',
      'shop'
    );
    const inserts = statements.filter((statement) => statement.startsWith('INSERT'));

    expect(inserts.length).toBe(3);
    for (const insert of inserts) {
      expect(Buffer.byteLength(insert, 'utf8')).toBeLessThan(SEED_BATCH_MAX_BYTES + 1024);
    }
    const rowCount = inserts.reduce((total, insert) => total + insert.split('\n(').length - 1, 0);
    expect(rowCount).toBe(1500);
  });

  it('puts a single oversized row in its own batch', () => {
    const csvText = ['id,body', `1,${'y'.repeat(SEED_BATCH_MAX_BYTES + 10)}`, '2,z'].join('\n');
    const statements = generateSeedStatements(
      {
        ...seed(),
        spec: {
          ...seed().spec,
          schema: {
            columns: [
              { name: 'id', type: 'INTEGER' },
              { name: 'body', type: 'STRING' },
            ],
          },
        },
      },
      readCsv(csvText, { delimiter: ',', expectedColumns: ['id', 'body'] }),
      'snowflake',
      'shop'
    );

    expect(statements.filter((statement) => statement.startsWith('INSERT'))).toHaveLength(2);
  });
});
