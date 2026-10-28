import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { compileResolutionCluster } from '../../../../src/compiler/identity/codegen.js';
import type { ResolvedResolutionSpec } from '../../../../src/compiler/identity/types.js';

interface DuckDbReader {
  getRowObjectsJS(): Record<string, unknown>[];
}

interface DuckDbConnection {
  run(sql: string): Promise<unknown>;
  runAndReadAll(sql: string): Promise<DuckDbReader>;
  disconnectSync(): void;
}

interface DuckDbInstance {
  connect(): Promise<DuckDbConnection>;
  closeSync(): void;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const requireFromTrack = createRequire(join(repoRoot, 'packages/dogsled/package.json'));
const { DuckDBInstance } = requireFromTrack('@duckdb/node-api') as {
  DuckDBInstance: { create(path: string): Promise<DuckDbInstance> };
};

const SPEC: ResolvedResolutionSpec = {
  name: 'company_resolution',
  entity: 'company',
  description: 'Resolve companies.',
  inputs: [
    {
      ref: 'raw.companies',
      fqTableName: 'raw.companies',
      alias: 's0',
      idFields: ['id'],
    },
  ],
  standardize: [],
  deterministicRules: [],
  thresholds: {
    autoMerge: 0.9,
    review: 0.6,
    autoReject: 0.4,
  },
  entityIdPolicy: {
    strategy: 'stable',
    newId: 'component_id',
    merge: 'oldest_entity_id',
    split: 'preserve_anchor',
  },
  targetSchema: 'entity_graph',
};

let openInstance: DuckDbInstance | undefined;
let openConnection: DuckDbConnection | undefined;

async function createDb(): Promise<DuckDbConnection> {
  openInstance = await DuckDBInstance.create(':memory:');
  openConnection = await openInstance.connect();
  await openConnection.run('CREATE SCHEMA entity_graph');
  await openConnection.run(`
    CREATE TABLE entity_graph.company__review_decisions (
      pair_id VARCHAR,
      decision VARCHAR,
      confidence DOUBLE,
      status VARCHAR,
      decided_at TIMESTAMP,
      applied_at TIMESTAMP
    )
  `);
  await openConnection.run(`
    CREATE TABLE entity_graph.company__clusters (
      cluster_id VARCHAR,
      record_id VARCHAR,
      source_ref VARCHAR,
      source_entity_id VARCHAR,
      source_system VARCHAR,
      confidence_score DOUBLE,
      clustered_at TIMESTAMP
    )
  `);
  return openConnection;
}

afterEach(() => {
  openConnection?.disconnectSync();
  openConnection = undefined;
  openInstance?.closeSync();
  openInstance = undefined;
});

async function query(
  connection: DuckDbConnection,
  sql: string
): Promise<Record<string, unknown>[]> {
  const reader = await connection.runAndReadAll(sql);
  return reader.getRowObjectsJS();
}

async function loadInputs(
  connection: DuckDbConnection,
  recordIds: string[],
  pairs: Array<readonly [string, string]>
): Promise<void> {
  const recordRows = recordIds
    .map(
      (recordId) =>
        `('${recordId}', 'raw.companies', '{"id":"${recordId}"}', '${recordId}', 'crm', CURRENT_TIMESTAMP)`
    )
    .join(',\n');
  const pairRows = pairs
    .map(
      ([left, right]) =>
        `('${left}|${right}', '${left}', '${right}', 'raw.companies', 'raw.companies', 1.0)`
    )
    .join(',\n');

  await connection.run(`
    CREATE OR REPLACE TABLE entity_graph.company__standardized AS
    SELECT *
    FROM (VALUES ${recordRows}) AS t(
      record_id,
      source_ref,
      source_pk_json,
      _source_entity_id,
      _source_system,
      _standardized_at
    )
  `);

  if (pairs.length === 0) {
    await connection.run(`
      CREATE OR REPLACE TABLE entity_graph.company__pair_scores AS
      SELECT
        CAST(NULL AS VARCHAR) AS pair_id,
        CAST(NULL AS VARCHAR) AS record_a_id,
        CAST(NULL AS VARCHAR) AS record_b_id,
        CAST(NULL AS VARCHAR) AS source_a,
        CAST(NULL AS VARCHAR) AS source_b,
        CAST(NULL AS DOUBLE) AS composite_score
      WHERE 1 = 0
    `);
    return;
  }

  await connection.run(`
    CREATE OR REPLACE TABLE entity_graph.company__pair_scores AS
    SELECT *
    FROM (VALUES ${pairRows}) AS t(
      pair_id,
      record_a_id,
      record_b_id,
      source_a,
      source_b,
      composite_score
    )
  `);
}

async function runCluster(connection: DuckDbConnection): Promise<void> {
  const compiled = compileResolutionCluster(SPEC, 'duckdb', 'entity_graph');
  for (const statement of compiled.statements) {
    await connection.run(statement.sql);
  }
}

async function eventCount(connection: DuckDbConnection): Promise<number> {
  const [row] = await query(
    connection,
    'SELECT COUNT(*) AS event_count FROM entity_graph.company__entity_id_events'
  );
  return Number(row?.event_count ?? 0);
}

describe('stable entity ID execution on DuckDB', () => {
  it('keeps serving IDs stable across reruns, lower IDs, merges, splits, reactivation, and missing records', async () => {
    const connection = await createDb();

    await loadInputs(connection, ['a', 'b', 'z'], [['a', 'b']]);
    await runCluster(connection);

    expect(
      await query(
        connection,
        'SELECT record_id, entity_id, cluster_id, component_id FROM entity_graph.company__clusters ORDER BY record_id'
      )
    ).toEqual([
      { record_id: 'a', entity_id: 'a', cluster_id: 'a', component_id: 'a' },
      { record_id: 'b', entity_id: 'a', cluster_id: 'a', component_id: 'a' },
      { record_id: 'z', entity_id: 'z', cluster_id: 'z', component_id: 'z' },
    ]);
    const firstEventCount = await eventCount(connection);

    await runCluster(connection);
    expect(await eventCount(connection)).toBe(firstEventCount);

    await loadInputs(
      connection,
      ['0', 'a', 'b', 'z'],
      [
        ['a', 'b'],
        ['0', 'b'],
      ]
    );
    await runCluster(connection);
    expect(
      await query(
        connection,
        "SELECT entity_id, cluster_id, component_id FROM entity_graph.company__clusters WHERE record_id = '0'"
      )
    ).toEqual([{ entity_id: 'a', cluster_id: 'a', component_id: '0' }]);

    await loadInputs(
      connection,
      ['0', 'a', 'b', 'z'],
      [
        ['a', 'b'],
        ['0', 'b'],
        ['b', 'z'],
      ]
    );
    await runCluster(connection);
    expect(
      await query(
        connection,
        'SELECT entity_id, alias_entity_id FROM entity_graph.company__entity_id_aliases WHERE superseded_at IS NULL'
      )
    ).toEqual([{ entity_id: 'a', alias_entity_id: 'z' }]);
    const mergedEventCount = await eventCount(connection);

    await runCluster(connection);
    expect(await eventCount(connection)).toBe(mergedEventCount);
    expect(
      await query(
        connection,
        "SELECT entity_id, cluster_id, component_id FROM entity_graph.company__clusters WHERE record_id = 'z'"
      )
    ).toEqual([{ entity_id: 'a', cluster_id: 'a', component_id: '0' }]);

    await loadInputs(
      connection,
      ['0', 'a', 'b', 'z'],
      [
        ['a', 'b'],
        ['0', 'b'],
      ]
    );
    await runCluster(connection);
    expect(
      await query(
        connection,
        "SELECT entity_id, cluster_id, component_id FROM entity_graph.company__clusters WHERE record_id = 'z'"
      )
    ).toEqual([{ entity_id: 'z', cluster_id: 'z', component_id: 'z' }]);
    expect(
      await query(
        connection,
        "SELECT assignment_reason FROM entity_graph.company__entity_id_current WHERE record_id = 'z'"
      )
    ).toEqual([{ assignment_reason: 'reactivated' }]);
    expect(
      await query(
        connection,
        "SELECT event_type, entity_id, previous_entity_id, record_id FROM entity_graph.company__entity_id_events WHERE event_type = 'reactivate' AND record_id = 'z'"
      )
    ).toEqual([
      { event_type: 'reactivate', entity_id: 'z', previous_entity_id: 'a', record_id: 'z' },
    ]);
    expect(
      await query(
        connection,
        "SELECT alias_entity_id FROM entity_graph.company__entity_id_aliases WHERE alias_entity_id = 'z' AND superseded_at IS NULL"
      )
    ).toEqual([]);

    await loadInputs(
      connection,
      ['0', 'a', 'b'],
      [
        ['a', 'b'],
        ['0', 'b'],
      ]
    );
    await runCluster(connection);
    expect(
      await query(
        connection,
        "SELECT entity_id FROM entity_graph.company__entity_id_record_map WHERE record_id = 'z'"
      )
    ).toEqual([{ entity_id: 'z' }]);
    expect(
      await query(
        connection,
        "SELECT record_id FROM entity_graph.company__entity_id_current WHERE record_id = 'z'"
      )
    ).toEqual([]);
  });
});
