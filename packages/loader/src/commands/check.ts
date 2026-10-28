import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { assertDriverVersion } from '@bobsled-inc/connections';

import chalk from 'chalk';

import { allRows, closeDuckDbResources, openDuckDb } from '../runtime/duckdb-primitives.js';
import { resolveOptionPlaceholders } from './run-cli.js';

import type { Command } from 'commander';
import type { DuckDbConnectionLike, DuckDbDatabaseLike } from '../runtime/duckdb-primitives.js';

export interface CheckDependencies {
  stderr?: NodeJS.WritableStream;
  databaseFactory?: (dbPath: string) => Promise<DuckDbDatabaseLike>;
  setExitCode?: (code: number) => void;
}

async function checkDuckDb(dbPath: string, dependencies: CheckDependencies = {}): Promise<void> {
  const stderr = dependencies.stderr ?? process.stderr;
  const factory = dependencies.databaseFactory ?? openDuckDb;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  let db: DuckDbDatabaseLike | null = null;
  let conn: DuckDbConnectionLike | null = null;

  try {
    db = await factory(dbPath);
    conn = await db.connect();
    await allRows(conn, 'SELECT 1');
    stderr.write(chalk.green(`✓ DuckDB: database writable at ${dbPath}`) + '\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(chalk.red(`✗ DuckDB: ${message}`) + '\n');
    setExitCode(1);
  } finally {
    try {
      await closeDuckDbResources(conn, db);
    } catch {
      // best-effort cleanup
    }
  }
}

export interface CheckDuckLakeDependencies {
  stderr?: NodeJS.WritableStream;
  setExitCode?: (code: number) => void;
  checkFactory?: (options: {
    catalogUrl: string;
    dataPath?: string;
    attachAlias?: string;
  }) => Promise<void>;
}

async function checkDuckLake(
  options: { catalogUrl: string; dataPath?: string; attachAlias?: string },
  dependencies: CheckDuckLakeDependencies = {}
): Promise<void> {
  const stderr = dependencies.stderr ?? process.stderr;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });
  const check =
    dependencies.checkFactory ??
    (async (duckLakeOptions: { catalogUrl: string; dataPath?: string; attachAlias?: string }) => {
      const { DuckLakeDestination } = await import('../runtime/destinations/ducklake.js');
      const dest = new DuckLakeDestination({
        catalogUrl: duckLakeOptions.catalogUrl,
        dataPath: duckLakeOptions.dataPath,
        attachAlias: duckLakeOptions.attachAlias,
      });
      try {
        await dest.initialize();
      } finally {
        await dest.close().catch(() => {});
      }
    });

  try {
    await check(options);
    stderr.write(
      chalk.green(
        `✓ DuckLake: catalog "${options.catalogUrl}" is accessible via alias "${options.attachAlias ?? 'lake'}"`
      ) + '\n'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(chalk.red(`✗ DuckLake: ${message}`) + '\n');
    setExitCode(1);
  }
}

async function checkBigQuery(
  options: { projectId?: string; datasetId: string; location?: string; keyFilename?: string },
  dependencies: CheckDependencies = {}
): Promise<void> {
  const stderr = dependencies.stderr ?? process.stderr;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  try {
    assertDriverVersion('@google-cloud/bigquery', '8.1.1', createRequire(import.meta.url));
    const module = await import('@google-cloud/bigquery');
    const client = new module.BigQuery({
      projectId: options.projectId,
      location: options.location,
      keyFilename: options.keyFilename,
    });

    const dataset = client.dataset(options.datasetId);
    const [exists] = await dataset.exists();
    if (exists) {
      stderr.write(chalk.green(`✓ BigQuery: dataset "${options.datasetId}" is accessible`) + '\n');
    } else {
      stderr.write(
        chalk.yellow(
          `! BigQuery: dataset "${options.datasetId}" does not exist; it will be created on first load if the credentials have permission`
        ) + '\n'
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(chalk.red(`✗ BigQuery: ${message}`) + '\n');
    setExitCode(1);
  }
}

async function checkGcs(bucket: string, dependencies: CheckDependencies = {}): Promise<void> {
  const stderr = dependencies.stderr ?? process.stderr;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  try {
    const module = await import('@google-cloud/storage');
    const storage = new module.Storage();
    const [exists] = await storage.bucket(bucket).exists();
    if (!exists) {
      stderr.write(chalk.red(`✗ GCS: bucket "${bucket}" does not exist`) + '\n');
      setExitCode(1);
      return;
    }

    stderr.write(chalk.green(`✓ GCS: bucket "${bucket}" is accessible`) + '\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(chalk.red(`✗ GCS: ${message}`) + '\n');
    setExitCode(1);
  }
}

async function checkLocal(outputDir: string, dependencies: CheckDependencies = {}): Promise<void> {
  const stderr = dependencies.stderr ?? process.stderr;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  try {
    const stat = await fs.stat(outputDir);
    if (!stat.isDirectory()) {
      stderr.write(chalk.red(`✗ Local: "${outputDir}" is not a directory`) + '\n');
      setExitCode(1);
      return;
    }

    await fs.access(outputDir, fs.constants.W_OK);
    stderr.write(chalk.green(`✓ Local: output directory ${outputDir} is writable`) + '\n');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      stderr.write(chalk.red(`✗ Local: output directory ${outputDir} does not exist`) + '\n');
    } else if (error instanceof Error && 'code' in error && error.code === 'EACCES') {
      stderr.write(chalk.red(`✗ Local: output directory ${outputDir} is not writable`) + '\n');
    } else {
      const message = error instanceof Error ? error.message : String(error);
      stderr.write(chalk.red(`✗ Local: ${message}`) + '\n');
    }
    setExitCode(1);
  }
}

async function checkSnowflake(
  options: {
    account: string;
    username: string;
    password?: string;
    privateKeyPath?: string;
    warehouse: string;
    database: string;
    schema?: string;
    role?: string;
  },
  dependencies: CheckDependencies = {}
): Promise<void> {
  const stderr = dependencies.stderr ?? process.stderr;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  try {
    const { SnowflakeDestination } = await import('../runtime/destinations/snowflake.js');
    const dest = new SnowflakeDestination({
      account: options.account,
      username: options.username,
      password: options.password,
      privateKeyPath: options.privateKeyPath,
      warehouse: options.warehouse,
      database: options.database,
      schema: options.schema ?? 'PUBLIC',
      role: options.role,
    });
    await dest.initialize();
    await dest.close();
    stderr.write(
      chalk.green(
        `✓ Snowflake: connected to ${options.account} (warehouse: ${options.warehouse})`
      ) + '\n'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(chalk.red(`✗ Snowflake: ${message}`) + '\n');
    setExitCode(1);
  }
}

async function checkPostgres(
  options: {
    host: string;
    port?: number;
    database: string;
    schema?: string;
    username: string;
    password: string;
    ssl?: boolean;
  },
  dependencies: CheckDependencies = {}
): Promise<void> {
  const stderr = dependencies.stderr ?? process.stderr;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  try {
    const { PostgresDestination } = await import('../runtime/destinations/postgres.js');
    const dest = new PostgresDestination({
      host: options.host,
      port: options.port,
      database: options.database,
      schema: options.schema ?? 'public',
      username: options.username,
      password: options.password,
      ssl: options.ssl,
    });
    await dest.initialize();
    await dest.close();
    stderr.write(
      chalk.green(
        `✓ Postgres: connected to ${options.host}:${options.port ?? 5432}/${options.database}`
      ) + '\n'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(chalk.red(`✗ Postgres: ${message}`) + '\n');
    setExitCode(1);
  }
}

async function checkMySql(
  options: {
    host: string;
    port?: number;
    database: string;
    user: string;
    password?: string;
    ssl?: boolean;
  },
  dependencies: CheckDependencies = {}
): Promise<void> {
  const stderr = dependencies.stderr ?? process.stderr;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  let pool: unknown = null;

  try {
    assertDriverVersion('mysql2', '3.22.0', createRequire(import.meta.url), 'mysql2/promise');
    const mysql = await import('mysql2/promise');
    pool = mysql.createPool({
      host: options.host,
      port: options.port ?? 3306,
      database: options.database,
      user: options.user,
      password: options.password ?? '',
      ssl: options.ssl ? { rejectUnauthorized: true } : undefined,
    });

    const connection = await (pool as { getConnection(): Promise<unknown> }).getConnection();
    await (connection as { execute(query: string): Promise<unknown> }).execute('SELECT 1');
    (connection as { release(): void }).release();
    stderr.write(
      chalk.green(
        `✓ MySQL: database "${options.database}" is accessible at ${options.host}:${options.port ?? 3306}`
      ) + '\n'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(chalk.red(`✗ MySQL: ${message}`) + '\n');
    setExitCode(1);
  } finally {
    if (pool) {
      try {
        await (pool as { end(): Promise<void> }).end();
      } catch {
        // Best-effort cleanup
      }
    }
  }
}

export interface CheckDatabricksDependencies extends CheckDependencies {
  clientFactory?: (
    serverHostname: string,
    httpPath: string,
    accessToken: string
  ) => Promise<{
    connect(options: { host: string; path: string; token: string }): Promise<{
      openSession(): Promise<{
        executeStatement(statement: string): Promise<{
          fetchAll(): Promise<Record<string, unknown>[]>;
          close(): Promise<void>;
        }>;
        close(): Promise<void>;
      }>;
      close(): Promise<void>;
    }>;
  }>;
}

async function checkDatabricks(
  options: {
    serverHostname: string;
    httpPath: string;
    accessToken: string;
    catalog: string;
    schema: string;
  },
  dependencies: CheckDatabricksDependencies = {}
): Promise<void> {
  const stderr = dependencies.stderr ?? process.stderr;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  const factory =
    dependencies.clientFactory ??
    (async (_serverHostname: string, _httpPath: string, _accessToken: string) => {
      assertDriverVersion('@databricks/sql', '2.0.0', createRequire(import.meta.url));
      const { DBSQLClient } = await import('@databricks/sql');
      return new DBSQLClient() as unknown as {
        connect(opts: { host: string; path: string; token: string }): Promise<{
          openSession(): Promise<{
            executeStatement(statement: string): Promise<{
              fetchAll(): Promise<Record<string, unknown>[]>;
              close(): Promise<void>;
            }>;
            close(): Promise<void>;
          }>;
          close(): Promise<void>;
        }>;
      };
    });

  let session: {
    executeStatement(statement: string): Promise<{
      fetchAll(): Promise<Record<string, unknown>[]>;
      close(): Promise<void>;
    }>;
    close(): Promise<void>;
  } | null = null;

  let connection: {
    openSession(): Promise<{
      executeStatement(statement: string): Promise<{
        fetchAll(): Promise<Record<string, unknown>[]>;
        close(): Promise<void>;
      }>;
      close(): Promise<void>;
    }>;
    close(): Promise<void>;
  } | null = null;

  try {
    const client = await factory(options.serverHostname, options.httpPath, options.accessToken);
    connection = await client.connect({
      host: options.serverHostname,
      path: options.httpPath,
      token: options.accessToken,
    });
    session = await connection.openSession();

    const result = await session.executeStatement('SELECT 1');
    await result.fetchAll();
    await result.close();

    if (options.catalog.includes('`')) {
      throw new Error('Invalid Databricks catalog name: backticks are not allowed');
    }
    if (options.schema.includes('`')) {
      throw new Error('Invalid Databricks schema name: backticks are not allowed');
    }

    const catalogResult = await session.executeStatement(`USE CATALOG \`${options.catalog}\``);
    await catalogResult.fetchAll();
    await catalogResult.close();

    const schemaResult = await session.executeStatement(`USE SCHEMA \`${options.schema}\``);
    await schemaResult.fetchAll();
    await schemaResult.close();

    stderr.write(
      chalk.green(
        `✓ Databricks: catalog "${options.catalog}" schema "${options.schema}" is accessible`
      ) + '\n'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(chalk.red(`✗ Databricks: ${message}`) + '\n');
    setExitCode(1);
  } finally {
    if (session) {
      try {
        await session.close();
      } catch {
        // Best-effort cleanup
      }
    }
    if (connection) {
      try {
        await connection.close();
      } catch {
        // Best-effort cleanup
      }
    }
  }
}

export interface CheckSqliteDependencies {
  stderr?: NodeJS.WritableStream;
  setExitCode?: (code: number) => void;
  checkFactory?: (dbPath: string) => Promise<void>;
}

async function checkSqlite(
  dbPath: string,
  dependencies: CheckSqliteDependencies = {}
): Promise<void> {
  const stderr = dependencies.stderr ?? process.stderr;
  const check =
    dependencies.checkFactory ??
    (async (p: string) => {
      const { SqliteDestination } = await import('../runtime/destinations/sqlite.js');
      const dest = new SqliteDestination({ dbPath: p });
      await dest.initialize();
      await dest.close();
    });
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  try {
    await check(dbPath);
    stderr.write(chalk.green(`✓ SQLite: database writable at ${dbPath}`) + '\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(chalk.red(`✗ SQLite: ${message}`) + '\n');
    setExitCode(1);
  }
}

async function checkMsSql(
  options: {
    host: string;
    port?: number;
    database: string;
    username?: string;
    password?: string;
    encrypt?: boolean;
    trustServerCertificate?: boolean;
    schema?: string;
  },
  dependencies: CheckDependencies = {}
): Promise<void> {
  const stderr = dependencies.stderr ?? process.stderr;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  try {
    const { MsSqlDestination } = await import('../runtime/destinations/mssql.js');
    const dest = new MsSqlDestination({
      host: options.host,
      port: options.port,
      database: options.database,
      username: options.username,
      password: options.password,
      encrypt: options.encrypt,
      trustServerCertificate: options.trustServerCertificate,
      schema: options.schema,
    });
    await dest.initialize();
    await dest.close();
    stderr.write(
      chalk.green(
        `✓ MSSQL: database "${options.database}" is accessible at ${options.host}:${options.port ?? 1433}`
      ) + '\n'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(chalk.red(`✗ MSSQL: ${message}`) + '\n');
    setExitCode(1);
  }
}

async function checkClickHouse(
  options: {
    host: string;
    port?: number;
    database: string;
    username?: string;
    password?: string;
    ssl?: boolean;
  },
  dependencies: CheckDependencies = {}
): Promise<void> {
  const stderr = dependencies.stderr ?? process.stderr;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  try {
    const { ClickHouseDestination } = await import('../runtime/destinations/clickhouse.js');
    const dest = new ClickHouseDestination({
      host: options.host,
      port: options.port,
      database: options.database,
      username: options.username,
      password: options.password,
      ssl: options.ssl,
    });
    await dest.initialize();
    await dest.close();
    stderr.write(
      chalk.green(
        `✓ ClickHouse: connected to ${options.ssl ? 'https' : 'http'}://${options.host}:${options.port ?? 8123}`
      ) + '\n'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(chalk.red(`✗ ClickHouse: ${message}`) + '\n');
    setExitCode(1);
  }
}

async function checkTurbopuffer(
  options: { apiKey: string; region?: string },
  dependencies: CheckDependencies = {}
): Promise<void> {
  const stderr = dependencies.stderr ?? process.stderr;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  try {
    const { TurbopufferDestination } = await import('../runtime/destinations/turbopuffer.js');
    const dest = new TurbopufferDestination({ apiKey: options.apiKey, region: options.region });
    await dest.initialize();
    await dest.close();
    stderr.write(
      chalk.green(`✓ Turbopuffer: authenticated in region ${options.region ?? 'gcp-us-central1'}`) +
        '\n'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(chalk.red(`✗ Turbopuffer: ${message}`) + '\n');
    setExitCode(1);
  }
}

async function checkElasticsearch(
  options: {
    host: string;
    port?: number;
    apiKey?: string;
    username?: string;
    password?: string;
  },
  dependencies: CheckDependencies = {}
): Promise<void> {
  const stderr = dependencies.stderr ?? process.stderr;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  try {
    const { ElasticsearchDestination } = await import('../runtime/destinations/elasticsearch.js');
    const dest = new ElasticsearchDestination({
      host: options.host,
      port: options.port,
      apiKey: options.apiKey,
      username: options.username,
      password: options.password,
    });
    await dest.initialize();
    await dest.close();
    stderr.write(
      chalk.green(
        `✓ Elasticsearch: cluster at ${options.host}:${options.port ?? 9200} is accessible`
      ) + '\n'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(chalk.red(`✗ Elasticsearch: ${message}`) + '\n');
    setExitCode(1);
  }
}

async function checkChroma(
  options: {
    host: string;
    port?: number;
    tenant?: string;
    database?: string;
  },
  dependencies: CheckDependencies = {}
): Promise<void> {
  const stderr = dependencies.stderr ?? process.stderr;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  try {
    const { ChromaDestination } = await import('../runtime/destinations/chroma.js');
    const dest = new ChromaDestination({
      host: options.host,
      port: options.port,
      tenant: options.tenant,
      database: options.database,
    });
    await dest.initialize();
    await dest.close();
    stderr.write(
      chalk.green(`✓ Chroma: connected to ${options.host}:${options.port ?? 8000}`) + '\n'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(chalk.red(`✗ Chroma: ${message}`) + '\n');
    setExitCode(1);
  }
}

async function checkPgVector(
  options: {
    host: string;
    port?: number;
    database: string;
    schema?: string;
    username: string;
    password: string;
    ssl?: boolean;
  },
  dependencies: CheckDependencies = {}
): Promise<void> {
  const stderr = dependencies.stderr ?? process.stderr;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  try {
    const { PgVectorDestination } = await import('../runtime/destinations/pgvector.js');
    const dest = new PgVectorDestination({
      host: options.host,
      port: options.port,
      database: options.database,
      schema: options.schema ?? 'public',
      username: options.username,
      password: options.password,
      ssl: options.ssl,
    });
    await dest.initialize();
    await dest.close();
    stderr.write(
      chalk.green(
        `✓ PgVector: connected to ${options.host}:${options.port ?? 5432}/${options.database} (schema: ${options.schema ?? 'public'})`
      ) + '\n'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(chalk.red(`✗ PgVector: ${message}`) + '\n');
    setExitCode(1);
  }
}

async function checkS3(
  options: { bucket: string; region?: string; roleArn?: string; externalId?: string },
  dependencies: CheckDependencies = {}
): Promise<void> {
  const stderr = dependencies.stderr ?? process.stderr;
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  try {
    assertDriverVersion('@aws-sdk/client-s3', '3.1017.0', createRequire(import.meta.url));
    const { S3Client, HeadBucketCommand } = await import('@aws-sdk/client-s3');
    const { buildS3ClientConfig } = await import('../runtime/destinations/s3.js');
    const clientConfig = await buildS3ClientConfig({
      region: options.region,
      roleArn: options.roleArn,
      externalId: options.externalId,
    });
    const client = new S3Client(clientConfig);
    await client.send(new HeadBucketCommand({ Bucket: options.bucket }));
    stderr.write(chalk.green(`✓ S3: bucket "${options.bucket}" is accessible`) + '\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(chalk.red(`✗ S3: ${message}`) + '\n');
    setExitCode(1);
  }
}

export function registerCheckCommand(program: Command): void {
  program
    .command('check')
    .description('Validate destination connectivity and permissions')
    .option(
      '--dest <dest>',
      'Destination: duckdb, ducklake, sqlite, bigquery, snowflake, postgres, mysql, databricks, mssql, clickhouse, turbopuffer, elasticsearch, chroma, pgvector, gcs, local, or s3'
    )
    .option('--db-path <path>', 'DuckDB database file path')
    .option('--ducklake-catalog-url <url>', 'DuckLake catalog URL')
    .option('--ducklake-data-path <path>', 'DuckLake data path override')
    .option('--ducklake-alias <alias>', 'DuckLake attach alias')
    .option('--project-id <id>', 'BigQuery project ID')
    .option('--dataset-id <id>', 'BigQuery dataset ID')
    .option('--location <location>', 'BigQuery location')
    .option('--key-filename <path>', 'BigQuery service account key file')
    .option('--gcs-bucket <bucket>', 'GCS bucket name')
    .option('--output-dir <path>', 'Local output directory path')
    .option('--s3-bucket <bucket>', 'S3 bucket name')
    .option('--s3-region <region>', 'AWS region')
    .option('--s3-role-arn <arn>', 'AWS IAM role ARN for cross-account access')
    .option('--s3-external-id <id>', 'External ID for S3 role assumption')
    .option('--sf-account <account>', 'Snowflake account identifier')
    .option('--sf-username <user>', 'Snowflake username')
    .option('--sf-password <pass>', 'Snowflake password')
    .option('--sf-private-key-path <path>', 'Path to Snowflake private key file')
    .option('--sf-warehouse <wh>', 'Snowflake warehouse')
    .option('--sf-database <db>', 'Snowflake database')
    .option('--sf-role <role>', 'Snowflake role')
    .option('--postgres-host <host>', 'Postgres host')
    .option('--postgres-port <port>', 'Postgres port')
    .option('--postgres-database <db>', 'Postgres database')
    .option('--postgres-schema <schema>', 'Postgres schema')
    .option('--postgres-user <user>', 'Postgres username')
    .option('--postgres-password <pass>', 'Postgres password')
    .option('--postgres-ssl', 'Postgres SSL')
    .option('--mysql-host <host>', 'MySQL host')
    .option('--mysql-port <port>', 'MySQL port')
    .option('--mysql-database <database>', 'MySQL database name')
    .option('--mysql-user <user>', 'MySQL user')
    .option('--mysql-password <password>', 'MySQL password')
    .option('--mysql-ssl', 'Use SSL for MySQL connection')
    .option('--databricks-host <host>', 'Databricks server hostname')
    .option('--databricks-http-path <path>', 'Databricks HTTP path')
    .option('--databricks-token <token>', 'Databricks access token')
    .option('--databricks-catalog <catalog>', 'Databricks catalog')
    .option('--databricks-schema <schema>', 'Databricks schema')
    .option('--mssql-host <host>', 'MSSQL host')
    .option('--mssql-port <port>', 'MSSQL port')
    .option('--mssql-database <database>', 'MSSQL database name')
    .option('--mssql-schema <schema>', 'MSSQL schema')
    .option('--mssql-username <username>', 'MSSQL username')
    .option('--mssql-password <password>', 'MSSQL password')
    .option('--mssql-encrypt', 'Use encryption for MSSQL connection')
    .option('--mssql-trust-server-certificate', 'Trust MSSQL server certificate')
    .option('--pgvector-host <host>', 'PgVector host')
    .option('--pgvector-port <port>', 'PgVector port')
    .option('--pgvector-database <database>', 'PgVector database')
    .option('--pgvector-schema <schema>', 'PgVector schema')
    .option('--pgvector-user <user>', 'PgVector username')
    .option('--pgvector-password <password>', 'PgVector password')
    .option('--pgvector-ssl', 'Use SSL for PgVector connection')
    .option('--clickhouse-host <host>', 'ClickHouse host')
    .option('--clickhouse-port <port>', 'ClickHouse port')
    .option('--clickhouse-database <database>', 'ClickHouse database')
    .option('--clickhouse-username <username>', 'ClickHouse username')
    .option('--clickhouse-password <password>', 'ClickHouse password')
    .option('--clickhouse-ssl', 'Use HTTPS for the ClickHouse connection')
    .option('--turbopuffer-api-key <key>', 'Turbopuffer API key')
    .option('--turbopuffer-region <region>', 'Turbopuffer region')
    .option('--elasticsearch-host <host>', 'Elasticsearch host')
    .option('--elasticsearch-port <port>', 'Elasticsearch port')
    .option('--elasticsearch-api-key <key>', 'Elasticsearch API key')
    .option('--elasticsearch-username <username>', 'Elasticsearch username')
    .option('--elasticsearch-password <password>', 'Elasticsearch password')
    .option('--chroma-host <host>', 'Chroma host')
    .option('--chroma-port <port>', 'Chroma port')
    .option('--chroma-tenant <tenant>', 'Chroma tenant')
    .option('--chroma-database <database>', 'Chroma database')
    .action(async (rawOptions: Record<string, unknown>) => {
      const options = resolveOptionPlaceholders(rawOptions);
      const dest = options.dest as string | undefined;

      switch (dest) {
        case 'duckdb': {
          const dbPath = options.dbPath as string | undefined;
          if (!dbPath) {
            process.stderr.write(chalk.red('✗ --db-path is required for DuckDB check') + '\n');
            process.exitCode = 1;
            return;
          }
          await checkDuckDb(dbPath);
          break;
        }
        case 'ducklake': {
          const catalogUrl = options.ducklakeCatalogUrl as string | undefined;
          if (!catalogUrl) {
            process.stderr.write(
              chalk.red('✗ --ducklake-catalog-url is required for DuckLake check') + '\n'
            );
            process.exitCode = 2;
            return;
          }
          await checkDuckLake({
            catalogUrl,
            dataPath: options.ducklakeDataPath as string | undefined,
            attachAlias: options.ducklakeAlias as string | undefined,
          });
          break;
        }
        case 'sqlite': {
          const dbPath = options.dbPath as string | undefined;
          if (!dbPath) {
            process.stderr.write(chalk.red('✗ --db-path is required for SQLite check') + '\n');
            process.exitCode = 1;
            return;
          }
          await checkSqlite(dbPath);
          break;
        }
        case 'bigquery': {
          const datasetId = options.datasetId as string | undefined;
          if (!datasetId) {
            process.stderr.write(chalk.red('✗ --dataset-id is required for BigQuery check') + '\n');
            process.exitCode = 1;
            return;
          }
          await checkBigQuery({
            projectId: options.projectId as string | undefined,
            datasetId,
            location: options.location as string | undefined,
            keyFilename: options.keyFilename as string | undefined,
          });
          break;
        }
        case 'gcs': {
          const bucket = options.gcsBucket as string | undefined;
          if (!bucket) {
            process.stderr.write(chalk.red('✗ --gcs-bucket is required for GCS check') + '\n');
            process.exitCode = 1;
            return;
          }
          await checkGcs(bucket);
          break;
        }
        case 'local': {
          const outputDir = options.outputDir as string | undefined;
          if (!outputDir) {
            process.stderr.write(chalk.red('✗ --output-dir is required for local check') + '\n');
            process.exitCode = 1;
            return;
          }
          await checkLocal(outputDir);
          break;
        }
        case 's3': {
          const bucket = options.s3Bucket as string | undefined;
          if (!bucket) {
            process.stderr.write(chalk.red('✗ --s3-bucket is required for S3 check') + '\n');
            process.exitCode = 1;
            return;
          }
          await checkS3({
            bucket,
            region: options.s3Region as string | undefined,
            roleArn: options.s3RoleArn as string | undefined,
            externalId: options.s3ExternalId as string | undefined,
          });
          break;
        }
        case 'snowflake': {
          const account = options.sfAccount as string | undefined;
          const username = options.sfUsername as string | undefined;
          const warehouse = options.sfWarehouse as string | undefined;
          const database = options.sfDatabase as string | undefined;
          if (!account || !username || !warehouse || !database) {
            process.stderr.write(
              chalk.red(
                '✗ --sf-account, --sf-username, --sf-warehouse, and --sf-database are required for Snowflake check'
              ) + '\n'
            );
            process.exitCode = 1;
            return;
          }
          await checkSnowflake({
            account,
            username,
            password: options.sfPassword as string | undefined,
            privateKeyPath: options.sfPrivateKeyPath as string | undefined,
            warehouse,
            database,
            role: options.sfRole as string | undefined,
          });
          break;
        }
        case 'postgres': {
          const host = options.postgresHost as string | undefined;
          const database = options.postgresDatabase as string | undefined;
          const username = options.postgresUser as string | undefined;
          const password = options.postgresPassword as string | undefined;
          if (!host || !database || !username || !password) {
            process.stderr.write(
              chalk.red(
                '✗ --postgres-host, --postgres-database, --postgres-user, and --postgres-password are required for Postgres check'
              ) + '\n'
            );
            process.exitCode = 1;
            return;
          }
          await checkPostgres({
            host,
            port: options.postgresPort as number | undefined,
            database,
            schema: options.postgresSchema as string | undefined,
            username,
            password,
            ssl: options.postgresSsl as boolean | undefined,
          });
          break;
        }
        case 'mysql': {
          const host = options.mysqlHost as string | undefined;
          const database = options.mysqlDatabase as string | undefined;
          const user = options.mysqlUser as string | undefined;
          if (!host) {
            process.stderr.write(chalk.red('✗ --mysql-host is required for MySQL check') + '\n');
            process.exitCode = 1;
            return;
          }
          if (!database) {
            process.stderr.write(
              chalk.red('✗ --mysql-database is required for MySQL check') + '\n'
            );
            process.exitCode = 1;
            return;
          }
          if (!user) {
            process.stderr.write(chalk.red('✗ --mysql-user is required for MySQL check') + '\n');
            process.exitCode = 1;
            return;
          }
          await checkMySql({
            host,
            port: options.mysqlPort as number | undefined,
            database,
            user,
            password: options.mysqlPassword as string | undefined,
            ssl: options.mysqlSsl as boolean | undefined,
          });
          break;
        }
        case 'databricks': {
          const host = options.databricksHost as string | undefined;
          const httpPath = options.databricksHttpPath as string | undefined;
          const token = options.databricksToken as string | undefined;
          const catalog = options.databricksCatalog as string | undefined;
          const schema = options.databricksSchema as string | undefined;
          if (!host || !httpPath || !token || !catalog || !schema) {
            process.stderr.write(
              chalk.red(
                '✗ --databricks-host, --databricks-http-path, --databricks-token, --databricks-catalog, and --databricks-schema are required for Databricks check'
              ) + '\n'
            );
            process.exitCode = 1;
            return;
          }
          await checkDatabricks({
            serverHostname: host,
            httpPath,
            accessToken: token,
            catalog,
            schema,
          });
          break;
        }
        case 'mssql': {
          const host = options.mssqlHost as string | undefined;
          const database = options.mssqlDatabase as string | undefined;
          if (!host) {
            process.stderr.write(chalk.red('✗ --mssql-host is required for MSSQL check') + '\n');
            process.exitCode = 1;
            return;
          }
          if (!database) {
            process.stderr.write(
              chalk.red('✗ --mssql-database is required for MSSQL check') + '\n'
            );
            process.exitCode = 1;
            return;
          }
          await checkMsSql({
            host,
            port: options.mssqlPort as number | undefined,
            database,
            username: options.mssqlUsername as string | undefined,
            password: options.mssqlPassword as string | undefined,
            encrypt: options.mssqlEncrypt as boolean | undefined,
            trustServerCertificate: options.mssqlTrustServerCertificate as boolean | undefined,
            schema: options.mssqlSchema as string | undefined,
          });
          break;
        }
        case 'clickhouse': {
          const host = options.clickhouseHost as string | undefined;
          const database = options.clickhouseDatabase as string | undefined;
          if (!host) {
            process.stderr.write(
              chalk.red('✗ --clickhouse-host is required for ClickHouse check') + '\n'
            );
            process.exitCode = 1;
            return;
          }
          if (!database) {
            process.stderr.write(
              chalk.red('✗ --clickhouse-database is required for ClickHouse check') + '\n'
            );
            process.exitCode = 1;
            return;
          }
          await checkClickHouse({
            host,
            port: options.clickhousePort as number | undefined,
            database,
            username: options.clickhouseUsername as string | undefined,
            password: options.clickhousePassword as string | undefined,
            ssl: options.clickhouseSsl as boolean | undefined,
          });
          break;
        }
        case 'turbopuffer': {
          const apiKey = options.turbopufferApiKey as string | undefined;
          if (!apiKey) {
            process.stderr.write(
              chalk.red('✗ --turbopuffer-api-key is required for Turbopuffer check') + '\n'
            );
            process.exitCode = 2;
            return;
          }
          await checkTurbopuffer({
            apiKey,
            region: options.turbopufferRegion as string | undefined,
          });
          break;
        }
        case 'elasticsearch': {
          const host = options.elasticsearchHost as string | undefined;
          if (!host) {
            process.stderr.write(
              chalk.red('✗ --elasticsearch-host is required for Elasticsearch check') + '\n'
            );
            process.exitCode = 1;
            return;
          }
          await checkElasticsearch({
            host,
            port: options.elasticsearchPort as number | undefined,
            apiKey: options.elasticsearchApiKey as string | undefined,
            username: options.elasticsearchUsername as string | undefined,
            password: options.elasticsearchPassword as string | undefined,
          });
          break;
        }
        case 'chroma': {
          const host = options.chromaHost as string | undefined;
          if (!host) {
            process.stderr.write(chalk.red('✗ --chroma-host is required for Chroma check') + '\n');
            process.exitCode = 2;
            return;
          }
          await checkChroma({
            host,
            port: options.chromaPort as number | undefined,
            tenant: options.chromaTenant as string | undefined,
            database: options.chromaDatabase as string | undefined,
          });
          break;
        }
        case 'pgvector': {
          const host = options.pgvectorHost as string | undefined;
          const database = options.pgvectorDatabase as string | undefined;
          const username = options.pgvectorUser as string | undefined;
          const password = options.pgvectorPassword as string | undefined;
          if (!host || !database || !username || !password) {
            process.stderr.write(
              chalk.red(
                '✗ --pgvector-host, --pgvector-database, --pgvector-user, and --pgvector-password are required for PgVector check'
              ) + '\n'
            );
            process.exitCode = 2;
            return;
          }
          await checkPgVector({
            host,
            port: options.pgvectorPort as number | undefined,
            database,
            schema: options.pgvectorSchema as string | undefined,
            username,
            password,
            ssl: options.pgvectorSsl as boolean | undefined,
          });
          break;
        }
        default:
          process.stderr.write(
            chalk.red(
              '✗ --dest must be one of: duckdb, ducklake, sqlite, bigquery, snowflake, postgres, mysql, databricks, mssql, clickhouse, turbopuffer, elasticsearch, chroma, pgvector, gcs, local, s3'
            ) + '\n'
          );
          process.exitCode = 2;
      }
    });
}

export {
  checkDuckDb,
  checkDuckLake,
  checkSqlite,
  checkLocal,
  checkS3,
  checkSnowflake,
  checkPostgres,
  checkMySql,
  checkDatabricks,
  checkMsSql,
  checkClickHouse,
  checkTurbopuffer,
  checkElasticsearch,
  checkChroma,
  checkPgVector,
};
