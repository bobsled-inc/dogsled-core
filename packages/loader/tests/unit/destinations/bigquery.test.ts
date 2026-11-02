import { describe, expect, it, vi } from 'vitest';

import {
  BigQueryDestination,
  buildBigQuerySchemaField,
  mapBigQueryType,
} from '../../../src/runtime/destinations/bigquery.js';

import type {
  BigQueryClientLike,
  BigQueryDatasetLike,
  BigQueryJobLike,
  BigQueryLoadJobResponse,
  BigQueryTableLike,
} from '../../../src/runtime/destinations/bigquery.js';
import type { SchemaColumn } from '@bobsled-inc/protocol';

const issueColumns: SchemaColumn[] = [
  { name: 'id', type: 'integer', primary_key: true },
  { name: 'title', type: 'string' },
];

function createMockJob(
  rows: Record<string, unknown>[] = [],
  metadata?: BigQueryJobLike['metadata']
): BigQueryJobLike {
  return {
    getQueryResults: vi.fn().mockResolvedValue([rows]),
    metadata,
  };
}

function createMockTable(
  options: {
    exists?: boolean;
    metadata?: {
      schema?: { fields?: Array<{ name: string; type: string; mode?: string }> };
      clustering?: { fields?: string[] };
      labels?: Record<string, string>;
      type?: string;
      externalDataConfiguration?: unknown;
    };
    loadErrors?: Array<{ message: string }>;
    loadOutputRows?: string;
  } = {}
): BigQueryTableLike {
  const loadResponse: BigQueryLoadJobResponse = {
    status: { errors: options.loadErrors },
    statistics: options.loadOutputRows
      ? { load: { outputRows: options.loadOutputRows } }
      : undefined,
  };
  return {
    exists: vi.fn().mockResolvedValue([options.exists ?? false]),
    load: vi.fn().mockResolvedValue([loadResponse]),
    getMetadata: vi.fn().mockResolvedValue([options.metadata ?? { schema: { fields: [] } }]),
    setMetadata: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockDataset(
  options: {
    exists?: boolean;
    tables?: Map<string, BigQueryTableLike>;
  } = {}
): BigQueryDatasetLike {
  const tables = options.tables ?? new Map();
  return {
    exists: vi.fn().mockResolvedValue([options.exists ?? false]),
    create: vi.fn().mockResolvedValue(undefined),
    table: vi.fn((name: string) => tables.get(name) ?? createMockTable()),
    createQueryJob: vi.fn().mockResolvedValue([createMockJob()]),
  };
}

function createMockClient(dataset?: BigQueryDatasetLike): BigQueryClientLike {
  const ds = dataset ?? createMockDataset({ exists: true });
  return {
    dataset: vi.fn().mockReturnValue(ds),
    createQueryJob: vi.fn().mockResolvedValue([createMockJob()]),
  };
}

describe('BigQueryDestination', () => {
  it('creates a reserved table with its ownership label and rejects a different label', async () => {
    const marker = 'temp-dataset-019a';
    const table = createMockTable({
      metadata: {
        type: 'TABLE',
        labels: { dogsled_temp_dataset: marker },
        schema: {
          fields: [
            { name: 'id', type: 'INT64' },
            { name: 'title', type: 'STRING' },
            { name: '_time_extracted', type: 'TIMESTAMP' },
            { name: '_dogsled_loaded_at', type: 'TIMESTAMP' },
          ],
        },
      },
    });
    vi.mocked(table.exists).mockResolvedValueOnce([false]).mockResolvedValue([true]);
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });
    await dest.initialize();
    await dest.ensureTable('test_ds', 'issues', issueColumns, { tableOwnershipMarker: marker });
    expect(vi.mocked(client.createQueryJob).mock.calls[0]?.[0].query).toContain(
      'OPTIONS(labels=[("dogsled_temp_dataset", "temp-dataset-019a")])'
    );

    vi.mocked(table.getMetadata).mockResolvedValue([
      { type: 'TABLE', labels: { dogsled_temp_dataset: 'someone-else' }, schema: { fields: [] } },
    ]);
    await expect(
      dest.ensureTable('test_ds', 'issues', issueColumns, { tableOwnershipMarker: marker })
    ).rejects.toThrow('ownership marker does not match');
  });

  it('rejects a pre-existing unmarked reserved table before schema changes', async () => {
    const table = createMockTable({ exists: true, metadata: { schema: { fields: [] } } });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });
    await dest.initialize();
    await expect(
      dest.ensureTable('test_ds', 'issues', issueColumns, {
        tableOwnershipMarker: 'temp-dataset-019a',
      })
    ).rejects.toThrow('ownership marker does not match');
    expect(client.createQueryJob).not.toHaveBeenCalled();
  });
  it('rejects a same-marker external table before changing it', async () => {
    const marker = 'temp-dataset-019a';
    const table = createMockTable({
      exists: true,
      metadata: {
        type: 'EXTERNAL',
        externalDataConfiguration: {},
        labels: { dogsled_temp_dataset: marker },
        schema: { fields: [] },
      },
    });
    const client = createMockClient(
      createMockDataset({ exists: true, tables: new Map([['issues', table]]) })
    );
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });
    await dest.initialize();
    await expect(
      dest.ensureTable('test_ds', 'issues', issueColumns, { tableOwnershipMarker: marker })
    ).rejects.toThrow('managed base table');
    expect(client.createQueryJob).not.toHaveBeenCalled();
  });

  it('reads actual columns after a same-marker create race', async () => {
    const marker = 'temp-dataset-019a';
    const table = createMockTable({
      metadata: {
        type: 'TABLE',
        labels: { dogsled_temp_dataset: marker },
        schema: { fields: [{ name: 'different', type: 'STRING' }] },
      },
    });
    vi.mocked(table.exists).mockResolvedValueOnce([false]).mockResolvedValue([true]);
    const client = createMockClient(
      createMockDataset({ exists: true, tables: new Map([['issues', table]]) })
    );
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });
    await dest.initialize();
    await expect(
      dest.ensureTable('test_ds', 'issues', issueColumns, {
        tableOwnershipMarker: marker,
        schemaBehavior: 'strict',
      })
    ).rejects.toThrow();
  });
  it('maps vector columns to ARRAY<FLOAT64> and repeated FLOAT64 schema fields', () => {
    const column: SchemaColumn = { name: 'embedding', type: 'vector', dimension: 1536 };

    expect(mapBigQueryType(column)).toBe('ARRAY<FLOAT64>');
    expect(buildBigQuerySchemaField(column)).toEqual({
      name: 'embedding',
      type: 'FLOAT64',
      mode: 'REPEATED',
    });
  });

  it('normalizes legacy repeated FLOAT metadata for existing vector columns', async () => {
    const table = createMockTable({
      exists: true,
      metadata: {
        schema: {
          fields: [
            { name: 'id', type: 'INT64' },
            { name: 'embedding', type: 'FLOAT', mode: 'REPEATED' },
            { name: '_time_extracted', type: 'TIMESTAMP' },
            { name: '_dogsled_loaded_at', type: 'TIMESTAMP' },
          ],
        },
      },
    });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['embeddings', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();
    await expect(
      dest.ensureTable('test_ds', 'embeddings', [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'embedding', type: 'vector', dimension: 3 },
      ])
    ).resolves.toBeUndefined();
    expect(client.createQueryJob).not.toHaveBeenCalled();
  });

  it('initialize() creates dataset if not exists', async () => {
    const dataset = createMockDataset({ exists: false });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();

    expect(dataset.exists).toHaveBeenCalled();
    expect(dataset.create).toHaveBeenCalled();
  });

  it('initialize() skips creation if dataset exists', async () => {
    const dataset = createMockDataset({ exists: true });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();

    expect(dataset.exists).toHaveBeenCalled();
    expect(dataset.create).not.toHaveBeenCalled();
  });

  it('ensureTable() creates table via DDL with correct BigQuery types', async () => {
    const table = createMockTable({ exists: false });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();
    await dest.ensureTable('test_ds', 'issues', issueColumns);

    // Should have created a DDL query
    expect(client.createQueryJob).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining('CREATE TABLE IF NOT EXISTS'),
      })
    );
    const call = vi.mocked(client.createQueryJob).mock.calls[0]!;
    const query = call[0].query;
    expect(query).toContain('INT64');
    expect(query).toContain('STRING');
    expect(query).toContain('_time_extracted');
    expect(query).toContain('_dogsled_loaded_at');
  });

  it('loadFromUri loads GCS URIs via LOAD DATA INTO, never table.load', async () => {
    // Regression: the BigQuery SDK treats a *string* source in `table.load(<src>)`
    // as a LOCAL file path (opens an fs ReadStream), so passing a `gs://...` URI —
    // e.g. the wildcard URIs an UNLOAD/EXPORT emits during cross-warehouse publish
    // — fails with ENOENT and crashes on the stream's unhandled async error. The
    // load must go through a `LOAD DATA INTO ... FROM FILES(uris=[...])` statement,
    // which loads natively from GCS.
    const table = createMockTable({ exists: false });
    const dataset = createMockDataset({ exists: true, tables: new Map([['stg', table]]) });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({
      datasetId: 'test_ds',
      client,
      stagingFormat: 'parquet',
    });

    await dest.initialize();
    await dest.loadFromUri('test_ds', 'stg', ['gs://bucket/run/_stg/*.parquet'], issueColumns);

    // The local-file API must never be used for a GCS load.
    expect(table.load).not.toHaveBeenCalled();

    const queries = vi.mocked(client.createQueryJob).mock.calls.map((c) => c[0].query);
    expect(queries.some((q) => q.includes('TRUNCATE TABLE'))).toBe(true);
    const loadData = queries.find((q) => q.includes('LOAD DATA INTO'));
    expect(loadData).toBeDefined();
    expect(loadData).toContain("uris = ['gs://bucket/run/_stg/*.parquet']");
    expect(loadData).toContain("format = 'PARQUET'");
  });

  it('loadFromUri with no URIs truncates the table and never loads', async () => {
    const table = createMockTable({ exists: true });
    const dataset = createMockDataset({ exists: true, tables: new Map([['stg', table]]) });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({
      datasetId: 'test_ds',
      client,
      stagingFormat: 'parquet',
    });

    await dest.initialize();
    const result = await dest.loadFromUri('test_ds', 'stg', [], issueColumns);

    expect(result.rowsAffected).toBe(0);
    expect(table.load).not.toHaveBeenCalled();
    const queries = vi.mocked(client.createQueryJob).mock.calls.map((c) => c[0].query);
    expect(queries.some((q) => q.includes('TRUNCATE TABLE'))).toBe(true);
    expect(queries.some((q) => q.includes('LOAD DATA'))).toBe(false);
  });

  it('loadFromUri rejects non-gs:// URIs before building the load statement', async () => {
    const table = createMockTable({ exists: false });
    const dataset = createMockDataset({ exists: true, tables: new Map([['stg', table]]) });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({
      datasetId: 'test_ds',
      client,
      stagingFormat: 'parquet',
    });

    await dest.initialize();
    await expect(
      dest.loadFromUri('test_ds', 'stg', ['/tmp/local/file.parquet'], issueColumns)
    ).rejects.toThrow(/gs:\/\//);

    const queries = vi.mocked(client.createQueryJob).mock.calls.map((c) => c[0].query);
    expect(queries.some((q) => q.includes('LOAD DATA'))).toBe(false);
  });

  it('ensureTable() creates table with PARTITION BY and CLUSTER BY from options', async () => {
    const table = createMockTable({ exists: false });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    const columns: SchemaColumn[] = [
      { name: 'id', type: 'integer', primary_key: true },
      { name: 'title', type: 'string' },
      { name: 'updated_at', type: 'timestamp' },
    ];

    await dest.initialize();
    await dest.ensureTable('test_ds', 'issues', columns, {
      keyProperties: ['id'],
      cursorField: 'updated_at',
    });

    const call = vi.mocked(client.createQueryJob).mock.calls[0]!;
    const query = call[0].query;
    // Timestamp cursor_field is resolved as partition column, not _time_extracted
    expect(query).toContain('PARTITION BY DATE(`updated_at`)');
    // Partition column is excluded from CLUSTER BY
    expect(query).toContain('CLUSTER BY `id`');
  });

  it('ensureTable() honors explicit partitionBy over cursorField', async () => {
    const table = createMockTable({ exists: false });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['costs', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    const columns: SchemaColumn[] = [
      { name: 'id', type: 'integer', primary_key: true },
      { name: 'updated_at', type: 'timestamp' },
      { name: 'accrued_at', type: 'timestamp' },
    ];

    await dest.initialize();
    await dest.ensureTable('test_ds', 'costs', columns, {
      keyProperties: ['id'],
      cursorField: 'updated_at',
      partitionBy: 'accrued_at',
    });

    const query = vi.mocked(client.createQueryJob).mock.calls[0]![0].query;
    expect(query).toContain('PARTITION BY DATE(`accrued_at`)');
    expect(query).not.toContain('PARTITION BY DATE(`updated_at`)');
  });

  it('ensureTable() updates clustering on existing table when different', async () => {
    const table = createMockTable({
      exists: true,
      metadata: {
        schema: {
          fields: [
            { name: 'id', type: 'INT64' },
            { name: 'title', type: 'STRING' },
            { name: 'updated_at', type: 'TIMESTAMP' },
            { name: '_time_extracted', type: 'TIMESTAMP' },
            { name: '_dogsled_loaded_at', type: 'TIMESTAMP' },
          ],
        },
        clustering: { fields: ['id'] },
      },
    });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();
    await dest.ensureTable(
      'test_ds',
      'issues',
      [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'title', type: 'string' },
        { name: 'updated_at', type: 'timestamp' },
      ],
      {
        keyProperties: ['id'],
        cursorField: 'updated_at',
      }
    );

    // Should have called setMetadata to update clustering
    expect(table.setMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        clustering: { fields: ['updated_at', 'id'] },
      })
    );
  });

  it('ensureTable() skips clustering update when already matching', async () => {
    const table = createMockTable({
      exists: true,
      metadata: {
        schema: {
          fields: [
            { name: 'id', type: 'INT64' },
            { name: 'title', type: 'STRING' },
            { name: '_time_extracted', type: 'TIMESTAMP' },
            { name: '_dogsled_loaded_at', type: 'TIMESTAMP' },
          ],
        },
        clustering: { fields: ['id'] },
      },
    });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();
    await dest.ensureTable('test_ds', 'issues', issueColumns, {
      keyProperties: ['id'],
    });

    // Should NOT have called ALTER TABLE SET OPTIONS — clustering already matches
    const queryJobCalls = vi.mocked(client.createQueryJob).mock.calls;
    const clusterCall = queryJobCalls.find((c) => c[0].query.includes('SET OPTIONS'));
    expect(clusterCall).toBeUndefined();
  });

  it('ensureTable() adds columns for schema evolution', async () => {
    const table = createMockTable({
      exists: true,
      metadata: {
        schema: {
          fields: [
            { name: 'id', type: 'INT64' },
            { name: 'title', type: 'STRING' },
            { name: '_time_extracted', type: 'TIMESTAMP' },
            { name: '_dogsled_loaded_at', type: 'TIMESTAMP' },
          ],
        },
      },
    });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();

    const extendedColumns: SchemaColumn[] = [...issueColumns, { name: 'status', type: 'string' }];
    await dest.ensureTable('test_ds', 'issues', extendedColumns);

    // Should have called createQueryJob with ALTER TABLE for new column
    expect(client.createQueryJob).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining('ALTER TABLE'),
      })
    );
    const alterCall = vi
      .mocked(client.createQueryJob)
      .mock.calls.find((c) => c[0].query.includes('ALTER TABLE'));
    expect(alterCall).toBeDefined();
    expect(alterCall![0].query).toContain('status');
    expect(alterCall![0].query).toContain('STRING');
  });

  it('ensureTable() re-fetches metadata before setMetadata when schema evolves', async () => {
    // Reproduces the bug where ALTER TABLE invalidates the etag in the
    // previously-fetched metadata, causing setMetadata to fail with 412
    const staleMetadata = {
      schema: {
        fields: [
          { name: 'id', type: 'INT64' },
          { name: 'title', type: 'STRING' },
          { name: '_time_extracted', type: 'TIMESTAMP' },
          { name: '_dogsled_loaded_at', type: 'TIMESTAMP' },
        ],
      },
      clustering: { fields: ['id'] },
      etag: 'stale-etag',
    };
    const freshMetadata = {
      ...staleMetadata,
      schema: {
        fields: [...staleMetadata.schema.fields, { name: 'workspace_token', type: 'STRING' }],
      },
      etag: 'fresh-etag',
    };
    const table: BigQueryTableLike = {
      exists: vi.fn().mockResolvedValue([true]),
      load: vi.fn().mockResolvedValue([{ status: {} }]),
      getMetadata: vi
        .fn()
        .mockResolvedValueOnce([staleMetadata])
        .mockResolvedValueOnce([freshMetadata]),
      setMetadata: vi.fn().mockResolvedValue(undefined),
    };
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['accounts', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();
    await dest.ensureTable(
      'test_ds',
      'accounts',
      [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'title', type: 'string' },
        { name: 'workspace_token', type: 'string', primary_key: true },
      ],
      {
        keyProperties: ['id', 'workspace_token'],
      }
    );

    // getMetadata called twice: initial fetch + re-fetch after ALTER TABLE
    expect(table.getMetadata).toHaveBeenCalledTimes(2);
    // setMetadata receives the fresh metadata (with fresh etag), not the stale one
    expect(table.setMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        etag: 'fresh-etag',
        clustering: { fields: ['id', 'workspace_token'] },
      })
    );
  });

  it('ensureTable() throws on type change', async () => {
    const table = createMockTable({
      exists: true,
      metadata: {
        schema: {
          fields: [
            { name: 'id', type: 'INT64' },
            { name: 'title', type: 'STRING' },
            { name: '_time_extracted', type: 'TIMESTAMP' },
            { name: '_dogsled_loaded_at', type: 'TIMESTAMP' },
          ],
        },
      },
    });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();

    const changedColumns: SchemaColumn[] = [
      { name: 'title', type: 'integer' },
      { name: 'id', type: 'integer', primary_key: true },
    ];

    await expect(dest.ensureTable('test_ds', 'issues', changedColumns)).rejects.toThrow(
      /Schema change conflict.*title.*STRING.*INT64/
    );
  });

  it('loadAndFinalize("append") calls table.load with WRITE_APPEND and returns row count', async () => {
    const table = createMockTable({ exists: true, loadOutputRows: '5' });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();

    const result = await dest.loadAndFinalize(
      'test_ds',
      'issues',
      '/tmp/data.jsonl',
      issueColumns,
      'append',
      []
    );

    expect(table.load).toHaveBeenCalledWith(
      '/tmp/data.jsonl',
      expect.objectContaining({
        writeDisposition: 'WRITE_APPEND',
        schemaUpdateOptions: ['ALLOW_FIELD_ADDITION'],
      })
    );
    expect(result).toEqual({ rowsAffected: 5 });
  });

  it('cancel() invokes the active BigQuery load job cancellation hook', async () => {
    let resolveJob: ((value: unknown) => void) | undefined;
    const terminalJob = new Promise((resolve) => {
      resolveJob = resolve;
    });
    const loadJob: BigQueryJobLike = {
      cancel: vi.fn().mockResolvedValue(undefined),
      promise: vi.fn(() => terminalJob),
      getQueryResults: vi.fn(),
      getMetadata: vi.fn().mockResolvedValue([
        {
          status: {},
          statistics: { load: { outputRows: '1' } },
        },
      ]),
    };
    const table = createMockTable({ exists: true });
    table.createLoadJob = vi.fn().mockResolvedValue([loadJob]);
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });
    await dest.initialize();

    const operation = dest.loadAndFinalize(
      'test_ds',
      'issues',
      '/tmp/data.jsonl',
      issueColumns,
      'append',
      []
    );
    const operationAssertion = expect(operation).rejects.toThrow(
      'BigQuery destination operation cancelled'
    );
    await vi.waitFor(() => expect(loadJob.promise).toHaveBeenCalled());
    const cancellation = dest.cancel();

    await vi.waitFor(() => expect(loadJob.cancel).toHaveBeenCalledOnce());
    expect(loadJob.getQueryResults).not.toHaveBeenCalled();
    resolveJob!([{}]);
    await cancellation;
    await operationAssertion;
    expect(dataset.createQueryJob).not.toHaveBeenCalled();
  });

  it('cancels every capable active job even when another job has no cancel hook', async () => {
    const capableJob: BigQueryJobLike = {
      cancel: vi.fn().mockResolvedValue(undefined),
      promise: vi.fn().mockResolvedValue([{}]),
      getQueryResults: vi.fn(),
    };
    const incapableJob: BigQueryJobLike = {
      promise: vi.fn().mockResolvedValue([{}]),
      getQueryResults: vi.fn(),
    };
    const activeJobs = (dest: BigQueryDestination): Set<BigQueryJobLike> =>
      (dest as unknown as { activeJobs: Set<BigQueryJobLike> }).activeJobs;
    const dest = new BigQueryDestination({
      datasetId: 'test_ds',
      client: createMockClient(),
      stagingFormat: 'jsonl',
    });
    activeJobs(dest).add(incapableJob);
    activeJobs(dest).add(capableJob);

    await expect(dest.cancel()).rejects.toThrow('does not expose cancel');
    expect(capableJob.cancel).toHaveBeenCalledOnce();
    expect(capableJob.promise).toHaveBeenCalledOnce();
    expect(incapableJob.promise).toHaveBeenCalledOnce();
  });

  it('cancels a malformed submitted load job instead of dispatching a duplicate fallback', async () => {
    const malformedJob: BigQueryJobLike = {
      cancel: vi.fn().mockResolvedValue(undefined),
      getQueryResults: vi.fn(),
    };
    const table = createMockTable({ exists: true });
    table.createLoadJob = vi.fn().mockResolvedValue([malformedJob]);
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const dest = new BigQueryDestination({
      datasetId: 'test_ds',
      client: createMockClient(dataset),
      stagingFormat: 'jsonl',
    });
    await dest.initialize();

    await expect(
      dest.loadAndFinalize('test_ds', 'issues', '/tmp/data.jsonl', issueColumns, 'append', [])
    ).rejects.toThrow('does not expose promise');
    expect(malformedJob.cancel).toHaveBeenCalledOnce();
    expect(table.load).not.toHaveBeenCalled();
  });

  it('waits for a late-created load job to settle when cancellation is rejected', async () => {
    let resolveCreate: ((value: [BigQueryJobLike]) => void) | undefined;
    let resolveJob: ((value: unknown) => void) | undefined;
    const loadJob: BigQueryJobLike = {
      cancel: vi.fn().mockRejectedValue(new Error('cancel rejected')),
      promise: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveJob = resolve;
          })
      ),
      getQueryResults: vi.fn(),
    };
    const table = createMockTable({ exists: true });
    table.createLoadJob = vi.fn(
      () =>
        new Promise<[BigQueryJobLike]>((resolve) => {
          resolveCreate = resolve;
        })
    );
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const dest = new BigQueryDestination({
      datasetId: 'test_ds',
      client: createMockClient(dataset),
      stagingFormat: 'jsonl',
    });
    await dest.initialize();

    const operation = dest.loadAndFinalize(
      'test_ds',
      'issues',
      '/tmp/data.jsonl',
      issueColumns,
      'append',
      []
    );
    const operationAssertion = expect(operation).rejects.toThrow('cancel rejected');
    await vi.waitFor(() => expect(resolveCreate).toBeDefined());
    // No job handle exists yet, so the public cancel call returns immediately.
    await dest.cancel();
    resolveCreate!([loadJob]);
    await vi.waitFor(() => expect(loadJob.cancel).toHaveBeenCalledOnce());

    // Rejected cancellation is not acknowledged: the destination keeps waiting
    // for the remote job's terminal operation promise.
    expect(resolveJob).toBeDefined();
    resolveJob!([{}]);
    await operationAssertion;
    await expect(dest.cancel()).resolves.toBeUndefined();
  });

  it('loadAndFinalize("append") runs UPDATE to backfill _dogsled_loaded_at', async () => {
    const table = createMockTable({ exists: true, loadOutputRows: '5' });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();

    await dest.loadAndFinalize('test_ds', 'issues', '/tmp/data.jsonl', issueColumns, 'append', []);

    // Should have called dataset.createQueryJob with UPDATE to backfill _dogsled_loaded_at
    const queryJobCalls = vi.mocked(dataset.createQueryJob).mock.calls;
    const updateCall = queryJobCalls.find((c) => c[0].query.includes('UPDATE'));
    expect(updateCall).toBeDefined();
    expect(updateCall![0].query).toContain('_dogsled_loaded_at');
    expect(updateCall![0].query).toContain('IS NULL');
  });

  it('loadAndFinalize("append") returns zero when statistics are absent', async () => {
    const table = createMockTable({ exists: true });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();

    const result = await dest.loadAndFinalize(
      'test_ds',
      'issues',
      '/tmp/data.jsonl',
      issueColumns,
      'append',
      []
    );

    expect(result).toEqual({ rowsAffected: 0 });
  });

  it('loadAndFinalize("append") throws on load job errors', async () => {
    const table = createMockTable({
      exists: true,
      loadErrors: [{ message: 'Invalid JSON' }],
    });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();

    await expect(
      dest.loadAndFinalize('test_ds', 'issues', '/tmp/data.jsonl', issueColumns, 'append', [])
    ).rejects.toThrow(/Invalid JSON/);
  });

  it('loadAndFinalize("full_refresh") uses WRITE_TRUNCATE on first call', async () => {
    const table = createMockTable({ exists: true, loadOutputRows: '10' });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();

    const result = await dest.loadAndFinalize(
      'test_ds',
      'issues',
      '/tmp/data.jsonl',
      issueColumns,
      'full_refresh',
      []
    );

    expect(table.load).toHaveBeenCalledWith(
      '/tmp/data.jsonl',
      expect.objectContaining({
        writeDisposition: 'WRITE_TRUNCATE',
      })
    );
    // WRITE_TRUNCATE should NOT include schemaUpdateOptions
    const loadCall = vi.mocked(table.load).mock.calls[0]![1] as Record<string, unknown>;
    expect(loadCall).not.toHaveProperty('schemaUpdateOptions');
    expect(result).toEqual({ rowsAffected: 10 });
  });

  it('loadAndFinalize("full_refresh") uses WRITE_APPEND on second call', async () => {
    const table = createMockTable({ exists: true });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();

    // First call — WRITE_TRUNCATE
    await dest.loadAndFinalize(
      'test_ds',
      'issues',
      '/tmp/data1.jsonl',
      issueColumns,
      'full_refresh',
      []
    );

    // Second call — WRITE_APPEND
    await dest.loadAndFinalize(
      'test_ds',
      'issues',
      '/tmp/data2.jsonl',
      issueColumns,
      'full_refresh',
      []
    );

    const loadCalls = vi.mocked(table.load).mock.calls;
    expect(loadCalls).toHaveLength(2);
    expect(loadCalls[0]![1]).toEqual(
      expect.objectContaining({
        writeDisposition: 'WRITE_TRUNCATE',
      })
    );
    expect(loadCalls[1]![1]).toEqual(
      expect.objectContaining({
        writeDisposition: 'WRITE_APPEND',
      })
    );
  });

  it('loadAndFinalize("merge") loads staging, runs MERGE, drops staging, returns row count', async () => {
    const targetTable = createMockTable({ exists: true });
    const tables = new Map<string, BigQueryTableLike>([['issues', targetTable]]);

    // The staging table will be created dynamically — we use a default mock for unknown tables
    const dataset = createMockDataset({ exists: true, tables });
    const client = createMockClient(dataset);

    // Return a merge job with metadata containing numDmlAffectedRows
    const mergeJobMock = createMockJob([], {
      statistics: { query: { numDmlAffectedRows: '3' } },
    });
    const dropJobMock = createMockJob();
    vi.mocked(client.createQueryJob).mockImplementation(async (options) => {
      if (options.query.includes('MERGE')) {
        return [mergeJobMock];
      }
      return [dropJobMock];
    });

    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();

    const result = await dest.loadAndFinalize(
      'test_ds',
      'issues',
      '/tmp/data.jsonl',
      issueColumns,
      'merge',
      ['id']
    );

    // Should have called dataset.table for staging table (uses UUID suffix)
    const tableCalls = vi.mocked(dataset.table).mock.calls;
    const stagingCall = tableCalls.find((c) => /^_dogsled_stg_issues_[a-f0-9]{32}$/.test(c[0]));
    expect(stagingCall).toBeDefined();

    // Should have run MERGE query
    const queryJobCalls = vi.mocked(client.createQueryJob).mock.calls;
    const mergeCall = queryJobCalls.find((c) => c[0].query.includes('MERGE'));
    expect(mergeCall).toBeDefined();
    expect(mergeCall![0].query).toContain('QUALIFY ROW_NUMBER()');
    expect(mergeCall![0].query).toContain('CURRENT_TIMESTAMP()');
    expect(mergeCall![0].query).toContain('_dogsled_loaded_at');

    // Should have run DROP TABLE for staging
    const dropCall = queryJobCalls.find((c) => c[0].query.includes('DROP TABLE'));
    expect(dropCall).toBeDefined();

    // Should return the affected row count from the MERGE job
    expect(result).toEqual({ rowsAffected: 3 });
  });

  it('loadAndFinalize("merge") reads numDmlAffectedRows from refreshed job metadata when the creation snapshot lacks it', async () => {
    // Regression: the real SDK's getQueryResults() never refreshes
    // job.metadata, so the creation-time snapshot carries no
    // numDmlAffectedRows and every merge logged "loaded 0 rows" even though
    // the MERGE wrote rows. The destination must re-fetch metadata after the
    // job completes.
    const targetTable = createMockTable({ exists: true });
    const tables = new Map<string, BigQueryTableLike>([['issues', targetTable]]);
    const dataset = createMockDataset({ exists: true, tables });
    const client = createMockClient(dataset);

    const mergeJobMock: BigQueryJobLike = {
      getQueryResults: vi.fn().mockResolvedValue([[]]),
      // Creation snapshot: statistics exist but completion-only fields don't.
      metadata: { statistics: { query: {} } },
      getMetadata: vi
        .fn()
        .mockResolvedValue([{ statistics: { query: { numDmlAffectedRows: '5' } } }]),
    };
    vi.mocked(client.createQueryJob).mockImplementation(async (options) => {
      if (options.query.includes('MERGE')) return [mergeJobMock];
      return [createMockJob()];
    });

    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });
    await dest.initialize();

    const result = await dest.loadAndFinalize(
      'test_ds',
      'issues',
      '/tmp/data.jsonl',
      issueColumns,
      'merge',
      ['id']
    );

    expect(mergeJobMock.getMetadata).toHaveBeenCalled();
    expect(result).toEqual({ rowsAffected: 5 });
  });

  it('loadAndFinalize("merge") sets parquetOptions.enableListInference on staging load for PARQUET', async () => {
    // Regression: the merge path goes through stagingTable.load — same Parquet
    // LIST-vs-STRUCT trap as the append path.
    const targetTable = createMockTable({ exists: true });
    const stagingTable = createMockTable({ exists: true });
    const tables = new Map<string, BigQueryTableLike>([['issues', targetTable]]);
    const dataset = createMockDataset({ exists: true, tables });
    // Route any non-target table lookup (the UUID-suffixed staging name) to our spy
    vi.mocked(dataset.table).mockImplementation((name: string) =>
      name === 'issues' ? targetTable : stagingTable
    );
    const client = createMockClient(dataset);

    const mergeJobMock = createMockJob([], {
      statistics: { query: { numDmlAffectedRows: '3' } },
    });
    vi.mocked(client.createQueryJob).mockImplementation(async (options) => {
      if (options.query.includes('MERGE')) return [mergeJobMock];
      return [createMockJob()];
    });

    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });
    await dest.initialize();
    await dest.loadAndFinalize(
      'test_ds',
      'issues',
      '/tmp/data.parquet',
      issueColumns,
      'merge',
      ['id'],
      { format: 'parquet' }
    );

    const stagingLoadOptions = vi.mocked(stagingTable.load).mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(stagingLoadOptions['sourceFormat']).toBe('PARQUET');
    expect(stagingLoadOptions['parquetOptions']).toEqual({ enableListInference: true });
    // Parquet branch must NOT also send the explicit schema (Parquet self-describes,
    // and the explicit schema is what triggered the LIST→STRUCT trap in the first place).
    expect(stagingLoadOptions).not.toHaveProperty('schema');
  });

  it('staging table is dropped even on MERGE error', async () => {
    const dataset = createMockDataset({ exists: true });
    const client = createMockClient(dataset);

    // Make the MERGE query fail
    vi.mocked(client.createQueryJob).mockImplementation(async (options) => {
      if (options.query.includes('MERGE')) {
        throw new Error('MERGE failed');
      }
      return [createMockJob()];
    });

    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });
    await dest.initialize();

    await expect(
      dest.loadAndFinalize('test_ds', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', ['id'])
    ).rejects.toThrow('MERGE failed');

    // DROP TABLE should still have been called
    const queryJobCalls = vi.mocked(client.createQueryJob).mock.calls;
    const dropCall = queryJobCalls.find((c) => c[0].query.includes('DROP TABLE'));
    expect(dropCall).toBeDefined();
  });

  it('close() succeeds when no DuckDbWriter or GcsStagingManager are configured', async () => {
    const client = createMockClient();
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();
    await dest.close();
    // Should not throw — no resources to clean up
  });

  it('type mapping is correct', async () => {
    const columns: SchemaColumn[] = [
      { name: 'a', type: 'integer' },
      { name: 'b', type: 'number' },
      { name: 'c', type: 'boolean' },
      { name: 'd', type: 'timestamp' },
      { name: 'e', type: 'string' },
      { name: 'f', type: 'array' },
      { name: 'g', type: 'object' },
    ];

    const table = createMockTable({ exists: false });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['typed', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();
    await dest.ensureTable('test_ds', 'typed', columns);

    const query = vi.mocked(client.createQueryJob).mock.calls[0]![0].query;
    expect(query).toContain('INT64');
    expect(query).toContain('FLOAT64');
    expect(query).toContain('BOOL');
    expect(query).toContain('TIMESTAMP');
    expect(query).toContain('STRING');
  });

  // WI-1: Cross-flush merge timestamp guard
  it('merge SQL includes timestamp guard in WHEN MATCHED clause', async () => {
    const dataset = createMockDataset({ exists: true });
    const client = createMockClient(dataset);

    const mergeJobMock = createMockJob([], {
      statistics: { query: { numDmlAffectedRows: '1' } },
    });
    vi.mocked(client.createQueryJob).mockImplementation(async (options) => {
      if (options.query.includes('MERGE')) return [mergeJobMock];
      return [createMockJob()];
    });

    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });
    await dest.initialize();
    await dest.loadAndFinalize('test_ds', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
      'id',
    ]);

    const mergeCalls = vi
      .mocked(client.createQueryJob)
      .mock.calls.filter((c) => c[0].query.includes('MERGE'));
    expect(mergeCalls.length).toBe(1);
    const sql = mergeCalls[0]![0].query;
    expect(sql).toContain(
      'WHEN MATCHED AND (S.`_time_extracted` >= T.`_time_extracted` OR T.`_time_extracted` IS NULL)'
    );
  });

  // WI-3: NULL key behavior (documented via test)
  it('merge: ON clause uses direct key comparison (NULL behavior is standard SQL)', async () => {
    const dataset = createMockDataset({ exists: true });
    const client = createMockClient(dataset);

    const mergeJobMock = createMockJob([], { statistics: { query: { numDmlAffectedRows: '0' } } });
    vi.mocked(client.createQueryJob).mockImplementation(async (options) => {
      if (options.query.includes('MERGE')) return [mergeJobMock];
      return [createMockJob()];
    });

    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });
    await dest.initialize();
    await dest.loadAndFinalize('test_ds', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
      'id',
    ]);

    const sql = vi
      .mocked(client.createQueryJob)
      .mock.calls.find((c) => c[0].query.includes('MERGE'))![0].query;
    expect(sql).toContain('T.`id` = S.`id`');
  });

  // WI-6: Improved merge SQL test coverage
  it('merge: composite key ON clause has all keys joined by AND', async () => {
    const columns: SchemaColumn[] = [
      { name: 'id', type: 'integer', primary_key: true },
      { name: 'region', type: 'string', primary_key: true },
      { name: 'value', type: 'integer' },
    ];
    const dataset = createMockDataset({ exists: true });
    const client = createMockClient(dataset);

    const mergeJobMock = createMockJob([], { statistics: { query: { numDmlAffectedRows: '0' } } });
    vi.mocked(client.createQueryJob).mockImplementation(async (options) => {
      if (options.query.includes('MERGE')) return [mergeJobMock];
      return [createMockJob()];
    });

    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });
    await dest.initialize();
    await dest.loadAndFinalize('test_ds', 'items', '/tmp/data.jsonl', columns, 'merge', [
      'id',
      'region',
    ]);

    const sql = vi
      .mocked(client.createQueryJob)
      .mock.calls.find((c) => c[0].query.includes('MERGE'))![0].query;
    expect(sql).toContain('T.`id` = S.`id` AND T.`region` = S.`region`');
  });

  it('merge: staging partition dates never bound the target rows in the ON clause', async () => {
    const dataset = createMockDataset({ exists: true });
    vi.mocked(dataset.createQueryJob).mockResolvedValue([
      createMockJob([{ min_date: '2026-03-26', max_date: '2026-03-29' }]),
    ]);

    const client = createMockClient(dataset);
    const mergeJobMock = createMockJob([], { statistics: { query: { numDmlAffectedRows: '0' } } });
    vi.mocked(client.createQueryJob).mockImplementation(async (options) => {
      if (options.query.includes('MERGE')) return [mergeJobMock];
      return [createMockJob()];
    });

    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });
    await dest.initialize();
    await dest.loadAndFinalize('test_ds', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
      'id',
    ]);

    const sql = vi
      .mocked(client.createQueryJob)
      .mock.calls.find((c) => c[0].query.includes('MERGE'))![0].query;
    expect(sql).toContain(' ON T.`id` = S.`id` WHEN MATCHED ');
    expect(sql).not.toContain('DATE(T.');
  });

  it('merge: warns when the staging batch spans more than 4,000 partition days', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), metric: vi.fn() };
    const dataset = createMockDataset({ exists: true });
    vi.mocked(dataset.createQueryJob).mockResolvedValue([
      createMockJob([{ min_date: '2010-01-01', max_date: '2021-01-01' }]),
    ]);

    const client = createMockClient(dataset);
    const mergeJobMock = createMockJob([], { statistics: { query: { numDmlAffectedRows: '0' } } });
    vi.mocked(client.createQueryJob).mockImplementation(async (options) => {
      if (options.query.includes('MERGE')) return [mergeJobMock];
      return [createMockJob()];
    });

    const dest = new BigQueryDestination({
      datasetId: 'test_ds',
      client,
      stagingFormat: 'jsonl',
      logger,
    });
    await dest.initialize();
    await dest.loadAndFinalize('test_ds', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
      'id',
    ]);

    expect(logger.warn).toHaveBeenCalledWith(
      'partition_limit_risk',
      expect.objectContaining({
        stream: 'issues',
        partitionColumn: '_time_extracted',
        minDate: '2010-01-01',
        maxDate: '2021-01-01',
      })
    );
  });

  it('merge: UPDATE SET includes all non-key columns', async () => {
    const dataset = createMockDataset({ exists: true });
    const client = createMockClient(dataset);

    const mergeJobMock = createMockJob([], { statistics: { query: { numDmlAffectedRows: '0' } } });
    vi.mocked(client.createQueryJob).mockImplementation(async (options) => {
      if (options.query.includes('MERGE')) return [mergeJobMock];
      return [createMockJob()];
    });

    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });
    await dest.initialize();
    await dest.loadAndFinalize('test_ds', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
      'id',
    ]);

    const sql = vi
      .mocked(client.createQueryJob)
      .mock.calls.find((c) => c[0].query.includes('MERGE'))![0].query;
    expect(sql).toContain('`title` = S.`title`');
    expect(sql).toContain('`_time_extracted` = S.`_time_extracted`');
    expect(sql).toContain('`_dogsled_loaded_at` = S.`_dogsled_loaded_at`');
  });

  it('merge: INSERT VALUES includes all columns', async () => {
    const dataset = createMockDataset({ exists: true });
    const client = createMockClient(dataset);

    const mergeJobMock = createMockJob([], { statistics: { query: { numDmlAffectedRows: '0' } } });
    vi.mocked(client.createQueryJob).mockImplementation(async (options) => {
      if (options.query.includes('MERGE')) return [mergeJobMock];
      return [createMockJob()];
    });

    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });
    await dest.initialize();
    await dest.loadAndFinalize('test_ds', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
      'id',
    ]);

    const sql = vi
      .mocked(client.createQueryJob)
      .mock.calls.find((c) => c[0].query.includes('MERGE'))![0].query;
    expect(sql).toContain('INSERT (`id`, `title`, `_time_extracted`, `_dogsled_loaded_at`)');
    expect(sql).toContain(
      'VALUES (S.`id`, S.`title`, S.`_time_extracted`, S.`_dogsled_loaded_at`)'
    );
  });

  it('merge: QUALIFY dedup is present', async () => {
    const dataset = createMockDataset({ exists: true });
    const client = createMockClient(dataset);

    const mergeJobMock = createMockJob([], { statistics: { query: { numDmlAffectedRows: '0' } } });
    vi.mocked(client.createQueryJob).mockImplementation(async (options) => {
      if (options.query.includes('MERGE')) return [mergeJobMock];
      return [createMockJob()];
    });

    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });
    await dest.initialize();
    await dest.loadAndFinalize('test_ds', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
      'id',
    ]);

    const sql = vi
      .mocked(client.createQueryJob)
      .mock.calls.find((c) => c[0].query.includes('MERGE'))![0].query;
    expect(sql).toContain(
      'QUALIFY ROW_NUMBER() OVER (PARTITION BY `id` ORDER BY `_time_extracted` DESC'
    );
  });

  // WI-8: Full staging UUID + job labels
  it('staging table uses full UUID (32 hex chars)', async () => {
    const dataset = createMockDataset({ exists: true });
    const client = createMockClient(dataset);

    const mergeJobMock = createMockJob([], { statistics: { query: { numDmlAffectedRows: '0' } } });
    vi.mocked(client.createQueryJob).mockImplementation(async (options) => {
      if (options.query.includes('MERGE')) return [mergeJobMock];
      return [createMockJob()];
    });

    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });
    await dest.initialize();
    await dest.loadAndFinalize('test_ds', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
      'id',
    ]);

    const tableCalls = vi.mocked(dataset.table).mock.calls;
    const stagingCall = tableCalls.find((c) => /^_dogsled_stg_issues_[a-f0-9]{32}$/.test(c[0]));
    expect(stagingCall).toBeDefined();
  });

  it('loadAndFinalize("full_refresh") runs UPDATE to backfill _dogsled_loaded_at', async () => {
    const table = createMockTable({ exists: true, loadOutputRows: '10' });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();

    await dest.loadAndFinalize(
      'test_ds',
      'issues',
      '/tmp/data.jsonl',
      issueColumns,
      'full_refresh',
      []
    );

    const queryJobCalls = vi.mocked(dataset.createQueryJob).mock.calls;
    const updateCall = queryJobCalls.find((c) => c[0].query.includes('UPDATE'));
    expect(updateCall).toBeDefined();
    expect(updateCall![0].query).toContain('_dogsled_loaded_at');
    expect(updateCall![0].query).toContain('IS NULL');
  });

  it('ensureTable() rejects invalid schema names (defense-in-depth)', async () => {
    const client = createMockClient();
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();
    await expect(dest.ensureTable('invalid-schema!', 'issues', issueColumns)).rejects.toThrow(
      /Invalid schema name/
    );
  });

  it('ensureTable() skips API calls on second call with same columns (column cache)', async () => {
    const table = createMockTable({
      exists: true,
      metadata: {
        schema: {
          fields: [
            { name: 'id', type: 'INT64' },
            { name: 'title', type: 'STRING' },
            { name: '_time_extracted', type: 'TIMESTAMP' },
            { name: '_dogsled_loaded_at', type: 'TIMESTAMP' },
          ],
        },
      },
    });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();

    // First call — hits API
    await dest.ensureTable('test_ds', 'issues', issueColumns);
    expect(table.exists).toHaveBeenCalledTimes(1);

    // Second call — should skip API calls (cache hit)
    await dest.ensureTable('test_ds', 'issues', issueColumns);
    expect(table.exists).toHaveBeenCalledTimes(1); // NOT called again
  });

  it('ensureTable() adds new columns from cache without re-querying API', async () => {
    const table = createMockTable({
      exists: true,
      metadata: {
        schema: {
          fields: [
            { name: 'id', type: 'INT64' },
            { name: 'title', type: 'STRING' },
            { name: '_time_extracted', type: 'TIMESTAMP' },
            { name: '_dogsled_loaded_at', type: 'TIMESTAMP' },
          ],
        },
      },
    });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();

    // First call populates the cache
    await dest.ensureTable('test_ds', 'issues', issueColumns);
    expect(table.exists).toHaveBeenCalledTimes(1);

    // Second call with a new column — cache handles ADD COLUMN directly, no API re-query
    const extendedColumns: SchemaColumn[] = [...issueColumns, { name: 'status', type: 'string' }];
    await dest.ensureTable('test_ds', 'issues', extendedColumns);
    expect(table.exists).toHaveBeenCalledTimes(1);
  });

  // ── PR 2: Parquet staging ──

  it('loadAndFinalize("append") uses PARQUET sourceFormat when stagingFormat is parquet', async () => {
    const table = createMockTable({ exists: true, loadOutputRows: '5' });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);

    // Mock dynamic import of duckdb-writer
    const mockConvertFile = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../src/runtime/duckdb-writer.js', () => ({
      createDuckDbWriter: () =>
        Promise.resolve({
          convertFile: mockConvertFile,
          close: vi.fn().mockResolvedValue(undefined),
        }),
    }));

    const dest = new BigQueryDestination({
      datasetId: 'test_ds',
      client,
      stagingFormat: 'parquet',
    });

    await dest.initialize();

    await dest.loadAndFinalize('test_ds', 'issues', '/tmp/data.jsonl', issueColumns, 'append', []);

    // table.load should have been called with PARQUET sourceFormat
    // Note: the actual parquet conversion requires DuckDB, but the load call
    // will receive the .parquet path
    const loadCall = vi.mocked(table.load).mock.calls[0]!;
    const loadPath = loadCall[0] as string;
    const loadOptions = loadCall[1] as Record<string, unknown>;
    // When parquet staging is on, the source format should be PARQUET
    expect(loadOptions['sourceFormat']).toBe('PARQUET');
    expect(loadPath).toMatch(/\.parquet$/);

    await dest.close();
    vi.doUnmock('../../../src/runtime/duckdb-writer.js');
  });

  it('loadAndFinalize("append") uses JSONL when stagingFormat is jsonl', async () => {
    const table = createMockTable({ exists: true, loadOutputRows: '5' });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({
      datasetId: 'test_ds',
      client,
      stagingFormat: 'jsonl',
    });

    await dest.initialize();

    await dest.loadAndFinalize('test_ds', 'issues', '/tmp/data.jsonl', issueColumns, 'append', []);

    const loadOptions = vi.mocked(table.load).mock.calls[0]![1] as Record<string, unknown>;
    expect(loadOptions['sourceFormat']).toBe('NEWLINE_DELIMITED_JSON');
  });

  it('loadAndFinalize("append") keeps parquet inputs as PARQUET even when stagingFormat is jsonl', async () => {
    const table = createMockTable({ exists: true, loadOutputRows: '5' });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({
      datasetId: 'test_ds',
      client,
      stagingFormat: 'jsonl',
    });

    await dest.initialize();

    await dest.loadAndFinalize(
      'test_ds',
      'issues',
      '/tmp/data.parquet',
      issueColumns,
      'append',
      [],
      { format: 'parquet' }
    );

    const loadCall = vi.mocked(table.load).mock.calls[0]!;
    expect(loadCall[0]).toBe('/tmp/data.parquet');
    expect((loadCall[1] as Record<string, unknown>)['sourceFormat']).toBe('PARQUET');
  });

  it('loadAndFinalize defaults to parquet when stagingFormat not set', async () => {
    const table = createMockTable({ exists: true, loadOutputRows: '5' });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);

    // Mock dynamic import of duckdb-writer (needed for parquet conversion)
    const mockConvertFile = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../src/runtime/duckdb-writer.js', () => ({
      createDuckDbWriter: () =>
        Promise.resolve({
          convertFile: mockConvertFile,
          close: vi.fn().mockResolvedValue(undefined),
        }),
    }));

    // No stagingFormat set — should default to parquet (matching Zod schema default)
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client });

    await dest.initialize();

    await dest.loadAndFinalize('test_ds', 'issues', '/tmp/data.jsonl', issueColumns, 'append', []);

    const loadOptions = vi.mocked(table.load).mock.calls[0]![1] as Record<string, unknown>;
    expect(loadOptions['sourceFormat']).toBe('PARQUET');

    await dest.close();
    vi.doUnmock('../../../src/runtime/duckdb-writer.js');
  });

  it('loadAndFinalize sets parquetOptions.enableListInference for PARQUET source', async () => {
    // Regression: without enableListInference, BigQuery treats Parquet 3-level
    // LIST encoding (e.g. vector columns) as STRUCT<repeated element> and the
    // explicit REPEATED schema below silently lands empty arrays for every row.
    const table = createMockTable({ exists: true, loadOutputRows: '3' });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({
      datasetId: 'test_ds',
      client,
      stagingFormat: 'jsonl',
    });

    await dest.initialize();
    await dest.loadAndFinalize(
      'test_ds',
      'issues',
      '/tmp/data.parquet',
      issueColumns,
      'append',
      [],
      { format: 'parquet' }
    );

    const loadOptions = vi.mocked(table.load).mock.calls[0]![1] as Record<string, unknown>;
    expect(loadOptions['sourceFormat']).toBe('PARQUET');
    expect(loadOptions['parquetOptions']).toEqual({ enableListInference: true });
  });

  it('loadAndFinalize does NOT set parquetOptions for JSONL source', async () => {
    const table = createMockTable({ exists: true, loadOutputRows: '3' });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({
      datasetId: 'test_ds',
      client,
      stagingFormat: 'jsonl',
    });

    await dest.initialize();
    await dest.loadAndFinalize('test_ds', 'issues', '/tmp/data.jsonl', issueColumns, 'append', []);

    const loadOptions = vi.mocked(table.load).mock.calls[0]![1] as Record<string, unknown>;
    expect(loadOptions['sourceFormat']).toBe('NEWLINE_DELIMITED_JSON');
    expect(loadOptions).not.toHaveProperty('parquetOptions');
  });

  // ── PR 3: GCS staging ──

  it('loadAndFinalize uses GCS URI when gcsStagingBucket is configured', async () => {
    const table = createMockTable({ exists: true, loadOutputRows: '5' });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);

    // Mock GCS staging manager
    const mockUpload = vi.fn().mockResolvedValue('gs://my-bucket/data.jsonl');
    const mockCleanupAll = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../src/runtime/gcs-staging.js', () => ({
      GcsStagingManager: class {
        upload = mockUpload;
        cleanupAll = mockCleanupAll;
      },
    }));

    const dest = new BigQueryDestination({
      datasetId: 'test_ds',
      client,
      stagingFormat: 'jsonl',
      gcsStagingBucket: 'my-bucket',
      gcsStagingPrefix: 'staging/',
    });

    await dest.initialize();

    await dest.loadAndFinalize('test_ds', 'issues', '/tmp/data.jsonl', issueColumns, 'append', []);

    // table.load should have been called with gs:// URI
    const loadPath = vi.mocked(table.load).mock.calls[0]![0];
    expect(loadPath).toMatch(/^gs:\/\//);

    await dest.close();
    vi.doUnmock('../../../src/runtime/gcs-staging.js');
  });

  it('loadAndFinalize uses direct path when no GCS staging bucket', async () => {
    const table = createMockTable({ exists: true, loadOutputRows: '5' });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();

    await dest.loadAndFinalize('test_ds', 'issues', '/tmp/data.jsonl', issueColumns, 'append', []);

    const loadPath = vi.mocked(table.load).mock.calls[0]![0];
    expect(loadPath).toBe('/tmp/data.jsonl');
  });

  it('loadFromUri() truncates then LOAD DATA INTO with all GCS URIs in one statement', async () => {
    const table = createMockTable({ exists: true, loadOutputRows: '5' });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();
    await dest.loadFromUri(
      'test_ds',
      'issues',
      ['gs://stage/run/part-000.parquet', 'gs://stage/run/part-001.parquet'],
      issueColumns
    );

    // The local-file API (`table.load(<string>)`) must never be used for GCS.
    expect(table.load).not.toHaveBeenCalled();

    const queries = vi.mocked(client.createQueryJob).mock.calls.map((c) => c[0].query);
    expect(queries.some((q) => q.includes('TRUNCATE TABLE'))).toBe(true);
    const loadData = queries.find((q) => q.includes('LOAD DATA INTO'));
    expect(loadData).toBeDefined();
    // Both URIs land in a single `uris = [...]` list (LOAD DATA accepts wildcards).
    expect(loadData).toContain("'gs://stage/run/part-000.parquet'");
    expect(loadData).toContain("'gs://stage/run/part-001.parquet'");
  });

  // ── PR 5: Observability ──

  it('logs metrics when logger is provided', async () => {
    const table = createMockTable({ exists: true, loadOutputRows: '5' });
    const dataset = createMockDataset({
      exists: true,
      tables: new Map([['issues', table]]),
    });
    const client = createMockClient(dataset);

    const metricCalls: Array<{ name: string; value: number }> = [];
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      metric: vi.fn((name: string, value: number) => metricCalls.push({ name, value })),
    };

    const dest = new BigQueryDestination({
      datasetId: 'test_ds',
      client,
      stagingFormat: 'jsonl',
      logger: mockLogger,
    });

    await dest.initialize();

    await dest.loadAndFinalize('test_ds', 'issues', '/tmp/data.jsonl', issueColumns, 'append', []);

    // Should have logged load_job_ms metric
    expect(metricCalls.some((c) => c.name === 'load_job_ms')).toBe(true);
  });

  it('close() is idempotent when called without active resources', async () => {
    const client = createMockClient();
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });

    await dest.initialize();
    // close should not throw even when no DuckDbWriter or GcsStagingManager are initialized
    await dest.close();
    // calling close again should also be safe
    await dest.close();
  });

  it('merge query job includes labels for cost attribution', async () => {
    const dataset = createMockDataset({ exists: true });
    const client = createMockClient(dataset);

    const mergeJobMock = createMockJob([], { statistics: { query: { numDmlAffectedRows: '0' } } });
    vi.mocked(client.createQueryJob).mockImplementation(async (options) => {
      if (options.query.includes('MERGE')) return [mergeJobMock];
      return [createMockJob()];
    });

    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });
    await dest.initialize();
    await dest.loadAndFinalize('test_ds', 'issues', '/tmp/data.jsonl', issueColumns, 'merge', [
      'id',
    ]);

    const mergeCall = vi
      .mocked(client.createQueryJob)
      .mock.calls.find((c) => c[0].query.includes('MERGE'));
    expect(mergeCall).toBeDefined();
    expect(mergeCall![0].labels).toEqual({
      dogsled_stream: 'issues',
      dogsled_strategy: 'merge',
    });
  });
});

describe('BigQueryDestination — system column DDL', () => {
  // BigQuery rejects `ALTER TABLE ... ADD COLUMN ... DEFAULT ...` on an existing
  // table ("Add field with default value to an existing table schema is not supported").
  const ADD_COLUMN_WITH_DEFAULT = /ADD COLUMN[^,]*\bDEFAULT\b/i;

  async function runEnsureTable(
    fields: Array<{ name: string; type: string }> | undefined,
    options?: { keyProperties: string[] }
  ): Promise<{ queries: string[]; table: BigQueryTableLike }> {
    const table = createMockTable({
      exists: fields !== undefined,
      metadata: { schema: { fields: fields ?? [] } },
    });
    const client = createMockClient(
      createMockDataset({ exists: true, tables: new Map([['issues', table]]) })
    );
    const dest = new BigQueryDestination({ datasetId: 'test_ds', client, stagingFormat: 'jsonl' });
    await dest.ensureTable('test_ds', 'issues', issueColumns, options);
    const queries = vi.mocked(client.createQueryJob).mock.calls.map((c) => c[0].query);
    for (const query of queries) expect(query).not.toMatch(ADD_COLUMN_WITH_DEFAULT);
    return { queries, table };
  }

  it('creates a new table with the loaded-at default inline in CREATE TABLE', async () => {
    const { queries } = await runEnsureTable(undefined);

    expect(queries).toEqual([
      'CREATE TABLE IF NOT EXISTS `test_ds`.`issues` (`id` INT64, `title` STRING, ' +
        '`_time_extracted` TIMESTAMP, `_dogsled_loaded_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP()) ' +
        'PARTITION BY DATE(`_time_extracted`)',
    ]);
  });

  it('adds a missing loaded-at column to an existing table without a DEFAULT', async () => {
    const { queries } = await runEnsureTable([
      { name: 'id', type: 'INT64' },
      { name: 'title', type: 'STRING' },
      { name: '_time_extracted', type: 'TIMESTAMP' },
    ]);

    expect(queries).toEqual([
      'ALTER TABLE `test_ds`.`issues` ADD COLUMN `_dogsled_loaded_at` TIMESTAMP',
    ]);
  });

  it('adds both missing system columns to an existing table without a DEFAULT', async () => {
    const { queries, table } = await runEnsureTable(
      [
        { name: 'id', type: 'INT64' },
        { name: 'title', type: 'STRING' },
      ],
      { keyProperties: ['id'] }
    );

    expect(queries).toEqual([
      'ALTER TABLE `test_ds`.`issues` ADD COLUMN `_time_extracted` TIMESTAMP, ' +
        'ADD COLUMN `_dogsled_loaded_at` TIMESTAMP',
    ]);
    // The ALTER invalidates the table etag, so clustering must use fresh metadata.
    expect(table.getMetadata).toHaveBeenCalledTimes(2);
    expect(table.setMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ clustering: { fields: ['id'] } })
    );
  });
});

describe('BigQueryDestination — refreshable token provider', () => {
  const nowSec = Math.floor(Date.now() / 1000);

  function invalidCreds(): Error {
    return Object.assign(
      new Error('Request had invalid authentication credentials ... Invalid Credentials'),
      { code: 401 }
    );
  }

  it('force-refreshes the token once and retries on a 401 from BigQuery', async () => {
    const provider = vi.fn().mockResolvedValue({ accessToken: 'fresh', expiresAt: nowSec + 3_600 });

    let loadCalls = 0;
    const table = createMockTable({ exists: true, loadOutputRows: '7' });
    const loadResponse: BigQueryLoadJobResponse = {
      status: {},
      statistics: { load: { outputRows: '7' } },
    };
    table.load = vi.fn().mockImplementation(() => {
      loadCalls += 1;
      if (loadCalls === 1) return Promise.reject(invalidCreds());
      return Promise.resolve([loadResponse]);
    });
    const dataset = createMockDataset({ exists: true, tables: new Map([['issues', table]]) });
    const client = createMockClient(dataset);

    const dest = new BigQueryDestination({
      datasetId: 'test_ds',
      client,
      stagingFormat: 'jsonl',
      tokenProvider: provider,
    });
    await dest.initialize();
    const result = await dest.loadAndFinalize(
      'test_ds',
      'issues',
      '/tmp/data.jsonl',
      issueColumns,
      'append',
      []
    );

    expect(loadCalls).toBe(2); // failed once, retried once
    expect(provider).toHaveBeenCalledTimes(1); // exactly one force-refresh
    expect(result.rowsAffected).toBe(7);
  });

  it('backward compat: a static access token does NOT refresh and propagates a 401', async () => {
    const table = createMockTable({ exists: true });
    table.load = vi.fn().mockRejectedValue(invalidCreds());
    const dataset = createMockDataset({ exists: true, tables: new Map([['issues', table]]) });
    const client = createMockClient(dataset);

    const dest = new BigQueryDestination({
      datasetId: 'test_ds',
      client,
      stagingFormat: 'jsonl',
      accessToken: 'static-token', // no tokenProvider
    });
    await dest.initialize();

    await expect(
      dest.loadAndFinalize('test_ds', 'issues', '/tmp/data.jsonl', issueColumns, 'append', [])
    ).rejects.toThrow(/Invalid Credentials/);
    // No refresh seam → a single attempt, error surfaces unchanged (today's behavior).
    expect(table.load).toHaveBeenCalledTimes(1);
  });

  it('multi-batch load crossing a short token TTL succeeds via mid-run refresh', async () => {
    // RED on current code (static token never refreshes → 401 mid-run). GREEN with
    // the refreshable provider: each expired-token 401 triggers a force-refresh.
    const TTL = 3_600;
    let clock = nowSec;
    let active = { accessToken: '', expiresAt: 0 };
    const provider = vi.fn().mockImplementation(async () => {
      active = { accessToken: `tok-${provider.mock.calls.length}`, expiresAt: clock + TTL };
      return active;
    });

    const loadResponse: BigQueryLoadJobResponse = {
      status: {},
      statistics: { load: { outputRows: '1' } },
    };
    const table = createMockTable({ exists: true });
    table.load = vi.fn().mockImplementation(() => {
      clock += 3_000; // ~50 min of wall-clock per batch
      if (active.expiresAt === 0 || clock >= active.expiresAt) {
        // Token expired (or never minted) → BigQuery rejects, as in production.
        return Promise.reject(invalidCreds());
      }
      return Promise.resolve([loadResponse]);
    });
    const dataset = createMockDataset({ exists: true, tables: new Map([['issues', table]]) });
    const client = createMockClient(dataset);

    const dest = new BigQueryDestination({
      datasetId: 'test_ds',
      client,
      stagingFormat: 'jsonl',
      tokenProvider: provider,
    });
    await dest.initialize();

    for (let batch = 0; batch < 4; batch += 1) {
      const result = await dest.loadAndFinalize(
        'test_ds',
        'issues',
        '/tmp/data.jsonl',
        issueColumns,
        'append',
        []
      );
      expect(result.rowsAffected).toBe(1);
    }

    // Refreshes happened mid-run (≥1 force-refresh across the batches).
    expect(provider.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
