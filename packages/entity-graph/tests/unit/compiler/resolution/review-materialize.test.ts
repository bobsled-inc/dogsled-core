import { describe, expect, it } from 'vitest';

import {
  generateIncrementalMaterializeSql,
  generateTouchedEntityIdsQuery,
  generateUpdatedGoldenRowsQuery,
} from '../../../../src/compiler/identity/review-materialize.js';
import type { ResolvedResolutionSpec } from '../../../../src/compiler/identity/types.js';

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

/** Same spec but with zero profile attributes (no EAV recompute to emit). */
const ATTRLESS_SPEC: ResolvedResolutionSpec = { ...SPEC, standardize: [] };

const PAIR_STATEMENT_NAMES = [
  'union_clusters',
  'union_clusters_cleanup',
  'pair_confidence',
  'golden_record_delete',
  'golden_record_insert',
  'golden_delete',
  'golden_insert',
  'crosswalks_delete',
  'crosswalks_insert',
] as const;

describe('generateIncrementalMaterializeSql — statement shape', () => {
  it('emits one ordered statement group per merge pair', () => {
    const statements = generateIncrementalMaterializeSql({
      spec: SPEC,
      dialect: 'duckdb',
      targetSchema: 'entity_graph',
      mergePairIds: ['a|b', 'b|c'],
    });

    expect(statements.map((s) => s.name)).toEqual([
      ...PAIR_STATEMENT_NAMES.map((name) => `materialize_merge_1_${name}`),
      ...PAIR_STATEMENT_NAMES.map((name) => `materialize_merge_2_${name}`),
    ]);
  });

  it('returns no statements when there are no merge pairs', () => {
    expect(
      generateIncrementalMaterializeSql({
        spec: SPEC,
        dialect: 'duckdb',
        targetSchema: 'entity_graph',
        mergePairIds: [],
      })
    ).toEqual([]);
  });

  it('skips the EAV golden recompute when the spec has no attributes', () => {
    const statements = generateIncrementalMaterializeSql({
      spec: ATTRLESS_SPEC,
      dialect: 'duckdb',
      targetSchema: 'entity_graph',
      mergePairIds: ['a|b'],
    });

    expect(statements.map((s) => s.name)).toEqual(
      PAIR_STATEMENT_NAMES.filter((name) => name !== 'golden_record_insert').map(
        (name) => `materialize_merge_1_${name}`
      )
    );
  });

  it('never rebuilds whole tables — no CREATE OR REPLACE, writes stay entity-scoped', () => {
    const statements = generateIncrementalMaterializeSql({
      spec: SPEC,
      dialect: 'duckdb',
      targetSchema: 'entity_graph',
      mergePairIds: ['a|b'],
    });

    for (const statement of statements) {
      expect(statement.sql).not.toMatch(/CREATE\s+OR\s+REPLACE/i);
      expect(statement.tableCreated).toBeUndefined();
    }
  });

  it('picks the winner entity the way stable entity-id assignment does', () => {
    const [unionInsert] = generateIncrementalMaterializeSql({
      spec: SPEC,
      dialect: 'duckdb',
      targetSchema: 'entity_graph',
      mergePairIds: ['a|b'],
    });

    // Earliest birth event in __entity_id_events wins, tie-break entity_id ASC
    // — mirrors stable_choice_ranked in codegen-entity-id.ts.
    expect(unionInsert!.sql).toContain('company__entity_id_events');
    expect(unionInsert!.sql).toContain(`"first_assigned_at" ASC`);
    expect(unionInsert!.sql).toContain(`"entity_id" ASC`);
    expect(unionInsert!.sql).toContain(`<> 'alias'`);
  });

  it('guards the crosswalk/golden refresh statements for idempotent re-apply', () => {
    const statements = generateIncrementalMaterializeSql({
      spec: SPEC,
      dialect: 'duckdb',
      targetSchema: 'entity_graph',
      mergePairIds: ['a|b'],
    });
    const guarded = statements.filter(
      (s) => s.name.includes('golden') || s.name === 'materialize_merge_1_crosswalks_delete'
    );

    expect(guarded.length).toBeGreaterThan(0);
    for (const statement of guarded) {
      expect(statement.sql).toContain('EXISTS (SELECT 1 FROM stale_records)');
    }
    // The crosswalk re-projection is guarded per-row instead.
    const crosswalksInsert = statements.find(
      (s) => s.name === 'materialize_merge_1_crosswalks_insert'
    );
    expect(crosswalksInsert!.sql).toContain('NOT EXISTS');
  });

  it('chains every statement on its predecessor so a failure skips the rest', () => {
    const statements = generateIncrementalMaterializeSql({
      spec: SPEC,
      dialect: 'duckdb',
      targetSchema: 'entity_graph',
      mergePairIds: ['a|b', 'b|c'],
      dependsOn: 'apply_review_decisions',
    });

    expect(statements[0]!.deps).toEqual(['apply_review_decisions']);
    for (let index = 1; index < statements.length; index++) {
      expect(statements[index]!.deps).toEqual([statements[index - 1]!.name]);
    }
  });

  it('treats confidence drift as a refresh signal', () => {
    const statements = generateIncrementalMaterializeSql({
      spec: SPEC,
      dialect: 'duckdb',
      targetSchema: 'entity_graph',
      mergePairIds: ['a|b'],
    });
    const goldenDelete = statements.find((s) => s.name === 'materialize_merge_1_golden_delete');

    // A merge decision on an already-merged pair only raises confidence_score;
    // the stale signal must still fire so golden trust is recomputed.
    expect(goldenDelete!.sql).toContain('confidence_score');
  });

  it('keeps the CTE clause after INSERT INTO / inside DELETE ... IN for BigQuery', () => {
    const statements = generateIncrementalMaterializeSql({
      spec: SPEC,
      dialect: 'bigquery',
      targetSchema: 'entity_graph',
      mergePairIds: ['a|b'],
    });

    for (const statement of statements) {
      // BigQuery rejects a WITH clause that precedes INSERT/DELETE/UPDATE.
      expect(statement.sql.trimStart().startsWith('WITH')).toBe(false);
    }
  });
});

describe('post-materialization read queries', () => {
  it('resolves touched entity_ids through __crosswalks via the pair records', () => {
    const sql = generateTouchedEntityIdsQuery('company', 'duckdb', 'entity_graph', ['a|b', 'b|c']);
    expect(sql).toContain('company__crosswalks');
    expect(sql).toContain('company__pair_scores');
    expect(sql).toContain(`'a|b'`);
    expect(sql).toContain(`'b|c'`);
  });

  it('returns the updated wide golden rows for the touched entities', () => {
    const sql = generateUpdatedGoldenRowsQuery('company', 'duckdb', 'entity_graph', ['a|b']);
    expect(sql).toContain('company__golden');
    expect(sql).toContain('company__crosswalks');
  });
});
