import { CommandError } from '@bobsled-inc/protocol';

import type { SqlQueryRunner, SqlRunnerModule } from './types.js';

// Compatibility re-exports; identifier validation is protocol-owned because
// metadata-only configuration consumers must not load connection runtimes.
export { isValidSqlIdentifier, validateSqlIdentifier } from '@bobsled-inc/protocol';

export function assertRunnerSupportsBindings(
  runner: SqlRunnerModule,
  integrationName: string
): asserts runner is SqlRunnerModule & { query: SqlQueryRunner; supportsBindings: true } {
  if (!runner.query) {
    throw new CommandError(
      `Integration "${integrationName}" does not expose a SQL query runner.`,
      2
    );
  }
  if (runner.supportsBindings !== true) {
    throw new CommandError(
      `Integration "${integrationName}" does not support parameterized SQL bindings required by sync run.`,
      2
    );
  }
}
