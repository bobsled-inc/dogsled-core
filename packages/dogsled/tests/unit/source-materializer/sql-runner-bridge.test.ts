import { describe, expect, it, vi } from 'vitest';

import { createSqlRunnerFor } from '../../../src/runtime/source-materializer/sql-runner-bridge.js';

describe('createSqlRunnerFor', () => {
  it('resolves an in-memory DuckDB runner', async () => {
    const resolveRunnerImpl = vi.fn().mockResolvedValue({
      run: vi.fn(),
      query: vi.fn(),
      close: vi.fn(),
    });
    await createSqlRunnerFor({
      destination: {
        kind: 'in_memory',
        sqlRunnerKind: 'duckdb',
        schema: 'sources',
        table: 'x',
        fullyQualified: 'sources.x',
        config: {
          dest: 'duckdb',
          dbPath: ':memory:',
          targetSchema: 'sources',
          bufferSize: 100_000,
          logFormat: 'json',
          maxConcurrentLoads: 1,
        },
      },
      resolveRunnerImpl,
    });
    expect(resolveRunnerImpl).toHaveBeenCalledWith(
      expect.objectContaining({ source_type: 'duckdb', auth: { type: 'memory' } })
    );
  });

  it('boots DuckLake attach on ducklake destinations', async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({ rowCount: 0 }),
      close: vi.fn(),
    };
    const resolveRunnerImpl = vi.fn().mockResolvedValue(runner);
    await createSqlRunnerFor({
      destination: {
        kind: 'ducklake',
        sqlRunnerKind: 'duckdb',
        schema: 'sources',
        table: 'x',
        fullyQualified: 'sources.x',
        config: {
          dest: 'ducklake',
          catalogUrl: 'ducklake:/tmp/c.ducklake',
          attachAlias: 'lake',
          targetSchema: 'sources',
          bufferSize: 100_000,
          logFormat: 'json',
          maxConcurrentLoads: 1,
        },
      },
      resolveRunnerImpl,
    });
    const calls = runner.run.mock.calls.map((call: [string]) => call[0]);
    expect(calls.some((sql: string) => /INSTALL\s+ducklake/i.test(sql))).toBe(true);
    expect(calls.some((sql: string) => /LOAD\s+ducklake/i.test(sql))).toBe(true);
    expect(calls.some((sql: string) => /ATTACH\s+'ducklake:/i.test(sql))).toBe(true);
    expect(calls.some((sql: string) => /USE\s+"lake"/i.test(sql))).toBe(true);
  });

  it('passes through for BigQuery without a boot sequence', async () => {
    const runner = { run: vi.fn(), close: vi.fn() };
    const resolveRunnerImpl = vi.fn().mockResolvedValue(runner);
    await createSqlRunnerFor({
      destination: {
        kind: 'bigquery',
        sqlRunnerKind: 'bigquery',
        schema: 'analytics',
        table: 'x',
        fullyQualified: 'analytics.x',
        config: {
          dest: 'bigquery',
          projectId: 'p',
          datasetId: 'analytics',
          bufferSize: 100_000,
          logFormat: 'json',
          targetFileSizeMb: 256,
          stagingFormat: 'parquet',
          maxConcurrentLoads: 4,
          maxLoadJobs: 9000,
        },
      },
      resolveRunnerImpl,
    });
    expect(runner.run).not.toHaveBeenCalled();
  });
});
