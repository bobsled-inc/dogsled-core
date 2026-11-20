import { CommandError, parseEnvPlaceholder } from '@bobsled-inc/protocol';

/** CLI option-to-config mapping, extracted to keep run.ts under the file-size budget. */
export function resolveEnvPlaceholder(value: string, label = 'an option value'): string {
  if (!value.startsWith('$')) {
    return value;
  }

  const envName = parseEnvPlaceholder(value);
  if (!envName) {
    throw new CommandError(
      `Invalid environment variable name in placeholder for ${label}. Use format $ENV_VAR_NAME or \${{ env.ENV_VAR_NAME }}.`,
      2
    );
  }

  const resolved = process.env[envName];
  if (resolved === undefined) {
    throw new CommandError(`Missing environment variable: ${envName}`, 2);
  }

  return resolved;
}

/** Resolve the Snowflake workload identity CLI option without accepting a token in argv. */
export function parseSnowflakeWorkloadIdentityToken(value: string): string {
  const envName = parseEnvPlaceholder(value);
  if (!envName) {
    throw new CommandError(
      'Snowflake workload identity token must be an environment variable reference.',
      2
    );
  }

  const resolved = process.env[envName];
  if (resolved === undefined) {
    throw new CommandError('Snowflake workload identity token environment variable is not set.', 2);
  }
  if (resolved.trim().length === 0) {
    throw new CommandError('Snowflake workload identity token must be non-empty.', 2);
  }

  return resolved;
}

/**
 * Parse the `--object-metadata` JSON object. The config schema checks its keys, values and size.
 * Its values are free text, so the loader takes them as they are and never expands a `$NAME` in
 * them: `dogsled.yml` resolves its placeholders before it starts the loader, and a second pass
 * would read what the first one wrote as another placeholder.
 */
function parseObjectMetadataOption(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const fail = (): never => {
    throw new CommandError(
      '--object-metadata must be a JSON object of text values, such as \'{"team":"data"}\'.',
      2
    );
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    return fail();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fail();
  return parsed as Record<string, unknown>;
}

function resolveNestedPlaceholders<T>(value: T, label = 'an option value'): T {
  if (typeof value === 'string') {
    return resolveEnvPlaceholder(value, label) as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveNestedPlaceholders(entry, label)) as T;
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        resolveNestedPlaceholders(entry, `destination field "${key}"`),
      ])
    ) as T;
  }

  return value;
}

function parseStringListOption(value: unknown): string[] | undefined {
  if (typeof value !== 'string') {
    return Array.isArray(value) ? (resolveNestedPlaceholders(value) as string[]) : undefined;
  }

  const resolved = resolveEnvPlaceholder(value);
  return resolved
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function buildConfigInput(options: Record<string, unknown>): Record<string, unknown> {
  const dest = (options.dest as string) ?? 'local';
  const reconcileSchema = parseStringListOption(options.reconcileSchema);
  if (dest !== 'snowflake' && reconcileSchema && reconcileSchema.length > 0) {
    throw new CommandError('--reconcile-schema is only supported for Snowflake destinations.', 2);
  }

  switch (dest) {
    case 'duckdb':
      return resolveNestedPlaceholders({
        dest,
        dbPath: options.dbPath,
        targetSchema: options.targetSchema,
        loadStrategy: options.loadStrategy,
        schemaBehavior: options.schemaBehavior,
        bufferSize: options.bufferSize,
        logFormat: options.logFormat,
        memoryLimit: options.memoryLimit,
        maxConcurrentLoads: options.maxConcurrentLoads,
        checkpointDir: options.checkpointDir,
        maxBufferMemory: options.maxBufferMemory,
        tablePrefix: options.tablePrefix,
        streamLoadStrategies: options.streamLoadStrategy,
        streamSchemaBehaviors: options.streamSchemaBehavior,
        streamTables: options.streamTable,
      });
    case 'ducklake':
      return resolveNestedPlaceholders({
        dest,
        catalogUrl: options.ducklakeCatalogUrl,
        dataPath: options.ducklakeDataPath,
        attachAlias: options.ducklakeAlias,
        targetSchema: options.targetSchema,
        loadStrategy: options.loadStrategy,
        schemaBehavior: options.schemaBehavior,
        bufferSize: options.bufferSize,
        logFormat: options.logFormat,
        memoryLimit: options.memoryLimit,
        maxConcurrentLoads: options.maxConcurrentLoads,
        checkpointDir: options.checkpointDir,
        maxBufferMemory: options.maxBufferMemory,
        tablePrefix: options.tablePrefix,
        streamLoadStrategies: options.streamLoadStrategy,
        streamSchemaBehaviors: options.streamSchemaBehavior,
        streamTables: options.streamTable,
      });
    case 'bigquery':
      return resolveNestedPlaceholders({
        dest,
        projectId: options.projectId,
        datasetId: options.datasetId,
        location: options.location,
        keyFilename: options.keyFilename,
        accessToken: options.bqAccessToken,
        tokenCommand: options.bqTokenCommand,
        loadStrategy: options.loadStrategy,
        schemaBehavior: options.schemaBehavior,
        bufferSize: options.bufferSize,
        logFormat: options.logFormat,
        targetFileSizeMb: options.targetFileSize,
        stagingFormat: options.stagingFormat,
        gcsStagingBucket: options.gcsStagingBucket,
        gcsStagingPrefix: options.gcsStagingPrefix,
        maxConcurrentLoads: options.maxConcurrentLoads,
        checkpointDir: options.checkpointDir,
        maxBufferMemory: options.maxBufferMemory,
        metricsFile: options.metricsFile,
        maxLoadJobs: options.maxLoadJobs,
        tablePrefix: options.tablePrefix,
        streamLoadStrategies: options.streamLoadStrategy,
        streamSchemaBehaviors: options.streamSchemaBehavior,
        streamTables: options.streamTable,
        streamTableOwnershipMarkers: options.streamTableOwnershipMarker,
      });
    case 'snowflake':
      return resolveNestedPlaceholders({
        dest,
        account: options.sfAccount,
        username: options.sfUsername,
        password: options.sfPassword,
        privateKeyPath: options.sfPrivateKeyPath,
        privateKeyPassphrase: options.sfPrivateKeyPassphrase,
        accessToken: options.sfAccessToken,
        tokenCommand: options.sfTokenCommand,
        workloadIdentityToken: options.sfWorkloadIdentityToken,
        warehouse: options.sfWarehouse,
        database: options.sfDatabase,
        targetSchema: options.targetSchema,
        role: options.sfRole,
        loadStrategy: options.loadStrategy,
        schemaBehavior: options.schemaBehavior,
        bufferSize: options.bufferSize,
        logFormat: options.logFormat,
        maxConcurrentLoads: options.maxConcurrentLoads,
        checkpointDir: options.checkpointDir,
        maxBufferMemory: options.maxBufferMemory,
        tablePrefix: options.tablePrefix,
        streamLoadStrategies: options.streamLoadStrategy,
        streamSchemaBehaviors: options.streamSchemaBehavior,
        streamTables: options.streamTable,
        streamTableOwnershipMarkers: options.streamTableOwnershipMarker,
        ...(reconcileSchema && reconcileSchema.length > 0 ? { reconcileSchema } : {}),
      });
    case 'postgres':
      return resolveNestedPlaceholders({
        dest,
        host: options.postgresHost,
        port: options.postgresPort,
        database: options.postgresDatabase,
        schema: options.postgresSchema,
        username: options.postgresUser,
        password: options.postgresPassword,
        ssl: options.postgresSsl,
        loadStrategy: options.loadStrategy,
        schemaBehavior: options.schemaBehavior,
        bufferSize: options.bufferSize,
        logFormat: options.logFormat,
        maxConcurrentLoads: options.maxConcurrentLoads,
        checkpointDir: options.checkpointDir,
        maxBufferMemory: options.maxBufferMemory,
        tablePrefix: options.tablePrefix,
        streamLoadStrategies: options.streamLoadStrategy,
        streamSchemaBehaviors: options.streamSchemaBehavior,
        streamTables: options.streamTable,
        streamTableOwnershipMarkers: options.streamTableOwnershipMarker,
      });
    case 'mysql':
      return resolveNestedPlaceholders({
        dest,
        host: options.mysqlHost,
        port: options.mysqlPort,
        database: options.mysqlDatabase,
        user: options.mysqlUser,
        password: options.mysqlPassword,
        ssl: options.mysqlSsl,
        loadStrategy: options.loadStrategy,
        schemaBehavior: options.schemaBehavior,
        bufferSize: options.bufferSize,
        logFormat: options.logFormat,
        maxConcurrentLoads: options.maxConcurrentLoads,
        checkpointDir: options.checkpointDir,
        maxBufferMemory: options.maxBufferMemory,
        tablePrefix: options.tablePrefix,
        streamLoadStrategies: options.streamLoadStrategy,
        streamSchemaBehaviors: options.streamSchemaBehavior,
        streamTables: options.streamTable,
      });
    case 'databricks':
      return resolveNestedPlaceholders({
        dest,
        serverHostname: options.databricksHost,
        httpPath: options.databricksHttpPath,
        accessToken: options.databricksToken,
        oauthClientId: options.databricksOauthClientId,
        oauthClientSecret: options.databricksOauthClientSecret,
        catalog: options.databricksCatalog,
        schema: options.databricksSchema,
        loadStrategy: options.loadStrategy,
        schemaBehavior: options.schemaBehavior,
        bufferSize: options.bufferSize,
        logFormat: options.logFormat,
        maxConcurrentLoads: options.maxConcurrentLoads,
        checkpointDir: options.checkpointDir,
        maxBufferMemory: options.maxBufferMemory,
        tablePrefix: options.tablePrefix,
        streamLoadStrategies: options.streamLoadStrategy,
        streamSchemaBehaviors: options.streamSchemaBehavior,
        streamTables: options.streamTable,
        streamTableOwnershipMarkers: options.streamTableOwnershipMarker,
      });
    case 'sqlite':
      return resolveNestedPlaceholders({
        dest,
        dbPath: options.dbPath,
        targetSchema: options.targetSchema,
        loadStrategy: options.loadStrategy,
        schemaBehavior: options.schemaBehavior,
        bufferSize: options.bufferSize,
        logFormat: options.logFormat,
        maxConcurrentLoads: options.maxConcurrentLoads,
        checkpointDir: options.checkpointDir,
        maxBufferMemory: options.maxBufferMemory,
        tablePrefix: options.tablePrefix,
        streamLoadStrategies: options.streamLoadStrategy,
        streamSchemaBehaviors: options.streamSchemaBehavior,
        streamTables: options.streamTable,
      });
    case 'gcs':
      return {
        ...resolveNestedPlaceholders({
          dest,
          format: options.format,
          outputDir: options.outputDir,
          gcsBucket: options.gcsBucket,
          gcsPrefix: options.gcsPrefix,
          streamSubfolder: options.streamSubfolder,
          bufferSize: options.bufferSize,
          logFormat: options.logFormat,
        }),
        objectMetadata: parseObjectMetadataOption(options.objectMetadata),
      };
    case 's3':
      return {
        ...resolveNestedPlaceholders({
          dest,
          format: options.format,
          outputDir: options.outputDir,
          s3Bucket: options.s3Bucket,
          s3Prefix: options.s3Prefix,
          s3Region: options.s3Region,
          s3RoleArn: options.s3RoleArn,
          s3ExternalId: options.s3ExternalId,
          streamSubfolder: options.streamSubfolder,
          bufferSize: options.bufferSize,
          logFormat: options.logFormat,
        }),
        objectMetadata: parseObjectMetadataOption(options.objectMetadata),
      };
    case 'clickhouse':
      return resolveNestedPlaceholders({
        dest,
        host: options.clickhouseHost,
        port: options.clickhousePort,
        database: options.clickhouseDatabase,
        username: options.clickhouseUsername,
        password: options.clickhousePassword,
        ssl: options.clickhouseSsl,
        vectorIndex: options.clickhouseVectorIndex,
        loadStrategy: options.loadStrategy,
        schemaBehavior: options.schemaBehavior,
        bufferSize: options.bufferSize,
        logFormat: options.logFormat,
        maxConcurrentLoads: options.maxConcurrentLoads,
        checkpointDir: options.checkpointDir,
        maxBufferMemory: options.maxBufferMemory,
        tablePrefix: options.tablePrefix,
        streamLoadStrategies: options.streamLoadStrategy,
        streamSchemaBehaviors: options.streamSchemaBehavior,
        streamTables: options.streamTable,
      });
    case 'turbopuffer':
      return resolveNestedPlaceholders({
        dest,
        apiKey: options.turbopufferApiKey,
        region: options.turbopufferRegion,
        namespacePrefix: options.turbopufferNamespacePrefix,
        distanceMetric: options.turbopufferDistanceMetric,
        fullTextColumns: parseStringListOption(options.turbopufferFullTextColumns),
        vectorDimension: options.vectorDimension,
        vectorColumns: parseStringListOption(options.vectorColumns),
        loadStrategy: options.loadStrategy,
        schemaBehavior: options.schemaBehavior,
        bufferSize: options.bufferSize,
        logFormat: options.logFormat,
        maxConcurrentLoads: options.maxConcurrentLoads,
        checkpointDir: options.checkpointDir,
        maxBufferMemory: options.maxBufferMemory,
        tablePrefix: options.tablePrefix,
        streamLoadStrategies: options.streamLoadStrategy,
        streamSchemaBehaviors: options.streamSchemaBehavior,
        streamTables: options.streamTable,
      });
    case 'elasticsearch':
      return resolveNestedPlaceholders({
        dest,
        host: options.elasticsearchHost,
        port: options.elasticsearchPort,
        index: options.elasticsearchIndex,
        apiKey: options.elasticsearchApiKey,
        username: options.elasticsearchUsername,
        password: options.elasticsearchPassword,
        ssl: options.elasticsearchSsl,
        vectorDimension: options.elasticsearchVectorDimension,
        vectorColumns: options.vectorColumns,
        loadStrategy: options.loadStrategy,
        schemaBehavior: options.schemaBehavior,
        bufferSize: options.bufferSize,
        logFormat: options.logFormat,
        maxConcurrentLoads: options.maxConcurrentLoads,
        checkpointDir: options.checkpointDir,
        maxBufferMemory: options.maxBufferMemory,
        tablePrefix: options.tablePrefix,
        streamLoadStrategies: options.streamLoadStrategy,
        streamSchemaBehaviors: options.streamSchemaBehavior,
        streamTables: options.streamTable,
      });
    case 'chroma':
      return resolveNestedPlaceholders({
        dest,
        host: options.chromaHost,
        port: options.chromaPort,
        tenant: options.chromaTenant,
        database: options.chromaDatabase,
        loadStrategy: options.loadStrategy,
        schemaBehavior: options.schemaBehavior,
        bufferSize: options.bufferSize,
        logFormat: options.logFormat,
        maxConcurrentLoads: options.maxConcurrentLoads,
        checkpointDir: options.checkpointDir,
        maxBufferMemory: options.maxBufferMemory,
        tablePrefix: options.tablePrefix,
        streamLoadStrategies: options.streamLoadStrategy,
        streamSchemaBehaviors: options.streamSchemaBehavior,
        streamTables: options.streamTable,
      });
    case 'pgvector':
      return resolveNestedPlaceholders({
        dest,
        host: options.pgvectorHost,
        port: options.pgvectorPort,
        database: options.pgvectorDatabase,
        schema: options.pgvectorSchema,
        username: options.pgvectorUser,
        password: options.pgvectorPassword,
        ssl: options.pgvectorSsl,
        loadStrategy: options.loadStrategy,
        schemaBehavior: options.schemaBehavior,
        bufferSize: options.bufferSize,
        logFormat: options.logFormat,
        maxConcurrentLoads: options.maxConcurrentLoads,
        checkpointDir: options.checkpointDir,
        maxBufferMemory: options.maxBufferMemory,
        tablePrefix: options.tablePrefix,
        streamLoadStrategies: options.streamLoadStrategy,
        streamSchemaBehaviors: options.streamSchemaBehavior,
        streamTables: options.streamTable,
        vectorDimension: options.vectorDimension,
        vectorColumns: parseStringListOption(options.vectorColumns),
      });
    case 'local':
      return resolveNestedPlaceholders({
        dest,
        format: options.format,
        outputDir: options.outputDir,
        streamSubfolder: options.streamSubfolder,
        bufferSize: options.bufferSize,
        logFormat: options.logFormat,
      });
    default:
      return resolveNestedPlaceholders({
        dest,
        format: options.format,
        outputDir: options.outputDir,
        bufferSize: options.bufferSize,
        logFormat: options.logFormat,
      });
  }
}

/** Resolve `$VAR` and `${{ env.VAR }}` option values the same way `load run` does. */
export function resolveOptionPlaceholders(
  options: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(options).map(([key, value]) => [
      key,
      typeof value === 'string' ? resolveEnvPlaceholder(value, optionFlag(key)) : value,
    ])
  );
}

function optionFlag(key: string): string {
  return `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}
