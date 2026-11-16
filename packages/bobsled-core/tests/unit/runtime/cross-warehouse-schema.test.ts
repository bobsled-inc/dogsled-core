import { CommandError } from '@bobsled-inc/protocol';
import { describe, expect, it, vi } from 'vitest';

import { describeTable, enforceSchemaDrift } from '../../../src/runtime/cross-warehouse-schema.js';

import type { SqlRunnerModule } from '@bobsled-inc/connections';
import type { SchemaColumn } from '@bobsled-inc/protocol';

function runner(rows: Record<string, unknown>[]): SqlRunnerModule & {
  query: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
} {
  return {
    run: vi.fn(async () => ({})),
    query: vi.fn(async () => rows),
  };
}

const target = {
  schema: 'main',
  table: 'orders',
  fqn: '"main"."orders"',
  dialect: 'duckdb' as const,
};

describe('cross-warehouse schema helpers', () => {
  it('describes an existing table from information_schema rows', async () => {
    const r = runner([
      { column_name: 'order_id', data_type: 'BIGINT' },
      { column_name: 'amount', data_type: 'DOUBLE' },
    ]);

    await expect(describeTable(r, undefined, 'main', 'orders', 'duckdb')).resolves.toEqual([
      { name: 'order_id', type: 'integer' },
      { name: 'amount', type: 'number' },
    ]);
    expect(r.query.mock.calls[0]?.[0]).toContain('information_schema.columns');
  });

  it('returns null when the target table does not exist', async () => {
    await expect(describeTable(runner([]), undefined, 'main', 'orders', 'duckdb')).resolves.toBe(
      null
    );
  });

  it('throws CommandError(3) when schema drift policy is fail', async () => {
    const expected: SchemaColumn[] = [
      { name: 'order_id', type: 'integer' },
      { name: 'amount', type: 'number' },
    ];
    const r = runner([{ column_name: 'order_id', data_type: 'BIGINT' }]);

    const error = await enforceSchemaDrift(r, expected, target, 'fail').catch((err) => err);
    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({ exitCode: 3 });
  });

  it('drops the target and returns fullRefresh for full_refresh drift policy', async () => {
    const expected: SchemaColumn[] = [
      { name: 'order_id', type: 'integer' },
      { name: 'amount', type: 'number' },
    ];
    const r = runner([{ column_name: 'order_id', data_type: 'BIGINT' }]);

    await expect(enforceSchemaDrift(r, expected, target, 'full_refresh')).resolves.toEqual({
      fullRefresh: true,
    });
    expect(r.run).toHaveBeenCalledWith(`DROP TABLE IF EXISTS ${target.fqn}`);
  });
});

describe('describeTable BigQuery path hardening', () => {
  it('rejects hostile BigQuery schema paths before querying', async () => {
    const query = vi.fn(async () => []);
    const runner = { query } as unknown as SqlRunnerModule;
    await expect(describeTable(runner, 'p', 'd\\', 't', 'bigquery')).rejects.toThrow(
      'backslashes and control characters are not allowed'
    );
    await expect(describeTable(runner, 'p', 'd`x', 't', 'bigquery')).rejects.toThrow(
      'backticks are not allowed'
    );
    expect(query).not.toHaveBeenCalled();
  });
});
