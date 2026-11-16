import { describe, expect, it, vi } from 'vitest';

import { materializeWarehouseLeaf } from '../../../src/runtime/source-materializer/materialize-warehouse-leaf.js';
import { METADATA_TABLE } from '../../../src/runtime/source-materializer/metadata.js';

const METADATA_COLUMNS = [
  'source_name',
  'filter_hash',
  'loaded_at',
  'record_count',
  'etag',
  'cursor_field',
  'cursor_type',
  'cursor_value',
  'snapshot_kind',
  'snapshot_variant',
  'row_count',
  'in_progress_until',
];

/** An engine whose metadata table is complete and holds one fresh row for `accounts`. */
function engineRunner() {
  const statements: string[] = [];
  const handle = async (sql: string) => {
    statements.push(sql);
    if (sql.includes('INFORMATION_SCHEMA')) {
      return METADATA_COLUMNS.map((column_name) => ({ column_name }));
    }
    if (sql.includes(METADATA_TABLE) && /source_name\s*=/i.test(sql)) {
      return [
        {
          source_name: 'accounts',
          filter_hash: 'all',
          loaded_at: '2026-11-17T10:00:00.000Z',
          record_count: 3,
          row_count: 3,
          snapshot_kind: 'canonical',
          snapshot_variant: null,
          in_progress_until: null,
        },
      ];
    }
    return [];
  };
  return { run: vi.fn(handle), query: vi.fn(handle), statements };
}

async function reuseLeaf(engineDialect: 'bigquery' | 'duckdb') {
  const runner = engineRunner();
  const receipt = await materializeWarehouseLeaf({
    entry: {} as never,
    sourceName: 'accounts',
    schema: 'sources',
    database: {} as never,
    engineRunner: runner,
    sourceRunner: {} as never,
    dialect: 'snowflake',
    engineDialect,
    tempDir: '/tmp',
    mode: 'lazy',
    maxAge: '1h',
    currentFilterHash: 'all',
    nowIso: '2026-11-17T10:05:00.000Z',
  });
  return { receipt, statements: runner.statements };
}

describe('materializeWarehouseLeaf engine schema', () => {
  it('issues no dataset DDL on a BigQuery engine once the dataset exists', async () => {
    const { receipt, statements } = await reuseLeaf('bigquery');
    expect(receipt.action).toBe('reused');
    expect(statements.some((sql) => /CREATE SCHEMA/i.test(sql))).toBe(false);
  });

  it('still creates the engine schema on DuckDB before the freshness probe', async () => {
    const { receipt, statements } = await reuseLeaf('duckdb');
    expect(receipt.action).toBe('reused');
    expect(statements[0]).toBe('CREATE SCHEMA IF NOT EXISTS "sources"');
  });
});
