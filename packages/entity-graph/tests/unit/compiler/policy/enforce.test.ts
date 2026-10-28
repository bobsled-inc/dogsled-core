import { describe, expect, it } from 'vitest';
import {
  checkTrustGate,
  checkApprovalGate,
  checkHighImpactMergeGate,
  resolvePiiRedactFields,
} from '../../../../src/compiler/policy/enforce.js';
import type { ResolvedPolicy } from '../../../../src/compiler/policy/types.js';

const basePolicy: ResolvedPolicy = {
  spec_version: '1',
  type: 'policy',
  name: 'test-policy',
};

describe('checkTrustGate', () => {
  it('passes when no min_entity_trust_score configured', () => {
    const result = checkTrustGate(basePolicy, 'ent-1', 0.1);
    expect(result.passed).toBe(true);
    expect(result.threshold).toBe(0);
  });

  it('passes when score meets threshold', () => {
    const policy: ResolvedPolicy = {
      ...basePolicy,
      activation_gates: { min_entity_trust_score: 0.7 },
    };
    const result = checkTrustGate(policy, 'ent-1', 0.7);
    expect(result.passed).toBe(true);
  });

  it('passes when score exceeds threshold', () => {
    const policy: ResolvedPolicy = {
      ...basePolicy,
      activation_gates: { min_entity_trust_score: 0.7 },
    };
    const result = checkTrustGate(policy, 'ent-1', 0.9);
    expect(result.passed).toBe(true);
  });

  it('blocks when score is below threshold', () => {
    const policy: ResolvedPolicy = {
      ...basePolicy,
      activation_gates: { min_entity_trust_score: 0.7 },
    };
    const result = checkTrustGate(policy, 'ent-1', 0.5);
    expect(result.passed).toBe(false);
    expect(result.entityId).toBe('ent-1');
    expect(result.entityTrustScore).toBe(0.5);
    expect(result.threshold).toBe(0.7);
  });
});

describe('checkApprovalGate', () => {
  it('does not block human decisions by default', () => {
    const result = checkApprovalGate(basePolicy, 'human');
    expect(result.blocked).toBe(false);
  });

  it('does not block agent decisions when no gate configured', () => {
    const result = checkApprovalGate(basePolicy, 'agent');
    expect(result.blocked).toBe(false);
  });

  it('blocks agent decisions when all_agent_decisions gate is set', () => {
    const policy: ResolvedPolicy = {
      ...basePolicy,
      approval_gates: { require_human_approval_for: ['all_agent_decisions'] },
    };
    const result = checkApprovalGate(policy, 'agent');
    expect(result.blocked).toBe(true);
    expect(result.reason).toBeDefined();
  });

  it('does not block human decisions even when all_agent_decisions gate is set', () => {
    const policy: ResolvedPolicy = {
      ...basePolicy,
      approval_gates: { require_human_approval_for: ['all_agent_decisions'] },
    };
    const result = checkApprovalGate(policy, 'human');
    expect(result.blocked).toBe(false);
  });
});

describe('checkHighImpactMergeGate', () => {
  it('does not block when gate not configured', () => {
    const result = checkHighImpactMergeGate(basePolicy, 20);
    expect(result.blocked).toBe(false);
  });

  it('does not block small clusters even with gate configured', () => {
    const policy: ResolvedPolicy = {
      ...basePolicy,
      approval_gates: { require_human_approval_for: ['high_impact_merge'] },
    };
    const result = checkHighImpactMergeGate(policy, 5, 10);
    expect(result.blocked).toBe(false);
  });

  it('blocks when cluster size meets threshold', () => {
    const policy: ResolvedPolicy = {
      ...basePolicy,
      approval_gates: { require_human_approval_for: ['high_impact_merge'] },
    };
    const result = checkHighImpactMergeGate(policy, 10, 10);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('10');
  });
});

describe('resolvePiiRedactFields', () => {
  it('returns empty when no policy fields and no auto-detected', () => {
    const fields = resolvePiiRedactFields(basePolicy);
    expect(fields).toHaveLength(0);
  });

  it('returns explicit policy fields', () => {
    const policy: ResolvedPolicy = {
      ...basePolicy,
      review_export: { redact_fields_for_agent_review: ['ssn', 'email'] },
    };
    const fields = resolvePiiRedactFields(policy);
    expect(fields).toEqual(['ssn', 'email']);
  });

  it('falls back to auto-detected fields when policy has none', () => {
    const fields = resolvePiiRedactFields(basePolicy, ['dob', 'phone']);
    expect(fields).toEqual(['dob', 'phone']);
  });

  it('prefers explicit policy fields over auto-detected', () => {
    const policy: ResolvedPolicy = {
      ...basePolicy,
      review_export: { redact_fields_for_agent_review: ['ssn'] },
    };
    const fields = resolvePiiRedactFields(policy, ['dob', 'phone']);
    expect(fields).toEqual(['ssn']);
  });
});
