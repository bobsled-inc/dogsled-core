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
  const context = { retryOpts: () => ({}), throwIfCancelled: vi.fn() };
  const floats: SchemaColumn = { name: 'floats', type: 'vector', dimension: 3 };
  const body: SchemaColumn = { name: 'body', type: 'string' };
  const added: SchemaColumn = { name: 'added', type: 'vector', dimension: 3 };

  it('fills in the element type and length of plain VECTOR columns only', async () => {
    const types = new Map(informationSchema);
    const execute = vi.fn().mockResolvedValue(result(described));
    await readSnowflakeVectorTypes(context, { execute }, '"S"."T"', [floats], undefined, types);
    expect(execute.mock.calls).toEqual([[{ sqlText: 'DESCRIBE TABLE "S"."T"' }]]);
    expect([...types]).toEqual([
      ['ID', 'NUMBER'],
      ['BODY', 'TEXT'],
      ['FLOATS', 'VECTOR(FLOAT, 3)'],
      ['INTS', 'VECTOR(INT, 16)'],
      ['_TIME_EXTRACTED', 'TIMESTAMP_TZ'],
    ]);
  });

  it.each<[string, SchemaColumn[], EnsureTableOptions | undefined]>([
    ['declares no vector', [body], undefined],
    ['declares a vector the table does not have', [body, added], undefined],
    ['declares the column as text', [{ name: 'floats', type: 'string' }], undefined],
    ['has schema_behavior freeze', [floats], { schemaBehavior: 'freeze' }],
  ])('reads nothing when the stream %s', async (_case, columns, options) => {
    const types = new Map(informationSchema);
    const execute = vi.fn();
    await readSnowflakeVectorTypes(context, { execute }, '"S"."T"', columns, options, types);
    expect(execute).not.toHaveBeenCalled();
    expect([...types]).toEqual(informationSchema);
  });

  it('reads the types when reconciliation overrides freeze', async () => {
    const execute = vi.fn().mockResolvedValue(result(described));
    const options: EnsureTableOptions = { schemaBehavior: 'freeze', reconcileSchema: true };
    const types = new Map(informationSchema);
    await readSnowflakeVectorTypes(context, { execute }, '"S"."T"', [floats], options, types);
    expect(types.get('FLOATS')).toBe('VECTOR(FLOAT, 3)');
  });

  it('stops when the run was cancelled while it read', async () => {
    const types = new Map(informationSchema);
    const execute = vi.fn().mockResolvedValue(result(described));
    const cancelled = {
      ...context,
      throwIfCancelled: () => {
        throw new Error('cancelled');
      },
    };
    await expect(
      readSnowflakeVectorTypes(cancelled, { execute }, '"S"."T"', [floats], undefined, types)
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
    expect(warehouse.started('DESCRIBE')).toHaveLength(mode === 'freeze' ? 0 : 1);
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

  it.each(['append', 'merge'] as const)('refuses a changed dimension with %s', async (strategy) => {
    const warehouse = new FakeSnowflake();
    await load(warehouse, columns(3), 'append');

    await expect(load(warehouse, columns(4), strategy)).rejects.toThrow(
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

  describe('full refresh', () => {
    it('truncates and reloads the table instead of replacing it', async () => {
      const warehouse = new FakeSnowflake();
      await load(warehouse, columns(3), 'full_refresh');
      await load(warehouse, columns(3), 'full_refresh');
      expect(warehouse.started(REPLACE_TABLE)).toEqual([]);
      expect(warehouse.started('TRUNCATE TABLE')).toHaveLength(1);
      expect(warehouse.started('COPY INTO')).toHaveLength(1);
    });

    it('leaves the table alone until the first rows arrive', async () => {
      const warehouse = new FakeSnowflake();
      await load(warehouse, columns(3), 'full_refresh');
      const destination = await warehouse.run();
      await destination.ensureTable('test_schema', 'chunks', columns(3), {
        loadStrategy: 'full_refresh',
      });
      for (const prefix of [REPLACE_TABLE, 'TRUNCATE', 'DELETE', 'DROP']) {
        expect(warehouse.started(prefix)).toEqual([]);
      }
    });

    it('replaces the table for a changed dimension by default', async () => {
      const warehouse = new FakeSnowflake();
      await load(warehouse, columns(3), 'full_refresh');
      await load(warehouse, columns(4), 'full_refresh');
      expect(warehouse.started(REPLACE_TABLE)).toHaveLength(1);
      expect(warehouse.started(REPLACE_TABLE)[0]).toContain('"TEXT_EMBEDDING" VECTOR(FLOAT, 4)');
    });

    it.each<[string, EnsureTableOptions, string]>([
      ['strict', { schemaBehavior: 'strict' }, 'VECTOR(FLOAT, 3) vs VECTOR(FLOAT, 4)'],
      [
        'reconciliation',
        { reconcileSchema: true },
        'existing type VECTOR(FLOAT, 3) does not match expected VECTOR(FLOAT, 4)',
      ],
    ])('refuses a changed dimension with %s', async (_mode, options, message) => {
      const warehouse = new FakeSnowflake();
      await load(warehouse, columns(3), 'full_refresh');
      await expect(load(warehouse, columns(4), 'full_refresh', options)).rejects.toThrow(message);
      for (const prefix of [REPLACE_TABLE, 'ALTER TABLE', 'TRUNCATE', 'COPY INTO']) {
        expect(warehouse.started(prefix)).toEqual([]);
      }
    });
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
      'existing type VECTOR does not match expected VARCHAR'
    );
  });

  it('does not describe the table for a stream without vector columns', async () => {
    const warehouse = new FakeSnowflake();
    await load(warehouse, columns(3), 'append');
    await load(warehouse, columns(3).slice(0, 2), 'append');
    expect(warehouse.started('DESCRIBE')).toEqual([]);
    expect(warehouse.started('COPY INTO')).toHaveLength(1);
  });

  it('compares an existing vector column that a later schema of the run declares', async () => {
    const warehouse = new FakeSnowflake();
    await load(warehouse, columns(3), 'append');

    const destination = await warehouse.run();
    const ensure = (schema: SchemaColumn[]) =>
      destination.ensureTable('test_schema', 'chunks', schema, { loadStrategy: 'append' });
    await ensure(columns(3).slice(0, 2));
    expect(warehouse.started('DESCRIBE')).toEqual([]);
    await ensure(columns(3));
    await ensure(columns(3));
    expect(warehouse.started('DESCRIBE')).toHaveLength(1);
    await expect(ensure(columns(4))).rejects.toThrow(
      'existing type VECTOR(FLOAT, 3) does not match expected VECTOR(FLOAT, 4)'
    );
  });

  it('compares a vector column that a later schema of the run adds', async () => {
    const warehouse = new FakeSnowflake();
    await load(warehouse, columns(3).slice(0, 2), 'append');

    const destination = await warehouse.run();
    const ensure = (schema: SchemaColumn[]) =>
      destination.ensureTable('test_schema', 'chunks', schema, { loadStrategy: 'append' });
    await ensure(columns(3).slice(0, 2));
    await ensure(columns(3));
    expect(warehouse.started('ALTER TABLE')[0]).toContain(
      'ADD COLUMN "TEXT_EMBEDDING" VECTOR(FLOAT, 3)'
    );
    await ensure(columns(3));
    expect(warehouse.started('DESCRIBE')).toEqual([]);
    await expect(ensure(columns(4))).rejects.toThrow(
      'existing type VECTOR(FLOAT, 3) does not match expected VECTOR(FLOAT, 4)'
    );
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
