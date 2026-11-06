import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { isDuckDbAvailable, type DuckDbIntegration } from '@bobsled-inc/connections';
import type { AgenticCursorKey } from '../../src/agentic/cursor.js';
import { agenticRowDb } from '../../src/agentic/row-state-dialect.js';
import { executeAgenticRun } from '../../src/agentic/run.js';
import {
  snowflakeRowDialect,
  waitForSnowflakeLockQueue,
} from '../../src/agentic/warehouse-row-dialects.js';
import { createWarehouseRowStore } from '../../src/agentic/warehouse-row-state.js';
import { openLimitedRunner } from '../../src/agentic/warehouse-statement-limit.js';
import { benchmarkWorkload } from '../support/agentic-benchmark.js';
import { mapScenario } from '../support/agentic-store-scenario.js';
import { createSnowflakeEmulator, type SnowflakeEmulator } from '../support/snowflake-emulator.js';

const namespace = '"MEMORY"."CHECKPOINTS"';
const key: AgenticCursorKey = { scope: 'lake', model: 'pairs', target: 'main.pairs' };
const signature = 'a'.repeat(64);

describe.skipIf(!(await isDuckDbAvailable()))('the warehouse row store on an emulator', () => {
  const emulators: SnowflakeEmulator[] = [];
  afterEach(async () => {
    for (const emulator of emulators.splice(0)) await emulator.close();
  });
  async function open() {
    const emulator = await createSnowflakeEmulator();
    emulators.push(emulator);
    const store = () =>
      createWarehouseRowStore(emulator.integration, {
        schema: 'checkpoints',
        customRunners: emulator.customRunners,
        leaseMs: 12_000,
      });
    /** A session on the same limited runner the store would use, with its tables ready. */
    const db = async () => {
      const runner = await openLimitedRunner(emulator.integration, {
        customRunners: emulator.customRunners,
        leaseMs: 12_000,
      });
      return waitForSnowflakeLockQueue(agenticRowDb(runner));
    };
    return { emulator, store, db };
  }

  describe('first rows', () => {
    it('adds one row however many callers race on a new key', async () => {
      const { emulator, store, db } = await open();
      const session = await store().acquire((await mapScenario()).key);
      await session.release();
      const connection = await db();
      const table = `${namespace}."__DOGSLED_AGENTIC_CURSORS"`;
      await Promise.all(
        Array.from({ length: 8 }, () =>
          snowflakeRowDialect.insertIfAbsent(
            connection,
            table,
            { key_hash: 'k', scope: 's', model: 'm', target: 't', version: 0, record: '' },
            'key_hash',
            namespace
          )
        )
      );
      expect(await emulator.sql(`SELECT * FROM ${table}`)).toHaveLength(1);
    });

    it('keeps the text of a first row exact through both levels of quoting', async () => {
      const { emulator, store, db } = await open();
      await (await store().acquire((await mapScenario()).key)).release();
      const table = `${namespace}."__DOGSLED_AGENTIC_CURSORS"`;
      const record = `{"a":"it's","b":"C:\\\\new\\n","c":"line\nbreak","d":"\t語"}`;
      await snowflakeRowDialect.insertIfAbsent(
        await db(),
        table,
        { key_hash: 'k', scope: 's', model: 'm', target: 't', version: 0, record },
        'key_hash',
        namespace
      );
      expect(await emulator.sql(`SELECT "RECORD" FROM ${table}`)).toEqual([{ RECORD: record }]);
    });

    it('stops at an empty guard table rather than insert without its lock', async () => {
      const { emulator, store } = await open();
      await (await store().acquire((await mapScenario()).key)).release();
      await emulator.sql(`DELETE FROM ${namespace}."__DOGSLED_AGENTIC_GUARD"`);
      await expect(store().cursors!.begin(key, signature, 'run-1')).rejects.toThrow('NO_GUARD');
      expect(await emulator.sql(`SELECT * FROM ${namespace}."__DOGSLED_AGENTIC_CURSORS"`)).toEqual(
        []
      );
    });

    it('keeps one header when a run is opened concurrently from new', async () => {
      const { emulator, store } = await open();
      const { key: run } = await mapScenario();
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => store().acquire(run))
      );
      for (const result of results) {
        if (result.status === 'fulfilled') await result.value.release();
      }
      expect(
        await emulator.sql(`SELECT * FROM ${namespace}."__DOGSLED_AGENTIC_RUNS"`)
      ).toHaveLength(1);
    });
  });

  describe('lock queue', () => {
    it('rides out more header updates than the lock queue admits', async () => {
      const { emulator, store } = await open();
      const { key: run, initial } = await mapScenario();
      const runs = Array.from({ length: 30 }, (_, index) => `run-${index}`);
      const sessions = await Promise.all(runs.map((id) => store().acquire({ ...run, id })));
      emulator.lockHoldMs = 20;
      const created = await Promise.allSettled(
        sessions.map((session, index) =>
          session.create({ ...initial, key: { ...run, id: runs[index]! } })
        )
      );
      expect(created.filter((result) => result.status === 'rejected')).toEqual([]);
      expect(emulator.lockRefusals()).toBeGreaterThan(0);
      emulator.lockHoldMs = 0;
      for (const session of sessions) await session.release();
    }, 60_000);
  });

  describe('statements', () => {
    it('stays near four statements per assignment, whatever the engine', async () => {
      const { emulator } = await open();
      const assignments = 50;
      const workload = benchmarkWorkload(assignments, 'map');
      const directory = mkdtempSync(join(tmpdir(), 'row-statements-'));
      // A lease this long renews nothing during the run, so its speed cannot change the count.
      const stateStore = createWarehouseRowStore(emulator.integration, {
        schema: 'checkpoints',
        customRunners: emulator.customRunners,
        leaseMs: 600_000,
      });
      try {
        await executeAgenticRun(workload.host, workload.context(), {
          projectDirectory: directory,
          stateStore,
          run: { id: 'counted', mode: 'start' },
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
      const perAssignment = emulator.statements.length / assignments;
      expect(perAssignment).toBeGreaterThanOrEqual(4);
      expect(perAssignment).toBeLessThan(4.5);
    }, 120_000);
  });

  describe('schemas', () => {
    const creates = (emulator: SnowflakeEmulator) =>
      emulator.statements.filter((sql) => sql.startsWith('CREATE SCHEMA'));

    it('creates a schema that is missing', async () => {
      const { emulator, store } = await open();
      await (await store().acquire((await mapScenario()).key)).release();
      expect(creates(emulator)).toHaveLength(1);
    });

    it('never asks to create a schema that exists', async () => {
      const { emulator, store } = await open();
      await emulator.sql(`CREATE SCHEMA ${namespace}`);
      await (await store().acquire((await mapScenario()).key)).release();
      await store().cursors!.begin(key, signature, 'run-1');
      expect(creates(emulator)).toEqual([]);
    });
  });

  describe('statement limits', () => {
    it('opens each session through the limited runner', async () => {
      const { emulator, store } = await open();
      const session = await store().acquire((await mapScenario()).key);
      await session.release();
      await store().cursors!.begin(key, signature, 'run-1');
      // Half of the 12 second lease, on every session the store opened.
      expect(new Set(emulator.statementLimits)).toEqual(new Set([6_000]));
      expect(emulator.statementLimits.length).toBeGreaterThan(1);
    });
  });
});

describe('the warehouse row store factory', () => {
  const postgres = {
    spec_version: '1',
    type: 'integration',
    name: 'lake',
    source_type: 'postgres',
    connection: { host: 'localhost', port: 5432, database: 'test' },
    auth: { type: 'password', user: 'test', password: 'test' },
  } as const;
  const duckdb: DuckDbIntegration = {
    spec_version: '1',
    type: 'integration',
    name: 'lake',
    source_type: 'duckdb',
    connection: {},
    auth: { type: 'memory' },
  };
  const invalid = { code: 'limit', reason: 'invalid_store_config' };

  it('refuses engines without a dialect', () => {
    expect(() => createWarehouseRowStore(duckdb, { schema: 's' })).toThrow(
      expect.objectContaining(invalid)
    );
  });

  it.each([
    ['an empty schema', { schema: ' ' }],
    ['a lease that is too short', { schema: 's', leaseMs: 9_999 }],
    ['a lease that is too long', { schema: 's', leaseMs: 600_001 }],
    ['no retention', { schema: 's', retentionMs: 0 }],
  ])('refuses %s', (_name, options) => {
    expect(() => createWarehouseRowStore(postgres, options)).toThrow(
      expect.objectContaining(invalid)
    );
  });

  it('refuses a PostgreSQL schema name that the server would truncate', () => {
    const name = (bytes: number) => 's'.repeat(bytes);
    expect(() => createWarehouseRowStore(postgres, { schema: name(64) })).toThrow(
      expect.objectContaining(invalid)
    );
    expect(() => createWarehouseRowStore(postgres, { schema: '語'.repeat(22) })).toThrow(
      expect.objectContaining(invalid)
    );
    expect(() => createWarehouseRowStore(postgres, { schema: name(63) })).not.toThrow();
  });

  it('declares what the row store promises', () => {
    const store = createWarehouseRowStore(postgres, { schema: 's' });
    expect(store.expiresRuns).toBe(true);
    expect(store.limits).toBeDefined();
    expect(store.cursors).toBeDefined();
  });
});
