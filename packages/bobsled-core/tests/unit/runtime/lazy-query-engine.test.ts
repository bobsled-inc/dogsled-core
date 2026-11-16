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
});
