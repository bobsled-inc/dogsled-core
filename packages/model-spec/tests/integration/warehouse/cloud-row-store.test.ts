import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveRunner } from '@bobsled-inc/connections';
import { agenticRowDb } from '../../../src/agentic/row-state-dialect.js';
import { createWarehouseAgenticCursorStore } from '../../../src/agentic/warehouse-cursors.js';
import { snowflakeRowDialect } from '../../../src/agentic/warehouse-row-dialects.js';
import { createWarehouseRowStore } from '../../../src/agentic/warehouse-row-state.js';
import { caseName, quoteIdentifier } from '../../../src/compiler/dialect.js';
import {
  describeAgenticStoreConformance,
  type StoreHandle,
} from '../../support/agentic-store-conformance.js';
import { snowflakeIntegration } from '../../support/row-store-integrations.js';

const baseSchema = process.env.DOGSLED_MODEL_SPEC_CHECKPOINT_SCHEMA;
const snowflake = await snowflakeIntegration();

const q = (name: string) => quoteIdentifier(caseName(name, 'snowflake'), 'snowflake');
const database = snowflake?.connection.database;
const qualified = (schema: string) => [...(database ? [database] : []), schema].map(q).join('.');
async function sql(statement: string): Promise<Record<string, unknown>[]> {
  const runner = await resolveRunner(snowflake!);
  try {
    return await runner.query!(statement);
  } finally {
    await runner.close?.();
  }
}
/** Every test gets a schema of its own, which is the only thing this suite ever drops. */
const testSchema = () => `${baseSchema}_row_${randomUUID().replaceAll('-', '')}`;
const dropSchema = (schema: string) => sql(`DROP SCHEMA IF EXISTS ${qualified(schema)} CASCADE`);

const schemas = new WeakMap<StoreHandle, string>();
const rows = (schema: string, retentionMs = 86_400_000) =>
  createWarehouseRowStore(snowflake!, { schema, retentionMs });
const table = (handle: StoreHandle, name: string) =>
  `${qualified(schemas.get(handle)!)}.${q(name)}`;

describe.skipIf(!snowflake)('Snowflake row store', () => {
  describeAgenticStoreConformance({
    name: 'Snowflake row layout',
    timeoutMs: 900_000,
    open: async () => {
      const schema = testSchema();
      const handle: StoreHandle = {
        store: rows(schema),
        reopen: () => rows(schema),
        cleanup: async () => {
          await dropSchema(schema);
        },
      };
      schemas.set(handle, schema);
      return handle;
    },
    expireLease: async (handle) => {
      await sql(`UPDATE ${table(handle, '__dogsled_agentic_runs')} SET ${q('lease_expires')} = 0`);
    },
    withRetention: (handle, retentionMs) => rows(schemas.get(handle)!, retentionMs),
    damage: async (handle) => {
      await sql(
        `UPDATE ${table(handle, '__dogsled_agentic_rows')} SET ${q('data')} = '{"damaged":1}'`
      );
    },
  });

  describe('what the dialect assumes', { timeout: 300_000 }, () => {
    it('reads one clock whatever the session time zone', async () => {
      const runner = await resolveRunner(snowflake!);
      try {
        const clock = async (zone: string) => {
          await runner.run(`ALTER SESSION SET TIMEZONE = '${zone}'`);
          const [row] = await runner.query!(`SELECT ${snowflakeRowDialect.clock} AS ${q('clock')}`);
          return Number(row!.CLOCK);
        };
        const tokyo = await clock('Asia/Tokyo');
        const angeles = await clock('America/Los_Angeles');
        expect(Math.abs(tokyo - Date.now())).toBeLessThan(300_000);
        expect(Math.abs(angeles - Date.now())).toBeLessThan(300_000);
      } finally {
        await runner.close?.();
      }
    });

    it('reports the rows an update changed as the dialect reads them', async () => {
      const schema = testSchema();
      const name = `${qualified(schema)}.${q('probe')}`;
      const runner = await resolveRunner(snowflake!);
      try {
        await runner.run(`CREATE SCHEMA IF NOT EXISTS ${qualified(schema)}`);
        await runner.run(`CREATE TABLE ${name} (${q('a')} BIGINT)`);
        await runner.run(`INSERT INTO ${name} VALUES (1), (2)`);
        const db = agenticRowDb(runner);
        const set = `UPDATE ${name} SET ${q('a')} = ${q('a')} + 10`;
        expect(await snowflakeRowDialect.changed(db, `${set} WHERE ${q('a')} = ?`, [1])).toBe(1);
        expect(await snowflakeRowDialect.changed(db, `${set} WHERE ${q('a')} = ?`, [99])).toBe(0);
        expect(await snowflakeRowDialect.changed(db, set, [])).toBe(2);
      } finally {
        await runner.close?.();
        await dropSchema(schema);
      }
    });

    it('carries progress over from the warehouse store, once', async () => {
      const schema = testSchema();
      const key = { scope: 'row-store-test', model: randomUUID(), target: 'cursor-test' };
      const signature = 'a'.repeat(64);
      try {
        const old = createWarehouseAgenticCursorStore(snowflake!, { schema });
        await old.begin(key, signature, 'old-run');
        await old.commit(key, signature, 'old-run', { pairs: 5 });
        const cursors = rows(schema).cursors!;
        expect(await cursors.begin(key, signature, 'new-run')).toEqual({ pairs: 5 });
        await cursors.commit(key, signature, 'new-run', { pairs: 7 });
        await old.begin(key, signature, 'old-run-2');
        await old.commit(key, signature, 'old-run-2', { pairs: 9 });
        expect(await cursors.begin(key, signature, 'next')).toEqual({ pairs: 7 });
      } finally {
        await dropSchema(schema);
      }
    });
  });
});
