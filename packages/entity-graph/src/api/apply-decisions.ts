import type { CustomRunnerRegistry } from '@bobsled-inc/connections';
import type { SupportedDialect } from '@bobsled-inc/model-spec';
import { CommandError } from '@bobsled-inc/protocol';

import { buildConfidenceGatedDecisionRows } from '../compiler/agent/confidence-gate.js';
import type { AgentThresholdBand } from '../compiler/agent/schema.js';
import { chainReviewApplySql, generateApplySql } from '../compiler/identity/review-apply.js';
import {
  generateIncrementalMaterializeSql,
  generateTouchedEntityIdsQuery,
  generateUpdatedGoldenRowsQuery,
} from '../compiler/identity/review-materialize.js';
import type { SqlStatement } from '../compiler/identity/types.js';
import { discoverColocatedSurvivorshipSpec } from '../commands/survivorship-discovery.js';
import { toGoldenAttributeRule } from '../compiler/survivorship/codegen.js';
import { isAgentDecisionBundleV1, type AgentDecisionBundleV1 } from '../compiler/agent/types.js';
import { executeStatements, hashString } from '../commands/agent-support.js';
import { normalizeQueryRow } from '../commands/resolve-query-utils.js';
import { generateAuditLogDdl, generateReviewApplyAuditSql } from '../compiler/audit/codegen.js';
import {
  toResolveStatementJson,
  type ResolveStatementJson,
} from '../commands/resolve-execution.js';
import { buildWorkflowFailure, type ResolveWorkflowFailure } from './resolve-project.js';
import {
  loadEntityGraphProjectContext,
  type EntityGraphProjectContext,
  type EntityGraphProjectOptions,
} from '../runtime/project-context.js';
import { resolveEntityGraphRunner } from '../runtime/runner-resolver.js';

export interface ApplyReviewDecisionsOptions extends EntityGraphProjectOptions {
  /**
   * The agent's adjudications for one entity's `__review_queue` borderline
   * pairs. Validated with `isAgentDecisionBundleV1`. `bundle.entity` selects
   * the resolution spec; `bundle.decisions[*]` are confidence-gated into
   * applied / proposed / deferred lifecycle statuses.
   */
  bundle: AgentDecisionBundleV1;
  /** Decision-source label written onto every row. Defaults to the bundle's. */
  decisionSource?: string;
  /**
   * Auto-apply confidence floor. Decisions at/above apply; merge/not_match
   * below land as `proposed` for human confirmation. Defaults to the spec's
   * `agent_policy.auto_apply_threshold`, then `0.75`.
   */
  autoApplyThreshold?: number;
  /** Direct path to a SQL runner module. Wins over `customRunners`. */
  runner?: string;
  /**
   * Materialization mode for APPLIED merge decisions (default `'none'`,
   * preserving the append-only behavior). With `'incremental'`, right after
   * the decision rows are appended the affected entities' `__clusters`,
   * `__crosswalks`, `__golden_record`, and `__golden` rows are updated in
   * place — scoped to only the touched entity_ids, reusing the cluster
   * phase's survivorship/golden codegen, never re-running the pipeline.
   * Requires a prior resolve+cluster run. `proposed` / `deferred` decisions
   * stay record-only either way; `not_match` only appends its edge (see
   * `review-materialize.ts` for the unmerge follow-up + concurrency
   * contract).
   */
  materialize?: 'none' | 'incremental';
  /** Compile + gate only; never execute. */
  dryRun?: boolean;
  /** Secrets file path forwarded to the integration secret resolver. */
  secrets?: string;
  /**
   * In-memory runner registry keyed by `(source_type, auth_type)`. Mirrors
   * `runResolveProject({ customRunners })` so `@dogsled/lakehouse-execution`
   * can drive applies against BigQuery WIF / Snowflake OIDC with pre-minted
   * encrypted tokens. Only consulted on the `integration` resolver branch.
   */
  customRunners?: CustomRunnerRegistry;
  /**
   * Decision-trace ("why") context, injected by the host (e.g. agents-elt) at
   * execution time. Persisted ONLY into the warehouse `audit_log` payload —
   * never a metadata DB. `precedentRefs` falls back to the bundle's
   * `precedent_refs` when omitted here.
   */
  decisionTrace?: {
    policyVersion?: string;
    configSnapshot?: Record<string, unknown>;
    langsmithTraceId?: string;
    precedentRefs?: string[];
  };
}

/**
 * One refreshed wide `__golden` row. Only `entity_id` is fixed — the
 * remaining columns are spec-driven (profile attributes, per-source id/flag
 * splay, `cluster_size`, `trust_score`, `trust_band`), so they stay an index
 * signature. Keys are normalized to lowercase regardless of warehouse casing.
 */
export interface MaterializedGoldenRow {
  entity_id: string;
  [column: string]: unknown;
}

export interface ApplyReviewDecisionsResult {
  context: EntityGraphProjectContext;
  entity: string;
  name: string;
  dialect: SupportedDialect;
  schema: string;
  executed: boolean;
  dry_run: boolean;
  decision_batch_id: string;
  applied_count: number;
  proposed_count: number;
  deferred_count: number;
  merge_count: number;
  not_match_count: number;
  statement_count: number;
  statements: ResolveStatementJson[];
  warnings: string[];
  failure?: ResolveWorkflowFailure;
  /** Materialization mode this apply ran with (`'none'` unless requested). */
  materialize_mode: 'none' | 'incremental';
  /** Applied merge pairs targeted for incremental materialization. */
  materialized_merge_count: number;
  /**
   * Current (post-merge) entity_ids of the records touched by the
   * materialized pairs. Empty unless `materialize: 'incremental'` executed
   * against a runner that supports `query()`.
   */
  materialized_entity_ids: string[];
  /**
   * Updated wide `__golden` rows for the touched entities, so the caller can
   * reflect the merge immediately. Same availability as
   * `materialized_entity_ids`.
   */
  updated_golden_rows: MaterializedGoldenRow[];
}

/**
 * Apply an agent's entity-resolution review decisions back to the warehouse.
 *
 * Mirrors the `agent review-batch --mode apply` CLI path (`commands/agent.ts`)
 * but takes a pre-built decision bundle instead of fetching the review queue:
 * confidence-gate → `generateApplySql` (writes `__review_decisions`, refreshes
 * `__not_match_edges`) → execute via the resolved runner. `proposed` /
 * `deferred` rows stay pending — the human-confirmation gate. The resolve /
 * cluster hot path is never touched.
 *
 * With `materialize: 'incremental'`, applied merge decisions additionally
 * take effect immediately: entity-scoped updates to `__clusters`,
 * `__crosswalks`, `__golden_record`, and `__golden` (see
 * `compiler/identity/review-materialize.ts` for the idempotency +
 * concurrency contract), and the result reflects the touched entity_ids and
 * updated golden rows when the runner supports `query()`.
 *
 * The structural twin of `runResolveProject`: same options/`customRunners`
 * shape, same runner lifecycle, so `@dogsled/lakehouse-execution` drives it
 * the same way it drives resolve/cluster.
 */
export async function applyReviewDecisions(
  options: ApplyReviewDecisionsOptions
): Promise<ApplyReviewDecisionsResult> {
  const { bundle } = options;
  if (!isAgentDecisionBundleV1(bundle)) {
    throw new CommandError(
      'applyReviewDecisions: invalid agent decision bundle (expected entity_graph_decision_bundle.v1).',
      2,
      {
        valid: false,
        errorCode: 'INVALID_AGENT_DECISION_BUNDLE',
        errors: [{ path: 'bundle', message: 'Expected entity_graph_decision_bundle.v1.' }],
      }
    );
  }

  const context = await loadEntityGraphProjectContext({
    ...options,
    entityNames: [bundle.entity],
  });
  const spec = context.specs[0];
  if (!spec) {
    throw new CommandError(`No resolution spec found for entity '${bundle.entity}'.`, 2, {
      valid: false,
      errorCode: 'RESOLUTION_SPEC_NOT_FOUND',
      errors: [{ path: 'entity', message: `No resolution spec for '${bundle.entity}'.` }],
    });
  }

  const decisionSource = options.decisionSource ?? bundle.decision_source;
  const autoApplyThreshold =
    options.autoApplyThreshold ?? spec.agentPolicy?.autoApplyThreshold ?? 0.75;
  if (!Number.isFinite(autoApplyThreshold) || autoApplyThreshold < 0 || autoApplyThreshold > 1) {
    // A NaN / Infinity / out-of-range threshold would silently misclassify
    // every pair and emit nonsense confidence metrics — fail loud instead.
    throw new CommandError(
      'applyReviewDecisions: autoApplyThreshold must be a finite number in [0, 1].',
      2,
      {
        valid: false,
        errorCode: 'INVALID_AUTO_APPLY_THRESHOLD',
        errors: [{ path: 'autoApplyThreshold', message: 'Expected a finite number in [0, 1].' }],
      }
    );
  }

  // The bundle carries no per-pair band metadata. When it declares exactly
  // one band ('review' or 'deterministic_review'), attribute every decision
  // to it; otherwise default to 'review' so the gate never warns about
  // missing band metadata.
  const bundleBand: AgentThresholdBand =
    bundle.threshold_bands?.length === 1 && bundle.threshold_bands[0] !== undefined
      ? bundle.threshold_bands[0]
      : 'review';
  const thresholdBandByPairId = new Map<string, AgentThresholdBand>(
    bundle.decisions.map((decision) => [decision.pair_id, bundleBand] as const)
  );

  const decisionBatchId = hashString(JSON.stringify(bundle));
  const gated = buildConfidenceGatedDecisionRows(
    bundle,
    { decisionSource, autoApplyThreshold },
    decisionBatchId,
    thresholdBandByPairId
  );

  const effectiveSchema = spec.targetSchema ?? context.targetSchema;

  // Content hash over the gated rows — written onto every `__review_decisions`
  // row AND into the audit row, so the audit `skipped` replay-check matches on
  // (decision_batch_id, content_hash). Deterministic from the bundle.
  const contentHash = hashString(
    JSON.stringify(
      [...gated.decisionRows].sort((left, right) => left.pair_id.localeCompare(right.pair_id))
    )
  );

  const trace = options.decisionTrace;
  const precedentRefs = trace?.precedentRefs ?? bundle.precedent_refs;

  const materializeMode = options.materialize ?? 'none';
  // Only finalized merges materialize — mirrors generateApplySql's actionable
  // filter, so proposed / deferred rows stay record-only.
  const appliedMergePairIds =
    materializeMode === 'incremental'
      ? gated.decisionRows
          .filter(
            (row) =>
              row.decision === 'merge' && (row.status === undefined || row.status === 'applied')
          )
          .map((row) => row.pair_id)
      : [];
  const materializeWarnings: string[] = [];
  if (materializeMode === 'incremental' && gated.notMatchCount > 0) {
    materializeWarnings.push(
      `${spec.entity}: not_match decisions are recorded and block future re-merge, but records ` +
        `currently sharing an entity_id are not split incrementally (unmerge-on-not_match is a ` +
        `follow-up); the next full resolve+cluster performs the split.`
    );
  }
  // Same refined-rule discovery the cluster phase uses (resolve-project.ts),
  // so the incremental golden recompute matches the next full run exactly.
  const survivorshipSpec =
    appliedMergePairIds.length > 0
      ? discoverColocatedSurvivorshipSpec(spec, context.targetSchema, context.entityGraphDir)
      : undefined;

  const applyStatements = generateApplySql(
    gated.decisionRows,
    spec.entity,
    context.dialect,
    effectiveSchema,
    {
      defaultBatchId: decisionBatchId,
      defaultContentHash: contentHash,
      defaultDecisionSource: decisionSource,
    }
  );
  const lastApplyStatementName = applyStatements.at(-1)?.name;
  const materializeStatements: SqlStatement[] =
    appliedMergePairIds.length > 0
      ? generateIncrementalMaterializeSql({
          spec,
          dialect: context.dialect,
          targetSchema: effectiveSchema,
          mergePairIds: appliedMergePairIds,
          // Skip materialization entirely when the decision append failed —
          // decisions are the source of truth the targeted update derives from.
          ...(lastApplyStatementName ? { dependsOn: lastApplyStatementName } : {}),
          ...(survivorshipSpec
            ? { goldenRules: survivorshipSpec.attributeRules.map(toGoldenAttributeRule) }
            : {}),
        })
      : [];

  // Prepend the audit_log DDL + the review_apply audit row (mirrors the CLI
  // `review apply` path) so the programmatic API ALSO persists the decision
  // trace into the warehouse `audit_log`. `generateApplySql` follows, writing
  // the per-pair `__review_decisions` rows. Both execute against the resolved
  // warehouse runner — nothing here touches any metadata DB.
  const statements: SqlStatement[] = chainReviewApplySql([
    ...generateAuditLogDdl(context.dialect),
    generateReviewApplyAuditSql({
      entityName: spec.entity,
      targetSchema: effectiveSchema,
      dialect: context.dialect,
      decisionBatchId,
      contentHash,
      decisionCount: gated.decisionRows.length,
      mergeCount: gated.mergeCount,
      notMatchCount: gated.notMatchCount,
      deferredCount: gated.deferredCount,
      // Always 0 — the defer/escalate collapse means new applies never emit an
      // `escalate` decision (mirrors commands/review.ts).
      escalatedCount: 0,
      decisionSource,
      ...(trace?.policyVersion != null ? { policyVersion: trace.policyVersion } : {}),
      ...(trace?.configSnapshot != null ? { configSnapshot: trace.configSnapshot } : {}),
      ...(trace?.langsmithTraceId != null ? { langsmithTraceId: trace.langsmithTraceId } : {}),
      ...(precedentRefs != null && precedentRefs.length > 0 ? { precedentRefs } : {}),
      ...(bundle.learning_context != null ? { learningContext: bundle.learning_context } : {}),
    }),
    ...applyStatements,
    ...materializeStatements,
  ]);

  const base = {
    context,
    entity: spec.entity,
    name: spec.name,
    dialect: context.dialect,
    schema: effectiveSchema,
    decision_batch_id: decisionBatchId,
    applied_count: gated.actionableCount,
    proposed_count: gated.proposedCount,
    deferred_count: gated.deferredCount,
    merge_count: gated.mergeCount,
    not_match_count: gated.notMatchCount,
    statement_count: statements.length,
    warnings: [...gated.warnings, ...materializeWarnings],
    materialize_mode: materializeMode,
    materialized_merge_count: appliedMergePairIds.length,
    materialized_entity_ids: [] as string[],
    updated_golden_rows: [] as MaterializedGoldenRow[],
  };

  const runnerHandle = options.dryRun
    ? undefined
    : await resolveEntityGraphRunner({
        cwd: context.cwd,
        runnerPath: options.runner,
        integration: context.integration,
        secrets: options.secrets,
        allowLocalRunnerFallback: false,
        ...(options.customRunners ? { customRunners: options.customRunners } : {}),
      });

  if (options.dryRun) {
    return {
      ...base,
      executed: false,
      dry_run: true,
      statements: statements.map((stmt) => toResolveStatementJson(stmt)),
    };
  }
  if (!runnerHandle) {
    // dryRun is false but no runner resolved (no runner path, no integration,
    // local fallback disabled). Surface the misconfiguration instead of
    // silently reporting a dry run with nothing applied.
    throw new CommandError(
      'applyReviewDecisions: no SQL runner resolved. Provide a runner, an integration, or set dryRun.',
      1,
      {
        valid: false,
        errorCode: 'NO_RUNNER_RESOLVED',
        errors: [{ path: 'runner', message: 'No executable runner available.' }],
      }
    );
  }

  try {
    const results = await executeStatements(
      spec.entity,
      statements,
      runnerHandle.runner,
      context.quiet,
      false
    );
    const failed = results.filter((row) => row.status === 'failed');

    // Reflect the merge back to the caller: touched entity_ids + updated
    // golden rows. Read-only and fail-soft — a fetch problem never fails an
    // apply whose writes succeeded.
    let materializedEntityIds: string[] = [];
    let updatedGoldenRows: MaterializedGoldenRow[] = [];
    const fetchWarnings: string[] = [];
    if (appliedMergePairIds.length > 0 && failed.length === 0) {
      const query = runnerHandle.runner.query;
      if (!query) {
        fetchWarnings.push(
          `${spec.entity}: runner does not support query(); materialized entity_ids and golden rows were not fetched.`
        );
      } else {
        try {
          const entityRows = await query(
            generateTouchedEntityIdsQuery(
              spec.entity,
              context.dialect,
              effectiveSchema,
              appliedMergePairIds
            )
          );
          // Normalize casing — warehouses like Snowflake return ENTITY_ID.
          materializedEntityIds = entityRows
            .map((row) => normalizeQueryRow(row).entity_id)
            .filter((value): value is string => typeof value === 'string');
          const goldenRows = await query(
            generateUpdatedGoldenRowsQuery(
              spec.entity,
              context.dialect,
              effectiveSchema,
              appliedMergePairIds
            )
          );
          updatedGoldenRows = goldenRows
            .map((row) => normalizeQueryRow(row))
            .filter((row): row is MaterializedGoldenRow => typeof row.entity_id === 'string');
        } catch (error) {
          fetchWarnings.push(
            `${spec.entity}: failed to fetch materialized golden rows: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }

    return {
      ...base,
      executed: true,
      dry_run: false,
      warnings: [...base.warnings, ...fetchWarnings],
      materialized_entity_ids: materializedEntityIds,
      updated_golden_rows: updatedGoldenRows,
      statements: statements.map((stmt, index) => toResolveStatementJson(stmt, results[index])),
      ...(failed.length > 0 ? { failure: buildWorkflowFailure(spec.entity, failed) } : {}),
    };
  } finally {
    await runnerHandle.close();
  }
}
