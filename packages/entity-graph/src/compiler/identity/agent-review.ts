/**
 * Agent review primitive — LLM-driven pair review.
 *
 * Open-source component that reads __review_queue, invokes an
 * injectable LlmClient, and writes decisions to __review_decisions.
 * A host application can inject a richer client with monitoring,
 * caching, and cross-customer learning.
 */

import { randomUUID } from 'node:crypto';

import { AGENT_THRESHOLD_BANDS, type AgentThresholdBand } from '../agent/schema.js';
import { quoteLiteral, buildFqName, quoteIdentifier } from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type {
  AgentPolicy,
  AgentReviewOptions,
  LlmClient,
  PairContext,
  PairDecision,
  SqlStatement,
} from './types.js';
import { outputTableName } from '../output-tables/index.js';

interface AgentDecisionSqlOptions {
  mode?: 'propose' | 'apply';
  /**
   * Confidence threshold above which an apply-mode call is committed as
   * `applied`. Required because the previous optional shape silently routed
   * every call to `applied` when undefined — a footgun. Callers without an
   * explicit threshold should pass `0.85` (the legacy default).
   */
  autoApplyThreshold: number;
  thresholdBandByPairId?: Record<string, AgentThresholdBand>;
  decisionSource?: string;
  reviewer?: string;
}

interface PreparedDecisionRow {
  pairId: string;
  decision: PairDecision['decision'];
  reviewer: string;
  reasoning: string;
  confidence?: number;
  proposedDecision?: PairDecision['decision'];
  proposedConfidence?: number;
  // 'escalated' kept for backward compat with rows written before the
  // agent_confidence_floor split. New code does not emit it.
  status: 'proposed' | 'applied' | 'deferred' | 'escalated';
}

// ---------------------------------------------------------------------------
// Metrics tracking
// ---------------------------------------------------------------------------

export interface AgentReviewMetrics {
  pairsReviewed: number;
  pairsMerged: number;
  pairsRejected: number;
  costUsd: number;
  tokensUsed: number;
  pairsRemaining: number;
}

// ---------------------------------------------------------------------------
// Agent review execution
// ---------------------------------------------------------------------------

export interface AgentReviewInput {
  pairs: PairContext[];
  policy: AgentPolicy;
  llmClient: LlmClient;
}

export interface AgentReviewResult {
  decisions: PairDecision[];
  metrics: AgentReviewMetrics;
  costCeilingReached: boolean;
}

/**
 * Run agent review on a batch of pairs.
 *
 * Respects max_pairs_per_run and max_cost_usd limits.
 * Returns decisions and metrics for the run.
 */
export async function runAgentReview(input: AgentReviewInput): Promise<AgentReviewResult> {
  const { pairs, policy, llmClient } = input;
  const batchSize = policy.batchSize ?? 100;
  const maxPairs = policy.maxPairsPerRun ?? pairs.length;
  const costCeiling = policy.maxCostUsd ?? Infinity;

  const allDecisions: PairDecision[] = [];
  let totalCost = 0;
  let totalTokens = 0;
  let costCeilingReached = false;

  // Limit to max_pairs_per_run
  const pairsToProcess = pairs.slice(0, maxPairs);

  // Process in batches
  for (let i = 0; i < pairsToProcess.length; i += batchSize) {
    const batch = pairsToProcess.slice(i, i + batchSize);

    const options: AgentReviewOptions = {
      model: policy.legacyModel,
      batchSize,
      tokenBudgetPerPair: policy.tokenBudgetPerPair,
      promptTemplate: policy.promptTemplate,
      contextFields: policy.contextFields,
    };

    const decisions = await llmClient.reviewPairs(batch, options);
    allDecisions.push(...decisions);

    // Update metrics (cost tracking is approximate — LlmClient may provide exact values)
    const batchMerged = decisions.filter((d) => d.decision === 'merge').length;
    const batchRejected = decisions.filter((d) => d.decision === 'not_match').length;
    totalCost += batchMerged * 0.001 + batchRejected * 0.001; // Placeholder cost estimate
    totalTokens += batch.length * (policy.tokenBudgetPerPair ?? 2000);

    // Check cost ceiling
    if (totalCost >= costCeiling) {
      costCeilingReached = true;
      break;
    }
  }

  const metrics: AgentReviewMetrics = {
    pairsReviewed: allDecisions.length,
    pairsMerged: allDecisions.filter((d) => d.decision === 'merge').length,
    pairsRejected: allDecisions.filter((d) => d.decision === 'not_match').length,
    costUsd: totalCost,
    tokensUsed: totalTokens,
    pairsRemaining: pairs.length - allDecisions.length,
  };

  return { decisions: allDecisions, metrics, costCeilingReached };
}

// ---------------------------------------------------------------------------
// SQL generation for agent decisions
// ---------------------------------------------------------------------------

/**
 * Generate SQL to INSERT agent review decisions into __review_decisions
 * and __not_match_edges.
 */
export function generateAgentDecisionSql(
  decisions: PairDecision[],
  entityName: string,
  dialect: SupportedDialect,
  targetSchema: string,
  options: AgentDecisionSqlOptions
): SqlStatement[] {
  const statements: SqlStatement[] = [];
  if (decisions.length === 0) return statements;

  const decisionsTable = buildFqName(
    targetSchema,
    outputTableName(entityName, '__review_decisions'),
    dialect
  );

  const pairIdCol = quoteIdentifier('pair_id', dialect);
  const decisionCol = quoteIdentifier('decision', dialect);
  const reviewerCol = quoteIdentifier('reviewer', dialect);
  const reasonCol = quoteIdentifier('reason', dialect);
  const confidenceCol = quoteIdentifier('confidence', dialect);
  const proposedDecisionCol = quoteIdentifier('proposed_decision', dialect);
  const proposedConfidenceCol = quoteIdentifier('proposed_confidence', dialect);
  const statusCol = quoteIdentifier('status', dialect);
  const decidedAtCol = quoteIdentifier('decided_at', dialect);
  const batchIdCol = quoteIdentifier('decision_batch_id', dialect);
  const sourceCol = quoteIdentifier('decision_source', dialect);
  const mode = options.mode ?? 'apply';
  const reviewer = options.reviewer ?? 'agent';
  const decisionSource = options.decisionSource ?? 'agent_auto';
  const preparedDecisions = decisions.map((decision) =>
    prepareDecisionRow(decision, mode, {
      autoApplyThreshold: options.autoApplyThreshold,
      reviewer,
    })
  );

  // Generate a batch ID for this set of agent decisions
  const batchId = randomUUID();

  // INSERT into __review_decisions
  const values = preparedDecisions
    .map(
      (d) =>
        `(${quoteLiteral(d.pairId, dialect)}, ${quoteLiteral(d.decision, dialect)}, ${quoteLiteral(d.reviewer, dialect)}, ${quoteLiteral(d.reasoning, dialect)}, ${d.confidence != null ? quoteLiteral(d.confidence, dialect) : 'NULL'}, ${d.proposedDecision ? quoteLiteral(d.proposedDecision, dialect) : 'NULL'}, ${d.proposedConfidence != null ? quoteLiteral(d.proposedConfidence, dialect) : 'NULL'}, ${quoteLiteral(d.status, dialect)}, CURRENT_TIMESTAMP, ${quoteLiteral(batchId, dialect)}, ${quoteLiteral(decisionSource, dialect)})`
    )
    .join(',\n');

  statements.push({
    name: 'agent_review_decisions',
    sql: [
      `INSERT INTO ${decisionsTable}`,
      `  (${pairIdCol}, ${decisionCol}, ${reviewerCol}, ${reasonCol}, ${confidenceCol}, ${proposedDecisionCol}, ${proposedConfidenceCol}, ${statusCol}, ${decidedAtCol}, ${batchIdCol}, ${sourceCol})`,
      `VALUES`,
      values,
    ].join('\n'),
  });

  // INSERT not_match into __not_match_edges
  const notMatch = preparedDecisions.filter(
    (d) => d.decision === 'not_match' && d.status === 'applied'
  );
  if (notMatch.length > 0) {
    const edgesTable = buildFqName(
      targetSchema,
      outputTableName(entityName, '__not_match_edges'),
      dialect
    );
    const queueTable = buildFqName(
      targetSchema,
      outputTableName(entityName, '__review_queue'),
      dialect
    );

    const recordAIdCol = quoteIdentifier('record_a_id', dialect);
    const recordBIdCol = quoteIdentifier('record_b_id', dialect);

    const pairIds = notMatch.map((d) => quoteLiteral(d.pairId, dialect)).join(', ');

    statements.push({
      name: 'agent_not_match_edges',
      sql: [
        `INSERT INTO ${edgesTable}`,
        `  (${pairIdCol}, ${recordAIdCol}, ${recordBIdCol}, ${reviewerCol}, ${reasonCol}, ${decidedAtCol}, ${confidenceCol})`,
        `SELECT`,
        `  d.${pairIdCol},`,
        `  rq.${recordAIdCol},`,
        `  rq.${recordBIdCol},`,
        `  ${quoteLiteral(reviewer, dialect)},`,
        `  d.${reasonCol},`,
        `  d.${decidedAtCol},`,
        `  d.${confidenceCol}`,
        `FROM ${decisionsTable} d`,
        `JOIN ${queueTable} rq ON d.${pairIdCol} = rq.${pairIdCol}`,
        `WHERE d.${reviewerCol} = ${quoteLiteral(reviewer, dialect)}`,
        `  AND d.${pairIdCol} IN (${pairIds})`,
        `  AND d.${batchIdCol} = ${quoteLiteral(batchId, dialect)}`,
      ].join('\n'),
    });
  }

  return statements;
}

/**
 * Generate the query to read unreviewed pairs from __review_queue.
 *
 * Ordering is stable (composite_score, then pair_id) so batches are
 * deterministic across runs — part of the agent-review determinism posture.
 */
export function generateUnreviewedPairsQuery(
  entityName: string,
  dialect: SupportedDialect,
  targetSchema: string,
  options: {
    /** Bands to include; defaults to every agent-reviewable band. */
    thresholdBands?: readonly AgentThresholdBand[];
    /** Cap the number of returned pairs (e.g. agent_policy.max_pairs_per_run). */
    limit?: number;
  } = {}
): string {
  const queueTable = buildFqName(
    targetSchema,
    outputTableName(entityName, '__review_queue'),
    dialect
  );
  const decisionsTable = buildFqName(
    targetSchema,
    outputTableName(entityName, '__review_decisions'),
    dialect
  );
  const pairId = quoteIdentifier('pair_id', dialect);
  const thresholdBand = quoteIdentifier('threshold_band', dialect);
  const bands = options.thresholdBands ?? AGENT_THRESHOLD_BANDS;
  const limit = options.limit;
  if (limit != null && (!Number.isInteger(limit) || limit < 0)) {
    throw new Error(`Invalid limit ${limit}. Expected a non-negative integer.`);
  }

  return [
    `SELECT rq.*`,
    `FROM ${queueTable} rq`,
    `WHERE rq.${thresholdBand} IN (${bands.map((band) => quoteLiteral(band, dialect)).join(', ')})`,
    `  AND NOT EXISTS (`,
    `    SELECT 1 FROM ${decisionsTable} d WHERE d.${pairId} = rq.${pairId}`,
    `  )`,
    `ORDER BY rq.${quoteIdentifier('composite_score', dialect)} ASC, rq.${pairId} ASC`,
    ...(limit != null ? [`LIMIT ${quoteLiteral(limit, dialect)}`] : []),
  ].join('\n');
}

/**
 * Emit METRIC messages to stderr in the expected format.
 */
export function formatMetrics(metrics: AgentReviewMetrics): string {
  return JSON.stringify({
    type: 'METRIC',
    metric: 'agent_review',
    data: {
      pairs_reviewed: metrics.pairsReviewed,
      pairs_merged: metrics.pairsMerged,
      pairs_rejected: metrics.pairsRejected,
      cost_usd: metrics.costUsd,
      tokens_used: metrics.tokensUsed,
      pairs_remaining: metrics.pairsRemaining,
    },
  });
}

function prepareDecisionRow(
  decision: PairDecision,
  mode: 'propose' | 'apply',
  options: {
    autoApplyThreshold: number;
    reviewer: string;
  }
): PreparedDecisionRow {
  // Three-tier outcome:
  //   1. Agent itself returned `defer` (its own confidence floor) →
  //      status='deferred', decision='defer'. This is the only path
  //      that produces a deferred row — the system never rewrites a
  //      committed agent call to `defer`.
  //   2. Apply mode + confidence below auto-apply threshold (or
  //      propose mode) → status='proposed', with the agent's actual
  //      call preserved on `decision`. proposedDecision /
  //      proposedConfidence carry the same values as evidence for
  //      reviewers, who can one-click confirm or override.
  //   3. Apply mode + confidence at/above auto-apply threshold →
  //      status='applied', decision=<agent's call>.
  if (decision.decision === 'defer') {
    return {
      pairId: decision.pairId,
      decision: 'defer',
      reviewer: options.reviewer,
      reasoning: decision.reasoning,
      confidence: decision.confidence,
      status: 'deferred',
    };
  }

  if (mode === 'propose') {
    return {
      pairId: decision.pairId,
      decision: decision.decision,
      reviewer: options.reviewer,
      reasoning: decision.reasoning,
      confidence: decision.confidence,
      proposedDecision: decision.decision,
      proposedConfidence: decision.confidence,
      status: 'proposed',
    };
  }

  const meetsThreshold =
    decision.confidence != null && decision.confidence >= options.autoApplyThreshold;

  if (!meetsThreshold) {
    // Preserve the agent's actual call (merge / not_match) — the
    // system no longer rewrites to `defer`. Surface it as `proposed`
    // so reviewers can confirm or override.
    return {
      pairId: decision.pairId,
      decision: decision.decision,
      reviewer: options.reviewer,
      reasoning: decision.reasoning,
      confidence: decision.confidence,
      proposedDecision: decision.decision,
      proposedConfidence: decision.confidence,
      status: 'proposed',
    };
  }

  return {
    pairId: decision.pairId,
    decision: decision.decision,
    reviewer: options.reviewer,
    reasoning: decision.reasoning,
    confidence: decision.confidence,
    status: 'applied',
  };
}
