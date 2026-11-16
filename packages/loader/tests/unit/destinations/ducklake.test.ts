import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DuckLakeDestination } from '../../../src/runtime/destinations/ducklake.js';
import { issueColumns } from '../../helpers/fixtures.js';

import type {
  DuckDbConnectionLike,
  DuckDbDatabaseLike,
} from '../../../src/runtime/duckdb-primitives.js';
import type { SchemaColumn } from '@bobsled-inc/protocol';

class FakeDuckDbConnection implements DuckDbConnectionLike {
  constructor(private readonly attachAlias: string = 'lake') {}

  readonly runLog: string[] = [];
  readonly allLog: string[] = [];
  private readonly tableColumns = new Map<string, Map<string, string>>();
  private readonly tableRowCounts = new Map<string, number>();
  private readonly createdTempTables = new Set<string>();
  nextInsertRows = 0;
  nextStagingRows = 0;
  failOnRun?: (sql: string) => Error | null;

  async run(sql: string): Promise<void> {
    this.runLog.push(sql);

    const forcedError = this.failOnRun?.(sql);
    if (forcedError) {
      throw forcedError;
    }

    if (sql.startsWith('CREATE TABLE IF NOT EXISTS ')) {
      const match = sql.match(/^CREATE TABLE IF NOT EXISTS (.+?) \((.+)\)$/);
      if (match) {
        const [, qualifiedTable, defs] = match;
        const columns = new Map<string, string>();
        for (const def of defs.split(', ')) {
          const columnMatch = def.match(/^"([^"]+)" (.+)$/);
          if (columnMatch) {
            columns.set(columnMatch[1]!, columnMatch[2]!);
          }
        }
        this.tableColumns.set(qualifiedTable!, columns);
      }
    }

    if (sql.startsWith('ALTER TABLE ') && sql.includes(' ADD COLUMN ')) {
      const match = sql.match(/^ALTER TABLE (.+?) ADD COLUMN "([^"]+)" (.+)$/);
      if (match) {
        const [, qualifiedTable, columnName, columnType] = match;
        const columns = this.tableColumns.get(qualifiedTable!) ?? new Map<string, string>();
        columns.set(columnName!, columnType!);
        this.tableColumns.set(qualifiedTable!, columns);
      }
    }

    if (sql.startsWith('TRUNCATE TABLE ')) {
      const table = sql.replace('TRUNCATE TABLE ', '');
      this.tableRowCounts.set(table, 0);
    }

    if (sql.startsWith('INSERT INTO ')) {
      const match = sql.match(/^INSERT INTO (.+?) \(/);
      if (match) {
        const table = match[1]!;
        const current = this.tableRowCounts.get(table) ?? 0;
        this.tableRowCounts.set(table, current + this.nextInsertRows);
        this.nextInsertRows = 0;
      }
    }

    if (sql.startsWith('CREATE TEMP TABLE ')) {
      const match = sql.match(/^CREATE TEMP TABLE (temp\.main\."[^"]+") AS /);
      if (match) {
        const stagingTable = match[1]!;
        this.createdTempTables.add(stagingTable);
        this.tableRowCounts.set(stagingTable, this.nextStagingRows);
        this.nextStagingRows = 0;
      }
    }

    if (sql.startsWith('DROP TABLE IF EXISTS ')) {
      const table = sql.replace('DROP TABLE IF EXISTS ', '');
      this.createdTempTables.delete(table);
      this.tableRowCounts.delete(table);
    }
  }

  async all(sql: string): Promise<Record<string, unknown>[]> {
    this.allLog.push(sql);

    if (sql.includes('FROM information_schema.tables')) {
      const schemaMatch = sql.match(/table_schema = '([^']+)'/);
      const tableMatch = sql.match(/table_name = '([^']+)'/);
      const tableKey = `"${this.attachAlias}"."${schemaMatch?.[1] ?? 'main'}"."${tableMatch?.[1] ?? ''}"`;
      return this.tableColumns.has(tableKey) ? [{ '1': 1 }] : [];
    }

    if (sql.includes('FROM information_schema.columns')) {
      const schemaMatch = sql.match(/table_schema = '([^']+)'/);
      const tableMatch = sql.match(/table_name = '([^']+)'/);
      const tableKey = `"${this.attachAlias}"."${schemaMatch?.[1] ?? 'main'}"."${tableMatch?.[1] ?? ''}"`;
      const columns = this.tableColumns.get(tableKey);
      if (!columns) {
        return [];
      }

      return [...columns.entries()].map(([column_name, data_type]) => ({
        column_name,
        data_type,
      }));
    }

    const countMatch = sql.match(/^SELECT COUNT\(\*\) AS c FROM (.+)$/);
    if (countMatch) {
      return [{ c: this.tableRowCounts.get(countMatch[1]!) ?? 0 }];
    }

    return [];
  }

  async close(): Promise<void> {
    // no-op
  }

  getColumns(table: string): Record<string, string> | undefined {
    const columns = this.tableColumns.get(table);
    if (!columns) {
      return undefined;
    }
    return Object.fromEntries(columns.entries());
  }
}

class FakeDuckDbDatabase implements DuckDbDatabaseLike {
  constructor(private readonly connection: FakeDuckDbConnection) {}

  async connect(): Promise<DuckDbConnectionLike> {
    return this.connection;
  }

  async close(): Promise<void> {
    // no-op
  }
}

function createHarness(options?: {
  attachAlias?: string;
  metadataSchema?: string;
  failOnRun?: (sql: string) => Error | null;
}): {
  connection: FakeDuckDbConnection;
  destination: DuckLakeDestination;
} {
  const connection = new FakeDuckDbConnection(options?.attachAlias ?? 'lake');
  connection.failOnRun = options?.failOnRun;
  const database = new FakeDuckDbDatabase(connection);

  return {
    connection,
    destination: new DuckLakeDestination({
      catalogUrl: 'ducklake:catalog.db',
      dataPath: './data',
      attachAlias: options?.attachAlias,
      metadataSchema: options?.metadataSchema,
      databaseFactory: async () => database,
    }),
  };
}

describe('DuckLakeDestination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initialize() runs INSTALL, LOAD, and ATTACH with DATA_PATH support', async () => {
    const { connection, destination } = createHarness({ attachAlias: 'warehouse' });

    await destination.initialize();

    expect(connection.runLog).toEqual([
      // ducklake is a core extension in 1.4.x; we install core first (the mock
      // succeeds, so no community fallback is logged), then LOAD + ATTACH.
      'INSTALL ducklake',
      'LOAD ducklake',
      `ATTACH 'ducklake:catalog.db' AS "warehouse" (DATA_PATH './data')`,
    ]);
  });

  it('initialize() appends METADATA_SCHEMA to the ATTACH when set', async () => {
    const { connection, destination } = createHarness({
      attachAlias: 'warehouse',
      metadataSchema: 'ducklake_cache',
    });

    await destination.initialize();

    expect(connection.runLog).toEqual([
      'INSTALL ducklake',
      'LOAD ducklake',
      `ATTACH 'ducklake:catalog.db' AS "warehouse" (DATA_PATH './data', METADATA_SCHEMA 'ducklake_cache')`,
    ]);
  });

  it('ensureTable() creates the attached-catalog table with loader system columns', async () => {
    const { connection, destination } = createHarness();
    await destination.initialize();

    await destination.ensureTable('main', 'issues', issueColumns);

    expect(connection.getColumns('"lake"."main"."issues"')).toEqual({
      id: 'BIGINT',
      title: 'VARCHAR',
      _time_extracted: 'TIMESTAMP',
      _bobsled_loaded_at: 'TIMESTAMP',
    });
  });

  it('ensureTable() adds new columns through ALTER TABLE when schema evolves', async () => {
    const { connection, destination } = createHarness();
    await destination.initialize();

    await destination.ensureTable('main', 'issues', issueColumns);
    const extendedColumns: SchemaColumn[] = [...issueColumns, { name: 'status', type: 'string' }];

    await destination.ensureTable('main', 'issues', extendedColumns);

    expect(connection.runLog).toContain(
      'ALTER TABLE "lake"."main"."issues" ADD COLUMN "status" VARCHAR'
    );
    expect(connection.getColumns('"lake"."main"."issues"')?.status).toBe('VARCHAR');
  });

  it('loadAndFinalize("append") inserts into the 3-part qualified table and returns rows affected', async () => {
    const { connection, destination } = createHarness();
    await destination.initialize();
    await destination.ensureTable('main', 'issues', issueColumns);
    connection.nextInsertRows = 2;

    const result = await destination.loadAndFinalize(
      'main',
      'issues',
      '/tmp/append.jsonl',
      issueColumns,
      'append',
      []
    );

    expect(result).toEqual({ rowsAffected: 2 });
    expect(
      connection.runLog.some((sql) =>
        sql.startsWith(
          'INSERT INTO "lake"."main"."issues" ("id", "title", "_time_extracted", "_bobsled_loaded_at")'
        )
      )
    ).toBe(true);
  });

  it('loadAndFinalize("merge") builds a deduping MERGE with ROW_NUMBER and returns staging count', async () => {
    const { connection, destination } = createHarness();
    await destination.initialize();
    await destination.ensureTable('main', 'issues', issueColumns);
    connection.nextStagingRows = 2;

    const result = await destination.loadAndFinalize(
      'main',
      'issues',
      '/tmp/merge.jsonl',
      issueColumns,
      'merge',
      ['id']
    );

    expect(result).toEqual({ rowsAffected: 2 });
    expect(
      connection.runLog.some((sql) =>
        sql.includes(
          'ROW_NUMBER() OVER (PARTITION BY "id" ORDER BY "_time_extracted" DESC NULLS LAST)'
        )
      )
    ).toBe(true);
    expect(
      connection.runLog.some((sql) =>
        sql.startsWith('MERGE INTO "lake"."main"."issues" USING temp.main."_bobsled_stg_issues_')
      )
    ).toBe(true);
  });

  it('loadAndFinalize("full_refresh") truncates only once across multiple flushes', async () => {
    const { connection, destination } = createHarness();
    await destination.initialize();
    await destination.ensureTable('main', 'issues', issueColumns);

    connection.nextInsertRows = 1;
    await destination.loadAndFinalize(
      'main',
      'issues',
      '/tmp/refresh-1.jsonl',
      issueColumns,
      'full_refresh',
      []
    );

    connection.nextInsertRows = 1;
    const result = await destination.loadAndFinalize(
      'main',
      'issues',
      '/tmp/refresh-2.jsonl',
      issueColumns,
      'full_refresh',
      []
    );

    expect(result).toEqual({ rowsAffected: 1 });
    expect(
      connection.runLog.filter((sql) => sql === 'TRUNCATE TABLE "lake"."main"."issues"')
    ).toHaveLength(1);
  });

  it('filters global information_schema by catalog and qualifies destination tables', async () => {
    const { connection, destination } = createHarness({ attachAlias: 'warehouse' });
    await destination.initialize();

    await destination.ensureTable('main', 'issues', issueColumns);

    expect(
      connection.allLog.some((sql) =>
        sql.includes("FROM information_schema.columns WHERE table_catalog = 'warehouse'")
      )
    ).toBe(true);
    expect(connection.runLog.some((sql) => sql.includes('"warehouse"."main"."issues"'))).toBe(true);
  });

  it('drops the staging table when merge fails', async () => {
    const { connection, destination } = createHarness({
      failOnRun: (sql) =>
        sql.startsWith('MERGE INTO ') ? new Error('forced merge failure') : null,
    });
    await destination.initialize();
    await destination.ensureTable('main', 'issues', issueColumns);
    connection.nextStagingRows = 1;

    await expect(
      destination.loadAndFinalize('main', 'issues', '/tmp/error.jsonl', issueColumns, 'merge', [
        'id',
      ])
    ).rejects.toThrow('forced merge failure');

    expect(
      connection.runLog.some((sql) =>
        sql.startsWith('DROP TABLE IF EXISTS temp.main."_bobsled_stg_issues_')
      )
    ).toBe(true);
  });

  it('close() issues DETACH before cleanup', async () => {
    const { connection, destination } = createHarness();
    await destination.initialize();

    await destination.close();

    expect(connection.runLog.at(-1)).toBe('DETACH "lake"');
  });

  it('merge strategy requires at least one key column', async () => {
    const { destination } = createHarness();
    await destination.initialize();

    await expect(
      destination.loadAndFinalize('main', 'issues', '/tmp/error.jsonl', issueColumns, 'merge', [])
    ).rejects.toThrow('merge strategy requires at least one key column');
  });

  it('constructor rejects invalid memoryLimit values', () => {
    expect(
      () =>
        new DuckLakeDestination({
          catalogUrl: 'ducklake:catalog.db',
          memoryLimit: 'not-a-size',
        })
    ).toThrow(/Invalid memoryLimit/);
    expect(
      () =>
        new DuckLakeDestination({
          catalogUrl: 'ducklake:catalog.db',
          memoryLimit: 'MB512',
        })
    ).toThrow(/Invalid memoryLimit/);
  });

  it('constructor accepts valid memoryLimit values', () => {
    expect(
      () =>
        new DuckLakeDestination({
          catalogUrl: 'ducklake:catalog.db',
          memoryLimit: '512MB',
        })
    ).not.toThrow();
    expect(
      () =>
        new DuckLakeDestination({
          catalogUrl: 'ducklake:catalog.db',
          memoryLimit: '2.5GiB',
        })
    ).not.toThrow();
  });

  it('constructor rejects invalid attachAlias values', () => {
    expect(
      () =>
        new DuckLakeDestination({
          catalogUrl: 'ducklake:catalog.db',
          attachAlias: 'my-alias',
        })
    ).toThrow(/Invalid attach alias/);
    expect(
      () =>
        new DuckLakeDestination({
          catalogUrl: 'ducklake:catalog.db',
          attachAlias: '123invalid',
        })
    ).toThrow(/Invalid attach alias/);
  });

  it('constructor accepts valid attachAlias values', () => {
    expect(
      () =>
        new DuckLakeDestination({
          catalogUrl: 'ducklake:catalog.db',
          attachAlias: 'warehouse',
        })
    ).not.toThrow();
    expect(
      () =>
        new DuckLakeDestination({
          catalogUrl: 'ducklake:catalog.db',
          attachAlias: '_my_lake',
        })
    ).not.toThrow();
  });

  it('constructor accepts generated file paths without reading them during SQL generation', async () => {
    const { connection, destination } = createHarness();
    await destination.initialize();
    await destination.ensureTable('main', 'issues', issueColumns);
    connection.nextInsertRows = 1;

    await destination.loadAndFinalize(
      'main',
      'issues',
      '/tmp/path with spaces/issues.jsonl',
      issueColumns,
      'append',
      []
    );

    expect(
      connection.runLog.some((sql) =>
        sql.includes(`read_json('/tmp/path with spaces/issues.jsonl'`)
      )
    ).toBe(true);
  });

  describe('deleteRows', () => {
    it('deletes escaped values from the attached-catalog table', async () => {
      const { connection, destination } = createHarness({ attachAlias: 'warehouse' });
      await destination.initialize();
      await destination.ensureTable('main', 'issues', issueColumns);

      await destination.deleteRows('main', 'issues', 'title', ["a'b", 'c']);

      expect(
        connection.allLog.some((sql) =>
          sql.includes("FROM information_schema.tables WHERE table_catalog = 'warehouse'")
        )
      ).toBe(true);
      expect(connection.runLog.filter((sql) => sql.startsWith('DELETE'))).toEqual([
        `DELETE FROM "warehouse"."main"."issues" WHERE "title" IN ('a''b', 'c')`,
      ]);
    });

    it('batches values 500 per statement', async () => {
      const { connection, destination } = createHarness();
      await destination.initialize();
      await destination.ensureTable('main', 'issues', issueColumns);

      const values = Array.from({ length: 1001 }, (_, i) => `id-${i}`);
      await destination.deleteRows('main', 'issues', 'title', values);

      const deletes = connection.runLog.filter((sql) => sql.startsWith('DELETE'));
      expect(deletes.map((sql) => sql.split("', '").length)).toEqual([500, 500, 1]);
    });

    it('is a no-op when the table does not exist', async () => {
      const { connection, destination } = createHarness();
      await destination.initialize();

      await destination.deleteRows('main', 'missing', 'title', ['a']);

      expect(connection.allLog.some((sql) => sql.includes('information_schema.tables'))).toBe(true);
      expect(connection.runLog.some((sql) => sql.startsWith('DELETE'))).toBe(false);
    });

    it('propagates delete errors', async () => {
      const { destination } = createHarness({
        failOnRun: (sql) => (sql.startsWith('DELETE') ? new Error('forced delete failure') : null),
      });
      await destination.initialize();
      await destination.ensureTable('main', 'issues', issueColumns);

      await expect(destination.deleteRows('main', 'issues', 'title', ['a'])).rejects.toThrow(
        'forced delete failure'
      );
    });
  });
});
