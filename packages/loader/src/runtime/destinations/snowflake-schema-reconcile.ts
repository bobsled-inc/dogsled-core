import { withRetry, type RetryOptions } from '../retry.js';

import type { ColumnType, SchemaColumn } from '@bobsled-inc/protocol';
import type { EnsureTableOptions, SchemaComparisonResult } from './database.js';
import { enforceSchemaContract, SYSTEM_COLUMNS } from './database.js';
import type { SnowflakeConnectionLike } from './snowflake.js';
import type { SnowflakeTableMaintenanceContext } from './snowflake-table-maintenance.js';

interface SnowflakeSchemaConnection {
  execute(options: { sqlText: string }): Promise<unknown>;
}

/**
 * Replace the plain VECTOR that INFORMATION_SCHEMA.COLUMNS reports for a vector column with its
 * full type from DESCRIBE TABLE, such as VECTOR(FLOAT, 3). This reads nothing unless the stream
 * declares such a column as a vector and its schema_behavior compares types.
 */
export async function readSnowflakeVectorTypes(
  context: Pick<SnowflakeTableMaintenanceContext, 'retryOpts' | 'throwIfCancelled'>,
  connection: Pick<SnowflakeConnectionLike, 'execute'>,
  qualifiedTable: string,
  columns: SchemaColumn[],
  options: EnsureTableOptions | undefined,
  existingMap: Map<string, string>
): Promise<void> {
  if (options?.schemaBehavior === 'freeze' && !options.reconcileSchema) return;
  const isPlainVector = (name: string): boolean =>
    existingMap.get(name)?.toUpperCase() === 'VECTOR';
  if (!columns.some((c) => c.type === 'vector' && isPlainVector(c.name.toUpperCase()))) return;

  const described = await withRetry(
    () => connection.execute({ sqlText: `DESCRIBE TABLE ${qualifiedTable}` }),
    context.retryOpts('describe_table')
  );
  context.throwIfCancelled();
  for (const row of described.getRows()) {
    const name = String(row['name']);
    if (isPlainVector(name)) existingMap.set(name, String(row['type']));
  }
}

/** Compare an incoming schema with Snowflake's cached or queried column map. */
export function compareSnowflakeSchema(
  columns: SchemaColumn[],
  existingMap: ReadonlyMap<string, string>,
  mapColumnType: (column: SchemaColumn) => string,
  normalizeType: (type: string) => string,
  reverseMapType: (type: string) => ColumnType
): SchemaComparisonResult {
  const systemColumnNames = new Set([
    SYSTEM_COLUMNS.TIME_EXTRACTED.toUpperCase(),
    SYSTEM_COLUMNS.LOADED_AT.toUpperCase(),
  ]);
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
