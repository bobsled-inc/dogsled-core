import type { SchemaColumn } from '@bobsled-inc/protocol';

import { reverseMapDbType, SYSTEM_COLUMN_NAMES } from './database.js';
import type { SchemaComparisonResult } from './database.js';
import { mapBigQueryType, normalizeBqType } from './bigquery-type-mapping.js';

/** Requested columns the table lacks, and requested columns whose type differs. */
export function compareBigQueryColumns(
  columns: SchemaColumn[],
  existing: Map<string, string>
): Pick<SchemaComparisonResult, 'newColumns' | 'typeConflicts'> {
  const newColumns: SchemaColumn[] = [];
  const typeConflicts: SchemaComparisonResult['typeConflicts'] = [];
  for (const col of columns) {
    const existingType = existing.get(col.name);
    const expectedType = mapBigQueryType(col);
    if (existingType === undefined) {
      newColumns.push(col);
    } else if (normalizeBqType(existingType) !== normalizeBqType(expectedType)) {
      typeConflicts.push({
        column: col.name,
        existingType,
        expectedType,
        existingColumnType: reverseMapDbType(existingType),
        expectedColumnType: col.type,
      });
    }
  }
  return { newColumns, typeConflicts };
}

/** Existing non-system columns the request no longer names. */
export function removedBigQueryColumns(
  columns: SchemaColumn[],
  existing: Map<string, string>
): string[] {
  const requested = new Set(columns.map((c) => c.name));
  const system: Set<string> = new Set(SYSTEM_COLUMN_NAMES);
  return [...existing.keys()].filter((name) => !requested.has(name) && !system.has(name));
}

/**
 * Of the loader's safe widenings, BigQuery's SET DATA TYPE accepts only
 * INT64 -> FLOAT64. Fail on the others before any DDL, so a rejected
 * statement never takes the added columns down with it.
 */
export function assertBigQueryWidenings(
  qualifiedTable: string,
  columnsToWiden: SchemaComparisonResult['typeConflicts']
): void {
  const unsupported = columnsToWiden.find(
    (conflict) =>
      normalizeBqType(conflict.existingType) !== 'INT64' ||
      mapBigQueryType(conflict.expectedColumnType) !== 'FLOAT64'
  );
  if (unsupported) {
    throw new Error(
      `Schema change conflict on ${qualifiedTable}.${unsupported.column}: ` +
        `BigQuery cannot change existing type ${unsupported.existingType} to ${unsupported.expectedType}`
    );
  }
}
