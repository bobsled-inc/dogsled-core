import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe } from 'vitest';
import {
  buildDuckDbRunner,
  isDuckDbAvailable,
  type DuckDbIntegration,
} from '@bobsled-inc/connections';
import {
  createDefaultAgenticStateStore,
  createDuckDbCheckpointStore,
  createLocalAgenticStateStore,
  digestAgenticState,
} from '../../src/agentic/index.js';
import { duckDbOperationBackend } from '../../src/agentic/duckdb-state.js';
import { agenticHeaderTableName } from '../../src/agentic/row-state-tables.js';
import { createAgenticRowStore } from '../../src/agentic/row-store.js';
import { AGENTIC_ROW_STORE_LIMITS } from '../../src/agentic/store-limits.js';
import { snowflakeRowDialect } from '../../src/agentic/warehouse-row-dialects.js';
import { createWarehouseRowStore } from '../../src/agentic/warehouse-row-state.js';
import {
  describeAgenticStoreConformance,
  type StoreHandle,
} from '../support/agentic-store-conformance.js';
import { createSnowflakeEmulator, type SnowflakeEmulator } from '../support/snowflake-emulator.js';

const worker = fileURLToPath(new URL('../support/agentic-store-crash-process.ts', import.meta.url));
const projects = new WeakMap<StoreHandle, string>();
const project = (handle: StoreHandle): string => projects.get(handle)!;
function localHandle(open: (directory: string) => StoreHandle['store']): StoreHandle {
  const directory = mkdtempSync(join(tmpdir(), 'store-conformance-'));
  const handle: StoreHandle = {
    store: open(directory),
    reopen: () => open(directory),
    cleanup: async () => rmSync(directory, { recursive: true, force: true }),
  };
  projects.set(handle, directory);
  return handle;
}
const integration = (directory: string): DuckDbIntegration => ({
  spec_version: '1',
  type: 'integration',
  name: 'checkpoints',
  source_type: 'duckdb',
  connection: {},
  auth: { type: 'file', path: join(directory, 'checkpoints.duckdb'), read_only: false },
});
const shared = (directory: string, retentionMs?: number, leaseMs = 10_000) =>
  createDuckDbCheckpointStore(integration(directory), {
    schema: 'agentic_checkpoints',
    leaseMs,
    ...(retentionMs === undefined ? {} : { retentionMs }),
  });
async function sql(directory: string, statement: string): Promise<void> {
  await runOn(integration(directory), [statement]);
}
async function runOn(database: DuckDbIntegration, statements: string[]): Promise<void> {
  const runner = await buildDuckDbRunner(database);
  try {
    for (const statement of statements) await runner.run(statement);
  } finally {
    await runner.close?.();
  }
}
// DuckDB cannot add a generated column to an existing table.
const computedColumn = (table: string) => [
  `CREATE TABLE ${table}_kept AS SELECT * FROM ${table}`,
  `DROP TABLE ${table}`,
  `CREATE TABLE ${table} (run_hash VARCHAR NOT NULL, computed VARCHAR GENERATED ALWAYS AS (repeat('x', 10)))`,
];
const lowerMacro = ['CREATE MACRO lower(x) AS x'];
const asView = (table: string) => [
  `ALTER TABLE ${table} RENAME TO kept_rows`,
  `CREATE VIEW ${table} AS SELECT * FROM ${table.replace(/[^.]*$/, 'kept_rows')}`,
];

describeAgenticStoreConformance({
  name: 'local file',
  open: async () => localHandle(createLocalAgenticStateStore),
  crashWorker: (handle) => [worker, 'file', project(handle)],
  damage: async (handle) => {
    const { writeFileSync } = await import('node:fs');
    const directory = join(project(handle), '.dogsled/model-spec');
    const snapshot = readdirSync(directory).find((name) => /^[a-f0-9]{64}-.*\.json$/.test(name));
    writeFileSync(join(directory, snapshot!), '{}');
  },
});

const runFile = (handle: StoreHandle, key: Parameters<typeof digestAgenticState>[0]) => ({
  ...integration(project(handle)),
  auth: {
    type: 'file' as const,
    path: join(
      project(handle),
      `.dogsled/model-spec/agentic-state/run-${digestAgenticState(key)}.duckdb`
    ),
    read_only: false,
  },
});
const emulators = new WeakMap<StoreHandle, SnowflakeEmulator>();
const rowTable = (name: string) => `"MEMORY"."CHECKPOINTS"."__DOGSLED_AGENTIC_${name}"`;
/** The header table of `key`, which the store must find without being told. */
const headerTable = (key: Parameters<typeof digestAgenticState>[0]) =>
  `"MEMORY"."CHECKPOINTS"."${agenticHeaderTableName(
    digestAgenticState(key),
    snowflakeRowDialect.headerTables[0]!
  ).toUpperCase()}"`;
const emulated = (
  emulator: SnowflakeEmulator,
  retentionMs?: number,
  leaseMs = 10_000,
  groupCommit = false
) =>
  createWarehouseRowStore(emulator.integration, {
    schema: 'checkpoints',
    customRunners: emulator.customRunners,
    leaseMs,
    ...(retentionMs === undefined ? {} : { retentionMs }),
    ...(groupCommit ? { groupCommit } : {}),
  });
async function emulatorHandle(leaseMs?: number, groupCommit = false): Promise<StoreHandle> {
  const emulator = await createSnowflakeEmulator();
  const handle: StoreHandle = {
    store: emulated(emulator, undefined, leaseMs, groupCommit),
    reopen: () => emulated(emulator, undefined, leaseMs, groupCommit),
    cleanup: () => emulator.close(),
  };
  emulators.set(handle, emulator);
  return handle;
}

/** Shared tables in a DuckDB file, through the row store's own factory, with group commit. */
const groupedDuckDb = (directory: string, leaseMs = 10_000) =>
  createAgenticRowStore(
    duckDbOperationBackend(
      join(directory, 'checkpoints.duckdb'),
      'agentic_checkpoints',
      undefined,
      leaseMs
    ),
    { leaseMs, retentionMs: 30 * 86_400_000, groupCommit: true }
  );

describe.skipIf(!(await isDuckDbAvailable()))('DuckDB', () => {
  for (const groupCommit of [false, true]) {
    // The Snowflake dialect and backend on an emulator. See cloud-row-store.test.ts for the proof.
    describeAgenticStoreConformance({
      name: groupCommit ? 'Snowflake emulator, group commit' : 'Snowflake emulator',
      groupCommit,
      limits: snowflakeRowDialect.limits,
      open: () => emulatorHandle(undefined, groupCommit),
      openLarge: () => emulatorHandle(600_000, groupCommit),
      expireLease: async (handle, key) => {
        await emulators.get(handle)!.sql(`UPDATE ${headerTable(key)} SET "LEASE_EXPIRES" = 0`);
      },
      withRetention: (handle, retentionMs) =>
        emulated(emulators.get(handle)!, retentionMs, undefined, groupCommit),
      damage: async (handle) => {
        await emulators.get(handle)!.sql(`UPDATE ${rowTable('ROWS')} SET "DATA" = '{"damaged":1}'`);
      },
      replaceRowsTable: async (handle) => {
        const emulator = emulators.get(handle)!;
        await emulator.sql(`ALTER TABLE ${rowTable('ROWS')} RENAME TO kept_rows`);
        await emulator.sql(
          `CREATE VIEW ${rowTable('ROWS')} AS SELECT * FROM "MEMORY"."CHECKPOINTS".kept_rows`
        );
      },
      addComputedColumn: async (handle) => {
        await emulators
          .get(handle)!
          .sql(`ALTER TABLE ${rowTable('ROWS')} ADD COLUMN computed VARCHAR DEFAULT 'x'`);
      },
    });
  }

  // A real engine with real transactions under group commit.
  describeAgenticStoreConformance({
    name: 'DuckDB shared tables, group commit',
    groupCommit: true,
    limits: AGENTIC_ROW_STORE_LIMITS,
    open: async () => localHandle(groupedDuckDb),
    openLarge: async () => localHandle((directory) => groupedDuckDb(directory, 600_000)),
    expireLease: (handle) =>
      sql(
        project(handle),
        'UPDATE agentic_checkpoints.__dogsled_agentic_runs SET lease_expires = 0'
      ),
  });

  describeAgenticStoreConformance({
    name: 'DuckDB run file',
    // The store declares what its file-store runs hold, and a DuckDB run file holds more.
    runLimits: AGENTIC_ROW_STORE_LIMITS,
    open: async () => localHandle(createDefaultAgenticStateStore),
    crashWorker: (handle) => [worker, 'duckdb', project(handle)],
    withRetention: (handle, retentionMs) =>
      createDefaultAgenticStateStore(project(handle), { retentionMs }),
    damage: (handle, key) =>
      runOn(runFile(handle, key), [`UPDATE __dogsled_agentic_rows SET data = '{"damaged":true}'`]),
    replaceRowsTable: (handle, key) =>
      runOn(runFile(handle, key), asView('__dogsled_agentic_rows')),
    addComputedColumn: (handle, key) =>
      runOn(runFile(handle, key), computedColumn('__dogsled_agentic_rows')),
    plantLowerMacro: (handle, key) => runOn(runFile(handle, key), lowerMacro),
  });

  describeAgenticStoreConformance({
    name: 'DuckDB shared tables',
    limits: AGENTIC_ROW_STORE_LIMITS,
    open: async () => localHandle(shared),
    openLarge: async () => localHandle((directory) => shared(directory, undefined, 600_000)),
    expireLease: (handle) =>
      sql(
        project(handle),
        'UPDATE agentic_checkpoints.__dogsled_agentic_runs SET lease_expires = 0'
      ),
    withRetention: (handle, retentionMs) => shared(project(handle), retentionMs),
    damage: (handle) =>
      sql(
        project(handle),
        `UPDATE agentic_checkpoints.__dogsled_agentic_rows SET data = '{"damaged":true}'`
      ),
    replaceRowsTable: (handle) =>
      runOn(integration(project(handle)), asView('agentic_checkpoints.__dogsled_agentic_rows')),
    addComputedColumn: (handle) =>
      runOn(
        integration(project(handle)),
        computedColumn('agentic_checkpoints.__dogsled_agentic_rows')
      ),
    plantLowerMacro: (handle) => runOn(integration(project(handle)), lowerMacro),
  });
});
