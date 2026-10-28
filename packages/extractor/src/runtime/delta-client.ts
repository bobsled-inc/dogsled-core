/**
 * Delta Lake warehouse client using DuckDB's delta extension.
 *
 * Supports cursor-based incremental extraction via delta_scan() and
 * Change Data Feed (CDF) via two approaches:
 * 1. DuckDB delta_scan with CDF parameters (preferred)
 * 2. Direct read_parquet() of _change_data/ files (fallback)
 */

import type { ExecuteOptions, TableDiscovery, WarehouseClient } from './warehouse-client.js';
import { DuckDbEngine, escapeSqlString, validateStorageAuth } from './duckdb-engine.js';
import type { ResolvedStorageAuth } from './duckdb-engine.js';

// ---------------------------------------------------------------------------
// Config shape (resolved from IntegrationSpec)
// ---------------------------------------------------------------------------

interface DeltaConfig {
  storage_url: string;
  default_schema?: string;
  storage: ResolvedStorageAuth;
}

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

function parseDeltaConfig(raw: Record<string, unknown>): DeltaConfig {
  const storageUrl = raw['storage_url'];
  if (typeof storageUrl !== 'string' || storageUrl.length === 0) {
    throw new Error('DeltaConfig: "storage_url" is required and must be a non-empty string');
  }
  if (!/^(s3:\/\/|gs:\/\/|https:\/\/)/i.test(storageUrl)) {
    throw new Error('DeltaConfig: "storage_url" must use s3://, gs://, or https:// scheme');
  }

  const defaultSchema = raw['default_schema'];
  if (defaultSchema !== undefined && defaultSchema !== null && typeof defaultSchema !== 'string') {
    throw new Error('DeltaConfig: "default_schema" must be a string if provided');
  }

  const validatedStorage = validateStorageAuth(raw['storage'], 'DeltaConfig');

  return {
    storage_url: storageUrl,
    default_schema: typeof defaultSchema === 'string' ? defaultSchema : undefined,
    storage: validatedStorage,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the full S3/GCS path to a Delta table.
 */
function resolveTablePath(storageUrl: string, database: string | undefined, table: string): string {
  const base = storageUrl.replace(/\/+$/, '');
  const parts = [base];
  if (database) parts.push(database);
  parts.push(table);
  return parts.join('/');
}

/**
 * Build a delta_scan() TVF for a given table path.
 */
export function buildDeltaScanTvf(tablePath: string): string {
  return `delta_scan('${escapeSqlString(tablePath)}')`;
}

/**
 * Build a CDF TVF using read_parquet on the _change_data/ directory.
 *
 * This is the fallback approach when DuckDB's delta extension doesn't
 * support native CDF parameters.
 */
export function buildCdfParquetTvf(tablePath: string, sinceVersion?: number): string {
  const cdfPath = `${tablePath}/_change_data/*.parquet`;
  if (sinceVersion !== undefined) {
    if (!Number.isSafeInteger(sinceVersion)) {
      throw new Error(
        `buildCdfParquetTvf: sinceVersion must be a safe integer, got ${sinceVersion}`
      );
    }
    return `read_parquet('${escapeSqlString(cdfPath)}') WHERE _commit_version > ${sinceVersion}`;
  }
  return `read_parquet('${escapeSqlString(cdfPath)}')`;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class DeltaWarehouseClient implements WarehouseClient {
  readonly dialect = 'delta' as const;
  private engine: DuckDbEngine | undefined;
  private enginePromise: Promise<DuckDbEngine> | undefined;
  private readonly config: DeltaConfig;

  constructor(rawConfig: Record<string, unknown>) {
    this.config = parseDeltaConfig(rawConfig);
  }

  private async getEngine(): Promise<DuckDbEngine> {
    if (this.engine) {
      return this.engine;
    }
    // Cache the in-flight promise so concurrent callers share one init. If any
    // step fails after the engine is created, close it to release the native
    // handle and temp credential state before clearing the cache.
    if (!this.enginePromise) {
      this.enginePromise = (async () => {
        let engine: DuckDbEngine | undefined;
        try {
          engine = await DuckDbEngine.create();
          await engine.initExtensions(['delta', 'httpfs']);
          await engine.configureStorage(this.config.storage);
          // Lock down after all extensions loaded and storage configured
          await engine.finalizeReadOnly();
          this.engine = engine;
          return engine;
        } catch (error) {
          this.enginePromise = undefined;
          if (engine) {
            try {
              await engine.close();
            } catch {
              // best-effort; preserve the original init error
            }
          }
          throw error;
        }
      })();
    }
    return this.enginePromise;
  }

  /**
   * Build the delta_scan() TVF for a given table.
   */
  buildTvf(database: string | undefined, table: string): string {
    const tablePath = resolveTablePath(
      this.config.storage_url,
      database ?? this.config.default_schema,
      table
    );
    return buildDeltaScanTvf(tablePath);
  }

  /**
   * Build the CDF TVF for change tracking.
   */
  buildCdfTvf(database: string | undefined, table: string, sinceVersion?: number): string {
    const tablePath = resolveTablePath(
      this.config.storage_url,
      database ?? this.config.default_schema,
      table
    );
    return buildCdfParquetTvf(tablePath, sinceVersion);
  }

  async *execute(
    sql: string,
    params?: unknown[],
    opts?: ExecuteOptions
  ): AsyncGenerator<Record<string, unknown>[]> {
    // DuckDB doesn't support parameterized queries via the callback API.
    // Throw if params are passed to catch query builder bugs early.
    if (params && params.length > 0) {
      throw new Error('DuckDB lakehouse queries do not support bind parameters');
    }

    const engine = await this.getEngine();

    const maxRows = opts?.maxRows;
    let emitted = 0;

    for await (const batch of engine.query(sql)) {
      if (maxRows !== undefined) {
        const remaining = maxRows - emitted;
        if (remaining <= 0) break;
        if (batch.length > remaining) {
          yield batch.slice(0, remaining);
          break;
        }
      }
      yield batch;
      emitted += batch.length;
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const engine = await this.getEngine();
      await engine.queryAll('SELECT 1 AS test');
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Introspect a single Delta table by describing its schema via DuckDB.
   *
   * For Delta Lake, the WarehouseClient `introspect(database, schema)` interface
   * maps to path-based table resolution: `database` is the namespace/path prefix
   * and `schema` is the table directory name. This discovers a single table
   * rather than enumerating tables in a namespace (Delta has no catalog).
   */
  async introspect(database: string, table: string): Promise<TableDiscovery[]> {
    const engine = await this.getEngine();
    const tablePath = resolveTablePath(this.config.storage_url, database, table);
    const tvf = buildDeltaScanTvf(tablePath);
    const columnInfos = await engine.describe(tvf);

    return [
      {
        tableName: table,
        schema: database,
        columns: columnInfos.map((col) => ({
          name: col.name,
          sourceType: col.type,
          nullable: col.nullable,
          isPrimaryKey: false,
        })),
      },
    ];
  }

  async close(): Promise<void> {
    // Clear the cached init promise first so a reopened client gets a fresh
    // engine instead of reusing the closed one. Also handles the case where
    // close() races an in-flight init: the promise is dropped and, if it
    // later resolves to an engine, that engine is closed too.
    const pending = this.enginePromise;
    this.enginePromise = undefined;

    if (this.engine) {
      const engine = this.engine;
      this.engine = undefined;
      await engine.close();
      return;
    }
    if (pending) {
      const engine = await pending.catch(() => undefined);
      if (engine) {
        await engine.close();
      }
    }
  }
}
