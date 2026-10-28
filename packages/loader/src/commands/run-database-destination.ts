import { CommandError } from '@bobsled-inc/protocol';
import { validateQueryTag, type BigQueryTokenProvider } from '@bobsled-inc/connections';
import {
  type LoaderConfig,
  type BigQueryDestConfig,
  type DuckDbDestConfig,
  type DuckLakeDestConfig,
  type SnowflakeDestConfig,
  type PostgresDestConfig,
  type MySqlDestConfig,
  type DatabricksDestConfig,
  type SqliteDestConfig,
  type MsSqlDestConfig,
  type ClickHouseDestConfig,
  type TurbopufferDestConfig,
  type ElasticsearchDestConfig,
  type ChromaDestConfig,
  type PgVectorDestConfig,
} from '../schemas/config.js';
import type { DatabaseDestination } from '../runtime/destinations/database.js';
import type { LoaderLogger } from '../runtime/logger.js';

export type DatabaseDestConfig =
  | DuckDbDestConfig
  | DuckLakeDestConfig
  | BigQueryDestConfig
  | SnowflakeDestConfig
  | PostgresDestConfig
  | MySqlDestConfig
  | DatabricksDestConfig
  | SqliteDestConfig
  | MsSqlDestConfig
  | ClickHouseDestConfig
  | TurbopufferDestConfig
  | ElasticsearchDestConfig
  | ChromaDestConfig
  | PgVectorDestConfig;

export interface CreateDatabaseDestinationOptions {
  tempDir?: string;
  logger?: LoaderLogger;
  /** Shared managed-credential provider for model/cross-warehouse callers. */
  tokenProvider?: BigQueryTokenProvider;
  /** Trusted per-run Snowflake query metadata; never sourced from loader configuration. */
  queryTag?: string;
  /** Trusted physical warehouse override for a materialized Snowflake destination. */
  destinationWarehouse?: string;
}

function validateSnowflakeWorkloadIdentityConflicts(
  config: SnowflakeDestConfig,
  hasTokenProvider: boolean
): void {
  if (config.workloadIdentityToken === undefined) {
    return;
  }

  const conflicts: string[] = [];
  if (config.password !== undefined) conflicts.push('password');
  if (config.privateKeyPath !== undefined) conflicts.push('private key fields');
  if (config.privateKeyPassphrase !== undefined && config.privateKeyPath === undefined) {
    conflicts.push('private key fields');
  }
  if (config.accessToken !== undefined) conflicts.push('access token');
  if (config.tokenCommand !== undefined) conflicts.push('token command');
  if (hasTokenProvider) conflicts.push('token provider');
  if (config.authenticator !== undefined) conflicts.push('authenticator');
  if (
    config.oauthClientId !== undefined ||
    config.oauthClientSecret !== undefined ||
    config.oauthTokenUrl !== undefined
  ) {
    conflicts.push('OAuth fields');
  }

  if (conflicts.length > 0) {
    throw new CommandError(
      `Snowflake workload identity token cannot be combined with ${conflicts.join(', ')}.`
    );
  }
}

export function isDatabaseDestConfig(config: LoaderConfig): config is DatabaseDestConfig {
  return (
    config.dest === 'duckdb' ||
    config.dest === 'ducklake' ||
    config.dest === 'bigquery' ||
    config.dest === 'snowflake' ||
    config.dest === 'postgres' ||
    config.dest === 'mysql' ||
    config.dest === 'databricks' ||
    config.dest === 'sqlite' ||
    config.dest === 'mssql' ||
    config.dest === 'clickhouse' ||
    config.dest === 'turbopuffer' ||
    config.dest === 'elasticsearch' ||
    config.dest === 'chroma' ||
    config.dest === 'pgvector'
  );
}

export async function createDefaultDatabaseDestination(
  config: DatabaseDestConfig,
  options?: CreateDatabaseDestinationOptions
): Promise<DatabaseDestination> {
  if (options?.destinationWarehouse !== undefined) {
    if (options.destinationWarehouse.trim().length === 0) {
      throw new CommandError('destinationWarehouse must be a non-empty string.');
    }
    if (config.dest !== 'snowflake') {
      throw new CommandError(
        'destinationWarehouse is only supported for a materialized Snowflake destination.'
      );
    }
  }
  if (config.dest === 'duckdb') {
    const { DuckDbDestination } = await import('../runtime/destinations/duckdb.js');
    return new DuckDbDestination({ dbPath: config.dbPath, memoryLimit: config.memoryLimit });
  }

  if (config.dest === 'ducklake') {
    try {
      const { DuckLakeDestination } = await import('../runtime/destinations/ducklake.js');
      return new DuckLakeDestination({
        catalogUrl: config.catalogUrl,
        dataPath: config.dataPath,
        attachAlias: config.attachAlias,
        metadataSchema: config.metadataSchema,
        memoryLimit: config.memoryLimit,
        logger: options?.logger,
      });
    } catch (error) {
      if (error instanceof Error) {
        throw new CommandError(`Invalid DuckLake destination configuration: ${error.message}`);
      }
      throw new CommandError('Invalid DuckLake destination configuration');
    }
  }

  if (config.dest === 'snowflake') {
    const queryTag = validateQueryTag(options?.queryTag);
    validateSnowflakeWorkloadIdentityConflicts(config, options?.tokenProvider !== undefined);
    const { SnowflakeDestination } = await import('../runtime/destinations/snowflake.js');
    const configTokenProvider = config.tokenCommand
      ? (await import('../runtime/bigquery-auth.js')).createTokenCommandProvider(
          config.tokenCommand
        )
      : undefined;
    return new SnowflakeDestination({
      account: config.account,
      username: config.username,
      password: config.password,
      privateKeyPath: config.privateKeyPath,
      privateKeyPassphrase: config.privateKeyPassphrase,
      accessToken: config.accessToken,
      workloadIdentityToken: config.workloadIdentityToken,
      tokenProvider: options?.tokenProvider ?? configTokenProvider,
      authenticator: config.authenticator,
      oauthClientId: config.oauthClientId,
      oauthClientSecret: config.oauthClientSecret,
      oauthTokenUrl: config.oauthTokenUrl,
      warehouse: options?.destinationWarehouse ?? config.warehouse,
      database: config.database,
      schema: config.targetSchema,
      role: config.role,
      queryTag,
      logger: options?.logger,
    });
  }

  if (config.dest === 'postgres') {
    const { PostgresDestination } = await import('../runtime/destinations/postgres.js');
    return new PostgresDestination({
      host: config.host,
      port: config.port,
      database: config.database,
      schema: config.schema,
      username: config.username,
      password: config.password,
      ssl: config.ssl,
      logger: options?.logger,
    });
  }

  if (config.dest === 'mysql') {
    const { MySqlDestination } = await import('../runtime/destinations/mysql.js');
    return new MySqlDestination({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl,
      logger: options?.logger,
    });
  }

  if (config.dest === 'databricks') {
    const { DatabricksDestination } = await import('../runtime/destinations/databricks.js');
    return new DatabricksDestination({
      serverHostname: config.serverHostname,
      httpPath: config.httpPath,
      accessToken: config.accessToken,
      oauthClientId: config.oauthClientId,
      oauthClientSecret: config.oauthClientSecret,
      catalog: config.catalog,
      schema: config.schema,
      logger: options?.logger,
    });
  }

  if (config.dest === 'sqlite') {
    const { SqliteDestination } = await import('../runtime/destinations/sqlite.js');
    return new SqliteDestination({ dbPath: config.dbPath, logger: options?.logger });
  }

  if (config.dest === 'mssql') {
    const { MsSqlDestination } = await import('../runtime/destinations/mssql.js');
    return new MsSqlDestination({
      host: config.host,
      port: config.port,
      database: config.database,
      schema: config.schema,
      username: config.username,
      password: config.password,
      encrypt: config.encrypt,
      trustServerCertificate: config.trustServerCertificate,
      logger: options?.logger,
    });
  }

  if (config.dest === 'clickhouse') {
    const { ClickHouseDestination } = await import('../runtime/destinations/clickhouse.js');
    return new ClickHouseDestination({
      host: config.host,
      port: config.port,
      database: config.database,
      username: config.username,
      password: config.password,
      ssl: config.ssl,
      vectorIndex: config.vectorIndex,
      logger: options?.logger,
    });
  }

  if (config.dest === 'turbopuffer') {
    const { TurbopufferDestination } = await import('../runtime/destinations/turbopuffer.js');
    return new TurbopufferDestination({
      apiKey: config.apiKey,
      region: config.region,
      namespacePrefix: config.namespacePrefix,
      distanceMetric: config.distanceMetric,
      fullTextColumns: config.fullTextColumns,
      vectorDimension: config.vectorDimension,
      vectorColumns: config.vectorColumns,
      logger: options?.logger,
    });
  }

  if (config.dest === 'elasticsearch') {
    const { ElasticsearchDestination } = await import('../runtime/destinations/elasticsearch.js');
    return new ElasticsearchDestination({
      host: config.host,
      port: config.port,
      index: config.index,
      apiKey: config.apiKey,
      username: config.username,
      password: config.password,
      ssl: config.ssl,
      vectorDimension: config.vectorDimension,
      vectorColumns: config.vectorColumns,
      logger: options?.logger,
    });
  }

  if (config.dest === 'chroma') {
    const { ChromaDestination } = await import('../runtime/destinations/chroma.js');
    return new ChromaDestination({
      host: config.host,
      port: config.port,
      tenant: config.tenant,
      database: config.database,
      logger: options?.logger,
    });
  }

  if (config.dest === 'pgvector') {
    const { PgVectorDestination } = await import('../runtime/destinations/pgvector.js');
    const vectorConfig =
      config.vectorColumns && config.vectorDimension
        ? { columns: config.vectorColumns, dimension: config.vectorDimension }
        : undefined;
    return new PgVectorDestination(
      {
        host: config.host,
        port: config.port,
        database: config.database,
        schema: config.schema,
        username: config.username,
        password: config.password,
        ssl: config.ssl,
        logger: options?.logger,
      },
      vectorConfig
    );
  }

  if (config.dest === 'bigquery') {
    const { BigQueryDestination } = await import('../runtime/destinations/bigquery.js');
    // `credentials_token_command` (tokenCommand) takes precedence over the
    // static `credentials_access_token` (accessToken): wrap it into a token
    // provider the destination calls per fetch for proactive/reactive refresh.
    const tokenProvider = config.tokenCommand
      ? (await import('../runtime/bigquery-auth.js')).createTokenCommandProvider(
          config.tokenCommand
        )
      : undefined;
    return new BigQueryDestination({
      projectId: config.projectId,
      datasetId: config.datasetId,
      location: config.location,
      keyFilename: config.keyFilename,
      credentials: config.credentials,
      accessToken: config.accessToken,
      tokenProvider: options?.tokenProvider ?? tokenProvider,
      stagingFormat: config.stagingFormat,
      gcsStagingBucket: config.gcsStagingBucket,
      gcsStagingPrefix: config.gcsStagingPrefix,
      tempDir: options?.tempDir,
      logger: options?.logger,
    });
  }

  const _exhaustiveCheck: never = config;
  throw new Error(`Unhandled destination type: ${(_exhaustiveCheck as { dest: string }).dest}`);
}
