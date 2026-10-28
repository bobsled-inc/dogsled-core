import { isPlainObject, readFiniteNumber, readString } from './guards';
import type { AgentReviewTaskResult } from './entity-graph-agent-review';

export type ClaudeAgentProposedDecision = 'merge' | 'not_match' | 'defer';

export interface ClaudeAgentAssessment {
  pair_id: string;
  proposed_decision: ClaudeAgentProposedDecision;
  proposed_confidence: number;
  assessment: string;
}

export interface QueueRowAgentProposal extends ClaudeAgentAssessment {
  decision_source: string;
  decision_batch_id: string | null;
}

export interface ParseClaudeAgentAssessmentPayloadOptions {
  allowedPairIds?: ReadonlySet<string>;
}

export interface AgentProposalDecisionRow {
  pair_id: string;
  decision: 'merge' | 'not_match' | 'defer';
  status: 'proposed' | 'deferred';
  reviewer: string;
  reason: string;
  proposed_decision: ClaudeAgentProposedDecision;
  proposed_confidence: number;
  decision_source: string;
  decision_batch_id: string;
}

export interface BuildAgentReviewSampleResultOptions {
  entity: string;
  limit: number;
  candidateCount: number;
  assessments: ClaudeAgentAssessment[];
  decisionBatchId?: string;
  warnings?: string[];
}

export const CLAUDE_AGENT_REVIEWER = 'claude-code-demo';
export const CLAUDE_AGENT_DECISION_SOURCE = 'claude_code_demo';
export const AGENT_SAMPLE_LIMIT = 10;

const PROPOSED_DECISIONS = new Set<ClaudeAgentProposedDecision>(['merge', 'not_match', 'defer']);

function readProposedDecision(value: unknown): ClaudeAgentProposedDecision | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return PROPOSED_DECISIONS.has(normalized as ClaudeAgentProposedDecision)
    ? (normalized as ClaudeAgentProposedDecision)
    : null;
}

export function clampAgentSampleLimit(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : AGENT_SAMPLE_LIMIT;
  if (!Number.isFinite(parsed)) return AGENT_SAMPLE_LIMIT;
  return Math.min(Math.max(Math.trunc(parsed), 1), AGENT_SAMPLE_LIMIT);
}

export function parseClaudeAgentAssessmentPayload(
  value: unknown,
  options?: ParseClaudeAgentAssessmentPayloadOptions
): ClaudeAgentAssessment[] | null {
  const rawAssessments = Array.isArray(value)
    ? value
    : isPlainObject(value) && Array.isArray(value.assessments)
      ? value.assessments
      : null;
  if (!rawAssessments) return null;

  const assessments = new Map<string, ClaudeAgentAssessment>();
  for (const raw of rawAssessments) {
    if (!isPlainObject(raw)) return null;

    const pairId = readString(raw.pair_id)?.trim();
    if (!pairId || (options?.allowedPairIds && !options.allowedPairIds.has(pairId))) {
      return null;
    }

    const proposedDecision = readProposedDecision(raw.proposed_decision);
    if (!proposedDecision) return null;

    const confidence = readFiniteNumber(raw.proposed_confidence);
    if (confidence === null || confidence < 0 || confidence > 1) return null;

    const assessment = readString(raw.assessment)?.trim();
    if (!assessment) return null;

    assessments.set(pairId, {
      pair_id: pairId,
      proposed_decision: proposedDecision,
      proposed_confidence: confidence,
      assessment,
    });
  }

  return [...assessments.values()];
}

export function buildAgentProposalDecisionRows(
  assessments: ClaudeAgentAssessment[],
  decisionBatchId: string
): AgentProposalDecisionRow[] {
  return assessments.map((assessment) => ({
    pair_id: assessment.pair_id,
    decision: assessment.proposed_decision,
    status: assessment.proposed_decision === 'defer' ? 'deferred' : 'proposed',
    reviewer: CLAUDE_AGENT_REVIEWER,
    reason: assessment.assessment,
    proposed_decision: assessment.proposed_decision,
    proposed_confidence: assessment.proposed_confidence,
    decision_source: CLAUDE_AGENT_DECISION_SOURCE,
    decision_batch_id: decisionBatchId,
  }));
}

export function buildAgentReviewSampleResult(
  options: BuildAgentReviewSampleResultOptions
): AgentReviewTaskResult {
  const { assessments, candidateCount, decisionBatchId, entity, limit, warnings = [] } = options;
  const noCandidates = candidateCount === 0;
  let mergeCount = 0;
  let notMatchCount = 0;
  let deferredCount = 0;
  for (const assessment of assessments) {
    if (assessment.proposed_decision === 'merge') mergeCount += 1;
    else if (assessment.proposed_decision === 'not_match') notMatchCount += 1;
    else if (assessment.proposed_decision === 'defer') deferredCount += 1;
  }
  return {
    version: 'entity_graph_agent_review_sample.v1',
    command: 'agent-review.sample',
    operation: 'claude_code_demo_sample',
    entity,
    mode: 'propose',
    executed: !noCandidates,
    status: noCandidates ? 'no_candidates' : 'proposals_saved',
    summary: {
      candidate_count: candidateCount,
      decision_count: assessments.length,
      merge_count: mergeCount,
      not_match_count: notMatchCount,
      deferred_count: deferredCount,
      selection: {
        threshold_bands: ['review'],
        limit,
        pending_review_count: candidateCount,
      },
      decision_batch_id: decisionBatchId,
    },
    recommended_next_action: noCandidates ? 'noop' : 'agent_review',
    artifacts: {
      agent_assessments: assessments,
    },
    warnings,
  };
}

export function readAgentProposalFromQueueRow(row: unknown): QueueRowAgentProposal | null {
  if (!isPlainObject(row)) return null;
  const decisionSource = readString(row.decision_source);
  if (decisionSource !== CLAUDE_AGENT_DECISION_SOURCE) return null;

  const pairId = readString(row.pair_id)?.trim();
  const proposedDecision = readProposedDecision(row.proposed_decision);
  const proposedConfidence = readFiniteNumber(row.proposed_confidence);
  const assessment = readString(row.decision_reason)?.trim();
  if (
    !pairId ||
    !proposedDecision ||
    proposedConfidence === null ||
    proposedConfidence < 0 ||
    proposedConfidence > 1 ||
    !assessment
  ) {
    return null;
  }

  return {
    pair_id: pairId,
    proposed_decision: proposedDecision,
    proposed_confidence: proposedConfidence,
    assessment,
    decision_source: decisionSource,
    decision_batch_id: readString(row.decision_batch_id) ?? null,
  };
}

export function getClaudeFailureHttpStatus(code: string | undefined): number {
  if (code === 'unavailable' || code === 'auth') return 503;
  if (code === 'timeout') return 504;
  return 500;
}
