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
import {
  describeAgenticStoreConformance,
  type StoreHandle,
} from '../support/agentic-store-conformance.js';

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
const shared = (directory: string, retentionMs?: number) =>
  createDuckDbCheckpointStore(integration(directory), {
    schema: 'agentic_checkpoints',
    leaseMs: 10_000,
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

describe.skipIf(!(await isDuckDbAvailable()))('DuckDB', () => {
  describeAgenticStoreConformance({
    name: 'DuckDB run file',
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
    open: async () => localHandle(shared),
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
