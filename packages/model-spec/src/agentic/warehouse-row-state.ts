/**
 * The row store on a warehouse: shared tables in the configured schema behind a fenced lease.
 * A host opts in by passing this as `agentic.stateStore`. `checkpoint_store` does not select it,
 * so a run stays on the warehouse store until its host chooses otherwise.
 */
import type { IntegrationFile } from '@bobsled-inc/connections';
import { caseName } from '../compiler/dialect.js';
import { parseAgenticCursorRecord, type AgenticLegacyCursorReader } from './row-cursors.js';
import { agenticRowDb, type AgenticRowDb, type AgenticRowDialect } from './row-state-dialect.js';
import {
  AGENTIC_ROW_RETENTION_MS,
  agenticRowTable,
  type AgenticRowBackend,
} from './row-state-tables.js';
import { createAgenticRowStore } from './row-store.js';
import { AgenticStateError, digestAgenticState, type AgenticStateStore } from './state.js';
import { resolveWarehouseCheckpointTarget } from './warehouse-checkpoint-target.js';
import {
  postgresRowDialect,
  snowflakeRowDialect,
  waitForSnowflakeLockQueue,
} from './warehouse-row-dialects.js';
import type { WarehouseCheckpointOptions } from './warehouse-state.js';
import { openLimitedRunner } from './warehouse-statement-limit.js';
import { LEGACY_WAREHOUSE_CURSOR_TABLES } from './legacy-names.js';
import { WAREHOUSE_CURSORS_TABLE } from './warehouse-cursors.js';

export type WarehouseRowStoreOptions = WarehouseCheckpointOptions & {
  /** How long a finished run stays after its last write. Default: 30 days. */
  retentionMs?: number;
  /**
   * Experimental, off by default. Commits the starts and finishes of model calls that are waiting
   * together, with one insert and one header update, rather than two statements for each. A call
   * still starts only once its start is saved. See docs/agentic-group-commit.md.
   */
  groupCommit?: boolean;
};

/** The warehouse store's cursor table, then the names it had in earlier Core generations. */
const OLDER_CURSOR_TABLES = [
  ...new Set([WAREHOUSE_CURSORS_TABLE, ...LEGACY_WAREHOUSE_CURSOR_TABLES]),
];
/** PostgreSQL truncates a longer identifier, and a bound name would then match nothing. */
const postgresNameBytes = 63;

type RowEngine = 'postgres' | 'snowflake';
const isRowEngine = (engine: string): engine is RowEngine =>
  engine === 'postgres' || engine === 'snowflake';
const dialects: Record<RowEngine, AgenticRowDialect> = {
  postgres: postgresRowDialect,
  snowflake: snowflakeRowDialect,
};
const statementLayers: Record<RowEngine, (db: AgenticRowDb, signal?: AbortSignal) => AgenticRowDb> =
  { postgres: (db) => db, snowflake: waitForSnowflakeLockQueue };

type WarehouseTarget = { catalog?: string; schema: string };

/** Names a view of the target's catalog. Snowflake's information schema is per database. */
const catalogView = (dialect: AgenticRowDialect, target: WarehouseTarget, view: string): string =>
  `${target.catalog ? `${dialect.identifier(target.catalog)}.` : ''}information_schema.${view}`;

/** PostgreSQL's information schema can hide a schema that a role does not own, so it asks the
 * catalog. A wrong "no" would send the statement this exists to avoid. */
const schemaQuery = (engine: RowEngine, target: WarehouseTarget): string =>
  engine === 'postgres'
    ? 'SELECT 1 AS found FROM pg_catalog.pg_namespace WHERE nspname = $1 LIMIT 1'
    : `SELECT 1 AS found FROM ${catalogView(dialects[engine], target, 'schemata')} WHERE schema_name = ? LIMIT 1`;

function warehouseRowBackend(
  integration: IntegrationFile,
  engine: RowEngine,
  target: WarehouseTarget,
  namespace: string,
  options: WarehouseRowStoreOptions
): AgenticRowBackend {
  const { signal } = options;
  return {
    dialect: dialects[engine],
    hasSchema: async (db) =>
      (await db.query(schemaQuery(engine, target), [target.schema])).length > 0,
    async connect(handling) {
      const runner = await openLimitedRunner(integration, options, handling);
      return {
        namespace,
        use(operation, useOptions) {
          const active = useOptions?.cleanup ? undefined : signal;
          return operation(statementLayers[engine](agenticRowDb(runner, active), active));
        },
        close: async () => runner.close?.(),
      };
    },
  };
}

/**
 * The checked settings of a store with `options`, and the backend it writes through. The store and
 * `warehouseRowStoreBackend` both start here, so neither can skip a check.
 */
function rowStoreSetup(integration: IntegrationFile, options: WarehouseRowStoreOptions) {
  const engine = integration.source_type;
  if (!isRowEngine(engine)) {
    throw new AgenticStateError('limit', {
      reason: 'invalid_store_config',
      message: 'The warehouse row store supports PostgreSQL and Snowflake.',
    });
  }
  const { schema } = options;
  const leaseMs = options.leaseMs ?? 120_000;
  const retentionMs = options.retentionMs ?? AGENTIC_ROW_RETENTION_MS;
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
        'The warehouse row store settings are invalid: schema must be one non-empty name, leaseMs must be 10,000 to 600,000 and retentionMs must be positive.',
    });
  }
  const target = resolveWarehouseCheckpointTarget(integration, options);
  if (engine === 'postgres' && Buffer.byteLength(target.schema) > postgresNameBytes) {
    throw new AgenticStateError('limit', {
      reason: 'invalid_store_config',
      message: `A PostgreSQL schema name can be at most ${postgresNameBytes} bytes.`,
    });
  }
  const namespace = [...(target.catalog ? [target.catalog] : []), target.schema]
    .map(dialects[engine].identifier)
    .join('.');
  const backend = warehouseRowBackend(integration, engine, target, namespace, {
    ...options,
    leaseMs,
  });
  return { engine, target, backend, leaseMs, retentionMs };
}

/**
 * The backend `createWarehouseRowStore` writes through for `options`, after the same checks: its
 * tables, statements and statement limits. Test fixtures use it to write a large run in bulk as the
 * store would. Internal: the package does not export it.
 */
export function warehouseRowStoreBackend(
  integration: IntegrationFile,
  options: WarehouseRowStoreOptions
): AgenticRowBackend {
  return rowStoreSetup(integration, options).backend;
}

/** Whether the old table exists. PostgreSQL's catalog answers that whatever the role may read,
 * so a table it has no grant on fails at the read that follows. Snowflake has no such view:
 * a table the role cannot see looks missing, so the role must hold `SELECT` on it. */
const legacyTableQuery = (engine: RowEngine, target: WarehouseTarget): string =>
  engine === 'postgres'
    ? 'SELECT 1 AS found FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 LIMIT 1'
    : `SELECT 1 AS found FROM ${catalogView(dialects[engine], target, 'tables')} WHERE table_schema = ? AND table_name = ? LIMIT 1`;

/**
 * Reads what `__dogsled_cursors`, the warehouse store's table in this schema, holds for a key.
 * A table that was never created means no earlier progress, and that has to be established: a
 * failed read must not pass for one, or the key would start again from the beginning.
 */
function legacyCursorReader(
  backend: AgenticRowBackend,
  engine: RowEngine,
  target: WarehouseTarget
): AgenticLegacyCursorReader {
  const { dialect } = backend;
  const q = dialect.identifier;
  return async (key) => {
    const connection = await backend.connect();
    try {
      return await connection.use(async (db) => {
        // The first table that exists holds the older progress: the current name once the
        // warehouse store took its table over, else the name it had before.
        for (const name of OLDER_CURSOR_TABLES) {
          const found = await db.query(legacyTableQuery(engine, target), [
            target.schema,
            caseName(name, engine),
          ]);
          if (!found.length) continue;
          const table = agenticRowTable(dialect, connection.namespace, name);
          const rows = await db.query(
            `SELECT ${q('record')} FROM ${table} WHERE ${q('key')} = ${dialect.bind(1)} LIMIT 2`,
            [digestAgenticState(key)]
          );
          if (rows.length > 1) throw new AgenticStateError('corrupt');
          return rows.length ? parseAgenticCursorRecord(rows[0]!.record) : null;
        }
        return null;
      });
    } finally {
      await connection.close();
    }
  };
}

/**
 * Keeps agentic state as rows in `options.schema` on PostgreSQL or Snowflake. A host opts in by
 * passing it as `agentic.stateStore`: a warehouse `checkpoint_store` keeps the warehouse store.
 * A new cursor key carries over its value from `__dogsled_cursors`, the warehouse store's table
 * in the same schema. On Snowflake the store's role must hold `SELECT` on that table wherever
 * the old store ran, because Snowflake reports a table the role cannot see as missing, and the
 * key would then start from empty.
 */
export function createWarehouseRowStore(
  integration: IntegrationFile,
  options: WarehouseRowStoreOptions
): AgenticStateStore {
  const { engine, target, backend, leaseMs, retentionMs } = rowStoreSetup(integration, options);
  const { signal } = options;
  return createAgenticRowStore(backend, {
    leaseMs,
    retentionMs,
    ...(signal ? { signal } : {}),
    legacyCursors: legacyCursorReader(backend, engine, target),
    ...(options.groupCommit === true ? { groupCommit: true } : {}),
  });
}
