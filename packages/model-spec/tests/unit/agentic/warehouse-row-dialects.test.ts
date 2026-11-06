import { describe, expect, it, vi } from 'vitest';
import { insertAgenticWrite } from '../../../src/agentic/row-state-rows.js';
import { createAgenticRowWrite } from '../../../src/agentic/row-state-layout.js';
import type { AgenticRowDb } from '../../../src/agentic/row-state-dialect.js';
import { agenticRowColumns, agenticStatement } from '../../../src/agentic/row-state-tables.js';
import {
  postgresRowDialect,
  snowflakeRowDialect,
  waitForSnowflakeLockQueue,
} from '../../../src/agentic/warehouse-row-dialects.js';

// Fake timers do not reach node:timers/promises, which the lock queue's wait uses.
vi.mock('node:timers/promises', async (original) => ({
  ...(await original<typeof import('node:timers/promises')>()),
  setTimeout: (ms: number, value: unknown, options?: { signal?: AbortSignal }) =>
    new Promise((done, fail) => {
      if (options?.signal?.aborted) fail(new Error('Wait aborted'));
      const timer = setTimeout(() => done(value), ms);
      options?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        fail(new Error('Wait aborted'));
      });
    }),
}));

const columns = agenticRowColumns.map((column) => column.name);
const values = { key_hash: 'hash', record: "it's", version: 0, active: true };

function fakeDb(query: AgenticRowDb['query'] = async () => []) {
  return { run: vi.fn(async (_sql: string) => ({})), query: vi.fn(query) };
}
/** The script inside `EXECUTE IMMEDIATE`, as Snowflake reads the literal: one pass, because
 * `\\n` is a backslash and an n, not a backslash and a new line. */
const script = (sql: string): string =>
  /^EXECUTE IMMEDIATE '(.*)'$/s
    .exec(sql)![1]!
    .replace(/\\(.)|''/gs, (match, escaped?: string) =>
      match === "''" ? "'" : escaped === 'n' ? '\n' : escaped!
    );

describe('PostgreSQL row dialect', () => {
  const dialect = postgresRowDialect;

  it('keeps one row per key through the key the table declares', async () => {
    expect(dialect.createTable('t', [{ name: 'key_hash', type: 'text' }], ['key_hash'])).toContain(
      'PRIMARY KEY ("key_hash")'
    );
    const db = fakeDb();
    await dialect.insertIfAbsent(db, 't', values, 'key_hash', 'n');
    expect(db.query).toHaveBeenCalledWith(
      'INSERT INTO t ("key_hash", "record", "version", "active") VALUES ($1, $2, $3, $4) ON CONFLICT ("key_hash") DO NOTHING',
      Object.values(values)
    );
  });

  it('makes a repeated row harmless and numbers placeholders across rows', () => {
    const sql = dialect.insertRows('t', ['a', 'b'], 2);
    expect(sql).toBe('INSERT INTO t ("a", "b") VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING');
  });

  it('counts changed rows from RETURNING', async () => {
    const db = fakeDb(async () => [{ changed: 1 }, { changed: 1 }]);
    expect(await dialect.changed(db, 'UPDATE t SET a = $1', [1])).toBe(2);
    expect(db.query).toHaveBeenCalledWith('UPDATE t SET a = $1 RETURNING 1 AS changed', [1]);
  });

  it('reads the wall clock, not the start of the transaction', () => {
    expect(dialect.clock).toContain('clock_timestamp()');
    expect(dialect.clock).not.toMatch(/\bnow\(\)/);
  });

  it('stays within the protocol limit on parameters', () => {
    expect(dialect.maxInsertRows * columns.length).toBeLessThan(65_535);
  });
});

describe('Snowflake row dialect', () => {
  const dialect = snowflakeRowDialect;
  const table = '"DB"."S"."T"';

  it('folds identifiers to upper case and binds by position', () => {
    expect(dialect.identifier('run_hash')).toBe('"RUN_HASH"');
    expect(dialect.bind(7)).toBe('?');
    const statement = agenticStatement(dialect);
    expect(`${statement.bind('a')} ${statement.bind(2)}`).toBe('? ?');
    expect(statement.params).toEqual(['a', 2]);
  });

  it('declares no key, because Snowflake would not enforce one', () => {
    const sql = dialect.createTable(table, [{ name: 'a', type: 'integer' }], ['a']);
    expect(sql).toBe(`CREATE TABLE IF NOT EXISTS ${table} ("A" BIGINT NOT NULL)`);
  });

  it('creates the guard with exactly one row in one statement', () => {
    expect(dialect.setup!('"DB"."S"')).toEqual([
      `CREATE TABLE IF NOT EXISTS "DB"."S"."__DOGSLED_AGENTIC_GUARD" AS SELECT CAST('' AS VARCHAR) AS "TOKEN"`,
    ]);
  });

  it('adds a first row inside one transaction, behind the guard', async () => {
    const db = fakeDb();
    await dialect.insertIfAbsent(db, table, values, 'key_hash', '"DB"."S"');
    expect(db.run).toHaveBeenCalledTimes(1);
    const lines = script(db.run.mock.calls[0]![0]).split('\n');
    expect(lines[0]).toMatch(/^DECLARE no_guard EXCEPTION \(-20001, '.+'\); matches INTEGER;$/);
    expect(lines.slice(1, 3)).toEqual(['BEGIN', 'BEGIN TRANSACTION;']);
    expect(lines[3]).toMatch(
      /^UPDATE "DB"\."S"\."__DOGSLED_AGENTIC_GUARD" SET "TOKEN" = '[-\w]+';$/
    );
    expect(lines.slice(4)).toEqual([
      'IF (SQLROWCOUNT <> 1) THEN RAISE no_guard; END IF;',
      `matches := (SELECT COUNT(*) FROM ${table} WHERE "KEY_HASH" = 'hash');`,
      'IF (matches = 0) THEN',
      `INSERT INTO ${table} ("KEY_HASH", "RECORD", "VERSION", "ACTIVE") VALUES ('hash', 'it''s', 0, TRUE);`,
      'END IF;',
      'COMMIT;',
      'EXCEPTION WHEN OTHER THEN ROLLBACK; RAISE;',
      'END;',
    ]);
  });

  it('writes every value type a first row can hold as a literal', async () => {
    const db = fakeDb();
    const row = {
      key_hash: 'k',
      retain_until: BigInt(Number.MAX_SAFE_INTEGER),
      reclaimable: false,
    };
    await dialect.insertIfAbsent(db, table, row, 'key_hash', '"DB"."S"');
    expect(script(db.run.mock.calls[0]![0])).toContain(
      `VALUES ('k', ${Number.MAX_SAFE_INTEGER}, FALSE);`
    );
  });

  it('takes no lock for a key that already has its row', async () => {
    const db = fakeDb(async () => [{ found: 1 }]);
    await dialect.insertIfAbsent(db, table, values, 'key_hash', '"DB"."S"');
    expect(db.query).toHaveBeenCalledWith(
      `SELECT 1 AS found FROM ${table} WHERE "KEY_HASH" = ? LIMIT 1`,
      ['hash']
    );
    expect(db.run).not.toHaveBeenCalled();
  });

  it('counts changed rows from the result of the update', async () => {
    const reported = async (count: unknown) =>
      dialect.changed(
        fakeDb(async () => [
          { 'number of rows updated': count, 'number of multi-joined rows updated': '0' },
        ]),
        'UPDATE t SET a = ?',
        [1]
      );
    expect(await reported('1')).toBe(1);
    expect(await reported(1)).toBe(1);
    expect(await reported(1n)).toBe(1);
    expect(await reported('0')).toBe(0);
    expect(await reported('2')).toBe(2);
  });

  it.each([
    ['no result', []],
    ['another shape', [{ changed: 1 }]],
    ['a null count', [{ 'number of rows updated': null }]],
    ['a count that is not a number', [{ 'number of rows updated': 'one' }]],
    ['two rows', [{ 'number of rows updated': '1' }, { 'number of rows updated': '1' }]],
  ])('treats %s as an unknown outcome, not as no change', async (_name, rows) => {
    await expect(
      dialect.changed(
        fakeDb(async () => rows),
        'UPDATE t',
        []
      )
    ).rejects.toThrow('did not report');
  });

  it('reads a clock that the session time zone cannot move', () => {
    expect(dialect.clock).toBe('DATE_PART(EPOCH_MILLISECOND, SYSDATE())');
  });

  it('uses no syntax that Snowflake lacks', () => {
    expect(dialect.insertRows(table, ['a', 'b'], 2)).toBe(
      `INSERT INTO ${table} ("A", "B") VALUES (?, ?), (?, ?)`
    );
  });

  it('keeps the worst-case statement under 1 MB, counting bound values', async () => {
    // Three bytes per UTF-16 unit, and rows that fill the character bound in every statement.
    const data = '語'.repeat(dialect.maxRowChars);
    const items = Array.from({ length: 5 }, () => ({ kind: 'attempt' as const, data }));
    const db = fakeDb();
    await insertAgenticWrite(
      { db, dialect, table, hash: 'h'.repeat(64) },
      createAgenticRowWrite('', 1, 'operation', items),
      async () => {}
    );
    expect(db.query).toHaveBeenCalledTimes(5);
    for (const [sql, params] of db.query.mock.calls) {
      const bytes = (params as unknown[]).reduce<number>(
        (total, value) => total + Buffer.byteLength(String(value)),
        Buffer.byteLength(sql)
      );
      expect(bytes).toBeLessThan(1_000_000);
    }
  });

  it('keeps many small rows under the same limit, and bounds their binds', async () => {
    const items = Array.from({ length: 300 }, (_, index) => ({
      kind: 'attempt' as const,
      data: `"${index}"`,
    }));
    const db = fakeDb();
    await insertAgenticWrite(
      { db, dialect, table, hash: 'h'.repeat(64) },
      createAgenticRowWrite('', 1, 'operation', items),
      async () => {}
    );
    expect(db.query).toHaveBeenCalledTimes(3);
    const binds = db.query.mock.calls.map(([, params]) => (params as unknown[]).length);
    expect(Math.max(...binds)).toBe(1_280);
  });

  it('never splits a row across statements beyond what one statement can carry', () => {
    expect(dialect.maxRowChars).toBeLessThanOrEqual(dialect.maxInsertChars);
    expect(dialect.maxInsertChars * 3).toBeLessThan(1_000_000);
  });
});

describe('Snowflake lock queue', () => {
  const full = () =>
    Object.assign(
      new Error('...the number of waiters for this lock exceeds the 20 statements limit.'),
      {
        code: '000625',
        sqlState: '57014',
      }
    );

  it('repeats a statement the lock queue refused', async () => {
    const db = fakeDb();
    db.query.mockRejectedValueOnce(full()).mockResolvedValueOnce([{ answer: 1 }]);
    db.run.mockRejectedValueOnce(full());
    const waiting = waitForSnowflakeLockQueue(db);
    expect(await waiting.query('UPDATE t', [1])).toEqual([{ answer: 1 }]);
    await waiting.run('EXECUTE IMMEDIATE');
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query).toHaveBeenLastCalledWith('UPDATE t', [1]);
    expect(db.run).toHaveBeenCalledTimes(2);
  });

  it('recognizes the error by its code alone and by its message alone', async () => {
    const db = fakeDb();
    db.query
      .mockRejectedValueOnce(Object.assign(new Error('Refused'), { code: 625 }))
      .mockRejectedValueOnce(new Error('the number of waiters for this lock exceeds the 40 limit'))
      .mockResolvedValueOnce([]);
    expect(await waitForSnowflakeLockQueue(db).query('UPDATE t')).toEqual([]);
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  it('does not repeat any other failure', async () => {
    const db = fakeDb();
    const failure = Object.assign(new Error('SQL compilation error'), { code: '001003' });
    db.query.mockRejectedValueOnce(failure);
    await expect(waitForSnowflakeLockQueue(db).query('UPDATE t')).rejects.toBe(failure);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('gives up after a bounded number of attempts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const db = fakeDb(async () => {
        throw full();
      });
      const outcome = waitForSnowflakeLockQueue(db).query('UPDATE t');
      const settled = expect(outcome).rejects.toThrow('number of waiters');
      await vi.advanceTimersByTimeAsync(60_000);
      await settled;
      expect(db.query).toHaveBeenCalledTimes(8);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops waiting when the run is cancelled', async () => {
    const controller = new AbortController();
    const db = fakeDb(async () => {
      controller.abort();
      throw full();
    });
    await expect(
      waitForSnowflakeLockQueue(db, controller.signal).query('UPDATE t')
    ).rejects.toMatchObject({ name: 'SqlCancelledError' });
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
