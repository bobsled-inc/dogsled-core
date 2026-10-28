/**
 * Iceberg warehouse client using DuckDB's iceberg extension.
 *
 * Supports two connection modes:
 * - REST Catalog: discovers metadata via REST API, gets vended credentials
 * - Direct: reads Iceberg metadata files directly from S3/GCS
 */

import type {
  ColumnDiscovery,
  ExecuteOptions,
  TableDiscovery,
  WarehouseClient,
} from './warehouse-client.js';
import { DuckDbEngine, escapeSqlString, validateStorageAuth } from './duckdb-engine.js';
import type { ResolvedStorageAuth } from './duckdb-engine.js';
import { IcebergCatalogClient } from './iceberg-catalog.js';
import type { IcebergCatalogAuth } from './iceberg-catalog.js';
import { resolveAndValidateHost } from '../framework/core/ssrf.js';

// ---------------------------------------------------------------------------
// Config shape (resolved from IntegrationSpec)
// ---------------------------------------------------------------------------

interface IcebergRestCatalogConfig {
  mode: 'rest_catalog';
  catalog_url: string;
  warehouse?: string;
  default_namespace?: string;
  auth: IcebergCatalogAuth;
  storage?: ResolvedStorageAuth;
}

interface IcebergDirectConfig {
  mode: 'direct';
  warehouse_path: string;
  storage: ResolvedStorageAuth;
}

type IcebergConfig = IcebergRestCatalogConfig | IcebergDirectConfig;

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

function requireString(obj: Record<string, unknown>, key: string, label: string): string {
  const val = obj[key];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`IcebergConfig: "${label}" is required and must be a non-empty string`);
  }
  return val;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const val = obj[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'string') {
    throw new Error(`IcebergConfig: "${key}" must be a string if provided`);
  }
  return val;
}

function parseIcebergConfig(raw: Record<string, unknown>): IcebergConfig {
  const mode = requireString(raw, 'mode', 'mode');

  if (mode === 'rest_catalog') {
    const catalogUrl = requireString(raw, 'catalog_url', 'catalog_url');
    const warehouse = optionalString(raw, 'warehouse');
    const defaultNamespace = optionalString(raw, 'default_namespace');

    const authRaw = raw['auth'];
    if (!authRaw || typeof authRaw !== 'object' || Array.isArray(authRaw)) {
      throw new Error('IcebergConfig: "auth" must be an object');
    }
    const authObj = authRaw as Record<string, unknown>;
    const authType = requireString(authObj, 'type', 'auth.type');

    let auth: IcebergCatalogAuth;
    if (authType === 'oauth2') {
      auth = {
        type: 'oauth2',
        clientId: optionalString(authObj, 'clientId'),
        clientSecret: optionalString(authObj, 'clientSecret'),
        tokenUrl: optionalString(authObj, 'tokenUrl'),
        scope: optionalString(authObj, 'scope'),
      };
    } else if (authType === 'token') {
      auth = {
        type: 'token',
        token: optionalString(authObj, 'token'),
      };
    } else {
      throw new Error(
        `IcebergConfig: unsupported auth type "${authType}" (expected "oauth2" or "token")`
      );
    }

    const storage = raw['storage'];
    const validatedStorage = storage ? validateStorageAuth(storage, 'IcebergConfig') : undefined;

    return {
      mode: 'rest_catalog',
      catalog_url: catalogUrl,
      warehouse,
      default_namespace: defaultNamespace,
      auth,
      storage: validatedStorage,
    };
  }

  if (mode === 'direct') {
    const warehousePath = requireString(raw, 'warehouse_path', 'warehouse_path');
    if (!/^(s3:\/\/|gs:\/\/|https:\/\/)/i.test(warehousePath)) {
      throw new Error('IcebergConfig: "warehouse_path" must use s3://, gs://, or https:// scheme');
    }
    const storage = raw['storage'];
    if (!storage || typeof storage !== 'object' || Array.isArray(storage)) {
      throw new Error('IcebergConfig: "storage" is required for direct mode');
    }
    const validatedStorage = validateStorageAuth(storage, 'IcebergConfig');
    return {
      mode: 'direct',
      warehouse_path: warehousePath,
      storage: validatedStorage,
    };
  }

  throw new Error(
    `IcebergConfig: unsupported mode "${mode}" (expected "rest_catalog" or "direct")`
  );
}

function buildIcebergScanTvf(metadataLocation: string): string {
  return `iceberg_scan('${escapeSqlString(metadataLocation)}')`;
}

/**
 * Resolve metadata location for a table in direct mode.
 *
 * Convention: `{warehouse_path}/{database}/{table}/metadata/v*.metadata.json`
 * We use DuckDB's iceberg_scan which accepts the table root path.
 */
function resolveDirectTablePath(
  warehousePath: string,
  database: string | undefined,
  table: string
): string {
  const base = warehousePath.replace(/\/+$/, '');
  const parts = [base];
  if (database) parts.push(database);
  parts.push(table);
  return parts.join('/');
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class IcebergWarehouseClient implements WarehouseClient {
  readonly dialect = 'iceberg' as const;
  private engine: DuckDbEngine | undefined;
  private enginePromise: Promise<DuckDbEngine> | undefined;
  private catalogClientPromise: Promise<IcebergCatalogClient> | undefined;
  private readonly config: IcebergConfig;

  constructor(rawConfig: Record<string, unknown>) {
    this.config = parseIcebergConfig(rawConfig);
  }

  private finalizePromise: Promise<void> | undefined;

  private async getEngine(): Promise<DuckDbEngine> {
    if (this.engine) {
      return this.engine;
    }
    // Cache the in-flight promise so concurrent callers share one init. If
    // any step fails after the engine is created, close it before clearing
    // the cache — otherwise the native handle and any temp credential state
    // owned by DuckDbEngine.close() leak.
    if (!this.enginePromise) {
      this.enginePromise = (async () => {
        let engine: DuckDbEngine | undefined;
        try {
          engine = await DuckDbEngine.create();
          await engine.initExtensions(['iceberg', 'httpfs']);
          if (this.config.mode === 'direct') {
            await engine.configureStorage(this.config.storage);
          } else if (this.config.storage) {
            await engine.configureStorage(this.config.storage);
          }
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
   * Ensure engine is locked to read-only before executing queries.
   * Deferred until after all storage configuration (including vended credentials
   * from REST catalog) is complete. Uses a stored Promise to prevent concurrent
   * calls from double-finalizing (TOCTOU). The promise is cleared on rejection
   * so a later call can retry instead of permanently caching the failure.
   */
  private async ensureReadOnly(): Promise<void> {
    if (!this.finalizePromise) {
      this.finalizePromise = (async () => {
        const engine = await this.getEngine();
        await engine.finalizeReadOnly();
      })().catch((error) => {
        this.finalizePromise = undefined;
        throw error;
      });
    }
    return this.finalizePromise;
  }

  private async getCatalogClient(): Promise<IcebergCatalogClient> {
    if (this.config.mode !== 'rest_catalog') {
      throw new Error('Catalog client is only available in rest_catalog mode');
    }
    if (!this.catalogClientPromise) {
      this.catalogClientPromise = IcebergCatalogClient.create({
        catalogUrl: this.config.catalog_url,
        warehouse: this.config.warehouse,
        auth: this.config.auth,
      });
    }
    return this.catalogClientPromise;
  }

  /**
   * Build the TVF string for a given table, handling both connection modes.
   */
  async buildTvf(database: string | undefined, table: string): Promise<string> {
    if (this.config.mode === 'rest_catalog') {
      const catalog = await this.getCatalogClient();
      const namespace = database
        ? database.split('.')
        : this.config.default_namespace
          ? this.config.default_namespace.split('.')
          : [];

      const response = await catalog.loadTable(namespace, table);

      // Validate metadata location scheme to prevent local filesystem access
      // from a malicious or compromised catalog server
      const loc = response.metadataLocation;
      if (!/^(s3:\/\/|gs:\/\/|https:\/\/)/i.test(loc)) {
        throw new Error(
          `Iceberg catalog returned disallowed metadataLocation scheme: "${loc.slice(0, 50)}..."`
        );
      }
      // SSRF: for HTTPS metadata locations, validate hostname is not private
      if (/^https:\/\//i.test(loc)) {
        const metadataHostname = new URL(loc).hostname;
        await resolveAndValidateHost(metadataHostname, 'Iceberg metadataLocation');
      }

      // If catalog vends credentials, configure DuckDB with them
      if (response.config && Object.keys(response.config).length > 0) {
        const engine = await this.getEngine();
        await engine.configureStorage({
          type: 'vended',
          credentials: response.config,
        });
      }

      return buildIcebergScanTvf(response.metadataLocation);
    }

    // Direct mode
    const tablePath = resolveDirectTablePath(this.config.warehouse_path, database, table);
    return buildIcebergScanTvf(tablePath);
  }

  async *execute(
    sql: string,
    params?: unknown[],
    opts?: ExecuteOptions
  ): AsyncGenerator<Record<string, unknown>[]> {
    // DuckDB doesn't support parameterized queries via the callback API.
    // Params are handled by the query builder (TVF is pre-built).
    // Throw if params are passed to catch query builder bugs early.
    if (params && params.length > 0) {
      throw new Error('DuckDB lakehouse queries do not support bind parameters');
    }

    // Lock down to read-only before first query (after all storage config)
    await this.ensureReadOnly();
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
      await this.ensureReadOnly();
      const engine = await this.getEngine();
      await engine.queryAll('SELECT 1 AS test');

      // For REST catalog mode, also test catalog connectivity
      if (this.config.mode === 'rest_catalog') {
        const catalog = await this.getCatalogClient();
        await catalog.getConfig();
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async introspect(database: string, schema: string): Promise<TableDiscovery[]> {
    if (this.config.mode === 'rest_catalog') {
      const catalog = await this.getCatalogClient();
      const namespace = schema ? [database, schema].filter(Boolean) : [database];
      const tables = await catalog.listTables(namespace);

      const results: TableDiscovery[] = [];
      for (const tableId of tables) {
        const response = await catalog.loadTable(tableId.namespace, tableId.name);
        const currentSchemaId = response.metadata['current-schema-id'] ?? 0;
        const icebergSchema = response.metadata.schemas?.find(
          (s) => s['schema-id'] === currentSchemaId
        );

        const columns: ColumnDiscovery[] = (icebergSchema?.fields ?? []).map((field) => ({
          name: field.name,
          sourceType: typeof field.type === 'string' ? field.type : JSON.stringify(field.type),
          nullable: !field.required,
          isPrimaryKey: false,
        }));

        results.push({
          tableName: tableId.name,
          schema: tableId.namespace.join('.'),
          columns,
        });
      }

      return results;
    }

    // Direct mode: use DuckDB DESCRIBE on a single table path.
    // For direct Iceberg access, `database` is the namespace prefix and
    // `schema` is the table directory name (no catalog to enumerate).
    await this.ensureReadOnly();
    const engine = await this.getEngine();
    const table = schema;
    const tablePath = resolveDirectTablePath(this.config.warehouse_path, database, table);
    const tvf = buildIcebergScanTvf(tablePath);
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
    // Clear cached init / finalize promises so a reopened client gets a fresh
    // engine and re-finalizes on its first query. If close() races an in-flight
    // init, drop the promise and close the resolved engine if it ever arrives.
    const pending = this.enginePromise;
    this.enginePromise = undefined;
    this.finalizePromise = undefined;

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
