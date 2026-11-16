import { DuckDBInstance } from '@duckdb/node-api';
import { isDuckDbAvailable } from '@bobsled-inc/connections';
import { describe, expect, it, vi } from 'vitest';

import { init as initDuckDbPublication } from '../../../src/agentic/duckdb-publication-storage.js';
import { adoptLegacyWarehouseTables } from '../../../src/agentic/legacy-tables.js';
import { renameLegacyMetadataColumns } from '../../../src/agentic/metadata-columns.js';
import {
  AGENTIC_METADATA_NAMES,
  agenticMetadataSpellings,
  canonicalAgenticNames,
  currentAgenticNames,
  usesReservedAgenticPrefix,
} from '../../../src/agentic/metadata-names.js';
import { AGENTIC_METADATA_COLUMNS } from '../../../src/agentic/model.js';
import { duckDbRowDialect } from '../../../src/agentic/row-state-dialect.js';
import {
  AGENTIC_ROWS_TABLE,
  AGENTIC_RUNS_TABLE,
  AGENTIC_TABLE_PREFIX,
  prepareAgenticRowTables,
} from '../../../src/agentic/row-state-tables.js';
import { createAgenticRowSchema } from '../../../src/agentic/rows.js';
import { agenticDefinitionIdentity } from '../../../src/agentic/state.js';

// Generic takeover tests: earlier table names are stand-ins, so they pass before and after the
// Bobsled Core -> Bobsled rename flips the current names. Metadata spellings use the real list.
vi.mock('../../../src/agentic/legacy-names.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  LEGACY_AGENTIC_TABLE_PREFIXES: ['__legacy_agentic_'],
  LEGACY_DUCKDB_PUBLICATION_SCHEMAS: ['_legacy_agentic_publication'],
}));

const other = (name: string) => {
  const role = (
    Object.keys(AGENTIC_METADATA_NAMES) as (keyof typeof AGENTIC_METADATA_NAMES)[]
  ).find((key) => AGENTIC_METADATA_NAMES[key] === name)!;
  return agenticMetadataSpellings(role).find((spelling) => spelling !== name)!;
};

describe('agentic metadata names across generations', () => {
  const definition = (names: (name: string) => string) => ({
    target: 'main.pairs',
    resolved: {
      output_columns: [
        { name: 'pair_id', type: 'string', nullable: false },
        ...AGENTIC_METADATA_COLUMNS.map((column) => ({ ...column, name: names(column.name) })),
      ],
    },
    instructions: 'Explain the reason briefly',
  });

  it('gives a definition the same identity whichever generation spelled its metadata', () => {
    expect(agenticDefinitionIdentity(definition(other))).toBe(
      agenticDefinitionIdentity(definition((name) => name))
    );
    expect(agenticDefinitionIdentity({ ...definition((name) => name), target: 'main.x' })).not.toBe(
      agenticDefinitionIdentity(definition((name) => name))
    );
  });

  it('maps keys and exact values only, never text that merely contains a name', () => {
    const row = {
      [other(AGENTIC_METADATA_NAMES.run_id)]: 'r',
      note: `x ${AGENTIC_METADATA_NAMES.reason}`,
    };
    expect(currentAgenticNames(row)).toEqual({
      [AGENTIC_METADATA_NAMES.run_id]: 'r',
      note: `x ${AGENTIC_METADATA_NAMES.reason}`,
    });
    expect(canonicalAgenticNames(currentAgenticNames(row))).toEqual(canonicalAgenticNames(row));
  });

  it('validates rows in either spelling and returns them in the schema spelling', () => {
    const columns = [
      { name: 'pair_id', type: 'string' as const, nullable: false },
      ...AGENTIC_METADATA_COLUMNS,
    ];
    const value = {
      pair_id: 'p1',
      [other(AGENTIC_METADATA_NAMES.run_id)]: 'run',
      [other(AGENTIC_METADATA_NAMES.evidence)]: null,
      [AGENTIC_METADATA_NAMES.confidence]: 0.5,
      [other(AGENTIC_METADATA_NAMES.reason)]: null,
    };
    expect(createAgenticRowSchema(columns).parse(value)).toEqual(currentAgenticNames(value));
    const earlier = columns.map((column) =>
      AGENTIC_METADATA_COLUMNS.includes(column) ? { ...column, name: other(column.name) } : column
    );
    const respelled = Object.fromEntries(
      Object.entries(currentAgenticNames(value)).map(([key, item]) => [
        AGENTIC_METADATA_COLUMNS.some((column) => column.name === key) ? other(key) : key,
        item,
      ])
    );
    expect(createAgenticRowSchema(earlier).parse(currentAgenticNames(value))).toEqual(respelled);
  });

  it('reserves both generations and the Track prefix for Core columns', () => {
    for (const prefix of ['_bobsled_', '_bobsled_', '_track_', '_BOBSLED_']) {
      expect(usesReservedAgenticPrefix(`${prefix}x`)).toBe(true);
    }
    expect(usesReservedAgenticPrefix('_source_bobsled_api')).toBe(false);
  });

  it('renames earlier metadata columns of a target in place, position by position', async () => {
    const renames: [string, string][] = [];
    const expected = [{ name: 'pair_id' }, ...AGENTIC_METADATA_COLUMNS];
    const columns = expected.map((column, index) => ({
      column_name: index === 0 ? 'PAIR_ID' : other(column.name).toUpperCase(),
    }));
    await renameLegacyMetadataColumns(
      columns,
      expected,
      (name) => name.toUpperCase(),
      async (from, to) => void renames.push([from, to]),
      't'
    );
    expect(renames).toEqual(
      AGENTIC_METADATA_COLUMNS.map((column) => [
        other(column.name).toUpperCase(),
        column.name.toUpperCase(),
      ])
    );
    expect(columns.map((column) => column.column_name)).toEqual(
      expected.map((c) => c.name.toUpperCase())
    );
    await expect(
      renameLegacyMetadataColumns(
        [{ column_name: other(AGENTIC_METADATA_NAMES.run_id) }],
        [{ name: AGENTIC_METADATA_NAMES.run_id }],
        (name) => name,
        () => Promise.reject(new Error('not allowed')),
        't'
      )
    ).rejects.toThrow(/renaming it to .* failed/);
  });
});

async function duckdb() {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const toValues = (params?: readonly unknown[]) =>
    params?.map((value) => (typeof value === 'number' ? BigInt(value) : value)) as never;
  return {
    run: async (sql: string, params?: readonly unknown[]) => {
      await connection.run(sql, toValues(params));
    },
    query: async (sql: string, params?: readonly unknown[]) =>
      (await connection.runAndReadAll(sql, toValues(params))).getRowObjectsJson() as Record<
        string,
        unknown
      >[],
  };
}

describe.skipIf(!(await isDuckDbAvailable()))('agentic table takeover on DuckDB', () => {
  const legacy = (name: string) => `__legacy_agentic_${name.slice(AGENTIC_TABLE_PREFIX.length)}`;

  it('renames an earlier row store in place so saved runs resume', async () => {
    const db = await duckdb();
    await db.run('CREATE SCHEMA s');
    await prepareAgenticRowTables(db as never, duckDbRowDialect, '"s"');
    await db.run(
      `INSERT INTO "s"."${AGENTIC_RUNS_TABLE}" (run_hash, scope, model, run_id, layout, revision, lease_owner, lease_expires, token, head, summary, retain_until, reclaimable) VALUES ('h', 's', 'm', 'r', 1, 0, '', 0, '', '', '', 0, true)`
    );
    for (const name of [AGENTIC_RUNS_TABLE, AGENTIC_ROWS_TABLE, `${AGENTIC_TABLE_PREFIX}cursors`]) {
      await db.run(`ALTER TABLE "s"."${name}" RENAME TO "${legacy(name)}"`);
    }
    await prepareAgenticRowTables(db as never, duckDbRowDialect, '"s"');
    const tables = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 's' ORDER BY 1"
    );
    expect(tables.map((row) => row['table_name'])).toEqual(
      [AGENTIC_RUNS_TABLE, AGENTIC_ROWS_TABLE, `${AGENTIC_TABLE_PREFIX}cursors`].sort()
    );
    expect(await db.query(`SELECT run_id FROM "s"."${AGENTIC_RUNS_TABLE}"`)).toEqual([
      { run_id: 'r' },
    ]);
  });

  it('keeps the current table and never drops the earlier one when both exist', async () => {
    const db = await duckdb();
    await db.run('CREATE SCHEMA s');
    await prepareAgenticRowTables(db as never, duckDbRowDialect, '"s"');
    await db.run(`DROP TABLE "s"."${AGENTIC_ROWS_TABLE}"`);
    await db.run(`CREATE TABLE "s"."${legacy(AGENTIC_RUNS_TABLE)}" (x INTEGER)`);
    await prepareAgenticRowTables(db as never, duckDbRowDialect, '"s"');
    const tables = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 's' ORDER BY 1"
    );
    expect(tables.map((row) => row['table_name'])).toContain(legacy(AGENTIC_RUNS_TABLE));
    expect(tables.map((row) => row['table_name'])).toContain(AGENTIC_ROWS_TABLE);
  });

  it('adopts an earlier warehouse table once, and fails rather than shadow saved state', async () => {
    const db = await duckdb();
    const sql = { run: db.run, query: db.query, p: (index: number) => `$${index}` };
    await db.run('CREATE SCHEMA w');
    await db.run('CREATE TABLE w.__old_cursors (key VARCHAR, record VARCHAR)');
    await db.run("INSERT INTO w.__old_cursors VALUES ('k', 'v')");
    const pairs = [['__new_cursors', ['__old_cursors']]] as const;
    expect(
      await adoptLegacyWarehouseTables(sql as never, 'postgres', { schema: 'w' }, pairs)
    ).toEqual(['__old_cursors']);
    expect(await db.query('SELECT record FROM w.__new_cursors')).toEqual([{ record: 'v' }]);
    expect(
      await adoptLegacyWarehouseTables(sql as never, 'postgres', { schema: 'w' }, pairs)
    ).toEqual([]);
  });

  it('copies an earlier DuckDB publication schema once, keeping revisions and receipts', async () => {
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
    await initDuckDbPublication(db as never);
    await initDuckDbPublication(db as never);
    const schema = (
      await db.query(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE '%agentic_publication' AND schema_name <> '_legacy_agentic_publication'"
      )
    )[0]!['schema_name'];
    expect(await db.query(`SELECT target, revision FROM "${schema}".targets`)).toEqual([
      { target: 't', revision: '3' },
    ]);
    expect(await db.query(`SELECT operation_id FROM "${schema}".receipts`)).toEqual([
      { operation_id: 'op' },
    ]);
  });
});
