import { describe, expect, it, vi } from 'vitest';

import type { ResolvedDestination } from '../../../src/runtime/source-materializer/destination-resolver.js';
import type { ApiResourceEntry } from '../../../src/runtime/source-materializer/load-specs.js';

const mocks = vi.hoisted(() => ({
  materializeSource: vi.fn(),
}));

vi.mock('../../../src/runtime/source-materializer/load-specs.js', () => ({
  loadApiResourceEntries: vi.fn(async () => [
    {
      kind: 'api_resource',
      fqRef: 'sources.issues',
      integration: 'github',
      resource: 'issues',
      connection: 'github_prod',
      maxAge: '15m',
      columns: [{ name: 'id', type: 'integer' }],
    } satisfies ApiResourceEntry,
  ]),
  sourceNameOf: (entry: ApiResourceEntry) => entry.fqRef.slice('sources.'.length),
}));

vi.mock('../../../src/runtime/source-materializer/materializer.js', () => ({
  formatReceipt: () => 'source=issues target=bigquery table=analytics.issues action=materialized',
  materializeSource: mocks.materializeSource,
}));

vi.mock('@bobsled-inc/loader', () => ({
  createDefaultDatabaseDestination: vi.fn(() => ({
    close: vi.fn(async () => undefined),
  })),
}));

describe('LazyQueryEngine', () => {
  it('does not pass transaction refresh leases to BigQuery materializations', async () => {
    const { runQueryCommand } = await import('../../../src/runtime/lazy-query-engine.js');
    const destination: ResolvedDestination = {
      kind: 'bigquery',
      schema: 'analytics',
      table: 'issues',
      fullyQualified: 'analytics.issues',
      sqlRunnerKind: 'bigquery',
      config: {
        dest: 'bigquery',
        datasetId: 'analytics',
        bufferSize: 100_000,
        logFormat: 'json',
        targetFileSizeMb: 256,
        stagingFormat: 'parquet',
        maxConcurrentLoads: 4,
        maxLoadJobs: 9000,
      },
    };
    const runner = {
      run: vi.fn(async () => undefined),
      query: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
    };
    mocks.materializeSource.mockResolvedValue({
      source: 'issues',
      target: 'bigquery',
      table: 'analytics.issues',
      filterHash: 'hash',
      snapshotAgeSeconds: 0,
      records: 1,
      action: 'materialized',
      durationMs: 1,
    });

    await runQueryCommand({
      projectRoot: '/tmp/project',
      sql: 'SELECT * FROM sources.issues',
      integrationSpecLoader: () => ({ integration: {} as never, resource: { query: {} } as never }),
      resolveDestinationImpl: async () => destination,
      createSqlRunnerImpl: async () => runner,
    });

    const call = mocks.materializeSource.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.beginRefresh).toBeUndefined();
    expect(call.finishRefresh).toBeUndefined();
    expect(call.readRow).toBeTypeOf('function');
    expect(call.upsertRow).toBeTypeOf('function');
    expect(runner.run).not.toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(runner.run).not.toHaveBeenCalledWith('BEGIN TRANSACTION');
  });

  describe('BigQuery table updates per lazy query', () => {
    // BigQuery allows about five metadata updates per table every ten seconds,
    // and a no-op CREATE TABLE IF NOT EXISTS or ADD COLUMN IF NOT EXISTS still
    // counts. This fake tracks the metadata table's columns and records every
    // table DDL statement so each lazy query's update count can be asserted.
    const ALL_COLUMNS = [
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

    function fakeBigQueryRunner(initialColumns?: string[]) {
      let columns = initialColumns ? [...initialColumns] : undefined;
      const tableDdl: string[] = [];
      const metadataReads: string[] = [];
      const runner = {
        run: vi.fn(async (sql: string) => {
          if (!/^\s*(CREATE|ALTER|DROP)\s+TABLE\b/i.test(sql)) return undefined;
          tableDdl.push(sql);
          if (/^\s*CREATE\s+TABLE/i.test(sql) && columns === undefined) {
            columns = [...sql.matchAll(/(\w+)\s+(?:STRING|TIMESTAMP|INT64)\b/g)].map((m) => m[1]!);
          }
          for (const match of sql.matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g)) {
            if (columns && !columns.includes(match[1]!)) columns.push(match[1]!);
          }
          return undefined;
        }),
        query: vi.fn(async (sql: string) => {
          if (/INFORMATION_SCHEMA\.COLUMNS/.test(sql)) {
            metadataReads.push(sql);
            return (columns ?? []).map((column_name) => ({ column_name }));
          }
          return [];
        }),
        close: vi.fn(async () => undefined),
      };
      return { runner, tableDdl, metadataReads, columns: () => columns };
    }

    async function lazyQuery(runner: ReturnType<typeof fakeBigQueryRunner>['runner']) {
      const { runQueryCommand } = await import('../../../src/runtime/lazy-query-engine.js');
      await runQueryCommand({
        projectRoot: '/tmp/project',
        sql: 'SELECT * FROM sources.issues',
        integrationSpecLoader: () => ({
          integration: {} as never,
          resource: { query: {} } as never,
        }),
        resolveDestinationImpl: async () => ({
          kind: 'bigquery',
          schema: 'analytics',
          table: 'issues',
          fullyQualified: 'analytics.issues',
          sqlRunnerKind: 'bigquery',
          config: {
            dest: 'bigquery',
            datasetId: 'analytics',
            bufferSize: 100_000,
            logFormat: 'json',
            targetFileSizeMb: 256,
            stagingFormat: 'parquet',
            maxConcurrentLoads: 4,
            maxLoadJobs: 9000,
          },
        }),
        createSqlRunnerImpl: async () => runner,
      });
    }

    function materializeThroughMetadataStore() {
      mocks.materializeSource.mockImplementation(async (args) => {
        await args.readRow({ schema: 'analytics', sourceName: 'issues', filterHash: 'hash' });
        await args.upsertRow({
          schema: 'analytics',
          row: {
            source_name: 'issues',
            filter_hash: 'hash',
            loaded_at: '2026-11-16T00:00:00.000Z',
            record_count: 1,
          },
        });
        return {
          source: 'issues',
          target: 'bigquery',
          table: 'analytics.issues',
          filterHash: 'hash',
          snapshotAgeSeconds: 0,
          records: 1,
          action: 'materialized',
          durationMs: 1,
        };
      });
    }

    it('creates a fresh metadata table with one statement and then issues no DDL', async () => {
      materializeThroughMetadataStore();
      const fake = fakeBigQueryRunner();

      await lazyQuery(fake.runner);
      expect(fake.tableDdl).toHaveLength(1);
      expect(fake.tableDdl[0]).toMatch(
        /^CREATE TABLE IF NOT EXISTS `analytics`.`_bobsled_source_metadata`/
      );
      expect(fake.columns()).toEqual(ALL_COLUMNS);

      await lazyQuery(fake.runner);
      expect(fake.tableDdl).toHaveLength(1);
    });

    it('adds every missing column to an older metadata table in one ALTER TABLE', async () => {
      materializeThroughMetadataStore();
      const fake = fakeBigQueryRunner(ALL_COLUMNS.slice(0, 5));

      await lazyQuery(fake.runner);
      expect(fake.tableDdl).toEqual([
        'ALTER TABLE `analytics`.`_bobsled_source_metadata` ' +
          'ADD COLUMN IF NOT EXISTS cursor_field STRING, ADD COLUMN IF NOT EXISTS cursor_type STRING, ' +
          'ADD COLUMN IF NOT EXISTS cursor_value STRING, ADD COLUMN IF NOT EXISTS snapshot_kind STRING, ' +
          'ADD COLUMN IF NOT EXISTS snapshot_variant STRING, ADD COLUMN IF NOT EXISTS row_count INT64, ' +
          'ADD COLUMN IF NOT EXISTS in_progress_until TIMESTAMP',
      ]);
      expect(fake.columns()).toEqual(ALL_COLUMNS);

      await lazyQuery(fake.runner);
      expect(fake.tableDdl).toHaveLength(1);
    });

    it('issues no table DDL when the metadata table is already complete', async () => {
      materializeThroughMetadataStore();
      const fake = fakeBigQueryRunner(ALL_COLUMNS);

      await lazyQuery(fake.runner);
      await lazyQuery(fake.runner);

      expect(fake.tableDdl).toEqual([]);
      // One schema read per query: the engine ensures the table and tells the
      // metadata store, so the store does not read it again.
      expect(fake.metadataReads).toHaveLength(2);
      // No dataset DDL either: CREATE SCHEMA runs only when the dataset is missing.
      expect(fake.runner.run).not.toHaveBeenCalledWith(expect.stringMatching(/CREATE SCHEMA/));
      expect(fake.runner.run).toHaveBeenCalledWith(expect.stringMatching(/^MERGE /));
    });
  });
});
