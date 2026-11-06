/**
 * @bobsled-inc/connections
 *
 * Shared connection plumbing for the Dogsled monorepo: integration + target YAML
 * schemas, `${{ env.VAR }}` secret interpolation, per-dialect connection
 * construction, and the runner-resolution dispatcher consumed by extractor,
 * loader, and model-spec.
 *
 * Initially only Model Spec (`@bobsled-inc/model-spec`) consumes this
 * package. Extractor and loader stay on their own schemas until the follow-up
 * consolidation work.
 */

// ── Shared ─────────────────────────────────────────────────────────────────
export { snakeCaseHandleSchema, validateDualShapeFields } from './schemas/shared.js';
export type { DualFieldPair } from './schemas/shared.js';

// ── Model connections ─────────────────────────────────────────────────────
export {
  AiGatewayModelConnectionSchema,
  ApiKeyModelConnectionSchema,
  BedrockModelConnectionSchema,
  EnvPlaceholderSchema,
  ModelConnectionSchema,
  OllamaModelConnectionSchema,
  PlatformBudgetSchema,
  PlatformConfigSchema,
} from './schemas/model.js';
export type { ModelConnection, PlatformBudget, PlatformConfig } from './schemas/model.js';

// ── Snowflake ──────────────────────────────────────────────────────────────
export {
  SnowflakeConnectionSchema,
  SnowflakeAuthSchema,
  SnowflakePatAuthSchema,
  SnowflakeRsaKeyAuthSchema,
  SnowflakeOAuthAuthSchema,
  SnowflakeSledhouseOidcAuthSchema,
  SnowflakeWorkloadIdentityAuthSchema,
} from './schemas/snowflake.js';
export type { SnowflakeConnection, SnowflakeAuth } from './schemas/snowflake.js';

// ── BigQuery ───────────────────────────────────────────────────────────────
export {
  BigQueryConnectionSchema,
  BigQueryAuthSchema,
  BigQueryAdcAuthSchema,
  BigQueryWifAuthSchema,
  BigQueryServiceAccountAuthSchema,
} from './schemas/bigquery.js';
export type { BigQueryConnection, BigQueryAuth } from './schemas/bigquery.js';

// ── Postgres ───────────────────────────────────────────────────────────────
export {
  PostgresConnectionSchema,
  PostgresAuthSchema,
  PostgresPasswordAuthSchema,
  PostgresIamAuthSchema,
} from './schemas/postgres.js';
export type { PostgresConnection, PostgresAuth } from './schemas/postgres.js';

// ── Databricks ─────────────────────────────────────────────────────────────
export {
  DatabricksConnectionSchema,
  DatabricksAuthSchema,
  DatabricksPatAuthSchema,
  DatabricksOAuthM2mAuthSchema,
} from './schemas/databricks.js';
export type { DatabricksConnection, DatabricksAuth } from './schemas/databricks.js';
export { fetchDatabricksOAuthToken } from './runtime/runners/databricks.js';

// ── ClickHouse ─────────────────────────────────────────────────────────────
export {
  ClickHouseConnectionSchema,
  ClickHouseAuthSchema,
  ClickHousePasswordAuthSchema,
} from './schemas/clickhouse.js';
export type { ClickHouseConnection, ClickHouseAuth } from './schemas/clickhouse.js';

// ── DuckDB ─────────────────────────────────────────────────────────────────
export {
  DuckDbConnectionSchema,
  DuckDbAuthSchema,
  DuckDbFileAuthSchema,
  DuckDbMemoryAuthSchema,
} from './schemas/duckdb.js';
export type { DuckDbConnection, DuckDbAuth } from './schemas/duckdb.js';

// ── Integration + target union ─────────────────────────────────────────────
export {
  IntegrationFileSchema,
  SnowflakeIntegrationSchema,
  BigQueryIntegrationSchema,
  CrossWarehouseStagingSchema,
  PostgresIntegrationSchema,
  DatabricksIntegrationSchema,
  DuckDbIntegrationSchema,
  ClickHouseIntegrationSchema,
  SourceTypeValues,
  SourceTypeSchema,
} from './schemas/integration.js';
export type {
  IntegrationFile,
  SnowflakeIntegration,
  BigQueryIntegration,
  PostgresIntegration,
  DatabricksIntegration,
  DuckDbIntegration,
  ClickHouseIntegration,
  SourceType,
} from './schemas/integration.js';

export { TargetFileSchema } from './schemas/target.js';
export type { TargetFile, TargetOverrides, TargetDefaults } from './schemas/target.js';

// ── Secrets ────────────────────────────────────────────────────────────────
export type { SecretResolver } from './secrets/types.js';
export { withDeclaredSecretNames } from './secrets/host-resolver.js';
export { EnvSecretResolver } from './secrets/env-resolver.js';
export { interpolateSecrets } from './secrets/interpolate.js';
export type { InterpolateOptions } from './secrets/interpolate.js';

// ── Filesystem loaders ────────────────────────────────────────────────────
export { loadIntegration, loadIntegrationDirectory } from './fs/load-integration.js';
export type { LoadIntegrationOptions } from './fs/load-integration.js';
export { findIndexedIntegration, loadIndexedIntegrations } from './fs/indexed-integrations.js';
export type { IndexedIntegration } from './fs/indexed-integrations.js';
export { loadTarget } from './fs/load-target.js';
export type { LoadTargetOptions } from './fs/load-target.js';

// ── Runtime (runners + dispatcher) ────────────────────────────────────────
export type {
  SqlExecOptions,
  SqlRunner,
  SqlDryRunner,
  SqlQueryRow,
  SqlQueryRunner,
  SqlRunnerModule,
  SqlParams,
  SqlParamValue,
  SqlUnloader,
  UnloadOptions,
  UnloadResult,
} from './runtime/types.js';

// ── Cooperative cancellation ───────────────────────────────────────────────
// The runner contract's cancellation half. `runCancellable` is what makes an
// abort reach the DRIVER (interrupt / job.cancel / statement.cancel /
// operation.cancel / pg_cancel_backend) rather than only rejecting the promise.
export {
  SqlCancelledError,
  isCancellationError,
  runCancellable,
  throwIfCancelled,
} from './runtime/cancellation.js';
export type { RegisterCanceller } from './runtime/cancellation.js';

export {
  assertRunnerSupportsBindings,
  isValidSqlIdentifier,
  validateSqlIdentifier,
} from './runtime/identifier.js';
export { CustomRunnerRegistry, runnerKey } from './runtime/custom-runner.js';
export type { CustomRunnerFactory, RunnerFactoryContext } from './runtime/custom-runner.js';
export { resolveRunner } from './runtime/resolve-runner.js';
export type { ResolveRunnerOptions } from './runtime/resolve-runner.js';
export { QUERY_TAG_MAX_LENGTH, validateQueryTag } from './runtime/query-tag.js';
export { buildDuckDbRunner, isDuckDbAvailable } from './runtime/runners/duckdb.js';
export { resolveSnowflakeWarehouseOverride } from './runtime/runners/snowflake.js';

// ── Refreshable managed credentials (mid-run token refresh) ─────────────────
// Single source of truth — re-exported by `@bobsled-inc/loader` and consumed by
// the BigQuery/Snowflake warehouse runners so long-running Model Spec model +
// entity-graph tasks refresh their short-lived token mid-run.
export {
  RefreshableTokenSource,
  createRefreshableAuthClient,
  createTokenCommandProvider,
  parseTokenCommandOutput,
  isInvalidCredentialsError,
  TOKEN_REFRESH_SKEW_SECONDS,
} from './runtime/refreshable-token.js';
export type { BigQueryAccessToken, BigQueryTokenProvider } from './runtime/refreshable-token.js';

export { assertDriverVersion } from './runtime/driver-version.js';
