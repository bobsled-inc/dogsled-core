/** One row per cursor key, updated by one compare-and-swap statement. */
import { setTimeout as delay } from 'node:timers/promises';
import { throwIfCancelled } from '@bobsled-inc/connections';
import {
  AgenticCursorKeySchema,
  CursorRecordSchema,
  updateCursorRecord,
  type AgenticCursorKey,
  type AgenticCursorStore,
  type AgenticCursorValues,
  type CursorRecord,
} from './cursor.js';
import type { AgenticRowDb } from './row-state-dialect.js';
import {
  AGENTIC_CURSORS_TABLE,
  agenticRowTable,
  agenticStatement,
  ensureAgenticRowTables,
  type AgenticRowBackend,
} from './row-state-tables.js';
import { AgenticStateError, digestAgenticState } from './state.js';

/** Where a key's progress lived before this store. Read once, when its row is created. */
export type AgenticLegacyCursorReader = (key: AgenticCursorKey) => Promise<CursorRecord | null>;

const maxAttempts = 32;

/** A stored cursor record. An empty one is a key with no progress yet. */
export function parseAgenticCursorRecord(raw: unknown): CursorRecord | null {
  if (raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 262144) throw new AgenticStateError('corrupt');
  try {
    return CursorRecordSchema.parse(JSON.parse(raw));
  } catch {
    throw new AgenticStateError('corrupt');
  }
}

/** The record a row store holds for a key, without reserving anything. */
export async function readAgenticRowCursor(
  backend: AgenticRowBackend,
  rawKey: AgenticCursorKey
): Promise<CursorRecord | null> {
  const { dialect } = backend;
  const hash = digestAgenticState(AgenticCursorKeySchema.parse(rawKey));
  const connection = await backend.connect();
  const { namespace } = connection;
  try {
    return await connection.use(async (db) => {
      await ensureAgenticRowTables(db, backend, namespace);
      const table = agenticRowTable(dialect, namespace, AGENTIC_CURSORS_TABLE);
      const rows = await db.query(
        `SELECT ${dialect.identifier('record')} FROM ${table} WHERE ${dialect.identifier('key_hash')} = ${dialect.bind(1)} LIMIT 2`,
        [hash]
      );
      if (rows.length > 1) throw new AgenticStateError('corrupt');
      return rows.length ? parseAgenticCursorRecord(rows[0]!.record) : null;
    });
  } finally {
    await connection.close();
  }
}

export function createAgenticRowCursorStore(options: {
  backend: AgenticRowBackend;
  legacy?: AgenticLegacyCursorReader;
  /** Keep a reservation from the legacy store. Only for a caller whose takeover can open
   * that run; otherwise the key could never be released, so it is refused. */
  carryLegacyOwner?: boolean;
  signal?: AbortSignal;
}): AgenticCursorStore {
  const { backend, legacy, carryLegacyOwner, signal } = options;
  const { dialect } = backend;
  const q = dialect.identifier;
  const withDb = async <T>(
    operation: (db: AgenticRowDb, table: string, namespace: string) => Promise<T>
  ): Promise<T> => {
    const connection = await backend.connect();
    const { namespace } = connection;
    try {
      return await connection.use(async (db) => {
        await ensureAgenticRowTables(db, backend, namespace);
        const table = agenticRowTable(dialect, namespace, AGENTIC_CURSORS_TABLE);
        return operation(db, table, namespace);
      });
    } finally {
      await connection.close();
    }
  };
  /** Compare and swap once. Returns undefined when the key has no row yet, or `false` when
   * another writer changed the row first. */
  const swap = (
    hash: string,
    change: (previous: CursorRecord | null) => CursorRecord
  ): Promise<AgenticCursorValues | false | undefined> =>
    withDb(async (db, table) => {
      const rows = await db.query(
        `SELECT ${q('version')}, ${q('record')} FROM ${table} WHERE ${q('key_hash')} = ${dialect.bind(1)} LIMIT 2`,
        [hash]
      );
      if (rows.length > 1) throw new AgenticStateError('corrupt');
      if (!rows.length) return undefined;
      const raw = rows[0]!.record;
      const next = change(parseAgenticCursorRecord(raw));
      const json = JSON.stringify(next);
      if (json === raw) return next.values;
      const statement = agenticStatement(dialect);
      const set = `${q('record')} = ${statement.bind(json)}, ${q('version')} = ${q('version')} + 1`;
      const where = `${q('key_hash')} = ${statement.bind(hash)} AND ${q('version')} = ${statement.bind(Number(rows[0]!.version))}`;
      const changed = await dialect.changed(
        db,
        `UPDATE ${table} SET ${set} WHERE ${where}`,
        statement.params
      );
      return changed === 1 ? next.values : false;
    });
  const mutate = async (
    rawKey: AgenticCursorKey,
    signature: string,
    runId: string,
    values?: AgenticCursorValues,
    previousRunId?: string
  ): Promise<AgenticCursorValues> => {
    const key = AgenticCursorKeySchema.parse(rawKey);
    const hash = digestAgenticState(key);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      throwIfCancelled(signal);
      const result = await swap(hash, (previous) =>
        updateCursorRecord(previous, signature, runId, values, previousRunId)
      );
      if (result === undefined) {
        // Outside any database operation: the legacy store can be this same file.
        const carried = (await legacy?.(key)) ?? null;
        if (carried?.activeRun && carried.activeRun !== runId && !carryLegacyOwner) {
          throw new AgenticStateError('conflict', {
            reason: 'cursor_held_elsewhere',
            message: 'An unfinished run holds this incremental cursor in the previous store.',
            hint: 'Finish that run from the previous store before moving to this one.',
          });
        }
        await withDb((db, table, namespace) =>
          dialect.insertIfAbsent(
            db,
            table,
            {
              key_hash: hash,
              scope: key.scope,
              model: key.model,
              target: key.target,
              version: 0,
              record: carried ? JSON.stringify(carried) : '',
            },
            'key_hash',
            namespace
          )
        );
      } else if (result === false) {
        const cap = Math.min(1_000, 10 * 2 ** Math.min(attempt, 7));
        const wait = Math.floor(cap * (0.5 + Math.random() / 2));
        await delay(wait, undefined, signal ? { signal } : undefined);
      } else {
        return result;
      }
    }
    throw new AgenticStateError('unavailable', {
      reason: 'cursor_contention',
      message: 'Too many writers are updating this incremental cursor at once.',
      hint: 'Retry the run.',
    });
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
