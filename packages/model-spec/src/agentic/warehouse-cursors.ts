import { resolveWarehouseCheckpointTarget } from './warehouse-checkpoint-target.js';
import { randomUUID } from 'node:crypto';
import { resolveRunner, throwIfCancelled, type IntegrationFile } from '@bobsled-inc/connections';
import { caseName, quoteIdentifier } from '../compiler/dialect.js';
import { atomicPublication, sqlPublicationDb } from './sql-publication-storage.js';
import {
  publicationLiteral,
  publicationTableSuffix,
  publicationType,
} from './sql-publication-dialect.js';
import { AgenticCursorKeySchema, CursorRecordSchema, updateCursorRecord } from './cursor.js';
import type { AgenticCursorStore, AgenticCursorKey, AgenticCursorValues } from './cursor.js';
import type { WarehouseCheckpointOptions } from './warehouse-state.js';
import { AgenticStateError, digestAgenticState } from './state.js';

/** One table for every model. The sentinel row serializes short cursor updates, not execution. */
export function createWarehouseAgenticCursorStore(
  integration: IntegrationFile,
  options: WarehouseCheckpointOptions
): AgenticCursorStore {
  const dialect = integration.source_type;
  if (dialect === 'duckdb' || dialect === 'clickhouse') {
    throw new Error('Use local cursor storage for DuckDB');
  }
  const { catalog, schema } = resolveWarehouseCheckpointTarget(integration, options);
  const q = (name: string) => quoteIdentifier(caseName(name, dialect), dialect);
  const namespace = [...(catalog ? [catalog] : []), schema].map(q).join('.');
  const table = `${namespace}.${q('__dogsled_cursors')}`;
  const lit = (value: string) => publicationLiteral(value, dialect);
  const mutateOnce = async (
    key: AgenticCursorKey,
    signature: string,
    runId: string,
    values?: AgenticCursorValues,
    previousRunId?: string
  ) => {
    throwIfCancelled(options.signal);
    const runner = await resolveRunner(integration, options);
    try {
      const db = sqlPublicationDb(runner, dialect, options.signal);
      const text = publicationType('string', dialect);
      await db.run(`CREATE SCHEMA IF NOT EXISTS ${namespace}`);
      await db.run(
        `CREATE TABLE IF NOT EXISTS ${table}${publicationTableSuffix(dialect)} AS SELECT CAST('' AS ${text}) AS ${q('key')}, CAST('' AS ${text}) AS ${q('record')}, CAST('' AS ${text}) AS ${q('token')}`
      );
      if (dialect === 'databricks') {
        const rows = await db.query(`DESCRIBE DETAIL ${table}`);
        if (
          rows.length !== 1 ||
          !Array.isArray(rows[0]?.tablefeatures) ||
          !rows[0].tablefeatures.includes('catalogManaged')
        ) {
          throw new Error('Cursor storage requires Databricks catalog commits');
        }
      }
      const guard = await db.query(
        `SELECT ${q('token')} FROM ${table} WHERE ${q('key')} = '' LIMIT 2`
      );
      if (guard.length !== 1 || typeof guard[0]?.token !== 'string') {
        throw new AgenticStateError('corrupt');
      }
      const guardToken = guard[0].token;
      const hash = digestAgenticState(AgenticCursorKeySchema.parse(key));
      const rows = await db.query(
        `SELECT ${q('record')} FROM ${table} WHERE ${q('key')} = ${db.p(1)} LIMIT 2`,
        [hash]
      );
      if (rows.length > 1) throw new AgenticStateError('corrupt');
      const raw = rows[0]?.record;
      if (raw !== undefined && (typeof raw !== 'string' || raw.length > 262144)) {
        throw new AgenticStateError('corrupt');
      }
      const previous =
        raw === undefined ? null : CursorRecordSchema.parse(JSON.parse(raw as string));
      const next = updateCursorRecord(previous, signature, runId, values, previousRunId);
      if (JSON.stringify(next) === raw) return next.values;
      const token = randomUUID();
      const expected =
        raw === undefined
          ? `(SELECT COUNT(*) FROM ${table} WHERE ${q('key')} = ${lit(hash)}) = 0`
          : `(SELECT COUNT(*) FROM ${table} WHERE ${q('key')} = ${lit(hash)} AND ${q('record')} = ${lit(raw as string)}) = 1`;
      await atomicPublication(
        db,
        runner,
        dialect,
        [
          `UPDATE ${table} SET ${q('token')} = ${lit(token)} WHERE ${q('key')} = '' AND ${q('token')} = ${lit(guardToken)} AND (${expected})`,
          `DELETE FROM ${table} WHERE ${q('key')} = ${lit(hash)}`,
          `INSERT INTO ${table} (${q('key')}, ${q('record')}, ${q('token')}) VALUES (${lit(hash)}, ${lit(JSON.stringify(next))}, ${lit(token)})`,
        ],
        `(SELECT COUNT(*) FROM ${table} WHERE ${q('key')} = '' AND ${q('token')} = ${lit(token)}) = 1 AND (SELECT COUNT(*) FROM ${table} WHERE ${q('key')} = ${lit(hash)}) = 1`,
        options.signal
      );
      return next.values;
    } finally {
      await runner.close?.();
    }
  };
  const mutate: typeof mutateOnce = async (...args) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await mutateOnce(...args);
      } catch (error) {
        throwIfCancelled(options.signal);
        if (error instanceof AgenticStateError || attempt >= 3) throw error;
      }
    }
  };
  return {
    supersede: (key, signature, previousRunId, runId) =>
      mutate(key, signature, runId, undefined, previousRunId),
    begin: (key, signature, runId) => mutate(key, signature, runId),
    async commit(key, signature, runId, values) {
      await mutate(key, signature, runId, values);
    },
  };
}
