import { withRetry, type RetryOptions } from '../retry.js';

import type { ColumnType, SchemaColumn } from '@bobsled-inc/protocol';
import type { EnsureTableOptions, SchemaComparisonResult } from './database.js';
import { enforceSchemaContract, SYSTEM_COLUMN_NAMES } from './database.js';

interface SnowflakeSchemaConnection {
  execute(options: { sqlText: string }): Promise<unknown>;
}

/** Column name -> data type from INFORMATION_SCHEMA.COLUMNS rows. */
export function snowflakeColumnMap(
  rows: ReadonlyArray<Record<string, unknown>>
): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(String(row['COLUMN_NAME'] ?? ''), String(row['DATA_TYPE'] ?? ''));
  }
  return map;
}

/** Compare an incoming schema with Snowflake's cached or queried column map. */
export function compareSnowflakeSchema(
  columns: SchemaColumn[],
  existingMap: ReadonlyMap<string, string>,
  mapColumnType: (column: SchemaColumn) => string,
  normalizeType: (type: string) => string,
  reverseMapType: (type: string) => ColumnType
): SchemaComparisonResult {
  const systemColumnNames = new Set(SYSTEM_COLUMN_NAMES.map((name) => name.toUpperCase()));
  const newColumns: SchemaColumn[] = [];
  const typeConflicts: SchemaComparisonResult['typeConflicts'] = [];
  const requestedNames = new Set(columns.map((column) => column.name.toUpperCase()));
  const removedColumns: string[] = [];

  for (const column of columns) {
    const upperName = column.name.toUpperCase();
    const existingType = existingMap.get(upperName);
    const expectedType = mapColumnType(column);
    if (existingType === undefined) {
      newColumns.push(column);
    } else if (normalizeType(existingType) !== normalizeType(expectedType)) {
      typeConflicts.push({
        column: column.name,
        existingType,
        expectedType,
        existingColumnType: reverseMapType(existingType),
        expectedColumnType: column.type,
      });
    }
  }

  for (const existingName of existingMap.keys()) {
    if (!requestedNames.has(existingName) && !systemColumnNames.has(existingName)) {
      removedColumns.push(existingName);
    }
  }

  return { newColumns, removedColumns, typeConflicts };
}

/** Reconciliation is the one operation that intentionally permits safe widening. */
export function enforceContract(
  options: EnsureTableOptions | undefined,
  comparison: SchemaComparisonResult,
  qualifiedTable: string
): ReturnType<typeof enforceSchemaContract> {
  return enforceSchemaContract(
    options?.reconcileSchema ? 'evolve' : options?.schemaBehavior,
    comparison,
    qualifiedTable
  );
}

/** Drop schema-contract columns and keep the in-memory Snowflake cache aligned. */
export async function reconcileRemovedSnowflakeColumns(
  connection: SnowflakeSchemaConnection,
  qualifiedTable: string,
  removedColumns: readonly string[],
  columnCache: Map<string, string>,
  throwIfCancelled: () => void,
  retryOptions: (context: string) => RetryOptions,
  quoteIdentifier: (identifier: string) => string,
  beforeMutation?: () => Promise<void>
): Promise<void> {
  for (const removedColumn of removedColumns) {
    throwIfCancelled();
    await withRetry(async () => {
      await beforeMutation?.();
      return connection.execute({
        sqlText: `ALTER TABLE ${qualifiedTable} DROP COLUMN ${quoteIdentifier(removedColumn)}`,
      });
    }, retryOptions('drop_column'));
    columnCache.delete(removedColumn.toUpperCase());
  }
}
