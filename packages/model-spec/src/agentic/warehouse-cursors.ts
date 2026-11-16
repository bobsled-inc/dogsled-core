import { resolveWarehouseCheckpointTarget } from './warehouse-checkpoint-target.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { throwIfCancelled, type IntegrationFile } from '@bobsled-inc/connections';
import { caseName, quoteIdentifier } from '../compiler/dialect.js';
import { atomicPublication, sqlPublicationDb } from './sql-publication-storage.js';
import { openLimitedRunner } from './warehouse-statement-limit.js';
import {
  publicationLiteral,
  publicationTableSuffix,
  publicationType,
} from './sql-publication-dialect.js';
import { AgenticCursorKeySchema, CursorRecordSchema, updateCursorRecord } from './cursor.js';
import type { AgenticCursorStore, AgenticCursorKey, AgenticCursorValues } from './cursor.js';
import type { WarehouseCheckpointOptions } from './warehouse-state.js';
import { AgenticStateError, digestAgenticState } from './state.js';
import { LEGACY_WAREHOUSE_CURSOR_TABLES } from './legacy-names.js';
import { adoptLegacyWarehouseTables } from './legacy-tables.js';

function isCursorContention(error: Error, dialect: string): boolean {
  const seen = new Set<Error>();
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error && !seen.has(current); depth++) {
    seen.add(current);
    const message = current.message.trim();
    if (message === 'Stale publication owner or target version') return true;
    if (
      dialect === 'snowflake' &&
      /^Uncaught exception of type 'STALE' on line \d+ at position \d+\s*: Stale publication owner or target version$/.test(
        message
      )
    ) {
      return true;
    }
    if (
      dialect === 'bigquery' &&
      /^(?:Query error: |Assertion failed: )Stale publication owner or target version(?: at \[\d+:\d+\])?$/.test(
        message
      )
    ) {
      return true;
    }
    if (
      dialect === 'databricks' &&
      /^\[USER_RAISED_EXCEPTION\] Stale publication owner or target version(?:\.? SQLSTATE: 45000)?$/.test(
        message
      )
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

class CursorContention extends Error {
  constructor(readonly original: Error) {
    super('Cursor contention', { cause: original });
  }
}

/** The warehouse store's cursor table, one for every model in a schema. */
export const WAREHOUSE_CURSORS_TABLE = '__bobsled_cursors';

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
  const table = `${namespace}.${q(WAREHOUSE_CURSORS_TABLE)}`;
  let adopted = false;
  const lit = (value: string) => publicationLiteral(value, dialect);
  const mutateOnce = async (
    key: AgenticCursorKey,
    signature: string,
    runId: string,
    values?: AgenticCursorValues,
    previousRunId?: string
  ) => {
    throwIfCancelled(options.signal);
    const runner = await openLimitedRunner(integration, options);
    try {
      const db = sqlPublicationDb(runner, dialect, options.signal);
      const text = publicationType('string', dialect);
      await db.run(`CREATE SCHEMA IF NOT EXISTS ${namespace}`);
      if (!adopted) {
        await adoptLegacyWarehouseTables(db, dialect, { catalog, schema }, [
          [WAREHOUSE_CURSORS_TABLE, LEGACY_WAREHOUSE_CURSOR_TABLES],
        ]);
        adopted = true;
      }
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
      try {
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
      } catch (error) {
        if (error instanceof Error && isCursorContention(error, dialect)) {
          throw new CursorContention(error);
        }
        throw error;
      }
      return next.values;
    } finally {
      await runner.close?.();
    }
  };
  const mutate: typeof mutateOnce = async (...args) => {
    const started = Date.now();
    let retryingContention = false;
    let slowestAttemptMs = 0;
    let retryBudgetMs = 120_000;
    let lastError: unknown;
    for (let attempt = 0; ; attempt++) {
      throwIfCancelled(options.signal);
      if (retryingContention && Date.now() - started >= retryBudgetMs) throw lastError;
      const attemptStarted = Date.now();
      try {
        return await mutateOnce(...args);
      } catch (failure) {
        throwIfCancelled(options.signal);
        const contended = failure instanceof CursorContention;
        const error = contended ? failure.original : failure;
        lastError = error;
        if (error instanceof AgenticStateError || attempt >= (contended ? 31 : 3)) throw error;
        if (!contended) continue;
        retryingContention = true;
        slowestAttemptMs = Math.max(slowestAttemptMs, Math.max(0, Date.now() - attemptStarted));
        retryBudgetMs = Math.min(360_000, Math.max(120_000, 32 * slowestAttemptMs + 31_000));
        const remaining = retryBudgetMs - (Date.now() - started);
        if (remaining <= 0) throw error;
        const cap = Math.min(1_000, 50 * 2 ** Math.min(attempt, 5));
        const wait = Math.min(remaining, Math.floor(cap * (0.5 + Math.random() / 2)));
        try {
          await delay(wait, undefined, options.signal ? { signal: options.signal } : undefined);
        } catch (waitingError) {
          throwIfCancelled(options.signal);
          throw waitingError;
        }
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
