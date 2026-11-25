import { describe, expect, it, vi } from 'vitest';

import { SnowflakeDestination } from '../../../src/runtime/destinations/snowflake.js';
import { readSnowflakeVectorTypes } from '../../../src/runtime/destinations/snowflake-schema-reconcile.js';
import type {
  SnowflakeConnectionLike,
  SnowflakeStatementResult,
} from '../../../src/runtime/destinations/snowflake.js';
import type { EnsureTableOptions } from '../../../src/runtime/destinations/database.js';
import type { LoadStrategy, SchemaColumn } from '@bobsled-inc/protocol';

function result(rows: Record<string, unknown>[] = []): SnowflakeStatementResult {
  return { getRows: () => rows, getAffectedRows: () => 0, getColumns: () => [] };
}

/** The type names a Snowflake account answers with for the same column. */
function informationSchemaType(type: string): string {
  return type === 'VARCHAR' ? 'TEXT' : type.replace(/\(.*\)$/, '');
}

function describedType(type: string): string {
  if (type === 'VARCHAR') return 'VARCHAR(16777216)';
  return type === 'TIMESTAMP_TZ' ? 'TIMESTAMP_TZ(9)' : type;
}

/** A Snowflake account that keeps the tables its connections create. */
class FakeSnowflake {
  readonly statements: string[] = [];
  private readonly tables = new Map<
    string,
    { columns: Array<[name: string, type: string]>; comment?: string }
  >();

  /** Create the table in the account, as CREATE TABLE outside Dogsled would. */
  createTable(name: string, columns: Array<[name: string, type: string]>): void {
    this.tables.set(name, {
      columns: [
        ...columns,
        ['_TIME_EXTRACTED', 'TIMESTAMP_TZ'],
        ['_DOGSLED_LOADED_AT', 'TIMESTAMP_TZ'],
      ],
    });
  }

  private execute(sqlText: string): SnowflakeStatementResult {
    this.statements.push(sqlText);
    const ddl = sqlText.match(
      /^CREATE (?:OR REPLACE )?TABLE (?:IF NOT EXISTS )?"[^"]+"\."([^"]+)" \((.*?)\)(?: COPY GRANTS)?(?: COMMENT = '([^']*)')?$/
    );
    if (ddl) {
      const columns = [...ddl[2]!.matchAll(/"([^"]+)" ([A-Z_]+(?:\([^)]*\))?)/g)];
      this.tables.set(ddl[1]!, {
        columns: columns.map((column) => [column[1]!, column[2]!]),
        comment: ddl[3],
      });
    }
    const described = sqlText.match(/^DESCRIBE TABLE "[^"]+"\."([^"]+)"$/);
    if (described) {
      return result(
        this.tables.get(described[1]!)!.columns.map(([name, type]) => ({
          name,
          type: describedType(type),
          kind: 'COLUMN',
        }))
      );
    }
    if (sqlText.includes('.INFORMATION_SCHEMA.SCHEMATA')) {
      return result([{ SCHEMA_NAME: 'TEST_SCHEMA' }]);
    }
    const name = sqlText.match(/TABLE_NAME = '([^']+)'/)?.[1];
    const table = name === undefined ? undefined : this.tables.get(name);
    if (sqlText.includes('.INFORMATION_SCHEMA.COLUMNS')) {
      return result(
        table?.columns.map(([column, type]) => ({
          COLUMN_NAME: column,
          DATA_TYPE: informationSchemaType(type),
        }))
      );
    }
    if (sqlText.includes('.INFORMATION_SCHEMA.TABLES')) {
      return result(
        table && [{ TABLE_NAME: name, COMMENT: table.comment ?? null, CLUSTERING_KEY: null }]
      );
    }
    return result();
  }

  /** A loader run: a new destination and connection, which share only the account. */
  async run(): Promise<SnowflakeDestination> {
    this.statements.length = 0;
    const connection: SnowflakeConnectionLike = {
      connect: vi.fn().mockResolvedValue(undefined),
      execute: async ({ sqlText }) => this.execute(sqlText),
      uploadFile: vi.fn().mockResolvedValue({ status: 'UPLOADED' }),
      isClosed: () => false,
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    const destination = new SnowflakeDestination({
      account: 'test-account',
      username: 'test-user',
      password: 'test-pass',
      warehouse: 'TEST_WH',
      database: 'TEST_DB',
      schema: 'TEST_SCHEMA',
      connectionFactory: () => connection,
    });
    await destination.initialize();
    this.statements.length = 0;
    return destination;
  }

  started(prefix: string): string[] {
    return this.statements.filter((statement) => statement.startsWith(prefix));
  }
}

function columns(dimension: number): SchemaColumn[] {
  return [
    { name: 'id', type: 'integer', primary_key: true },
    { name: 'document_id', type: 'string' },
    { name: 'text_embedding', type: 'vector', dimension },
  ];
}

async function load(
  warehouse: FakeSnowflake,
  schema: SchemaColumn[],
  strategy: LoadStrategy,
  options: EnsureTableOptions = {},
  table = 'chunks'
): Promise<void> {
  const destination = await warehouse.run();
  await destination.ensureTable('test_schema', table, schema, {
    loadStrategy: strategy,
    ...options,
  });
  await destination.loadAndFinalize('test_schema', table, '/tmp/rows.jsonl', schema, strategy, [
    'id',
  ]);
}

const REPLACE_TABLE = 'CREATE OR REPLACE TABLE ';

describe('readSnowflakeVectorTypes', () => {
  // INFORMATION_SCHEMA.COLUMNS and DESCRIBE TABLE as a Snowflake account answered them.
  const informationSchema: Array<[string, string]> = [
    ['ID', 'NUMBER'],
    ['BODY', 'TEXT'],
    ['FLOATS', 'VECTOR'],
    ['INTS', 'VECTOR'],
    ['_TIME_EXTRACTED', 'TIMESTAMP_TZ'],
  ];
  const described = [
    { name: 'ID', type: 'NUMBER(38,0)' },
    { name: 'BODY', type: 'VARCHAR(16777216)' },
    { name: 'FLOATS', type: 'VECTOR(FLOAT, 3)' },
    { name: 'INTS', type: 'VECTOR(INT, 16)' },
    { name: '_TIME_EXTRACTED', type: 'TIMESTAMP_TZ(9)' },
  ];

  it('fills in the element type and length of plain VECTOR columns only', async () => {
    const types = new Map(informationSchema);
    const execute = vi.fn().mockResolvedValue(result(described));
    await readSnowflakeVectorTypes({ execute }, '"S"."T"', types, vi.fn(), () => ({}));
    expect(execute.mock.calls).toEqual([[{ sqlText: 'DESCRIBE TABLE "S"."T"' }]]);
    expect([...types]).toEqual([
      ['ID', 'NUMBER'],
      ['BODY', 'TEXT'],
      ['FLOATS', 'VECTOR(FLOAT, 3)'],
      ['INTS', 'VECTOR(INT, 16)'],
      ['_TIME_EXTRACTED', 'TIMESTAMP_TZ'],
    ]);
  });

  it('reads nothing when no column is a vector', async () => {
    const types = new Map(informationSchema.filter(([, type]) => type !== 'VECTOR'));
    const execute = vi.fn();
    await readSnowflakeVectorTypes({ execute }, '"S"."T"', types, vi.fn(), () => ({}));
    expect(execute).not.toHaveBeenCalled();
  });

  it('stops when the run was cancelled while it read', async () => {
    const types = new Map(informationSchema);
    const execute = vi.fn().mockResolvedValue(result(described));
    const throwIfCancelled = () => {
      throw new Error('cancelled');
    };
    await expect(
      readSnowflakeVectorTypes({ execute }, '"S"."T"', types, throwIfCancelled, () => ({}))
    ).rejects.toThrow('cancelled');
    expect([...types]).toEqual(informationSchema);
  });
});

describe('Snowflake tables with a vector column', () => {
  it.each(['append', 'merge', 'full_refresh'] as const)(
    'loads again into the existing table with %s',
    async (strategy) => {
      const warehouse = new FakeSnowflake();
      await load(warehouse, columns(3), strategy);
      expect(warehouse.started('CREATE TABLE')[0]).toContain('"TEXT_EMBEDDING" VECTOR(FLOAT, 3)');
      expect(warehouse.started('DESCRIBE')).toEqual([]);

      await load(warehouse, columns(3), strategy);

      expect(warehouse.started('DESCRIBE')).toEqual(['DESCRIBE TABLE "TEST_SCHEMA"."CHUNKS"']);
      expect(warehouse.started('ALTER TABLE')).toEqual([]);
      expect(warehouse.started(REPLACE_TABLE)).toEqual([]);
      expect(warehouse.started('COPY INTO')).toHaveLength(1);
      expect(warehouse.started('MERGE INTO')).toHaveLength(strategy === 'merge' ? 1 : 0);
    }
  );

  it.each(['strict', 'freeze'] as const)('loads again under schema_behavior %s', async (mode) => {
    const warehouse = new FakeSnowflake();
    await load(warehouse, columns(3), 'append');
    await load(warehouse, columns(3), 'append', { schemaBehavior: mode });
    expect(warehouse.started('COPY INTO')).toHaveLength(1);
  });

  it('loads again after REPLACE deletes the old rows of a document', async () => {
    const warehouse = new FakeSnowflake();
    await load(warehouse, columns(3), 'append');

    const destination = await warehouse.run();
    await destination.ensureTable('test_schema', 'chunks', columns(3), { loadStrategy: 'append' });
    await destination.deleteRows('test_schema', 'chunks', 'document_id', ['doc-1']);
    await destination.loadAndFinalize(
      'test_schema',
      'chunks',
      '/tmp/rows.jsonl',
      columns(3),
      'append',
      ['id']
    );

    const order = ['DELETE FROM', 'COPY INTO'].map((prefix) =>
      warehouse.statements.findIndex((statement) => statement.startsWith(prefix))
    );
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[1]).toBeGreaterThan(order[0]!);
  });

  it.each([
    ['append', {}],
    ['merge', {}],
    ['full_refresh', { reconcileSchema: true }],
  ] as const)('refuses a changed dimension with %s %o', async (strategy, options) => {
    const warehouse = new FakeSnowflake();
    await load(warehouse, columns(3), 'append');

    await expect(load(warehouse, columns(4), strategy, options)).rejects.toThrow(
      'Schema change conflict on "TEST_SCHEMA"."CHUNKS".text_embedding: ' +
        'existing type VECTOR(FLOAT, 3) does not match expected VECTOR(FLOAT, 4)'
    );
    for (const prefix of ['ALTER TABLE', REPLACE_TABLE, 'TRUNCATE', 'COPY INTO', 'MERGE INTO']) {
      expect(warehouse.started(prefix)).toEqual([]);
    }
  });

  it('names both types when schema_behavior strict refuses a changed dimension', async () => {
    const warehouse = new FakeSnowflake();
    await load(warehouse, columns(3), 'append');
    await expect(
      load(warehouse, columns(4), 'append', { schemaBehavior: 'strict' })
    ).rejects.toThrow('type conflict on text_embedding: VECTOR(FLOAT, 3) vs VECTOR(FLOAT, 4)');
  });

  it('replaces the table in a full refresh only when the dimension changed', async () => {
    const warehouse = new FakeSnowflake();
    await load(warehouse, columns(3), 'full_refresh');
    await load(warehouse, columns(4), 'full_refresh');
    expect(warehouse.started(REPLACE_TABLE)[0]).toContain('"TEXT_EMBEDDING" VECTOR(FLOAT, 4)');

    await load(warehouse, columns(4), 'full_refresh');
    expect(warehouse.started(REPLACE_TABLE)).toEqual([]);
    expect(warehouse.started('TRUNCATE TABLE')).toHaveLength(1);
  });

  it.each([
    ['VECTOR(INT, 3)', 'VECTOR(INT, 3)'],
    ['VARCHAR', 'TEXT'],
  ])('refuses a vector for an existing %s column', async (type, named) => {
    const warehouse = new FakeSnowflake();
    warehouse.createTable('CHUNKS', [
      ['ID', 'NUMBER(38,0)'],
      ['DOCUMENT_ID', 'VARCHAR'],
      ['TEXT_EMBEDDING', type],
    ]);
    await expect(load(warehouse, columns(3), 'append')).rejects.toThrow(
      `existing type ${named} does not match expected VECTOR(FLOAT, 3)`
    );
  });

  it('refuses text for an existing vector column', async () => {
    const warehouse = new FakeSnowflake();
    await load(warehouse, columns(3), 'append');
    const text = columns(3).map((column): SchemaColumn =>
      column.type === 'vector' ? { name: column.name, type: 'string' } : column
    );
    await expect(load(warehouse, text, 'append')).rejects.toThrow(
      'existing type VECTOR(FLOAT, 3) does not match expected VARCHAR'
    );
  });

  it('describes the table once when a run sends its schema again', async () => {
    const warehouse = new FakeSnowflake();
    await load(warehouse, columns(3), 'append');

    const destination = await warehouse.run();
    // The first schema does not have the vector column yet, the next ones do.
    for (const schema of [columns(3).slice(0, 2), columns(3), columns(3)]) {
      await destination.ensureTable('test_schema', 'chunks', schema, { loadStrategy: 'append' });
    }
    expect(warehouse.started('DESCRIBE')).toHaveLength(1);
    await expect(
      destination.ensureTable('test_schema', 'chunks', columns(4), { loadStrategy: 'append' })
    ).rejects.toThrow('existing type VECTOR(FLOAT, 3) does not match expected VECTOR(FLOAT, 4)');
  });

  it('describes a reserved table under its exact name', async () => {
    const warehouse = new FakeSnowflake();
    const options = { tableOwnershipMarker: 'marker-a' };
    await load(warehouse, columns(3), 'append', options, 'stage_Mixed');
    await load(warehouse, columns(3), 'append', options, 'stage_Mixed');
    expect(warehouse.started('DESCRIBE')).toEqual(['DESCRIBE TABLE "TEST_SCHEMA"."stage_Mixed"']);
    expect(warehouse.started('COPY INTO')).toHaveLength(1);
  });

  it('reads no extra metadata for a table without vector columns', async () => {
    const warehouse = new FakeSnowflake();
    const plain = columns(3).slice(0, 2);
    await load(warehouse, plain, 'append');

    const destination = await warehouse.run();
    await destination.ensureTable('test_schema', 'chunks', plain, { loadStrategy: 'append' });

    expect(
      warehouse.statements.map((statement) => statement.replace(/ (?:FROM|WHERE) .*/, ''))
    ).toEqual(['SELECT SCHEMA_NAME', 'SELECT COLUMN_NAME, DATA_TYPE', 'SELECT CLUSTERING_KEY']);
  });
});
