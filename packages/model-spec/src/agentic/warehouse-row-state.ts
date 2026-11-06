/**
 * The row store on a warehouse: shared tables in the configured schema behind a fenced lease.
 * A host opts in by passing this as `agentic.stateStore`. `checkpoint_store` does not select it,
 * so a run stays on the warehouse store until its host chooses otherwise.
 */
import type { IntegrationFile } from '@bobsled-inc/connections';
import { agenticRowDb, type AgenticRowDb, type AgenticRowDialect } from './row-state-dialect.js';
import { AGENTIC_ROW_RETENTION_MS, type AgenticRowBackend } from './row-state-tables.js';
import { createAgenticRowStore } from './row-store.js';
import { AgenticStateError, type AgenticStateStore } from './state.js';
import { resolveWarehouseCheckpointTarget } from './warehouse-checkpoint-target.js';
import {
  postgresRowDialect,
  snowflakeRowDialect,
  waitForSnowflakeLockQueue,
} from './warehouse-row-dialects.js';
import type { WarehouseCheckpointOptions } from './warehouse-state.js';
import { openLimitedRunner } from './warehouse-statement-limit.js';

export type WarehouseRowStoreOptions = WarehouseCheckpointOptions & {
  /** How long a finished run stays after its last write. Default: 30 days. */
  retentionMs?: number;
};

type RowEngine = 'postgres' | 'snowflake';
const isRowEngine = (engine: string): engine is RowEngine =>
  engine === 'postgres' || engine === 'snowflake';
const dialects: Record<RowEngine, AgenticRowDialect> = {
  postgres: postgresRowDialect,
  snowflake: snowflakeRowDialect,
};
const statementLayers: Record<RowEngine, (db: AgenticRowDb, signal?: AbortSignal) => AgenticRowDb> =
  { postgres: (db) => db, snowflake: waitForSnowflakeLockQueue };

function warehouseRowBackend(
  integration: IntegrationFile,
  engine: RowEngine,
  namespace: string,
  options: WarehouseRowStoreOptions
): AgenticRowBackend {
  const { signal } = options;
  return {
    dialect: dialects[engine],
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

export function createWarehouseRowStore(
  integration: IntegrationFile,
  options: WarehouseRowStoreOptions
): AgenticStateStore {
  const engine = integration.source_type;
  if (!isRowEngine(engine)) {
    throw new AgenticStateError('limit', {
      reason: 'invalid_store_config',
      message: 'The warehouse row store supports PostgreSQL and Snowflake.',
    });
  }
  const { schema, signal } = options;
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
  const dialect = dialects[engine];
  const namespace = [...(target.catalog ? [target.catalog] : []), target.schema]
    .map(dialect.identifier)
    .join('.');
  const backend = warehouseRowBackend(integration, engine, namespace, { ...options, leaseMs });
  return createAgenticRowStore(backend, {
    leaseMs,
    retentionMs,
    ...(signal ? { signal } : {}),
  });
}
