import { DuckDBInstance } from '@duckdb/node-api';
import { isDuckDbAvailable } from '@bobsled-inc/connections';
import { describe, expect, it, vi } from 'vitest';

import { caseName } from '../../../src/compiler/dialect.js';
import { init as initDuckDbPublication } from '../../../src/agentic/duckdb-publication-storage.js';
import {
  AGENTIC_METADATA_NAMES,
  agenticMetadataSpellings,
  canonicalAgenticDefinition,
  canonicalAgenticNames,
  currentAgenticNames,
} from '../../../src/agentic/metadata-names.js';
import { duckDbRowDialect } from '../../../src/agentic/row-state-dialect.js';
import {
  AGENTIC_ROWS_TABLE,
  AGENTIC_TABLE_PREFIX,
  prepareAgenticRowTables,
} from '../../../src/agentic/row-state-tables.js';
import { snowflakeRowDialect } from '../../../src/agentic/warehouse-row-dialects.js';

// Generic takeover failure tests: earlier names are stand-ins, so they pass before and after the
// Dogsled -> Bobsled rename flips the current names.
vi.mock('../../../src/agentic/legacy-names.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  LEGACY_AGENTIC_TABLE_PREFIXES: ['__legacy_agentic_'],
  LEGACY_DUCKDB_PUBLICATION_SCHEMAS: ['_legacy_agentic_publication'],
}));

const earlier = (name: string) => `__legacy_agentic_${name.slice(AGENTIC_TABLE_PREFIX.length)}`;
const refused = () => Object.assign(new Error('Insufficient privileges to operate on table'));

/**
 * A Snowflake catalog in memory: renames, creates and the two catalog views the row store reads.
 * Names fold to upper case, as Snowflake folds the store's unquoted-looking names.
 */
function fakeSnowflake(refuse: (from: string) => boolean = () => false) {
  const types: Record<string, string> = { VARCHAR: 'TEXT', BIGINT: 'NUMBER', BOOLEAN: 'BOOLEAN' };
  const tables = new Map<string, { name: string; type: string }[]>();
  const created: string[] = [];
  const ids = (sql: string) => [...sql.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => match[1]!);
  const db = {
    tables,
    created,
    async run(sql: string) {
      if (sql.startsWith('CREATE SCHEMA')) return;
      if (sql.includes(' RENAME TO ')) {
        const [, from, , to] = ids(sql);
        if (!tables.has(from!)) return;
        if (refuse(from!)) throw refused();
        if (tables.has(to!)) throw new Error(`Object '${to}' already exists.`);
        tables.set(to!, tables.get(from!)!);
        tables.delete(from!);
        return;
      }
      if (sql.startsWith('CREATE TABLE IF NOT EXISTS')) {
        const [, name] = ids(sql);
        if (tables.has(name!)) return;
        tables.set(
          name!,
          / AS SELECT /.test(sql)
            ? [{ name: 'TOKEN', type: 'TEXT' }]
            : [...sql.matchAll(/"([^"]+)" (VARCHAR|BIGINT|BOOLEAN) NOT NULL/g)].map((match) => ({
                name: match[1]!,
                type: types[match[2]!]!,
              }))
        );
        created.push(name!);
        return;
      }
      if (sql.startsWith('INSERT INTO') || sql.startsWith('UPDATE')) return;
      throw new Error(`unexpected statement: ${sql}`);
    },
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('information_schema.columns')) {
        const [, ...names] = params as string[];
        return names.flatMap((table) =>
          (tables.get(table) ?? []).map((column) => ({
            table_name: table,
            column_name: column.name,
            data_type: column.type,
            numeric_scale: column.type === 'NUMBER' ? 0 : null,
            is_nullable: 'NO',
            column_default: null,
            is_identity: 'NO',
          }))
        );
      }
      if (sql.includes('information_schema.tables')) {
        return tables.has(String(params[1])) ? [{ found: 1 }] : [];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return db;
}

/** An earlier generation's Snowflake row store: every table, header set and the guard. */
async function earlierSnowflakeStore(refuse?: (from: string) => boolean) {
  const setup = fakeSnowflake();
  await prepareAgenticRowTables(setup as never, snowflakeRowDialect, '"S"');
  const prefix = caseName(AGENTIC_TABLE_PREFIX, 'snowflake');
  const db = fakeSnowflake(refuse);
  for (const [name, columns] of setup.tables) {
    db.tables.set(name.replace(prefix, '__LEGACY_AGENTIC_'), columns);
  }
  return db;
}

describe('a row-store rename that fails on Snowflake', () => {
  const rows = caseName(earlier(AGENTIC_ROWS_TABLE), 'snowflake');
  const guard = '__LEGACY_AGENTIC_GUARD';

  it.each([
    ['the rows table', rows],
    ['the guard', guard],
  ])(
    'stops setup when %s cannot be renamed, creates nothing, and retries next run',
    async (_, table) => {
      let refuse = true;
      const db = await earlierSnowflakeStore((from) => refuse && from === table);
      await expect(
        prepareAgenticRowTables(db as never, snowflakeRowDialect, '"S"')
      ).rejects.toThrow(/Insufficient privileges/);
      expect(db.created).toEqual([]);
      expect(db.tables.has(table)).toBe(true);

      refuse = false;
      await prepareAgenticRowTables(db as never, snowflakeRowDialect, '"S"');
      expect(db.created).toEqual([]);
      expect([...db.tables.keys()].filter((name) => name.startsWith('__LEGACY_'))).toEqual([]);
    }
  );

  it('keeps the current table, and the earlier one, when both exist', async () => {
    const db = await earlierSnowflakeStore();
    const current = caseName(AGENTIC_ROWS_TABLE, 'snowflake');
    db.tables.set(current, db.tables.get(rows)!);
    await prepareAgenticRowTables(db as never, snowflakeRowDialect, '"S"');
    expect(db.tables.has(rows)).toBe(true);
    expect(db.tables.has(current)).toBe(true);
    expect(db.created).toEqual([]);
  });
});

async function duckdb() {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  return {
    run: async (sql: string, params?: readonly unknown[]) => {
      await connection.run(sql, params as never);
    },
    query: async (sql: string, params?: readonly unknown[]) =>
      (await connection.runAndReadAll(sql, params as never)).getRowObjectsJson() as Record<
        string,
        unknown
      >[],
  };
}

describe.skipIf(!(await isDuckDbAvailable()))('takeover failures on DuckDB', () => {
  const tableNames = async (db: Awaited<ReturnType<typeof duckdb>>) =>
    (
      await db.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 's' ORDER BY 1"
      )
    ).map((row) => String(row['table_name']));

  it('stops setup when a row-store rename fails, creates nothing, and retries next run', async () => {
    const db = await duckdb();
    await db.run('CREATE SCHEMA s');
    await prepareAgenticRowTables(db as never, duckDbRowDialect, '"s"');
    for (const name of await tableNames(db)) {
      await db.run(`ALTER TABLE "s"."${name}" RENAME TO "${earlier(name)}"`);
    }
    const before = await tableNames(db);
    let refuse = true;
    const flaky = {
      ...db,
      run: async (sql: string, params?: readonly unknown[]) => {
        if (refuse && sql.includes(' RENAME TO ') && sql.includes(earlier(AGENTIC_ROWS_TABLE))) {
          throw new Error('permission denied');
        }
        return db.run(sql, params);
      },
    };
    await expect(prepareAgenticRowTables(flaky as never, duckDbRowDialect, '"s"')).rejects.toThrow(
      /permission denied/
    );
    const after = await tableNames(db);
    expect(after).not.toContain(AGENTIC_ROWS_TABLE);
    expect(after).toContain(earlier(AGENTIC_ROWS_TABLE));

    refuse = false;
    await prepareAgenticRowTables(flaky as never, duckDbRowDialect, '"s"');
    expect(await tableNames(db)).toEqual(
      before
        .map((name) => `${AGENTIC_TABLE_PREFIX}${name.slice('__legacy_agentic_'.length)}`)
        .sort()
    );
  });

  const earlierPublication = async () => {
    const db = await duckdb();
    await db.run('CREATE SCHEMA _legacy_agentic_publication');
    await db.run(
      'CREATE TABLE _legacy_agentic_publication.targets (target VARCHAR PRIMARY KEY, revision BIGINT NOT NULL, fence VARCHAR NOT NULL)'
    );
    await db.run(
      'CREATE TABLE _legacy_agentic_publication.receipts (operation_id VARCHAR PRIMARY KEY, receipt VARCHAR NOT NULL)'
    );
    await db.run("INSERT INTO _legacy_agentic_publication.targets VALUES ('t', 3, 'f')");
    await db.run("INSERT INTO _legacy_agentic_publication.receipts VALUES ('op', '{}')");
    return db;
  };
  const currentSchema = async (db: Awaited<ReturnType<typeof duckdb>>) =>
    String(
      (
        await db.query(
          "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE '%agentic_publication' AND schema_name <> '_legacy_agentic_publication'"
        )
      )[0]!['schema_name']
    );

  it('copies nothing when a crash stops the publication copy part way, and all of it next run', async () => {
    const db = await earlierPublication();
    const crashing = {
      ...db,
      run: async (sql: string, params?: readonly unknown[]) => {
        if (sql.startsWith('INSERT INTO') && sql.includes('receipts')) throw new Error('crash');
        return db.run(sql, params);
      },
    };
    await expect(initDuckDbPublication(crashing as never)).rejects.toThrow(/crash/);
    const schema = await currentSchema(db);
    expect(await db.query(`SELECT count(*) AS n FROM "${schema}".targets`)).toEqual([{ n: '0' }]);

    await initDuckDbPublication(db as never);
    expect(await db.query(`SELECT target, revision FROM "${schema}".targets`)).toEqual([
      { target: 't', revision: '3' },
    ]);
    expect(await db.query(`SELECT operation_id FROM "${schema}".receipts`)).toEqual([
      { operation_id: 'op' },
    ]);
  });

  it('never copies into current publication tables that already hold state', async () => {
    const db = await earlierPublication();
    await initDuckDbPublication({
      ...db,
      run: async (sql: string, params?: readonly unknown[]) =>
        sql.startsWith('INSERT INTO') ? undefined : db.run(sql, params),
    } as never);
    const schema = await currentSchema(db);
    await db.run(`INSERT INTO "${schema}".targets VALUES ('t', 7, 'g')`);
    await initDuckDbPublication(db as never);
    expect(await db.query(`SELECT target, revision FROM "${schema}".targets`)).toEqual([
      { target: 't', revision: '7' },
    ]);
    expect(await db.query(`SELECT count(*) AS n FROM "${schema}".receipts`)).toEqual([{ n: '0' }]);
  });
});

describe('respelling never touches user data', () => {
  const role = (name: string) =>
    (Object.keys(AGENTIC_METADATA_NAMES) as (keyof typeof AGENTIC_METADATA_NAMES)[]).find(
      (key) => AGENTIC_METADATA_NAMES[key] === name
    )!;
  const otherSpelling = (name: string) =>
    agenticMetadataSpellings(role(name)).find((spelling) => spelling !== name)!;
  const reason = AGENTIC_METADATA_NAMES.reason;

  it('respells only top-level row keys: values and nested keys stay as written', () => {
    const row = {
      [otherSpelling(AGENTIC_METADATA_NAMES.run_id)]: 'r',
      note: otherSpelling(reason),
      nested: { [otherSpelling(reason)]: 1 },
      list: [otherSpelling(reason), { [otherSpelling(reason)]: 2 }],
    };
    const expected = { ...row, [AGENTIC_METADATA_NAMES.run_id]: 'r' };
    delete (expected as Record<string, unknown>)[otherSpelling(AGENTIC_METADATA_NAMES.run_id)];
    expect(currentAgenticNames(row)).toEqual(expected);
    expect(canonicalAgenticNames([row])[0]!.nested).toEqual(row.nested);
  });

  it('respells only column name fields of a definition', () => {
    const definition = {
      description: otherSpelling(reason),
      columns: [{ name: otherSpelling(reason), description: otherSpelling(reason) }],
    };
    const canonical = canonicalAgenticDefinition(definition);
    expect(canonical.description).toBe(definition.description);
    expect(canonical.columns[0]!.description).toBe(definition.columns[0]!.description);
    expect(canonical.columns[0]!.name).toBe(agenticMetadataSpellings(role(reason))[0]);
  });
});
