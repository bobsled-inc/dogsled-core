import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { isDuckDbAvailable, type DuckDbIntegration } from '@bobsled-inc/connections';
import type { AgenticCursorKey } from '../../src/agentic/cursor.js';
import { agenticRowDb } from '../../src/agentic/row-state-dialect.js';
import {
  agenticHeaderTableName,
  agenticHeaderTableNames,
} from '../../src/agentic/row-state-tables.js';
import { digestAgenticState, type AgenticRunKey } from '../../src/agentic/state.js';
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
const quotedTable = (name: string) => `${namespace}."${name.toUpperCase()}"`;
/** The table a run's header belongs in, by the rule the store must follow. */
const tableOf = (run: AgenticRunKey) =>
  agenticHeaderTableName(digestAgenticState(run), snowflakeRowDialect.headerTables[0]!);
const headerRows = async (emulator: SnowflakeEmulator) =>
  (
    await Promise.all(
      agenticHeaderTableNames(snowflakeRowDialect).map((name) =>
        emulator.sql(`SELECT * FROM ${quotedTable(name)}`)
      )
    )
  ).flat();
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
      await expect(store().cursors!.begin(key, signature, 'run-1')).rejects.toMatchObject({
        code: 'corrupt',
        reason: 'state_table_replaced',
      });
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
      expect(await headerRows(emulator)).toHaveLength(1);
    });
  });

  describe('header tables', () => {
    /** Run keys whose hashes pick tables as asked. The hash is fixed, so a search finds them. */
    const keyIn = (
      run: AgenticRunKey,
      wanted: (table: string, id: string) => boolean
    ): AgenticRunKey => {
      for (let index = 0; ; index++) {
        const candidate = { ...run, id: `run-${index}` };
        if (wanted(tableOf(candidate), candidate.id)) return candidate;
      }
    };
    const pending = () => new Promise<'waiting'>((done) => setTimeout(() => done('waiting'), 150));

    it('keeps a header in the one table the run hashes to, and finds it there', async () => {
      const { emulator, store } = await open();
      const { key: run, initial } = await mapScenario();
      const session = await store().acquire(run);
      await session.create(initial);
      await session.release();
      for (const name of agenticHeaderTableNames(snowflakeRowDialect)) {
        const rows = await emulator.sql(`SELECT 1 FROM ${quotedTable(name)}`);
        expect(rows).toHaveLength(name === tableOf(run) ? 1 : 0);
      }
      const resumed = await store().acquire(run);
      expect(await resumed.read()).toEqual(initial);
      await resumed.release();
    });

    it('lets runs in different tables write while one table is locked', async () => {
      const { emulator, store } = await open();
      const { key: base, initial } = await mapScenario();
      const blocked = keyIn(base, () => true);
      const free = keyIn(base, (table) => table !== tableOf(blocked));
      const [first, second] = [await store().acquire(blocked), await store().acquire(free)];
      const release = await emulator.holdLock(quotedTable(tableOf(blocked)));
      const waiting = first.create({ ...initial, key: blocked });
      // The other run finishes while the first still waits for its table.
      await second.create({ ...initial, key: free });
      expect(await Promise.race([waiting, pending()])).toBe('waiting');
      release();
      await waiting;
      await first.release();
      await second.release();
    });

    it('queues runs that share a table, so the test above means something', async () => {
      const { emulator, store } = await open();
      const { key: base, initial } = await mapScenario();
      const one = keyIn(base, () => true);
      const other = keyIn(base, (table, id) => table === tableOf(one) && id !== one.id);
      const [first, second] = [await store().acquire(one), await store().acquire(other)];
      const release = await emulator.holdLock(quotedTable(tableOf(one)));
      const waiting = second.create({ ...initial, key: other });
      expect(await Promise.race([waiting, pending()])).toBe('waiting');
      release();
      await waiting;
      await first.release();
      await second.release();
    });

    it('purges an expired run from a table the acquiring run does not use', async () => {
      const { emulator, store } = await open();
      const { key: base } = await mapScenario();
      const old = keyIn(base, () => true);
      const session = await store().acquire(old);
      await session.release();
      await emulator.sql(`UPDATE ${quotedTable(tableOf(old))} SET "RETAIN_UNTIL" = 0`);
      const elsewhere = keyIn({ ...base, model: 'other' }, (table) => table !== tableOf(old));
      await (await store().acquire(elsewhere)).release();
      expect(await emulator.sql(`SELECT 1 FROM ${quotedTable(tableOf(old))}`)).toEqual([]);
    });

    it('sends one statement to look for expired runs, however many tables there are', async () => {
      const { emulator, store } = await open();
      const { key: run } = await mapScenario();
      await (await store().acquire(run)).release();
      emulator.statements.length = 0;
      await (await store().acquire({ ...run, id: 'second' })).release();
      const looking = emulator.statements.filter((sql) => sql.includes('"RETAIN_UNTIL" <='));
      expect(looking).toHaveLength(1);
      for (const name of agenticHeaderTableNames(snowflakeRowDialect)) {
        expect(looking[0]).toContain(quotedTable(name));
      }
    });

    it('reports a view in place of any header table', async () => {
      const { emulator, store } = await open();
      const { key: run } = await mapScenario();
      await (await store().acquire(run)).release();
      const name = quotedTable(agenticHeaderTableNames(snowflakeRowDialect).at(-1)!);
      await emulator.sql(`ALTER TABLE ${name} RENAME TO kept_header`);
      await emulator.sql(`CREATE VIEW ${name} AS SELECT * FROM ${namespace}.kept_header`);
      await expect(store().acquire({ ...run, id: 'next' })).rejects.toMatchObject({
        code: 'corrupt',
        reason: 'state_table_replaced',
      });
    });

    it('creates the tables once and checks them with one statement after that', async () => {
      const { emulator, store } = await open();
      const { key: run } = await mapScenario();
      await (await store().acquire(run)).release();
      expect(emulator.statements.filter((sql) => sql.startsWith('CREATE TABLE')).length).toBe(
        agenticHeaderTableNames(snowflakeRowDialect).length + 3
      );
      emulator.statements.length = 0;
      await (await store().acquire({ ...run, id: 'second' })).release();
      expect(emulator.statements.filter((sql) => sql.startsWith('CREATE'))).toEqual([]);
    });

    it('keeps a run in flight when a later version changes the number of tables', async () => {
      const { emulator, store } = await open();
      const { key: run, initial } = await mapScenario();
      const original = snowflakeRowDialect.headerTables;
      const before = tableOf(run);
      const session = await store().acquire(run);
      await session.create(initial);
      await session.release();
      try {
        Object.assign(snowflakeRowDialect, { headerTables: [32, ...original] });
        const resumed = await store().acquire(run);
        expect(await resumed.read()).toEqual(initial);
        await resumed.release();
        const newer = agenticHeaderTableName(digestAgenticState(run), 32);
        expect(await emulator.sql(`SELECT 1 FROM ${quotedTable(newer)}`)).toEqual([]);
        expect(await emulator.sql(`SELECT 1 FROM ${quotedTable(before)}`)).toHaveLength(1);

        const next = { ...run, id: 'started-after-the-change' };
        await (await store().acquire(next)).release();
        const fresh = agenticHeaderTableName(digestAgenticState(next), 32);
        expect(await emulator.sql(`SELECT 1 FROM ${quotedTable(fresh)}`)).toHaveLength(1);

        await emulator.sql(`UPDATE ${quotedTable(before)} SET "RETAIN_UNTIL" = 0`);
        await (await store().acquire({ ...run, id: 'purger' })).release();
        expect(await emulator.sql(`SELECT 1 FROM ${quotedTable(before)}`)).toEqual([]);
      } finally {
        Object.assign(snowflakeRowDialect, { headerTables: original });
      }
    });

    it('spreads runs across the set', () => {
      const tables = new Set(
        Array.from({ length: 400 }, (_, index) =>
          agenticHeaderTableName(digestAgenticState({ scope: 's', model: 'm', id: `${index}` }), 8)
        )
      );
      expect(tables.size).toBe(8);
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
      const { emulator, store } = await open();
      // Only a schema's first run creates its tables, so count a run after that.
      await (await store().acquire((await mapScenario()).key)).release();
      emulator.statements.length = 0;
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
      // What one header table took. More tables must not cost a run anything.
      expect(perAssignment).toBeLessThan(4.34);
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
