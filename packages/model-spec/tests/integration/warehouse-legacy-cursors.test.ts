import { afterEach, describe, expect, it } from 'vitest';
import { isDuckDbAvailable } from '@bobsled-inc/connections';
import { AgenticCursorConflict, type AgenticCursorKey } from '../../src/agentic/cursor.js';
import { digestAgenticState } from '../../src/agentic/state.js';
import { createWarehouseRowStore } from '../../src/agentic/warehouse-row-state.js';
import { createSnowflakeEmulator, type SnowflakeEmulator } from '../support/snowflake-emulator.js';

const namespace = '"MEMORY"."CHECKPOINTS"';
const key: AgenticCursorKey = { scope: 'lake', model: 'pairs', target: 'main.pairs' };
const signature = 'a'.repeat(64);
const legacyRecord = (activeRun: string | null, committedRun = 'earlier') =>
  JSON.stringify({ signature, values: { pairs: 5 }, activeRun, committedRun });

describe.skipIf(!(await isDuckDbAvailable()))('cursors from the warehouse store', () => {
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
    /** Creates the warehouse store's cursor table with one row for `key`. */
    const legacy = async (record: string) => {
      await emulator.sql(`CREATE SCHEMA IF NOT EXISTS ${namespace}`);
      await emulator.sql(
        `CREATE TABLE IF NOT EXISTS ${namespace}."__BOBSLED_CURSORS" ("KEY" VARCHAR, "RECORD" VARCHAR, "TOKEN" VARCHAR)`
      );
      await emulator.sql(
        `INSERT INTO ${namespace}."__BOBSLED_CURSORS" VALUES ('${digestAgenticState(key)}', '${record}', 't')`
      );
    };
    const cursorRows = async () => {
      const rows = await emulator
        .sql(`SELECT "VERSION", "RECORD" FROM ${namespace}."__BOBSLED_AGENTIC_CURSORS"`)
        .catch(() => []);
      return rows.map((row) => ({ VERSION: Number(row.VERSION), RECORD: String(row.RECORD) }));
    };
    return { emulator, store, legacy, cursorRows };
  }
  const landing = /^UPDATE .*__BOBSLED_AGENTIC_CURSORS.* SET "RECORD" = \?, "VERSION" = 0/;

  it('reads the old value of a new key once', async () => {
    const { emulator, store, legacy } = await open();
    await legacy(legacyRecord(null));
    const cursors = store().cursors!;
    expect(await cursors.begin(key, signature, 'run-1')).toEqual({ pairs: 5 });
    await cursors.commit(key, signature, 'run-1', { pairs: 7 });
    await emulator.sql(
      `UPDATE ${namespace}."__BOBSLED_CURSORS" SET "RECORD" = '${legacyRecord(null).replace('5', '9')}'`
    );
    expect(await store().cursors!.begin(key, signature, 'run-2')).toEqual({ pairs: 7 });
  });

  it('sends a carried record as a bound value, never as a literal', async () => {
    const { emulator, store, legacy, cursorRows } = await open();
    const committedRun = 'easy-to-find-in-a-script';
    await legacy(legacyRecord(null, committedRun));
    await store().cursors!.begin(key, signature, 'run-1');
    expect(emulator.statements.filter((sql) => sql.startsWith('EXECUTE IMMEDIATE'))).not.toEqual(
      []
    );
    expect(emulator.statements.join('\n')).not.toContain(committedRun);
    const [row] = await cursorRows();
    expect(row!.RECORD).toContain(committedRun);
  });

  it('leads back to the old value after a crash before the record landed', async () => {
    const { emulator, store, legacy, cursorRows } = await open();
    await legacy(legacyRecord(null));
    emulator.crashBefore = landing;
    await expect(store().cursors!.begin(key, signature, 'run-1')).rejects.toThrow('connection');
    expect(await cursorRows()).toEqual([{ VERSION: -1, RECORD: '' }]);
    // A new process: the empty row must not read as a key with no progress.
    expect(await store().cursors!.begin(key, signature, 'run-1')).toEqual({ pairs: 5 });
  });

  it('still refuses a key an old run holds after such a crash', async () => {
    const { emulator, store, legacy, cursorRows } = await open();
    await legacy(legacyRecord('run-1'));
    emulator.crashBefore = landing;
    await expect(store().cursors!.begin(key, signature, 'run-1')).rejects.toThrow('connection');
    await emulator.sql(
      `UPDATE ${namespace}."__BOBSLED_CURSORS" SET "RECORD" = '${legacyRecord('old-run')}'`
    );
    await expect(store().cursors!.begin(key, signature, 'run-2')).rejects.toMatchObject({
      reason: 'cursor_held_elsewhere',
    });
    expect(await cursorRows()).toEqual([{ VERSION: -1, RECORD: '' }]);
  });

  it('starts empty if the old value is gone by the time a crash is recovered', async () => {
    const { emulator, store, legacy, cursorRows } = await open();
    await legacy(legacyRecord(null));
    emulator.crashBefore = landing;
    await expect(store().cursors!.begin(key, signature, 'run-1')).rejects.toThrow('connection');
    await emulator.sql(`DELETE FROM ${namespace}."__BOBSLED_CURSORS"`);
    expect(await store().cursors!.begin(key, signature, 'run-1')).toEqual({});
    expect((await cursorRows())[0]!.VERSION).toBe(1);
  });

  it('carries the value once when runs race on a new key', async () => {
    const { store, legacy, cursorRows } = await open();
    await legacy(legacyRecord(null));
    const runs = Array.from({ length: 6 }, (_, index) => `run-${index}`);
    const results = await Promise.allSettled(
      runs.map((run) => store().cursors!.begin(key, signature, run))
    );
    const winners = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []
    );
    expect(winners).toEqual([{ pairs: 5 }]);
    expect(await cursorRows()).toHaveLength(1);
  });

  it('starts empty when the old table was never created', async () => {
    const { emulator, store } = await open();
    expect(await store().cursors!.begin(key, signature, 'run-1')).toEqual({});
    expect(emulator.statements.filter((sql) => sql.includes('__BOBSLED_CURSORS"'))).toEqual([]);
  });

  it('starts empty when the old table has no value for the key', async () => {
    const { store, legacy } = await open();
    await legacy(legacyRecord(null));
    const other = { ...key, target: 'main.other' };
    expect(await store().cursors!.begin(other, signature, 'run-1')).toEqual({});
  });

  it('refuses a key an unfinished old run still holds, and writes nothing', async () => {
    const { store, legacy, cursorRows } = await open();
    await legacy(legacyRecord('old-run'));
    await expect(store().cursors!.begin(key, signature, 'run-1')).rejects.toMatchObject({
      code: 'conflict',
      reason: 'cursor_held_elsewhere',
    });
    expect(await cursorRows()).toEqual([]);
  });

  it('lets the run that holds the old reservation carry on', async () => {
    const { store, legacy } = await open();
    await legacy(legacyRecord('run-1'));
    const cursors = store().cursors!;
    expect(await cursors.begin(key, signature, 'run-1')).toEqual({ pairs: 5 });
    await expect(cursors.begin(key, signature, 'run-2')).rejects.toBeInstanceOf(
      AgenticCursorConflict
    );
  });

  it('stops rather than start over when the old record is damaged', async () => {
    const { store, legacy, cursorRows } = await open();
    await legacy('{"not":"a cursor"}');
    await expect(store().cursors!.begin(key, signature, 'run-1')).rejects.toMatchObject({
      code: 'corrupt',
    });
    expect(await cursorRows()).toEqual([]);
  });

  it('stops rather than start over when the old table holds the key twice', async () => {
    const { store, legacy, cursorRows } = await open();
    await legacy(legacyRecord(null));
    await legacy(legacyRecord(null));
    await expect(store().cursors!.begin(key, signature, 'run-1')).rejects.toMatchObject({
      code: 'corrupt',
    });
    expect(await cursorRows()).toEqual([]);
  });

  it('never touches the old table for a key that already has a row', async () => {
    const { emulator, store, legacy } = await open();
    await store().cursors!.begin(key, signature, 'run-1');
    await legacy(legacyRecord(null));
    emulator.statements.length = 0;
    await store().cursors!.begin(key, signature, 'run-1');
    expect(emulator.statements.join('\n')).not.toContain('__BOBSLED_CURSORS"');
  });
});
