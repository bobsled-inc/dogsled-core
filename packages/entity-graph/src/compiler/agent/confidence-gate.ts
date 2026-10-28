/**
 * Confidence-gating for agent decision bundles.
 *
 * Extracted verbatim from `commands/agent.ts` so both the `agent review-batch`
 * CLI handler and the programmatic `applyReviewDecisions` API
 * (`api/apply-decisions.ts`, used by a host application's out-of-band
 * entity-resolution reviewer) share one implementation of the three-tier
 * apply / propose / defer gate. Behavior is identical to the CLI original.
 */
import type { AgentDecisionBundleV1 } from './types.js';
import type { AgentThresholdBand } from './schema.js';

/**
 * Minimal config surface the gate reads. `ReviewBatchResolvedConfig`
 * (commands/agent-support.ts) is structurally assignable, so the CLI passes
 * its full config object through unchanged.
 */
export interface ConfidenceGateConfig {
  decisionSource: string;
  autoApplyThreshold: number;
}

/** Min / max / avg (4dp) over a confidence sample; all-null for an empty set. */
export function summarizeConfidence(values: number[]): {
  count: number;
  min: number | null;
  max: number | null;
  avg: number | null;
} {
  if (values.length === 0) {
    return { count: 0, min: null, max: null, avg: null };
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    count: values.length,
    min: Number(min.toFixed(4)),
    max: Number(max.toFixed(4)),
    avg: Number(avg.toFixed(4)),
  };
}

/**
 * Route each bundle decision into an `applied` / `proposed` / `deferred` row.
 *
 * `defer` → `deferred`; a committed `merge`/`not_match` with confidence at or
 * above `config.autoApplyThreshold` → `applied`, below → `proposed` (preserved
 * for one-click human confirmation). Also returns per-tier counts, confidence
 * distributions, and warnings (below-threshold count, missing threshold bands).
 */
export function buildConfidenceGatedDecisionRows(
  bundle: AgentDecisionBundleV1,
  config: ConfidenceGateConfig,
  decisionBatchId: string,
  thresholdBandByPairId: Map<string, AgentThresholdBand>
): {
  decisionRows: Array<{
    pair_id: string;
    decision: 'merge' | 'not_match' | 'defer';
    status: 'applied' | 'deferred' | 'proposed';
    reviewer: string;
    reason?: string;
    confidence?: number;
    proposed_decision?: 'merge' | 'not_match' | 'defer';
    proposed_confidence?: number;
    decision_batch_id: string;
    decision_source: string;
  }>;
  actionableCount: number;
  pendingCount: number;
  deferredCount: number;
  proposedCount: number;
  mergeCount: number;
  notMatchCount: number;
  warnings: string[];
  confidenceDistribution: {
    applied: ReturnType<typeof summarizeConfidence>;
    deferred: ReturnType<typeof summarizeConfidence>;
  };
  proposedVsApplied: {
    meetsThreshold: number;
    belowThreshold: number;
    avgConfidenceGap: number | null;
  };
} {
  let belowThresholdCount = 0;
  let thresholdMetCount = 0;
  const confidenceGaps: number[] = [];
  const missingThresholdBandPairIds = new Set<string>();

  // Three-tier outcome per decision:
  //   * Agent returned `defer` → status=`deferred`, decision=`defer`.
  //   * Agent committed (merge/not_match) but confidence below
  //     auto-apply threshold → status=`proposed`, decision preserves
  //     the agent's call. The agent's call survives so a human can
  //     one-click confirm or override.
  //   * Agent committed and confidence meets threshold → status=`applied`.
  //
  // The bundle's decision union also includes the legacy `escalate` value
  // for backward compat (see AgentDecisionBundleDecisionValue). Normalize
  // it to `defer` at the top of the loop so the rest of the runtime only
  // ever sees the live three-value union.
  const decisionRows = bundle.decisions.map((decisionRaw) => {
    const decision: typeof decisionRaw & {
      decision: 'merge' | 'not_match' | 'defer';
    } = {
      ...decisionRaw,
      decision: decisionRaw.decision === 'escalate' ? 'defer' : decisionRaw.decision,
    };
    if (decision.decision === 'defer') {
      return {
        pair_id: decision.pair_id,
        decision: decision.decision,
        status: 'deferred' as const,
        reviewer: config.decisionSource,
        reason: decision.reason,
        confidence: decision.confidence,
        decision_batch_id: decisionBatchId,
        decision_source: config.decisionSource,
      };
    }

    const thresholdBand = thresholdBandByPairId.get(decision.pair_id);
    if (thresholdBand == null) {
      missingThresholdBandPairIds.add(decision.pair_id);
    }
    const requiredConfidence = config.autoApplyThreshold;
    const meetsThreshold = decision.confidence != null && decision.confidence >= requiredConfidence;
    if (meetsThreshold) {
      thresholdMetCount += 1;
    }

    if (meetsThreshold) {
      return {
        pair_id: decision.pair_id,
        decision: decision.decision,
        status: 'applied' as const,
        reviewer: config.decisionSource,
        reason: decision.reason,
        confidence: decision.confidence,
        decision_batch_id: decisionBatchId,
        decision_source: config.decisionSource,
      };
    }

    belowThresholdCount += 1;
    if (decision.confidence != null) {
      confidenceGaps.push(Number((requiredConfidence - decision.confidence).toFixed(4)));
    }

    return {
      pair_id: decision.pair_id,
      decision: decision.decision,
      status: 'proposed' as const,
      reviewer: config.decisionSource,
      reason: decision.reason,
      confidence: decision.confidence,
      proposed_decision: decision.decision,
      proposed_confidence: decision.confidence,
      decision_batch_id: decisionBatchId,
      decision_source: config.decisionSource,
    };
  });

  const actionable = decisionRows.filter(
    (decisionRow) =>
      decisionRow.status === 'applied' &&
      (decisionRow.decision === 'merge' || decisionRow.decision === 'not_match')
  );
  const pending = decisionRows.filter(
    (decisionRow) => decisionRow.status === 'deferred' || decisionRow.status === 'proposed'
  );
  const deferred = pending.filter((decisionRow) => decisionRow.status === 'deferred');
  const proposed = pending.filter((decisionRow) => decisionRow.status === 'proposed');
  const warnings: string[] = [];
  if (belowThresholdCount > 0) {
    warnings.push(
      `${belowThresholdCount} decision(s) fell below their apply confidence floor and were persisted as proposed for human confirmation.`
    );
  }
  if (missingThresholdBandPairIds.size > 0) {
    warnings.push(
      `Missing threshold_band metadata for ${missingThresholdBandPairIds.size} decision(s); defaulted to auto_apply_threshold for pair_id(s): ${Array.from(
        missingThresholdBandPairIds
      )
        .sort()
        .join(', ')}.`
    );
  }

  return {
    decisionRows,
    actionableCount: actionable.length,
    pendingCount: pending.length,
    deferredCount: deferred.length,
    proposedCount: proposed.length,
    mergeCount: actionable.filter((decisionRow) => decisionRow.decision === 'merge').length,
    notMatchCount: actionable.filter((decisionRow) => decisionRow.decision === 'not_match').length,
    warnings,
    confidenceDistribution: {
      applied: summarizeConfidence(
        actionable.flatMap((decisionRow) =>
          decisionRow.confidence != null ? [decisionRow.confidence] : []
        )
      ),
      deferred: summarizeConfidence(
        pending.flatMap((decisionRow) => {
          const value = decisionRow.proposed_confidence ?? decisionRow.confidence;
          return value != null ? [value] : [];
        })
      ),
    },
    proposedVsApplied: {
      meetsThreshold: thresholdMetCount,
      belowThreshold: belowThresholdCount,
      avgConfidenceGap:
        confidenceGaps.length === 0
          ? null
          : Number(
              (
                confidenceGaps.reduce((sum, confidenceGap) => sum + confidenceGap, 0) /
                confidenceGaps.length
              ).toFixed(4)
            ),
    },
  };
}
