import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { BigQueryDestination } from '../../../src/runtime/destinations/bigquery.js';
import { closeDuckDbResources, openDuckDb } from '../../../src/runtime/duckdb-primitives.js';

import type {
  BigQueryClientLike,
  BigQueryDatasetLike,
  BigQueryJobLike,
  BigQueryLoadJobResponse,
} from '../../../src/runtime/destinations/bigquery.js';
import type { SchemaColumn } from '@bobsled-inc/protocol';

const issueColumns: SchemaColumn[] = [
  { name: 'id', type: 'integer', primary_key: true },
  { name: 'title', type: 'string' },
];

const duckDbTypes: Partial<Record<SchemaColumn['type'], string>> = {
  integer: 'BIGINT',
  string: 'VARCHAR',
  timestamp: 'TIMESTAMP',
};

function toDuckDbSql(sql: string): string {
  return sql
    .replace(/`([^`]+)`/g, '"$1"')
    .replace(
      /FORMAT_DATE\('%Y-%m-%d', DATE\(((?:MIN|MAX)\([^()]+\))\)\)/g,
      "strftime(CAST($1 AS DATE), '%Y-%m-%d')"
    )
    .replace(/DATE\(([^()]+)\)/g, 'CAST($1 AS DATE)')
    .replace(/CURRENT_TIMESTAMP\(\)/g, 'CURRENT_TIMESTAMP')
    .replace(/ PARTITION BY CAST\([^()]+ AS DATE\)/, '')
    .replace(/ CLUSTER BY .*$/, '')
    .replace(/\bINT64\b/g, 'BIGINT')
    .replace(/\bSTRING\b/g, 'VARCHAR')
    .replace(/^MERGE /, 'MERGE INTO ');
}

/**
 * Replays the SQL the BigQuery destination emits for `ensureTable` + `merge`
 * against an in-memory DuckDB database, so merge tests can assert on the rows
 * left in the target table instead of only on SQL text. Only the statement
 * shapes on that path are translated; any other statement fails the test so the
 * replay cannot silently diverge from what BigQuery would receive.
 */
async function createMergeReplay(columns: SchemaColumn[]) {
  const db = await openDuckDb(':memory:');
  const conn = await db.connect();
  await conn.run('CREATE SCHEMA test_ds');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bq-merge-replay-'));
  const queries: string[] = [];

  const readJsonColumns = [...columns, { name: '_time_extracted', type: 'timestamp' as const }]
    .map((c) => {
      const type = duckDbTypes[c.type];
      if (!type) throw new Error(`merge replay has no DuckDB type for ${c.type}`);
      return `'${c.name}': '${type}'`;
    })
    .join(', ');

  async function runQuery(options: { query: string }): Promise<[BigQueryJobLike]> {
    const { query } = options;
    if (!/^(CREATE TABLE|SELECT FORMAT_DATE|MERGE|DROP TABLE)/.test(query)) {
      throw new Error(`merge replay cannot translate: ${query}`);
    }
    queries.push(query);
    const rows = await conn.all(toDuckDbSql(query));
    return [{ getQueryResults: vi.fn().mockResolvedValue([rows]) }];
  }

  const dataset: BigQueryDatasetLike = {
    exists: vi.fn().mockResolvedValue([true]),
    create: vi.fn().mockResolvedValue(undefined),
    table: (name: string) => ({
      exists: vi.fn().mockResolvedValue([false]),
      load: vi.fn(async (source: string) => {
        await conn.run(
          `CREATE OR REPLACE TABLE test_ds."${name}" AS SELECT * FROM read_json('${source}', format = 'newline_delimited', columns = {${readJsonColumns}})`
        );
        return [{ status: {} }] as [BigQueryLoadJobResponse];
      }),
      getMetadata: vi.fn().mockResolvedValue([{ schema: { fields: [] } }]),
      setMetadata: vi.fn().mockResolvedValue(undefined),
    }),
    createQueryJob: vi.fn(runQuery),
  };
  const client: BigQueryClientLike = {
    dataset: vi.fn().mockReturnValue(dataset),
    createQueryJob: vi.fn(runQuery),
  };
  const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });
  let batch = 0;

  return {
    dest,
    queries,
    /** Run DuckDB SQL directly, to seed target state the loader would not produce itself. */
    exec(sql: string): Promise<void> {
      return conn.run(sql);
    },
    async merge(table: string, rows: Record<string, unknown>[], keyColumns: string[]) {
      batch += 1;
      const file = path.join(tempDir, `${table}-${batch}.jsonl`);
      await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n'));
      await dest.loadAndFinalize('test_ds', table, file, columns, 'merge', keyColumns);
    },
    async rows(table: string): Promise<Array<[number, unknown]>> {
      const rows = await conn.all(`SELECT id, title FROM test_ds."${table}" ORDER BY ALL`);
      return rows.map((row) => [Number(row['id']), row['title']]);
    },
    async close() {
      await dest.close();
      await closeDuckDbResources(conn, db);
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

describe('BigQueryDestination — merge keeps one row per key across partitions', () => {
  const day1 = '2026-09-27T06:00:00.000Z';
  const day2 = '2026-09-28T06:00:00.000Z';

  it('re-merging the same keys on a later extraction day updates instead of inserting (_time_extracted partitioning)', async () => {
    const replay = await createMergeReplay(issueColumns);
    try {
      await replay.dest.ensureTable('test_ds', 'issues', issueColumns, { keyProperties: ['id'] });
      await replay.merge(
        'issues',
        [1, 2, 3].map((id) => ({ id, title: `v1-${id}`, _time_extracted: day1 })),
        ['id']
      );
      await replay.merge(
        'issues',
        [1, 2, 3].map((id) => ({ id, title: `v2-${id}`, _time_extracted: day2 })),
        ['id']
      );

      expect(replay.queries.find((q) => q.startsWith('CREATE TABLE'))).toContain(
        'PARTITION BY DATE(`_time_extracted`)'
      );
      expect(await replay.rows('issues')).toEqual([
        [1, 'v2-1'],
        [2, 'v2-2'],
        [3, 'v2-3'],
      ]);
      // The target partition column must not narrow which existing rows can match.
      for (const sql of replay.queries.filter((q) => q.startsWith('MERGE'))) {
        expect(sql).toMatch(/ ON T\.`id` = S\.`id` WHEN MATCHED /);
      }
    } finally {
      await replay.close();
    }
  });

  it.each([
    ['timestamp cursor_field', { cursorField: 'updated_at' }],
    ['explicit partition_by', { partitionBy: 'updated_at' }],
  ])(
    'a row whose partition value moves to a later day is updated, not duplicated (%s)',
    async (_label, partitionOptions) => {
      const columns: SchemaColumn[] = [...issueColumns, { name: 'updated_at', type: 'timestamp' }];
      const replay = await createMergeReplay(columns);
      try {
        await replay.dest.ensureTable('test_ds', 'issues', columns, {
          keyProperties: ['id'],
          ...partitionOptions,
        });
        await replay.merge(
          'issues',
          [
            { id: 1, title: 'open', updated_at: '2026-09-01T10:00:00.000Z', _time_extracted: day1 },
            { id: 2, title: 'open', updated_at: '2026-09-01T10:00:00.000Z', _time_extracted: day1 },
          ],
          ['id']
        );
        // Incremental run: only the changed row, with its cursor in a newer partition.
        await replay.merge(
          'issues',
          [
            {
              id: 1,
              title: 'closed',
              updated_at: '2026-09-20T10:00:00.000Z',
              _time_extracted: day2,
            },
          ],
          ['id']
        );

        expect(replay.queries.find((q) => q.startsWith('CREATE TABLE'))).toContain(
          'PARTITION BY DATE(`updated_at`)'
        );
        expect(await replay.rows('issues')).toEqual([
          [1, 'closed'],
          [2, 'open'],
        ]);
      } finally {
        await replay.close();
      }
    }
  );

  it('updates an existing row whose _time_extracted is NULL instead of leaving it stale', async () => {
    const replay = await createMergeReplay(issueColumns);
    try {
      await replay.dest.ensureTable('test_ds', 'issues', issueColumns, { keyProperties: ['id'] });
      // A table Bobsled Core adopted: ensureTable adds _time_extracted, leaving existing rows NULL.
      await replay.exec(`INSERT INTO test_ds.issues (id, title) VALUES (1, 'legacy')`);

      await replay.merge('issues', [{ id: 1, title: 'fresh', _time_extracted: day2 }], ['id']);

      expect(await replay.rows('issues')).toEqual([[1, 'fresh']]);
    } finally {
      await replay.close();
    }
  });
});
