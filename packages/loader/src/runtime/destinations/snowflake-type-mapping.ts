import type { SchemaColumn } from '@bobsled-inc/protocol';

export function mapSnowflakeType(type: SchemaColumn['type']): string {
  switch (type) {
    case 'integer':
      return 'NUMBER(38,0)';
    case 'number':
      return 'FLOAT';
    case 'boolean':
      return 'BOOLEAN';
    case 'timestamp':
      return 'TIMESTAMP_TZ';
    case 'string':
    case 'array':
    case 'object':
      return 'VARCHAR';
    case 'vector':
      throw new Error('Snowflake vector columns require a SchemaColumn with dimension');
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unsupported column type: ${_exhaustive}`);
    }
  }
}

export function mapSnowflakeColumnType(column: SchemaColumn | SchemaColumn['type']): string {
  if (typeof column !== 'string' && column.type === 'vector') {
    return `VECTOR(FLOAT, ${column.dimension})`;
  }

  return mapSnowflakeType(typeof column === 'string' ? column : column.type);
}

/**
 * Normalize Snowflake types for comparison. INFORMATION_SCHEMA.COLUMNS returns
 * canonical forms (e.g. 'TEXT' for VARCHAR, 'NUMBER' without precision).
 */
export function normalizeSnowflakeType(t: string): string {
  const upper = t.toUpperCase();
  const vectorMatch = upper.match(/^VECTOR\(\s*FLOAT\s*,\s*(\d+)\s*\)$/);
  if (vectorMatch) return `VECTOR(FLOAT, ${vectorMatch[1]})`;
  if (upper.startsWith('NUMBER')) return 'NUMBER';
  if (upper === 'VARCHAR' || upper === 'TEXT') return 'TEXT';
  return upper;
}
