import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveRunner } from '@bobsled-inc/connections';
import { AgenticCursorConflict } from '../../../src/agentic/cursor.js';
import { agenticRowDb } from '../../../src/agentic/row-state-dialect.js';
import { createAgenticRowWrite } from '../../../src/agentic/row-state-layout.js';
import { insertAgenticWrite } from '../../../src/agentic/row-state-rows.js';
import { createWarehouseAgenticCursorStore } from '../../../src/agentic/warehouse-cursors.js';
import { postgresRowDialect } from '../../../src/agentic/warehouse-row-dialects.js';
import { createWarehouseRowStore } from '../../../src/agentic/warehouse-row-state.js';
import { mapScenario } from '../../support/agentic-store-scenario.js';
import { postgresIntegration as integration } from '../../support/row-store-integrations.js';

const enabled =
  process.env.DOGSLED_MODEL_SPEC_INTEGRATION_WAREHOUSE?.split(',').includes('postgres');
async function sql<T extends Record<string, unknown>>(statement: string): Promise<T[]> {
  const runner = await resolveRunner(integration());
  try {
    return (await runner.query!(statement)) as T[];
  } finally {
    await runner.close?.();
  }
}
const key = { scope: 'lake', model: 'pairs', target: 'main.pairs' };
const signature = 'a'.repeat(64);

describe.skipIf(!enabled)('PostgreSQL row store', { timeout: 60_000 }, () => {
  const schemas: string[] = [];
  const schema = () => {
    const name = `row_store_${randomUUID().replaceAll('-', '')}`;
    schemas.push(name);
    return name;
  };
  afterEach(async () => {
    for (const name of schemas.splice(0)) await sql(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
  });

  it('carries progress over from the warehouse store, once', async () => {
    const name = schema();
    const old = createWarehouseAgenticCursorStore(integration(), { schema: name });
    await old.begin(key, signature, 'old-run');
    await old.commit(key, signature, 'old-run', { pairs: 5 });

    const cursors = createWarehouseRowStore(integration(), { schema: name }).cursors!;
    expect(await cursors.begin(key, signature, 'new-run')).toEqual({ pairs: 5 });
    await cursors.commit(key, signature, 'new-run', { pairs: 7 });

    // The old store moves on, and the row store must not notice.
    await old.begin(key, signature, 'old-run-2');
    await old.commit(key, signature, 'old-run-2', { pairs: 9 });
    expect(await cursors.begin(key, signature, 'next')).toEqual({ pairs: 7 });
  });

  it('refuses a key that a run in the warehouse store still holds', async () => {
    const name = schema();
    const old = createWarehouseAgenticCursorStore(integration(), { schema: name });
    await old.begin(key, signature, 'old-run');
    const store = createWarehouseRowStore(integration(), { schema: name });
    await expect(store.cursors!.begin(key, signature, 'new-run')).rejects.toMatchObject({
      code: 'conflict',
      reason: 'cursor_held_elsewhere',
    });
    const rows = await sql(`SELECT 1 FROM "${name}"."__dogsled_agentic_cursors"`).catch(() => []);
    expect(rows).toEqual([]);
  });

  it('starts empty in a schema the warehouse store never used', async () => {
    const store = createWarehouseRowStore(integration(), { schema: schema() });
    expect(await store.cursors!.begin(key, signature, 'run')).toEqual({});
    await expect(store.cursors!.begin(key, signature, 'other')).rejects.toBeInstanceOf(
      AgenticCursorConflict
    );
  });

  it('keeps one row per key whatever the concurrency, because the key is enforced', async () => {
    const name = schema();
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        createWarehouseRowStore(integration(), { schema: name }).cursors!.begin(
          key,
          signature,
          `run-${index}`
        )
      )
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await sql(`SELECT * FROM "${name}"."__dogsled_agentic_cursors"`)).toHaveLength(1);
  });

  it('treats a write that is repeated after a lost reply as the same write', async () => {
    const name = schema();
    const { key: run } = await mapScenario();
    const session = await createWarehouseRowStore(integration(), { schema: name }).acquire(run);
    await session.release();
    const runner = await resolveRunner(integration());
    try {
      const write = createAgenticRowWrite('', 0, 'create', [{ kind: 'definition', data: '{}' }]);
      const rows = {
        db: agenticRowDb(runner),
        dialect: postgresRowDialect,
        table: `"${name}"."__dogsled_agentic_rows"`,
        hash: 'h'.repeat(64),
      };
      await insertAgenticWrite(rows, write, async () => {});
      await insertAgenticWrite(rows, write, async () => {});
    } finally {
      await runner.close?.();
    }
    expect(await sql(`SELECT 1 FROM "${name}"."__dogsled_agentic_rows"`)).toHaveLength(1);
  });

  it('declares the keys it relies on', async () => {
    const name = schema();
    const { key: run } = await mapScenario();
    const session = await createWarehouseRowStore(integration(), { schema: name }).acquire(run);
    await session.release();
    const keys = await sql<{ table_name: string; columns: string }>(
      `SELECT t.relname AS table_name, pg_get_indexdef(i.indexrelid) AS columns
         FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = '${name}' AND i.indisprimary ORDER BY 1`
    );
    expect(keys.map((row) => row.table_name)).toEqual([
      '__dogsled_agentic_cursors',
      '__dogsled_agentic_rows',
      '__dogsled_agentic_runs',
    ]);
    expect(keys[1]!.columns).toContain('(run_hash, write_id, item, part)');
  });
});
