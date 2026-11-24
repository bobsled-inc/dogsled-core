/**
 * `CustomRunnerFactory` — host-injection seam for runner construction.
 *
 * A host application can use this to wire the `sledhouse_oidc` Snowflake auth
 * type to its own data-source provider; open-source users
 * shouldn't normally need to register anything.
 *
 * Factories are keyed on `(source_type, auth.type)` so future
 * Host-specific auth types on other dialects (e.g. a WIF variant) can be
 * routed cleanly without overloading the built-in namespace.
 */

import type { IntegrationFile, SourceType } from '../schemas/integration.js';

import type { BigQueryTokenProvider } from './refreshable-token.js';
import type { SqlRunnerModule } from './types.js';
import type { SecretResolver } from '../secrets/types.js';

export interface RunnerFactoryContext {
  /** Secret resolver, if the factory needs to look up additional env vars. */
  secretResolver?: SecretResolver;
  /**
   * Pipeline-resolved effective warehouse, one per run. When set, it overrides
   * `connection.warehouse` for the Snowflake session this factory opens. The
   * runtime opens a single session per run, so warehouse selection is
   * pipeline-grained only — per-model/resource selection is rejected upstream
   * at validation time.
   */
  warehouse?: string;
  /**
   * Trusted, per-run execution metadata. Built-in Snowflake runners send this
   * as `QUERY_TAG`; custom factories may use their provider's equivalent.
   */
  queryTag?: string;
  /**
   * Refreshable managed-credential provider. When set, the warehouse runner
   * authenticates with the short-lived token this returns and re-invokes it
   * mid-run — proactively before expiry and reactively on a 401 — so a
   * multi-hour Model Spec model / entity-graph task does not die when the orchestrator
   * token (~1h) lapses. Built from the same `credentials_token_command`
   * contract the loader uses — a command string that prints a fresh token —
   * via `createTokenCommandProvider`. (Models/entity-graph share that
   * command-string contract, not the loader's destination config field.) When
   * unset, runners keep their existing static-credential behaviour unchanged.
   *
   * Built-in runners consume this directly; host-registered custom factories
   * (e.g. a host application's BigQuery WIF / Snowflake OIDC runners) receive it
   * here so they can share the SAME refresh machinery.
   */
  tokenProvider?: BigQueryTokenProvider;
  /**
   * Server-side limit, in milliseconds, for each statement on the runner this
   * factory opens. A factory that shares one session between runners must not
   * apply it to that session; callers keep their own client-side deadline.
   */
  statementTimeoutMs?: number;
}

/**
 * Build a runner from a validated integration. The integration is expected to
 * have already had its `${{ env.VAR }}` / `_env` tokens interpolated.
 */
export type CustomRunnerFactory = (
  integration: IntegrationFile,
  context: RunnerFactoryContext
) => Promise<SqlRunnerModule>;

/** Composite key used for factory registration and dispatch. */
export function runnerKey(sourceType: SourceType, authType: string): string {
  return `${sourceType}:${authType}`;
}

/**
 * Lightweight registry. Model Spec (and any host embedding Model Spec) constructs one of
 * these, calls `.register(sourceType, authType, factory)` for each custom
 * factory it owns, and passes the registry to `resolveRunner()`.
 */
export class CustomRunnerRegistry {
  private readonly factories = new Map<string, CustomRunnerFactory>();

  register(sourceType: SourceType, authType: string, factory: CustomRunnerFactory): void {
    this.factories.set(runnerKey(sourceType, authType), factory);
  }

  get(sourceType: SourceType, authType: string): CustomRunnerFactory | undefined {
    return this.factories.get(runnerKey(sourceType, authType));
  }

  has(sourceType: SourceType, authType: string): boolean {
    return this.factories.has(runnerKey(sourceType, authType));
  }

  /** Snapshot of registered keys — for diagnostics / logging. */
  keys(): readonly string[] {
    return [...this.factories.keys()];
  }
}
