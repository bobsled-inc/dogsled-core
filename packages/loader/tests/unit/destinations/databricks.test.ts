import * as fs from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  DatabricksConnectionLike,
  DatabricksOperationLike,
  DatabricksSessionLike,
} from '../../../src/runtime/destinations/databricks.js';
import type { SchemaColumn } from '@bobsled-inc/protocol';

vi.mock('node:fs/promises');

const issueColumns: SchemaColumn[] = [
  { name: 'id', type: 'integer', primary_key: true },
  { name: 'title', type: 'string' },
];

function createMockOperation(rows: Record<string, unknown>[] = []): DatabricksOperationLike & {
  fetchAll: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    fetchAll: vi.fn().mockResolvedValue(rows),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockSession(
  options: {
    tableExists?: boolean;
    tableType?: string;
    ownershipMarker?: string;
    existingColumns?: Array<{ column_name: string; data_type: string }>;
  } = {}
): {
  session: DatabricksSessionLike & {
    executeStatement: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  operations: Array<{ sql: string; operation: DatabricksOperationLike }>;
} {
  const operations: Array<{ sql: string; operation: DatabricksOperationLike }> = [];
  let created = false;
  let createdMarker: string | undefined;
  const executeStatement = vi.fn().mockImplementation((sql: string) => {
    let rows: Record<string, unknown>[] = [];
    if (sql.includes('system.information_schema.tables')) {
      rows = options.tableExists || created ? [{ table_type: options.tableType ?? 'MANAGED' }] : [];
    } else if (sql.includes('system.information_schema.columns')) {
      rows = options.existingColumns ?? [];
    } else if (sql.startsWith('SHOW TBLPROPERTIES')) {
      const marker = options.ownershipMarker ?? createdMarker;
      rows = marker === undefined ? [] : [{ value: marker }];
    } else if (sql.startsWith('CREATE TABLE IF NOT EXISTS')) {
      created = true;
      createdMarker = sql.match(/'dogsled_temp_dataset' = '([^']+)'/)?.[1];
    }

    const operation = createMockOperation(rows);
    operations.push({ sql, operation });
    return Promise.resolve(operation);
  });

  return {
    session: {
      executeStatement,
      close: vi.fn().mockResolvedValue(undefined),
    },
    operations,
  };
}

function createMockConnection(session: DatabricksSessionLike): DatabricksConnectionLike & {
  openSession: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    openSession: vi.fn().mockResolvedValue(session),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

async function createDestination(connection?: DatabricksConnectionLike) {
  const { session } = createMockSession();
  const conn = connection ?? createMockConnection(session);
  const { DatabricksDestination } = await import('../../../src/runtime/destinations/databricks.js');
  return {
    dest: new DatabricksDestination({
      serverHostname: 'example.cloud.databricks.com',
      httpPath: '/sql/1.0/warehouses/abc123',
      accessToken: 'dapi-test-token',
      catalog: 'main',
      schema: 'analytics',
      clientFactory: async () => conn,
    }),
    connection: conn,
  };
}

function mockFileContent(records: Record<string, unknown>[]): void {
  vi.mocked(fs.readFile).mockResolvedValue(records.map((row) => JSON.stringify(row)).join('\n'));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@databricks/sql');
});

describe('DatabricksDestination', () => {
  it('never enables the SDK proxy/PAC path in the default adapter', async () => {
    const { session } = createMockSession();
    const connection = createMockConnection(session);
    const connect = vi.fn().mockResolvedValue(connection);
    vi.doMock('@databricks/sql', () => ({
      DBSQLClient: class {
        connect = connect;
      },
    }));
    const { DatabricksDestination } =
      await import('../../../src/runtime/destinations/databricks.js');
    const destination = new DatabricksDestination({
      serverHostname: 'warehouse.example.com',
      httpPath: '/sql/test',
      accessToken: 'test-token',
      catalog: 'main',
      schema: 'default',
    });
    try {
      await destination.initialize();
      expect(connect).toHaveBeenCalledExactlyOnceWith({
        host: 'warehouse.example.com',
        path: '/sql/test',
        token: 'test-token',
      });
      expect(connect.mock.calls[0]?.[0]).not.toHaveProperty('proxy');
    } finally {
      await destination.close();
    }
  });

  it('uses OAuth M2M to obtain the SQL client token when no PAT is configured', async () => {
    const { session } = createMockSession();
    const connection = createMockConnection(session);
    const clientFactory = vi.fn().mockResolvedValue(connection);
    const oauthTokenFetcher = vi.fn().mockResolvedValue('short-lived-token');
    const { DatabricksDestination } =
      await import('../../../src/runtime/destinations/databricks.js');
    const dest = new DatabricksDestination({
      serverHostname: 'example.cloud.databricks.com',
      httpPath: '/sql/1.0/warehouses/abc123',
      oauthClientId: 'client-id',
      oauthClientSecret: 'client-secret',
      catalog: 'main',
      schema: 'analytics',
      clientFactory,
      oauthTokenFetcher,
    });

    await dest.initialize();

    expect(oauthTokenFetcher).toHaveBeenCalledWith(
      'example.cloud.databricks.com',
      'client-id',
      'client-secret'
    );
    expect(clientFactory).toHaveBeenCalledWith(
      'example.cloud.databricks.com',
      '/sql/1.0/warehouses/abc123',
      'short-lived-token'
    );
  });

  it('rejects missing, partial, or mixed authentication', async () => {
    const { DatabricksDestination } =
      await import('../../../src/runtime/destinations/databricks.js');
    const base = {
      serverHostname: 'example.cloud.databricks.com',
      httpPath: '/sql/1.0/warehouses/abc123',
      catalog: 'main',
      schema: 'analytics',
    };
    expect(() => new DatabricksDestination(base)).toThrow('exactly one');
    expect(() => new DatabricksDestination({ ...base, oauthClientId: 'id' })).toThrow();
    expect(
      () =>
        new DatabricksDestination({
          ...base,
          accessToken: 'pat',
          oauthClientId: 'id',
          oauthClientSecret: 'secret',
        })
    ).toThrow('exactly one');
  });

  it('closes a late-created operation and session when cancellation is rejected', async () => {
    let resolveExecute: ((operation: DatabricksOperationLike) => void) | undefined;
    const operation: DatabricksOperationLike = {
      cancel: vi.fn().mockRejectedValue(new Error('cancel rejected')),
      fetchAll: vi.fn().mockResolvedValue([]),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const session: DatabricksSessionLike & {
      close: ReturnType<typeof vi.fn>;
      executeStatement: ReturnType<typeof vi.fn>;
    } = {
      executeStatement: vi.fn(
        () =>
          new Promise<DatabricksOperationLike>((resolve) => {
            resolveExecute = resolve;
          })
      ),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const connection = createMockConnection(session);
    const { dest } = await createDestination(connection);

    const initialization = dest.initialize();
    await vi.waitFor(() => expect(resolveExecute).toBeDefined());
    await dest.cancel();
    resolveExecute!(operation);

    await expect(initialization).rejects.toThrow('cancel rejected');
    expect(operation.cancel).toHaveBeenCalledOnce();
    expect(operation.fetchAll).not.toHaveBeenCalled();
    expect(operation.close).toHaveBeenCalledOnce();
    expect(session.close).toHaveBeenCalledOnce();
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it('initialize() consumes and closes operation handles for catalog and schema setup', async () => {
    const { session, operations } = createMockSession();
    const connection = createMockConnection(session);
    const { dest } = await createDestination(connection);

    await dest.initialize();

    expect(session.executeStatement).toHaveBeenCalledWith('USE CATALOG `main`');
    expect(session.executeStatement).toHaveBeenCalledWith('USE SCHEMA `analytics`');

    const useOperations = operations.filter(
      ({ sql }) => sql.startsWith('USE CATALOG') || sql.startsWith('USE SCHEMA')
    );
    expect(useOperations).toHaveLength(2);
    for (const entry of useOperations) {
      expect(entry.operation.fetchAll).toHaveBeenCalled();
      expect(entry.operation.close).toHaveBeenCalled();
    }
  });

  it('ensureTable() creates a table with system columns', async () => {
    const { session, operations } = createMockSession();
    const connection = createMockConnection(session);
    const { dest } = await createDestination(connection);
    await dest.initialize();

    await dest.ensureTable('analytics', 'issues', issueColumns);

    const createStatement = operations.find(({ sql }) => sql.startsWith('CREATE TABLE'));
    expect(createStatement?.sql).toContain('`id` BIGINT');
    expect(createStatement?.sql).toContain('`title` STRING');
    expect(createStatement?.sql).toContain('`_time_extracted` TIMESTAMP');
    expect(createStatement?.sql).toContain(
      '`_dogsled_loaded_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
    );
  });

  it('creates reserved tables with an atomic ownership property and verifies a managed table', async () => {
    const { session, operations } = createMockSession();
    const { dest } = await createDestination(createMockConnection(session));

    await dest.ensureTable('analytics', 'issues', issueColumns, {
      tableOwnershipMarker: 'dataset-123',
    });

    const createStatement = operations.find(({ sql }) => sql.startsWith('CREATE TABLE'));
    expect(createStatement?.sql).toContain(
      "TBLPROPERTIES ('dogsled_temp_dataset' = 'dataset-123')"
    );
    expect(operations.some(({ sql }) => sql.includes('SELECT table_type'))).toBe(true);
    expect(operations.some(({ sql }) => sql.startsWith('SHOW TBLPROPERTIES'))).toBe(true);
  });

  it('looks up Unity Catalog metadata using lowercase object names', async () => {
    const { session, operations } = createMockSession();
    const { DatabricksDestination } =
      await import('../../../src/runtime/destinations/databricks.js');
    const dest = new DatabricksDestination({
      serverHostname: 'example.cloud.databricks.com',
      httpPath: '/sql/1.0/warehouses/abc123',
      accessToken: 'dapi-test-token',
      catalog: 'MyCatalog',
      schema: 'MySchema',
      clientFactory: async () => createMockConnection(session),
    });

    await dest.ensureTable('MySchema', 'DS_CSV_123', issueColumns, {
      tableOwnershipMarker: 'dataset-123',
    });

    const metadataQueries = operations.filter(({ sql }) =>
      sql.includes('system.information_schema.')
    );
    expect(metadataQueries).toHaveLength(2);
    for (const { sql } of metadataQueries) {
      expect(sql).toContain("table_catalog = 'mycatalog'");
      expect(sql).toContain("table_schema = 'myschema'");
      expect(sql).toContain("table_name = 'ds_csv_123'");
    }
  });

  it.each([
    { tableType: 'EXTERNAL', ownershipMarker: 'dataset-123' },
    { tableType: 'MANAGED', ownershipMarker: undefined },
    { tableType: 'MANAGED', ownershipMarker: 'other-dataset' },
  ])('refuses to mutate an existing unowned or unmanaged table: %j', async (metadata) => {
    const { session, operations } = createMockSession({
      tableExists: true,
      ...metadata,
      existingColumns: [{ column_name: 'id', data_type: 'BIGINT' }],
    });
    const { dest } = await createDestination(createMockConnection(session));

    await expect(
      dest.ensureTable('analytics', 'issues', issueColumns, {
        tableOwnershipMarker: 'dataset-123',
      })
    ).rejects.toThrow(/not an owned managed table|not owned by the requested dataset/);
    expect(
      operations.some(({ sql }) => /^(CREATE|ALTER|DELETE|INSERT|MERGE|COPY) /.test(sql))
    ).toBe(false);
  });

  it('rechecks the ownership property before loading a cached reserved table', async () => {
    const metadata: { ownershipMarker?: string } = { ownershipMarker: 'dataset-123' };
    const { session, operations } = createMockSession(metadata);
    const { dest } = await createDestination(createMockConnection(session));
    await dest.ensureTable('analytics', 'issues', issueColumns, {
      tableOwnershipMarker: 'dataset-123',
    });
    metadata.ownershipMarker = 'other-dataset';
    mockFileContent([{ id: 1, title: 'Bug', _time_extracted: '2026-01-01T00:00:00Z' }]);

    await expect(
      dest.loadAndFinalize('analytics', 'issues', '/tmp/issues.jsonl', issueColumns, 'append', [])
    ).rejects.toThrow('not owned by the requested dataset');
    expect(operations.some(({ sql }) => sql.startsWith('INSERT INTO'))).toBe(false);
  });

  it('ensureTable() includes CLUSTER BY on create when clustering columns are provided', async () => {
    const { session, operations } = createMockSession();
    const connection = createMockConnection(session);
    const { dest } = await createDestination(connection);
    await dest.initialize();

    await dest.ensureTable(
      'analytics',
      'issues',
      [...issueColumns, { name: 'updated_at', type: 'timestamp' }],
      {
        keyProperties: ['id'],
        cursorField: 'updated_at',
      }
    );

    const createStatement = operations.find(({ sql }) => sql.startsWith('CREATE TABLE'));
    expect(createStatement?.sql).toContain('CLUSTER BY (`updated_at`, `id`)');
  });

  it('ensureTable() adds missing columns with ALTER TABLE', async () => {
    const { session, operations } = createMockSession({
      tableExists: true,
      existingColumns: [
        { column_name: 'id', data_type: 'BIGINT' },
        { column_name: '_time_extracted', data_type: 'TIMESTAMP' },
        { column_name: '_dogsled_loaded_at', data_type: 'TIMESTAMP' },
      ],
    });
    const { dest } = await createDestination(createMockConnection(session));
    await dest.initialize();

    await dest.ensureTable('analytics', 'issues', issueColumns);

    const alterStatement = operations.find(({ sql }) => sql.startsWith('ALTER TABLE'));
    expect(alterStatement?.sql).toContain('ADD COLUMNS (`title` STRING)');
  });

  it('ensureTable() rejects incompatible type changes', async () => {
    const { session } = createMockSession({
      tableExists: true,
      existingColumns: [
        { column_name: 'id', data_type: 'STRING' },
        { column_name: 'title', data_type: 'STRING' },
        { column_name: '_time_extracted', data_type: 'TIMESTAMP' },
        { column_name: '_dogsled_loaded_at', data_type: 'TIMESTAMP' },
      ],
    });
    const { dest } = await createDestination(createMockConnection(session));
    await dest.initialize();

    await expect(dest.ensureTable('analytics', 'issues', issueColumns)).rejects.toThrow(
      /Schema change conflict.*id.*STRING.*BIGINT/i
    );
  });

  it('ensureTable() applies ALTER TABLE ... CLUSTER BY when existing clustering differs', async () => {
    const { session, operations } = createMockSession({
      tableExists: true,
      existingColumns: [
        { column_name: 'id', data_type: 'BIGINT' },
        { column_name: 'title', data_type: 'STRING' },
        { column_name: 'updated_at', data_type: 'TIMESTAMP' },
        { column_name: '_time_extracted', data_type: 'TIMESTAMP' },
        { column_name: '_dogsled_loaded_at', data_type: 'TIMESTAMP' },
      ],
    });
    const { dest } = await createDestination(createMockConnection(session));
    await dest.initialize();

    await dest.ensureTable(
      'analytics',
      'issues',
      [...issueColumns, { name: 'updated_at', type: 'timestamp' }],
      {
        keyProperties: ['id'],
        cursorField: 'updated_at',
      }
    );

    const clusterStatement = operations.find(({ sql }) =>
      sql.startsWith('ALTER TABLE `analytics`.`issues` CLUSTER BY')
    );
    expect(clusterStatement?.sql).toContain('CLUSTER BY (`updated_at`, `id`)');
  });

  it('ensureTable() skips redundant ALTER TABLE ... CLUSTER BY when cache already matches', async () => {
    const { session, operations } = createMockSession({
      tableExists: true,
      existingColumns: [
        { column_name: 'id', data_type: 'BIGINT' },
        { column_name: 'title', data_type: 'STRING' },
        { column_name: 'updated_at', data_type: 'TIMESTAMP' },
        { column_name: '_time_extracted', data_type: 'TIMESTAMP' },
        { column_name: '_dogsled_loaded_at', data_type: 'TIMESTAMP' },
      ],
    });
    const { dest } = await createDestination(createMockConnection(session));
    await dest.initialize();

    const columns: SchemaColumn[] = [...issueColumns, { name: 'updated_at', type: 'timestamp' }];
    const options = { keyProperties: ['id'], cursorField: 'updated_at' } as const;

    await dest.ensureTable('analytics', 'issues', columns, options);
    await dest.ensureTable('analytics', 'issues', columns, options);

    const clusterStatements = operations.filter(({ sql }) =>
      sql.startsWith('ALTER TABLE `analytics`.`issues` CLUSTER BY')
    );
    expect(clusterStatements).toHaveLength(1);
  });

  it('loadAndFinalize(\"append\") inserts records with CURRENT_TIMESTAMP', async () => {
    const { session, operations } = createMockSession();
    const { dest } = await createDestination(createMockConnection(session));
    mockFileContent([{ id: 1, title: 'Bug', _time_extracted: '2026-01-01T00:00:00Z' }]);

    const result = await dest.loadAndFinalize(
      'analytics',
      'issues',
      '/tmp/issues.jsonl',
      issueColumns,
      'append',
      []
    );

    const insertStatement = operations.find(({ sql }) =>
      sql.startsWith('INSERT INTO `analytics`.`issues`')
    );
    expect(insertStatement?.sql).toContain('CURRENT_TIMESTAMP');
    expect(result.rowsAffected).toBe(1);
  });

  it('loadAndFinalize(\"full_refresh\") deletes rows once per table', async () => {
    const { session, operations } = createMockSession();
    const { dest } = await createDestination(createMockConnection(session));
    mockFileContent([{ id: 1, title: 'Bug', _time_extracted: '2026-01-01T00:00:00Z' }]);

    await dest.loadAndFinalize(
      'analytics',
      'issues',
      '/tmp/issues.jsonl',
      issueColumns,
      'full_refresh',
      []
    );
    await dest.loadAndFinalize(
      'analytics',
      'issues',
      '/tmp/issues.jsonl',
      issueColumns,
      'full_refresh',
      []
    );

    const deleteStatements = operations.filter(({ sql }) =>
      sql.startsWith('DELETE FROM `analytics`.`issues`')
    );
    expect(deleteStatements).toHaveLength(1);
  });

  it('loadAndFinalize(\"merge\") stages data, merges, and drops the staging table', async () => {
    const { session, operations } = createMockSession();
    const { dest } = await createDestination(createMockConnection(session));
    mockFileContent([{ id: 1, title: 'Bug', _time_extracted: '2026-01-01T00:00:00Z' }]);

    const result = await dest.loadAndFinalize(
      'analytics',
      'issues',
      '/tmp/issues.jsonl',
      issueColumns,
      'merge',
      ['id']
    );

    expect(
      operations.some(({ sql }) =>
        sql.startsWith('CREATE OR REPLACE TABLE `analytics`.`_dogsled_stg_issues_')
      )
    ).toBe(true);
    expect(
      operations.some(({ sql }) => sql.startsWith('INSERT INTO `analytics`.`_dogsled_stg_issues_'))
    ).toBe(true);
    expect(operations.some(({ sql }) => sql.startsWith('MERGE INTO `analytics`.`issues`'))).toBe(
      true
    );
    expect(
      operations.some(({ sql }) =>
        sql.startsWith('DROP TABLE IF EXISTS `analytics`.`_dogsled_stg_issues_')
      )
    ).toBe(true);
    expect(result.rowsAffected).toBe(1);
  });

  it('loadAndFinalize(\"merge\") requires key columns', async () => {
    const { dest } = await createDestination();
    mockFileContent([{ id: 1, title: 'Bug', _time_extracted: '2026-01-01T00:00:00Z' }]);

    await expect(
      dest.loadAndFinalize('analytics', 'issues', '/tmp/issues.jsonl', issueColumns, 'merge', [])
    ).rejects.toThrow(/merge strategy requires at least one key column/);
  });

  it('loadFromUri() deletes existing rows and COPY INTO loads Parquet URIs', async () => {
    const { session, operations } = createMockSession();
    const { dest } = await createDestination(createMockConnection(session));

    const result = await dest.loadFromUri(
      'analytics',
      'issues',
      ['/Volumes/stage/run/part-000.parquet'],
      issueColumns
    );

    expect(operations.some(({ sql }) => sql.startsWith('DELETE FROM `analytics`.`issues`'))).toBe(
      true
    );
    expect(
      operations.some(
        ({ sql }) =>
          sql.startsWith(
            "COPY INTO `analytics`.`issues` FROM '/Volumes/stage/run/part-000.parquet'"
          ) && sql.includes('FILEFORMAT = PARQUET')
      )
    ).toBe(true);
    expect(result.rowsAffected).toBe(0);
  });

  it('close() shuts down the cached session and connection', async () => {
    const { session } = createMockSession();
    const connection = createMockConnection(session);
    const { dest } = await createDestination(connection);
    await dest.initialize();

    await dest.close();

    expect(session.close).toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalled();
  });

  it('throws a helpful error when @databricks/sql is unavailable', async () => {
    vi.doMock('@databricks/sql', () => {
      throw new Error('Cannot find package @databricks/sql');
    });
    const { DatabricksDestination } =
      await import('../../../src/runtime/destinations/databricks.js');
    const dest = new DatabricksDestination({
      serverHostname: 'example.cloud.databricks.com',
      httpPath: '/sql/1.0/warehouses/abc123',
      accessToken: 'dapi-test-token',
      catalog: 'main',
      schema: 'analytics',
    });

    await expect(dest.initialize()).rejects.toThrow(/Install @databricks\/sql/);
  });
});

describe('Databricks untrusted record values', () => {
  it.each([
    "x\\', (SELECT current_user()) -- ",
    'back\\slash\n\r\t\b\f',
    "apostrophe'",
    'trailing\\',
  ])('escapes %s in INSERT statements', async (value) => {
    const { session, operations } = createMockSession();
    const { dest } = await createDestination(createMockConnection(session));
    mockFileContent([{ id: 1, title: value }]);
    await dest.initialize();
    await dest.loadAndFinalize(
      'analytics',
      'issues',
      '/tmp/records.jsonl',
      issueColumns,
      'append',
      []
    );
    const insert = operations.find(({ sql }) => sql.startsWith('INSERT INTO'))?.sql;
    const escaped = value
      .replaceAll('\\', '\\\\')
      .replaceAll("'", "''")
      .replaceAll('\n', '\\n')
      .replaceAll('\r', '\\r')
      .replaceAll('\t', '\\t')
      .replaceAll('\b', '\\b')
      .replaceAll('\f', '\\f');
    expect(insert).toContain("'" + escaped + "'");
    await dest.close();
  });
});
