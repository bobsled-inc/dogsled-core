/**
 * DuckDB end-to-end coverage for incremental review materialization:
 * a human merge takes effect immediately (crosswalks + golden) without a
 * re-cluster, re-applying is a no-op, and a subsequent full resolve+cluster
 * produces the identical golden result (self-healing).
 */

import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { compileResolutionCluster } from '../../src/compiler/identity/codegen.js';
import { generateApplySql } from '../../src/compiler/identity/review-apply.js';
import { generateIncrementalMaterializeSql } from '../../src/compiler/identity/review-materialize.js';
import type {
  ResolvedResolutionSpec,
  ReviewDecisionRow,
} from '../../src/compiler/identity/types.js';

/** One row from an in-memory DuckDB result — column names map to values. */
interface DuckDbRow {
  [column: string]: unknown;
}

/** Full-table dumps keyed by a short table label, for byte-identity checks. */
interface TableDumps {
  [table: string]: DuckDbRow[];
}

interface DuckDbReader {
  getRowObjectsJS(): DuckDbRow[];
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

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const requireFromPackage = createRequire(join(packageRoot, 'package.json'));
const { DuckDBInstance } = requireFromPackage('@duckdb/node-api') as {
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
  // defaultAttributes drops the first standardize entry, so the golden record
  // carries `name` and `domain` (read from standardized_name / _domain).
  standardize: [
    { field: 'id', transforms: [] },
    { field: 'name', transforms: [] },
    { field: 'domain', transforms: [] },
  ],
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

afterEach(() => {
  openConnection?.disconnectSync();
  openConnection = undefined;
  openInstance?.closeSync();
  openInstance = undefined;
});

/** Execute SQL and normalize DuckDB result chunks into plain row objects. */
async function query(connection: DuckDbConnection, sql: string): Promise<DuckDbRow[]> {
  const reader = await connection.runAndReadAll(sql);
  return reader.getRowObjectsJS();
}

interface SeedRecord {
  id: string;
  name: string;
  domain: string | null;
}

async function createDb(records: SeedRecord[], pairs: Array<[string, string, number]>) {
  openInstance = await DuckDBInstance.create(':memory:');
  const connection = await openInstance.connect();
  openConnection = connection;
  await connection.run('CREATE SCHEMA entity_graph');
  await connection.run(`
    CREATE TABLE entity_graph.company__review_decisions (
      pair_id VARCHAR,
      decision VARCHAR,
      reviewer VARCHAR,
      reason VARCHAR,
      decision_batch_id VARCHAR,
      content_hash VARCHAR,
      decision_source VARCHAR,
      decided_at TIMESTAMP,
      applied_at TIMESTAMP,
      confidence DOUBLE,
      proposed_decision VARCHAR,
      proposed_confidence DOUBLE,
      status VARCHAR
    )
  `);
  await connection.run(`
    CREATE TABLE entity_graph.company__not_match_edges (
      pair_id VARCHAR,
      record_a_id VARCHAR,
      record_b_id VARCHAR,
      reviewer VARCHAR,
      reason VARCHAR,
      decision_batch_id VARCHAR,
      decision_source VARCHAR,
      decided_at TIMESTAMP,
      applied_at TIMESTAMP,
      confidence DOUBLE
    )
  `);

  const recordRows = records
    .map(
      (record) =>
        `('${record.id}', 'raw.companies', '{"id":"${record.id}"}', '${record.id}', 'crm', ` +
        `CURRENT_TIMESTAMP, '${record.name}', ${record.domain ? `'${record.domain}'` : 'NULL'})`
    )
    .join(',\n');
  await connection.run(`
    CREATE TABLE entity_graph.company__standardized AS
    SELECT *
    FROM (VALUES ${recordRows}) AS t(
      record_id,
      source_ref,
      source_pk_json,
      _source_entity_id,
      _source_system,
      _standardized_at,
      standardized_name,
      standardized_domain
    )
  `);

  const pairRows = pairs
    .map(
      ([left, right, score]) =>
        `('${left}|${right}', '${left}', '${right}', 'raw.companies', 'raw.companies', ${score})`
    )
    .join(',\n');
  await connection.run(`
    CREATE TABLE entity_graph.company__pair_scores AS
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

  return connection;
}

async function runCluster(connection: DuckDbConnection): Promise<void> {
  const compiled = compileResolutionCluster(SPEC, 'duckdb', 'entity_graph');
  for (const statement of compiled.statements) {
    try {
      await connection.run(statement.sql);
    } catch (error) {
      // Mirror executeSqlStatements: tolerate the errors the statement
      // declares ignorable (e.g. the events backfill before __clusters exists).
      const message = error instanceof Error ? error.message : String(error);
      const ignorable = statement.ignoreErrorPatterns?.some((pattern) =>
        message.toLowerCase().includes(pattern.toLowerCase())
      );
      if (!ignorable) {
        throw error;
      }
    }
  }
}

async function applyDecisions(
  connection: DuckDbConnection,
  decisions: ReviewDecisionRow[],
  batchId: string
): Promise<void> {
  const statements = [
    ...generateApplySql(decisions, 'company', 'duckdb', 'entity_graph', {
      defaultBatchId: batchId,
      defaultContentHash: `hash-${batchId}`,
      defaultDecisionSource: 'human',
    }),
    ...generateIncrementalMaterializeSql({
      spec: SPEC,
      dialect: 'duckdb',
      targetSchema: 'entity_graph',
      // Same actionable filter applyReviewDecisions / the CLI use.
      mergePairIds: decisions
        .filter((d) => d.decision === 'merge' && (d.status === undefined || d.status === 'applied'))
        .map((d) => d.pair_id),
    }),
  ];
  for (const statement of statements) {
    await connection.run(statement.sql);
  }
}

async function crosswalkMap(connection: DuckDbConnection): Promise<Record<string, string>> {
  const rows = await query(
    connection,
    'SELECT record_id, entity_id FROM entity_graph.company__crosswalks ORDER BY record_id'
  );
  return Object.fromEntries(rows.map((row) => [String(row.record_id), String(row.entity_id)]));
}

/** Read golden rows in deterministic order for before/after assertions. */
async function goldenRows(connection: DuckDbConnection): Promise<DuckDbRow[]> {
  const rows = await query(
    connection,
    `SELECT entity_id, name, domain, companies_id, has_companies, cluster_size, trust_score, trust_band
     FROM entity_graph.company__golden ORDER BY entity_id`
  );
  return rows.map((row) => ({ ...row, cluster_size: Number(row.cluster_size) }));
}

/** Capture the materialization tables used to verify retry idempotency. */
async function dumpTables(connection: DuckDbConnection): Promise<TableDumps> {
  return {
    clusters: await query(
      connection,
      'SELECT entity_id, cluster_id, component_id, record_id, confidence_score, clustered_at FROM entity_graph.company__clusters ORDER BY record_id'
    ),
    crosswalks: await query(
      connection,
      'SELECT * FROM entity_graph.company__crosswalks ORDER BY record_id'
    ),
    golden: await query(
      connection,
      'SELECT * FROM entity_graph.company__golden ORDER BY entity_id'
    ),
    golden_record: await query(
      connection,
      'SELECT * FROM entity_graph.company__golden_record ORDER BY entity_id, attribute_name'
    ),
    decisions: await query(
      connection,
      'SELECT pair_id, decision, status, decision_batch_id FROM entity_graph.company__review_decisions ORDER BY pair_id, decided_at'
    ),
    not_match_edges: await query(
      connection,
      'SELECT pair_id, record_a_id, record_b_id FROM entity_graph.company__not_match_edges ORDER BY pair_id'
    ),
  };
}

describe('incremental review materialization on DuckDB', () => {
  it('materializes a human merge immediately, idempotently, and self-heals on the next full run', async () => {
    // a is a singleton; b+z auto-merge at baseline (score 0.95 ≥ 0.9), so the
    // human merge a↔b unions a record into an existing multi-member entity.
    const connection = await createDb(
      [
        { id: 'a', name: 'Acme Corporation', domain: null },
        { id: 'b', name: 'Acme', domain: 'acme.com' },
        { id: 'z', name: 'Acme Inc', domain: 'acme.io' },
      ],
      [
        ['a', 'b', 0.5],
        ['b', 'z', 0.95],
      ]
    );
    await runCluster(connection);

    // Baseline: two entities, review pair a|b unmerged.
    expect(await crosswalkMap(connection)).toEqual({ a: 'a', b: 'b', z: 'b' });
    const baselineComponents = await query(
      connection,
      'SELECT component_id, record_id FROM entity_graph.company__components ORDER BY record_id'
    );

    // Human merge on the review pair, materialized incrementally.
    await applyDecisions(
      connection,
      [{ pair_id: 'a|b', decision: 'merge', status: 'applied', reviewer: 'jane', confidence: 1 }],
      'batch-1'
    );

    // Crosswalks collapsed onto the stable winner ('a' — earliest birth,
    // entity_id ASC tie-break) without a re-cluster: __components untouched.
    expect(await crosswalkMap(connection)).toEqual({ a: 'a', b: 'a', z: 'a' });
    expect(
      await query(
        connection,
        'SELECT component_id, record_id FROM entity_graph.company__components ORDER BY record_id'
      )
    ).toEqual(baselineComponents);

    // Golden merged into one row for the touched entity: survivorship
    // recomputed across all three records (longest name wins source_priority
    // tie-break; domain pulled from the absorbed records).
    const merged = await goldenRows(connection);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      entity_id: 'a',
      name: 'Acme Corporation',
      domain: 'acme.com',
      cluster_size: 3,
      has_companies: true,
    });
    expect(
      await query(
        connection,
        'SELECT DISTINCT entity_id FROM entity_graph.company__golden_record ORDER BY entity_id'
      )
    ).toEqual([{ entity_id: 'a' }]);

    // Idempotency: re-applying the same decision is a byte-identical no-op.
    const afterFirstApply = await dumpTables(connection);
    await applyDecisions(
      connection,
      [{ pair_id: 'a|b', decision: 'merge', status: 'applied', reviewer: 'jane', confidence: 1 }],
      'batch-1'
    );
    expect(await dumpTables(connection)).toEqual(afterFirstApply);

    // Self-healing: a full resolve+cluster (which reads __review_decisions)
    // reproduces the identical crosswalks and golden result.
    const goldenBeforeResolve = await goldenRows(connection);
    await runCluster(connection);
    expect(await crosswalkMap(connection)).toEqual({ a: 'a', b: 'a', z: 'a' });
    expect(await goldenRows(connection)).toEqual(goldenBeforeResolve);
  });

  it('not_match appends the edge and blocks re-merge; the split lands on the next full run', async () => {
    const connection = await createDb(
      [
        { id: 'b', name: 'Acme', domain: 'acme.com' },
        { id: 'z', name: 'Zenith', domain: 'zenith.io' },
      ],
      [['b', 'z', 0.95]]
    );
    await runCluster(connection);
    expect(await crosswalkMap(connection)).toEqual({ b: 'b', z: 'b' });

    await applyDecisions(
      connection,
      [
        {
          pair_id: 'b|z',
          decision: 'not_match',
          status: 'applied',
          reviewer: 'jane',
          confidence: 1,
        },
      ],
      'batch-nm'
    );

    // Edge recorded; no incremental split (documented v1 follow-up) — the
    // records keep their shared entity until the next full run.
    expect(
      await query(
        connection,
        'SELECT pair_id FROM entity_graph.company__not_match_edges ORDER BY pair_id'
      )
    ).toEqual([{ pair_id: 'b|z' }]);
    expect(await crosswalkMap(connection)).toEqual({ b: 'b', z: 'b' });

    // The next full resolve+cluster honors the decision: pair excluded from
    // merge edges, so the records split and stay split.
    await runCluster(connection);
    const split = await crosswalkMap(connection);
    expect(split.b).not.toEqual(split.z);
    expect(await goldenRows(connection)).toHaveLength(2);
  });

  it('a merge decision on an already-merged pair refreshes confidence and golden trust', async () => {
    const connection = await createDb(
      [
        { id: 'b', name: 'Acme', domain: 'acme.com' },
        { id: 'z', name: 'Acme Inc', domain: 'acme.io' },
      ],
      [['b', 'z', 0.95]]
    );
    await runCluster(connection);

    // Auto-merged at 0.95 — a confirming human merge (confidence 1.0) changes
    // no entity assignment, only the pair confidence.
    const before = await goldenRows(connection);
    await applyDecisions(
      connection,
      [{ pair_id: 'b|z', decision: 'merge', status: 'applied', reviewer: 'jane', confidence: 1 }],
      'batch-conf'
    );

    expect(
      await query(
        connection,
        'SELECT record_id, confidence_score FROM entity_graph.company__clusters ORDER BY record_id'
      )
    ).toEqual([
      { record_id: 'b', confidence_score: 1 },
      { record_id: 'z', confidence_score: 1 },
    ]);
    const after = await goldenRows(connection);
    expect(after).toHaveLength(1);
    // Confidence drift alone must refresh the golden trust score.
    expect(Number(after[0]!.trust_score)).toBeGreaterThan(Number(before[0]!.trust_score));

    // Idempotent re-apply, then self-healing full run reproduce the same state.
    const dumps = await dumpTables(connection);
    await applyDecisions(
      connection,
      [{ pair_id: 'b|z', decision: 'merge', status: 'applied', reviewer: 'jane', confidence: 1 }],
      'batch-conf'
    );
    expect(await dumpTables(connection)).toEqual(dumps);
    await runCluster(connection);
    expect(await goldenRows(connection)).toEqual(after);
  });

  it('proposed merges do not materialize', async () => {
    const connection = await createDb(
      [
        { id: 'a', name: 'Acme Corporation', domain: null },
        { id: 'b', name: 'Acme', domain: 'acme.com' },
      ],
      [['a', 'b', 0.5]]
    );
    await runCluster(connection);

    await applyDecisions(
      connection,
      [
        {
          pair_id: 'a|b',
          decision: 'merge',
          status: 'proposed',
          reviewer: 'agent',
          confidence: 0.6,
        },
      ],
      'batch-proposed'
    );

    // The proposed row is recorded but nothing collapses.
    expect(await crosswalkMap(connection)).toEqual({ a: 'a', b: 'b' });
    expect(await goldenRows(connection)).toHaveLength(2);
    expect(
      await query(
        connection,
        "SELECT status FROM entity_graph.company__review_decisions WHERE pair_id = 'a|b'"
      )
    ).toEqual([{ status: 'proposed' }]);
  });
});
