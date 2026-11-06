/** The row store on DuckDB: shared tables in a configured file, or one local file per run. */
import {
  buildDuckDbRunner,
  throwIfCancelled,
  type DuckDbIntegration,
  type SqlRunnerModule,
} from '@bobsled-inc/connections';
import { canonicalDuckDbPath, openDuckDbWithRetry, withDuckDbFile } from './duckdb-file.js';
import { dbFor } from './duckdb-publication-storage.js';
import { readDuckDbCursor } from './duckdb-cursors.js';
import type { AgenticLegacyCursorReader } from './row-cursors.js';
import { agenticRowDb, duckDbRowDialect } from './row-state-dialect.js';
import { AGENTIC_ROW_RETENTION_MS, type AgenticRowBackend } from './row-state-tables.js';
import { createAgenticRowStore } from './row-store.js';
import { AgenticStateError, type AgenticStateStore } from './state.js';
import { limitRunner, warehouseStatementLimits } from './warehouse-statement-limit.js';

export interface DuckDbCheckpointOptions {
  schema: string;
  /** Lease length. Default: 120,000. Range: 10,000–600,000. */
  leaseMs?: number;
  /** How long a finished run stays after its last write. Default: 30 days. */
  retentionMs?: number;
  signal?: AbortSignal;
  /** Where progress for a new cursor key lived before this store. */
  legacyCursors?: AgenticLegacyCursorReader;
}

export function duckDbStateFile(path: string): DuckDbIntegration {
  return {
    spec_version: '1',
    type: 'integration',
    name: 'agentic_state',
    source_type: 'duckdb',
    connection: {},
    auth: { type: 'file', path, read_only: false },
  };
}

async function openRunner(config: DuckDbIntegration, signal?: AbortSignal) {
  const runner = await openDuckDbWithRetry(() => buildDuckDbRunner(config), {
    ...(signal ? { signal } : {}),
  });
  if (!runner.query || !runner.supportsBindings || !runner.close) {
    await runner.close?.();
    throw new Error('The DuckDB checkpoint store requires bindings, queries and close');
  }
  return runner;
}

/**
 * Opens the file for each operation and closes it again, so nothing holds the file between
 * operations. This is the safe way to share a file with publication and with other
 * processes: DuckDB allows one writing process per file. With a lease, statements have the
 * same deadline as on a warehouse, so a stuck one stops the session instead of hanging it.
 * DuckDB has no server-side limit to set, so the deadline stops waiting and nothing more.
 */
export function duckDbOperationBackend(
  path: string,
  schema: string,
  signal?: AbortSignal,
  leaseMs?: number
): AgenticRowBackend {
  let namespace: string | undefined;
  return {
    dialect: duckDbRowDialect,
    async connect(handling) {
      const canonical = await canonicalDuckDbPath(path);
      const config = duckDbStateFile(canonical);
      // DuckDB names the catalog after the file. A schema with the same name would be
      // ambiguous on its own, so ask for the catalog rather than repeat its naming rules.
      namespace ??= await withDuckDbFile(canonical, async () => {
        const runner = await openRunner(config, signal);
        try {
          const rows = await runner.query!('SELECT current_database() AS catalog');
          const catalog = duckDbRowDialect.identifier(String(rows[0]?.catalog));
          return `${catalog}.${duckDbRowDialect.identifier(schema)}`;
        } finally {
          await runner.close?.();
        }
      });
      return {
        namespace,
        use: (operation, options) =>
          withDuckDbFile(canonical, async () => {
            const active = options?.cleanup ? undefined : signal;
            throwIfCancelled(active);
            const opened = await openRunner(config, active);
            const runner =
              leaseMs === undefined
                ? opened
                : limitRunner(opened, warehouseStatementLimits(leaseMs), handling ?? {});
            try {
              return await operation(agenticRowDb(runner, active));
            } finally {
              await runner.close?.();
            }
          }),
        close: async () => {},
      };
    },
  };
}

/**
 * Keeps the file open for the whole session: a commit is one fsync of its write-ahead log,
 * and closing merges the log into the file once. Only for a file nothing else opens, because
 * a second open and close in this process would drop this process's lock on the file.
 */
export function duckDbHeldBackend(path: string, signal?: AbortSignal): AgenticRowBackend {
  return {
    dialect: duckDbRowDialect,
    async connect() {
      const runner: SqlRunnerModule = await openRunner(duckDbStateFile(path), signal);
      return {
        namespace: duckDbRowDialect.identifier('main'),
        use: (operation, options) =>
          operation(agenticRowDb(runner, options?.cleanup ? undefined : signal)),
        close: async () => runner.close?.(),
      };
    },
  };
}

/**
 * Shared tables in one DuckDB file, with the same fenced lease as a warehouse. The file must
 * not be a model's target: the host reads targets outside this store's guard.
 */
export function createDuckDbCheckpointStore(
  integration: DuckDbIntegration,
  options: DuckDbCheckpointOptions
): AgenticStateStore {
  const { schema, signal } = options;
  const leaseMs = options.leaseMs ?? 120_000;
  const retentionMs = options.retentionMs ?? AGENTIC_ROW_RETENTION_MS;
  if (integration.auth.type !== 'file' || integration.auth.read_only) {
    throw new AgenticStateError('limit', {
      reason: 'invalid_store_config',
      message: 'A DuckDB checkpoint_store needs a writable, file-backed integration.',
    });
  }
  if (
    !schema.trim() ||
    schema.length > 1024 ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 10_000 ||
    leaseMs > 600_000 ||
    !Number.isSafeInteger(retentionMs) ||
    retentionMs < 1
  ) {
    throw new AgenticStateError('limit', {
      reason: 'invalid_store_config',
      message:
        'The checkpoint_store setting is invalid: schema must be one non-empty name, lease_seconds must be 10 to 600 and retention must be positive.',
    });
  }
  const backend = duckDbOperationBackend(integration.auth.path, schema, signal, leaseMs);
  return createAgenticRowStore(backend, {
    leaseMs,
    retentionMs,
    ...(signal ? { signal } : {}),
    ...(options.legacyCursors ? { legacyCursors: options.legacyCursors } : {}),
  });
}

/** Reads the cursor a DuckDB publisher kept for this key in its target, if the file exists. */
export function duckDbPublicationCursorReader(
  integration: DuckDbIntegration,
  signal?: AbortSignal
): AgenticLegacyCursorReader {
  return async (key) => {
    if (integration.auth.type !== 'file') return null;
    const canonical = await canonicalDuckDbPath(integration.auth.path);
    const config = { ...integration, auth: { ...integration.auth, path: canonical } };
    return withDuckDbFile(canonical, async () => {
      throwIfCancelled(signal);
      const runner = await openRunner(config, signal);
      try {
        return await readDuckDbCursor(dbFor(runner, signal), key);
      } finally {
        await runner.close?.();
      }
    });
  };
}
