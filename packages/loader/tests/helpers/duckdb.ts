import {
  allRows,
  closeDuckDbResources,
  escapeSqlString,
  openDuckDb,
} from '../../src/runtime/duckdb-primitives.js';

import type {
  DuckDbConnectionLike,
  DuckDbDatabaseLike,
} from '../../src/runtime/duckdb-primitives.js';
import type { OutputFormat } from '../../src/runtime/formats.js';

export type FileOutputFormat = OutputFormat;

function normalizeValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }

  if (typeof value === 'object' && value !== null) {
    const normalizedEntries = Object.entries(value).map(([key, innerValue]) => [
      key,
      normalizeValue(innerValue),
    ]);
    return Object.fromEntries(normalizedEntries);
  }

  return value;
}

async function withDuckDb<T>(
  dbPath: string,
  fn: (conn: DuckDbConnectionLike) => Promise<T>
): Promise<T> {
  let db: DuckDbDatabaseLike | null = null;
  let conn: DuckDbConnectionLike | null = null;
  try {
    db = await openDuckDb(dbPath);
    conn = await db.connect();
    return await fn(conn);
  } finally {
    await closeDuckDbResources(conn, db);
  }
}

export async function queryRows(sql: string): Promise<Record<string, unknown>[]> {
  return withDuckDb(':memory:', async (conn) => {
    const rows = await allRows(conn, sql);
    return rows.map((row) =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]))
    );
  });
}

export async function readRowsFromFile(
  filePath: string,
  format: FileOutputFormat
): Promise<Record<string, unknown>[]> {
  const escapedPath = escapeSqlString(filePath);

  switch (format) {
    case 'jsonl':
      return queryRows(`SELECT * FROM read_json_auto('${escapedPath}')`);
    case 'csv':
      return queryRows(`SELECT * FROM read_csv_auto('${escapedPath}', header = true)`);
    case 'parquet':
      return queryRows(`SELECT * FROM read_parquet('${escapedPath}')`);
    case 'arrow':
      return queryRows(
        `INSTALL arrow FROM community; LOAD arrow; SELECT * FROM read_arrow('${escapedPath}')`
      );
  }
}

/**
 * Read rows from a persistent DuckDB file without normalization.
 *
 * Returns values in the raw shape produced by `@duckdb/node-api`'s
 * `getRowObjectsJS()` — `bigint` for BIGINT, `Date` for TIMESTAMP, etc.
 * Used by tests that need to assert on the type-marshalling contract.
 */
export async function queryPersistentDb(
  dbPath: string,
  sql: string
): Promise<Record<string, unknown>[]> {
  return withDuckDb(dbPath, (conn) => allRows(conn, sql));
}

export function sortRowsByNumericField(
  rows: Record<string, unknown>[],
  field: string
): Record<string, unknown>[] {
  return [...rows].sort((left, right) => {
    const leftValue = Number(left[field]);
    const rightValue = Number(right[field]);
    return leftValue - rightValue;
  });
}
