import { describe, expect, it } from 'vitest';

import { AgentTaskProfileSchema } from '../../../../src/compiler/agent/schema.js';
import {
  bundleToReviewDecisions,
  isAgentDecisionBundleV1,
  LEGACY_AGENT_DECISION_BUNDLE_VERSION,
} from '../../../../src/compiler/agent/types.js';

describe('AgentTaskProfileSchema', () => {
  it('parses a valid review-batch profile', () => {
    const parsed = AgentTaskProfileSchema.parse({
      spec_version: '0.2',
      type: 'agent_task_profile',
      name: 'company_review_batch',
      entity: 'company',
      operation: 'review_batch',
      mode: 'propose',
      selection: {
        threshold_bands: ['review'],
        limit: 50,
      },
      policy: {
        allow_writes: false,
        max_apply_count: 25,
        auto_apply_threshold: 0.82,
      },
      post_apply: {
        cluster: false,
        survivorship: false,
      },
      output: {
        decision_bundle_path: 'review/company_agent_bundle.yml',
      },
    });

    expect(parsed.operation).toBe('review_batch');
    expect(parsed.selection?.threshold_bands).toEqual(['review']);
    expect(parsed.selection?.limit).toBe(50);
    expect(parsed.policy?.auto_apply_threshold).toBe(0.82);
  });

  it('parses a valid onboard propose-cleaning profile', () => {
    const parsed = AgentTaskProfileSchema.parse({
      spec_version: '0.2',
      type: 'agent_task_profile',
      name: 'company_onboard_propose_cleaning',
      entity: 'company',
      operation: 'onboard_propose_cleaning',
      mode: 'propose',
    });

    expect(parsed.operation).toBe('onboard_propose_cleaning');
    expect(parsed.mode).toBe('propose');
  });

  it('rejects invalid agent task operations', () => {
    const result = AgentTaskProfileSchema.safeParse({
      spec_version: '0.2',
      type: 'agent_task_profile',
      name: 'company_invalid_operation',
      entity: 'company',
      operation: 'onboard_clean',
      mode: 'propose',
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error('Expected schema parse to fail');
    }
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_value',
          path: ['operation'],
        }),
      ])
    );
  });

  it('rejects removed human-review policy keys instead of silently accepting them', () => {
    const result = AgentTaskProfileSchema.safeParse({
      spec_version: '0.2',
      type: 'agent_task_profile',
      name: 'company_review_batch',
      entity: 'company',
      operation: 'review_batch',
      mode: 'propose',
      policy: {
        auto_apply_threshold: 0.82,
        human_review_confidence_floor: 0.8,
        skip_human_review: false,
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error('Expected schema parse to fail');
    }
    expect(
      result.error.issues.some(
        (issue) => issue.code === 'unrecognized_keys' && issue.path.join('.') === 'policy'
      )
    ).toBe(true);
  });

  it('rejects unknown nested keys instead of silently dropping them', () => {
    const result = AgentTaskProfileSchema.safeParse({
      spec_version: '0.2',
      type: 'agent_task_profile',
      name: 'company_review_batch',
      entity: 'company',
      operation: 'review_batch',
      mode: 'propose',
      selection: {
        threshold_bands: ['review'],
        limit: 50,
      },
      policy: {
        auto_apply_threshold: 0.82,
        confidence_threshold: 0.9,
      },
      post_apply: {
        cluster: false,
        survivorship: false,
      },
      output: {
        decision_bundle_path: 'review/company_agent_bundle.yml',
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error('Expected schema parse to fail');
    }
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'unrecognized_keys',
          path: ['policy'],
          keys: expect.arrayContaining(['confidence_threshold']),
        }),
      ])
    );
  });
});

describe('entity_graph_decision_bundle.v1', () => {
  it('recognizes valid bundles and converts them to review decisions', () => {
    const bundle = {
      version: 'entity_graph_decision_bundle.v1',
      entity: 'company',
      mode: 'propose',
      decision_source: 'agent',
      decisions: [
        {
          pair_id: 'abc123',
          decision: 'merge',
          reason: 'same domain and DUNS',
          confidence: 0.93,
        },
      ],
    } as const;

    expect(isAgentDecisionBundleV1(bundle)).toBe(true);
    expect(bundleToReviewDecisions(bundle)).toEqual([
      {
        pair_id: 'abc123',
        decision: 'merge',
        reviewer: 'agent',
        reason: 'same domain and DUNS',
        confidence: 0.93,
        decided_at: undefined,
        decision_batch_id: undefined,
        decision_source: 'agent',
        applied_at: undefined,
      },
    ]);
  });

  it('recognizes legacy mdm_decision_bundle.v1 bundles', () => {
    const bundle = {
      version: LEGACY_AGENT_DECISION_BUNDLE_VERSION,
      entity: 'company',
      mode: 'propose',
      decision_source: 'agent',
      decisions: [
        {
          pair_id: 'legacy_pair',
          decision: 'not_match',
        },
      ],
    } as const;

    expect(isAgentDecisionBundleV1(bundle)).toBe(true);
    expect(bundleToReviewDecisions(bundle)[0]).toMatchObject({
      pair_id: 'legacy_pair',
      decision: 'not_match',
      reviewer: 'agent',
    });
  });
});
