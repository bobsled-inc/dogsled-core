import * as fs from 'node:fs';
import * as path from 'node:path';

import { Option, type Command } from 'commander';
import { CommandError } from '@bobsled-inc/protocol';

import { buildAgentTaskResult, type AgentTaskResultV1 } from '../compiler/agent/types.js';
import { buildConfidenceGatedDecisionRows } from '../compiler/agent/confidence-gate.js';
import { generateApplySql } from '../compiler/identity/review-apply.js';
import { compileResolutionCluster } from '../compiler/identity/codegen.js';
import {
  buildExtractLearningsQuery,
  formatLearningsSummary,
  LearningRowsSchema,
} from '../compiler/identity/learnings.js';
import { compileSurvivorship } from '../compiler/survivorship/codegen.js';
import { loadProjectConfig, resolveConfig } from '@bobsled-inc/model-spec/shared';

import { createDialectOption, loadRunnerModule } from '@bobsled-inc/model-spec/shared';
import {
  onboardDiscoverHandler,
  onboardGenerateHandler,
  onboardVerifyHandler,
  type OnboardCommandOptions,
  type OnboardVerifyOptions,
} from './agent-onboard.js';
import {
  type AgentEntityOptions,
  type InitProfileOptions,
  type ReviewBatchOptions,
  type TruthsetInsight,
  AgentActionPriority,
  assertProfileOperation,
  ACCEPTED_REVIEW_BANDS,
  buildAgentResolutionContext,
  buildDecisionBundle,
  buildReviewBatchConfig,
  buildSurvivorshipMap,
  buildTruthsetMap,
  emitAgentResult,
  fetchPendingHumanReviewCount,
  fetchIncorrectFeedbackPairs,
  executeStatements,
  fetchResolveEstimateRows,
  fetchResolveStatusRows,
  fetchReviewRows,
  fetchSurvivorshipSummary,
  fetchTruthsetInsight,
  hashString,
  inferProfileDefaults,
  loadAgentTaskProfile,
  parsePositiveIntOption,
  requireQueryRunner,
  requireRunnerPath,
  resolveEntityNames,
  resolveSingleEntity,
  toStatementArtifacts,
  writeDecisionBundle,
} from './agent-support.js';

function deduplicateByPairId<T extends { pair_id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const deduplicated: T[] = [];

  for (const row of rows) {
    if (seen.has(row.pair_id)) {
      continue;
    }
    seen.add(row.pair_id);
    deduplicated.push(row);
  }

  return deduplicated;
}

async function triageHandler(
  entityNames: string[],
  options: AgentEntityOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const { profile } = loadAgentTaskProfile(options.profile);
  assertProfileOperation(profile, 'triage');

  const resolvedEntities = resolveEntityNames(entityNames, profile);
  const runnerPath = requireRunnerPath(options.runner, 'agent triage');
  const runner = await loadRunnerModule(runnerPath);
  const query = requireQueryRunner(runner, 'agent triage');
  const context = buildAgentResolutionContext(globalOptions, options, resolvedEntities);
  const truthsetMap = buildTruthsetMap(context.entityGraphDir);
  const survivorshipMap = buildSurvivorshipMap(context.entityGraphDir, context.targetSchema);
  const entities = [];
  let overallStatus: AgentTaskResultV1['status'] = 'ok';
  let recommendedNextAction: AgentTaskResultV1['recommended_next_action'] = 'noop';

  for (const spec of context.specs) {
    const statusCounts = await fetchResolveStatusRows(spec, context.dialect, query);
    const estimate = await fetchResolveEstimateRows(spec, context.dialect, query);
    const pendingReviewRows = await fetchReviewRows(
      spec,
      context.dialect,
      query,
      ACCEPTED_REVIEW_BANDS,
      1
    );
    const pendingHumanReviewCount =
      (statusCounts.review_decisions ?? 0) > 0
        ? await fetchPendingHumanReviewCount(spec, context.dialect, query)
        : 0;
    const truthset = truthsetMap.get(spec.entity.toLowerCase());
    const truthsetInsight =
      truthset != null
        ? await fetchTruthsetInsight(
            truthset,
            context.entityGraphDir,
            spec.targetSchema ?? context.targetSchema,
            context.dialect,
            query,
            null
          )
        : null;
    const hasSurvivorship = survivorshipMap.has(spec.entity.toLowerCase());

    let entityAction: AgentTaskResultV1['recommended_next_action'] = 'noop';
    let entityStatus: AgentTaskResultV1['status'] = 'ok';
    if ((statusCounts.standardized ?? 0) === 0 || (statusCounts.pair_scores ?? 0) === 0) {
      entityAction = 'run_resolution';
    } else if (pendingReviewRows.length > 0) {
      entityAction = 'agent_review_batch';
      if (pendingHumanReviewCount > 0) {
        entityStatus = 'needs_human';
      }
    } else if (pendingHumanReviewCount > 0) {
      entityStatus = 'needs_human';
      // Pending human review doesn't override required post-apply
      // materialization. If applied review_decisions already exist but
      // clusters haven't been refreshed, recommend `cluster` so downstream
      // edges/projections get rebuilt. Otherwise nothing left to recommend
      // until the human acts on the pending rows.
      entityAction =
        (statusCounts.clusters ?? 0) === 0 && (statusCounts.review_decisions ?? 0) > 0
          ? 'cluster'
          : 'noop';
    } else if ((statusCounts.clusters ?? 0) === 0 && (statusCounts.review_decisions ?? 0) > 0) {
      entityAction = 'cluster';
    } else if (
      (statusCounts.golden_record ?? 0) === 0 &&
      (statusCounts.clusters ?? 0) > 0 &&
      hasSurvivorship
    ) {
      entityAction = 'survivorship_refresh';
    } else if (
      truthsetInsight != null &&
      truthsetInsight.currentMetrics.auto_merge_precision < truthsetInsight.requiredPrecision
    ) {
      entityAction = 'truthset_regress';
      entityStatus = 'needs_human';
    }

    if (entityStatus === 'needs_human') {
      overallStatus = 'needs_human';
    }
    if (AgentActionPriority[entityAction] > AgentActionPriority[recommendedNextAction]) {
      recommendedNextAction = entityAction;
    }

    entities.push({
      entity: spec.entity,
      status: entityStatus,
      recommended_next_action: entityAction,
      status_counts: statusCounts,
      estimate,
      has_pending_review: pendingReviewRows.length > 0,
      pending_human_review_count: pendingHumanReviewCount,
      truthset:
        truthsetInsight == null
          ? null
          : {
              name: truthsetInsight.spec.name,
              required_precision: truthsetInsight.requiredPrecision,
              current_metrics: truthsetInsight.currentMetrics,
            },
      survivorship_available: hasSurvivorship,
    });
  }

  const result = buildAgentTaskResult({
    command: 'agent.triage',
    operation: 'triage',
    entities: context.specs.map((spec) => spec.entity),
    executed: true,
    status: overallStatus,
    summary: {
      entity_count: entities.length,
      entities,
    },
    recommended_next_action: recommendedNextAction,
    artifacts: {},
    warnings: [],
  });

  emitAgentResult(result, options.json);
}

async function reviewBatchHandler(
  options: ReviewBatchOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const { profile, profilePath } = loadAgentTaskProfile(options.profile);
  assertProfileOperation(profile, 'review_batch');

  const entity = resolveSingleEntity(options.entity, profile);
  const runnerPath = requireRunnerPath(options.runner, 'agent review-batch');
  const runner = await loadRunnerModule(runnerPath);
  const query = requireQueryRunner(runner, 'agent review-batch');
  const context = buildAgentResolutionContext(globalOptions, options, [entity]);
  const spec = context.specs[0]!;
  const truthsetMap = buildTruthsetMap(context.entityGraphDir);
  const survivorshipMap = buildSurvivorshipMap(context.entityGraphDir, context.targetSchema);
  const config = buildReviewBatchConfig(spec, profile, options, profilePath);
  const effectiveSchema = spec.targetSchema ?? context.targetSchema;
  const pendingRows = await fetchReviewRows(
    spec,
    context.dialect,
    query,
    config.thresholdBands,
    config.limit
  );
  const learningRows = await query(
    buildExtractLearningsQuery(spec.entity, context.dialect, effectiveSchema)
  );
  const parsedLearningRows = LearningRowsSchema.safeParse(learningRows);
  if (!parsedLearningRows.success) {
    const issue = parsedLearningRows.error.issues[0];
    throw new CommandError(
      `Runner query for ${spec.entity} returned invalid learning rows: ${issue?.message ?? 'schema validation failed'}`,
      1
    );
  }
  const learningContext = formatLearningsSummary(parsedLearningRows.data);
  const incorrectFeedbackRows = await fetchIncorrectFeedbackPairs(spec, context.dialect, query);
  const allRows = deduplicateByPairId([...pendingRows, ...incorrectFeedbackRows]);
  const thresholdBandByPairId = new Map(
    allRows.map((row) => [row.pair_id, row.threshold_band] as const)
  );
  const bundle = buildDecisionBundle(spec, allRows, config, learningContext || undefined);
  const bundlePath = writeDecisionBundle(bundle, config.outputBundlePath);
  const reEvaluationCount = incorrectFeedbackRows.length;
  const duplicatePairCount = pendingRows.length + incorrectFeedbackRows.length - allRows.length;
  const warnings: string[] = [];
  const blockingWarnings: string[] = [];

  if (spec.agentPolicy?.enabled === false) {
    blockingWarnings.push(
      'Resolution spec agent_policy.enabled=false blocks autonomous review runs.'
    );
  }
  if (config.mode === 'apply' && spec.agentPolicy?.confirmBeforeWrite) {
    blockingWarnings.push(
      'Resolution spec agent_policy.confirm_before_write=true blocks unattended apply mode.'
    );
  }

  let truthsetInsight: TruthsetInsight | null = null;
  const truthset = truthsetMap.get(spec.entity.toLowerCase());
  if (config.mode === 'apply' && truthset != null && config.requireTruthsetPrecision != null) {
    truthsetInsight = await fetchTruthsetInsight(
      truthset,
      context.entityGraphDir,
      spec.targetSchema ?? context.targetSchema,
      context.dialect,
      query,
      config.requireTruthsetPrecision
    );
    if (truthsetInsight.currentMetrics.auto_merge_precision < truthsetInsight.requiredPrecision) {
      blockingWarnings.push(
        `Current truthset auto_merge_precision ${truthsetInsight.currentMetrics.auto_merge_precision.toFixed(4)} is below required floor ${truthsetInsight.requiredPrecision.toFixed(4)}.`
      );
    }
  }

  if (config.mode === 'propose' || bundle.decisions.length === 0) {
    const result = buildAgentTaskResult({
      command: 'agent.review-batch',
      operation: 'review_batch',
      entity: spec.entity,
      mode: config.mode,
      executed: true,
      status: 'ok',
      summary: {
        candidate_count: allRows.length,
        decision_count: bundle.decisions.length,
        selection: {
          threshold_bands: config.thresholdBands,
          limit: config.limit,
          pending_review_count: pendingRows.length,
          re_evaluation_count: reEvaluationCount,
          duplicate_pair_count: duplicatePairCount,
        },
      },
      recommended_next_action: 'noop',
      artifacts: {
        profile_path: profilePath,
        output_bundle_path: bundlePath,
        decision_bundle: bundle,
      },
      warnings,
    });

    emitAgentResult(result, options.json);
    return;
  }

  const decisionBatchId = hashString(JSON.stringify(bundle));
  const gated = buildConfidenceGatedDecisionRows(
    bundle,
    config,
    decisionBatchId,
    thresholdBandByPairId
  );
  warnings.push(...gated.warnings);

  if (config.maxApplyCount != null && gated.actionableCount > config.maxApplyCount) {
    blockingWarnings.push(
      `Apply mode selected ${gated.actionableCount} actionable decision(s), exceeding max_apply_count=${config.maxApplyCount}.`
    );
  }

  if (blockingWarnings.length > 0 || !config.allowWrites) {
    const result = buildAgentTaskResult({
      command: 'agent.review-batch',
      operation: 'review_batch',
      entity: spec.entity,
      mode: config.mode,
      executed: false,
      status: 'blocked',
      summary: {
        candidate_count: allRows.length,
        decision_count: bundle.decisions.length,
        actionable_decision_count: gated.actionableCount,
        deferred_count: gated.deferredCount,
        proposed_count: gated.proposedCount,
        selection: {
          threshold_bands: config.thresholdBands,
          limit: config.limit,
        },
      },
      // Blocked batches always halt the agent loop — retrying without operator
      // action would re-hit the same policy gate or blocking warning.
      recommended_next_action: 'noop',
      artifacts: {
        profile_path: profilePath,
        output_bundle_path: bundlePath,
        decision_bundle: bundle,
      },
      warnings: config.allowWrites
        ? [...warnings, ...blockingWarnings]
        : [...warnings, ...blockingWarnings, 'Apply mode blocked by allow_writes=false policy.'],
    });

    emitAgentResult(result, options.json);
    return;
  }

  const applyStatements = generateApplySql(
    gated.decisionRows,
    spec.entity,
    context.dialect,
    spec.targetSchema ?? context.targetSchema,
    {
      defaultBatchId: decisionBatchId,
      defaultDecisionSource: config.decisionSource,
    }
  );
  const applyResults = await executeStatements(
    spec.entity,
    applyStatements,
    runner,
    context.quiet,
    Boolean(options.json)
  );
  const artifacts: Record<string, unknown> = {
    profile_path: profilePath,
    output_bundle_path: bundlePath,
    decision_bundle: bundle,
    apply_statements: toStatementArtifacts(applyStatements, applyResults),
  };

  const shouldRunCluster = config.postApply.cluster && gated.actionableCount > 0;
  const shouldRunSurvivorship = config.postApply.survivorship && gated.actionableCount > 0;

  if (shouldRunCluster) {
    const compiled = compileResolutionCluster(spec, context.dialect, context.targetSchema);
    const clusterResults = await executeStatements(
      spec.entity,
      compiled.statements,
      runner,
      context.quiet,
      Boolean(options.json)
    );
    artifacts.cluster_statements = toStatementArtifacts(compiled.statements, clusterResults);
  }

  if (shouldRunSurvivorship) {
    if (!shouldRunCluster) {
      throw new CommandError(
        'post_apply.survivorship requires post_apply.cluster after apply mode.',
        2
      );
    }
    const survivorship = survivorshipMap.get(spec.entity.toLowerCase());
    if (!survivorship) {
      throw new CommandError(`No survivorship spec found for ${spec.entity}.`, 2);
    }
    const compiled = compileSurvivorship(survivorship, context.dialect);
    const survivorshipResults = await executeStatements(
      spec.entity,
      compiled.statements,
      runner,
      context.quiet,
      Boolean(options.json)
    );
    const survivorshipSummary = await fetchSurvivorshipSummary(
      survivorship,
      context.dialect,
      query
    );
    artifacts.survivorship_statements = toStatementArtifacts(
      compiled.statements,
      survivorshipResults
    );
    artifacts.survivorship_summary = survivorshipSummary;
  }

  const hasDeferredDecisions = gated.deferredCount > 0;
  const hasProposedOnlyPendingDecisions = gated.pendingCount > 0 && !hasDeferredDecisions;

  const result = buildAgentTaskResult({
    command: 'agent.review-batch',
    operation: 'review_batch',
    entity: spec.entity,
    mode: config.mode,
    executed: true,
    status: gated.pendingCount > 0 ? 'needs_human' : 'ok',
    summary: {
      candidate_count: allRows.length,
      applied_count: gated.actionableCount,
      deferred_count: gated.deferredCount,
      proposed_count: gated.proposedCount,
      merge_count: gated.mergeCount,
      not_match_count: gated.notMatchCount,
      confidence_distribution: gated.confidenceDistribution,
      proposed_vs_applied: {
        meets_threshold: gated.proposedVsApplied.meetsThreshold,
        below_threshold: gated.proposedVsApplied.belowThreshold,
        avg_confidence_gap: gated.proposedVsApplied.avgConfidenceGap,
      },
      decision_batch_id: decisionBatchId,
      post_apply: {
        cluster: shouldRunCluster,
        survivorship: shouldRunSurvivorship,
      },
      truthset:
        truthsetInsight == null
          ? null
          : {
              required_precision: truthsetInsight.requiredPrecision,
              current_metrics: truthsetInsight.currentMetrics,
            },
    },
    // Even with rows in `proposed` lifecycle awaiting human review, applied
    // merge / not_match decisions in this batch still need cluster /
    // survivorship materialization. Recommend `cluster` when applied rows
    // exist and clusters haven't been run yet, regardless of proposed
    // count. Only fall to `noop` when there's truly nothing left to do
    // until the human acts.
    recommended_next_action: hasDeferredDecisions
      ? 'agent_review_batch'
      : gated.actionableCount > 0 && !shouldRunCluster
        ? 'cluster'
        : hasProposedOnlyPendingDecisions
          ? 'noop'
          : shouldRunSurvivorship
            ? 'noop'
            : shouldRunCluster && survivorshipMap.has(spec.entity.toLowerCase())
              ? 'survivorship_refresh'
              : truthsetMap.has(spec.entity.toLowerCase())
                ? 'truthset_regress'
                : 'noop',
    artifacts,
    warnings,
  });

  emitAgentResult(result, options.json);
}

async function survivorshipRefreshHandler(
  entityNames: string[],
  options: AgentEntityOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const { profile } = loadAgentTaskProfile(options.profile);
  assertProfileOperation(profile, 'survivorship_refresh');

  const resolvedEntities = resolveEntityNames(entityNames, profile);
  const runnerPath = requireRunnerPath(options.runner, 'agent survivorship-refresh');
  const runner = await loadRunnerModule(runnerPath);
  const query = requireQueryRunner(runner, 'agent survivorship-refresh');
  const context = buildAgentResolutionContext(globalOptions, options, resolvedEntities);
  const survivorshipMap = buildSurvivorshipMap(context.entityGraphDir, context.targetSchema);
  const truthsetMap = buildTruthsetMap(context.entityGraphDir);
  const entities = [];

  for (const spec of context.specs) {
    const survivorship = survivorshipMap.get(spec.entity.toLowerCase());
    if (!survivorship) {
      throw new CommandError(`No survivorship spec found for ${spec.entity}.`, 2);
    }

    const compiled = compileSurvivorship(survivorship, context.dialect);
    const executionResults = await executeStatements(
      spec.entity,
      compiled.statements,
      runner,
      context.quiet,
      Boolean(options.json)
    );
    const summary = await fetchSurvivorshipSummary(survivorship, context.dialect, query);
    entities.push({
      entity: spec.entity,
      schema: survivorship.targetSchema,
      statements: toStatementArtifacts(compiled.statements, executionResults),
      summary,
    });
  }

  const result = buildAgentTaskResult({
    command: 'agent.survivorship-refresh',
    operation: 'survivorship_refresh',
    entities: context.specs.map((spec) => spec.entity),
    executed: true,
    status: 'ok',
    summary: {
      entity_count: entities.length,
      entities: entities.map((entity) => ({
        entity: entity.entity,
        summary: entity.summary,
      })),
    },
    recommended_next_action: context.specs.some((spec) =>
      truthsetMap.has(spec.entity.toLowerCase())
    )
      ? 'truthset_regress'
      : 'noop',
    artifacts: {
      entities,
    },
    warnings: [],
  });

  emitAgentResult(result, options.json);
}

async function truthsetRegressHandler(
  entityNames: string[],
  options: AgentEntityOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const { profile } = loadAgentTaskProfile(options.profile);
  assertProfileOperation(profile, 'truthset_regress');

  const resolvedEntities = resolveEntityNames(entityNames, profile);
  const runnerPath = requireRunnerPath(options.runner, 'agent truthset-regress');
  const runner = await loadRunnerModule(runnerPath);
  const query = requireQueryRunner(runner, 'agent truthset-regress');
  const context = buildAgentResolutionContext(globalOptions, options, resolvedEntities);
  const truthsetMap = buildTruthsetMap(context.entityGraphDir);
  const entities = [];
  let overallStatus: AgentTaskResultV1['status'] = 'ok';

  for (const spec of context.specs) {
    const truthset = truthsetMap.get(spec.entity.toLowerCase());
    if (!truthset) {
      throw new CommandError(`No truthset spec found for ${spec.entity}.`, 2);
    }

    const insight = await fetchTruthsetInsight(
      truthset,
      context.entityGraphDir,
      spec.targetSchema ?? context.targetSchema,
      context.dialect,
      query,
      profile?.policy?.require_truthset_precision ?? null
    );
    const thresholdDelta = {
      auto_merge: Number(
        (insight.recommendedThresholds.auto_merge - insight.currentThresholds.auto_merge).toFixed(4)
      ),
      review: Number(
        (insight.recommendedThresholds.review - insight.currentThresholds.review).toFixed(4)
      ),
      auto_reject: Number(
        (insight.recommendedThresholds.auto_reject - insight.currentThresholds.auto_reject).toFixed(
          4
        )
      ),
    };
    const needsHuman = insight.recommendedMetrics.auto_merge_precision < insight.requiredPrecision;
    if (needsHuman) {
      overallStatus = 'needs_human';
    }

    entities.push({
      entity: spec.entity,
      truthset: truthset.name,
      label_count: insight.labelCount,
      required_precision: insight.requiredPrecision,
      current_thresholds: insight.currentThresholds,
      current_metrics: insight.currentMetrics,
      recommended_thresholds: insight.recommendedThresholds,
      recommended_metrics: insight.recommendedMetrics,
      threshold_delta: thresholdDelta,
      status: needsHuman ? 'needs_human' : 'ok',
    });
  }

  const result = buildAgentTaskResult({
    command: 'agent.truthset-regress',
    operation: 'truthset_regress',
    entities: context.specs.map((spec) => spec.entity),
    executed: true,
    status: overallStatus,
    summary: {
      entity_count: entities.length,
      entities,
    },
    recommended_next_action: 'noop',
    artifacts: {
      entities,
    },
    warnings: [],
  });

  emitAgentResult(result, options.json);
}

function initProfileHandler(
  name: string,
  options: InitProfileOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): void {
  const cwd = process.cwd();
  const { config } = loadProjectConfig(cwd);
  const resolved = resolveConfig({}, config);
  const defaults = inferProfileDefaults(name);
  const entity = options.entity ?? defaults.entity;
  const operation = options.operation ?? defaults.operation;
  const mode = options.mode ?? 'propose';
  const agentDir = path.join(cwd, resolved.entityGraphDir, 'agent');
  const filePath = path.join(agentDir, `${name}.yml`);

  if (fs.existsSync(filePath)) {
    throw new CommandError(`Agent task profile already exists: ${filePath}`, 2);
  }

  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    filePath,
    (operation.startsWith('onboard_')
      ? [
          `spec_version: '0.2'`,
          `type: agent_task_profile`,
          `name: ${name}`,
          `entity: ${entity}`,
          `operation: ${operation}`,
          '',
        ]
      : [
          `spec_version: '0.2'`,
          `type: agent_task_profile`,
          `name: ${name}`,
          `entity: ${entity}`,
          `operation: ${operation}`,
          `mode: ${mode}`,
          `selection:`,
          `  limit: 50`,
          `policy:`,
          `  allow_writes: ${mode === 'apply' ? 'true' : 'false'}`,
          `  max_apply_count: 25`,
          `  auto_apply_threshold: 0.75`,
          `post_apply:`,
          `  cluster: false`,
          `  survivorship: false`,
          `output:`,
          `  decision_bundle_path: review/${entity}_agent_bundle.json`,
          '',
        ]
    ).join('\n'),
    'utf-8'
  );

  const result = buildAgentTaskResult({
    command: 'agent.init-profile',
    operation,
    entity,
    mode,
    executed: true,
    status: 'ok',
    summary: {
      profile_name: name,
    },
    recommended_next_action: 'noop',
    artifacts: {
      profile_path: filePath,
    },
    warnings: [],
  });

  emitAgentResult(result, options.json || globalOptions.quiet);
}

export function registerAgentCommand(program: Command): void {
  const agent = program
    .command('agent')
    .description('Bounded one-shot agent tasks for OSS Entity Graph workflows');

  agent
    .command('triage')
    .argument('[entity...]', 'Entity names to inspect (default: profile entity)')
    .requiredOption('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--profile <path>', 'Path to agent task profile YAML')
    .option('--json', 'Output results as JSON')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(async (entityNames: string[], opts: AgentEntityOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await triageHandler(entityNames, opts, globalOptions);
    });

  agent
    .command('review-batch')
    .option('--entity <name>', 'Entity name to review (defaults to profile entity)')
    .requiredOption('--runner <path>', 'Path to SQL runner module with run(sql) and query(sql)')
    .addOption(new Option('--mode <value>', 'Review batch mode').choices(['propose', 'apply']))
    .addOption(
      new Option('--limit <n>', 'Maximum pairs to include').argParser(parsePositiveIntOption)
    )
    .option('--decision-source <value>', 'Decision source label', 'agent')
    .addOption(
      new Option('--post-apply <value>', 'Post-apply actions').choices([
        'none',
        'cluster',
        'cluster,survivorship',
      ])
    )
    .option('--output-bundle <path>', 'Write the proposal bundle to disk')
    .option('--profile <path>', 'Path to agent task profile YAML')
    .option('--json', 'Output results as JSON')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(async (opts: ReviewBatchOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await reviewBatchHandler(opts, globalOptions);
    });

  agent
    .command('survivorship-refresh')
    .argument('[entity...]', 'Entity names to refresh (default: profile entity)')
    .requiredOption('--runner <path>', 'Path to SQL runner module with run(sql) and query(sql)')
    .option('--profile <path>', 'Path to agent task profile YAML')
    .option('--json', 'Output results as JSON')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(async (entityNames: string[], opts: AgentEntityOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await survivorshipRefreshHandler(entityNames, opts, globalOptions);
    });

  agent
    .command('truthset-regress')
    .argument('[entity...]', 'Entity names to regress (default: profile entity)')
    .requiredOption('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--profile <path>', 'Path to agent task profile YAML')
    .option('--json', 'Output results as JSON')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(async (entityNames: string[], opts: AgentEntityOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await truthsetRegressHandler(entityNames, opts, globalOptions);
    });

  agent
    .command('onboard-discover')
    .requiredOption('--connection <name>', 'Source connection name to inspect')
    .option('--entity <name>', 'Entity name to onboard (defaults to profile entity)')
    .option('--profile <path>', 'Path to agent task profile YAML')
    .option('--json', 'Output results as JSON')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(async (opts: OnboardCommandOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await onboardDiscoverHandler(opts, globalOptions);
    });

  agent
    .command('onboard-generate')
    .option('--entity <name>', 'Entity name to generate (defaults to profile entity)')
    .option('--profile <path>', 'Path to agent task profile YAML')
    .option('--json', 'Output results as JSON')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(async (opts: OnboardCommandOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await onboardGenerateHandler(opts, globalOptions);
    });

  agent
    .command('onboard-verify')
    .requiredOption('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--entity <name>', 'Entity name to verify (defaults to profile entity)')
    .option('--profile <path>', 'Path to agent task profile YAML')
    .option('--json', 'Output results as JSON')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(async (opts: OnboardVerifyOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await onboardVerifyHandler(opts, globalOptions);
    });

  agent
    .command('init-profile')
    .argument('<name>', 'Profile name (written to <entityGraphDir>/agent/<name>.yml)')
    .option('--entity <name>', 'Entity name')
    .addOption(
      new Option('--operation <value>', 'Agent operation').choices([
        'triage',
        'review_batch',
        'survivorship_refresh',
        'truthset_regress',
        'onboard_discover',
        'onboard_generate',
        'onboard_propose_cleaning',
        'onboard_verify',
      ])
    )
    .addOption(new Option('--mode <value>', 'Default profile mode').choices(['propose', 'apply']))
    .option('--profile <path>', 'Unused for init-profile; kept for interface parity')
    .option('--json', 'Output results as JSON')
    .option('--schema <name>', 'Unused for init-profile; kept for interface parity')
    .addOption(createDialectOption())
    .action((name: string, opts: InitProfileOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      initProfileHandler(name, opts, globalOptions);
    });
}
