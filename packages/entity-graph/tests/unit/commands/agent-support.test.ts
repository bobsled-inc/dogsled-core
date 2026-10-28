import { describe, expect, it } from 'vitest';

import {
  buildDecisionBundle,
  buildReviewBatchConfig,
  fetchIncorrectFeedbackPairs,
} from '../../../src/commands/agent-support.js';

describe('buildReviewBatchConfig', () => {
  it('prefers profile thresholds, then spec thresholds, then defaults', () => {
    const config = buildReviewBatchConfig(
      {
        name: 'company_resolution',
        entity: 'company',
        description: 'Resolve companies.',
        inputs: [],
        standardize: [{ field: 'company_name', transforms: ['lowercase'] }],
        blocking: { rules: [] },
        deterministicRules: [],
        scoring: undefined,
        thresholds: {
          autoMerge: 0.95,
          review: 0.6,
          autoReject: 0.55,
        },
        agentPolicy: {
          enabled: true,
          autoApplyThreshold: 0.8,
        },
        targetSchema: 'ENTITY_GRAPH',
      },
      {
        spec_version: '0.2',
        type: 'agent_task_profile',
        name: 'company_review_batch',
        entity: 'company',
        operation: 'review_batch',
        policy: {
          auto_apply_threshold: 0.84,
          agent_confidence_floor: 0.5,
        },
      },
      {},
      '/tmp/company_review_batch.yml'
    );

    expect(config.autoApplyThreshold).toBe(0.84);
    expect(config.agentConfidenceFloor).toBe(0.5);
    expect(config.thresholdBands).toEqual(['review', 'deterministic_review']);
  });
});

describe('buildDecisionBundle', () => {
  it('uses action-aware confidence heuristics for generated bundles', () => {
    const bundle = buildDecisionBundle(
      {
        name: 'company_resolution',
        entity: 'company',
        description: 'Resolve companies.',
        inputs: [],
        standardize: [{ field: 'company_name', transforms: ['lowercase'] }],
        blocking: { rules: [] },
        deterministicRules: [],
        scoring: undefined,
        thresholds: {
          autoMerge: 0.95,
          review: 0.6,
          autoReject: 0.55,
        },
        targetSchema: 'ENTITY_GRAPH',
      },
      [
        {
          pair_id: 'pair-merge',
          record_a_id: 'a',
          record_b_id: 'b',
          source_a: 'crm',
          source_b: 'zi',
          composite_score: 0.82,
          threshold_band: 'review',
          blocking_rules: '[]',
          field_diffs: '{}',
          recommended_action: 'merge',
        },
        {
          pair_id: 'pair-reject',
          record_a_id: 'c',
          record_b_id: 'd',
          source_a: 'crm',
          source_b: 'zi',
          composite_score: 0.62,
          threshold_band: 'review',
          blocking_rules: '[]',
          field_diffs: '{}',
          recommended_action: 'not_match',
        },
      ],
      {
        mode: 'apply',
        thresholdBands: ['review'],
        limit: 10,
        allowWrites: true,
        maxApplyCount: 10,
        requireTruthsetPrecision: null,
        autoApplyThreshold: 0.8,
        postApply: { cluster: false, survivorship: false },
        decisionSource: 'agent',
      }
    );

    expect(bundle.decisions[0]?.confidence).toBe(0.82);
    expect(bundle.decisions[1]?.confidence).toBe(0.38);
  });

  it('includes learning_context when provided', () => {
    const bundle = buildDecisionBundle(
      {
        name: 'company_resolution',
        entity: 'company',
        description: 'Resolve companies.',
        inputs: [],
        standardize: [{ field: 'company_name', transforms: ['lowercase'] }],
        blocking: { rules: [] },
        deterministicRules: [],
        scoring: undefined,
        thresholds: {
          autoMerge: 0.95,
          review: 0.6,
          autoReject: 0.55,
        },
        targetSchema: 'ENTITY_GRAPH',
      },
      [
        {
          pair_id: 'pair-merge',
          record_a_id: 'a',
          record_b_id: 'b',
          source_a: 'crm',
          source_b: 'zi',
          composite_score: 0.82,
          threshold_band: 'review',
          blocking_rules: '[]',
          field_diffs: '{}',
          recommended_action: 'merge',
        },
      ],
      {
        mode: 'propose',
        thresholdBands: ['review'],
        limit: 10,
        allowWrites: true,
        maxApplyCount: 10,
        requireTruthsetPrecision: null,
        autoApplyThreshold: 0.7,
        postApply: { cluster: false, survivorship: false },
        decisionSource: 'agent',
      },
      'Recent human corrections go here.'
    );

    expect(bundle.learning_context).toBe('Recent human corrections go here.');
  });
});

describe('fetchIncorrectFeedbackPairs', () => {
  it('queries the latest incorrectly reviewed pairs from the review queue', async () => {
    let capturedSql = '';
    const rows = await fetchIncorrectFeedbackPairs(
      {
        name: 'company_resolution',
        entity: 'company',
        description: 'Resolve companies.',
        inputs: [],
        standardize: [{ field: 'company_name', transforms: ['lowercase'] }],
        blocking: { rules: [] },
        deterministicRules: [],
        scoring: undefined,
        thresholds: {
          autoMerge: 0.95,
          review: 0.6,
          autoReject: 0.55,
        },
        targetSchema: 'ENTITY_GRAPH',
      },
      'snowflake',
      async (sql) => {
        capturedSql = sql;
        return [
          {
            pair_id: 'pair-123',
            record_a_id: 'a',
            record_b_id: 'b',
            source_a: 'crm',
            source_b: 'zi',
            composite_score: 0.61,
            threshold_band: 'review',
            blocking_rules: '[]',
            field_diffs: '{}',
            recommended_action: 'not_match',
          },
        ];
      }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.pair_id).toBe('pair-123');
    expect(capturedSql).toContain('HUMAN_FEEDBACK_OUTCOME');
    expect(capturedSql).toContain("'incorrect'");
    expect(capturedSql).toContain('COMPANY__REVIEW_QUEUE');
  });
});
