/**
 * Seed SQL codegen — generate CREATE TABLE + INSERT statements.
 *
 * Compiles seed specs with CSV data into warehouse DDL with batched INSERT
 * statements. A batch closes at 1000 rows or about 512 KB of SQL, whichever
 * comes first, so it stays well under BigQuery's 1 MB query-length limit and
 * Snowflake's statement-size limit.
 */

import { quoteIdentifier, buildFqName, getCanonicalDialect } from '../dialect.js';
import { CommandError } from '../../errors.js';

import type { SupportedDialect } from '../dialect.js';
import type { ParsedSeedSpec } from './parser.js';
import type { CsvReadResult } from './csv-reader.js';
import {
  classifySeedType,
  seedColumnSqlType,
  seedValueLiteral,
  unsupportedSeedTypeMessage,
} from './types.js';
import { getSeedUniqueColumns } from './validation.js';

export { seedValueLiteral } from './types.js';

/**
 * Map Model Spec `VECTOR` columns to dialect-native vector types. Each warehouse
 * mature enough to support vector search gets its first-class type;
 * dialects without one fall back to the array/JSON precedent used in the
 * loader's runtime DDL inference.
 */
export function mapVectorType(dialect: SupportedDialect, dimension?: number): string {
  if (dimension === undefined || !Number.isInteger(dimension) || dimension <= 0) {
    throw new Error('VECTOR columns require a positive integer dimension');
  }
  const canonicalDialect = getCanonicalDialect(dialect);
  if (dialect === 'pgvector') {
    return `vector(${dimension})`;
  }
  switch (canonicalDialect) {
    case 'snowflake':
      return `VECTOR(FLOAT, ${dimension})`;
    case 'bigquery':
      return 'ARRAY<FLOAT64>';
    case 'duckdb':
      return `FLOAT[${dimension}]`;
    case 'databricks':
      return 'ARRAY<FLOAT>';
    case 'clickhouse':
      // No fixed-length vector type; the vector-similarity index is declared on
      // an ordinary Array(Float32), which is also what the loader's ClickHouse
      // destination writes.
      return 'Array(Float32)';
    case 'postgres':
      // Plain Postgres (no pgvector extension) — fall back to a JSON array.
      return 'JSONB';
    case 'mysql':
      return 'JSON';
  }
}

// ---------------------------------------------------------------------------
// SQL generation
// ---------------------------------------------------------------------------

/** Maximum rows per INSERT batch. */
export const SEED_BATCH_MAX_ROWS = 1000;
/** Maximum SQL bytes of row data per INSERT batch (half of BigQuery's 1 MB limit). */
export const SEED_BATCH_MAX_BYTES = 512 * 1024;

/**
 * Generate SQL for a seed spec: CREATE OR REPLACE TABLE + batched INSERTs, as
 * one script. Use {@link generateSeedStatements} to execute it: drivers such
 * as BigQuery's and Snowflake's run one statement per call.
 */
export function generateSeedSql(
  spec: ParsedSeedSpec,
  csvData: CsvReadResult,
  dialect: SupportedDialect,
  targetSchema: string
): string {
  return generateSeedStatements(spec, csvData, dialect, targetSchema)
    .map((statement) => `${statement};`)
    .join('\n\n');
}

/**
 * Generate the seed's statements, each without a trailing semicolon, in
 * execution order: the CREATE TABLE, then one INSERT per batch.
 */
export function generateSeedStatements(
  spec: ParsedSeedSpec,
  csvData: CsvReadResult,
  dialect: SupportedDialect,
  targetSchema: string
): string[] {
  const schema = spec.spec.materialization.target_schema ?? targetSchema;
  const tableName = buildFqName(schema, spec.name, dialect);

  for (const column of spec.spec.schema.columns) {
    if (!classifySeedType(column.type)) {
      throw new CommandError(unsupportedSeedTypeMessage(spec.name, column.name, column.type), 2);
    }
  }

  // Column definitions for CREATE TABLE
  const columnDefs = spec.spec.schema.columns
    .map((col) => `  ${quoteIdentifier(col.name, dialect)} ${seedColumnSqlType(col.type, dialect)}`)
    .join(',\n');

  const parts: string[] = [];

  // ClickHouse has no default table engine, and MergeTree requires a sorting
  // key; `tuple()` is its documented "no sorting key" form. Every other dialect
  // infers storage on its own.
  const tableSuffix =
    getCanonicalDialect(dialect) === 'clickhouse' ? ' ENGINE = MergeTree() ORDER BY tuple()' : '';

  // CREATE OR REPLACE TABLE
  const canonicalDialect = getCanonicalDialect(dialect);
  if (spec.spec.materialization.on_conflict === 'replace') {
    // Postgres-family and MySQL have no CREATE OR REPLACE TABLE.
    if (canonicalDialect === 'postgres' || canonicalDialect === 'mysql') {
      parts.push(`DROP TABLE IF EXISTS ${tableName}`);
      parts.push(`CREATE TABLE ${tableName} (\n${columnDefs}\n)`);
    } else {
      parts.push(`CREATE OR REPLACE TABLE ${tableName} (\n${columnDefs}\n)${tableSuffix}`);
    }
  } else {
    parts.push(`CREATE TABLE IF NOT EXISTS ${tableName} (\n${columnDefs}\n)${tableSuffix}`);
  }

  // Map CSV headers to spec column order
  const headerIndexMap = new Map(csvData.headers.map((h, i) => [h.toLowerCase(), i]));
  const columnOrder = spec.spec.schema.columns.map((col) => {
    const idx = headerIndexMap.get(col.name.toLowerCase());
    if (idx === undefined) {
      throw new Error(`Column "${col.name}" not found in CSV headers`);
    }
    return idx;
  });

  // Batched INSERT statements
  const columnNames = spec.spec.schema.columns
    .map((col) => quoteIdentifier(col.name, dialect))
    .join(', ');
  const uniqueColumns = getSeedUniqueColumns(spec);

  const skip = spec.spec.materialization.on_conflict === 'skip';
  if (skip && uniqueColumns.length === 0 && csvData.rows.length > 0) {
    throw new Error(
      `Seed ${spec.name} uses on_conflict: skip but defines no unique_columns or primary_key columns.`
    );
  }
  const renderRow = (row: string[]): string => {
    const vals = columnOrder.map((colIdx, valueIndex) => {
      const column = spec.spec.schema.columns[valueIndex]!;
      const literal = seedValueLiteral(row[colIdx], column.type, dialect);
      return skip ? `${literal} AS ${quoteIdentifier(column.name, dialect)}` : literal;
    });
    return skip ? `SELECT ${vals.join(', ')}` : `(${vals.join(', ')})`;
  };

  for (const batch of batchRows(csvData.rows.map(renderRow))) {
    if (skip) {
      const selectRows = batch.join('\nUNION ALL\n');

      const conflictPredicate = uniqueColumns
        .map((column) => {
          const columnRef = quoteIdentifier(column, dialect);
          return `existing.${columnRef} = incoming.${columnRef}`;
        })
        .join(' AND ');

      parts.push(
        [
          `INSERT INTO ${tableName} (${columnNames})`,
          `SELECT ${columnNames}`,
          `FROM (`,
          selectRows,
          `) incoming`,
          `WHERE NOT EXISTS (`,
          `  SELECT 1`,
          `  FROM ${tableName} existing`,
          `  WHERE ${conflictPredicate}`,
          `)`,
        ].join('\n')
      );
      continue;
    }

    parts.push(`INSERT INTO ${tableName} (${columnNames})\nVALUES\n${batch.join(',\n')}`);
  }

  return parts;
}

/**
 * Group rendered rows into batches of at most {@link SEED_BATCH_MAX_ROWS} rows
 * and {@link SEED_BATCH_MAX_BYTES} bytes. A single row larger than the byte
 * limit gets its own batch.
 */
function batchRows(rows: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const row of rows) {
    const rowBytes = Buffer.byteLength(row, 'utf8') + 2;
    if (
      current.length > 0 &&
      (current.length >= SEED_BATCH_MAX_ROWS || bytes + rowBytes > SEED_BATCH_MAX_BYTES)
    ) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += rowBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
