import { describe, expect, it } from 'vitest';

import {
  buildResolveEstimateQuery,
  transformInspectPairResult,
} from '../../../src/commands/resolve-support.js';
import { transformInspectClusterResult } from '../../../src/commands/resolve-inspect-cluster.js';

import type { ResolvedResolutionSpec } from '../../../src/compiler/identity/types.js';

describe('transformInspectPairResult', () => {
  it('normalizes key casing and parses JSON payloads', () => {
    const result = transformInspectPairResult([
      {
        PAIR_ID: 'pair-1',
        RECORD_A_ID: 'a',
        RECORD_B_ID: 'b',
        SOURCE_A: 'crm',
        SOURCE_B: 'zi',
        COMPOSITE_SCORE: 0.81,
        MATCH_TYPE: 'review',
        RULE_NAME: null,
        BLOCKING_RULES: '["exact_domain"]',
        FIELD_SCORES: '{"domain":1,"name":0.8}',
        THRESHOLD_BAND: 'review',
        RECOMMENDED_ACTION: 'merge',
        SEMANTIC_SCORE: 0.91,
        SEMANTIC_DECISION: 'kept_for_review',
        DECISION: 'defer',
        PROPOSED_DECISION: 'merge',
        PROPOSED_CONFIDENCE: 0.74,
      },
    ]);

    expect(result).toMatchObject({
      found: true,
      pair_id: 'pair-1',
      threshold_band: 'review',
      blocking_rules: ['exact_domain'],
      field_scores: {
        domain: 1,
        name: 0.8,
      },
      proposed_decision: 'merge',
      proposed_confidence: 0.74,
      semantic_score: 0.91,
      semantic_decision: 'kept_for_review',
    });
  });
});

describe('buildResolveEstimateQuery', () => {
  const spec: ResolvedResolutionSpec = {
    name: 'company_resolution',
    entity: 'company',
    description: 'Resolve companies.',
    inputs: [],
    standardize: [],
    deterministicRules: [],
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
      fields: ['company_name'],
      promoteToMergeThreshold: 0.94,
      promoteToRejectThreshold: 0.55,
    },
  };

  it('includes semantic triage estimate fields on request', () => {
    const sql = buildResolveEstimateQuery(spec, 'main', 'duckdb', {
      includeSemanticTriage: true,
      useSemanticCache: false,
    });

    expect(sql).toContain('semantic_candidate_count');
    expect(sql).toContain('estimated_embedding_input_count');
    expect(sql).toContain('estimated_embedding_cost_usd');
  });

  it('counts flag_for_review pairs as review regardless of score band', () => {
    const flagSpec: ResolvedResolutionSpec = {
      ...spec,
      deterministicRules: [
        {
          name: 'same_name_no_domain',
          conditions: [{ field: 'company_name', operator: 'exact', bothNotNull: true }],
          action: 'flag_for_review',
          confidence: 0.85,
        },
      ],
    };
    const sql = buildResolveEstimateQuery(flagSpec, 'main', 'duckdb');

    // Flagged pairs are excluded from the auto-merge and auto-reject buckets
    // and folded into the review bucket unconditionally.
    expect(sql).toContain(`"match_type" <> 'deterministic_review'`);
    expect(sql).toContain(`OR "match_type" = 'deterministic_review'`);
  });

  it('emits unchanged estimate SQL without flag rules', () => {
    const sql = buildResolveEstimateQuery(spec, 'main', 'duckdb');
    expect(sql).not.toContain('deterministic_review');
  });

  it('excludes deterministic pairs from the reject bucket when auto_merge is null', () => {
    // With auto_merge: null every deterministic pair merges regardless of its
    // confidence — a low-confidence one must not also count as an auto-reject.
    const nullSpec: ResolvedResolutionSpec = {
      ...spec,
      deterministicRules: [
        {
          name: 'exact_name',
          conditions: [{ field: 'company_name', operator: 'exact', bothNotNull: true }],
          action: 'auto_merge',
          confidence: 0.5,
        },
      ],
      thresholds: { autoMerge: null, review: 0.6, autoReject: 0.4 },
    };
    const sql = buildResolveEstimateQuery(nullSpec, 'main', 'duckdb');
    expect(sql).toContain(`"composite_score" < 0.6 AND "match_type" <> 'deterministic'`);
  });
});

describe('transformInspectClusterResult', () => {
  it('groups flat rows into sectioned cluster output', () => {
    const result = transformInspectClusterResult([
      {
        section: 'members',
        cluster_id: 'cluster-1',
        record_id: 'rec-1',
        source_ref: 'crm',
        source_system: 'crm',
        source_entity_id: 'crm-1',
        confidence_score: null,
      },
      {
        section: 'crosswalks',
        cluster_id: 'cluster-1',
        record_id: 'rec-1',
        source_ref: 'crm',
        source_system: 'crm',
        source_entity_id: 'crm-1',
        confidence_score: '',
      },
      {
        section: 'golden_record',
        cluster_id: 'cluster-1',
        attribute_name: 'domain',
        attribute_value: 'acme.com',
      },
      {
        section: 'contributing_decisions',
        cluster_id: 'cluster-1',
        pair_id: 'pair-1',
        record_a_id: 'rec-1',
        record_b_id: 'rec-2',
        decision: 'merge',
        confidence: null,
        proposed_confidence: undefined,
      },
      {
        section: 'audit',
        cluster_id: 'cluster-1',
        event_id: 'evt-1',
        category: 'resolution',
        subject_type: 'cluster',
        subject_id: 'cluster-1',
        payload: '{"kind":"merge","record_count":2}',
        audit_reason: 'review_apply',
        actor: 'agent',
        actor_type: 'system',
        occurred_at: '2026-04-29T00:00:00.000Z',
      },
    ]);

    expect(result).toMatchObject({
      found: true,
      cluster_id: 'cluster-1',
      cluster_size: 1,
    });
    expect(result?.source_system_distribution).toEqual([{ source_system: 'crm', count: 1 }]);
    expect(result?.members).toHaveLength(1);
    expect(result?.golden_record).toEqual([
      { attribute_name: 'domain', attribute_value: 'acme.com' },
    ]);
    expect(result?.contributing_decisions).toEqual([
      expect.objectContaining({
        pair_id: 'pair-1',
        decision: 'merge',
        confidence: null,
        proposed_confidence: null,
      }),
    ]);
    expect(result?.audit).toEqual([
      expect.objectContaining({
        event_id: 'evt-1',
        payload: { kind: 'merge', record_count: 2 },
        audit_reason: 'review_apply',
      }),
    ]);
    expect(result?.members[0]?.confidence_score).toBeNull();
    expect(result?.crosswalks[0]?.confidence_score).toBeNull();
  });

  it('chooses canonical entity identity from stable cluster sections', () => {
    const result = transformInspectClusterResult([
      {
        section: 'contributing_decisions',
        entity_id: 'requested-alias',
        cluster_id: 'requested-alias',
        pair_id: 'pair-1',
      },
      {
        section: 'members',
        entity_id: 'stable-entity',
        cluster_id: 'stable-entity',
        record_id: 'rec-1',
      },
    ]);

    expect(result).toMatchObject({
      entity_id: 'stable-entity',
      cluster_id: 'stable-entity',
    });
  });
});
