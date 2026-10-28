/**
 * Agent panel — multi-model consensus reviewer.
 *
 * A panel is a composite {@link LlmClient}: it fans a review-band pair out to a
 * first panel of model-role judges and, when they disagree, escalates the
 * aggregated rationales to a resolution panel that adjudicates which judges were
 * right. Unresolved pairs are deferred to a human. The panel still returns the
 * ordinary `PairDecision[]`, so the existing confidence gate, apply SQL, and
 * `__review_decisions` writeback are unchanged.
 *
 * This module is provider-agnostic: judges are injected as already-constructed
 * single-model `LlmClient`s. A host application builds the concrete
 * provider-backed judges (see `@bobsled-inc/ai`) and wires them in.
 */

import { runAgentReview } from './agent-review.js';

import type {
  AgentPolicy,
  AgentReviewOptions,
  LlmClient,
  PairContext,
  PairDecision,
  PanelConsensus,
  PanelJudge,
  PanelJudges,
  PanelJudgeLabel,
  PanelTrace,
  ResolvedPanelPolicy,
} from './types.js';

/**
 * Synthetic `PairContext.fields` key carrying the first panel's labels +
 * rationales into the resolution panel. The resolution judge's prompt keys off
 * this to render the dossier. Stripped of meaning by ordinary scoring code.
 */
export const FIRST_PANEL_CONTEXT_FIELD = '__first_panel';

/** Bound per-judge rationale length so a trace stays a sane SQL-literal size. */
const MAX_RATIONALE_CHARS = 600;

interface ConsensusVerdict {
  decision: PairDecision['decision'] | null;
  ratio: number;
  kind: 'unanimous' | 'majority' | 'split';
}

/**
 * Tally a tier's labels into a verdict.
 *
 * - `unanimous`: every judge must agree, else `split`.
 * - `majority`: a single label held by a strict majority (no tie), else `split`.
 *   A `defer` majority is a real `decision: 'defer'`, not a `split`.
 */
export function tallyConsensus(labels: PanelJudgeLabel[], mode: PanelConsensus): ConsensusVerdict {
  if (labels.length === 0) {
    return { decision: null, ratio: 0, kind: 'split' };
  }

  const counts = new Map<PairDecision['decision'], number>();
  for (const label of labels) {
    counts.set(label.label, (counts.get(label.label) ?? 0) + 1);
  }

  let maxCount = 0;
  for (const count of counts.values()) {
    if (count > maxCount) maxCount = count;
  }
  const leaders = [...counts.entries()].filter(([, count]) => count === maxCount);
  const winner = leaders[0]?.[0];
  if (winner == null) {
    return { decision: null, ratio: 0, kind: 'split' };
  }
  const ratio = Number((maxCount / labels.length).toFixed(4));

  if (mode === 'unanimous') {
    return maxCount === labels.length
      ? { decision: winner, ratio: 1, kind: 'unanimous' }
      : { decision: null, ratio, kind: 'split' };
  }

  // majority: one clear leader holding > 50%.
  if (leaders.length === 1 && maxCount * 2 > labels.length) {
    return { decision: winner, ratio, kind: ratio === 1 ? 'unanimous' : 'majority' };
  }
  return { decision: null, ratio, kind: 'split' };
}

/**
 * Derive the `PairDecision.confidence` from the winning tier and its agreement
 * ratio. `base * ratio` keeps a partial majority below a unanimous call, and a
 * resolution-panel agreement below a first-panel one — which is what routes the
 * decision through the existing confidence gate (unanimous first panel tends to
 * `applied`, resolution-resolved tends to `proposed` for human confirm).
 */
export function deriveConfidence(
  tier: 'first' | 'resolution',
  ratio: number,
  policy: ResolvedPanelPolicy
): number {
  const base = tier === 'first' ? policy.unanimousConfidence : policy.resolutionConfidence;
  return Number((base * ratio).toFixed(4));
}

function truncateRationale(rationale: string): string {
  return rationale.length > MAX_RATIONALE_CHARS
    ? `${rationale.slice(0, MAX_RATIONALE_CHARS)}…`
    : rationale;
}

function augmentPairWithFirstPanel(pair: PairContext, labels: PanelJudgeLabel[]): PairContext {
  const dossier = labels.map((label) => ({
    role: label.role,
    label: label.label,
    rationale: truncateRationale(label.rationale),
  }));
  return {
    ...pair,
    fields: {
      ...pair.fields,
      [FIRST_PANEL_CONTEXT_FIELD]: { a: JSON.stringify(dossier), b: '' },
    },
  };
}

function buildDecision(
  pair: PairContext,
  decision: PairDecision['decision'],
  confidence: number,
  trace: PanelTrace
): PairDecision {
  return { pairId: pair.pairId, decision, confidence, reasoning: JSON.stringify(trace) };
}

/**
 * Run every judge in a panel over the same pairs and collect one label per
 * (pair, judge). Unknown pair IDs and a judge's duplicate pair IDs are ignored
 * (first write wins) so a misbehaving judge can't double-count.
 */
async function collectPanelLabels(
  panel: PanelJudge[],
  pairs: PairContext[],
  options: AgentReviewOptions
): Promise<Map<string, PanelJudgeLabel[]>> {
  const knownPairIds = new Set(pairs.map((pair) => pair.pairId));
  const perJudge = await Promise.all(
    panel.map(async (judge) => ({
      judge,
      decisions: await judge.client.reviewPairs(pairs, { ...options, model: judge.role }),
    }))
  );

  const byPairId = new Map<string, PanelJudgeLabel[]>();
  for (const { judge, decisions } of perJudge) {
    const seen = new Set<string>();
    for (const decision of decisions) {
      if (!knownPairIds.has(decision.pairId) || seen.has(decision.pairId)) continue;
      seen.add(decision.pairId);
      const labels = byPairId.get(decision.pairId) ?? [];
      labels.push({
        role: judge.role,
        label: decision.decision,
        rationale: decision.reasoning,
        confidence: decision.confidence,
      });
      byPairId.set(decision.pairId, labels);
    }
  }
  return byPairId;
}

export interface AgentPanelClientInput {
  judges: PanelJudges;
  policy: ResolvedPanelPolicy;
}

/**
 * Core two-tier consensus over a batch of pairs. Returns one `PairDecision` per
 * input pair (consensus outcome, derived confidence, JSON panel trace).
 */
export async function runPanelReview(
  pairs: PairContext[],
  options: AgentReviewOptions,
  input: AgentPanelClientInput
): Promise<PairDecision[]> {
  const { judges, policy } = input;
  if (pairs.length === 0) return [];

  // --- Tier 1: every first-panel judge labels every pair. ---
  const firstLabelsByPair = await collectPanelLabels(judges.firstPanel, pairs, options);

  const results: PairDecision[] = [];
  const disagreed: Array<{
    pair: PairContext;
    firstLabels: PanelJudgeLabel[];
    firstVerdict: ConsensusVerdict;
  }> = [];

  for (const pair of pairs) {
    const firstLabels = firstLabelsByPair.get(pair.pairId) ?? [];
    const verdict = tallyConsensus(firstLabels, policy.consensus);
    if (verdict.decision !== null) {
      results.push(
        buildDecision(pair, verdict.decision, deriveConfidence('first', verdict.ratio, policy), {
          pairId: pair.pairId,
          firstPanel: firstLabels,
          firstPanelConsensus: verdict.kind,
          outcome: verdict.decision,
          resolvedAtTier: 'first',
          agreementRatio: verdict.ratio,
        })
      );
    } else {
      disagreed.push({ pair, firstLabels, firstVerdict: verdict });
    }
  }

  if (disagreed.length === 0) return results;

  // --- Tier 2: resolution panel adjudicates the first panel's rationales. ---
  const augmented = disagreed.map((entry) =>
    augmentPairWithFirstPanel(entry.pair, entry.firstLabels)
  );
  const resolutionLabelsByPair = await collectPanelLabels(
    judges.resolutionPanel,
    augmented,
    options
  );

  for (const { pair, firstLabels, firstVerdict } of disagreed) {
    const resolutionLabels = resolutionLabelsByPair.get(pair.pairId) ?? [];
    const verdict = tallyConsensus(resolutionLabels, policy.consensus);
    const resolved = verdict.decision !== null;
    const outcome: PairDecision['decision'] = verdict.decision ?? 'defer';
    results.push(
      buildDecision(
        pair,
        outcome,
        resolved ? deriveConfidence('resolution', verdict.ratio, policy) : 0,
        {
          pairId: pair.pairId,
          firstPanel: firstLabels,
          firstPanelConsensus: firstVerdict.kind,
          resolutionPanel: resolutionLabels,
          resolutionConsensus: verdict.kind,
          outcome,
          resolvedAtTier: resolved ? 'resolution' : 'unresolved',
          agreementRatio: verdict.ratio,
        }
      )
    );
  }

  return results;
}

/**
 * Wrap a panel as a drop-in {@link LlmClient}, so it slots into `runAgentReview`
 * exactly where the single-agent client would.
 */
export function createAgentPanelClient(
  judges: PanelJudges,
  policy: ResolvedPanelPolicy
): LlmClient {
  return {
    reviewPairs: (pairs, options) => runPanelReview(pairs, options, { judges, policy }),
  };
}

export interface ReviewWithPanelInput {
  pairs: PairContext[];
  /** Resolved agent policy; `policy.panel` selects panel behavior. */
  policy: AgentPolicy;
  /** Single-agent reviewer (used directly in `replace`-disabled and `escalate`). */
  singleAgentClient: LlmClient;
  /** Judges for the first and resolution panels. */
  judges: PanelJudges;
}

/**
 * Select the reviewer for the review band and run it, honoring `policy.panel`:
 *
 * - panel absent / disabled → single agent only.
 * - `replace` → panel reviews every pair.
 * - `escalate` → single agent runs first; only its `defer` or below-floor
 *   (`agentConfidenceFloor`) pairs are re-reviewed by the panel, whose call
 *   supersedes the single agent's for those pairs.
 *
 * All paths return `PairDecision[]` for the unchanged downstream gate + apply.
 */
export async function runReviewWithPanel(input: ReviewWithPanelInput): Promise<PairDecision[]> {
  const { pairs, policy, singleAgentClient, judges } = input;
  const panel = policy.panel;

  if (!panel?.enabled) {
    return (await runAgentReview({ pairs, policy, llmClient: singleAgentClient })).decisions;
  }

  const panelClient = createAgentPanelClient(judges, panel);

  if (panel.mode === 'replace') {
    return (await runAgentReview({ pairs, policy, llmClient: panelClient })).decisions;
  }

  // escalate: single agent first, panel only on its defer / low-confidence pairs.
  const floor = policy.agentConfidenceFloor ?? 0.5;
  const single = (await runAgentReview({ pairs, policy, llmClient: singleAgentClient })).decisions;
  const escalateIds = new Set(
    single
      .filter((decision) => decision.decision === 'defer' || decision.confidence < floor)
      .map((decision) => decision.pairId)
  );
  if (escalateIds.size === 0) return single;

  const escalatePairs = pairs.filter((pair) => escalateIds.has(pair.pairId));
  const escalated = (await runAgentReview({ pairs: escalatePairs, policy, llmClient: panelClient }))
    .decisions;
  const escalatedById = new Map(escalated.map((decision) => [decision.pairId, decision]));
  return single.map((decision) => escalatedById.get(decision.pairId) ?? decision);
}
