import { describe, expect, it } from 'vitest';
import { CommandError } from '@bobsled-inc/protocol';
import { DuckDbEngine } from '../../src/runtime/duckdb-engine.js';

/**
 * Tests for the JS-layer read-only guard (`assertReadOnlySql`).
 *
 * After the migration to @duckdb/node-api, read-only enforcement moved from
 * engine-level SET access_mode to a JS regex guard. These tests ensure the
 * guard correctly allows read queries and blocks write/admin statements.
 *
 * We test the guard in isolation by calling `assertReadOnlySql` directly
 * (made package-visible for testability) rather than spinning up a real
 * DuckDB instance.
 */

describe('assertReadOnlySql', () => {
  function createGuard(): { assert: (sql: string) => void } {
    // Create a minimal object that mimics the finalized engine state
    // to test the guard logic without a real DuckDB connection.
    const engine = Object.create(DuckDbEngine.prototype) as DuckDbEngine;
    // Set the finalized flag via the public method's effect
    Object.assign(engine, { finalizedReadOnly: true });
    return { assert: (sql: string) => engine.assertReadOnlySql(sql) };
  }

  describe('allows read-only statements', () => {
    const allowed = [
      'SELECT 1',
      'select * from t',
      '  SELECT col FROM table_name WHERE id = 1',
      'DESCRIBE SELECT * FROM t',
      'EXPLAIN SELECT * FROM t',
      'PRAGMA version',
      'pragma table_info(t)',
      'WITH cte AS (SELECT 1) SELECT * FROM cte',
      'with recursive r as (select 1 union all select n+1 from r where n < 10) select * from r',
      // Regression: DML keywords as string data or identifiers must not trigger the write-CTE guard.
      "WITH cte AS (SELECT 'update' AS verb) SELECT verb FROM cte",
      "SELECT 'insert into t values (1)' AS payload",
      'WITH "merge" AS (SELECT 1 AS id) SELECT id FROM "merge"',
      "SELECT col FROM t WHERE note = 'delete me' -- insert comment here",
      "SELECT /* update note */ col FROM t WHERE action = 'merge'",
    ];

    for (const sql of allowed) {
      it(`allows: ${sql.slice(0, 60)}`, () => {
        const guard = createGuard();
        expect(() => guard.assert(sql)).not.toThrow();
      });
    }
  });

  describe('blocks write and admin statements', () => {
    const blocked = [
      'INSERT INTO t VALUES (1)',
      'UPDATE t SET col = 1',
      'DELETE FROM t WHERE id = 1',
      'DROP TABLE t',
      'CREATE TABLE t (id INT)',
      'ALTER TABLE t ADD COLUMN col INT',
      'SET access_mode = read_write',
      'INSTALL httpfs',
      'LOAD httpfs',
      'COPY t TO file.csv',
    ];

    for (const sql of blocked) {
      it(`blocks: ${sql.slice(0, 60)}`, () => {
        const guard = createGuard();
        expect(() => guard.assert(sql)).toThrow(CommandError);
      });
    }
  });

  describe('blocks statement splitting', () => {
    const split = ['SELECT 1; DROP TABLE t', 'SELECT 1;\nINSTALL httpfs', 'SELECT 1;\tLOAD httpfs'];

    for (const sql of split) {
      it(`blocks: ${sql.slice(0, 60)}`, () => {
        const guard = createGuard();
        expect(() => guard.assert(sql)).toThrow(CommandError);
      });
    }
  });

  describe('blocks write CTEs', () => {
    const writeCtes = [
      'WITH cte AS (SELECT 1) INSERT INTO t SELECT * FROM cte',
      'WITH cte AS (SELECT 1) UPDATE t SET col = cte.val FROM cte',
      'WITH cte AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT id FROM cte)',
      'WITH src AS (SELECT 1) MERGE INTO t USING src ON t.id = src.id WHEN MATCHED THEN UPDATE SET col = 1',
    ];

    for (const sql of writeCtes) {
      it(`blocks: ${sql.slice(0, 60)}`, () => {
        const guard = createGuard();
        expect(() => guard.assert(sql)).toThrow(CommandError);
      });
    }
  });

  it('does not throw when not finalized', () => {
    const engine = Object.create(DuckDbEngine.prototype) as DuckDbEngine;
    Object.assign(engine, { finalizedReadOnly: false });
    expect(() => engine.assertReadOnlySql('DROP TABLE t')).not.toThrow();
  });

  it('allows trailing semicolons without additional statements', () => {
    const guard = createGuard();
    expect(() => guard.assert('SELECT 1;')).not.toThrow();
    expect(() => guard.assert('SELECT 1;  ')).not.toThrow();
    expect(() => guard.assert('SELECT 1;\n')).not.toThrow();
  });
});
