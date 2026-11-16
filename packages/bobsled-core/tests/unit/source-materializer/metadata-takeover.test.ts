import { DuckDBInstance } from '@duckdb/node-api';
import { describe, expect, it, vi } from 'vitest';

import {
  METADATA_TABLE,
  ensureMetadataTable,
  readMetadataRow,
} from '../../../src/runtime/source-materializer/metadata.js';

// Generic takeover test: an earlier name stands in, so this passes before and
// after the Bobsled Core -> Bobsled rename changes the current table name.
vi.mock('../../../src/runtime/source-materializer/legacy-names.js', () => ({
  LEGACY_METADATA_TABLES: ['_legacy_source_metadata'],
}));

async function duckdbRunner() {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  return {
    run: async (sql: string) => {
      await connection.run(sql);
      return { rows: [], rowCount: 0 };
    },
    query: async (sql: string) => (await connection.runAndReadAll(sql)).getRowObjectsJson(),
    tables: async () =>
      (
        await connection.runAndReadAll(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = 'raw' ORDER BY table_name`
        )
      )
        .getRowObjectsJson()
        .map((row) => String(row['table_name'])),
  };
}

const LEGACY_ROW = `INSERT INTO raw._legacy_source_metadata (source_name, filter_hash, loaded_at, record_count, etag)
  VALUES ('issues', 'abc', TIMESTAMP '2026-01-02 03:04:05', 7, 'W/"1"')`;

describe('source metadata table takeover', () => {
  it('renames an earlier metadata table in place so cursors and ETags survive', async () => {
    const runner = await duckdbRunner();
    await runner.run('CREATE SCHEMA raw');
    await runner.run(
      `CREATE TABLE raw._legacy_source_metadata (source_name VARCHAR, filter_hash VARCHAR, loaded_at TIMESTAMP, record_count BIGINT, etag VARCHAR)`
    );
    await runner.run(LEGACY_ROW);

    await ensureMetadataTable({ runner, schema: 'raw', dialect: 'duckdb' });
    await ensureMetadataTable({ runner, schema: 'raw', dialect: 'duckdb' });

    expect(await runner.tables()).toEqual([METADATA_TABLE]);
    const row = await readMetadataRow({
      runner,
      schema: 'raw',
      sourceName: 'issues',
      filterHash: 'abc',
      dialect: 'duckdb',
    });
    expect(row).toMatchObject({ source_name: 'issues', record_count: 7, etag: 'W/"1"' });
  });

  it('keeps the current table when both exist and never drops the earlier one', async () => {
    const runner = await duckdbRunner();
    await runner.run('CREATE SCHEMA raw');
    await runner.run(
      `CREATE TABLE raw._legacy_source_metadata (source_name VARCHAR, filter_hash VARCHAR, loaded_at TIMESTAMP, record_count BIGINT, etag VARCHAR)`
    );
    await runner.run(LEGACY_ROW);
    await ensureMetadataTable({ runner, schema: 'raw', dialect: 'duckdb' });
    await runner.run(
      `CREATE TABLE raw._legacy_source_metadata (source_name VARCHAR, filter_hash VARCHAR, loaded_at TIMESTAMP, record_count BIGINT, etag VARCHAR)`
    );

    await ensureMetadataTable({ runner, schema: 'raw', dialect: 'duckdb' });

    expect(await runner.tables()).toEqual(['_legacy_source_metadata', METADATA_TABLE].sort());
  });

  it('creates the current table on a fresh schema', async () => {
    const runner = await duckdbRunner();
    await runner.run('CREATE SCHEMA raw');
    await ensureMetadataTable({ runner, schema: 'raw', dialect: 'duckdb' });
    expect(await runner.tables()).toEqual([METADATA_TABLE]);
  });
});
