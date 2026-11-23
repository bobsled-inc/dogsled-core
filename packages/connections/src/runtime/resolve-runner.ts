/**
 * `resolveRunner` — the single entry point Model Spec calls to turn a validated
 * integration into an `SqlRunnerModule`.
 *
 * Dispatch order (per the Notion sub-spec): custom → built-in → fail.
 *
 *   1. If a `CustomRunnerFactory` is registered for
 *      `(integration.source_type, integration.auth.type)`, it wins
 *      unconditionally. A host application can use this to wire
 *      `sledhouse_oidc` without leaking GCP/OIDC plumbing into this package.
 *   2. Otherwise, dispatch to the built-in registry.
 *   3. If neither is present, throw a detailed error listing the key that
 *      was looked up and the factories the caller registered, so operators
 *      can see at a glance what's missing.
 */

import { CommandError } from '@bobsled-inc/protocol';

import type { IntegrationFile } from '../schemas/integration.js';
import type { SecretResolver } from '../secrets/types.js';

import type { CustomRunnerRegistry } from './custom-runner.js';
import { validateQueryTag } from './query-tag.js';
import type { BigQueryTokenProvider } from './refreshable-token.js';
import { builtinRunnerRegistry } from './runners/index.js';
import type { SqlRunnerModule } from './types.js';

export interface ResolveRunnerOptions {
  /**
   * Host-registered runner factories. Keyed by `(source_type, auth.type)`
   * via `CustomRunnerRegistry`. Entries here always win over the built-in
   * registry.
   */
  customRunners?: CustomRunnerRegistry;

  /**
   * Secret resolver passed to the chosen factory. Custom runners may need
   * secondary env-var lookups (e.g. a host-provided runner reading a GCP SA email).
   * Built-in runners operate on the already-interpolated integration, so
   * this is informational for them.
   */
  secretResolver?: SecretResolver;

  /**
   * Pipeline-resolved effective warehouse, threaded into the factory context.
   * When set, the Snowflake runner uses it as the session warehouse in place
   * of `connection.warehouse`. One per run — warehouse selection is
   * pipeline-grained only.
   */
  warehouse?: string;

  /**
   * Trusted, per-run query metadata. This programmatic option is intentionally
   * separate from integration YAML.
   */
  queryTag?: string;

  /**
   * Refreshable managed-credential provider. Forwarded to the chosen factory's
   * {@link RunnerFactoryContext.tokenProvider}; the BigQuery and Snowflake
   * runners use it to refresh the orchestrator's short-lived token mid-run.
   * Build one from a `credentials_token_command` string via
   * `createTokenCommandProvider`. When unset, runners keep their static
   * credentials and behave exactly as before.
   */
  tokenProvider?: BigQueryTokenProvider;

  /**
   * Server-side limit, in milliseconds, for each statement on the runner this
   * call opens. It covers that runner only, so other runners for the same
   * integration keep the warehouse default. Unset leaves the default in place.
   */
  statementTimeoutMs?: number;
}

/**
 * Resolve the runner that matches `integration`'s `(source_type, auth.type)`
 * precedence: custom → built-in → fail.
 */
export async function resolveRunner(
  integration: IntegrationFile,
  options: ResolveRunnerOptions = {}
): Promise<SqlRunnerModule> {
  const queryTag = validateQueryTag(options.queryTag);
  const authType = integration.auth.type;
  const custom = options.customRunners?.get(integration.source_type, authType);
  if (custom) {
    return custom(integration, {
      secretResolver: options.secretResolver,
      warehouse: options.warehouse,
      queryTag,
      tokenProvider: options.tokenProvider,
      statementTimeoutMs: options.statementTimeoutMs,
    });
  }

  const builtin = builtinRunnerRegistry.get(integration.source_type, authType);
  if (builtin) {
    return builtin(integration, {
      secretResolver: options.secretResolver,
      warehouse: options.warehouse,
      queryTag,
      tokenProvider: options.tokenProvider,
      statementTimeoutMs: options.statementTimeoutMs,
    });
  }

  const registeredKeys = options.customRunners?.keys().join(', ') || '(none)';
  throw new CommandError(
    `No runner available for (source_type="${integration.source_type}", auth.type="${authType}"). ` +
      'Neither a built-in adapter nor a registered CustomRunnerFactory matched this key. ' +
      `Registered custom-factory keys: ${registeredKeys}.`,
    2
  );
}
