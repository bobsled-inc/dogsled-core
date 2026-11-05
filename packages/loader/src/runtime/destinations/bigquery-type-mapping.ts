import type { ColumnType, SchemaColumn } from '@bobsled-inc/protocol';

/** Normalize BigQuery type aliases to canonical forms for comparison. */
export function normalizeBqType(t: string): string {
  switch (t.toUpperCase()) {
    case 'INTEGER':
      return 'INT64';
    case 'FLOAT':
      return 'FLOAT64';
    case 'BOOLEAN':
      return 'BOOL';
    default:
      return t.toUpperCase();
  }
}

export function mapBigQueryType(column: ColumnType | SchemaColumn): string {
  const type = typeof column === 'string' ? column : column.type;
  switch (type) {
    case 'integer':
      return 'INT64';
    case 'number':
      return 'FLOAT64';
    case 'boolean':
      return 'BOOL';
    case 'timestamp':
      return 'TIMESTAMP';
    case 'string':
    case 'array':
    case 'object':
      return 'STRING';
    case 'vector':
      return 'ARRAY<FLOAT64>';
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unsupported column type: ${_exhaustive}`);
    }
  }
}

export function buildBigQuerySchemaField(column: SchemaColumn): {
  name: string;
  mode?: 'NULLABLE' | 'REPEATED';
  type: string;
} {
  if (column.type === 'vector') {
    return { name: column.name, type: 'FLOAT64', mode: 'REPEATED' };
  }

  return { name: column.name, type: mapBigQueryType(column), mode: 'NULLABLE' };
}

export function getExistingBigQueryType(field: { mode?: string; type: string }): string {
  const normalizedType = normalizeBqType(field.type);
  if (field.mode?.toUpperCase() === 'REPEATED' && normalizedType === 'FLOAT64') {
    return 'ARRAY<FLOAT64>';
  }

  return normalizedType;
}
