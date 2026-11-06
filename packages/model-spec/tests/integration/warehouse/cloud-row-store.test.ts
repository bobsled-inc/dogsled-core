import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CustomRunnerRegistry, resolveRunner } from '@bobsled-inc/connections';
import { agenticRowDb } from '../../../src/agentic/row-state-dialect.js';
import { agenticHeaderTableName } from '../../../src/agentic/row-state-tables.js';
import { digestAgenticState } from '../../../src/agentic/state.js';
import { createAgenticRowWrite } from '../../../src/agentic/row-state-layout.js';
import { insertAgenticWrite } from '../../../src/agentic/row-state-rows.js';
import { createWarehouseAgenticCursorStore } from '../../../src/agentic/warehouse-cursors.js';
import { snowflakeRowDialect } from '../../../src/agentic/warehouse-row-dialects.js';
import { createWarehouseRowStore } from '../../../src/agentic/warehouse-row-state.js';
import { openLimitedRunner } from '../../../src/agentic/warehouse-statement-limit.js';
import { caseName, quoteIdentifier } from '../../../src/compiler/dialect.js';
import {
  describeAgenticStoreConformance,
  type StoreHandle,
} from '../../support/agentic-store-conformance.js';
import { hostRunners, snowflakeIntegration } from '../../support/row-store-integrations.js';

const baseSchema = process.env.DOGSLED_MODEL_SPEC_CHECKPOINT_SCHEMA;
const snowflake = await snowflakeIntegration();
const runners = await hostRunners();

const q = (name: string) => quoteIdentifier(caseName(name, 'snowflake'), 'snowflake');
const database = snowflake?.connection.database;
const qualified = (schema: string) => [...(database ? [database] : []), schema].map(q).join('.');
async function sql(statement: string): Promise<Record<string, unknown>[]> {
  const runner = await resolveRunner(snowflake!, runners);
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
  createWarehouseRowStore(snowflake!, { schema, retentionMs, ...runners });
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
    expireLease: async (handle, key) => {
      const header = agenticHeaderTableName(
        digestAgenticState(key),
        snowflakeRowDialect.headerTables[0]!
      );
      await sql(`UPDATE ${table(handle, header)} SET ${q('lease_expires')} = 0`);
    },
    withRetention: (handle, retentionMs) => rows(schemas.get(handle)!, retentionMs),
    damage: async (handle) => {
      await sql(
        `UPDATE ${table(handle, '__dogsled_agentic_rows')} SET ${q('data')} = '{"damaged":1}'`
      );
    },
    replaceRowsTable: async (handle) => {
      const rowsTable = table(handle, '__dogsled_agentic_rows');
      const kept = table(handle, 'kept_rows');
      await sql(`ALTER TABLE ${rowsTable} RENAME TO ${kept}`);
      await sql(`CREATE VIEW ${rowsTable} AS SELECT * FROM ${kept}`);
    },
    addComputedColumn: async (handle) => {
      await sql(
        `ALTER TABLE ${table(handle, '__dogsled_agentic_rows')} ADD COLUMN ${q('computed')} VARCHAR DEFAULT 'x'`
      );
    },
  });

  describe('what the dialect assumes', { timeout: 300_000 }, () => {
    it('reads one clock whatever the session time zone', async () => {
      const runner = await resolveRunner(snowflake!, runners);
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
      const runner = await resolveRunner(snowflake!, runners);
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

    it('accepts the largest INSERT the row bounds allow', async () => {
      const schema = testSchema();
      const runner = await resolveRunner(snowflake!, runners);
      try {
        const session = await rows(schema).acquire({ scope: 'size', model: 'probe', id: 'run' });
        await session.release();
        const table = `${qualified(schema)}.${q('__dogsled_agentic_rows')}`;
        // Three bytes per character: the most one statement can carry under these bounds.
        const data = '語'.repeat(snowflakeRowDialect.maxRowChars);
        await insertAgenticWrite(
          {
            db: agenticRowDb(runner),
            dialect: snowflakeRowDialect,
            table,
            hash: 'h'.repeat(64),
          },
          createAgenticRowWrite('', 1, 'operation', [{ kind: 'attempt', data }]),
          async () => {}
        );
        const [row] = await runner.query!(`SELECT LENGTH(${q('data')}) AS ${q('n')} FROM ${table}`);
        expect(Number(row!.N)).toBe(snowflakeRowDialect.maxRowChars);
      } finally {
        await runner.close?.();
        await dropSchema(schema);
      }
    });

    it('refuses a function named like a built-in the store calls', async () => {
      const schema = testSchema();
      await sql(`CREATE SCHEMA ${qualified(schema)}`);
      try {
        await expect(
          sql(
            `CREATE FUNCTION ${qualified(schema)}.${q('sysdate')}() RETURNS TIMESTAMP_NTZ AS 'CAST(0 AS TIMESTAMP_NTZ)'`
          )
        ).rejects.toThrow();
      } finally {
        await dropSchema(schema);
      }
    });

    it('turns AUTOCOMMIT on for a state session', async () => {
      const runner = await openLimitedRunner(snowflake!, { ...runners, leaseMs: 120_000 });
      try {
        const [row] = await runner.query!(`SHOW PARAMETERS LIKE 'AUTOCOMMIT' IN SESSION`);
        expect(row).toMatchObject({ value: 'true', level: 'SESSION' });
      } finally {
        await runner.close?.();
      }
    });

    it('stops at an empty guard table rather than insert without its lock', async () => {
      const schema = testSchema();
      const key = { scope: 'row-store-test', model: randomUUID(), target: 'guard-test' };
      try {
        const cursors = rows(schema).cursors!;
        await cursors.begin({ ...key, target: 'other' }, 'a'.repeat(64), 'run-1');
        await sql(`DELETE FROM ${qualified(schema)}.${q('__dogsled_agentic_guard')}`);
        await expect(cursors.begin(key, 'a'.repeat(64), 'run-2')).rejects.toMatchObject({
          code: 'corrupt',
          reason: 'state_table_replaced',
        });
        const stored = await sql(
          `SELECT 1 FROM ${qualified(schema)}.${q('__dogsled_agentic_cursors')} WHERE ${q('target')} = 'guard-test'`
        );
        expect(stored).toEqual([]);
      } finally {
        await dropSchema(schema);
      }
    });

    it('sends no CREATE SCHEMA for a schema that exists', async () => {
      const schema = testSchema();
      const sent: string[] = [];
      const customRunners = new CustomRunnerRegistry();
      customRunners.register('snowflake', snowflake!.auth.type, async (base, context) => {
        const runner = await resolveRunner(base, { ...context, ...runners });
        return {
          ...runner,
          run: (...args) => {
            sent.push(args[0]);
            return runner.run(...args);
          },
        };
      });
      await sql(`CREATE SCHEMA ${qualified(schema)}`);
      try {
        const store = createWarehouseRowStore(snowflake!, { schema, customRunners });
        const session = await store.acquire({ scope: 'schema', model: 'probe', id: randomUUID() });
        await session.release();
        expect(sent.filter((statement) => statement.startsWith('CREATE TABLE'))).not.toEqual([]);
        expect(sent.filter((statement) => statement.startsWith('CREATE SCHEMA'))).toEqual([]);
      } finally {
        await dropSchema(schema);
      }
    });

    it('carries progress over from the warehouse store, once', async () => {
      const schema = testSchema();
      const key = { scope: 'row-store-test', model: randomUUID(), target: 'cursor-test' };
      const signature = 'a'.repeat(64);
      try {
        const old = createWarehouseAgenticCursorStore(snowflake!, { schema, ...runners });
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
