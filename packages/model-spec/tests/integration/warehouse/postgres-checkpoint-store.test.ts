import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveRunner, type PostgresIntegration } from '@bobsled-inc/connections';
import { createWarehouseCheckpointStore } from '../../../src/agentic/warehouse-state.js';
import { digestAgenticState } from '../../../src/agentic/state.js';
import { executeAgenticRun } from '../../../src/agentic/run.js';
import { MemoryStateStore, runFixture } from '../../unit/agentic/state-fixture.js';

const faults = vi.hoisted(() => ({ afterCheckpoint: 0, failInsert: 0 }));
vi.mock('@bobsled-inc/connections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bobsled-inc/connections')>();
  return {
    ...actual,
    resolveRunner: async (...args: Parameters<typeof actual.resolveRunner>) => {
      const runner = await actual.resolveRunner(...args);
      let saving = false;
      return {
        ...runner,
        query: async (...queryArgs: Parameters<NonNullable<typeof runner.query>>) => {
          if (
            queryArgs[0].startsWith('INSERT INTO') &&
            faults.failInsert > 0 &&
            --faults.failInsert === 0
          ) {
            throw new Error('Injected failed staging write');
          }
          return runner.query!(...queryArgs);
        },
        run: async (...runArgs: Parameters<typeof runner.run>) => {
          if (runArgs[0].includes('SET "snapshot" =')) saving = true;
          const result = await runner.run(...runArgs);
          if (runArgs[0] === 'COMMIT' && saving) {
            saving = false;
            if (faults.afterCheckpoint > 0 && --faults.afterCheckpoint === 0) {
              throw new Error('Injected lost checkpoint response');
            }
          }
          return result;
        },
      };
    },
  };
});

describe.skipIf(
  !process.env.DOGSLED_MODEL_SPEC_INTEGRATION_WAREHOUSE?.split(',').includes('postgres')
)('warehouse checkpoints', () => {
  const dirs: string[] = [];
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    faults.afterCheckpoint = 0;
    faults.failInsert = 0;
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  async function setup() {
    const directory = await mkdtemp(join(tmpdir(), 'warehouse-checkpoint-'));
    dirs.push(directory);
    for (const name of ['HOST', 'DATABASE', 'USER', 'PASSWORD']) {
      if (!process.env[`DOGSLED_MODEL_SPEC_POSTGRES_${name}`]) {
        throw new Error(`DOGSLED_MODEL_SPEC_POSTGRES_${name} is required`);
      }
    }
    const integration: PostgresIntegration = {
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
    };
    const schema = `checkpoint_test_${randomUUID().replaceAll('-', '')}`;
    cleanups.push(async () => {
      const runner = await resolveRunner(integration);
      try {
        await runner.run(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await runner.close?.();
      }
    });
    return { directory, integration, schema };
  }
  async function snapshotFixture(directory: string) {
    const memory = new MemoryStateStore();
    const f = runFixture(8);
    // A deliberately large snapshot; a token cap would reject its input before any write.
    f.model.limits = {};
    f.model.plan.steps[0]!.instructions = 'Synthetic checkpoint data. '.repeat(2200);
    await executeAgenticRun(f.host, f.context(), {
      projectDirectory: directory,
      stateStore: memory,
      run: { id: randomUUID(), mode: 'start' },
    });
    return [...memory.runs.values()][0]!;
  }
  it('does not expose a snapshot when the second staging batch fails', async () => {
    const { directory, integration, schema } = await setup();
    const snapshot = await snapshotFixture(directory);
    const store = createWarehouseCheckpointStore(integration, { schema });
    const session = await store.acquire(snapshot.key);
    try {
      faults.failInsert = 2;
      await expect(session.create(snapshot)).rejects.toThrow('staging');
      expect(await session.read()).toBeNull();
      faults.failInsert = 0;
      await session.create(snapshot);
      expect(await session.read()).toEqual(snapshot);
    } finally {
      await session.release();
    }
  });
  it('rejects damaged payloads instead of treating them as missing', async () => {
    const { directory, integration, schema } = await setup();
    const snapshot = await snapshotFixture(directory);
    const store = createWarehouseCheckpointStore(integration, { schema });
    const session = await store.acquire(snapshot.key);
    const runner = await resolveRunner(integration);
    try {
      await session.create(snapshot);
      const table = `__dogsled_cp_${digestAgenticState(snapshot.key).slice(0, 48)}_p`;
      await runner.run(`UPDATE "${schema}"."${table}" SET "data" = 'invalid-base64'`);
      await expect(session.read()).rejects.toMatchObject({ code: 'corrupt' });
    } finally {
      await session.release();
      await runner.close?.();
    }
  });
  it('reuses completed assignments after reopening the warehouse store', async () => {
    const { directory, integration, schema } = await setup();
    const f = runFixture(2);
    const calls = vi.spyOn(f.host, 'executeAgent');
    const run = { id: directory, mode: 'start' as const };
    await executeAgenticRun(f.host, f.context(), {
      projectDirectory: directory,
      run,
      stateStore: createWarehouseCheckpointStore(integration, { schema }),
    });
    calls.mockClear();
    await executeAgenticRun(f.host, f.context(), {
      projectDirectory: directory,
      run: { ...run, mode: 'resume' },
      stateStore: createWarehouseCheckpointStore(integration, { schema }),
    });
    expect(f.host.executeAgent).not.toHaveBeenCalled();
    await expect(access(join(directory, '.dogsled/model-spec'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('reuses an accepted result when the commit response was lost', async () => {
    const { directory, integration, schema } = await setup();
    const f = runFixture(2);
    const calls = vi.spyOn(f.host, 'executeAgent');
    const options = {
      projectDirectory: directory,
      stateStore: createWarehouseCheckpointStore(integration, { schema }),
      run: { id: directory, mode: 'start' as const },
    };
    faults.afterCheckpoint = 4;
    await executeAgenticRun(f.host, f.context(), options);
    expect(faults.afterCheckpoint).toBe(0);
    expect(calls).toHaveBeenCalledTimes(2);
    calls.mockClear();
    await executeAgenticRun(f.host, f.context(), {
      ...options,
      run: { ...options.run, mode: 'resume' },
    });
    expect(calls).not.toHaveBeenCalled();
  });
  it('fences an expired owner after another process takes over', async () => {
    const { integration, schema } = await setup();
    const store = createWarehouseCheckpointStore(integration, { schema });
    const key = { scope: 'test', model: 'pairs', id: randomUUID() };
    const first = await store.acquire(key);
    const runner = await resolveRunner(integration);
    try {
      const table = `__dogsled_cp_${digestAgenticState(key).slice(0, 48)}_c`;
      if (typeof table !== 'string' || !/^__dogsled_cp_[a-f0-9]{48}_c$/.test(table)) {
        throw new Error('Missing test control table');
      }
      await runner.run(`UPDATE "${schema}"."${table}" SET "expires" = 0`);
      const second = await store.acquire(key);
      try {
        await expect(first.read()).rejects.toThrow();
        await first.release();
        expect(await second.read()).toBeNull();
      } finally {
        await second.release();
      }
    } finally {
      await first.release();
      await runner.close?.();
    }
  });
  it('rejects a second owner and permits acquisition after release', async () => {
    const { integration, schema } = await setup();
    const store = createWarehouseCheckpointStore(integration, { schema });
    const key = { scope: 'test', model: 'pairs', id: randomUUID() };
    const first = await store.acquire(key);
    try {
      expect(await first.read()).toBeNull();
      await expect(store.acquire(key)).rejects.toThrow();
    } finally {
      await first.release();
    }
    const second = await store.acquire(key);
    await expect(first.read()).rejects.toThrow();
    await second.release();
  });
});
