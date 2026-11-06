import { randomUUID } from 'node:crypto';
import { describe } from 'vitest';
import { resolveRunner, type PostgresIntegration } from '@bobsled-inc/connections';
import { digestAgenticState } from '../../../src/agentic/state.js';
import { createWarehouseCheckpointStore } from '../../../src/agentic/warehouse-state.js';
import { createAgenticRowStore } from '../../../src/agentic/row-store.js';
import {
  describeAgenticStoreConformance,
  type StoreHandle,
} from '../../support/agentic-store-conformance.js';
import { postgresRowBackend } from '../../support/postgres-row-backend.js';

const enabled =
  process.env.DOGSLED_MODEL_SPEC_INTEGRATION_WAREHOUSE?.split(',').includes('postgres');
const integration = (): PostgresIntegration => ({
  spec_version: '1',
  type: 'integration',
  name: 'lake',
  source_type: 'postgres',
  connection: {
    host: process.env.DOGSLED_MODEL_SPEC_POSTGRES_HOST!,
    port: Number(process.env.DOGSLED_MODEL_SPEC_POSTGRES_PORT ?? 5432),
    database: process.env.DOGSLED_MODEL_SPEC_POSTGRES_DATABASE!,
  },
  auth: {
    type: 'password',
    user: process.env.DOGSLED_MODEL_SPEC_POSTGRES_USER!,
    password: process.env.DOGSLED_MODEL_SPEC_POSTGRES_PASSWORD!,
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
  `__dogsled_cp_${digestAgenticState(key).slice(0, 48)}`;

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

  const rows = (schema: string, retentionMs = 86_400_000) =>
    createAgenticRowStore(postgresRowBackend(integration(), schema, 10_000), {
      leaseMs: 10_000,
      retentionMs,
    });
  describeAgenticStoreConformance({
    name: 'PostgreSQL row layout',
    open: async () => open((schema) => rows(schema)),
    expireLease: (handle) =>
      sql(`UPDATE "${schemas.get(handle)}"."__dogsled_agentic_runs" SET "lease_expires" = 0`),
    withRetention: (handle, retentionMs) => rows(schemas.get(handle)!, retentionMs),
    damage: (handle) =>
      sql(`UPDATE "${schemas.get(handle)}"."__dogsled_agentic_rows" SET "data" = '{"damaged":1}'`),
  });
});
