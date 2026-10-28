/**
 * `entity-graph review apply` — import review decisions from CSV/JSON/YAML
 * (or an entity_graph_decision_bundle.v1) and write them to the warehouse,
 * optionally materializing applied merges incrementally. Split out of
 * `review.ts` to respect the source-file budget.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { z } from 'zod';
import { CommandError } from '@bobsled-inc/protocol';

import type { ModelExecutionResult, SupportedDialect } from '@bobsled-inc/model-spec';
import { executeSqlStatements } from '@bobsled-inc/model-spec';
import { loadRunnerModule, out } from '@bobsled-inc/model-spec/shared';

import {
  detectDecisionInputFormat,
  parseDecisions,
  generateApplySql,
  chainReviewApplySql,
} from '../compiler/identity/review-apply.js';
import { buildConfidenceGatedDecisionRows } from '../compiler/agent/confidence-gate.js';
import type { AgentThresholdBand } from '../compiler/agent/schema.js';
import { generateIncrementalMaterializeSql } from '../compiler/identity/review-materialize.js';
import { generateMaterializeDdl } from '../compiler/identity/materializer.js';
import { generateAuditLogDdl, generateReviewApplyAuditSql } from '../compiler/audit/codegen.js';
import { toGoldenAttributeRule } from '../compiler/survivorship/codegen.js';
import { buildResolveContext } from './resolve-context.js';
import { assertReviewPolicyAllowsDecision } from './review-policy.js';
import { discoverColocatedSurvivorshipSpec } from './survivorship-discovery.js';
import {
  buildContentHash,
  buildDecisionBatchId,
  readStdin,
  resolveReviewTargets,
  type ReviewGlobalFlags,
} from './review-support.js';
import { resolveEntityGraphOutputFormat, type EntityGraphOutputFormat } from './utils.js';
import {
  emitReviewApplyStructured,
  reviewApplyError,
  type ReviewApplyReceipt,
} from './review-apply-output.js';

export interface ApplyOptions {
  input: string;
  entity: string;
  schema?: string;
  dialect?: SupportedDialect;
  runner?: string;
  batchId?: string;
  decisionSource?: string;
  policyFile?: string;
  specDir?: string;
  materialize?: string;
  json?: boolean;
  yaml?: boolean;
}

/** Apply reviewed merge and not-match decisions back into the Entity Graph tables. */
export async function applyHandler(
  options: ApplyOptions,
  globalOptions: ReviewGlobalFlags
): Promise<void> {
  let outputFormat: EntityGraphOutputFormat;
  try {
    outputFormat = resolveEntityGraphOutputFormat({
      json: options.json,
      yaml: options.yaml,
      defaultFormat: 'text',
    });
  } catch (error) {
    if (!(error instanceof CommandError)) throw error;
    throw reviewApplyError(error.message, 2, 'INVALID_OUTPUT_FORMAT', [
      { path: 'output', message: error.message },
    ]);
  }
  const structured = outputFormat !== 'text';
  const inputRef = options.input === '-' ? '-' : path.resolve(options.input);
  if (options.input !== '-' && !fs.existsSync(inputRef)) {
    throw reviewApplyError(`Input file not found: ${inputRef}`, 2, 'INPUT_FILE_NOT_FOUND', [
      { path: 'input', message: `File does not exist: ${inputRef}` },
    ]);
  }

  const content = options.input === '-' ? await readStdin() : fs.readFileSync(inputRef, 'utf-8');
  const format = detectDecisionInputFormat(content);

  const parsed = parseDecisions(content, format);
  let decisions = parsed.decisions;
  const warnings = [...parsed.warnings];

  if (decisions.length === 0) {
    throw reviewApplyError(
      'No valid decisions found in input file.',
      2,
      'NO_VALID_DECISIONS',
      warnings.length > 0
        ? warnings.map((warning) => ({ path: 'input', message: warning }))
        : [{ path: 'input', message: 'Expected at least one valid review decision.' }]
    );
  }

  const { targets, dialect, quiet } = resolveReviewTargets(
    [options.entity],
    options,
    globalOptions
  );
  const target = targets[0];
  if (!target) {
    throw reviewApplyError(
      `No resolution specs found matching: ${options.entity}`,
      2,
      'RESOLUTION_SPEC_NOT_FOUND',
      [{ path: 'entity', message: `No resolution spec for '${options.entity}'.` }]
    );
  }

  const decisionBatchId = options.batchId ?? buildDecisionBatchId(content);
  const decisionSourceRaw = options.decisionSource ?? parsed.bundle?.decision_source ?? 'human';
  const decisionSourceParsed = z.enum(['human', 'agent', 'system']).safeParse(decisionSourceRaw);
  if (!decisionSourceParsed.success) {
    throw reviewApplyError(
      `--decision-source must be one of: human, agent, system (got: ${decisionSourceRaw})`,
      2,
      'INVALID_DECISION_SOURCE',
      [{ path: 'decisionSource', message: 'Expected one of: human, agent, system.' }]
    );
  }
  const decisionSource = decisionSourceParsed.data;

  if (parsed.bundle) {
    const bundleBand: AgentThresholdBand =
      parsed.bundle.threshold_bands?.length === 1 && parsed.bundle.threshold_bands[0] !== undefined
        ? parsed.bundle.threshold_bands[0]
        : 'review';
    const thresholdBandByPairId = new Map<string, AgentThresholdBand>(
      parsed.bundle.decisions.map((decision) => [decision.pair_id, bundleBand] as const)
    );
    const gated = buildConfidenceGatedDecisionRows(
      parsed.bundle,
      { decisionSource, autoApplyThreshold: target.defaultApplyThreshold },
      decisionBatchId,
      thresholdBandByPairId
    );
    decisions = gated.decisionRows;
    warnings.push(...gated.warnings);
  }

  for (const warning of warnings) {
    out.warn(warning);
  }

  // `actionable` mirrors generateApplySql's filter exactly so the summary
  // counts and the SQL writes never drift apart. A row is actionable iff:
  //   - it is not a `defer` decision, and
  //   - its lifecycle is explicitly `applied` or absent for legacy input.
  // Every other lifecycle stays pending and cannot refresh projections.
  const actionableDecisions = decisions.filter(
    (d) => d.decision !== 'defer' && (d.status === undefined || d.status === 'applied')
  );
  const deferred = decisions.filter((d) => d.decision === 'defer');
  const proposed = decisions.filter((d) => d.decision !== 'defer' && d.status === 'proposed');
  const mergeCount = actionableDecisions.filter((d) => d.decision === 'merge').length;
  const notMatchCount = actionableDecisions.filter((d) => d.decision === 'not_match').length;
  const contentHash = buildContentHash(
    [...decisions].sort((left, right) => left.pair_id.localeCompare(right.pair_id))
  );

  assertReviewPolicyAllowsDecision({
    specDir: options.specDir,
    policyFile: options.policyFile,
    decisionSource,
  });

  const materializeParsed = z
    .enum(['none', 'incremental'])
    .safeParse(options.materialize ?? 'none');
  if (!materializeParsed.success) {
    throw reviewApplyError(
      `--materialize must be one of: none, incremental (got: ${options.materialize})`,
      2,
      'INVALID_MATERIALIZE_MODE',
      [{ path: 'materialize', message: 'Expected one of: none, incremental.' }]
    );
  }
  const materializeMode = materializeParsed.data;
  // Same actionable filter as generateApplySql — only finalized merges
  // materialize; proposed/deferred stay record-only.
  const materializePairIds =
    materializeMode === 'incremental'
      ? decisions
          .filter(
            (d) => d.decision === 'merge' && (d.status === undefined || d.status === 'applied')
          )
          .map((d) => d.pair_id)
      : [];
  const applySqlStatements = generateApplySql(decisions, target.entity, dialect, target.schema, {
    defaultBatchId: decisionBatchId,
    defaultContentHash: contentHash,
    defaultDecisionSource: decisionSource,
  });
  const lastApplyStatementName = applySqlStatements.at(-1)?.name;
  let materializeStatements: ReturnType<typeof generateIncrementalMaterializeSql> = [];
  if (materializePairIds.length > 0) {
    // Incremental materialization needs the resolved spec (golden rules,
    // inputs) — resolve it the same way the cluster phase does.
    let resolveContext;
    try {
      resolveContext = buildResolveContext(globalOptions, options, [options.entity]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw reviewApplyError(
        message,
        error instanceof CommandError && error.exitCode === 1 ? 1 : 2,
        'RESOLUTION_SPEC_RESOLVE_FAILED',
        [{ path: 'entity', message }]
      );
    }
    const spec = resolveContext.specs[0];
    if (!spec) {
      throw reviewApplyError(
        `--materialize incremental requires a resolution spec for '${options.entity}'.`,
        2,
        'RESOLUTION_SPEC_NOT_FOUND',
        [{ path: 'entity', message: `No resolution spec for '${options.entity}'.` }]
      );
    }
    const survivorshipSpec = discoverColocatedSurvivorshipSpec(
      spec,
      resolveContext.targetSchema,
      resolveContext.entityGraphDir
    );
    materializeStatements = generateIncrementalMaterializeSql({
      spec,
      dialect,
      targetSchema: target.schema,
      mergePairIds: materializePairIds,
      // Skip materialization entirely when the decision append failed —
      // decisions are the source of truth the targeted update derives from.
      ...(lastApplyStatementName ? { dependsOn: lastApplyStatementName } : {}),
      ...(survivorshipSpec
        ? { goldenRules: survivorshipSpec.attributeRules.map(toGoldenAttributeRule) }
        : {}),
    });
  }
  if (materializeMode === 'incremental' && notMatchCount > 0 && !quiet) {
    out.warn(
      `not_match decisions are recorded and block future re-merge, but records currently sharing ` +
        `an entity_id are not split incrementally; the next full resolve+cluster performs the split.`
    );
  }

  const statements = chainReviewApplySql([
    ...generateMaterializeDdl(target.entity, dialect, target.schema),

    ...generateAuditLogDdl(dialect),
    generateReviewApplyAuditSql({
      entityName: target.entity,
      targetSchema: target.schema,
      dialect,
      decisionBatchId,
      contentHash,
      decisionCount: decisions.length,
      mergeCount,
      notMatchCount,
      deferredCount: deferred.length,
      // Always 0 since the defer/escalate collapse — new code never emits
      // an `escalate` decision. The audit field stays for back-compat with
      // historical rows but is no longer populated by review apply.
      escalatedCount: 0,
      decisionSource,
    }),
    ...applySqlStatements,
    ...materializeStatements,
  ]);
  let executionResults: ModelExecutionResult[] = [];
  let failed: ModelExecutionResult[] = [];

  if (options.runner) {
    let run: Awaited<ReturnType<typeof loadRunnerModule>>['run'];
    try {
      ({ run } = await loadRunnerModule(options.runner));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw reviewApplyError(`Failed to load SQL runner: ${message}`, 1, 'RUNNER_LOAD_FAILED', [
        { path: 'runner', message },
      ]);
    }
    const suppressHumanOutput = quiet || structured;
    try {
      executionResults = await executeSqlStatements(
        statements.map((stmt) => ({
          modelName: `${target.entity}:${stmt.name}`,
          sql: stmt.sql,
          ignoreErrorPatterns: stmt.ignoreErrorPatterns,
          // deps are plain statement names — qualify them the same way
          // modelName is qualified so the executor's failed-upstream skip works.
          ...(stmt.deps ? { deps: stmt.deps.map((dep) => `${target.entity}:${dep}`) } : {}),
        })),
        run,
        {
          onInfo: suppressHumanOutput ? undefined : (msg) => out.info(msg),
          onError: (msg) => out.error(msg),
          onSuccess: suppressHumanOutput ? undefined : (msg) => out.success(msg),
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw reviewApplyError(
        `Review apply execution failed: ${message}`,
        1,
        'REVIEW_APPLY_EXECUTION_FAILED',
        [{ path: 'statements', message }]
      );
    }
    failed = executionResults.filter((row) => row.status === 'failed');
  } else if (!structured && !quiet) {
    for (const stmt of statements) {
      out.text(`-- ${stmt.name}\n${stmt.sql};\n\n`);
    }
  }

  // Build one canonical receipt so JSON, YAML, success, and controlled
  // statement-failure output cannot drift apart.
  const applyModelNames = new Set(
    applySqlStatements.map((statement) => `${target.entity}:${statement.name}`)
  );
  const applyExecutionResults = executionResults.filter((result) =>
    applyModelNames.has(result.modelName)
  );
  const persistedCount = !options.runner
    ? 0
    : applyExecutionResults.length === applySqlStatements.length &&
        applyExecutionResults.every((result) => result.status === 'success')
      ? decisions.length
      : null;
  const resultEnvelope: ReviewApplyReceipt = {
    command: 'review.apply',
    entity: target.entity,
    dialect,
    schema: target.schema,
    input_path: inputRef,
    input_format: format,
    executed: Boolean(options.runner),
    decision_batch_id: decisionBatchId,
    content_hash: contentHash,
    decision_source: decisionSource,
    total_decisions: decisions.length,
    persisted_count: persistedCount,
    applied_count: actionableDecisions.length,
    merge_count: mergeCount,
    not_match_count: notMatchCount,
    deferred_count: deferred.length,
    proposed_count: proposed.length,
    materialize_mode: materializeMode,
    materialized_merge_count: materializePairIds.length,
    statements: options.runner
      ? statements.map((stmt, index) => ({
          name: stmt.name,
          sql: stmt.sql,
          status: executionResults[index]?.status,
          error: executionResults[index]?.error,
          rows_affected: executionResults[index]?.rowsAffected,
        }))
      : statements.map((stmt) => ({
          name: stmt.name,
          sql: stmt.sql,
        })),
  };

  if (failed.length > 0) {
    if (structured) {
      emitReviewApplyStructured(outputFormat, resultEnvelope);
    }
    throw reviewApplyError(
      `${failed.length} review statement(s) failed.`,
      1,
      'REVIEW_STATEMENT_FAILED',
      failed.map((row) => ({
        path: row.modelName,
        message: row.error ?? 'SQL statement failed.',
      }))
    );
  }

  if (structured) {
    emitReviewApplyStructured(outputFormat, resultEnvelope);
    return;
  }

  if (quiet) {
    return;
  }

  const actionSummary = options.runner ? 'Persisted' : 'Generated SQL for';
  const summarySegments = [`${mergeCount} merge`, `${notMatchCount} not_match`];
  if (proposed.length > 0) {
    summarySegments.push(`${proposed.length} proposed`);
  }
  if (deferred.length > 0) {
    summarySegments.push(`${deferred.length} deferred`);
  }
  if (materializePairIds.length > 0) {
    summarySegments.push(`${materializePairIds.length} materialized incrementally`);
  }
  out.success(
    `${actionSummary} ${decisions.length} decision(s): ${summarySegments.join(', ')}` +
      ` [batch=${decisionBatchId}]`
  );
}
