/**
 * Warehouse and database type mapper.
 *
 * Maps source-specific column types to the protocol's ColumnType for use in
 * SCHEMA messages emitted during extraction.
 *
 * Pure functions — no side effects, no I/O. Case-insensitive matching.
 */

import type { ColumnType } from '@bobsled-inc/protocol';

import type { Dialect } from './warehouse-query-builder.js';

// ── Snowflake ──

function mapSnowflakeType(normalized: string, baseType: string): ColumnType {
  // Integer types (no fractional part)
  switch (baseType) {
    case 'INT':
    case 'INTEGER':
    case 'BIGINT':
    case 'SMALLINT':
    case 'TINYINT':
    case 'BYTEINT':
      return 'integer';

    // NUMBER/DECIMAL/NUMERIC — integer if scale=0, otherwise number
    case 'NUMBER':
    case 'DECIMAL':
    case 'NUMERIC': {
      const scaleMatch = normalized.match(/,\s*(\d+)\)/);
      if (scaleMatch?.[1] !== undefined && parseInt(scaleMatch[1], 10) === 0) {
        return 'integer';
      }
      // No parens at all — Snowflake NUMBER defaults to NUMBER(38,0) which is integer
      if (!normalized.includes('(')) {
        return 'integer';
      }
      return 'number';
    }

    case 'FLOAT':
    case 'FLOAT4':
    case 'FLOAT8':
    case 'DOUBLE':
    case 'REAL':
      return 'number';

    case 'VARCHAR':
    case 'CHAR':
    case 'STRING':
    case 'TEXT':
      return 'string';

    case 'BOOLEAN':
      return 'boolean';

    case 'DATE':
      return 'string';

    case 'TIMESTAMP':
    case 'TIMESTAMP_LTZ':
    case 'TIMESTAMP_NTZ':
    case 'TIMESTAMP_TZ':
    case 'DATETIME':
      return 'timestamp';

    case 'VARIANT':
    case 'OBJECT':
      return 'object';

    case 'ARRAY':
      return 'array';

    case 'BINARY':
    case 'VARBINARY':
      return 'string';

    default:
      return 'string';
  }
}

// ── BigQuery ──

function mapBigQueryType(normalized: string, baseType: string): ColumnType {
  // Handle ARRAY<...> and STRUCT<...> prefixes
  if (normalized.startsWith('ARRAY')) return 'array';
  if (normalized.startsWith('STRUCT')) return 'object';

  switch (baseType) {
    case 'INT64':
    case 'INT':
    case 'INTEGER':
    case 'SMALLINT':
    case 'BIGINT':
    case 'TINYINT':
    case 'BYTEINT':
      return 'integer';

    case 'FLOAT64':
    case 'FLOAT':
    case 'NUMERIC':
    case 'BIGNUMERIC':
    case 'DECIMAL':
    case 'BIGDECIMAL':
      return 'number';

    case 'STRING':
      return 'string';

    case 'BOOL':
    case 'BOOLEAN':
      return 'boolean';

    case 'DATE':
      return 'string';

    case 'TIMESTAMP':
    case 'DATETIME':
    case 'TIME':
      return 'timestamp';

    case 'RECORD':
      return 'object';

    case 'ARRAY':
      return 'array';

    case 'JSON':
      return 'object';

    case 'BYTES':
      return 'string';

    case 'GEOGRAPHY':
    case 'INTERVAL':
    case 'RANGE':
      return 'string';

    default:
      return 'string';
  }
}

// ── PostgreSQL ──

function mapPostgresType(normalized: string, baseType: string): ColumnType {
  // Handle array types: text[], varchar(255)[], etc.
  if (normalized.endsWith('[]')) return 'array';

  // Handle pg_catalog underscore array types
  if (baseType.startsWith('_')) return 'array';

  switch (baseType) {
    case 'INT2':
    case 'INT4':
    case 'INT8':
    case 'SMALLINT':
    case 'INTEGER':
    case 'INT':
    case 'BIGINT':
    case 'SERIAL':
    case 'SERIAL2':
    case 'SERIAL4':
    case 'SERIAL8':
    case 'BIGSERIAL':
    case 'SMALLSERIAL':
    case 'OID':
      return 'integer';

    case 'FLOAT4':
    case 'FLOAT8':
    case 'REAL':
    case 'DOUBLE PRECISION':
    case 'NUMERIC':
    case 'DECIMAL':
    case 'MONEY':
      return 'number';

    case 'TEXT':
    case 'VARCHAR':
    case 'CHAR':
    case 'CHARACTER':
    case 'CHARACTER VARYING':
    case 'BPCHAR':
    case 'UUID':
    case 'CITEXT':
    case 'NAME':
    case 'INET':
    case 'CIDR':
    case 'MACADDR':
    case 'MACADDR8':
    case 'INTERVAL':
    case 'BIT':
    case 'BIT VARYING':
    case 'VARBIT':
    case 'BYTEA':
      return 'string';

    case 'BOOL':
    case 'BOOLEAN':
      return 'boolean';

    case 'DATE':
      return 'string';

    case 'TIMESTAMP':
    case 'TIMESTAMPTZ':
    case 'TIMESTAMP WITHOUT TIME ZONE':
    case 'TIMESTAMP WITH TIME ZONE':
      return 'timestamp';

    case 'TIME':
    case 'TIMETZ':
    case 'TIME WITHOUT TIME ZONE':
    case 'TIME WITH TIME ZONE':
      return 'string';

    case 'JSON':
    case 'JSONB':
      return 'object';

    default:
      return 'string';
  }
}

// ── MySQL ──

function mapMySQLType(normalized: string, baseType: string): ColumnType {
  // Special case: TINYINT(1) is boolean in MySQL convention
  if (baseType === 'TINYINT' && normalized.includes('(1)')) {
    return 'boolean';
  }

  switch (baseType) {
    case 'TINYINT':
    case 'SMALLINT':
    case 'MEDIUMINT':
    case 'INT':
    case 'INTEGER':
    case 'BIGINT':
      return 'integer';

    case 'FLOAT':
    case 'DOUBLE':
    case 'DECIMAL':
    case 'NUMERIC':
      return 'number';

    case 'VARCHAR':
    case 'CHAR':
    case 'TEXT':
    case 'TINYTEXT':
    case 'MEDIUMTEXT':
    case 'LONGTEXT':
    case 'ENUM':
    case 'SET':
      return 'string';

    case 'BOOLEAN':
    case 'BOOL':
      return 'boolean';

    case 'DATE':
      return 'string';

    case 'TIMESTAMP':
    case 'DATETIME':
      return 'timestamp';

    case 'TIME':
    case 'YEAR':
      return 'string';

    case 'JSON':
      return 'object';

    case 'BINARY':
    case 'VARBINARY':
    case 'BLOB':
    case 'TINYBLOB':
    case 'MEDIUMBLOB':
    case 'LONGBLOB':
      return 'string';

    default:
      return 'string';
  }
}

// ── Redshift ──

function mapRedshiftType(normalized: string, baseType: string): ColumnType {
  switch (baseType) {
    case 'INT2':
    case 'SMALLINT':
    case 'INT':
    case 'INT4':
    case 'INTEGER':
    case 'INT8':
    case 'BIGINT':
      return 'integer';

    // DECIMAL/NUMERIC — integer if scale=0, otherwise number
    case 'DECIMAL':
    case 'NUMERIC': {
      const scaleMatch = normalized.match(/,\s*(\d+)\)/);
      if (scaleMatch?.[1] !== undefined && parseInt(scaleMatch[1], 10) === 0) {
        return 'integer';
      }
      // No parens — default to number (unlike Snowflake, Redshift NUMERIC defaults to NUMERIC(18,0)
      // but without explicit parens we default to number for safety)
      return 'number';
    }

    case 'FLOAT':
    case 'FLOAT4':
    case 'FLOAT8':
    case 'DOUBLE PRECISION':
    case 'REAL':
      return 'number';

    case 'VARCHAR':
    case 'CHAR':
    case 'CHARACTER':
    case 'CHARACTER VARYING':
    case 'NVARCHAR':
    case 'NCHAR':
    case 'TEXT':
    case 'BPCHAR':
      return 'string';

    case 'BOOLEAN':
    case 'BOOL':
      return 'boolean';

    case 'DATE':
      return 'string';

    case 'TIMESTAMP':
    case 'TIMESTAMPTZ':
    case 'TIMESTAMP WITH TIME ZONE':
    case 'TIMESTAMP WITHOUT TIME ZONE':
      return 'timestamp';

    case 'TIME':
    case 'TIMETZ':
      return 'string';

    case 'SUPER':
      return 'object';

    case 'GEOMETRY':
    case 'GEOGRAPHY':
    case 'HLLSKETCH':
    case 'VARBYTE':
      return 'string';

    default:
      return 'string';
  }
}

// ── DuckDB (shared by Iceberg + Delta) ──

function mapDuckDbType(normalized: string, baseType: string): ColumnType {
  // Handle complex types
  if (normalized.startsWith('STRUCT')) return 'object';
  if (normalized.startsWith('MAP')) return 'object';
  if (normalized.endsWith('[]')) return 'array';

  switch (baseType) {
    case 'BOOLEAN':
    case 'BOOL':
      return 'boolean';

    case 'TINYINT':
    case 'SMALLINT':
    case 'INTEGER':
    case 'INT':
    case 'BIGINT':
    case 'HUGEINT':
    case 'UTINYINT':
    case 'USMALLINT':
    case 'UINTEGER':
    case 'UBIGINT':
      return 'integer';

    case 'FLOAT':
    case 'DOUBLE':
    case 'REAL':
      return 'number';

    case 'DECIMAL':
    case 'NUMERIC': {
      const scaleMatch = normalized.match(/,\s*(\d+)\)/);
      if (scaleMatch?.[1] !== undefined && parseInt(scaleMatch[1], 10) === 0) {
        return 'integer';
      }
      return 'number';
    }

    case 'VARCHAR':
    case 'TEXT':
    case 'CHAR':
    case 'UUID':
    case 'BLOB':
    case 'ENUM':
      return 'string';

    case 'DATE':
    case 'TIME':
    case 'INTERVAL':
      return 'string';

    case 'TIMESTAMP':
    case 'TIMESTAMPTZ':
    case 'TIMESTAMP_S':
    case 'TIMESTAMP_MS':
    case 'TIMESTAMP_NS':
    case 'TIMESTAMP WITH TIME ZONE':
      return 'timestamp';

    case 'JSON':
      return 'object';

    case 'LIST':
    case 'ARRAY':
      return 'array';

    case 'STRUCT':
    case 'MAP':
    case 'UNION':
      return 'object';

    default:
      return 'string';
  }
}

/** Strip Nullable(...) and LowCardinality(...) wrappers so the base type is visible. */
function unwrapClickHouseType(normalized: string): string {
  let type = normalized;
  for (;;) {
    const match = type.match(/^(NULLABLE|LOWCARDINALITY)\((.+)\)$/);
    if (!match) return type;
    type = match[2]!;
  }
}

function mapClickHouseType(normalized: string): ColumnType {
  const inner = unwrapClickHouseType(normalized);
  const base = inner.split('(')[0]?.trim() ?? inner;
  switch (base) {
    case 'INT8':
    case 'INT16':
    case 'INT32':
    case 'INT64':
    case 'INT128':
    case 'INT256':
    case 'UINT8':
    case 'UINT16':
    case 'UINT32':
    case 'UINT64':
    case 'UINT128':
    case 'UINT256':
      return 'integer';
    case 'DECIMAL':
    case 'DECIMAL32':
    case 'DECIMAL64':
    case 'DECIMAL128':
    case 'DECIMAL256': {
      const scaleMatch = inner.match(/,\s*(\d+)\)/);
      if (scaleMatch?.[1] !== undefined && parseInt(scaleMatch[1], 10) === 0) return 'integer';
      return 'number';
    }
    case 'FLOAT32':
    case 'FLOAT64':
    case 'BFLOAT16':
      return 'number';
    case 'BOOL':
    case 'BOOLEAN':
      return 'boolean';
    case 'DATETIME':
    case 'DATETIME64':
      return 'timestamp';
    case 'DATE':
    case 'DATE32':
    case 'TIME':
    case 'TIME64':
    case 'STRING':
    case 'FIXEDSTRING':
    case 'UUID':
    case 'ENUM':
    case 'ENUM8':
    case 'ENUM16':
    case 'IPV4':
    case 'IPV6':
      return 'string';
    case 'ARRAY':
      return 'array';
    case 'MAP':
    case 'TUPLE':
    case 'JSON':
    case 'OBJECT':
    case 'NESTED':
    case 'VARIANT':
    case 'DYNAMIC':
      return 'object';
    default:
      return 'string';
  }
}

// ── Public API ──

/**
 * Map a source-specific column type string to the protocol's ColumnType.
 *
 * Matching is case-insensitive. Unknown types fall back to `'string'`.
 */
export function mapColumnType(dialect: Dialect, sourceType: string): ColumnType {
  const normalized = sourceType.toUpperCase().trim();
  // Extract base type: remove precision/scale parens for switch matching
  const baseType = normalized.split('(')[0]?.trim() ?? normalized;

  switch (dialect) {
    case 'snowflake':
      return mapSnowflakeType(normalized, baseType);
    case 'bigquery':
      return mapBigQueryType(normalized, baseType);
    case 'postgres':
      return mapPostgresType(normalized, baseType);
    case 'redshift':
      return mapRedshiftType(normalized, baseType);
    case 'mysql':
      return mapMySQLType(normalized, baseType);
    case 'clickhouse':
      return mapClickHouseType(normalized);
    case 'iceberg':
    case 'delta':
      return mapDuckDbType(normalized, baseType);
  }
}
