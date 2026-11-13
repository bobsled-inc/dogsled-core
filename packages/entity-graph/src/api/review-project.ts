/**
 * Agent review phase — `reviewResolveProject`.
 *
 * The separately callable review step between `runResolveProject` (threshold
 * routing fills `__review_queue`) and `clusterResolveProject` (applied merges
 * fold into golden records). Fetches the unreviewed gray-zone pairs, runs a
 * swappable judge over them, and writes the decisions through the existing
 * `applyReviewDecisions` gate. `resolve run`'s default behavior is untouched.
 *
 * Judge selection (`selectJudge`) — the `agent_policy.judge` tier picks the lane
 * (cross-repo contract §5); a host-injected `llmClient` always wins first as the
 * programmatic/test escape hatch:
 *   - host-injected `llmClient` — wins over every config-driven judge, including
 *     a pinned `judge` tier (works even when `agent_policy` is absent)
 *   - `judge: 'model'` — pin the in-Dogsled model judge; `reviewerOverride` AND
 *     `agent_policy.reviewer` are ignored (a host cannot upgrade a pinned-model
 *     entity — an ignored override is warned about)
 *   - `judge: 'agent'` — require an external transport (`reviewerOverride` >
 *     `agent_policy.reviewer`); with neither, skip with `no_judge_configured` +
 *     a warning naming the missing piece — never fall back to the model judge
 *   - `judge` absent (default ⇒ model): today's precedence unchanged — external
 *     transport (override > spec) when present, else the model judge / panel
 *
 * Config-driven judges, once the lane is picked:
 *   - external transport — `createExternalReviewerClient` (override wins over spec)
 *   - `agent_policy.model` — in-Dogsled model judge (`createModelReviewLlmClient`),
 *     composed with `agent_policy.panel` via `runReviewWithPanel` when enabled
 *   - `agent_policy.panel` alone (mode `replace`) — panel of model-role judges
 *
 * Fail-soft: judge/infra errors are captured per entity as `failure` +
 * warnings (`executed: false`) and never throw — undecided pairs simply stay
 * in the queue. Spec/config validation errors still throw `CommandError`.
 */

import type { CustomRunnerRegistry } from '@bobsled-inc/connections';
import { CommandError } from '@bobsled-inc/protocol';

import type { SqlQueryRunner, SupportedDialect } from '@bobsled-inc/model-spec';
import { AGENT_THRESHOLD_BANDS } from '../compiler/agent/schema.js';
import type {
  AgentDecisionBundleDecision,
  AgentDecisionBundleV1,
} from '../compiler/agent/types.js';
import { runAgentReview, type AgentReviewMetrics } from '../compiler/identity/agent-review.js';
import { fetchUnreviewedPairContexts } from '../compiler/identity/agent-review-fetch.js';
import { runReviewWithPanel } from '../compiler/identity/agent-panel.js';
import {
  buildExtractLearningsQuery,
  formatLearningsSummary,
  LearningRowsSchema,
} from '../compiler/identity/learnings.js';
import type {
  AgentPolicy,
  LlmClient,
  PairContext,
  PairDecision,
  PanelJudge,
  ResolvedResolutionSpec,
  ReviewerConfig,
} from '../compiler/identity/types.js';
import { buildSecretResolver } from '@bobsled-inc/model-spec/project';
import {
  loadEntityGraphProjectContext,
  type EntityGraphProjectOptions,
} from '../runtime/project-context.js';
import { resolveEntityGraphRunner } from '../runtime/runner-resolver.js';
import { applyReviewDecisions } from './apply-decisions.js';
import { createExternalReviewerClient } from './external-reviewer-client.js';
import { createModelReviewLlmClient, type ModelReviewLlmClient } from './model-review-client.js';
import type { ResolveWorkflowFailure } from './resolve-project.js';

export interface ReviewResolveProjectOptions extends EntityGraphProjectOptions {
  /** Direct path to a SQL runner module. Wins over `customRunners`. */
  runner?: string;
  /** Secrets file path forwarded to the integration secret resolver. */
  secrets?: string;
  /** In-memory runner registry keyed by `(source_type, auth_type)`. */
  customRunners?: CustomRunnerRegistry;
  /** Shell command printing a fresh access token (see `ResolveWorkflowOptions`). */
  credentialsTokenCommand?: string;
  /** Host-injected judge override — wins over every config-driven judge. */
  llmClient?: LlmClient;
  /**
   * Host-injected external-reviewer transport config (Option 2, managed
   * path). Wins over the spec's `agent_policy.reviewer`; decisions from
   * either land with `decision_source: 'agent'` (cross-repo contract §4).
   */
  reviewerOverride?: ReviewerConfig;
  /** Override the spec's `agent_policy.max_pairs_per_run` cap. */
  maxPairsPerRun?: number;
  /** Judge runs, decisions are NOT applied; the gated bundle is returned. */
  dryRun?: boolean;
  /** Decision-trace ("why") context persisted into the warehouse audit_log. */
  decisionTrace?: {
    policyVersion?: string;
    configSnapshot?: Record<string, unknown>;
    langsmithTraceId?: string;
    precedentRefs?: string[];
  };
}

export interface ReviewResolveProjectResult {
  entity: string;
  executed: boolean;
  skipped_reason?: 'agent_policy_disabled' | 'queue_empty' | 'no_judge_configured';
  pairs_fetched: number;
  metrics: AgentReviewMetrics;
  applied_count: number;
  proposed_count: number;
  deferred_count: number;
  decision_batch_id?: string;
  /** The gated decision bundle; present on dryRun. */
  bundle?: AgentDecisionBundleV1;
  warnings: string[];
  /** Judge-infra failure captured here — the run is NOT failed. */
  failure?: ResolveWorkflowFailure;
}

/** In-Dogsled model judge decisions land as `agent_auto` (cross-repo contract §4). */
const MODEL_JUDGE_DECISION_SOURCE = 'agent_auto';
/** External reviewer decisions land as `agent` (cross-repo contract §4). */
const EXTERNAL_REVIEWER_DECISION_SOURCE = 'agent';

type ReviewDecisionSource =
  typeof MODEL_JUDGE_DECISION_SOURCE | typeof EXTERNAL_REVIEWER_DECISION_SOURCE;

function emptyMetrics(pairsRemaining = 0): AgentReviewMetrics {
  return {
    pairsReviewed: 0,
    pairsMerged: 0,
    pairsRejected: 0,
    costUsd: 0,
    tokensUsed: 0,
    pairsRemaining,
  };
}

function skippedResult(
  entity: string,
  reason: NonNullable<ReviewResolveProjectResult['skipped_reason']>,
  warnings: string[],
  pairsFetched = 0
): ReviewResolveProjectResult {
  return {
    entity,
    executed: false,
    skipped_reason: reason,
    pairs_fetched: pairsFetched,
    metrics: emptyMetrics(pairsFetched),
    applied_count: 0,
    proposed_count: 0,
    deferred_count: 0,
    warnings,
  };
}

function failedResult(
  entity: string,
  stage: string,
  error: unknown,
  warnings: string[],
  pairsFetched = 0
): ReviewResolveProjectResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    entity,
    executed: false,
    pairs_fetched: pairsFetched,
    metrics: emptyMetrics(pairsFetched),
    applied_count: 0,
    proposed_count: 0,
    deferred_count: 0,
    warnings: [...warnings, `${entity}: ${stage} failed: ${message}`],
    failure: {
      entity,
      failedCount: 1,
      failedStatements: [{ name: stage, error: message }],
    },
  };
}

async function fetchLearningContext(
  query: SqlQueryRunner,
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  schema: string,
  warnings: string[]
): Promise<string | undefined> {
  try {
    const rows = await query(buildExtractLearningsQuery(spec.entity, dialect, schema));
    const parsed = LearningRowsSchema.safeParse(rows);
    if (!parsed.success) {
      warnings.push(
        `${spec.entity}: learning rows failed validation; reviewing without precedent context.`
      );
      return undefined;
    }
    const summary = formatLearningsSummary(parsed.data).trim();
    return summary.length > 0 ? summary : undefined;
  } catch {
    // Learning context is best-effort — a missing __review_decisions table
    // (first review of a fresh project) must not block the judge.
    return undefined;
  }
}

interface SelectedJudge {
  client: LlmClient;
  /** What `decision_source` this judge's decisions land as (contract §4). */
  decisionSource: ReviewDecisionSource;
  /** Usage-reporting clients whose real usage/warnings overwrite placeholder metrics. */
  usageClients: ModelReviewLlmClient[];
  /** Panel judges when `agent_policy.panel` drives the review. */
  panelJudges?: { firstPanel: PanelJudge[]; resolutionPanel: PanelJudge[] };
  singleAgentClient?: LlmClient;
}

async function buildPanelJudges(
  roles: readonly string[],
  makeClient: (role: string) => Promise<ModelReviewLlmClient | undefined>,
  usageClients: ModelReviewLlmClient[],
  missingRoles: string[]
): Promise<PanelJudge[]> {
  const judges: PanelJudge[] = [];
  for (const role of roles) {
    const client = await makeClient(role);
    if (!client) {
      missingRoles.push(role);
      continue;
    }
    usageClients.push(client);
    judges.push({ role, client });
  }
  return judges;
}

interface JudgeSelectionInput {
  options: ReviewResolveProjectOptions;
  spec: ResolvedResolutionSpec;
  cwd: string;
  dialect: SupportedDialect;
  targetSchema: string;
  learningContext?: string;
  warnings: string[];
}

/**
 * Judge-tier dispatcher (cross-repo contract §5). `agent_policy.judge` picks the
 * lane per entity — one spec pinning `model` never affects another entity's tier
 * in the same run, since selection runs per resolved spec.
 */
async function selectJudge(input: JudgeSelectionInput): Promise<SelectedJudge | undefined> {
  const { options, spec, warnings } = input;

  // The host-injected `llmClient` is the programmatic/test escape hatch: it wins
  // over every config-driven judge, including a pinned `judge` tier.
  if (options.llmClient) {
    return {
      client: options.llmClient,
      decisionSource: MODEL_JUDGE_DECISION_SOURCE,
      usageClients: [],
    };
  }

  const judge = spec.agentPolicy?.judge;
  const offeredReviewer = options.reviewerOverride ?? spec.agentPolicy?.reviewer;

  // `judge: 'model'` pins the in-Dogsled model judge — a host cannot upgrade a
  // pinned-model entity to the agent tier. Ignore both the host override and the
  // spec's own `reviewer:`, warning when either was offered so the silent
  // downgrade is visible.
  if (judge === 'model') {
    if (options.reviewerOverride) {
      warnings.push(
        `${spec.entity}: agent_policy.judge 'model' pins the in-Dogsled model judge; the host-supplied reviewer override was ignored (a pinned-model entity cannot be upgraded to the agent tier).`
      );
    }
    if (spec.agentPolicy?.reviewer) {
      warnings.push(
        `${spec.entity}: agent_policy.judge 'model' pins the in-Dogsled model judge; agent_policy.reviewer was ignored.`
      );
    }
    return buildModelJudge(input);
  }

  // `judge: 'agent'` requires an external/tool-using reviewer transport. Never
  // fall back to the model judge — the user asked for the agent tier; skip with
  // a named reason (mapped to `no_judge_configured`) and a warning instead.
  if (judge === 'agent') {
    if (!offeredReviewer) {
      warnings.push(
        `${spec.entity}: agent_policy.judge 'agent' requires an external reviewer transport (a host reviewerOverride or agent_policy.reviewer), but none was configured; skipping the agent review (no model-judge fallback).`
      );
      return undefined;
    }
    return buildExternalReviewerJudge(input, offeredReviewer);
  }

  // `judge` absent ⇒ model (default): today's precedence unchanged. An external
  // transport (override > spec) still wins when present; otherwise the model
  // judge / panel serves the phase.
  if (offeredReviewer) {
    return buildExternalReviewerJudge(input, offeredReviewer);
  }
  return buildModelJudge(input);
}

/** External/tool-using reviewer transport (`reviewerOverride` / `agent_policy.reviewer`). */
async function buildExternalReviewerJudge(
  input: JudgeSelectionInput,
  reviewer: ReviewerConfig
): Promise<SelectedJudge> {
  const { options, spec, cwd, dialect, targetSchema, learningContext } = input;
  const secretResolver = await buildSecretResolver(cwd, options.secrets);
  const client = await createExternalReviewerClient(reviewer, {
    secretResolver,
    entity: spec.entity,
    dialect,
    targetSchema,
    cwd,
    ...(spec.entitySemantics ? { entitySemantics: spec.entitySemantics } : {}),
    ...(learningContext ? { learningContext } : {}),
    ...(spec.agentPolicy?.maxCostUsd !== undefined
      ? { maxCostUsd: spec.agentPolicy.maxCostUsd }
      : {}),
  });
  return {
    client,
    decisionSource: EXTERNAL_REVIEWER_DECISION_SOURCE,
    usageClients: [client],
  };
}

/** In-Dogsled model judge (`agent_policy.model`) and/or panel of model-role judges. */
async function buildModelJudge(input: JudgeSelectionInput): Promise<SelectedJudge | undefined> {
  const { spec, cwd, learningContext, warnings } = input;
  const policy = spec.agentPolicy;
  const usageClients: ModelReviewLlmClient[] = [];
  const makeClient = (role: string) =>
    createModelReviewLlmClient({
      role,
      cwd,
      entity: spec.entity,
      ...(spec.entitySemantics ? { entitySemantics: spec.entitySemantics } : {}),
      ...(learningContext ? { learningContext } : {}),
      ...(policy?.maxCostUsd !== undefined ? { maxCostUsd: policy.maxCostUsd } : {}),
    });

  let modelClient: ModelReviewLlmClient | undefined;
  if (policy?.legacyModel) {
    modelClient = await makeClient(policy.legacyModel);
    if (!modelClient) {
      warnings.push(
        `agent_policy.model '${policy.legacyModel}' is not configured under platform.models in dogsled.yml; no model judge available.`
      );
    } else {
      usageClients.push(modelClient);
    }
  }

  const panel = policy?.panel;
  if (panel?.enabled) {
    const missingRoles: string[] = [];
    const firstPanel = await buildPanelJudges(
      panel.firstPanel,
      makeClient,
      usageClients,
      missingRoles
    );
    const resolutionPanel = await buildPanelJudges(
      panel.resolutionPanel,
      makeClient,
      usageClients,
      missingRoles
    );
    if (missingRoles.length > 0) {
      warnings.push(
        `agent_policy.panel roles not configured under platform.models: ${missingRoles.join(', ')}; panel disabled for this run.`
      );
    } else if (panel.mode === 'escalate' && !modelClient) {
      warnings.push(
        "agent_policy.panel.mode 'escalate' requires agent_policy.model for the first-pass judge; panel disabled for this run."
      );
    } else {
      return {
        // In `replace` mode the panel reviews every pair and the single-agent
        // client is never invoked by runReviewWithPanel; a no-op placeholder
        // satisfies the input shape when no model role is configured.
        client: modelClient ?? { reviewPairs: async () => [] },
        decisionSource: MODEL_JUDGE_DECISION_SOURCE,
        usageClients,
        panelJudges: { firstPanel, resolutionPanel },
        ...(modelClient ? { singleAgentClient: modelClient } : {}),
      };
    }
  }

  if (modelClient) {
    return { client: modelClient, decisionSource: MODEL_JUDGE_DECISION_SOURCE, usageClients };
  }
  return undefined;
}

async function runJudge(input: {
  judge: SelectedJudge;
  pairs: PairContext[];
  policy: AgentPolicy;
}): Promise<{ decisions: PairDecision[]; metrics: AgentReviewMetrics; warnings: string[] }> {
  const { judge, pairs, policy } = input;

  let decisions: PairDecision[];
  let metrics: AgentReviewMetrics | undefined;
  if (judge.panelJudges) {
    decisions = await runReviewWithPanel({
      pairs,
      policy,
      singleAgentClient: judge.singleAgentClient ?? judge.client,
      judges: judge.panelJudges,
    });
  } else {
    const reviewed = await runAgentReview({ pairs, policy, llmClient: judge.client });
    decisions = reviewed.decisions;
    metrics = reviewed.metrics;
  }

  metrics ??= {
    pairsReviewed: decisions.length,
    pairsMerged: decisions.filter((d) => d.decision === 'merge').length,
    pairsRejected: decisions.filter((d) => d.decision === 'not_match').length,
    costUsd: 0,
    tokensUsed: 0,
    pairsRemaining: pairs.length - decisions.length,
  };

  // Replace runAgentReview's placeholder cost/token estimates with the model
  // clients' real accumulated usage, and surface their fail-soft warnings.
  const warnings: string[] = [];
  if (judge.usageClients.length > 0) {
    let costUsd = 0;
    let tokensUsed = 0;
    for (const client of judge.usageClients) {
      const usage = client.usage();
      costUsd += usage.costUsd;
      tokensUsed += usage.tokensUsed;
      warnings.push(...usage.warnings);
    }
    metrics = { ...metrics, costUsd, tokensUsed };
  }
  return { decisions, metrics, warnings };
}

function buildBundle(
  spec: ResolvedResolutionSpec,
  decisions: PairDecision[],
  limit: number | undefined,
  learningContext: string | undefined,
  decisionSource: ReviewDecisionSource
): AgentDecisionBundleV1 {
  const bundleDecisions: AgentDecisionBundleDecision[] = decisions.map((decision) => ({
    pair_id: decision.pairId,
    decision: decision.decision,
    reason: decision.reasoning,
    confidence: decision.confidence,
    decision_source: decisionSource,
  }));
  return {
    version: 'entity_graph_decision_bundle.v1',
    entity: spec.entity,
    mode: 'apply',
    decision_source: decisionSource,
    ...(learningContext ? { learning_context: learningContext } : {}),
    threshold_bands: [...AGENT_THRESHOLD_BANDS],
    ...(limit !== undefined ? { limit } : {}),
    decisions: bundleDecisions,
  };
}

async function reviewEntity(input: {
  spec: ResolvedResolutionSpec;
  cwd: string;
  dialect: SupportedDialect;
  targetSchema: string;
  query: SqlQueryRunner;
  options: ReviewResolveProjectOptions;
}): Promise<ReviewResolveProjectResult> {
  const { spec, cwd, dialect, targetSchema, query, options } = input;
  const warnings: string[] = [];
  const schema = spec.targetSchema ?? targetSchema;

  if (spec.agentPolicy?.enabled !== true && !options.llmClient) {
    return skippedResult(spec.entity, 'agent_policy_disabled', warnings);
  }

  const maxPairs = options.maxPairsPerRun ?? spec.agentPolicy?.maxPairsPerRun;

  // --- Judge phase (fail-soft: capture failures, never throw). -------------
  let pairs: PairContext[];
  try {
    const fetched = await fetchUnreviewedPairContexts(query, spec, dialect, schema, {
      ...(maxPairs !== undefined ? { limit: maxPairs } : {}),
    });
    pairs = fetched.pairs;
    warnings.push(...fetched.warnings);
  } catch (error) {
    return failedResult(spec.entity, 'agent_review:fetch', error, warnings);
  }

  if (pairs.length === 0) {
    return skippedResult(spec.entity, 'queue_empty', warnings);
  }

  const learningContext = await fetchLearningContext(query, spec, dialect, schema, warnings);

  let decisions: PairDecision[];
  let metrics: AgentReviewMetrics;
  let decisionSource: ReviewDecisionSource;
  try {
    const judge = await selectJudge({
      options,
      spec,
      cwd,
      dialect,
      targetSchema: schema,
      ...(learningContext ? { learningContext } : {}),
      warnings,
    });
    if (!judge) {
      return skippedResult(spec.entity, 'no_judge_configured', warnings, pairs.length);
    }

    const policy: AgentPolicy = {
      ...(spec.agentPolicy ?? { enabled: true }),
      ...(maxPairs !== undefined ? { maxPairsPerRun: maxPairs } : {}),
    };
    const reviewed = await runJudge({ judge, pairs, policy });
    decisions = reviewed.decisions;
    metrics = reviewed.metrics;
    decisionSource = judge.decisionSource;
    warnings.push(...reviewed.warnings);
  } catch (error) {
    return failedResult(spec.entity, 'agent_review:judge', error, warnings, pairs.length);
  }

  const bundle = buildBundle(spec, decisions, maxPairs, learningContext, decisionSource);

  // --- Apply phase (existing gate; SQL failures surface via `failure`). ----
  const applied = await applyReviewDecisions({
    cwd,
    ...(options.integration !== undefined ? { integration: options.integration } : {}),
    ...(options.dialect !== undefined ? { dialect: options.dialect } : {}),
    ...(options.schema !== undefined ? { schema: options.schema } : {}),
    ...(options.verbose !== undefined ? { verbose: options.verbose } : {}),
    ...(options.quiet !== undefined ? { quiet: options.quiet } : {}),
    ...(options.resolvedIntegration !== undefined
      ? { resolvedIntegration: options.resolvedIntegration }
      : {}),
    ...(options.runner !== undefined ? { runner: options.runner } : {}),
    ...(options.secrets !== undefined ? { secrets: options.secrets } : {}),
    ...(options.customRunners !== undefined ? { customRunners: options.customRunners } : {}),
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    ...(options.decisionTrace !== undefined ? { decisionTrace: options.decisionTrace } : {}),
    bundle,
    decisionSource,
  });

  return {
    entity: spec.entity,
    executed: applied.executed,
    pairs_fetched: pairs.length,
    metrics,
    applied_count: applied.applied_count,
    proposed_count: applied.proposed_count,
    deferred_count: applied.deferred_count,
    decision_batch_id: applied.decision_batch_id,
    ...(options.dryRun ? { bundle } : {}),
    warnings: [...warnings, ...applied.warnings],
    ...(applied.failure ? { failure: applied.failure } : {}),
  };
}

/**
 * Run the agent review phase for each requested entity. Structural twin of
 * `clusterResolveProject` / `profileResolveProject`: same project loading and
 * runner lifecycle, one result per entity. Judge failures never throw — they
 * land on the entity's `failure` field; validation/config errors still throw
 * `CommandError` (exit 2) per repo conventions.
 */
export async function reviewResolveProject(
  options: ReviewResolveProjectOptions
): Promise<ReviewResolveProjectResult[]> {
  const context = await loadEntityGraphProjectContext(options);
  const runnerHandle = await resolveEntityGraphRunner({
    cwd: context.cwd,
    runnerPath: options.runner,
    integration: context.integration,
    secrets: options.secrets,
    allowLocalRunnerFallback: false,
    ...(options.customRunners ? { customRunners: options.customRunners } : {}),
    ...(options.credentialsTokenCommand
      ? { credentialsTokenCommand: options.credentialsTokenCommand }
      : {}),
  });
  if (!runnerHandle) {
    throw new CommandError(
      'reviewResolveProject: no SQL runner resolved. Provide a runner or an integration.',
      1,
      {
        valid: false,
        errorCode: 'NO_RUNNER_RESOLVED',
        errors: [{ path: 'runner', message: 'No executable runner available.' }],
      }
    );
  }
  const query = runnerHandle.runner.query;
  if (query == null) {
    await runnerHandle.close();
    throw new CommandError(
      'reviewResolveProject requires a runner module with query(sql) to read the review queue.',
      2
    );
  }

  const results: ReviewResolveProjectResult[] = [];
  try {
    for (const spec of context.specs) {
      results.push(
        await reviewEntity({
          spec,
          cwd: context.cwd,
          dialect: context.dialect,
          targetSchema: context.targetSchema,
          query,
          options,
        })
      );
    }
  } finally {
    await runnerHandle.close();
  }
  return results;
}
