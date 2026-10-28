import {
  AGENT_THRESHOLD_BANDS,
  type AgentTaskMode,
  type AgentTaskOperation,
  type AgentThresholdBand,
} from './schema.js';
import type { ReviewDecisionRow } from '../identity/types.js';

export const AGENT_DECISION_BUNDLE_VERSION = 'entity_graph_decision_bundle.v1';
export const AGENT_TASK_RESULT_VERSION = 'entity_graph_agent_task_result.v1';
export const LEGACY_AGENT_DECISION_BUNDLE_VERSION = 'mdm_decision_bundle.v1';

export type AgentDecisionBundleVersion =
  | typeof AGENT_DECISION_BUNDLE_VERSION
  | typeof LEGACY_AGENT_DECISION_BUNDLE_VERSION;

export type AgentTaskStatus = 'ok' | 'needs_human' | 'blocked' | 'failed';

export type AgentNextAction =
  | 'triage'
  | 'onboard_generate'
  | 'onboard_verify'
  | 'run_resolution'
  | 'agent_review_batch'
  | 'cluster'
  | 'survivorship_refresh'
  | 'truthset_regress'
  | 'noop';

/**
 * Decision values accepted in a v1 bundle. The live decision union
 * (`ReviewDecisionRow['decision']`) is `merge | not_match | defer` — but
 * persisted v1 artifacts on disk may carry the legacy `escalate` value
 * from before the agent_confidence_floor split. We accept it here so old
 * bundles still validate, then normalize it to `defer` when materializing
 * to a `ReviewDecisionRow` (see `bundleToReviewDecisions`).
 */
type AgentDecisionBundleDecisionValue = ReviewDecisionRow['decision'] | 'escalate';

export interface AgentDecisionBundleDecision {
  pair_id: string;
  decision: AgentDecisionBundleDecisionValue;
  /**
   * Lifecycle status carried through the explorer → CLI round-trip.
   * Agent proposals serialize as `'proposed'` (or `'deferred'` when the
   * agent itself returned `defer`). Without this field, the parser
   * defaulted merge/not_match calls to `'applied'` — a P1 demo bug.
   */
  status?: ReviewDecisionRow['status'];
  reason?: string;
  confidence?: number;
  reviewer?: string;
  decided_at?: string;
  decision_batch_id?: string;
  decision_source?: string;
  applied_at?: string;
}

export interface AgentDecisionBundleV1 {
  version: AgentDecisionBundleVersion;
  entity: string;
  mode: AgentTaskMode;
  decision_source: string;
  learning_context?: string;
  /**
   * Precedent the agent cited when adjudicating this batch (e.g.
   * `decision_batch_id` / `pair_id` references returned by
   * `find_similar_decisions`). Folded into the warehouse audit_log trace.
   * Optional and back-compat — older bundles omit it.
   */
  precedent_refs?: string[];
  threshold_bands?: AgentThresholdBand[];
  limit?: number;
  decisions: AgentDecisionBundleDecision[];
}

export interface AgentTaskSummaryV1 {
  [key: string]: unknown;
}

export interface AgentTaskArtifactsV1 {
  [key: string]: unknown;
}

export interface AgentTaskResultV1 {
  version: typeof AGENT_TASK_RESULT_VERSION;
  command: string;
  operation: AgentTaskOperation;
  entity?: string;
  entities?: string[];
  mode?: AgentTaskMode;
  executed: boolean;
  status: AgentTaskStatus;
  summary: AgentTaskSummaryV1;
  recommended_next_action: AgentNextAction;
  artifacts: AgentTaskArtifactsV1;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isDecisionValue(value: unknown): value is AgentDecisionBundleDecisionValue {
  // `escalate` accepted for backward compatibility with v1 bundles written
  // before the defer/escalate collapse. Bumping the bundle version would
  // strand every persisted v1 artifact on disk; instead we accept it here
  // and normalize to `defer` in bundleToReviewDecisions.
  return value === 'merge' || value === 'not_match' || value === 'defer' || value === 'escalate';
}

// 'escalated' kept for backward compat with rows written before the
// agent_confidence_floor split. New code does not emit it.
const VALID_BUNDLE_STATUSES: ReadonlySet<NonNullable<ReviewDecisionRow['status']>> = new Set([
  'proposed',
  'applied',
  'deferred',
  'escalated',
  'superseded',
]);

function isStatusValue(value: unknown): value is NonNullable<ReviewDecisionRow['status']> {
  return (
    typeof value === 'string' &&
    VALID_BUNDLE_STATUSES.has(value as NonNullable<ReviewDecisionRow['status']>)
  );
}

/**
 * Reject impossible decision/status combinations (e.g. `merge + deferred` or
 * `defer + applied`). Validating each field independently lets bundles slip
 * through that downstream readers — queue, open-vs-decided filters, edge
 * projections — interpret incoherently. A `defer` decision must lifecycle
 * through `deferred` (or the legacy `escalated`); a `merge`/`not_match` call
 * must lifecycle through `proposed` / `applied` / `superseded`.
 */
function hasValidDecisionStatusPair(
  decision: AgentDecisionBundleDecisionValue,
  status: ReviewDecisionRow['status'] | undefined
): boolean {
  if (status == null) return true;
  // `escalate` is the legacy v1 spelling of `defer`; lifecycle-wise it
  // behaves identically.
  if (decision === 'defer' || decision === 'escalate') {
    // Defer rows are review-only; they should never carry an applied/proposed
    // lifecycle status.
    return status === 'deferred' || status === 'escalated' || status === 'superseded';
  }
  // merge / not_match calls are committed decisions; they must not carry a
  // deferred lifecycle status.
  return status !== 'deferred' && status !== 'escalated';
}

export function isAgentDecisionBundleV1(value: unknown): value is AgentDecisionBundleV1 {
  if (!isRecord(value)) {
    return false;
  }

  const isSupportedBundleVersion =
    value.version === AGENT_DECISION_BUNDLE_VERSION ||
    value.version === LEGACY_AGENT_DECISION_BUNDLE_VERSION;

  if (
    !isSupportedBundleVersion ||
    typeof value.entity !== 'string' ||
    (value.mode !== 'propose' && value.mode !== 'apply') ||
    typeof value.decision_source !== 'string' ||
    !Array.isArray(value.decisions)
  ) {
    return false;
  }

  if (
    value.threshold_bands != null &&
    (!Array.isArray(value.threshold_bands) ||
      value.threshold_bands.some(
        (band) => !AGENT_THRESHOLD_BANDS.includes(band as AgentThresholdBand)
      ))
  ) {
    return false;
  }

  if (
    value.limit != null &&
    (typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit <= 0)
  ) {
    return false;
  }

  if (value.learning_context != null && typeof value.learning_context !== 'string') {
    return false;
  }

  if (
    value.precedent_refs != null &&
    (!Array.isArray(value.precedent_refs) ||
      value.precedent_refs.some((ref) => typeof ref !== 'string'))
  ) {
    return false;
  }

  return value.decisions.every((decision) => {
    if (!isRecord(decision)) {
      return false;
    }

    if (typeof decision.pair_id !== 'string' || !isDecisionValue(decision.decision)) {
      return false;
    }

    if (decision.status != null && !isStatusValue(decision.status)) {
      return false;
    }

    if (
      !hasValidDecisionStatusPair(
        decision.decision,
        decision.status as ReviewDecisionRow['status'] | undefined
      )
    ) {
      return false;
    }

    if (decision.reason != null && typeof decision.reason !== 'string') {
      return false;
    }

    if (decision.confidence != null && typeof decision.confidence !== 'number') {
      return false;
    }

    if (decision.reviewer != null && typeof decision.reviewer !== 'string') {
      return false;
    }
    if (decision.decided_at != null && typeof decision.decided_at !== 'string') {
      return false;
    }
    if (decision.decision_batch_id != null && typeof decision.decision_batch_id !== 'string') {
      return false;
    }
    if (decision.decision_source != null && typeof decision.decision_source !== 'string') {
      return false;
    }
    if (decision.applied_at != null && typeof decision.applied_at !== 'string') {
      return false;
    }

    return true;
  });
}

export function bundleToReviewDecisions(bundle: AgentDecisionBundleV1): ReviewDecisionRow[] {
  return bundle.decisions.map((decision) => ({
    pair_id: decision.pair_id,
    // Normalize the legacy `escalate` value to `defer` at the boundary —
    // ReviewDecisionRow no longer carries `escalate`, but persisted v1
    // bundles may. Status normalization happens just below.
    decision: decision.decision === 'escalate' ? 'defer' : decision.decision,
    // Preserve the status the bundle producer set (e.g. agent proposals
    // arrive as 'proposed'). isAgentDecisionBundleV1 has already validated
    // the union, so we can pass it through verbatim.
    status: decision.status,
    reviewer: decision.reviewer ?? bundle.decision_source,
    reason: decision.reason,
    confidence: decision.confidence,
    decided_at: decision.decided_at,
    decision_batch_id: decision.decision_batch_id,
    decision_source: decision.decision_source ?? bundle.decision_source,
    applied_at: decision.applied_at,
  }));
}

export function buildAgentTaskResult(input: Omit<AgentTaskResultV1, 'version'>): AgentTaskResultV1 {
  return {
    version: AGENT_TASK_RESULT_VERSION,
    ...input,
  };
}
