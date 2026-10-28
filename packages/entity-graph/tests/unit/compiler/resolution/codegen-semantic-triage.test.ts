import { describe, expect, it } from 'vitest';

import {
  buildSemanticEmbeddingEstimateQuery,
  buildSemanticEmbeddingInputQuery,
  generateSemanticTriageSql,
} from '../../../../src/compiler/identity/codegen-semantic-triage.js';

import type { ResolvedResolutionSpec } from '../../../../src/compiler/identity/types.js';

const SPEC: ResolvedResolutionSpec = {
  name: 'company_resolution',
  entity: 'company',
  description: 'Resolve companies.',
  inputs: [
    {
      ref: 'raw.crm_companies',
      fqTableName: 'raw.crm_companies',
      alias: 's0',
      idFields: ['id'],
    },
  ],
  standardize: [],
  deterministicRules: [],
  scoring: {
    method: 'weighted_features',
    features: [{ field: 'company_name', algorithm: 'jaro_winkler', weight: 1 }],
  },
  thresholds: {
    autoMerge: 0.95,
    review: 0.6,
    autoReject: 0.4,
  },
  entityIdPolicy: {
    strategy: 'stable',
    newId: 'component_id',
    merge: 'oldest_entity_id',
    split: 'preserve_anchor',
  },
  semanticTriage: {
    provider: 'openai_text_embedding_3_small',
    fields: ['company_name', 'domain'],
    promoteToMergeThreshold: 0.94,
    promoteToRejectThreshold: 0.55,
  },
};

describe('semantic triage with flag_for_review rules', () => {
  const FLAG_SPEC: ResolvedResolutionSpec = {
    ...SPEC,
    deterministicRules: [
      {
        name: 'same_name_no_domain',
        conditions: [{ field: 'company_name', operator: 'exact', bothNotNull: true }],
        action: 'flag_for_review',
        confidence: 0.85,
      },
    ],
  };

  it('excludes flagged pairs from triage eligibility and embedding spend', () => {
    const sql = buildSemanticEmbeddingInputQuery(FLAG_SPEC, 'duckdb', 'main');
    expect(sql).toContain(`"match_type" <> 'deterministic_review'`);
  });

  it('keeps flagged pairs in the rebuilt queue without a semantic decision', () => {
    const result = generateSemanticTriageSql(FLAG_SPEC, 'duckdb', 'main');
    const queue = result.statements.find((s) => s.name === 'semantic_review_queue');
    expect(queue?.sql).toContain(`OR ps."match_type" = 'deterministic_review'`);
    expect(queue?.sql).toContain(`WHEN ps."match_type" = 'deterministic_review' THEN NULL`);
    expect(queue?.sql).toContain(`"rule_name"`);
  });

  it('emits no flag-rule predicates when the spec has none', () => {
    const result = generateSemanticTriageSql(SPEC, 'duckdb', 'main');
    for (const statement of result.statements) {
      expect(statement.sql).not.toContain('deterministic_review');
    }
  });
});

describe('semantic triage codegen', () => {
  it('builds a cache-aware embedding input query', () => {
    const sql = buildSemanticEmbeddingInputQuery(SPEC, 'duckdb', 'main');

    expect(sql).toContain('company__embedding_cache');
    expect(sql).toContain('left_hash');
    expect(sql).toContain('right_hash');
    expect(sql).toContain('company_name');
    expect(sql).toContain('domain');
  });

  it('builds embedding cost estimate SQL', () => {
    const sql = buildSemanticEmbeddingEstimateQuery(SPEC, 'duckdb', 'main', true);

    expect(sql).toContain('semantic_candidate_count');
    expect(sql).toContain('estimated_embedding_input_count');
    expect(sql).toContain('estimated_embedding_cost_usd');
    expect(sql).toContain('0.02');
  });

  it('generates pair scores, queue rewrite, not-match, and audit SQL', () => {
    const result = generateSemanticTriageSql(SPEC, 'duckdb', 'main');

    expect(result.warnings).toEqual([]);
    expect(result.statements.map((statement) => statement.name)).toEqual([
      'semantic_pair_scores',
      'semantic_review_queue',
      'semantic_not_match_edges',
      'audit_semantic_promotions',
    ]);
    expect(result.statements[0]?.sql).toContain('array_cosine_similarity');
    expect(result.statements[1]?.sql).toContain('kept_for_review');
    expect(result.statements[2]?.sql).toContain('semantic_triage');
    expect(result.statements[3]?.sql).toContain('semantic_promote_merge');
  });

  it('generates semantic triage statements for non-DuckDB dialects', () => {
    const result = generateSemanticTriageSql(SPEC, 'snowflake', 'ENTITY_GRAPH');

    expect(result.warnings).toEqual([]);
    expect(result.statements.map((statement) => statement.name)).toEqual([
      'semantic_pair_scores',
      'semantic_review_queue',
      'semantic_not_match_edges',
      'audit_semantic_promotions',
    ]);
    expect(result.statements[0]?.sql).toContain('FLATTEN');
  });
});
