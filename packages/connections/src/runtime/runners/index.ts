/**
 * Built-in runner registry.
 *
 * The source of truth for "what runners does `@bobsled-inc/connections`
 * ship?" Every `(source_type, auth.type)` combination that a schema accepts
 * should either be listed here or be documented as requiring a
 * `CustomRunnerFactory`.
 *
 * Real adapters ship for DuckDB, Snowflake, BigQuery, Postgres,
 * Databricks, and ClickHouse. `(snowflake, sledhouse_oidc)` is custom-only by design —
 * it is intentionally absent from this registry so that `resolveRunner`
 * falls through to the "no factory registered" path, giving operators
 * an actionable error if they forgot to register the SledHouse custom
 * factory.
 */

import type { IntegrationFile, SourceType } from '../../schemas/integration.js';
import type { RunnerFactoryContext } from '../custom-runner.js';
import { runnerKey } from '../custom-runner.js';
import type { SqlRunnerModule } from '../types.js';

import { buildDuckDbRunner } from './duckdb.js';

type BuiltinRunnerBuilder = (
  integration: IntegrationFile,
  context: RunnerFactoryContext
) => Promise<SqlRunnerModule>;

const BUILTIN_RUNNERS = new Map<string, BuiltinRunnerBuilder>();

// DuckDB — real runner.
BUILTIN_RUNNERS.set(runnerKey('duckdb', 'file'), async (integration) => {
  if (integration.source_type !== 'duckdb') throw new Error('Expected DuckDB integration');
  return buildDuckDbRunner(integration);
});
BUILTIN_RUNNERS.set(runnerKey('duckdb', 'memory'), async (integration) => {
  if (integration.source_type !== 'duckdb') throw new Error('Expected DuckDB integration');
  return buildDuckDbRunner(integration);
});

// Snowflake — real runner (pat, rsa_key, oauth). sledhouse_oidc is custom-only.
// The factory context carries the pipeline-resolved `warehouse` override,
// threaded into the session config (overriding `connection.warehouse`).
// The factory context also carries the refreshable `tokenProvider` (when the
// orchestrator mints short-lived managed credentials), threaded into the
// session so the runner can re-mint + reconnect mid-run.
BUILTIN_RUNNERS.set(runnerKey('snowflake', 'pat'), async (integration, context) => {
  if (integration.source_type !== 'snowflake') throw new Error('Expected Snowflake integration');
  const { buildSnowflakeRunner } = await import('./snowflake.js');
  return buildSnowflakeRunner(integration, {
    warehouse: context.warehouse,
    queryTag: context.queryTag,
    tokenProvider: context.tokenProvider,
  });
});
BUILTIN_RUNNERS.set(runnerKey('snowflake', 'rsa_key'), async (integration, context) => {
  if (integration.source_type !== 'snowflake') throw new Error('Expected Snowflake integration');
  const { buildSnowflakeRunner } = await import('./snowflake.js');
  return buildSnowflakeRunner(integration, {
    warehouse: context.warehouse,
    queryTag: context.queryTag,
    tokenProvider: context.tokenProvider,
  });
});
BUILTIN_RUNNERS.set(runnerKey('snowflake', 'oauth'), async (integration, context) => {
  if (integration.source_type !== 'snowflake') throw new Error('Expected Snowflake integration');
  const { buildSnowflakeRunner } = await import('./snowflake.js');
  return buildSnowflakeRunner(integration, {
    warehouse: context.warehouse,
    queryTag: context.queryTag,
    tokenProvider: context.tokenProvider,
  });
});

// BigQuery — real runner (adc, wif, service_account).
BUILTIN_RUNNERS.set(runnerKey('bigquery', 'adc'), async (integration, context) => {
  if (integration.source_type !== 'bigquery') throw new Error('Expected BigQuery integration');
  const { buildBigQueryRunner } = await import('./bigquery.js');
  return buildBigQueryRunner(integration, { tokenProvider: context.tokenProvider });
});
BUILTIN_RUNNERS.set(runnerKey('bigquery', 'wif'), async (integration, context) => {
  if (integration.source_type !== 'bigquery') throw new Error('Expected BigQuery integration');
  const { buildBigQueryRunner } = await import('./bigquery.js');
  return buildBigQueryRunner(integration, { tokenProvider: context.tokenProvider });
});
BUILTIN_RUNNERS.set(runnerKey('bigquery', 'service_account'), async (integration, context) => {
  if (integration.source_type !== 'bigquery') throw new Error('Expected BigQuery integration');
  const { buildBigQueryRunner } = await import('./bigquery.js');
  return buildBigQueryRunner(integration, { tokenProvider: context.tokenProvider });
});

// Postgres — real runner (password, iam).
BUILTIN_RUNNERS.set(runnerKey('postgres', 'password'), async (integration) => {
  if (integration.source_type !== 'postgres') throw new Error('Expected Postgres integration');
  const { buildPostgresRunner } = await import('./postgres.js');
  return buildPostgresRunner(integration);
});
BUILTIN_RUNNERS.set(runnerKey('postgres', 'iam'), async (integration) => {
  if (integration.source_type !== 'postgres') throw new Error('Expected Postgres integration');
  const { buildPostgresRunner } = await import('./postgres.js');
  return buildPostgresRunner(integration);
});

// ClickHouse — real runner (password). Speaks the HTTP interface, so there is
// no separate auth variant for the native protocol.
BUILTIN_RUNNERS.set(runnerKey('clickhouse', 'password'), async (integration) => {
  if (integration.source_type !== 'clickhouse') throw new Error('Expected ClickHouse integration');
  const { buildClickHouseRunner } = await import('./clickhouse.js');
  return buildClickHouseRunner(integration);
});

// Databricks — real runner (pat, oauth_m2m).
BUILTIN_RUNNERS.set(runnerKey('databricks', 'pat'), async (integration) => {
  if (integration.source_type !== 'databricks') throw new Error('Expected Databricks integration');
  const { buildDatabricksRunner } = await import('./databricks.js');
  return buildDatabricksRunner(integration);
});
BUILTIN_RUNNERS.set(runnerKey('databricks', 'oauth_m2m'), async (integration) => {
  if (integration.source_type !== 'databricks') throw new Error('Expected Databricks integration');
  const { buildDatabricksRunner } = await import('./databricks.js');
  return buildDatabricksRunner(integration);
});

/** Readonly handle on the registry — exported so `resolveRunner` can dispatch. */
export const builtinRunnerRegistry: {
  get(sourceType: SourceType, authType: string): BuiltinRunnerBuilder | undefined;
  has(sourceType: SourceType, authType: string): boolean;
} = {
  get: (sourceType, authType) => BUILTIN_RUNNERS.get(runnerKey(sourceType, authType)),
  has: (sourceType, authType) => BUILTIN_RUNNERS.has(runnerKey(sourceType, authType)),
};
