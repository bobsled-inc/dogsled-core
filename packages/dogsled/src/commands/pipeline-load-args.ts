import { protectLoaderArgs, loaderSecretEnv } from '../runner/commands/loader-secrets.js';
import { CommandError, parseEnvPlaceholder } from '@bobsled-inc/protocol';

import type { NamedDestination } from '../runner/config/schema.js';
import {
  buildDestinationCliArgs,
  buildDestinationCliEnv,
  buildStreamOverrideCliArgs,
  SNOWFLAKE_ACCESS_TOKEN_ENV,
  SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN_ENV,
  validateSnowflakePipelineAuth,
  validateSnowflakeWorkloadIdentityToken,
} from '../runner/commands/destination-args.js';
import { resolveEnvPlaceholder } from '../runner/commands/env-placeholders.js';
import type { PipelineOptions } from './pipeline.js';

export interface PreparedPipelineWorkloadIdentity {
  childEnv: NodeJS.ProcessEnv;
  redactionTokens: string[];
}

function resolveWorkloadIdentityToken(value: string, env: NodeJS.ProcessEnv): string {
  if (value.startsWith('$') && !parseEnvPlaceholder(value)) {
    throw new CommandError(
      'Snowflake workload identity token has an invalid environment variable reference.',
      2
    );
  }
  return resolveEnvPlaceholder(value, env);
}

function appendReconcileSchemaArgs(
  args: string[],
  destinationType: string,
  streams: readonly string[] | undefined
): void {
  if (!streams || streams.length === 0) return;
  if (destinationType !== 'snowflake') {
    throw new CommandError('--reconcile-schema is only supported for Snowflake destinations.', 2);
  }
  args.push('--reconcile-schema', ...streams);
}

export function preparePipelineWorkloadIdentity(
  options: PipelineOptions,
  destinations: readonly NamedDestination[] | undefined,
  runtimeEnv: NodeJS.ProcessEnv
): PreparedPipelineWorkloadIdentity {
  if (options.sfWorkloadIdentityToken !== undefined) {
    if (destinations?.length) {
      throw new CommandError(
        'Snowflake workload identity token cannot be configured directly with named destinations. Configure workload identity credentials on the named Snowflake destination.',
        2
      );
    }
    if ((options.dest ?? 'local') !== 'snowflake') {
      throw new CommandError(
        'Snowflake workload identity token requires a Snowflake destination.',
        2
      );
    }
  }

  validateSnowflakePipelineAuth({
    workloadIdentityToken: options.sfWorkloadIdentityToken,
    password: options.sfPassword,
    privateKeyPath: options.sfPrivateKeyPath,
    privateKeyPassphrase: options.sfPrivateKeyPassphrase,
    accessToken: options.sfAccessToken,
    tokenCommand: options.sfTokenCommand,
  });
  for (const destination of destinations ?? []) {
    if (destination.type !== 'snowflake') continue;
    validateSnowflakePipelineAuth({
      workloadIdentityToken: destination.credentials_workload_identity_token,
      password: destination.password,
      privateKeyPath: destination.private_key_path,
      privateKeyPassphrase: destination.private_key_passphrase,
      accessToken: destination.credentials_access_token,
      tokenCommand: destination.credentials_token_command,
    });
  }

  const configuredTokens = [
    options.sfWorkloadIdentityToken,
    ...(destinations ?? []).map((destination) =>
      destination.type === 'snowflake' ? destination.credentials_workload_identity_token : undefined
    ),
  ].filter((token): token is string => token !== undefined);
  const sourceEnvNames = [
    ...(options.workloadIdentitySourceEnvNames ?? []),
    ...getWorkloadIdentitySourceEnvNames(configuredTokens),
  ];
  const resolvedTokens = configuredTokens.map((token) =>
    resolveWorkloadIdentityToken(token, runtimeEnv)
  );
  for (const token of resolvedTokens) {
    validateSnowflakeWorkloadIdentityToken(token);
  }

  return {
    childEnv: buildWorkloadIdentityChildEnv(runtimeEnv, sourceEnvNames, resolvedTokens),
    redactionTokens: [...configuredTokens, ...resolvedTokens],
  };
}

export function buildLoadArgsForDestination(
  destination: NamedDestination,
  options: PipelineOptions,
  env: NodeJS.ProcessEnv
): string[] {
  const args = [
    'run',
    '--output-dir',
    options.outputDir,
    ...buildDestinationCliArgs(destination, {
      // An invocation-level full refresh is authoritative for every fan-out
      // destination. Reconciliation relies on the loader seeing the same
      // full_refresh strategy that the extractor used for this run.
      loadStrategy: options.fullRefresh
        ? 'full_refresh'
        : (options.loadStrategy ?? destination.load_strategy),
      schemaBehavior: options.schemaBehavior ?? destination.schema_behavior,
      tablePrefix: destination.table_prefix ?? options.tablePrefix,
      // Per-resource overrides are resource-scoped, not destination-scoped, so
      // every fan-out destination gets the same per-stream maps. They win over
      // the destination-level (or pipeline-level) `--load-strategy` default and
      // over `--table-prefix` for the named streams only.
      ...(options.resourceLoadStrategy
        ? { streamLoadStrategies: options.resourceLoadStrategy }
        : {}),
      ...(options.resourceSchemaBehavior
        ? { streamSchemaBehaviors: options.resourceSchemaBehavior }
        : {}),
      ...(options.resourceTable ? { streamTables: options.resourceTable } : {}),
      ...(options.resourceTableOwnershipMarker
        ? { streamTableOwnershipMarkers: options.resourceTableOwnershipMarker }
        : {}),
      ...(destination.type === 'snowflake' &&
      destination.credentials_access_token &&
      !destination.credentials_token_command
        ? { snowflakeAccessTokenEnv: SNOWFLAKE_ACCESS_TOKEN_ENV }
        : {}),
      valueResolver: (value) => resolveEnvPlaceholder(value, env),
    }),
  ];

  if (options.bufferSize) {
    args.push('--buffer-size', String(options.bufferSize));
  }

  appendReconcileSchemaArgs(args, destination.type, options.reconcileSchema);
  if (destination.type === 'snowflake' && options.queryTag !== undefined) {
    args.push('--query-tag', options.queryTag);
  }
  args.push('--log-format', 'json');

  return args;
}

function buildRawLoadArgs(options: PipelineOptions): string[] {
  const destination = options.dest ?? 'local';
  const args = ['run', '--output-dir', options.outputDir];

  if (destination === 'snowflake') {
    validateSnowflakePipelineAuth({
      workloadIdentityToken: options.sfWorkloadIdentityToken,
      password: options.sfPassword,
      privateKeyPath: options.sfPrivateKeyPath,
      privateKeyPassphrase: options.sfPrivateKeyPassphrase,
      accessToken: options.sfAccessToken,
      tokenCommand: options.sfTokenCommand,
    });
  }

  if (destination === 'local' || destination === 'gcs' || destination === 's3') {
    if (!options.format) {
      throw new CommandError(
        'The --format option is required for local, gcs, and s3 destinations.'
      );
    }

    args.push('--format', options.format);
  }
  if (destination === 'gcs' && !options.gcsBucket) {
    throw new CommandError('The --gcs-bucket option is required when --dest is gcs.');
  }
  if (destination === 's3' && !options.s3Bucket) {
    throw new CommandError('The --s3-bucket option is required when --dest is s3.');
  }
  if (options.dest) {
    args.push('--dest', options.dest);
  }
  if (options.gcsBucket) {
    args.push('--gcs-bucket', options.gcsBucket);
  }
  if (options.gcsPrefix) {
    args.push('--gcs-prefix', options.gcsPrefix);
  }
  if (options.s3Bucket) {
    args.push('--s3-bucket', options.s3Bucket);
  }
  if (options.s3Prefix) {
    args.push('--s3-prefix', options.s3Prefix);
  }
  if (options.bufferSize) {
    args.push('--buffer-size', String(options.bufferSize));
  }
  if (options.dbPath) {
    args.push('--db-path', options.dbPath);
  }
  if (options.targetSchema) {
    args.push('--target-schema', options.targetSchema);
  }
  if (options.projectId) {
    args.push('--project-id', options.projectId);
  }
  if (options.datasetId) {
    args.push('--dataset-id', options.datasetId);
  }
  if (options.databricksHost) args.push('--databricks-host', options.databricksHost);
  if (options.databricksHttpPath) args.push('--databricks-http-path', options.databricksHttpPath);
  if (options.databricksCatalog) args.push('--databricks-catalog', options.databricksCatalog);
  if (options.databricksSchema) args.push('--databricks-schema', options.databricksSchema);
  if (options.databricksToken) args.push('--databricks-token', options.databricksToken);
  if (options.databricksOauthClientId) {
    args.push('--databricks-oauth-client-id', options.databricksOauthClientId);
  }
  if (options.databricksOauthClientSecret) {
    args.push('--databricks-oauth-client-secret', options.databricksOauthClientSecret);
  }
  if (options.location) {
    args.push('--location', options.location);
  }
  if (options.keyFilename) {
    args.push('--key-filename', options.keyFilename);
  }
  if (options.bqTokenCommand) {
    // Refreshable token command; refreshes mid-load. Takes precedence over a
    // static access token — emit only one of the two flags.
    args.push('--bq-token-command', options.bqTokenCommand);
  } else if (options.bqAccessToken) {
    // Pre-minted OAuth token; takes precedence over keyFilename.
    args.push('--bq-access-token', options.bqAccessToken);
  }
  if (options.sfAccount) {
    args.push('--sf-account', options.sfAccount);
  }
  if (options.sfUsername) {
    args.push('--sf-username', options.sfUsername);
  }
  if (options.sfPassword) {
    args.push('--sf-password', options.sfPassword);
  }
  if (options.sfPrivateKeyPath) {
    args.push('--sf-private-key-path', options.sfPrivateKeyPath);
  }
  if (options.sfPrivateKeyPassphrase) {
    args.push('--sf-private-key-passphrase', options.sfPrivateKeyPassphrase);
  }
  if (options.sfWorkloadIdentityToken !== undefined) {
    // The resolved workload identity token is supplied only through the
    // loader child environment; argv contains a stable placeholder.
    args.push('--sf-workload-identity-token', '$' + SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN_ENV);
  } else if (options.sfTokenCommand) {
    args.push('--sf-token-command', options.sfTokenCommand);
  } else if (options.sfAccessToken) {
    // The loader resolves this placeholder from its child environment, keeping
    // the JWT out of process argv and therefore out of ps/process inspection.
    args.push('--sf-access-token', `$${SNOWFLAKE_ACCESS_TOKEN_ENV}`);
  }
  if (options.sfWarehouse) {
    args.push('--sf-warehouse', options.sfWarehouse);
  }
  if (destination === 'snowflake' && options.queryTag !== undefined) {
    args.push('--query-tag', options.queryTag);
  }
  if (options.sfDatabase) {
    args.push('--sf-database', options.sfDatabase);
  }
  if (options.sfRole) {
    args.push('--sf-role', options.sfRole);
  }
  if (options.postgresHost) {
    args.push('--postgres-host', options.postgresHost);
  }
  if (options.postgresPort) {
    args.push('--postgres-port', String(options.postgresPort));
  }
  if (options.postgresDatabase) {
    args.push('--postgres-database', options.postgresDatabase);
  }
  if (options.postgresSchema) {
    args.push('--postgres-schema', options.postgresSchema);
  }
  if (options.postgresUser) {
    args.push('--postgres-user', options.postgresUser);
  }
  if (options.postgresPassword) {
    args.push('--postgres-password', options.postgresPassword);
  }
  if (options.postgresSsl) {
    args.push('--postgres-ssl');
  }
  if (options.mysqlHost) {
    args.push('--mysql-host', options.mysqlHost);
  }
  if (options.mysqlPort) {
    args.push('--mysql-port', String(options.mysqlPort));
  }
  if (options.mysqlDatabase) {
    args.push('--mysql-database', options.mysqlDatabase);
  }
  if (options.mysqlUser) {
    args.push('--mysql-user', options.mysqlUser);
  }
  if (options.mysqlPassword) {
    args.push('--mysql-password', options.mysqlPassword);
  }
  if (options.mysqlSsl) {
    args.push('--mysql-ssl');
  }
  if (options.clickhouseHost) {
    args.push('--clickhouse-host', options.clickhouseHost);
  }
  if (options.clickhousePort) {
    args.push('--clickhouse-port', String(options.clickhousePort));
  }
  if (options.clickhouseDatabase) {
    args.push('--clickhouse-database', options.clickhouseDatabase);
  }
  if (options.clickhouseUsername) {
    args.push('--clickhouse-username', options.clickhouseUsername);
  }
  if (options.clickhousePassword) {
    args.push('--clickhouse-password', options.clickhousePassword);
  }
  if (options.clickhouseSsl) {
    args.push('--clickhouse-ssl');
  }
  if (options.clickhouseVectorIndex) {
    args.push('--clickhouse-vector-index');
  }
  if (options.turbopufferApiKey) {
    args.push('--turbopuffer-api-key', options.turbopufferApiKey);
  }
  if (options.turbopufferRegion) {
    args.push('--turbopuffer-region', options.turbopufferRegion);
  }
  if (options.turbopufferNamespacePrefix) {
    args.push('--turbopuffer-namespace-prefix', options.turbopufferNamespacePrefix);
  }
  if (options.turbopufferDistanceMetric) {
    args.push('--turbopuffer-distance-metric', options.turbopufferDistanceMetric);
  }
  if (options.turbopufferFullTextColumns) {
    args.push('--turbopuffer-full-text-columns', options.turbopufferFullTextColumns);
  }
  if (options.loadStrategy) {
    args.push('--load-strategy', options.loadStrategy);
  }
  if (options.schemaBehavior) {
    args.push('--schema-behavior', options.schemaBehavior);
  }
  if (options.tablePrefix) {
    args.push('--table-prefix', options.tablePrefix);
  }
  args.push(
    ...buildStreamOverrideCliArgs({
      ...(options.resourceLoadStrategy
        ? { streamLoadStrategies: options.resourceLoadStrategy }
        : {}),
      ...(options.resourceSchemaBehavior
        ? { streamSchemaBehaviors: options.resourceSchemaBehavior }
        : {}),
      ...(options.resourceTable ? { streamTables: options.resourceTable } : {}),
      ...(options.resourceTableOwnershipMarker
        ? { streamTableOwnershipMarkers: options.resourceTableOwnershipMarker }
        : {}),
    })
  );
  appendReconcileSchemaArgs(args, destination, options.reconcileSchema);
  args.push('--log-format', 'json');

  return args;
}

export function buildSnowflakeLoadEnv(
  env: NodeJS.ProcessEnv,
  accessToken: string | undefined,
  tokenCommand: string | undefined,
  workloadIdentityToken?: string,
  resolutionEnv: NodeJS.ProcessEnv = env
): NodeJS.ProcessEnv {
  const resolvedWorkloadIdentityToken =
    workloadIdentityToken === undefined
      ? undefined
      : resolveEnvPlaceholder(workloadIdentityToken, resolutionEnv);
  const childEnv = buildWorkloadIdentityChildEnv(
    env,
    getWorkloadIdentitySourceEnvNames([workloadIdentityToken]),
    resolvedWorkloadIdentityToken === undefined ? [] : [resolvedWorkloadIdentityToken]
  );
  if (workloadIdentityToken !== undefined) {
    return {
      ...childEnv,
      [SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN_ENV]: resolvedWorkloadIdentityToken,
    };
  }
  if (!accessToken || tokenCommand) return childEnv;
  return {
    ...childEnv,
    [SNOWFLAKE_ACCESS_TOKEN_ENV]: resolveEnvPlaceholder(accessToken, resolutionEnv),
  };
}

export function buildSnowflakeDestinationLoadEnv(
  env: NodeJS.ProcessEnv,
  destination: NamedDestination,
  resolutionEnv: NodeJS.ProcessEnv = env
): NodeJS.ProcessEnv {
  if (destination.type !== 'snowflake') {
    return buildWorkloadIdentityChildEnv(env, []);
  }
  if (destination.credentials_workload_identity_token !== undefined) {
    return buildSnowflakeLoadEnv(
      env,
      undefined,
      undefined,
      destination.credentials_workload_identity_token,
      resolutionEnv
    );
  }
  if (!destination.credentials_access_token || destination.credentials_token_command) {
    return buildWorkloadIdentityChildEnv(env, []);
  }
  return buildSnowflakeLoadEnv(
    env,
    destination.credentials_access_token,
    undefined,
    undefined,
    resolutionEnv
  );
}

export function getWorkloadIdentitySourceEnvNames(tokens: Iterable<string | undefined>): string[] {
  const names = new Set<string>();
  for (const token of tokens) {
    if (!token?.startsWith('$')) continue;
    const name = parseEnvPlaceholder(token);
    if (name) names.add(name);
  }
  return [...names];
}

export function buildWorkloadIdentityChildEnv(
  env: NodeJS.ProcessEnv,
  sourceEnvNames: Iterable<string>,
  resolvedWorkloadIdentityTokens: Iterable<string> = []
): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  delete childEnv[SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN_ENV];
  const tokenValues = new Set(resolvedWorkloadIdentityTokens);
  const sourceNames = new Set(sourceEnvNames);
  for (const [name, value] of Object.entries(childEnv)) {
    if (sourceNames.has(name) || (value !== undefined && tokenValues.has(value))) {
      delete childEnv[name];
    }
  }
  return childEnv;
}

export function buildLoadArgs(options: PipelineOptions): string[] {
  return protectLoaderArgs(buildRawLoadArgs(options));
}

export function buildLoadEnv(
  env: NodeJS.ProcessEnv,
  options: PipelineOptions,
  resolutionEnv = env
): NodeJS.ProcessEnv {
  return loaderSecretEnv(
    buildSnowflakeLoadEnv(
      env,
      options.sfAccessToken,
      options.sfTokenCommand,
      options.sfWorkloadIdentityToken,
      resolutionEnv
    ),
    buildRawLoadArgs(options),
    resolutionEnv
  );
}

export function buildDestinationLoadEnv(
  env: NodeJS.ProcessEnv,
  destination: NamedDestination,
  resolutionEnv = env
): NodeJS.ProcessEnv {
  return buildDestinationCliEnv(
    buildSnowflakeDestinationLoadEnv(env, destination, resolutionEnv),
    destination,
    resolutionEnv
  );
}
