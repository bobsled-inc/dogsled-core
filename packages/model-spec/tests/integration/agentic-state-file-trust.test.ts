import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildDuckDbRunner, isDuckDbAvailable } from '@bobsled-inc/connections';
import { createDefaultAgenticStateStore } from '../../src/agentic/default-state.js';
import {
  createDuckDbCheckpointStore,
  duckDbHeldBackend,
  duckDbOperationBackend,
  duckDbStateFile,
} from '../../src/agentic/duckdb-state.js';
import { readAgenticRowCursor } from '../../src/agentic/row-cursors.js';
import { digestAgenticState } from '../../src/agentic/state.js';
import { mapScenario, type AgenticStoreScenario } from '../support/agentic-store-scenario.js';

const header = `SELECT 'x' AS run_hash, 'x' AS scope, 'x' AS model, 'x' AS run_id, 1 AS layout,
  0 AS revision, '' AS lease_owner, 0 AS lease_expires, '' AS token, '' AS head, '' AS summary,
  0 AS retain_until, true AS reclaimable`;

/** What someone who can write a state file could leave in it, and what that gets them. */
describe.skipIf(!(await isDuckDbAvailable()))('agentic DuckDB state files', () => {
  let map: AgenticStoreScenario;
  const directories: string[] = [];
  beforeAll(async () => {
    map = await mapScenario();
  });
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  function directory(): string {
    const created = fs.mkdtempSync(join(tmpdir(), 'state-file-'));
    directories.push(created);
    return created;
  }
  async function sql(file: string, statements: string[]): Promise<void> {
    const runner = await buildDuckDbRunner(duckDbStateFile(file));
    try {
      for (const statement of statements) await runner.run(statement);
    } finally {
      await runner.close?.();
    }
  }
  const checkpoints = (file: string) =>
    createDuckDbCheckpointStore(duckDbStateFile(file), { schema: 'checkpoints' });
  const cursorKey = { scope: 'lake', model: 'pairs', target: 'main.pairs' };

  it.each(['runs', 'rows', 'cursors'])(
    'refuses a shared file with a view named like the %s table',
    async (name) => {
      const file = join(directory(), 'state.duckdb');
      await sql(file, [
        'CREATE SCHEMA checkpoints',
        `CREATE VIEW checkpoints.__dogsled_agentic_${name} AS ${header}`,
      ]);
      await expect(checkpoints(file).acquire(map.key)).rejects.toMatchObject({
        code: 'corrupt',
        reason: 'state_table_replaced',
      });
    }
  );

  it.each([
    ['replaces lower', 'CREATE MACRO lower(x) AS x'],
    ['replaces length', 'CREATE MACRO length(x) AS 1'],
    ['replaces sum', 'CREATE MACRO sum(x) AS 1'],
    ['replaces an operator', 'CREATE MACRO "+"(a, b) AS 42'],
    ['replaces the clock', 'CREATE MACRO now() AS 7'],
    ['replaces current_database', `CREATE MACRO current_database() AS 'elsewhere'`],
    ['replaces a catalog function', 'CREATE MACRO duckdb_tables() AS TABLE SELECT 1 AS x'],
    ['hides in another schema', 'CREATE MACRO checkpoints.unrelated() AS 1'],
  ])('refuses a file with a stored macro that %s', async (_, macro) => {
    const file = join(directory(), 'state.duckdb');
    const first = await checkpoints(file).acquire(map.key);
    await first.release();
    await sql(file, [macro]);
    await expect(checkpoints(file).acquire(map.key)).rejects.toMatchObject({
      code: 'corrupt',
      reason: 'state_table_replaced',
    });
  });

  it('is not fooled by decoys and a macro that makes the catalog agree', async () => {
    const file = join(directory(), 'state.duckdb');
    await sql(file, [
      'CREATE SCHEMA checkpoints',
      ...['a', 'b', 'c'].map((name) => `CREATE TABLE checkpoints.decoy_${name} (x INTEGER)`),
      ...['runs', 'rows', 'cursors'].map(
        (name) => `CREATE VIEW checkpoints.__dogsled_agentic_${name} AS ${header}`
      ),
      `CREATE MACRO lower(x) AS replace(x, 'decoy_a', '__dogsled_agentic_runs')`,
    ]);
    await expect(checkpoints(file).acquire(map.key)).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('reports an object that stops the catalog functions from working', async () => {
    const file = join(directory(), 'state.duckdb');
    const first = await checkpoints(file).acquire(map.key);
    await first.release();
    await sql(file, ['CREATE VIEW duckdb_tables AS SELECT 1 AS planted']);
    await expect(checkpoints(file).acquire(map.key)).rejects.toMatchObject({
      code: 'corrupt',
      reason: 'state_table_replaced',
    });
  });

  it.each([
    ['a missing column', 'ALTER TABLE %t DROP COLUMN parts'],
    ['an extra column', 'ALTER TABLE %t ADD COLUMN extra VARCHAR'],
    ['a column of another type', 'ALTER TABLE %t ALTER COLUMN parts TYPE VARCHAR'],
    ['a nullable column', 'ALTER TABLE %t ALTER COLUMN kind DROP NOT NULL'],
    ['a default', `ALTER TABLE %t ALTER COLUMN kind SET DEFAULT 'attempt'`],
  ])('refuses a state table with %s', async (_, change) => {
    const file = join(directory(), 'state.duckdb');
    const first = await checkpoints(file).acquire(map.key);
    await first.release();
    await sql(file, [change.replace('%t', 'checkpoints.__dogsled_agentic_rows')]);
    await expect(checkpoints(file).acquire(map.key)).rejects.toMatchObject({
      code: 'corrupt',
      reason: 'state_table_replaced',
    });
  });

  it('refuses a generated column under the name of a real one', async () => {
    const file = join(directory(), 'state.duckdb');
    const first = await checkpoints(file).acquire(map.key);
    await first.release();
    const rows = 'checkpoints.__dogsled_agentic_rows';
    await sql(file, [
      `DROP TABLE ${rows}`,
      `CREATE TABLE ${rows} (run_hash VARCHAR NOT NULL, write_id VARCHAR NOT NULL, parent VARCHAR NOT NULL, revision BIGINT NOT NULL, operation_id VARCHAR NOT NULL, kind VARCHAR NOT NULL, item BIGINT NOT NULL, part BIGINT NOT NULL, parts BIGINT NOT NULL, data VARCHAR GENERATED ALWAYS AS (repeat('x', 9)))`,
    ]);
    await expect(checkpoints(file).acquire(map.key)).rejects.toMatchObject({
      code: 'corrupt',
      reason: 'state_table_replaced',
    });
  });

  it.each([
    ['an index', 'CREATE INDEX extra ON %t (write_id)'],
    ['an expression index', 'CREATE INDEX extra ON %t ((length(data)))'],
    ['a key', 'ALTER TABLE %t ADD PRIMARY KEY (run_hash, write_id, item, part)'],
  ])('refuses a state table with %s', async (_, change) => {
    const file = join(directory(), 'state.duckdb');
    const first = await checkpoints(file).acquire(map.key);
    await first.release();
    await sql(file, [change.replace('%t', 'checkpoints.__dogsled_agentic_rows')]);
    await expect(checkpoints(file).acquire(map.key)).rejects.toMatchObject({
      code: 'corrupt',
      reason: 'state_table_replaced',
    });
  });

  it('refuses a state table with a check constraint', async () => {
    const file = join(directory(), 'state.duckdb');
    const first = await checkpoints(file).acquire(map.key);
    await first.release();
    const cursors = 'checkpoints.__dogsled_agentic_cursors';
    await sql(file, [
      `DROP TABLE ${cursors}`,
      `CREATE TABLE ${cursors} (key_hash VARCHAR NOT NULL, scope VARCHAR NOT NULL, model VARCHAR NOT NULL, target VARCHAR NOT NULL, version BIGINT NOT NULL CHECK (version < 0), record VARCHAR NOT NULL)`,
    ]);
    await expect(checkpoints(file).acquire(map.key)).rejects.toMatchObject({
      code: 'corrupt',
      reason: 'state_table_replaced',
    });
  });

  it('accepts an index on something that is not a state table', async () => {
    const file = join(directory(), 'state.duckdb');
    await sql(file, [
      'CREATE TABLE unrelated (id INTEGER)',
      'CREATE INDEX extra ON unrelated (id)',
    ]);
    const session = await checkpoints(file).acquire(map.key);
    await session.release();
  });

  it.each([
    ['a stored macro', 'CREATE MACRO length(x) AS 0'],
    ['an index', 'CREATE INDEX extra ON checkpoints.__dogsled_agentic_rows (write_id)'],
    [
      'a nullable column',
      'ALTER TABLE checkpoints.__dogsled_agentic_rows ALTER kind DROP NOT NULL',
    ],
  ])('finds %s added between two operations on a checkpoint file', async (_, change) => {
    const file = join(directory(), 'state.duckdb');
    const session = await checkpoints(file).acquire(map.key);
    await session.create(map.initial);
    await sql(file, [change]);
    await expect(session.read()).rejects.toMatchObject({
      code: 'corrupt',
      reason: 'state_table_replaced',
    });
    await session.release().catch(() => {});
  });

  it('accepts its own tables, however the schema was first spelled', async () => {
    const file = join(directory(), 'state.duckdb');
    await sql(file, ['CREATE SCHEMA "Checkpoints"']);
    const session = await checkpoints(file).acquire(map.key);
    await session.release();
  });

  it('looks only in its own schema', async () => {
    const file = join(directory(), 'state.duckdb');
    const first = await checkpoints(file).acquire(map.key);
    await first.release();
    const store = createDuckDbCheckpointStore(duckDbStateFile(file), { schema: 'other' });
    await sql(file, [
      'CREATE SCHEMA other',
      `CREATE VIEW other.__dogsled_agentic_runs AS ${header}`,
    ]);
    await expect(store.acquire(map.key)).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('tells the tables of two schemas in one file apart', async () => {
    const file = join(directory(), 'state.duckdb');
    const first = await checkpoints(file).acquire(map.key);
    await first.release();
    const store = createDuckDbCheckpointStore(duckDbStateFile(file), { schema: 'other' });
    const second = await store.acquire(map.key);
    await second.release();
  });

  it('refuses a cursor read from a file with a planted view', async () => {
    const file = join(directory(), 'cursors.duckdb');
    await sql(file, ['CREATE VIEW __dogsled_agentic_cursors AS SELECT 1 AS record']);
    await expect(
      readAgenticRowCursor(duckDbOperationBackend(file, 'main'), cursorKey)
    ).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('refuses a run file with a planted view', async () => {
    const project = directory();
    const store = createDefaultAgenticStateStore(project);
    const session = await store.acquire(map.key);
    await session.create(map.initial);
    await session.release();
    const file = join(
      project,
      `.dogsled/model-spec/agentic-state/run-${digestAgenticState(map.key)}.duckdb`
    );
    await sql(file, [
      'DROP TABLE __dogsled_agentic_runs',
      `CREATE VIEW __dogsled_agentic_runs AS ${header}`,
    ]);
    await expect(store.acquire(map.key)).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('does not let a planted view expire a run file', async () => {
    const project = directory();
    const store = createDefaultAgenticStateStore(project, { retentionMs: 1 });
    const session = await store.acquire(map.key);
    await session.create(map.initial);
    await session.release();
    const file = join(
      project,
      `.dogsled/model-spec/agentic-state/run-${digestAgenticState(map.key)}.duckdb`
    );
    await sql(file, [
      'DROP TABLE __dogsled_agentic_runs',
      `CREATE VIEW __dogsled_agentic_runs AS ${header}`,
    ]);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
    const other = await store.acquire({ ...map.key, id: 'other' });
    await other.release();
    expect(fs.existsSync(file)).toBe(true);
  });

  it.each([
    ['opened per operation', (file: string) => duckDbOperationBackend(file, 'main')],
    ['held for a session', (file: string) => duckDbHeldBackend(file)],
  ])('cannot read another file from a state file %s', async (_, backend) => {
    const root = directory();
    const other = join(root, 'other.txt');
    fs.writeFileSync(other, 'not for this file');
    const connection = await backend(join(root, 'state.duckdb')).connect();
    try {
      await expect(
        connection.use((db) => db.query(`SELECT content FROM read_text('${other}')`))
      ).rejects.toThrow('disabled by configuration');
    } finally {
      await connection.close();
    }
  });
});
