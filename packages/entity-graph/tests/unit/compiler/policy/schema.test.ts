import { describe, expect, it } from 'vitest';
import { PolicySpecSchema } from '../../../../src/compiler/policy/schema.js';

describe('PolicySpecSchema', () => {
  it('accepts minimal valid policy', () => {
    const result = PolicySpecSchema.safeParse({
      spec_version: '1',
      type: 'policy',
      name: 'my-policy',
    });
    expect(result.success).toBe(true);
  });

  it('accepts full policy spec', () => {
    const result = PolicySpecSchema.safeParse({
      spec_version: '1',
      type: 'policy',
      name: 'full-policy',
      activation_gates: { min_entity_trust_score: 0.75 },
      review_export: { redact_fields_for_agent_review: ['ssn', 'dob'] },
      approval_gates: { require_human_approval_for: ['all_agent_decisions', 'high_impact_merge'] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing name', () => {
    const result = PolicySpecSchema.safeParse({
      spec_version: '1',
      type: 'policy',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown top-level keys', () => {
    const result = PolicySpecSchema.safeParse({
      spec_version: '1',
      type: 'policy',
      name: 'test',
      extra_field: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects trust score out of range', () => {
    const result = PolicySpecSchema.safeParse({
      spec_version: '1',
      type: 'policy',
      name: 'test',
      activation_gates: { min_entity_trust_score: 1.5 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid approval gate values', () => {
    const result = PolicySpecSchema.safeParse({
      spec_version: '1',
      type: 'policy',
      name: 'test',
      approval_gates: { require_human_approval_for: ['invalid_gate'] },
    });
    expect(result.success).toBe(false);
  });

  it('defaults redact_fields_for_agent_review to empty array', () => {
    const result = PolicySpecSchema.safeParse({
      spec_version: '1',
      type: 'policy',
      name: 'test',
      review_export: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review_export?.redact_fields_for_agent_review).toEqual([]);
    }
  });
});
