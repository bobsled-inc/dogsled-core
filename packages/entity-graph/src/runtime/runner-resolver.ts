import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  createTokenCommandProvider,
  interpolateSecrets,
  resolveRunner,
  type BigQueryTokenProvider,
  type CustomRunnerRegistry,
  type SecretResolver,
  type SqlRunnerModule,
} from '@bobsled-inc/connections';
import { buildSecretResolver, type ResolvedIntegration } from '@bobsled-inc/model-spec/project';
import { loadRunnerModule } from '@bobsled-inc/model-spec/shared';

export interface EntityGraphRunnerHandle {
  runner: SqlRunnerModule;
  source: 'runner_path' | 'integration' | 'local_runner';
  close: () => Promise<void>;
}

export interface ResolveEntityGraphRunnerOptions {
  cwd: string;
  runnerPath?: string;
  integration?: ResolvedIntegration;
  secretResolver?: SecretResolver;
  secrets?: string;
  allowLocalRunnerFallback?: boolean;
  /**
   * Optional in-memory registry of pre-built runner factories keyed by
   * `(source_type, auth_type)`. When present, entries here win over the
   * built-in `resolveRunner` dispatch, mirroring the same hook
   * `@bobsled-inc/model-spec`'s `runProject` already exposes for
   * Model Spec model materialization.
   *
   * A host application can inject BigQuery WIF and Snowflake OIDC
   * factories that consume externally minted, encrypted tokens. Without
   * this hook, the built-in drivers fall back to Google ADC, which is
   * unavailable in execution environments without a metadata server.
   *
   * Only consulted on the `integration` branch — when `runnerPath`
   * is set, the user-supplied module already drives execution and the
   * registry never wins.
   */
  customRunners?: CustomRunnerRegistry;
  /**
   * Refreshable managed-credential provider. When set, the integration-backed
   * warehouse runner re-mints the orchestrator's short-lived token mid-run
   * (proactive + reactive) so a multi-hour entity-graph phase does not die when
   * the ~1h token lapses. Takes precedence over `credentialsTokenCommand`.
   * Only consulted on the `integration` branch.
   */
  tokenProvider?: BigQueryTokenProvider;
  /**
   * Shell command that prints a fresh `{"access_token","expires_at"}` token —
   * the SAME `credentials_token_command` the loader consumes. Converted to a
   * {@link tokenProvider} when one isn't supplied directly.
   */
  credentialsTokenCommand?: string;
}

export async function resolveEntityGraphRunner(
  options: ResolveEntityGraphRunnerOptions
): Promise<EntityGraphRunnerHandle | undefined> {
  if (options.runnerPath) {
    const runner = await loadRunnerModule(options.runnerPath);
    return {
      runner,
      source: 'runner_path',
      close: async () => {
        await (runner as SqlRunnerModule).close?.();
      },
    };
  }

  if (!options.integration) {
    if (options.allowLocalRunnerFallback !== true) {
      return undefined;
    }
    const projectRoot = path.resolve(options.cwd);
    const localRunnerPath = path.resolve(projectRoot, 'runner.js');
    const relativeRunnerPath = path.relative(projectRoot, localRunnerPath);
    if (relativeRunnerPath.startsWith('..') || path.isAbsolute(relativeRunnerPath)) {
      throw new Error('runner.js must be inside the project directory.');
    }
    if (!fs.existsSync(localRunnerPath)) {
      return undefined;
    }
    const runner = await loadRunnerModule(localRunnerPath);
    return {
      runner,
      source: 'local_runner',
      close: async () => {
        await (runner as SqlRunnerModule).close?.();
      },
    };
  }

  const secretResolver =
    options.secretResolver ?? (await buildSecretResolver(options.cwd, options.secrets));
  const interpolated = await interpolateSecrets(options.integration.integration, secretResolver);
  // Refreshable managed credential — provider wins over the command string,
  // which in turn wins over the `BOBSLED_CORE_CREDENTIALS_TOKEN_COMMAND` env var. The
  // env fallback is how the standalone `dogsled entity-graph` subprocess + the
  // Cloud Run Jobs executor receive the SAME `credentials_token_command` the
  // loader gets from bobsled.yml, uniformly across every entity-graph phase.
  // Undefined leaves the runner on its static credentials (unchanged).
  const credentialsTokenCommand =
    options.credentialsTokenCommand ?? process.env['BOBSLED_CORE_CREDENTIALS_TOKEN_COMMAND'];
  const tokenProvider: BigQueryTokenProvider | undefined =
    options.tokenProvider ??
    (credentialsTokenCommand ? createTokenCommandProvider(credentialsTokenCommand) : undefined);
  const runner = await resolveRunner(interpolated, {
    secretResolver,
    ...(options.customRunners ? { customRunners: options.customRunners } : {}),
    ...(tokenProvider ? { tokenProvider } : {}),
  });
  return {
    runner,
    source: 'integration',
    close: async () => {
      await runner.close?.();
    },
  };
}
