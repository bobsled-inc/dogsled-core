/**
 * Shared WarehouseClient interface and factory for DW/DB extraction.
 *
 * All source types (Snowflake, BigQuery, PostgreSQL, Redshift, MySQL, ClickHouse, Iceberg, Delta) implement this
 * interface. The factory uses dynamic `import()` to avoid loading unnecessary
 * dependencies at startup.
 */

// Import Dialect from the canonical definition in warehouse-query-builder
import type { Dialect } from './warehouse-query-builder.js';
export type { Dialect };

/**
 * Discovered table from INFORMATION_SCHEMA introspection.
 */
export interface TableDiscovery {
  tableName: string;
  schema: string;
  database?: string;
  columns: ColumnDiscovery[];
}

/**
 * Discovered column metadata from INFORMATION_SCHEMA introspection.
 */
export interface ColumnDiscovery {
  name: string;
  /** Raw type string from the source system (e.g. "VARCHAR(255)", "NUMBER(38,0)") */
  sourceType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  comment?: string;
}

/**
 * Options for `execute()` calls.
 */
export interface ExecuteOptions {
  /** Maximum number of rows to return across all batches. */
  maxRows?: number;
}

/**
 * Common interface for all warehouse and database clients.
 *
 * `execute()` yields row batches (arrays of ~10K records) via AsyncGenerator
 * for bounded memory consumption — mirroring how the API extractor uses
 * async generator pagination.
 */
export interface WarehouseClient {
  readonly dialect: Dialect;

  /**
   * Execute a SQL statement and yield result rows in batches.
   *
   * @param sql - SQL statement to execute
   * @param params - Dialect-specific bind parameters
   * @param opts - Execution options (e.g. maxRows)
   * @yields Batches of row objects (each batch ~10K rows)
   */
  execute(
    sql: string,
    params?: unknown[],
    opts?: ExecuteOptions
  ): AsyncGenerator<Record<string, unknown>[]>;

  /**
   * Execute a statement without server-side cursors and return all rows.
   * Used for warehouse metadata checks and lightweight admin functions.
   */
  queryRows?(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;

  /**
   * Advance a logical replication slot to a durable LSN.
   * Only implemented by PostgreSQL-compatible clients that support logical replication.
   */
  advanceReplicationSlot?(slotName: string, lsn: string): Promise<string>;

  /**
   * Test that the client can connect and authenticate.
   */
  testConnection(): Promise<{ success: boolean; error?: string }>;

  /**
   * Introspect a database schema to discover tables and columns.
   *
   * @param database - Database (or project for BigQuery) to introspect
   * @param schema - Schema (or dataset for BigQuery) to introspect
   */
  introspect(database: string, schema: string): Promise<TableDiscovery[]>;

  /**
   * Build a table-valued function reference for lakehouse formats.
   * Only implemented by Iceberg and Delta clients.
   *
   * @param database - Database/namespace override
   * @param table - Table name
   * @returns TVF string (e.g. `iceberg_scan('s3://...')`, `delta_scan('s3://...')`)
   */
  buildTvf?(database: string | undefined, table: string): string | Promise<string>;

  /**
   * Build a CDF (Change Data Feed) TVF for Delta change tracking.
   * Only implemented by the Delta client.
   *
   * @param database - Database/namespace override
   * @param table - Table name
   * @param sinceVersion - Read changes since this version
   */
  buildCdfTvf?(database: string | undefined, table: string, sinceVersion?: number): string;

  /**
   * Release any held resources (connections, pools).
   * No-op for stateless REST clients.
   */
  close(): Promise<void>;
}

/**
 * Create a WarehouseClient for the given source type.
 *
 * Uses dynamic `import()` to lazy-load each client implementation,
 * avoiding unnecessary dependency loading at startup.
 *
 * @param sourceType - One of the supported source type identifiers
 * @param config - Parsed integration config (shape depends on sourceType)
 */
export async function createWarehouseClient(
  sourceType: string,
  config: Record<string, unknown>
): Promise<WarehouseClient> {
  switch (sourceType) {
    case 'snowflake': {
      const { SnowflakeWarehouseClient } = await import('./snowflake-client.js');
      return new SnowflakeWarehouseClient(config);
    }
    case 'bigquery': {
      const { BigQueryWarehouseClient } = await import('./bigquery-client.js');
      return new BigQueryWarehouseClient(config);
    }
    case 'postgres': {
      const { PostgresWarehouseClient } = await import('./postgres-client.js');
      return new PostgresWarehouseClient(config);
    }
    case 'redshift': {
      const { RedshiftWarehouseClient } = await import('./redshift-client.js');
      return new RedshiftWarehouseClient(config);
    }
    case 'mysql': {
      const { MysqlWarehouseClient } = await import('./mysql-client.js');
      return new MysqlWarehouseClient(config);
    }
    case 'clickhouse': {
      const { ClickHouseWarehouseClient } = await import('./clickhouse-client.js');
      return new ClickHouseWarehouseClient(config);
    }
    case 'iceberg': {
      const { IcebergWarehouseClient } = await import('./iceberg-client.js');
      return new IcebergWarehouseClient(config);
    }
    case 'delta': {
      const { DeltaWarehouseClient } = await import('./delta-client.js');
      return new DeltaWarehouseClient(config);
    }
    default:
      throw new Error(`Unsupported warehouse source type: ${sourceType}`);
  }
}
