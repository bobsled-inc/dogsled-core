import { AgenticCursorKeySchema, CursorRecordSchema, updateCursorRecord } from './cursor.js';
import type { AgenticCursorStore, AgenticCursorKey, AgenticCursorValues } from './cursor.js';
import { digestAgenticState } from './state.js';
import { q, PUBLICATION_SCHEMA, stageRef } from './duckdb-checks.js';
import type { Db } from './duckdb-publication-storage.js';

export function createDuckDbCursorStore(
  operation: <T>(fn: (db: Db) => Promise<T>) => Promise<T>
): AgenticCursorStore {
  const table = stageRef('cursors');
  const mutate = (
    key: AgenticCursorKey,
    signature: string,
    runId: string,
    values?: AgenticCursorValues,
    previousRunId?: string
  ) =>
    operation(async (db) => {
      await db.run(`CREATE SCHEMA IF NOT EXISTS ${q(PUBLICATION_SCHEMA)}`);
      await db.run(
        `CREATE TABLE IF NOT EXISTS ${table} (key VARCHAR PRIMARY KEY, record VARCHAR NOT NULL)`
      );
      await db.run('BEGIN TRANSACTION');
      try {
        const hash = digestAgenticState(AgenticCursorKeySchema.parse(key));
        const rows = await db.query(`SELECT record FROM ${table} WHERE key = ?`, [hash]);
        const previous = rows.length
          ? CursorRecordSchema.parse(JSON.parse(String(rows[0]!.record)))
          : null;
        const next = updateCursorRecord(previous, signature, runId, values, previousRunId);
        await db.query(
          `INSERT INTO ${table} VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET record = excluded.record`,
          [hash, JSON.stringify(next)]
        );
        await db.run('COMMIT');
        return next.values;
      } catch (error) {
        await db.run('ROLLBACK');
        throw error;
      }
    });
  return {
    supersede: (key, signature, previousRunId, runId) =>
      mutate(key, signature, runId, undefined, previousRunId),
    begin: (key, signature, runId) => mutate(key, signature, runId),
    async commit(key, signature, runId, values) {
      await mutate(key, signature, runId, values);
    },
  };
}
