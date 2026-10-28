import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDuckDbRunner } from '@bobsled-inc/connections';
import { insertDuckDbPublicationRows } from '../../../src/agentic/duckdb-publisher.js';
import { dbFor } from '../../../src/agentic/duckdb-publication-storage.js';
import { warehouseEnabled } from './setup.js';

describe.skipIf(!warehouseEnabled('duckdb'))('native DuckDB publication batches', () => {
  it('stores multiple batches with JSON bindings and rolls back all batches on failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentic-batches-'));
    const runner = await buildDuckDbRunner({
      spec_version: '1',
      type: 'integration',
      name: 'local',
      source_type: 'duckdb',
      auth: { type: 'file', path: join(directory, 'data.duckdb') },
    });
    const db = dbFor(runner);
    const columns = [
      { name: 'id', type: 'integer' as const, nullable: false },
      { name: 'detail', type: 'object' as const, nullable: true },
    ];
    const rows = Array.from({ length: 257 }, (_, id) => ({
      id,
      detail: id === 0 ? null : { text: "O'Brien; DROP TABLE stage" },
    }));
    try {
      await db.run('CREATE TABLE stage (id BIGINT PRIMARY KEY, detail JSON)');
      await db.run('BEGIN TRANSACTION');
      await insertDuckDbPublicationRows(db, '"stage"', columns, rows);
      await db.run('COMMIT');
      const stored = await db.query('SELECT id, detail FROM stage ORDER BY id');
      expect(
        stored.map((row) => ({
          id: Number(row.id),
          detail: row.detail === null ? null : JSON.parse(String(row.detail)),
        }))
      ).toEqual(rows);
      await db.run('BEGIN TRANSACTION');
      // The duplicate key is in the second batch, after a full first batch succeeds.
      await expect(
        insertDuckDbPublicationRows(db, '"stage"', columns, [
          ...Array.from({ length: 128 }, (_, id) => ({ id: id + 1000, detail: null })),
          { id: 0, detail: null },
        ])
      ).rejects.toThrow();
      await db.run('ROLLBACK');
      const count = await db.query('SELECT count(*) AS count FROM stage');
      expect(Number(count[0]!.count)).toBe(257);
    } finally {
      await runner.close!();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
