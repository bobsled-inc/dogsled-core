import { assertDeclaredEnvironmentReferences } from '@bobsled-inc/protocol';
import { protectLoaderArgs, loaderSecretEnv } from './loader-secrets.js';
import { CommandError, parseEnvPlaceholder } from '@bobsled-inc/protocol';

import type { DestinationConfig, NamedDestination } from '../config/schema.js';

export const SNOWFLAKE_ACCESS_TOKEN_ENV = 'DOGSLED_SNOWFLAKE_ACCESS_TOKEN';
export const SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN_ENV = 'DOGSLED_SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN';
export const MANAGED_DESTINATION_CORE_ERROR =
  'A "dogsled_managed" destination only runs in Dogsled Cloud. To run this pipeline with Dogsled Core, replace it with a concrete destination type such as "duckdb" or "bigquery".';

export interface SnowflakePipelineAuthOptions {
  workloadIdentityToken?: string;
  password?: string;
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
  accessToken?: string;
  tokenCommand?: string;
}

export function parseSnowflakeWorkloadIdentityToken(value: string): string {
  if (!parseEnvPlaceholder(value)) {
    throw new CommandError(
      'Snowflake workload identity token must be an environment variable reference.',
      2
    );
  }
  return value;
}

export function validateSnowflakeWorkloadIdentityToken(token: string | undefined): void {
  if (token !== undefined && token.trim().length === 0) {
    throw new CommandError('Snowflake workload identity token must be non-empty.', 2);
  }
}

export function validateSnowflakePipelineAuth(options: SnowflakePipelineAuthOptions): void {
  if (options.workloadIdentityToken === undefined) {
    return;
  }
  validateSnowflakeWorkloadIdentityToken(options.workloadIdentityToken);

  const conflicts: string[] = [];
  if (options.password !== undefined) conflicts.push('password');
  if (options.privateKeyPath !== undefined || options.privateKeyPassphrase !== undefined) {
    conflicts.push('private key fields');
  }
  if (options.tokenCommand !== undefined) conflicts.push('token command');
  if (options.accessToken !== undefined) conflicts.push('access token');

  if (conflicts.length > 0) {
    throw new CommandError(
      `Snowflake workload identity token cannot be combined with ${conflicts.join(', ')}.`
    );
  }
}

export interface DestinationCliArgOptions {
  loadStrategy?: string;
  schemaBehavior?: string;
  tablePrefix?: string;
  /** Per-stream load strategies (resolved resource name → strategy). */
  streamLoadStrategies?: Record<string, string>;
  /** Per-stream schema behaviors (resolved resource name → behavior). */
  streamSchemaBehaviors?: Record<string, string>;
  /** Per-stream destination table names (resolved resource name → table). */
  streamTables?: Record<string, string>;
  streamTableOwnershipMarkers?: Record<string, string>;
  /** Child-process env var used instead of placing a Snowflake JWT in argv. */
  snowflakeAccessTokenEnv?: string;
  valueResolver?: (value: string) => string;
}

/**
 * Emit the loader's repeatable per-stream override flags.
 *
 * These use the colon-delimited `<stream>:<value>` shape (same as the
 * extractor's `--resource-via`): load strategies and schema behaviors are
 * closed enums and table names must be plain SQL identifiers, so none of these
 * values can contain a colon.
 * Keys are sorted so the emitted argv is deterministic.
 */
export function buildStreamOverrideCliArgs(options: {
  streamLoadStrategies?: Record<string, string>;
  streamSchemaBehaviors?: Record<string, string>;
  streamTables?: Record<string, string>;
  streamTableOwnershipMarkers?: Record<string, string>;
}): string[] {
  const args: string[] = [];
  const strategies = options.streamLoadStrategies ?? {};
  for (const stream of Object.keys(strategies).sort()) {
    args.push('--stream-load-strategy', `${stream}:${strategies[stream]}`);
  }
  const schemaBehaviors = options.streamSchemaBehaviors ?? {};
  for (const stream of Object.keys(schemaBehaviors).sort()) {
    args.push('--stream-schema-behavior', `${stream}:${schemaBehaviors[stream]}`);
  }
  const tables = options.streamTables ?? {};
  for (const stream of Object.keys(tables).sort()) {
    args.push('--stream-table', `${stream}:${tables[stream]}`);
  }
  const markers = options.streamTableOwnershipMarkers ?? {};
  for (const stream of Object.keys(markers).sort()) {
    args.push('--stream-table-ownership-marker', `${stream}:${markers[stream]}`);
  }
  return args;
}

type DestinationLike = DestinationConfig | NamedDestination;

function buildFileDestinationCliArgs(
  destination: { stream_subfolder?: string | undefined; utc_timestamps?: boolean | undefined },
  resolveValue: (value: string) => string
): string[] {
  const args: string[] = [];
  if (destination.stream_subfolder) {
    args.push('--stream-subfolder', resolveValue(destination.stream_subfolder));
  }
  if (destination.utc_timestamps === true) {
    args.push('--utc-timestamps');
  }
  return args;
}

export function serializeDestinationsJson(destinations: NamedDestination[]): string {
  return JSON.stringify(destinations);
}

function buildRawDestinationCliArgs(
  destination: DestinationLike,
  options: DestinationCliArgOptions = {}
): string[] {
  assertDeclaredEnvironmentReferences(destination, destination.auth_env_vars);
  const args = ['--dest', destination.type];
  const resolveValue = options.valueResolver ?? ((value: string) => value);

  switch (destination.type) {
    case 'duckdb':
      args.push('--db-path', resolveValue(destination.db_path));
      if (destination.schema) {
        args.push('--target-schema', resolveValue(destination.schema));
      }
      break;
    case 'bigquery':
      args.push('--project-id', resolveValue(destination.project));
      args.push('--dataset-id', resolveValue(destination.dataset));
      if (destination.location) {
        args.push('--location', resolveValue(destination.location));
      }
      if (destination.credentials_token_command) {
        // Refreshable token: the loader runs this command per fetch and
        // refreshes mid-load. Takes precedence over a static access token —
        // emit only one of the two flags.
        args.push('--bq-token-command', resolveValue(destination.credentials_token_command));
      } else if (destination.credentials_access_token) {
        // Pre-minted short-lived OAuth access token. Mirrors
        // dbt-bigquery's `oauth-secrets` Temporary Token method —
        // bypasses ADC / keyFilename and goes straight to
        // `new BigQuery({ token })` in the loader.
        args.push('--bq-access-token', resolveValue(destination.credentials_access_token));
      }
      break;
    case 'databricks':
      args.push('--databricks-host', resolveValue(destination.server_hostname));
      args.push('--databricks-http-path', resolveValue(destination.http_path));
      args.push('--databricks-catalog', resolveValue(destination.catalog));
      args.push('--databricks-schema', resolveValue(destination.schema));
      if (destination.credentials_access_token) {
        args.push('--databricks-token', destination.credentials_access_token);
      }
      if (destination.oauth_client_id) {
        args.push('--databricks-oauth-client-id', resolveValue(destination.oauth_client_id));
      }
      if (destination.oauth_client_secret) {
        args.push('--databricks-oauth-client-secret', destination.oauth_client_secret);
      }
      break;
    case 's3':
      if (destination.format) {
        args.push('--format', resolveValue(destination.format));
      }
      args.push('--s3-bucket', resolveValue(destination.bucket));
      if (destination.prefix) {
        args.push('--s3-prefix', resolveValue(destination.prefix));
      }
      args.push(...buildFileDestinationCliArgs(destination, resolveValue));
      break;
    case 'snowflake':
      validateSnowflakePipelineAuth({
        workloadIdentityToken: destination.credentials_workload_identity_token,
        password: destination.password,
        privateKeyPath: destination.private_key_path,
        privateKeyPassphrase: destination.private_key_passphrase,
        accessToken: destination.credentials_access_token,
        tokenCommand: destination.credentials_token_command,
      });
      args.push('--sf-account', resolveValue(destination.account));
      args.push('--sf-username', resolveValue(destination.username));
      if (destination.password) {
        args.push('--sf-password', resolveValue(destination.password));
      }
      if (destination.private_key_path) {
        args.push('--sf-private-key-path', resolveValue(destination.private_key_path));
      }
      if (destination.private_key_passphrase) {
        args.push('--sf-private-key-passphrase', resolveValue(destination.private_key_passphrase));
      }
      if (destination.credentials_workload_identity_token !== undefined) {
        args.push('--sf-workload-identity-token', '$' + SNOWFLAKE_WORKLOAD_IDENTITY_TOKEN_ENV);
      } else if (destination.credentials_token_command) {
        // Refreshable OIDC token command takes precedence over a static token.
        args.push('--sf-token-command', resolveValue(destination.credentials_token_command));
      } else if (destination.credentials_access_token) {
        args.push(
          '--sf-access-token',
          options.snowflakeAccessTokenEnv
            ? `$${options.snowflakeAccessTokenEnv}`
            : resolveValue(destination.credentials_access_token)
        );
      }
      args.push('--sf-warehouse', resolveValue(destination.warehouse));
      args.push('--sf-database', resolveValue(destination.database));
      if (destination.schema) {
        args.push('--target-schema', resolveValue(destination.schema));
      }
      if (destination.role) {
        args.push('--sf-role', resolveValue(destination.role));
      }
      break;
    case 'postgres':
      args.push('--postgres-host', resolveValue(destination.host));
      if (destination.port) {
        args.push('--postgres-port', String(destination.port));
      }
      args.push('--postgres-database', resolveValue(destination.database));
      if (destination.schema) {
        args.push('--postgres-schema', resolveValue(destination.schema));
      }
      args.push('--postgres-user', resolveValue(destination.username));
      if (destination.password) {
        args.push('--postgres-password', resolveValue(destination.password));
      }
      if (destination.ssl) {
        args.push('--postgres-ssl');
      }
      break;
    case 'mysql':
      args.push('--mysql-host', resolveValue(destination.host));
      if (destination.port) {
        args.push('--mysql-port', String(destination.port));
      }
      args.push('--mysql-database', resolveValue(destination.database));
      args.push('--mysql-user', resolveValue(destination.user));
      if (destination.password) {
        args.push('--mysql-password', resolveValue(destination.password));
      }
      if (destination.ssl) {
        args.push('--mysql-ssl');
      }
      break;
    case 'clickhouse':
      args.push('--clickhouse-host', resolveValue(destination.host));
      if (destination.port) {
        args.push('--clickhouse-port', String(destination.port));
      }
      args.push('--clickhouse-database', resolveValue(destination.database));
      if (destination.username) {
        args.push('--clickhouse-username', resolveValue(destination.username));
      }
      if (destination.password) {
        args.push('--clickhouse-password', resolveValue(destination.password));
      }
      if (destination.ssl) {
        args.push('--clickhouse-ssl');
      }
      if (destination.vector_index) {
        args.push('--clickhouse-vector-index');
      }
      break;
    case 'turbopuffer':
      args.push('--turbopuffer-api-key', resolveValue(destination.api_key));
      if (destination.region) {
        args.push('--turbopuffer-region', resolveValue(destination.region));
      }
      if (destination.namespace_prefix) {
        args.push('--turbopuffer-namespace-prefix', resolveValue(destination.namespace_prefix));
      }
      if (destination.distance_metric) {
        args.push('--turbopuffer-distance-metric', destination.distance_metric);
      }
      if (destination.full_text_columns?.length) {
        args.push('--turbopuffer-full-text-columns', destination.full_text_columns.join(','));
      }
      break;
    case 'local':
      if (destination.format) {
        args.push('--format', resolveValue(destination.format));
      }
      args.push(...buildFileDestinationCliArgs(destination, resolveValue));
      break;
    case 'gcs':
      if (destination.format) {
        args.push('--format', resolveValue(destination.format));
      }
      args.push('--gcs-bucket', resolveValue(destination.bucket));
      if (destination.prefix) {
        args.push('--gcs-prefix', resolveValue(destination.prefix));
      }
      args.push(...buildFileDestinationCliArgs(destination, resolveValue));
      break;
    case 'dogsled_managed':
      // Orchestrator-resolved intent type — must be expanded into a
      // concrete warehouse-native destination block (e.g. bigquery)
      // before reaching CLI args. Reaching this branch means the
      // host application skipped the expansion step;
      // failing loud here is preferable to producing a `--dest
      // dogsled_managed` CLI invocation that would later error in
      // the loader registry with a vaguer "no loader registered"
      // message.
      throw new CommandError(MANAGED_DESTINATION_CORE_ERROR, 2);
    default: {
      const exhaustive: never = destination;
      throw new CommandError(
        `Unsupported destination type: ${(exhaustive as { type: string }).type}`,
        2
      );
    }
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
  args.push(...buildStreamOverrideCliArgs(options));

  return args;
}

export function buildDestinationCliArgs(
  destination: DestinationLike,
  options: DestinationCliArgOptions = {}
): string[] {
  return protectLoaderArgs(buildRawDestinationCliArgs(destination, options));
}

export function buildDestinationCliEnv(
  env: NodeJS.ProcessEnv,
  destination: DestinationLike,
  resolutionEnv = env
): NodeJS.ProcessEnv {
  return loaderSecretEnv(env, buildRawDestinationCliArgs(destination), resolutionEnv);
}
