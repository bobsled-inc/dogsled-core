import { describe, expect, it, vi } from 'vitest';

import { withScratchTable } from '../../../src/runtime/source-materializer/scratch-table.js';

function makeRunner() {
  const calls: string[] = [];
  return {
    calls,
    runner: {
      run: vi.fn(async (sql: string) => {
        calls.push(sql);
      }),
    },
  };
}

describe('withScratchTable', () => {
  it('creates and drops a duckdb temp.main scratch table', async () => {
    const { runner, calls } = makeRunner();

    await withScratchTable(
      {
        runner,
        dialect: 'duckdb',
        schema: 'main',
        baseName: 'issues',
        ttlSeconds: 300,
        columns: [{ name: 'id', type: 'integer' }],
      },
      async (scratch) => {
        expect(scratch.qualifiedName).toMatch(/^temp\.main\."issues_scratch_/);
      }
    );

    expect(calls.some((sql) => /CREATE TEMP TABLE temp\.main\./.test(sql))).toBe(true);
    expect(calls.some((sql) => /DROP TABLE IF EXISTS temp\.main\./.test(sql))).toBe(true);
  });

  it('preserves duckdb vector dimensions in scratch tables', async () => {
    const { runner, calls } = makeRunner();

    await withScratchTable(
      {
        runner,
        dialect: 'duckdb',
        schema: 'main',
        baseName: 'embeddings',
        ttlSeconds: 300,
        columns: [{ name: 'body_embedding', type: 'vector', dimension: 3 }],
      },
      async () => undefined
    );

    expect(calls.some((sql) => /"body_embedding" FLOAT\[3\]/.test(sql))).toBe(true);
  });

  it('creates a named bigquery table with expiration_timestamp', async () => {
    const { runner, calls } = makeRunner();

    await withScratchTable(
      {
        runner,
        dialect: 'bigquery',
        schema: 'analytics',
        baseName: 'issues',
        ttlSeconds: 900,
        columns: [{ name: 'id', type: 'integer' }],
      },
      async () => undefined
    );

    expect(
      calls.some(
        (sql) =>
          /CREATE TABLE `analytics`\.`issues_scratch_/.test(sql) &&
          /OPTIONS \(expiration_timestamp = TIMESTAMP_ADD\(CURRENT_TIMESTAMP\(\), INTERVAL 900 SECOND\)\)/.test(
            sql
          )
      )
    ).toBe(true);
  });

  it('creates a TRANSIENT table on snowflake', async () => {
    const { runner, calls } = makeRunner();

    await withScratchTable(
      {
        runner,
        dialect: 'snowflake',
        schema: 'PUBLIC',
        baseName: 'issues',
        ttlSeconds: 300,
        columns: [{ name: 'id', type: 'integer' }],
      },
      async () => undefined
    );

    expect(calls.some((sql) => /CREATE TRANSIENT TABLE "PUBLIC"\."issues_scratch_/.test(sql))).toBe(
      true
    );
  });

  it('drops the scratch table even when the body throws', async () => {
    const { runner, calls } = makeRunner();

    await expect(
      withScratchTable(
        {
          runner,
          dialect: 'duckdb',
          schema: 'main',
          baseName: 'issues',
          ttlSeconds: 300,
          columns: [{ name: 'id', type: 'integer' }],
        },
        async () => {
          throw new Error('boom');
        }
      )
    ).rejects.toThrow('boom');

    expect(calls.some((sql) => /DROP TABLE IF EXISTS temp\.main\./.test(sql))).toBe(true);
  });
});
