import type { ResolvedPolicy, TrustGateResult, ApprovalGateResult } from './types.js';

/**
 * Check whether an entity passes the minimum trust score gate.
 * Returns the gate result; caller is responsible for emitting policy_block audit rows.
 */
export function checkTrustGate(
  policy: ResolvedPolicy,
  entityId: string,
  entityTrustScore: number
): TrustGateResult {
  const threshold = policy.activation_gates?.min_entity_trust_score;
  if (threshold === undefined) {
    return { passed: true, entityId, entityTrustScore, threshold: 0 };
  }
  return {
    passed: entityTrustScore >= threshold,
    entityId,
    entityTrustScore,
    threshold,
  };
}

/**
 * Resolve the set of field names that should be redacted in review exports.
 * Merges the explicit list from the policy with any auto-detected PII field names.
 */
export function resolvePiiRedactFields(
  policy: ResolvedPolicy,
  autoDetectedPiiFields: readonly string[] = []
): readonly string[] {
  const explicit = policy.review_export?.redact_fields_for_agent_review;
  // Explicit array (even empty) takes precedence; undefined falls back to auto-detected.
  if (explicit !== undefined) {
    return explicit;
  }
  return autoDetectedPiiFields;
}

/**
 * Check whether a review apply operation is blocked by an approval gate.
 * Returns a result with `blocked: true` and a message when gated.
 */
export function checkApprovalGate(
  policy: ResolvedPolicy,
  decisionSource: 'human' | 'agent' | 'system'
): ApprovalGateResult {
  const gates = policy.approval_gates?.require_human_approval_for ?? [];

  if (gates.includes('all_agent_decisions') && decisionSource === 'agent') {
    return {
      blocked: true,
      reason:
        'Policy requires human approval for all agent decisions (approval_gates.require_human_approval_for includes "all_agent_decisions"). ' +
        'Re-apply with --decision-source human or update the policy file.',
    };
  }

  return { blocked: false };
}

/**
 * Check whether a high-impact merge decision is blocked.
 * High-impact merges are those that would merge clusters above a size threshold.
 */
export function checkHighImpactMergeGate(
  policy: ResolvedPolicy,
  clusterSize: number,
  highImpactThreshold = 10
): ApprovalGateResult {
  const gates = policy.approval_gates?.require_human_approval_for ?? [];

  if (gates.includes('high_impact_merge') && clusterSize >= highImpactThreshold) {
    return {
      blocked: true,
      reason:
        `Policy blocks high-impact merges (cluster size ${clusterSize} ≥ threshold ${highImpactThreshold}). ` +
        'Remove "high_impact_merge" from approval_gates.require_human_approval_for or apply with --decision-source human.',
    };
  }

  return { blocked: false };
}
