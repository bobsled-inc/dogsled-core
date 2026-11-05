import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqlCancelledError } from '../../../../src/runtime/cancellation.js';
import { buildDuckDbRunner } from '../../../../src/runtime/runners/duckdb.js';
import type { DuckDbIntegration } from '../../../../src/schemas/integration.js';

function memoryIntegration(): DuckDbIntegration {
  return {
    spec_version: '1',
    type: 'integration',
    name: 'local_duck',
    source_type: 'duckdb',
    connection: {},
    auth: { type: 'memory' },
  };
}

function fileIntegration(dbPath: string): DuckDbIntegration {
  return {
    spec_version: '1',
    type: 'integration',
    name: 'local_duck_file',
    source_type: 'duckdb',
    connection: {},
    auth: { type: 'file', path: dbPath, read_only: false },
  };
}

describe('buildDuckDbRunner — in-memory', () => {
  it('runs DDL + inserts + SELECT round-trip', async () => {
    const runner = await buildDuckDbRunner(memoryIntegration());
    try {
      await runner.run('CREATE TABLE t (id INTEGER, name VARCHAR)');
      await runner.run("INSERT INTO t VALUES (1, 'alpha'), (2, 'beta')");
      const rows = await runner.query!<{ id: number; name: string }>(
        'SELECT id, name FROM t ORDER BY id'
      );
      expect(rows).toEqual([
        { id: 1, name: 'alpha' },
        { id: 2, name: 'beta' },
      ]);
    } finally {
      await runner.close?.();
    }
  });

  it('supports positional query bindings', async () => {
    const runner = await buildDuckDbRunner(memoryIntegration());
    try {
      await runner.run('CREATE TABLE t (id INTEGER, name VARCHAR)');
      await runner.run("INSERT INTO t VALUES (1, 'alpha'), (2, 'beta')");
      const rows = await runner.query!<{ id: number; name: string }>(
        'SELECT id, name FROM t WHERE id = ?',
        [2]
      );
      expect(rows).toEqual([{ id: 2, name: 'beta' }]);
    } finally {
      await runner.close?.();
    }
  });

  it.each([
    2147483647,
    2147483648,
    -2147483648,
    -2147483649,
    2592000000,
    1793881483024,
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER,
  ])('stores the whole number %d exactly', async (value) => {
    const runner = await buildDuckDbRunner(memoryIntegration());
    try {
      await runner.run('CREATE TABLE t (exact BIGINT, approximate DOUBLE)');
      await runner.query!('INSERT INTO t VALUES (?, ?)', [value, value]);
      const rows = await runner.query!<{ exact: bigint; approximate: number }>('SELECT * FROM t');
      expect(rows).toEqual([{ exact: BigInt(value), approximate: value }]);
    } finally {
      await runner.close?.();
    }
  });

  it('keeps whole numbers beyond the safe range as doubles', async () => {
    const runner = await buildDuckDbRunner(memoryIntegration());
    try {
      await runner.run('CREATE TABLE t (value DOUBLE)');
      await runner.query!('INSERT INTO t VALUES (?), (?), (?)', [1e300, -1e300, Infinity]);
      const rows = await runner.query!<{ value: number }>('SELECT value FROM t');
      expect(rows.map((row) => row.value)).toEqual([1e300, -1e300, Infinity]);
    } finally {
      await runner.close?.();
    }
  });

  it('uses large numbers in expressions without wrapping them', async () => {
    const runner = await buildDuckDbRunner(memoryIntegration());
    try {
      const rows = await runner.query!<{ total: bigint }>(
        'SELECT CAST(1000 AS BIGINT) + ? AS total',
        [2592000000]
      );
      expect(rows[0]!.total).toBe(2592001000n);
    } finally {
      await runner.close?.();
    }
  });

  it('exposes close() as a no-throw cleanup', async () => {
    const runner = await buildDuckDbRunner(memoryIntegration());
    await runner.run('CREATE TABLE t (id INTEGER)');
    await expect(runner.close?.()).resolves.toBeUndefined();
  });

  it('interrupts and settles an active query before returning cancellation', async () => {
    const runner = await buildDuckDbRunner(memoryIntegration());
    const controller = new AbortController();
    try {
      const pending = runner.query!(
        'SELECT SUM(random()) AS total FROM range(1000000000)',
        undefined,
        { signal: controller.signal }
      );
      setTimeout(() => controller.abort(), 5);

      await expect(pending).rejects.toBeInstanceOf(SqlCancelledError);
      // Settlement leaves the connection usable; runCancellable did not return
      // while DuckDB was still unwinding the interrupted operation.
      await expect(runner.query!('SELECT 1 AS value')).resolves.toEqual([{ value: 1 }]);
    } finally {
      await runner.close?.();
    }
  });
});

describe('buildDuckDbRunner — file-backed', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conn-duck-'));
    dbPath = path.join(tmpDir, 'test.duckdb');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('persists data across runner instances', async () => {
    const r1 = await buildDuckDbRunner(fileIntegration(dbPath));
    await r1.run('CREATE TABLE persisted (id INTEGER, label VARCHAR)');
    await r1.run("INSERT INTO persisted VALUES (42, 'hello')");
    await r1.close?.();

    const r2 = await buildDuckDbRunner(fileIntegration(dbPath));
    try {
      const rows = await r2.query!<{ id: number; label: string }>(
        'SELECT id, label FROM persisted'
      );
      expect(rows).toEqual([{ id: 42, label: 'hello' }]);
    } finally {
      await r2.close?.();
    }
  });

  it('creates missing parent directories for a writable file-backed database', async () => {
    // DuckDBInstance.create() does not create parent dirs; opening a path under
    // a not-yet-existing directory must not throw "IO Error: Cannot open file".
    const nestedPath = path.join(tmpDir, 'data', 'nested', 'created.duckdb');
    const runner = await buildDuckDbRunner(fileIntegration(nestedPath));
    try {
      await runner.run('CREATE TABLE t (id INTEGER)');
      await runner.run('INSERT INTO t VALUES (7)');
      await expect(runner.query!('SELECT id FROM t')).resolves.toEqual([{ id: 7 }]);
      const dirStat = await fs.stat(path.dirname(nestedPath));
      expect(dirStat.isDirectory()).toBe(true);
    } finally {
      await runner.close?.();
    }
  });

  it('unloads query results to a local Parquet file', async () => {
    const runner = await buildDuckDbRunner(fileIntegration(dbPath));
    try {
      await runner.run('CREATE TABLE source_rows (id INTEGER, label VARCHAR)');
      await runner.run("INSERT INTO source_rows VALUES (1, 'alpha'), (2, 'beta')");
      const targetUri = path.join(tmpDir, 'unload', 'source_rows');

      const result = await runner.unload!('SELECT id, label FROM source_rows', targetUri, {
        format: 'parquet',
      });

      expect(result.uris).toEqual([path.join(targetUri, 'part-00000.parquet')]);
      await expect(fs.stat(result.uris[0]!)).resolves.toMatchObject({ size: expect.any(Number) });
      await expect(
        runner.query!(`SELECT COUNT(*) AS c FROM read_parquet('${result.uris[0]}')`)
      ).resolves.toEqual([{ c: 2n }]);
    } finally {
      await runner.close?.();
    }
  });
});
