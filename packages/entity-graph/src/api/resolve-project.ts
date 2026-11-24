import { randomUUID } from 'node:crypto';

import type { BigQueryTokenProvider, CustomRunnerRegistry } from '@bobsled-inc/connections';
import type { SqlQueryRunner, SqlRunnerModule, SupportedDialect } from '@bobsled-inc/model-spec';
import { CommandError } from '@bobsled-inc/protocol';

import {
  compileResolution,
  compileResolutionCluster,
  compileResolutionProfile,
  compileResolutionRun,
} from '../compiler/identity/codegen.js';
import { compileSurvivorship, toGoldenAttributeRule } from '../compiler/survivorship/codegen.js';
import { generateAuditLogDdl, generateSurvivorshipAuditSql } from '../compiler/audit/codegen.js';
import { computeResolutionRunFingerprint } from '../compiler/identity/fingerprint.js';
import {
  buildResolveStateSelectQuery,
  buildSourceWatermarkQuery,
  normalizeResolveStateRows,
  resolveStateSourceDefinitions,
  type ResolutionIncrementalOptions,
  type ResolveRunMode,
  type ResolveStateRow,
  type ResolveStateSourceDefinition,
} from '../compiler/identity/codegen-resolve-state.js';
import type {
  ResolutionCompileResult,
  ResolvedResolutionSpec,
  SqlStatement,
} from '../compiler/identity/types.js';
import { discoverColocatedSurvivorshipSpec } from '../commands/survivorship-discovery.js';
import {
  toResolvePreambleJson,
  toResolveStatementJson,
  type ResolvePreambleJson,
  type ResolveStatementJson,
} from '../commands/resolve-execution.js';
import { runSemanticTriageForResolution } from '../commands/resolve-semantic-triage.js';
import {
  queryEntityIdSummaryWithRunner,
  type EntityIdSummaryJson,
} from '../commands/resolve-entity-id-summary.js';
import { buildFqName, quoteIdentifier } from '@bobsled-inc/model-spec';
import { outputTableName } from '../compiler/output-tables/index.js';
import {
  loadEntityGraphProjectContext,
  type EntityGraphProjectContext,
  type EntityGraphProjectOptions,
} from '../runtime/project-context.js';
import {
  resolveEntityGraphRunner,
  type EntityGraphRunnerHandle,
} from '../runtime/runner-resolver.js';
import {
  executeEntityGraphPlan,
  type EntityGraphExecutionCallbacks,
} from '../runtime/execution.js';
import { out } from '@bobsled-inc/model-spec/shared';
import { readField } from './extract-project-utils.js';

const executionCallbacks: EntityGraphExecutionCallbacks = {
  onInfo: (msg) => out.info(msg),
  onError: (msg) => out.error(msg),
  onSuccess: (msg) => out.success(msg),
};

export interface ResolveWorkflowOptions extends EntityGraphProjectOptions {
  runner?: string;
  dryRun?: boolean;
  secrets?: string;
  mode?: 'staged' | 'direct';
  /**
   * Optional in-memory `CustomRunnerRegistry` keyed by
   * `(source_type, auth_type)`. Mirrors `@bobsled-inc/model-spec`'s
   * `runProject({ customRunners })` injection point so host orchestrators can
   * drive entity-graph runs against BigQuery WIF / Snowflake OIDC with
   * pre-minted, encrypted tokens — auth types Dogsled's built-in drivers
   * cannot always satisfy in hosted environments.
   *
   * Only consulted on the `integration` resolver branch — when `runner:
   * '<path>'` is set, that runner module is loaded directly and the
   * registry never wins.
   */
  customRunners?: CustomRunnerRegistry;
  /**
   * Refreshable managed-credential provider — re-mints the orchestrator's
   * short-lived token mid-run so a multi-hour entity-graph phase survives token
   * expiry. Takes precedence over `credentialsTokenCommand`. Forwarded to
   * `resolveEntityGraphRunner` → `resolveRunner`.
   */
  tokenProvider?: BigQueryTokenProvider;
  /**
   * Shell command printing a fresh `{"access_token","expires_at"}` token — the
   * same `credentials_token_command` the loader consumes. Converted to a
   * {@link tokenProvider} when one isn't supplied directly.
   */
  credentialsTokenCommand?: string;
  /**
   * Process only new/changed source rows when a compatible
   * `<entity>__resolve_state` baseline exists. Spec/fingerprint invalidation
   * automatically falls back to a full rebuild.
   */
  incremental?: boolean;
}

export interface ResolveValidateEntity {
  entity: string;
  name: string;
  target_schema: string;
  input_count: number;
  blocking_rule_count: number;
  deterministic_rule_count: number;
  scoring_feature_count: number;
  scoring_method?: 'weighted_features' | 'fellegi_sunter';
  scoring_comparison_count?: number;
}

export interface ResolveCompileEntity {
  entity: string;
  name: string;
  dialect: SupportedDialect;
  schema: string;
  statement_count: number;
  warnings: string[];
  spec: ResolvedResolutionSpec;
  result: ResolutionCompileResult;
}

export interface ResolveExecutionEntity {
  entity: string;
  name: string;
  dialect: SupportedDialect;
  schema: string;
  executed: boolean;
  dry_run: boolean;
  statement_count: number;
  warnings: string[];
  preamble?: ResolvePreambleJson;
  statements: ResolveStatementJson[];
  entity_id_summary?: EntityIdSummaryJson;
  /**
   * Rows in the phase's PRIMARY output table after a successful (non-dry-run)
   * execution — cluster → `<entity>__entity_id_current`, profile →
   * `<entity>__entity_profile`. Lets downstream consumers gate "did this phase
   * produce data" on real output instead of the `executed` flag (which only
   * means statements were dispatched). Present only when a query-capable runner
   * could read the count; absent for dry runs / unreadable runners / resolve.
   */
  rows_written?: number;
  /**
   * True when the phase executed but its primary output table has 0 rows — the
   * "succeeded-with-zero-output" signal. Set alongside `rows_written` (so
   * `skipped === (rows_written === 0)` when both are present); absent when the
   * count could not be read.
   */
  skipped?: boolean;
  mode?: ResolveRunMode;
  mode_reason?: string;
}

export interface ResolveWorkflowFailure {
  entity: string;
  failedCount: number;
  /** Per-statement failure detail (statement name + verbatim runner error). */
  failedStatements?: { name: string; error?: string }[];
}

export interface ResolveWorkflowResult<TEntity> {
  context: EntityGraphProjectContext;
  entities: TEntity[];
  failure?: ResolveWorkflowFailure;
}

export function buildWorkflowFailure(
  entity: string,
  failed: { modelName: string; error?: string }[]
): ResolveWorkflowFailure {
  return {
    entity,
    failedCount: failed.length,
    failedStatements: failed.map((row) => ({
      name: row.modelName,
      ...(row.error ? { error: row.error } : {}),
    })),
  };
}

/** Compact human-readable summary of a workflow failure for error messages. */
export function describeWorkflowFailure(failure: ResolveWorkflowFailure): string {
  const first = failure.failedStatements?.find((row) => row.error) ?? failure.failedStatements?.[0];
  const detail = first ? ` First failure [${first.name}]: ${first.error ?? 'unknown error'}` : '';
  return `${failure.entity}: ${failure.failedCount} statement(s) failed.${detail}`;
}

function statementCount(result: { preamble?: string; statements: SqlStatement[] }): number {
  return result.statements.length + (result.preamble ? 1 : 0);
}

function dryRunEntity(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string,
  result: { preamble?: string; statements: SqlStatement[]; warnings: string[] }
): ResolveExecutionEntity {
  return {
    entity: spec.entity,
    name: spec.name,
    dialect,
    schema: spec.targetSchema ?? targetSchema,
    executed: false,
    dry_run: true,
    statement_count: statementCount(result),
    preamble: result.preamble ? toResolvePreambleJson(result.preamble) : undefined,
    statements: result.statements.map((stmt) => toResolveStatementJson(stmt)),
    warnings: result.warnings,
  };
}

async function resolveRunnerForWorkflow(
  context: EntityGraphProjectContext,
  options: ResolveWorkflowOptions
): Promise<EntityGraphRunnerHandle | undefined> {
  if (options.dryRun) {
    return undefined;
  }
  return resolveEntityGraphRunner({
    cwd: context.cwd,
    runnerPath: options.runner,
    integration: context.integration,
    secrets: options.secrets,
    allowLocalRunnerFallback: false,
    ...(options.customRunners ? { customRunners: options.customRunners } : {}),
    ...(options.tokenProvider ? { tokenProvider: options.tokenProvider } : {}),
    ...(options.credentialsTokenCommand
      ? { credentialsTokenCommand: options.credentialsTokenCommand }
      : {}),
  });
}

async function collectPairCountWarnings(
  spec: ResolvedResolutionSpec,
  runner: SqlRunnerModule,
  schema: string,
  dialect: SupportedDialect
): Promise<string[]> {
  if (runner.query == null) {
    return [];
  }
  try {
    const pairCountQuery = [
      `SELECT COUNT(*) AS ${quoteIdentifier('pair_count', dialect)}`,
      `FROM ${buildFqName(schema, outputTableName(spec.entity, '__candidate_pairs'), dialect)}`,
    ].join('\n');
    const rawRows = await runner.query(pairCountQuery);
    const firstRow = rawRows[0];
    if (!firstRow) {
      return [];
    }

    const entries = new Map(
      Object.entries(firstRow).map(([key, value]) => [key.toLowerCase(), value])
    );
    const pairCount = Number(entries.get('pair_count'));
    const warnLimit = spec.pairCountWarnLimit ?? 100_000;
    return Number.isFinite(pairCount) && pairCount > warnLimit
      ? [
          `${spec.entity}: candidate pair count ${pairCount} exceeds pair_count_warn_limit=${warnLimit}.`,
        ]
      : [];
  } catch {
    return [`${spec.entity}: pair-count probe failed; skipping pair_count_warn_limit check.`];
  }
}

function isMissingResolveStateError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /does(?:n't| not) exist|not found|unknown table|no such table|object .* does not exist|table or view .* not found|relation .* does not exist|SQLSTATE.*42P01/i.test(
    message
  );
}

async function queryCurrentWatermark(
  query: SqlQueryRunner,
  source: ResolveStateSourceDefinition,
  dialect: SupportedDialect
): Promise<string | null> {
  const rows = await query(buildSourceWatermarkQuery(source, dialect));
  const first = rows[0];
  if (!first) return null;
  const raw = readField(first, 'watermark_value');
  return raw == null ? null : String(raw);
}

async function queryResolveStateRows(
  query: SqlQueryRunner,
  spec: ResolvedResolutionSpec,
  targetSchema: string,
  dialect: SupportedDialect
): Promise<ResolveStateRow[] | undefined> {
  try {
    return normalizeResolveStateRows(
      await query(buildResolveStateSelectQuery(spec.entity, targetSchema, dialect))
    );
  } catch (error) {
    if (isMissingResolveStateError(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function planResolveRunMode(input: {
  spec: ResolvedResolutionSpec;
  dialect: SupportedDialect;
  targetSchema: string;
  incrementalRequested: boolean;
  query?: SqlQueryRunner;
}): Promise<{
  mode: ResolveRunMode;
  modeReason: string;
  runId: string;
  specFingerprint: string;
  sources: ResolveStateSourceDefinition[];
  incremental?: ResolutionIncrementalOptions;
  capturedWatermarkValues?: Map<string, string | null>;
}> {
  const { spec, dialect, targetSchema } = input;
  const effectiveSchema = spec.targetSchema ?? targetSchema;
  const specFingerprint = computeResolutionRunFingerprint(spec, dialect, effectiveSchema);
  const sources = resolveStateSourceDefinitions(spec);
  const runId = `resolve_${randomUUID()}`;

  if (!input.incrementalRequested) {
    return {
      mode: 'full',
      modeReason: 'full_run_requested',
      runId,
      specFingerprint,
      sources,
    };
  }

  if (!input.query) {
    throw new CommandError(
      '--incremental requires a query-capable runner so resolve_state can be checked.',
      2
    );
  }

  const stateRows = await queryResolveStateRows(input.query, spec, effectiveSchema, dialect);
  if (!stateRows) {
    return {
      mode: 'full',
      modeReason: 'resolve_state_missing',
      runId,
      specFingerprint,
      sources,
    };
  }
  const stateBySource = new Map(stateRows.map((row) => [row.source_ref, row]));
  const incrementalSources: ResolutionIncrementalOptions['sources'] = [];
  // Snapshot each source's watermark BEFORE the delta pipeline runs; recording
  // this pre-scan value (not a live recompute after the run) closes the
  // state-write TOCTOU race that would otherwise silently skip rows committed
  // mid-run. See generateResolveStateInsertSql.capturedWatermarkValues.
  const capturedWatermarkValues = new Map<string, string | null>();

  for (const source of sources) {
    const state = stateBySource.get(source.sourceRef);
    if (!state) {
      return {
        mode: 'full',
        modeReason: `resolve_state_missing:${source.sourceRef}`,
        runId,
        specFingerprint,
        sources,
      };
    }
    if (state.spec_fingerprint !== specFingerprint) {
      return {
        mode: 'full',
        modeReason: `spec_fingerprint_changed:${source.sourceRef}`,
        runId,
        specFingerprint,
        sources,
      };
    }
    if (source.watermarkKind === 'full_refresh_only') {
      return {
        mode: 'full',
        modeReason: `full_refresh_only:${source.sourceRef}`,
        runId,
        specFingerprint,
        sources,
      };
    }
    if (source.watermarkKind === 'content_fingerprint') {
      const current = await queryCurrentWatermark(input.query, source, dialect);
      if (current !== state.watermark_value) {
        return {
          mode: 'full',
          modeReason: `content_fingerprint_changed:${source.sourceRef}`,
          runId,
          specFingerprint,
          sources,
        };
      }
      // Fingerprint matched: record the value we just observed (a fingerprint
      // source that is unchanged produces no delta, so pre-scan == post-scan).
      capturedWatermarkValues.set(source.sourceRef, current);
    } else {
      // loaded_at: capture MAX(loaded_at) now, before the delta scan.
      capturedWatermarkValues.set(
        source.sourceRef,
        await queryCurrentWatermark(input.query, source, dialect)
      );
    }
    incrementalSources.push({
      ...source,
      previousWatermarkValue: state.watermark_value,
    });
  }

  return {
    mode: 'incremental',
    modeReason: 'resolve_state_matched',
    runId,
    specFingerprint,
    sources,
    incremental: {
      runId,
      specFingerprint,
      modeReason: 'resolve_state_matched',
      sources: incrementalSources,
    },
    capturedWatermarkValues,
  };
}

/**
 * COUNT(*) of a phase's primary output table, reading the single count column
 * case-insensitively (warehouses vary identifier case). Returns `undefined` on
 * any failure (table not yet created, probe error) so callers can leave
 * `rows_written` absent rather than asserting a misleading 0.
 */
async function countOutputRows(
  query: NonNullable<SqlRunnerModule['query']>,
  schema: string,
  table: string,
  dialect: SupportedDialect
): Promise<number | undefined> {
  try {
    const rows = await query(
      [
        `SELECT COUNT(*) AS ${quoteIdentifier('row_count', dialect)}`,
        `FROM ${buildFqName(schema, table, dialect)}`,
      ].join('\n')
    );
    const firstRow = rows[0];
    if (!firstRow) {
      return 0;
    }
    const count = Number(readField(firstRow, 'row_count'));
    return Number.isFinite(count) ? count : 0;
  } catch {
    return undefined;
  }
}

export async function validateResolveProject(
  options: ResolveWorkflowOptions
): Promise<ResolveWorkflowResult<ResolveValidateEntity>> {
  const context = await loadEntityGraphProjectContext(options);
  return {
    context,
    entities: context.specs.map((spec) => ({
      entity: spec.entity,
      name: spec.name,
      target_schema: spec.targetSchema ?? context.targetSchema,
      input_count: spec.inputs.length,
      blocking_rule_count: spec.blocking?.rules.length ?? 0,
      deterministic_rule_count: spec.deterministicRules.length,
      scoring_feature_count:
        spec.scoring?.method === 'weighted_features' ? spec.scoring.features.length : 0,
      scoring_method: spec.scoring?.method,
      scoring_comparison_count:
        spec.scoring?.method === 'fellegi_sunter' ? spec.scoring.comparisons.length : undefined,
    })),
  };
}

export async function compileResolveProject(
  options: ResolveWorkflowOptions
): Promise<ResolveWorkflowResult<ResolveCompileEntity>> {
  const context = await loadEntityGraphProjectContext(options);
  return {
    context,
    entities: context.specs.map((spec) => {
      const result = compileResolution(spec, context.dialect, context.targetSchema);
      return {
        entity: spec.entity,
        name: spec.name,
        dialect: context.dialect,
        schema: spec.targetSchema ?? context.targetSchema,
        statement_count: statementCount(result),
        warnings: result.warnings,
        spec,
        result,
      };
    }),
  };
}

export async function runResolveProject(
  options: ResolveWorkflowOptions & {
    withSurvivorship?: boolean;
    withoutSurvivorship?: boolean;
  }
): Promise<ResolveWorkflowResult<ResolveExecutionEntity>> {
  if (options.withSurvivorship && options.withoutSurvivorship) {
    throw new CommandError(
      '--with-survivorship and --without-survivorship are mutually exclusive.',
      2
    );
  }

  const context = await loadEntityGraphProjectContext(options);
  const runnerHandle = await resolveRunnerForWorkflow(context, options);
  const entities: ResolveExecutionEntity[] = [];

  try {
    for (const spec of context.specs) {
      const effectiveSchema = spec.targetSchema ?? context.targetSchema;
      if (options.incremental && options.dryRun) {
        throw new CommandError(
          '--incremental cannot be combined with --dry-run because resolve_state must be checked.',
          2
        );
      }
      const modePlan = await planResolveRunMode({
        spec,
        dialect: context.dialect,
        targetSchema: context.targetSchema,
        incrementalRequested: options.incremental === true,
        query: runnerHandle?.runner.query,
      });
      const runResult = compileResolutionRun(spec, context.dialect, context.targetSchema, {
        ...(modePlan.incremental ? { incremental: modePlan.incremental } : {}),
        state: {
          runId: modePlan.runId,
          specFingerprint: modePlan.specFingerprint,
          mode: modePlan.mode,
          modeReason: modePlan.modeReason,
          sources: modePlan.sources,
          ...(modePlan.capturedWatermarkValues
            ? { capturedWatermarkValues: modePlan.capturedWatermarkValues }
            : {}),
        },
      });
      const survivorshipSpec = options.withoutSurvivorship
        ? undefined
        : discoverColocatedSurvivorshipSpec(spec, effectiveSchema, context.entityGraphDir);
      const shouldRunSurvivorship = survivorshipSpec != null || options.withSurvivorship === true;
      if (options.withSurvivorship === true && survivorshipSpec == null) {
        throw new CommandError(`No survivorship spec found for ${spec.entity}.`, 2);
      }
      // When a survivorship spec is present, refine the cluster-phase golden
      // tables (`__golden_record` + `__golden`) with its per-attribute rules so
      // both reflect the rich strategy; the survivorship compiler itself only
      // emits the audit trail.
      const clusterOpts = survivorshipSpec
        ? { goldenRules: survivorshipSpec.attributeRules.map(toGoldenAttributeRule) }
        : undefined;
      const directModeStatements =
        options.mode === 'direct'
          ? [
              ...compileResolutionCluster(spec, context.dialect, context.targetSchema, clusterOpts)
                .statements,
              ...compileResolutionProfile(spec, context.dialect, context.targetSchema).statements,
            ]
          : [];
      const extraStatements =
        shouldRunSurvivorship && survivorshipSpec
          ? [
              ...(options.mode === 'direct'
                ? []
                : [
                    ...compileResolutionCluster(
                      spec,
                      context.dialect,
                      context.targetSchema,
                      clusterOpts
                    ).statements,
                    ...compileResolutionProfile(spec, context.dialect, context.targetSchema)
                      .statements,
                  ]),
              ...generateAuditLogDdl(context.dialect),
              ...compileSurvivorship(survivorshipSpec, context.dialect).statements,
              generateSurvivorshipAuditSql(survivorshipSpec, context.dialect),
            ]
          : [];
      const result: ResolutionCompileResult = {
        ...runResult,
        statements: [...runResult.statements, ...directModeStatements, ...extraStatements],
        tableNames: [
          ...runResult.tableNames,
          ...directModeStatements.flatMap((statement) =>
            statement.tableCreated ? [statement.tableCreated] : []
          ),
          ...extraStatements.flatMap((statement) =>
            statement.tableCreated ? [statement.tableCreated] : []
          ),
        ],
      };

      if (!runnerHandle) {
        const entity = dryRunEntity(spec, context.dialect, context.targetSchema, result);
        entity.mode = modePlan.mode;
        entity.mode_reason = modePlan.modeReason;
        entities.push(entity);
        continue;
      }

      const semanticExecution = await runSemanticTriageForResolution(
        spec,
        runnerHandle.runner,
        result,
        context.dialect,
        effectiveSchema,
        context.quiet,
        executionCallbacks
      );
      const executionResults = semanticExecution.executionResults;
      const preambleResult = result.preamble ? executionResults[0] : undefined;
      const statementResults = result.preamble ? executionResults.slice(1) : executionResults;
      const failed = executionResults.filter((row) => row.status === 'failed');
      const runtimeWarnings = [...result.warnings, ...semanticExecution.warnings];

      if (failed.length === 0 && (spec.blocking?.rules.length ?? 0) === 0) {
        runtimeWarnings.push(
          ...(await collectPairCountWarnings(
            spec,
            runnerHandle.runner,
            effectiveSchema,
            context.dialect
          ))
        );
      }

      const entity: ResolveExecutionEntity = {
        entity: spec.entity,
        name: spec.name,
        dialect: context.dialect,
        schema: effectiveSchema,
        executed: true,
        dry_run: false,
        mode: modePlan.mode,
        mode_reason: modePlan.modeReason,
        statement_count: statementCount(result),
        preamble: result.preamble
          ? toResolvePreambleJson(result.preamble, preambleResult)
          : undefined,
        statements: result.statements.map((stmt, index) =>
          toResolveStatementJson(stmt, statementResults[index])
        ),
        warnings: runtimeWarnings,
      };
      entities.push(entity);

      if (failed.length === 0 && runnerHandle.runner.query) {
        const count = await countOutputRows(
          runnerHandle.runner.query,
          effectiveSchema,
          outputTableName(
            spec.entity,
            modePlan.mode === 'incremental' ? '__standardized_delta' : '__standardized'
          ),
          context.dialect
        );
        if (count !== undefined) {
          entity.rows_written = count;
          entity.skipped = count === 0;
        }
      }

      if (failed.length > 0) {
        return { context, entities, failure: buildWorkflowFailure(spec.entity, failed) };
      }
    }
  } finally {
    await runnerHandle?.close();
  }

  return { context, entities };
}

async function executeSimpleResolvePhase(
  options: ResolveWorkflowOptions,
  compile: (
    spec: ResolvedResolutionSpec,
    dialect: SupportedDialect,
    targetSchema: string
  ) => ResolutionCompileResult,
  includeEntitySummary: boolean,
  /**
   * Suffix of the phase's PRIMARY output table (e.g. `__entity_id_current` for
   * cluster, `__entity_profile` for profile). When set and a query-capable
   * runner is available, the executed entity is annotated with `rows_written` +
   * `skipped` so downstream consumers can gate on real output.
   */
  primaryOutputTableSuffix?: string
): Promise<ResolveWorkflowResult<ResolveExecutionEntity>> {
  const context = await loadEntityGraphProjectContext(options);
  const runnerHandle = await resolveRunnerForWorkflow(context, options);
  const entities: ResolveExecutionEntity[] = [];

  try {
    for (const spec of context.specs) {
      const result = compile(spec, context.dialect, context.targetSchema);
      const effectiveSchema = spec.targetSchema ?? context.targetSchema;

      if (!runnerHandle) {
        entities.push(dryRunEntity(spec, context.dialect, context.targetSchema, result));
        continue;
      }

      const executionResults = await executeEntityGraphPlan(
        spec.entity,
        runnerHandle.runner,
        { ...result, dialect: context.dialect },
        context.quiet,
        executionCallbacks
      );
      const preambleResult = result.preamble ? executionResults[0] : undefined;
      const statementResults = result.preamble ? executionResults.slice(1) : executionResults;
      const failed = executionResults.filter((row) => row.status === 'failed');
      const entity: ResolveExecutionEntity = {
        entity: spec.entity,
        name: spec.name,
        dialect: context.dialect,
        schema: effectiveSchema,
        executed: true,
        dry_run: false,
        statement_count: statementCount(result),
        preamble: result.preamble
          ? toResolvePreambleJson(result.preamble, preambleResult)
          : undefined,
        statements: result.statements.map((stmt, index) =>
          toResolveStatementJson(stmt, statementResults[index])
        ),
        warnings: result.warnings,
      };
      entities.push(entity);

      if (includeEntitySummary && failed.length === 0 && runnerHandle.runner.query) {
        try {
          entity.entity_id_summary = await queryEntityIdSummaryWithRunner(
            spec.entity,
            runnerHandle.runner.query,
            effectiveSchema,
            context.dialect
          );
        } catch {
          entity.warnings = [
            ...entity.warnings,
            `${spec.entity}: entity ID summary query failed; continuing without summary.`,
          ];
        }
      }

      // Annotate the executed entity with its primary-output row count so
      // downstream consumers can gate phase
      // completion on real output instead of the `executed` flag.
      if (primaryOutputTableSuffix && failed.length === 0 && runnerHandle.runner.query) {
        const count = await countOutputRows(
          runnerHandle.runner.query,
          effectiveSchema,
          outputTableName(spec.entity, primaryOutputTableSuffix),
          context.dialect
        );
        if (count !== undefined) {
          entity.rows_written = count;
          entity.skipped = count === 0;
        }
      }

      if (failed.length > 0) {
        return { context, entities, failure: buildWorkflowFailure(spec.entity, failed) };
      }
    }
  } finally {
    await runnerHandle?.close();
  }

  return { context, entities };
}

export async function clusterResolveProject(
  options: ResolveWorkflowOptions
): Promise<ResolveWorkflowResult<ResolveExecutionEntity>> {
  return executeSimpleResolvePhase(options, compileResolutionCluster, true, '__entity_id_current');
}

export async function profileResolveProject(
  options: ResolveWorkflowOptions
): Promise<ResolveWorkflowResult<ResolveExecutionEntity>> {
  return executeSimpleResolvePhase(options, compileResolutionProfile, false, '__entity_profile');
}
