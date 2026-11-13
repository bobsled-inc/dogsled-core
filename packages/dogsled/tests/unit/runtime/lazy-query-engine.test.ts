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

// An earlier metadata table name stands in, so the takeover runs before and after the rename.
vi.mock('../../../src/runtime/source-materializer/legacy-names.js', () => ({
  LEGACY_METADATA_TABLES: ['_legacy_source_metadata'],
}));

vi.mock('@bobsled-inc/loader', () => ({
  createDefaultDatabaseDestination: vi.fn(() => ({
    close: vi.fn(async () => undefined),
  })),
}));

const bigQueryDestination = (dataset: string): ResolvedDestination => ({
  kind: 'bigquery',
  schema: dataset,
  table: 'issues',
  fullyQualified: `${dataset}.issues`,
  sqlRunnerKind: 'bigquery',
  config: {
    dest: 'bigquery',
    projectId: 'proof-project',
    datasetId: dataset,
    bufferSize: 100_000,
    logFormat: 'json',
    targetFileSizeMb: 256,
    stagingFormat: 'parquet',
    maxConcurrentLoads: 4,
    maxLoadJobs: 9000,
  },
});

describe('LazyQueryEngine', () => {
  it('probes for an earlier metadata table once per process, not once per query', async () => {
    const { runQueryCommand } = await import('../../../src/runtime/lazy-query-engine.js');
    const destination = bigQueryDestination('probe_once');
    const statements: string[] = [];
    const freshRunner = async () => ({
      run: vi.fn(async (sql: string) => void statements.push(sql)),
      query: vi.fn(async (sql: string) => (statements.push(sql), [])),
      close: vi.fn(async () => undefined),
    });
    mocks.materializeSource.mockResolvedValue({
      source: 'issues',
      target: 'bigquery',
      table: 'probe_once.issues',
      filterHash: 'hash',
      snapshotAgeSeconds: 0,
      records: 1,
      action: 'materialized',
      durationMs: 1,
    });
    for (let query = 0; query < 2; query++) {
      await runQueryCommand({
        projectRoot: '/tmp/project',
        sql: 'SELECT * FROM sources.issues',
        integrationSpecLoader: () => ({
          integration: {} as never,
          resource: { query: {} } as never,
        }),
        resolveDestinationImpl: async () => destination,
        createSqlRunnerImpl: freshRunner,
      });
    }
    expect(statements.filter((sql) => /WHERE 1 = 0/.test(sql))).toHaveLength(1);
  });

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
});
