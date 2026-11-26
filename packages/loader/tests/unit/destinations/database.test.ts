import { describe, it, expect } from 'vitest';
import type { SchemaColumn } from '@bobsled-inc/protocol';
import {
  buildClusterColumns,
  reverseMapDbType,
  resolvePartitionColumn,
  SYSTEM_COLUMNS,
} from '../../../src/runtime/destinations/database.js';

describe('resolvePartitionColumn', () => {
  const columns: SchemaColumn[] = [
    { name: 'id', type: 'integer' },
    { name: 'accrued_at', type: 'timestamp' },
    { name: 'name', type: 'string' },
    { name: 'updated_at', type: 'timestamp' },
  ];

  it('uses explicit partitionBy when column exists and is timestamp', () => {
    const result = resolvePartitionColumn(columns, { partitionBy: 'accrued_at' });
    expect(result).toBe('accrued_at');
  });

  it('throws when explicit partitionBy column is not in schema', () => {
    expect(() => resolvePartitionColumn(columns, { partitionBy: 'nonexistent' })).toThrow(
      /partition_by column 'nonexistent' not found/
    );
  });

  it('throws when explicit partitionBy column is not timestamp type', () => {
    expect(() => resolvePartitionColumn(columns, { partitionBy: 'name' })).toThrow(
      /partition_by column 'name' must be timestamp type/
    );
  });

  it('uses timestamp cursorField when no explicit partitionBy', () => {
    const result = resolvePartitionColumn(columns, { cursorField: 'updated_at' });
    expect(result).toBe('updated_at');
  });

  it('falls back to _time_extracted when cursorField is not timestamp type', () => {
    const result = resolvePartitionColumn(columns, { cursorField: 'id' });
    expect(result).toBe(SYSTEM_COLUMNS.TIME_EXTRACTED);
  });

  it('falls back to _time_extracted when no options provided', () => {
    const result = resolvePartitionColumn(columns);
    expect(result).toBe(SYSTEM_COLUMNS.TIME_EXTRACTED);
  });

  it('falls back to _time_extracted when cursorField not in columns', () => {
    const result = resolvePartitionColumn(columns, { cursorField: 'missing_field' });
    expect(result).toBe(SYSTEM_COLUMNS.TIME_EXTRACTED);
  });

  it('throws when explicit partitionBy is not a valid identifier', () => {
    expect(() => resolvePartitionColumn(columns, { partitionBy: 'DROP TABLE' })).toThrow(
      /not a valid identifier/
    );
  });

  it.each(['1col', 'col-name', 'col.name', ''])(
    'rejects invalid partitionBy identifier %j',
    (partitionBy) => {
      expect(() => resolvePartitionColumn(columns, { partitionBy })).toThrow(
        /not a valid identifier/
      );
    }
  );

  it('prefers explicit partitionBy over cursorField', () => {
    const result = resolvePartitionColumn(columns, {
      partitionBy: 'accrued_at',
      cursorField: 'updated_at',
    });
    expect(result).toBe('accrued_at');
  });
});

describe('buildClusterColumns', () => {
  const columns: SchemaColumn[] = [
    { name: 'id', type: 'integer' },
    { name: 'updated_at', type: 'timestamp' },
    { name: 'account_id', type: 'string' },
    { name: 'service', type: 'string' },
    { name: 'extra', type: 'string' },
  ];

  it('puts cursorField first then key_properties up to 4', () => {
    const result = buildClusterColumns(columns, {
      cursorField: 'updated_at',
      keyProperties: ['id', 'account_id', 'service', 'extra'],
    });
    expect(result).toEqual(['updated_at', 'id', 'account_id', 'service']);
  });

  it('returns empty array when no options', () => {
    const result = buildClusterColumns(columns);
    expect(result).toEqual([]);
  });

  it('skips cursorField not in columns', () => {
    const result = buildClusterColumns(columns, {
      cursorField: 'missing',
      keyProperties: ['id'],
    });
    expect(result).toEqual(['id']);
  });

  it('deduplicates cursorField when it is also a key property', () => {
    const result = buildClusterColumns(columns, {
      cursorField: 'updated_at',
      keyProperties: ['updated_at', 'id'],
    });
    expect(result).toEqual(['updated_at', 'id']);
  });

  it('skips key properties that are not present in the schema', () => {
    const result = buildClusterColumns(columns, {
      keyProperties: ['id', 'ghost_column'],
    });
    expect(result).toEqual(['id']);
  });
});

describe('reverseMapDbType', () => {
  it('maps BigQuery ARRAY<FLOAT64> to vector', () => {
    expect(reverseMapDbType('ARRAY<FLOAT64>')).toBe('vector');
  });

  it('maps DuckDB FLOAT[1536] to vector', () => {
    expect(reverseMapDbType('FLOAT[1536]')).toBe('vector');
  });

  it('maps Postgres vector(1536) to vector', () => {
    expect(reverseMapDbType('vector(1536)')).toBe('vector');
  });

  it.each(['VECTOR', 'VECTOR(FLOAT, 1536)', 'VECTOR(INT, 16)'])(
    'maps Snowflake %s to vector',
    (type) => {
      expect(reverseMapDbType(type)).toBe('vector');
    }
  );

  it.each(['Array(Float32)', 'Array(Float64)', 'Array(BFloat16)'])(
    'maps ClickHouse %s to vector',
    (type) => {
      expect(reverseMapDbType(type)).toBe('vector');
    }
  );

  it('keeps ClickHouse Array(String) as a string fallback', () => {
    expect(reverseMapDbType('Array(String)')).toBe('string');
  });

  it('keeps scalar mappings unchanged', () => {
    expect(reverseMapDbType('TEXT')).toBe('string');
  });
});
