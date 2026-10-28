import {
  isPlainObject,
  readBoolean,
  readNullableNumber,
  readNumber,
  readString,
  readStringArray,
} from './guards';
import {
  parseClaudeAgentAssessmentPayload,
  type ClaudeAgentAssessment,
} from './entity-graph-agent-sample';

export interface AgentReviewSelectionSummary {
  threshold_bands?: string[];
  limit?: number;
  pending_review_count?: number;
  re_evaluation_count?: number;
  duplicate_pair_count?: number;
}

export interface AgentReviewConfidenceBucket {
  count?: number;
  min?: number | null;
  max?: number | null;
  avg?: number | null;
}

export interface AgentReviewConfidenceDistribution {
  applied?: AgentReviewConfidenceBucket;
  deferred?: AgentReviewConfidenceBucket;
}

export interface AgentReviewProposedVsApplied {
  meets_threshold?: number;
  below_threshold?: number;
  avg_confidence_gap?: number | null;
}

export interface AgentReviewPostApplySummary {
  cluster?: boolean;
  survivorship?: boolean;
}

export interface AgentReviewTruthsetMetrics {
  matched_label_count?: number;
  missing_pair_count?: number;
  auto_merge_precision?: number;
  auto_merge_recall?: number;
  review_recall?: number;
  auto_reject_precision?: number;
}

export interface AgentReviewTruthsetSummary {
  required_precision?: number;
  current_metrics?: AgentReviewTruthsetMetrics;
}

export interface AgentReviewSummary {
  candidate_count?: number;
  decision_count?: number;
  actionable_decision_count?: number;
  applied_count?: number;
  merge_count?: number;
  not_match_count?: number;
  deferred_count?: number;
  // Number of agent calls (merge/not_match) parked in `__review_decisions`
  // with status='proposed', awaiting human confirmation. Emitted by the
  // CLI's commands/agent.ts and review.ts apply summary.
  proposed_count?: number;
  selection?: AgentReviewSelectionSummary;
  confidence_distribution?: AgentReviewConfidenceDistribution;
  proposed_vs_applied?: AgentReviewProposedVsApplied;
  decision_batch_id?: string;
  post_apply?: AgentReviewPostApplySummary;
  truthset?: AgentReviewTruthsetSummary | null;
}

export interface AgentReviewTaskResult {
  version: string;
  command: string;
  operation: string;
  entity?: string;
  mode?: string;
  executed: boolean;
  status: string;
  summary: AgentReviewSummary;
  recommended_next_action: string;
  artifacts: unknown;
  warnings: string[];
}

export interface AgentReviewRouteResponse {
  error?: string;
  detail?: string;
  code?: string;
  hint?: string;
  result?: AgentReviewTaskResult;
  assessments?: ClaudeAgentAssessment[];
  stderr?: string | null;
}

function parseSelectionSummary(value: unknown): AgentReviewSelectionSummary | undefined {
  if (!isPlainObject(value)) return undefined;

  return {
    threshold_bands: readStringArray(value.threshold_bands),
    limit: readNumber(value.limit),
    pending_review_count: readNumber(value.pending_review_count),
    re_evaluation_count: readNumber(value.re_evaluation_count),
    duplicate_pair_count: readNumber(value.duplicate_pair_count),
  };
}

function parseConfidenceBucket(value: unknown): AgentReviewConfidenceBucket | undefined {
  if (!isPlainObject(value)) return undefined;

  return {
    count: readNumber(value.count),
    min: readNullableNumber(value.min),
    max: readNullableNumber(value.max),
    avg: readNullableNumber(value.avg),
  };
}

function parseConfidenceDistribution(
  value: unknown
): AgentReviewConfidenceDistribution | undefined {
  if (!isPlainObject(value)) return undefined;

  return {
    applied: parseConfidenceBucket(value.applied),
    deferred: parseConfidenceBucket(value.deferred),
  };
}

function parseProposedVsApplied(value: unknown): AgentReviewProposedVsApplied | undefined {
  if (!isPlainObject(value)) return undefined;

  return {
    meets_threshold: readNumber(value.meets_threshold),
    below_threshold: readNumber(value.below_threshold),
    avg_confidence_gap: readNullableNumber(value.avg_confidence_gap),
  };
}

function parsePostApplySummary(value: unknown): AgentReviewPostApplySummary | undefined {
  if (!isPlainObject(value)) return undefined;

  return {
    cluster: readBoolean(value.cluster),
    survivorship: readBoolean(value.survivorship),
  };
}

function parseTruthsetMetrics(value: unknown): AgentReviewTruthsetMetrics | undefined {
  if (!isPlainObject(value)) return undefined;

  return {
    matched_label_count: readNumber(value.matched_label_count),
    missing_pair_count: readNumber(value.missing_pair_count),
    auto_merge_precision: readNumber(value.auto_merge_precision),
    auto_merge_recall: readNumber(value.auto_merge_recall),
    review_recall: readNumber(value.review_recall),
    auto_reject_precision: readNumber(value.auto_reject_precision),
  };
}

function parseTruthsetSummary(value: unknown): AgentReviewTruthsetSummary | undefined {
  if (!isPlainObject(value)) return undefined;

  return {
    required_precision: readNumber(value.required_precision),
    current_metrics: parseTruthsetMetrics(value.current_metrics),
  };
}

export function parseAgentReviewSummary(value: unknown): AgentReviewSummary | null {
  if (!isPlainObject(value)) return null;

  return {
    candidate_count: readNumber(value.candidate_count),
    decision_count: readNumber(value.decision_count),
    actionable_decision_count: readNumber(value.actionable_decision_count),
    applied_count: readNumber(value.applied_count),
    merge_count: readNumber(value.merge_count),
    not_match_count: readNumber(value.not_match_count),
    deferred_count: readNumber(value.deferred_count),
    proposed_count: readNumber(value.proposed_count),
    selection: parseSelectionSummary(value.selection),
    confidence_distribution: parseConfidenceDistribution(value.confidence_distribution),
    proposed_vs_applied: parseProposedVsApplied(value.proposed_vs_applied),
    decision_batch_id: readString(value.decision_batch_id),
    post_apply: parsePostApplySummary(value.post_apply),
    truthset: value.truthset === null ? null : parseTruthsetSummary(value.truthset),
  };
}

export function parseAgentReviewTaskResult(value: unknown): AgentReviewTaskResult | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const version = readString(value.version);
  const command = readString(value.command);
  const operation = readString(value.operation);
  const executed = readBoolean(value.executed);
  const status = readString(value.status);
  const summary = parseAgentReviewSummary(value.summary);
  const recommendedNextAction = readString(value.recommended_next_action);
  const warnings = readStringArray(value.warnings);

  if (
    version === undefined ||
    command === undefined ||
    operation === undefined ||
    executed === undefined ||
    status === undefined ||
    summary === null ||
    recommendedNextAction === undefined ||
    warnings === undefined ||
    !isPlainObject(value.artifacts)
  ) {
    return null;
  }

  return {
    version,
    command,
    operation,
    entity: readString(value.entity),
    mode: readString(value.mode),
    executed,
    status,
    summary,
    recommended_next_action: recommendedNextAction,
    artifacts: value.artifacts,
    warnings,
  };
}

export function parseAgentReviewRouteResponse(value: unknown): AgentReviewRouteResponse | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const parsedResult =
    value.result === undefined ? undefined : parseAgentReviewTaskResult(value.result);
  if (value.result !== undefined && parsedResult === null) {
    return null;
  }

  const stderrValue =
    value.stderr === null || typeof value.stderr === 'string' ? value.stderr : undefined;
  const assessments =
    value.assessments === undefined
      ? undefined
      : (parseClaudeAgentAssessmentPayload(value.assessments) ?? undefined);
  if (value.assessments !== undefined && assessments === undefined) {
    return null;
  }

  return {
    error: readString(value.error),
    detail: readString(value.detail),
    code: readString(value.code),
    hint: readString(value.hint),
    result: parsedResult ?? undefined,
    assessments,
    stderr: stderrValue,
  };
}
