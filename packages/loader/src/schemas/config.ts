import { z } from 'zod';

import {
  isValidStreamSubfolder,
  LOAD_STRATEGIES,
  normalizeStreamSubfolder,
  SCHEMA_BEHAVIORS,
  STREAM_SUBFOLDER_RULE,
} from '@bobsled-inc/protocol';
import { OUTPUT_FORMATS } from '../runtime/formats.js';
import {
  RESERVED_TABLE_PREFIX,
  SQL_IDENTIFIER_PATTERN,
  usesReservedTablePrefix,
} from '../runtime/identifiers.js';

const bufferSize = z.coerce.number().int().positive().default(100_000);
const sqlIdentifier = z
  .string()
  .trim()
  .min(1)
  .regex(
    SQL_IDENTIFIER_PATTERN,
    'Must be a valid SQL identifier (letters, digits, underscores; must start with letter or underscore)'
  );
const hostName = z
  .string()
  .trim()
  .min(1)
  .regex(/^[^/:@#?]+$/, 'Must be a valid hostname (no /, :, @, #, or ? characters)');
const logFormat = z.enum(['text', 'json']).default('json');
const memorySizePattern = z
  .string()
  .regex(
    /^\d+(\.\d+)?\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/i,
    'Must be a valid memory size (e.g. "512MB", "2GB")'
  )
  .optional();
const snowflakeWorkloadIdentityToken = z
  .string()
  .refine((value) => !/[\r\n]/.test(value), 'must not contain CR or LF characters')
  .trim()
  .min(1);

/**
 * Opt-in folder added inside each stream's folder for file destinations, so a
 * file lands at `<prefix><stream>/<streamSubfolder>/<stream>-<n>.<ext>`.
 * Omitted by default, which keeps `<prefix><stream>/<stream>-<n>.<ext>`.
 */
const streamSubfolder = z
  .string()
  .trim()
  .transform(normalizeStreamSubfolder)
  .refine(isValidStreamSubfolder, STREAM_SUBFOLDER_RULE)
  .optional();

/**
 * Opt-in: write timestamp columns as UTC-adjusted. Parquet output only.
 * Omitted by default, which keeps timestamps as written before.
 */
const utcTimestamps = z.boolean().optional();

const utcTimestampsNeedParquet = {
  check: (config: { format: string; utcTimestamps?: boolean | undefined }) =>
    config.utcTimestamps !== true || config.format === 'parquet',
  options: {
    message: 'utcTimestamps applies to parquet output only',
    path: ['utcTimestamps'],
  },
};

const LocalDestConfigSchema = z
  .object({
    dest: z.literal('local'),
    format: z.enum(OUTPUT_FORMATS),
    outputDir: z.string().trim().min(1).default('./output'),
    streamSubfolder,
    utcTimestamps,
    bufferSize,
    logFormat,
  })
  .refine(utcTimestampsNeedParquet.check, utcTimestampsNeedParquet.options);

const GcsDestConfigSchema = z
  .object({
    dest: z.literal('gcs'),
    format: z.enum(OUTPUT_FORMATS),
    outputDir: z.string().trim().min(1).default('./output'),
    gcsBucket: z.string().trim().min(1),
    gcsPrefix: z.string().trim().min(1).optional(),
    streamSubfolder,
    utcTimestamps,
    bufferSize,
    logFormat,
  })
  .refine(utcTimestampsNeedParquet.check, utcTimestampsNeedParquet.options);

const S3DestConfigSchema = z
  .object({
    dest: z.literal('s3'),
    format: z.enum(OUTPUT_FORMATS),
    outputDir: z.string().trim().min(1).default('./output'),
    s3Bucket: z.string().trim().min(1),
    s3Prefix: z.string().trim().min(1).optional(),
    s3Region: z.string().trim().min(1).optional(),
    s3RoleArn: z.string().trim().min(1).optional(),
    s3ExternalId: z.string().trim().min(1).optional(),
    streamSubfolder,
    utcTimestamps,
    bufferSize,
    logFormat,
  })
  .refine(utcTimestampsNeedParquet.check, utcTimestampsNeedParquet.options);

const tablePrefix = z.string().trim().min(1).optional();
const destinationTable = sqlIdentifier.refine(
  (value) => !usesReservedTablePrefix(value),
  `Must not use the reserved staging prefix "${RESERVED_TABLE_PREFIX}"`
);

/**
 * Per-stream load-strategy overrides, keyed by the RAW stream name as it
 * appears in the SCHEMA message (before `tablePrefix` / sanitization). Set by
 * repeatable `--stream-load-strategy <stream>:<strategy>` flags, or by Dogsled
 * when a `dogsled.yml` resource declares `load_strategy:`.
 *
 * Precedence (highest first): this map → `loadStrategy` (the pipeline-level
 * `--load-strategy` default) → the SCHEMA message's own `load_strategy` →
 * `append`.
 */
const streamLoadStrategies = z.record(z.string().min(1), z.enum(LOAD_STRATEGIES)).optional();

/**
 * Per-stream schema-behavior overrides, keyed by the RAW stream name as it
 * appears in the SCHEMA message. Set by repeatable
 * `--stream-schema-behavior <stream>:<mode>` flags, or by Dogsled when a
 * `dogsled.yml` resource declares `schema_behavior:`.
 *
 * Precedence (highest first): this map → `schemaBehavior` (the pipeline-level
 * `--schema-behavior` default) → the SCHEMA message's own `schema_behavior` →
 * the loader's `evolve` default.
 */
const streamSchemaBehaviors = z.record(z.string().min(1), z.enum(SCHEMA_BEHAVIORS)).optional();

/**
 * Per-stream destination table names, keyed by the RAW stream name as it
 * appears in the SCHEMA message. Set by repeatable
 * `--stream-table <stream>:<table>` flags, or by Dogsled when a `dogsled.yml`
 * resource declares `table:`. An entry REPLACES the whole computed table name
 * — `tablePrefix` is not re-applied on top of it.
 */
const streamTables = z.record(sqlIdentifier, destinationTable).optional();

/**
 * Per-stream ownership markers for administrator-reserved warehouse tables.
 * Destinations persist and validate the exact marker before guarded mutations.
 */
const streamTableOwnershipMarkers = z
  .record(z.string().min(1), z.string().min(1).max(256))
  .optional();

/** Raw stream names explicitly selected for a one-shot Snowflake reconciliation. */
const reconcileSchema = z
  .array(sqlIdentifier)
  .min(1)
  .refine((streams) => new Set(streams).size === streams.length, 'Stream names must be unique')
  .optional();

const DuckDbDestConfigSchema = z.object({
  dest: z.literal('duckdb'),
  dbPath: z.string().trim().min(1),
  targetSchema: sqlIdentifier.default('main'),
  loadStrategy: z.enum(LOAD_STRATEGIES).optional(),
  schemaBehavior: z.enum(SCHEMA_BEHAVIORS).optional(),
  bufferSize,
  logFormat,
  memoryLimit: memorySizePattern,
  maxConcurrentLoads: z.coerce.number().int().positive().default(1),
  checkpointDir: z.string().trim().min(1).optional(),
  maxBufferMemory: memorySizePattern,
  tablePrefix,
  streamLoadStrategies,
  streamSchemaBehaviors,
  streamTables,
});

const DuckLakeDestConfigSchema = z.object({
  dest: z.literal('ducklake'),
  catalogUrl: z.string().trim().min(1),
  dataPath: z.string().trim().min(1).optional(),
  attachAlias: sqlIdentifier.default('lake'),
  targetSchema: sqlIdentifier.default('main'),
  // Schema in the (postgres/sqlite/duckdb) catalog DB where DuckLake stores its
  // own metadata tables (`ducklake_*`). Emitted as the `METADATA_SCHEMA` ATTACH
  // option. Lets the catalog live in a dedicated schema instead of `public`.
  metadataSchema: sqlIdentifier.optional(),
  loadStrategy: z.enum(LOAD_STRATEGIES).optional(),
  schemaBehavior: z.enum(SCHEMA_BEHAVIORS).optional(),
  bufferSize,
  logFormat,
  memoryLimit: memorySizePattern,
  maxConcurrentLoads: z.coerce.number().int().positive().default(1),
  checkpointDir: z.string().trim().min(1).optional(),
  maxBufferMemory: memorySizePattern,
  tablePrefix,
  streamLoadStrategies,
  streamSchemaBehaviors,
  streamTables,
});

const BigQueryDestConfigSchema = z.object({
  dest: z.literal('bigquery'),
  projectId: z.string().trim().min(1).optional(),
  datasetId: sqlIdentifier,
  location: z.string().trim().min(1).optional(),
  keyFilename: z.string().trim().min(1).optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
  /**
   * Pre-minted short-lived OAuth 2.0 access token. When set, takes
   * precedence over `keyFilename` and `credentials`; passed directly
   * to `new BigQuery({ token })` (mirrors dbt-bigquery's
   * `oauth-secrets` Temporary Token method). The runner is responsible
   * for resolving any `$VARNAME` placeholder in the source `dogsled.yml`
   * `credentials_access_token:` field before constructing this config.
   */
  accessToken: z.string().trim().min(1).optional(),
  /**
   * Shell command that prints a FRESH short-lived OAuth 2.0 access token as JSON
   * `{ "access_token": string, "expires_at": number }` (`expires_at` = Unix
   * seconds; `expires_in` seconds-from-now accepted as a fallback). Run once per
   * fetch by the loader, which refreshes proactively (within a 5-min skew of
   * expiry) and reactively (on a 401) so loads survive past the token TTL.
   *
   * Dogsled.yml field name: `credentials_token_command`. Takes precedence over the
   * static `credentials_access_token` (`accessToken`) when both are present.
   * Supports `$VAR` / `${{ env.VAR }}` placeholders like other secret fields.
   */
  tokenCommand: z.string().trim().min(1).optional(),
  loadStrategy: z.enum(LOAD_STRATEGIES).optional(),
  schemaBehavior: z.enum(SCHEMA_BEHAVIORS).optional(),
  bufferSize,
  logFormat,
  targetFileSizeMb: z.coerce.number().positive().optional().default(256),
  stagingFormat: z.enum(['parquet', 'jsonl']).default('parquet'),
  gcsStagingBucket: z.string().trim().min(1).optional(),
  gcsStagingPrefix: z.string().trim().min(1).optional(),
  maxConcurrentLoads: z.coerce.number().int().positive().default(4),
  checkpointDir: z.string().trim().min(1).optional(),
  maxBufferMemory: memorySizePattern,
  metricsFile: z.string().trim().min(1).optional(),
  maxLoadJobs: z.coerce.number().int().positive().optional().default(9000),
  tablePrefix,
  streamLoadStrategies,
  streamSchemaBehaviors,
  streamTables,
  streamTableOwnershipMarkers,
});

const SnowflakeDestConfigSchema = z.object({
  dest: z.literal('snowflake'),
  account: z.string().trim().min(1),
  username: z.string().trim().min(1),
  password: z.string().trim().min(1).optional(),
  privateKeyPath: z.string().trim().min(1).optional(),
  privateKeyPassphrase: z.string().trim().min(1).optional(),
  /**
   * Pre-minted short-lived OAuth 2.0 / OIDC access token for Snowflake.
   * When set, the loader forces `authenticator: 'OAUTH'` and passes this value
   * to `snowflake-sdk` as `token`.
   */
  accessToken: z.string().trim().min(1).optional(),
  /**
   * Shell command that prints JSON
   * `{ "access_token": string, "expires_at": number }` (`expires_in` also
   * accepted). Run once per fetch via the shared refreshable-token provider.
   *
   * Dogsled.yml field name: `credentials_token_command`. Takes precedence over
   * `credentials_access_token` (`accessToken`) when both are set.
   */
  tokenCommand: z.string().trim().min(1).optional(),
  /** Pre-minted Snowflake OIDC workload identity JWT for one loader attempt. */
  workloadIdentityToken: snowflakeWorkloadIdentityToken.optional(),
  // Explicit Snowflake authenticator.
  //   - 'OAUTH' (client_credentials grant): loader fetches an access token at connection time
  //     via oauthClientId / oauthClientSecret / oauthTokenUrl and passes it as `token`.
  //   - 'SNOWFLAKE_JWT' (RSA key-pair): loader reads privateKeyPath + privateKeyPassphrase and
  //     lets snowflake-sdk sign JWTs. Required — without it the driver defaults to password auth.
  authenticator: z.enum(['OAUTH', 'SNOWFLAKE_JWT']).optional(),
  oauthClientId: z.string().trim().min(1).optional(),
  oauthClientSecret: z.string().trim().min(1).optional(),
  oauthTokenUrl: z.string().url().optional(),
  warehouse: z.string().trim().min(1),
  database: z.string().trim().min(1),
  targetSchema: sqlIdentifier.default('PUBLIC'),
  role: z.string().trim().min(1).optional(),
  loadStrategy: z.enum(LOAD_STRATEGIES).optional(),
  schemaBehavior: z.enum(SCHEMA_BEHAVIORS).optional(),
  bufferSize,
  logFormat,
  maxConcurrentLoads: z.coerce.number().int().positive().default(1),
  checkpointDir: z.string().trim().min(1).optional(),
  maxBufferMemory: memorySizePattern,
  tablePrefix,
  streamLoadStrategies,
  streamSchemaBehaviors,
  streamTables,
  streamTableOwnershipMarkers,
  reconcileSchema,
});

const PostgresDestConfigSchema = z.object({
  dest: z.literal('postgres'),
  host: z.string().trim().min(1),
  port: z.coerce.number().int().positive().optional().default(5432),
  database: z.string().trim().min(1),
  schema: sqlIdentifier.optional().default('public'),
  username: z.string().trim().min(1),
  password: z.string().trim().min(1),
  ssl: z.boolean().optional().default(false),
  loadStrategy: z.enum(LOAD_STRATEGIES).optional(),
  schemaBehavior: z.enum(SCHEMA_BEHAVIORS).optional(),
  bufferSize,
  logFormat,
  maxConcurrentLoads: z.coerce.number().int().positive().default(1),
  checkpointDir: z.string().trim().min(1).optional(),
  maxBufferMemory: memorySizePattern,
  tablePrefix,
  streamLoadStrategies,
  streamSchemaBehaviors,
  streamTables,
  streamTableOwnershipMarkers,
});

const MySqlDestConfigSchema = z.object({
  dest: z.literal('mysql'),
  host: z.string().trim().min(1),
  port: z.coerce.number().int().positive().default(3306),
  database: z.string().trim().min(1),
  user: z.string().trim().min(1),
  password: z.string().trim().min(1).optional(),
  ssl: z.boolean().default(false),
  loadStrategy: z.enum(LOAD_STRATEGIES).optional(),
  schemaBehavior: z.enum(SCHEMA_BEHAVIORS).optional(),
  bufferSize,
  logFormat,
  maxConcurrentLoads: z.coerce.number().int().positive().default(4),
  checkpointDir: z.string().trim().min(1).optional(),
  maxBufferMemory: memorySizePattern,
  tablePrefix,
  streamLoadStrategies,
  streamSchemaBehaviors,
  streamTables,
});

const DatabricksDestConfigSchema = z.object({
  dest: z.literal('databricks'),
  serverHostname: z.string().trim().min(1),
  httpPath: z.string().trim().min(1),
  accessToken: z.string().trim().min(1).optional(),
  oauthClientId: z.string().trim().min(1).optional(),
  oauthClientSecret: z.string().trim().min(1).optional(),
  catalog: sqlIdentifier,
  schema: sqlIdentifier,
  loadStrategy: z.enum(LOAD_STRATEGIES).optional(),
  schemaBehavior: z.enum(SCHEMA_BEHAVIORS).optional(),
  bufferSize,
  logFormat,
  maxConcurrentLoads: z.coerce.number().int().positive().default(4),
  checkpointDir: z.string().trim().min(1).optional(),
  maxBufferMemory: memorySizePattern,
  tablePrefix,
  streamLoadStrategies,
  streamSchemaBehaviors,
  streamTables,
  streamTableOwnershipMarkers,
});

const SqliteDestConfigSchema = z.object({
  dest: z.literal('sqlite'),
  dbPath: z.string().trim().min(1),
  // SQLite only supports the 'main' schema without ATTACH DATABASE
  targetSchema: z.literal('main').default('main'),
  loadStrategy: z.enum(LOAD_STRATEGIES).optional(),
  schemaBehavior: z.enum(SCHEMA_BEHAVIORS).optional(),
  bufferSize,
  logFormat,
  maxConcurrentLoads: z.coerce.number().int().positive().default(1),
  checkpointDir: z.string().trim().min(1).optional(),
  maxBufferMemory: memorySizePattern,
  tablePrefix,
  streamLoadStrategies,
  streamSchemaBehaviors,
  streamTables,
});

const MsSqlDestConfigSchema = z.object({
  dest: z.literal('mssql'),
  host: z.string().trim().min(1),
  port: z.coerce.number().int().positive().optional().default(1433),
  database: z.string().trim().min(1),
  schema: sqlIdentifier.optional().default('dbo'),
  username: z.string().trim().min(1).optional(),
  password: z.string().trim().min(1).optional(),
  encrypt: z.boolean().optional().default(true),
  trustServerCertificate: z.boolean().optional().default(false),
  loadStrategy: z.enum(LOAD_STRATEGIES).optional(),
  schemaBehavior: z.enum(SCHEMA_BEHAVIORS).optional(),
  bufferSize,
  logFormat,
  maxConcurrentLoads: z.coerce.number().int().positive().default(4),
  checkpointDir: z.string().trim().min(1).optional(),
  maxBufferMemory: memorySizePattern,
  tablePrefix,
  streamLoadStrategies,
  streamSchemaBehaviors,
  streamTables,
});

const ClickHouseDestConfigSchema = z.object({
  dest: z.literal('clickhouse'),
  host: hostName,
  port: z.coerce.number().int().positive().optional().default(8123),
  database: z.string().trim().min(1),
  username: z.string().trim().min(1).optional().default('default'),
  password: z.string().trim().min(1).optional(),
  ssl: z.boolean().optional().default(false),
  vectorIndex: z.boolean().optional().default(false),
  loadStrategy: z.enum(LOAD_STRATEGIES).optional(),
  schemaBehavior: z.enum(SCHEMA_BEHAVIORS).optional(),
  bufferSize,
  logFormat,
  maxConcurrentLoads: z.coerce.number().int().positive().default(4),
  checkpointDir: z.string().trim().min(1).optional(),
  maxBufferMemory: memorySizePattern,
  tablePrefix,
  streamLoadStrategies,
  streamSchemaBehaviors,
  streamTables,
});

const ElasticsearchDestConfigSchema = z.object({
  dest: z.literal('elasticsearch'),
  host: hostName,
  port: z.coerce.number().int().positive().optional().default(9200),
  index: z.string().trim().min(1).optional().default('vectors'),
  apiKey: z.string().trim().min(1).optional(),
  username: z.string().trim().min(1).optional(),
  password: z.string().trim().min(1).optional(),
  ssl: z.boolean().optional().default(false),
  vectorDimension: z.coerce.number().int().positive().optional(),
  vectorColumns: z.array(z.string()).optional(),
  loadStrategy: z.enum(LOAD_STRATEGIES).optional(),
  schemaBehavior: z.enum(SCHEMA_BEHAVIORS).optional(),
  bufferSize,
  logFormat,
  maxConcurrentLoads: z.coerce.number().int().positive().default(4),
  checkpointDir: z.string().trim().min(1).optional(),
  maxBufferMemory: memorySizePattern,
  tablePrefix,
  streamLoadStrategies,
  streamSchemaBehaviors,
  streamTables,
});

const ChromaDestConfigSchema = z.object({
  dest: z.literal('chroma'),
  host: hostName,
  port: z.coerce.number().int().positive().optional().default(8000),
  tenant: z.string().trim().min(1).optional(),
  database: z.string().trim().min(1).optional(),
  loadStrategy: z.enum(LOAD_STRATEGIES).optional(),
  schemaBehavior: z.enum(SCHEMA_BEHAVIORS).optional(),
  bufferSize,
  logFormat,
  maxConcurrentLoads: z.coerce.number().int().positive().default(4),
  checkpointDir: z.string().trim().min(1).optional(),
  maxBufferMemory: memorySizePattern,
  tablePrefix,
  streamLoadStrategies,
  streamSchemaBehaviors,
  streamTables,
});

const PgVectorDestConfigSchema = z
  .object({
    dest: z.literal('pgvector'),
    host: hostName,
    port: z.coerce.number().int().positive().optional().default(5432),
    database: z.string().trim().min(1),
    schema: sqlIdentifier.optional().default('public'),
    username: z.string().trim().min(1),
    password: z.string().trim().min(1),
    ssl: z.boolean().optional().default(false),
    loadStrategy: z.enum(LOAD_STRATEGIES).optional(),
    schemaBehavior: z.enum(SCHEMA_BEHAVIORS).optional(),
    bufferSize,
    logFormat,
    maxConcurrentLoads: z.coerce.number().int().positive().default(1),
    checkpointDir: z.string().trim().min(1).optional(),
    maxBufferMemory: memorySizePattern,
    tablePrefix,
    streamLoadStrategies,
    streamSchemaBehaviors,
    streamTables,
    vectorDimension: z.coerce.number().int().positive().optional(),
    vectorColumns: z.array(z.string()).optional(),
  })
  .refine((c) => (c.vectorColumns === undefined) === (c.vectorDimension === undefined), {
    message: 'vectorColumns and vectorDimension must be provided together',
  });

const TurbopufferDestConfigSchema = z
  .object({
    dest: z.literal('turbopuffer'),
    apiKey: z.string().trim().min(1),
    region: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]+$/, 'Must be a Turbopuffer region id such as gcp-us-central1')
      .default('gcp-us-central1'),
    namespacePrefix: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]*$/)
      .optional(),
    distanceMetric: z.enum(['cosine_distance', 'euclidean_squared']).optional(),
    fullTextColumns: z.array(z.string()).optional(),
    vectorDimension: z.coerce.number().int().positive().optional(),
    vectorColumns: z.array(z.string()).optional(),
    loadStrategy: z.enum(LOAD_STRATEGIES).optional(),
    schemaBehavior: z.enum(SCHEMA_BEHAVIORS).optional(),
    bufferSize,
    logFormat,
    maxConcurrentLoads: z.coerce.number().int().positive().default(4),
    checkpointDir: z.string().trim().min(1).optional(),
    maxBufferMemory: memorySizePattern,
    tablePrefix,
    streamLoadStrategies,
    streamSchemaBehaviors,
    streamTables,
  })
  .refine((c) => (c.vectorColumns === undefined) === (c.vectorDimension === undefined), {
    message: 'vectorColumns and vectorDimension must be provided together',
  });
export const LoaderConfigSchema = z.discriminatedUnion('dest', [
  LocalDestConfigSchema,
  GcsDestConfigSchema,
  S3DestConfigSchema,
  DuckDbDestConfigSchema,
  DuckLakeDestConfigSchema,
  BigQueryDestConfigSchema,
  SnowflakeDestConfigSchema,
  PostgresDestConfigSchema,
  MySqlDestConfigSchema,
  DatabricksDestConfigSchema,
  SqliteDestConfigSchema,
  MsSqlDestConfigSchema,
  ClickHouseDestConfigSchema,
  ElasticsearchDestConfigSchema,
  ChromaDestConfigSchema,
  PgVectorDestConfigSchema,
  TurbopufferDestConfigSchema,
]);

export type LoaderConfig = z.infer<typeof LoaderConfigSchema>;
export type LocalDestConfig = z.infer<typeof LocalDestConfigSchema>;
export type GcsDestConfig = z.infer<typeof GcsDestConfigSchema>;
export type S3DestConfig = z.infer<typeof S3DestConfigSchema>;
export type DuckDbDestConfig = z.infer<typeof DuckDbDestConfigSchema>;
export type DuckLakeDestConfig = z.infer<typeof DuckLakeDestConfigSchema>;
export type BigQueryDestConfig = z.infer<typeof BigQueryDestConfigSchema>;
export type SnowflakeDestConfig = z.infer<typeof SnowflakeDestConfigSchema>;
export type PostgresDestConfig = z.infer<typeof PostgresDestConfigSchema>;
export type MySqlDestConfig = z.infer<typeof MySqlDestConfigSchema>;
export type DatabricksDestConfig = z.infer<typeof DatabricksDestConfigSchema>;
export type SqliteDestConfig = z.infer<typeof SqliteDestConfigSchema>;
export type MsSqlDestConfig = z.infer<typeof MsSqlDestConfigSchema>;
export type ClickHouseDestConfig = z.infer<typeof ClickHouseDestConfigSchema>;
export type ElasticsearchDestConfig = z.infer<typeof ElasticsearchDestConfigSchema>;
export type ChromaDestConfig = z.infer<typeof ChromaDestConfigSchema>;
export type PgVectorDestConfig = z.infer<typeof PgVectorDestConfigSchema>;
export type TurbopufferDestConfig = z.infer<typeof TurbopufferDestConfigSchema>;
export type FileDestConfig = LocalDestConfig | GcsDestConfig | S3DestConfig;
