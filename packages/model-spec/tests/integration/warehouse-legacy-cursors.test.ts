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
        `CREATE TABLE IF NOT EXISTS ${namespace}."__DOGSLED_CURSORS" ("KEY" VARCHAR, "RECORD" VARCHAR, "TOKEN" VARCHAR)`
      );
      await emulator.sql(
        `INSERT INTO ${namespace}."__DOGSLED_CURSORS" VALUES ('${digestAgenticState(key)}', '${record}', 't')`
      );
    };
    const cursorRows = () =>
      emulator.sql(`SELECT "RECORD" FROM ${namespace}."__DOGSLED_AGENTIC_CURSORS"`).catch(() => []);
    return { emulator, store, legacy, cursorRows };
  }

  it('reads the old value of a new key once', async () => {
    const { emulator, store, legacy } = await open();
    await legacy(legacyRecord(null));
    const cursors = store().cursors!;
    expect(await cursors.begin(key, signature, 'run-1')).toEqual({ pairs: 5 });
    await cursors.commit(key, signature, 'run-1', { pairs: 7 });
    await emulator.sql(
      `UPDATE ${namespace}."__DOGSLED_CURSORS" SET "RECORD" = '${legacyRecord(null).replace('5', '9')}'`
    );
    expect(await store().cursors!.begin(key, signature, 'run-2')).toEqual({ pairs: 7 });
  });

  it('starts empty when the old table was never created', async () => {
    const { emulator, store } = await open();
    expect(await store().cursors!.begin(key, signature, 'run-1')).toEqual({});
    expect(emulator.statements.filter((sql) => sql.includes('__DOGSLED_CURSORS"'))).toEqual([]);
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
    expect(emulator.statements.join('\n')).not.toContain('__DOGSLED_CURSORS"');
  });
});
