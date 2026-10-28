/**
 * Dialect-aware SQL query builder for warehouse and database extraction.
 *
 * Generates parameterized SQL for full refresh, incremental, and change tracking
 * replication methods across Snowflake, BigQuery, PostgreSQL, MySQL, and ClickHouse.
 *
 * Pure functions — no side effects, no I/O.
 */

import { assertBacktickIdentifier, assertBigQueryQuotedIdentifier } from '@bobsled-inc/protocol';
import { escapeSqlString } from './sql-escape.js';

export type Dialect =
  | 'snowflake'
  | 'bigquery'
  | 'postgres'
  | 'redshift'
  | 'mysql'
  | 'clickhouse'
  | 'iceberg'
  | 'delta';

export interface ChangeTrackingConfig {
  /** Snowflake CHANGES clause information mode. */
  information?: 'default' | 'append_only';
  /** BigQuery CDC type. */
  type?: 'appends' | 'changes';
  /** PostgreSQL logical decoding plugin. */
  plugin?: 'pgoutput';
  /** PostgreSQL logical replication slot. */
  slot_name?: string;
  /** PostgreSQL publication name. */
  publication_name?: string;
}

export interface QueryBuilderConfig {
  dialect: Dialect;
  /** Source table name. */
  table?: string;
  /** Custom SQL override — used as-is or wrapped as subquery. */
  sql?: string;
  /** Database name (Snowflake, MySQL). */
  database?: string;
  /** Schema name (Snowflake, PostgreSQL). */
  schema?: string;
  /** BigQuery dataset. */
  dataset?: string;
  /** BigQuery project. */
  project?: string;
  /** Table-valued function for lakehouse formats (e.g. iceberg_scan('s3://...'), delta_scan('s3://...')). */
  tvf?: string;
  /** Replication method. */
  method: 'full_refresh' | 'incremental_append' | 'incremental_merge' | 'change_tracking';
  /** Cursor column name for incremental methods. */
  cursorField?: string;
  /** Last known cursor value from state. */
  cursorValue?: string;
  /** Change tracking configuration (Snowflake/BigQuery only). */
  changeTracking?: ChangeTrackingConfig;
  /** Last sync timestamp for CDC window. */
  lastSyncTimestamp?: string;
}

export interface BuildResult {
  sql: string;
  params: unknown[];
}

// ── Identifier quoting ──

/**
 * Quote an identifier per dialect conventions.
 * - Snowflake / PostgreSQL: double-quote `"name"`
 * - BigQuery / MySQL / ClickHouse: backtick `` `name` ``
 */
export function quoteIdentifier(dialect: Dialect, name: string): string {
  switch (dialect) {
    case 'snowflake':
    case 'postgres':
    case 'redshift':
    case 'iceberg':
    case 'delta':
      return `"${name.replace(/"/g, '""')}"`;
    case 'bigquery':
      return `\`${assertBigQueryQuotedIdentifier(name)}\``;
    case 'mysql':
    case 'clickhouse':
      assertBacktickIdentifier(name);
      return `\`${name.replace(/`/g, '``')}\``;
  }
}

// ── BigQuery identifier validation ──

/** Validate a BigQuery identifier component to prevent backtick injection.
 * Dots are disallowed since components are joined with dots in the FQN. */
function validateBigQueryComponent(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_:-]*$/.test(value)) {
    throw new Error(`Invalid BigQuery ${label}: "${value}" contains disallowed characters`);
  }
  return value;
}

// ── Fully qualified table name ──

/**
 * Build a fully-qualified table reference per dialect.
 *
 * - Snowflake: `"DB"."SCHEMA"."TABLE"`
 * - BigQuery: `` `project.dataset.table` ``
 * - PostgreSQL: `"schema"."table"`
 * - MySQL / ClickHouse: `` `database`.`table` ``
 */
export function buildFullyQualifiedTable(dialect: Dialect, config: QueryBuilderConfig): string {
  // Lakehouse formats use a pre-built TVF string (e.g. iceberg_scan('s3://...'))
  if ((dialect === 'iceberg' || dialect === 'delta') && config.tvf) {
    return config.tvf;
  }

  if (!config.table) {
    throw new Error('table is required when building a fully-qualified table name');
  }

  switch (dialect) {
    case 'snowflake': {
      const parts: string[] = [];
      if (config.database) parts.push(quoteIdentifier(dialect, config.database));
      if (config.schema) parts.push(quoteIdentifier(dialect, config.schema));
      parts.push(quoteIdentifier(dialect, config.table));
      return parts.join('.');
    }
    case 'bigquery': {
      // BigQuery uses a single backtick-quoted dotted path: `project.dataset.table`
      // Validate each component to prevent backtick injection
      const parts: string[] = [];
      if (config.project) parts.push(validateBigQueryComponent(config.project, 'project'));
      if (config.dataset) parts.push(validateBigQueryComponent(config.dataset, 'dataset'));
      parts.push(validateBigQueryComponent(config.table, 'table'));
      return `\`${parts.join('.')}\``;
    }
    case 'postgres':
    case 'redshift': {
      const parts: string[] = [];
      if (config.schema) parts.push(quoteIdentifier(dialect, config.schema));
      parts.push(quoteIdentifier(dialect, config.table));
      return parts.join('.');
    }
    case 'mysql': {
      const parts: string[] = [];
      if (config.database) parts.push(quoteIdentifier(dialect, config.database));
      parts.push(quoteIdentifier(dialect, config.table));
      return parts.join('.');
    }
    case 'clickhouse': {
      // ClickHouse has no schema level; a resource schema is treated as the database.
      const parts: string[] = [];
      const database = config.database ?? config.schema;
      if (database) parts.push(quoteIdentifier(dialect, database));
      parts.push(quoteIdentifier(dialect, config.table));
      return parts.join('.');
    }
    case 'iceberg':
    case 'delta':
      // Without a TVF, fall back to double-quoted table name
      return quoteIdentifier(dialect, config.table);
  }
}

// ── Parameter placeholder ──

function buildParamPlaceholder(dialect: Dialect, index: number): string {
  switch (dialect) {
    case 'snowflake':
      return `:${index}`;
    case 'bigquery':
      return `@p${index}`;
    case 'postgres':
    case 'redshift':
    case 'iceberg':
    case 'delta':
      return `$${index}`;
    case 'mysql':
      return '?';
    case 'clickhouse':
      return `{p${index}:String}`;
  }
}

// ── Lakehouse inline helpers ──

/** Inline a cursor value into SQL for dialects that don't support bind parameters. */
function inlineCursorValue(value: string): string {
  return `'${escapeSqlString(value)}'`;
}

/** Check if dialect requires inlined values (no bind parameter support). */
function requiresInlinedParams(dialect: Dialect): boolean {
  return dialect === 'iceberg' || dialect === 'delta';
}

// ── WHERE clause ──

/**
 * Build a parameterized WHERE clause for incremental extraction.
 *
 * For lakehouse dialects (iceberg, delta) that don't support bind parameters,
 * pass `cursorValue` to inline the value directly into the SQL string.
 */
export function buildWhereClause(
  dialect: Dialect,
  cursorField: string,
  paramIndex: number,
  cursorValue?: string
): string {
  const quoted = quoteIdentifier(dialect, cursorField);
  if (cursorValue !== undefined && requiresInlinedParams(dialect)) {
    const inlined = inlineCursorValue(cursorValue);
    return `WHERE ${quoted} > ${inlined} ORDER BY ${quoted}`;
  }
  const param = buildParamPlaceholder(dialect, paramIndex);
  return `WHERE ${quoted} > ${param} ORDER BY ${quoted}`;
}

// ── Query builders per method ──

function buildFullRefreshQuery(config: QueryBuilderConfig): BuildResult {
  if (config.sql) {
    return { sql: config.sql, params: [] };
  }
  const fqn = buildFullyQualifiedTable(config.dialect, config);
  return { sql: `SELECT * FROM ${fqn}`, params: [] };
}

function buildIncrementalQuery(config: QueryBuilderConfig): BuildResult {
  if (!config.cursorField) {
    // No cursor field — fall back to full refresh behavior
    return buildFullRefreshQuery(config);
  }

  if (config.sql) {
    // Custom SQL with cursor: wrap as subquery
    const param = buildParamPlaceholder(config.dialect, 1);
    const quoted = quoteIdentifier(config.dialect, config.cursorField);

    if (config.cursorValue) {
      if (requiresInlinedParams(config.dialect)) {
        const inlined = inlineCursorValue(config.cursorValue);
        return {
          sql: `SELECT * FROM (${config.sql}) AS _src WHERE ${quoted} > ${inlined} ORDER BY ${quoted}`,
          params: [],
        };
      }
      return {
        sql: `SELECT * FROM (${config.sql}) AS _src WHERE ${quoted} > ${param} ORDER BY ${quoted}`,
        params: [config.cursorValue],
      };
    }
    // No cursor value yet (first run) — extract everything, ordered by cursor
    return {
      sql: `SELECT * FROM (${config.sql}) AS _src ORDER BY ${quoted}`,
      params: [],
    };
  }

  const fqn = buildFullyQualifiedTable(config.dialect, config);

  if (config.cursorValue) {
    if (requiresInlinedParams(config.dialect)) {
      const quoted = quoteIdentifier(config.dialect, config.cursorField);
      const inlined = inlineCursorValue(config.cursorValue);
      return {
        sql: `SELECT * FROM ${fqn} WHERE ${quoted} > ${inlined} ORDER BY ${quoted}`,
        params: [],
      };
    }
    const where = buildWhereClause(config.dialect, config.cursorField, 1);
    return {
      sql: `SELECT * FROM ${fqn} ${where}`,
      params: [config.cursorValue],
    };
  }

  // First run — no cursor value, extract everything ordered by cursor
  const quoted = quoteIdentifier(config.dialect, config.cursorField);
  return {
    sql: `SELECT * FROM ${fqn} ORDER BY ${quoted}`,
    params: [],
  };
}

function buildSnowflakeChangeTrackingQuery(config: QueryBuilderConfig): BuildResult {
  const fqn = buildFullyQualifiedTable('snowflake', config);
  const information = config.changeTracking?.information ?? 'default';
  const informationValue = information === 'append_only' ? 'APPEND_ONLY' : 'DEFAULT';

  if (!config.lastSyncTimestamp) {
    throw new Error('lastSyncTimestamp is required for Snowflake change tracking');
  }

  const param = buildParamPlaceholder('snowflake', 1);

  return {
    sql:
      `SELECT *, METADATA$ACTION, METADATA$ISUPDATE, METADATA$ROW_ID` +
      ` FROM ${fqn}` +
      ` CHANGES(INFORMATION => ${informationValue})` +
      ` AT(TIMESTAMP => ${param}::TIMESTAMP_LTZ)`,
    params: [config.lastSyncTimestamp],
  };
}

function buildBigQueryChangeTrackingQuery(config: QueryBuilderConfig): BuildResult {
  const cdcType = config.changeTracking?.type;
  if (!cdcType) {
    throw new Error(
      'changeTracking.type (appends | changes) is required for BigQuery change tracking'
    );
  }

  if (!config.lastSyncTimestamp) {
    throw new Error('lastSyncTimestamp is required for BigQuery change tracking');
  }

  const fqn = buildFullyQualifiedTable('bigquery', config);
  const tvf = cdcType === 'appends' ? 'APPENDS' : 'CHANGES';
  const param = buildParamPlaceholder('bigquery', 1);

  return {
    sql: `SELECT * FROM ${tvf}(TABLE ${fqn}, ${param}, CURRENT_TIMESTAMP())`,
    params: [config.lastSyncTimestamp],
  };
}

function buildDeltaCdfQuery(config: QueryBuilderConfig): BuildResult {
  if (!config.tvf) {
    throw new Error('tvf is required for Delta CDF change tracking');
  }

  // Delta CDF: read from the TVF (which includes CDF params) or _change_data/ directory
  // The tvf is pre-built by the Delta client with CDF parameters
  return {
    sql: `SELECT * FROM ${config.tvf}`,
    params: [],
  };
}

function buildPostgresChangeTrackingQuery(config: QueryBuilderConfig): BuildResult {
  const slotName = config.changeTracking?.slot_name;
  const publicationName = config.changeTracking?.publication_name;

  if (!slotName || !publicationName) {
    throw new Error(
      'changeTracking.slot_name and changeTracking.publication_name are required for PostgreSQL change tracking'
    );
  }

  return {
    sql:
      'SELECT lsn::text AS lsn, xid::text AS xid, data ' +
      'FROM pg_logical_slot_peek_binary_changes($1, NULL, NULL, ' +
      "'proto_version', '1', 'publication_names', $2)",
    params: [slotName, publicationName],
  };
}

function buildChangeTrackingQuery(config: QueryBuilderConfig): BuildResult {
  switch (config.dialect) {
    case 'snowflake':
      return buildSnowflakeChangeTrackingQuery(config);
    case 'bigquery':
      return buildBigQueryChangeTrackingQuery(config);
    case 'postgres':
      return buildPostgresChangeTrackingQuery(config);
    case 'delta':
      return buildDeltaCdfQuery(config);
    case 'redshift':
    case 'mysql':
    case 'clickhouse':
    case 'iceberg':
      throw new Error(
        `change_tracking is not supported for ${config.dialect}. Use incremental_append or incremental_merge instead.`
      );
  }
}

// ── Public API ──

/**
 * Build a parameterized extraction query for the given configuration.
 *
 * Returns the SQL string and an array of parameter values.
 */
export function buildExtractionQuery(config: QueryBuilderConfig): BuildResult {
  switch (config.method) {
    case 'full_refresh':
      return buildFullRefreshQuery(config);
    case 'incremental_append':
    case 'incremental_merge':
      return buildIncrementalQuery(config);
    case 'change_tracking':
      return buildChangeTrackingQuery(config);
  }
}
