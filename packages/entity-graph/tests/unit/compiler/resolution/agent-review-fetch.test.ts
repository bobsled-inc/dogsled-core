import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  fetchUnreviewedPairContexts,
  mapReviewQueueRowsToPairContexts,
  type ReviewQueueRow,
} from '../../../../src/compiler/identity/agent-review-fetch.js';
import type { ResolvedResolutionSpec } from '../../../../src/compiler/identity/types.js';
import { CommandError } from '@bobsled-inc/protocol';

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

function makeSpec(overrides: Partial<ResolvedResolutionSpec> = {}): ResolvedResolutionSpec {
  return {
    name: 'company_resolution',
    entity: 'company',
    description: 'Resolve companies.',
    inputs: [{ ref: 'raw.companies', fqTableName: 'raw.companies', alias: 's0', idFields: ['id'] }],
    standardize: [],
    deterministicRules: [],
    thresholds: { autoMerge: 0.9, review: 0.6, autoReject: 0.4 },
    entityIdPolicy: {
      strategy: 'stable',
      newId: 'component_id',
      merge: 'oldest_entity_id',
      split: 'preserve_anchor',
    },
    targetSchema: 'entity_graph',
    ...overrides,
  };
}

let openInstance: DuckDbInstance | undefined;
let openConnection: DuckDbConnection | undefined;

async function createDb(): Promise<DuckDbConnection> {
  openInstance = await DuckDBInstance.create(':memory:');
  openConnection = await openInstance.connect();
  const conn = openConnection;
  await conn.run('CREATE SCHEMA entity_graph');
  await conn.run(`
    CREATE TABLE entity_graph.company__review_queue (
      pair_id VARCHAR,
      record_a_id VARCHAR,
      record_b_id VARCHAR,
      source_a VARCHAR,
      source_b VARCHAR,
      composite_score DOUBLE,
      threshold_band VARCHAR,
      blocking_rules VARCHAR,
      field_diffs VARCHAR,
      recommended_action VARCHAR
    )
  `);
  await conn.run(`
    CREATE TABLE entity_graph.company__review_decisions (
      pair_id VARCHAR,
      decision VARCHAR,
      confidence DOUBLE,
      status VARCHAR,
      decided_at TIMESTAMP
    )
  `);
  await conn.run(`
    CREATE TABLE entity_graph.company__standardized (
      record_id VARCHAR,
      source_ref VARCHAR,
      standardized_name VARCHAR,
      standardized_website VARCHAR,
      country VARCHAR
    )
  `);
  return conn;
}

function queryRunner(conn: DuckDbConnection) {
  return async (sql: string) => (await conn.runAndReadAll(sql)).getRowObjectsJS();
}

async function seedQueue(
  conn: DuckDbConnection,
  rows: Array<{
    pairId: string;
    a: string;
    b: string;
    score: number;
    fieldDiffs: string;
    band?: string;
  }>
): Promise<void> {
  for (const row of rows) {
    await conn.run(`
      INSERT INTO entity_graph.company__review_queue VALUES (
        '${row.pairId}', '${row.a}', '${row.b}', 'shopify', 'hubspot',
        ${row.score}, '${row.band ?? 'review'}', 'exact_website',
        '${row.fieldDiffs.replace(/'/g, "''")}', 'merge'
      )
    `);
  }
}

async function seedStandardized(
  conn: DuckDbConnection,
  rows: Array<{ recordId: string; name: string; website: string; country?: string }>
): Promise<void> {
  for (const row of rows) {
    await conn.run(`
      INSERT INTO entity_graph.company__standardized VALUES (
        '${row.recordId}', 'raw.companies', '${row.name}', '${row.website}', '${row.country ?? 'us'}'
      )
    `);
  }
}

afterEach(() => {
  openConnection?.disconnectSync();
  openInstance?.closeSync();
  openConnection = undefined;
  openInstance = undefined;
});

describe('fetchUnreviewedPairContexts', () => {
  it('maps queue rows + field_diffs + __standardized values into PairContext[]', async () => {
    const conn = await createDb();
    await seedQueue(conn, [
      {
        pairId: 'p1',
        a: 'r1',
        b: 'r2',
        score: 0.72,
        fieldDiffs: '{"standardized_name":0.91,"standardized_website":0.4}',
      },
    ]);
    await seedStandardized(conn, [
      { recordId: 'r1', name: 'acme', website: 'acme.com' },
      { recordId: 'r2', name: 'acme inc', website: 'acme.io' },
    ]);

    const { pairs, warnings } = await fetchUnreviewedPairContexts(
      queryRunner(conn),
      makeSpec(),
      'duckdb',
      'entity_graph'
    );

    expect(warnings).toEqual([]);
    expect(pairs).toHaveLength(1);
    const pair = pairs[0]!;
    expect(pair).toMatchObject({
      pairId: 'p1',
      recordAId: 'r1',
      recordBId: 'r2',
      sourceA: 'shopify',
      sourceB: 'hubspot',
      compositeScore: 0.72,
    });
    expect(pair.fields).toEqual({
      standardized_name: { a: 'acme', b: 'acme inc', score: 0.91 },
      standardized_website: { a: 'acme.com', b: 'acme.io', score: 0.4 },
    });
  });

  it('filters fields to agent_policy.context_fields (raw names match standardized columns)', async () => {
    const conn = await createDb();
    await seedQueue(conn, [
      {
        pairId: 'p1',
        a: 'r1',
        b: 'r2',
        score: 0.7,
        fieldDiffs: '{"standardized_name":0.91,"standardized_website":0.4}',
      },
    ]);
    await seedStandardized(conn, [
      { recordId: 'r1', name: 'acme', website: 'acme.com', country: 'us' },
      { recordId: 'r2', name: 'acme inc', website: 'acme.io', country: 'de' },
    ]);

    const spec = makeSpec({
      agentPolicy: { enabled: true, contextFields: ['name', 'country'] },
    });
    const { pairs } = await fetchUnreviewedPairContexts(
      queryRunner(conn),
      spec,
      'duckdb',
      'entity_graph'
    );

    // `name` resolves its value through the standardized_ fallback and its
    // score through the standardized_name field_diffs key; `country` is a raw
    // passthrough column with no score; `website` is filtered out entirely.
    expect(pairs[0]!.fields).toEqual({
      name: { a: 'acme', b: 'acme inc', score: 0.91 },
      country: { a: 'us', b: 'de' },
    });
  });

  it('skips pairs that already have a decision and honors the limit', async () => {
    const conn = await createDb();
    await seedQueue(conn, [
      { pairId: 'p1', a: 'r1', b: 'r2', score: 0.61, fieldDiffs: '{}' },
      { pairId: 'p2', a: 'r1', b: 'r3', score: 0.62, fieldDiffs: '{}' },
      { pairId: 'p3', a: 'r2', b: 'r3', score: 0.63, fieldDiffs: '{}' },
    ]);
    await conn.run(`
      INSERT INTO entity_graph.company__review_decisions VALUES
        ('p1', 'merge', 0.9, 'applied', CURRENT_TIMESTAMP)
    `);

    const all = await fetchUnreviewedPairContexts(
      queryRunner(conn),
      makeSpec(),
      'duckdb',
      'entity_graph'
    );
    expect(all.pairs.map((pair) => pair.pairId)).toEqual(['p2', 'p3']);

    const limited = await fetchUnreviewedPairContexts(
      queryRunner(conn),
      makeSpec(),
      'duckdb',
      'entity_graph',
      { limit: 1 }
    );
    expect(limited.pairs.map((pair) => pair.pairId)).toEqual(['p2']);
  });

  it('degrades to scores-only with a warning when __standardized is unreadable', async () => {
    const conn = await createDb();
    await conn.run('DROP TABLE entity_graph.company__standardized');
    await seedQueue(conn, [
      { pairId: 'p1', a: 'r1', b: 'r2', score: 0.7, fieldDiffs: '{"standardized_name":0.8}' },
    ]);

    const { pairs, warnings } = await fetchUnreviewedPairContexts(
      queryRunner(conn),
      makeSpec(),
      'duckdb',
      'entity_graph'
    );

    expect(pairs[0]!.fields).toEqual({ standardized_name: { a: '', b: '', score: 0.8 } });
    expect(warnings.some((warning) => /__standardized/.test(warning))).toBe(true);
  });

  it('warns on unparseable field_diffs but still returns the pair', async () => {
    const conn = await createDb();
    await seedQueue(conn, [{ pairId: 'p1', a: 'r1', b: 'r2', score: 0.7, fieldDiffs: 'not json' }]);
    await seedStandardized(conn, [
      { recordId: 'r1', name: 'acme', website: 'acme.com' },
      { recordId: 'r2', name: 'acme inc', website: 'acme.io' },
    ]);

    const { pairs, warnings } = await fetchUnreviewedPairContexts(
      queryRunner(conn),
      makeSpec(),
      'duckdb',
      'entity_graph'
    );

    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.fields).toEqual({});
    expect(warnings.some((warning) => /field_diffs/.test(warning))).toBe(true);
  });

  it('throws CommandError(1) when the queue rows violate the schema', async () => {
    const badRunner = async () => [{ pair_id: 'p1' }];
    const error = await fetchUnreviewedPairContexts(
      badRunner,
      makeSpec(),
      'duckdb',
      'entity_graph'
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).exitCode).toBe(1);
  });
});

describe('mapReviewQueueRowsToPairContexts', () => {
  const row: ReviewQueueRow = {
    pair_id: 'p1',
    record_a_id: 'r1',
    record_b_id: 'r2',
    source_a: 'shopify',
    source_b: 'hubspot',
    composite_score: 0.7,
    threshold_band: 'review',
    blocking_rules: 'exact_website',
    field_diffs: '{"standardized_name":0.9}',
    recommended_action: 'merge',
  };

  it('maps without value enrichment when no lookup map is provided', () => {
    const [pair] = mapReviewQueueRowsToPairContexts([row]);
    expect(pair!.fields).toEqual({ standardized_name: { a: '', b: '', score: 0.9 } });
  });

  it('includes context fields even when they carry no score', () => {
    const values = new Map<string, Record<string, unknown>>([
      ['r1', { record_id: 'r1', standardized_name: 'acme', country: 'us' }],
      ['r2', { record_id: 'r2', standardized_name: 'acme inc', country: 'de' }],
    ]);
    const [pair] = mapReviewQueueRowsToPairContexts([row], {
      contextFields: ['name', 'country'],
      valuesByRecordId: values,
    });
    expect(pair!.fields).toEqual({
      name: { a: 'acme', b: 'acme inc', score: 0.9 },
      country: { a: 'us', b: 'de' },
    });
  });
});
