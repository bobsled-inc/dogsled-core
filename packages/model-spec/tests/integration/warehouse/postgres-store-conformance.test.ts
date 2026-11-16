import { randomUUID } from 'node:crypto';
import { describe } from 'vitest';
import { resolveRunner, type PostgresIntegration } from '@bobsled-inc/connections';
import { digestAgenticState } from '../../../src/agentic/state.js';
import { AGENTIC_ROW_STORE_LIMITS } from '../../../src/agentic/store-limits.js';
import { createWarehouseCheckpointStore } from '../../../src/agentic/warehouse-state.js';
import { createWarehouseRowStore } from '../../../src/agentic/warehouse-row-state.js';
import {
  describeAgenticStoreConformance,
  type StoreHandle,
} from '../../support/agentic-store-conformance.js';

const enabled =
  process.env.BOBSLED_CORE_MODEL_SPEC_INTEGRATION_WAREHOUSE?.split(',').includes('postgres');
const integration = (): PostgresIntegration => ({
  spec_version: '1',
  type: 'integration',
  name: 'lake',
  source_type: 'postgres',
  connection: {
    host: process.env.BOBSLED_CORE_MODEL_SPEC_POSTGRES_HOST!,
    port: Number(process.env.BOBSLED_CORE_MODEL_SPEC_POSTGRES_PORT ?? 5432),
    database: process.env.BOBSLED_CORE_MODEL_SPEC_POSTGRES_DATABASE!,
  },
  auth: {
    type: 'password',
    user: process.env.BOBSLED_CORE_MODEL_SPEC_POSTGRES_USER!,
    password: process.env.BOBSLED_CORE_MODEL_SPEC_POSTGRES_PASSWORD!,
  },
});
async function sql(statement: string): Promise<void> {
  const runner = await resolveRunner(integration());
  try {
    await runner.run(statement);
  } finally {
    await runner.close?.();
  }
}
const schemas = new WeakMap<StoreHandle, string>();
function open(create: (schema: string) => StoreHandle['store']): StoreHandle {
  const schema = `store_conformance_${randomUUID().replaceAll('-', '')}`;
  const handle: StoreHandle = {
    store: create(schema),
    reopen: () => create(schema),
    cleanup: () => sql(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`),
  };
  schemas.set(handle, schema);
  return handle;
}
const tableFor = (key: Parameters<typeof digestAgenticState>[0]) =>
  `__bobsled_cp_${digestAgenticState(key).slice(0, 48)}`;

describe.skipIf(!enabled)('PostgreSQL', () => {
  describeAgenticStoreConformance({
    name: 'PostgreSQL warehouse',
    open: async () =>
      open((schema) => createWarehouseCheckpointStore(integration(), { schema, leaseMs: 10_000 })),
    expireLease: (handle, key) =>
      sql(`UPDATE "${schemas.get(handle)}"."${tableFor(key)}_c" SET "expires" = 0`),
    damage: (handle, key) =>
      sql(`UPDATE "${schemas.get(handle)}"."${tableFor(key)}_p" SET "data" = 'invalid-base64'`),
    createAcceptsStartedRun: true,
  });

  const rows = (schema: string, retentionMs = 86_400_000, leaseMs = 10_000, groupCommit = false) =>
    createWarehouseRowStore(integration(), {
      schema,
      leaseMs,
      retentionMs,
      ...(groupCommit ? { groupCommit } : {}),
    });
  describeAgenticStoreConformance({
    name: 'PostgreSQL row layout, group commit',
    groupCommit: true,
    limits: AGENTIC_ROW_STORE_LIMITS,
    open: async () => open((schema) => rows(schema, undefined, undefined, true)),
    openLarge: async () => open((schema) => rows(schema, undefined, 600_000, true)),
    expireLease: (handle) =>
      sql(`UPDATE "${schemas.get(handle)}"."__bobsled_agentic_runs" SET "lease_expires" = 0`),
  });
  describeAgenticStoreConformance({
    name: 'PostgreSQL row layout',
    limits: AGENTIC_ROW_STORE_LIMITS,
    open: async () => open((schema) => rows(schema)),
    openLarge: async () => open((schema) => rows(schema, undefined, 600_000)),
    expireLease: (handle) =>
      sql(`UPDATE "${schemas.get(handle)}"."__bobsled_agentic_runs" SET "lease_expires" = 0`),
    withRetention: (handle, retentionMs) => rows(schemas.get(handle)!, retentionMs),
    damage: (handle) =>
      sql(`UPDATE "${schemas.get(handle)}"."__bobsled_agentic_rows" SET "data" = '{"damaged":1}'`),
    replaceRowsTable: async (handle) => {
      const table = `"${schemas.get(handle)}"."__bobsled_agentic_rows"`;
      await sql(`ALTER TABLE ${table} RENAME TO kept_rows`);
      await sql(`CREATE VIEW ${table} AS SELECT * FROM "${schemas.get(handle)}".kept_rows`);
    },
    addComputedColumn: (handle) =>
      sql(
        `ALTER TABLE "${schemas.get(handle)}"."__bobsled_agentic_rows" ADD COLUMN computed TEXT GENERATED ALWAYS AS (repeat('x', 10)) STORED`
      ),
  });
});
