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
  const runner = await buildDuckDbRunner(integration(directory));
  try {
    await runner.run(statement);
  } finally {
    await runner.close?.();
  }
}

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

describe.skipIf(!(await isDuckDbAvailable()))('DuckDB', () => {
  describeAgenticStoreConformance({
    name: 'DuckDB run file',
    open: async () => localHandle(createDefaultAgenticStateStore),
    crashWorker: (handle) => [worker, 'duckdb', project(handle)],
    withRetention: (handle, retentionMs) =>
      createDefaultAgenticStateStore(project(handle), { retentionMs }),
    damage: async (handle, key) => {
      const file = join(
        project(handle),
        `.dogsled/model-spec/agentic-state/run-${digestAgenticState(key)}.duckdb`
      );
      const runner = await buildDuckDbRunner({
        ...integration(project(handle)),
        auth: { type: 'file', path: file, read_only: false },
      });
      try {
        await runner.run(`UPDATE __dogsled_agentic_rows SET data = '{"damaged":true}'`);
      } finally {
        await runner.close?.();
      }
    },
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
  });
});
