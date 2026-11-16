/**
 * Resolution codegen orchestrator — compose all pipeline stages.
 *
 * Takes a ResolvedResolutionSpec and dialect, returns ordered SQL
 * statements for the entire resolution pipeline.
 */

import { getCanonicalDialect } from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { ResolvedResolutionSpec, ResolutionCompileResult, SqlStatement } from './types.js';
import {
  generateDeleteUpdatedStandardizedSql,
  generateInsertStandardizedDeltaSql,
  generateStandardizeSql,
} from './codegen-standardize.js';
import { generateBlockingSql, generateInsertCandidatePairsDeltaSql } from './codegen-blocking.js';
import { generateScoringSql } from './codegen-scoring.js';
import { generateThresholdSql } from './codegen-threshold.js';
import { generateSemanticTriageSql } from './codegen-semantic-triage.js';
import { generateComponentsSql } from './codegen-clustering.js';
import { generateCrosswalkSql } from './codegen-crosswalk.js';
import { generateEntityProfileSql } from './codegen-entity-profile.js';
import { generateGoldenRecordSql, generateGoldenWideSql } from './codegen-golden.js';
import { generateMaskedGoldenViewSql } from './codegen-governance.js';
import { generateTrustScoringSql } from './codegen-trust.js';
import type { GoldenAttributeRule } from './survivorship-ranking.js';
import { generateActivationSql } from './codegen-activation.js';
import { generateCleanViewsSql } from './codegen-views.js';
import { generateFuzzyPreamble, inlineFuzzyUdf } from '../core/dialect-similarity.js';
import { generateAuditLogDdl } from '../audit/codegen.js';
import { generateEntityIdBootstrapDdl, generateMaterializeDdl } from './materializer.js';
import { generateIncrementalDerivedPurgeSql } from './codegen-incremental.js';
import {
  generateInsertMatchInboxDeltaSql,
  generateMarkMatchInboxDrainedSql,
} from './codegen-match-inbox.js';
import {
  generateResolveRunAuditSql,
  generateResolveStateDeleteSql,
  generateResolveStateInsertSql,
  type ResolutionIncrementalOptions,
  type ResolveRunMode,
  type ResolveStateSourceDefinition,
} from './codegen-resolve-state.js';
import {
  generateEntityIdAliasesSql,
  generateEntityIdAssignmentEventsSql,
  generateEntityIdBackfillSql,
  generateEntityIdCurrentSql,
  generateEntityIdRecordMapSql,
  generateStableClustersSql,
} from './codegen-entity-id.js';

export interface CompileResolutionRunOptions {
  incremental?: ResolutionIncrementalOptions;
  state?: {
    runId: string;
    specFingerprint: string;
    mode: ResolveRunMode;
    modeReason: string;
    sources: ResolveStateSourceDefinition[];
    /** Plan-time watermark snapshots (source_ref → value) closing the state-write TOCTOU race. */
    capturedWatermarkValues?: ReadonlyMap<string, string | null>;
  };
}

function generateHashPreamble(spec: ResolvedResolutionSpec, dialect: SupportedDialect): string {
  if (dialect === 'redshift' || getCanonicalDialect(dialect) !== 'postgres') {
    return '';
  }
  const usesHash = spec.standardize.some((standardize) =>
    standardize.transforms.some(
      (transform) => transform === 'sha256' || transform === 'hmac_sha256'
    )
  );
  return usesHash ? 'CREATE EXTENSION IF NOT EXISTS pgcrypto;' : '';
}

function combinePreambles(...parts: string[]): string {
  return parts.filter((part) => part.trim().length > 0).join('\n');
}

/**
 * Compile a resolution spec through the threshold stage.
 * This is the `bobsled entity-graph resolve run` pipeline — standardize through routing.
 */
export function compileResolutionRun(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string,
  opts?: CompileResolutionRunOptions
): ResolutionCompileResult {
  // `incremental` and `state` must travel together: an incremental delta run
  // that never advances resolve_state would reprocess the same delta forever.
  // (A state-only run is valid — that's the full-run baseline.)
  if (opts?.incremental && !opts.state) {
    throw new Error('compileResolutionRun: incremental runs require a state option to persist.');
  }

  const warnings: string[] = [];
  const statements: SqlStatement[] = [];
  const effectiveSchema = spec.targetSchema ?? targetSchema;

  // Preamble (BigQuery Jaro-Winkler UDF, etc.)
  const preamble = combinePreambles(
    generateFuzzyPreamble(dialect),
    generateHashPreamble(spec, dialect)
  );

  // Create append-only tables before any stage references them.
  const ddlStatements = generateMaterializeDdl(spec.entity, dialect, effectiveSchema).filter(
    (statement) => !statement.name.startsWith('ddl_entity_id_')
  );
  statements.push(...ddlStatements);
  if (spec.semanticTriage || opts?.state) {
    statements.push(...generateAuditLogDdl(dialect));
  }

  if (opts?.incremental) {
    // Incremental stages: materialize delta rows, purge prior derived rows for
    // updated records, append the delta into accumulated tables, then route over
    // the accumulated score set. Clustering/profile remain full passes.
    statements.push(generateStandardizeSql(spec, dialect, effectiveSchema, opts));
    statements.push(generateInsertMatchInboxDeltaSql(spec, dialect, effectiveSchema));
    statements.push(...generateIncrementalDerivedPurgeSql(spec, dialect, effectiveSchema));
    statements.push(generateDeleteUpdatedStandardizedSql(spec, dialect, effectiveSchema));
    statements.push(generateInsertStandardizedDeltaSql(spec, dialect, effectiveSchema));
    statements.push(generateBlockingSql(spec, dialect, effectiveSchema, opts));
    statements.push(generateInsertCandidatePairsDeltaSql(spec, dialect, effectiveSchema));
    statements.push(generateScoringSql(spec, dialect, effectiveSchema, opts));
  } else {
    // Stage 1: Standardization
    statements.push(generateStandardizeSql(spec, dialect, effectiveSchema));

    // Stage 2: Blocking (candidate pairs)
    statements.push(generateBlockingSql(spec, dialect, effectiveSchema));
  }
  if ((spec.blocking?.rules?.length ?? 0) === 0) {
    const pairGenerationMsg =
      spec.blocking?.candidateLimit == null
        ? 'all pairs generated via full cross-join.'
        : `pairs generated via full cross-join, capped at ${spec.blocking.candidateLimit}.`;
    warnings.push(
      [
        `Entity "${spec.entity}": blocking is disabled — ${pairGenerationMsg}`,
        `Pair count warning threshold: ${spec.pairCountWarnLimit ?? 100_000}. Enable blocking or set`,
        `pair_count_warn_limit to adjust.`,
      ].join('\n')
    );
  }

  // Stage 3: Scoring (L1 deterministic + L2 fuzzy)
  if (!opts?.incremental) {
    statements.push(generateScoringSql(spec, dialect, effectiveSchema));
  }
  if (spec.thresholds.autoMerge === null) {
    // With score-driven auto-merge disabled, EVERY auto_merge deterministic
    // pair merges regardless of its confidence — surface miscalibrated rules
    // at compile time instead of as bad merges. flag_for_review rules never
    // merge on their own, so low confidence there is fine.
    const lowConfidenceRules = spec.deterministicRules.filter(
      (rule) => rule.action === 'auto_merge' && rule.confidence < spec.thresholds.review
    );
    if (lowConfidenceRules.length > 0) {
      warnings.push(
        [
          `Entity "${spec.entity}": auto_merge is null, so deterministic rules always merge —`,
          `but ${lowConfidenceRules.map((rule) => `"${rule.name}" (confidence ${rule.confidence})`).join(', ')}`,
          `score${lowConfidenceRules.length === 1 ? 's' : ''} below the review threshold (${spec.thresholds.review}).`,
          `Raise the rule confidence or tighten its conditions if these merges are not intended.`,
        ].join(' ')
      );
    }
  }

  // Stage 4: Threshold routing (review queue)
  statements.push(generateThresholdSql(spec, dialect, effectiveSchema));
  const semanticTriage = generateSemanticTriageSql(spec, dialect, effectiveSchema);
  statements.push(...semanticTriage.statements);
  warnings.push(...semanticTriage.warnings);

  if (opts?.incremental) {
    statements.push(
      generateMarkMatchInboxDrainedSql(spec, dialect, effectiveSchema, opts.incremental.runId)
    );
  }

  if (opts?.state) {
    statements.push(
      generateResolveRunAuditSql(spec, dialect, {
        runId: opts.state.runId,
        specFingerprint: opts.state.specFingerprint,
        mode: opts.state.mode,
        modeReason: opts.state.modeReason,
        sourceCount: opts.state.sources.length,
      }),
      generateResolveStateDeleteSql(spec, dialect, effectiveSchema),
      generateResolveStateInsertSql(spec, dialect, effectiveSchema, {
        runId: opts.state.runId,
        specFingerprint: opts.state.specFingerprint,
        sources: opts.state.sources,
        ...(opts.state.capturedWatermarkValues
          ? { capturedWatermarkValues: opts.state.capturedWatermarkValues }
          : {}),
      })
    );
  }

  const tableNames = statements.filter((s) => s.tableCreated).map((s) => s.tableCreated!);

  // On BigQuery the Jaro-Winkler UDF is a job-scoped temp function, so it must be
  // inlined into each statement that calls it rather than emitted as a standalone
  // preamble. No-op for every other dialect.
  const inlinedStatements = inlineFuzzyUdf(statements, getCanonicalDialect(dialect));

  return {
    ok: true,
    statements: inlinedStatements,
    entityName: spec.entity,
    tableNames,
    warnings,
    preamble: preamble || undefined,
  };
}

/**
 * Compile the entity serving profile stage.
 * This is the `bobsled entity-graph resolve profile` pipeline — entity profile, trust, activations.
 */
export function compileResolutionProfile(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): ResolutionCompileResult {
  const effectiveSchema = spec.targetSchema ?? targetSchema;
  const viewResult = generateCleanViewsSql(spec, dialect, effectiveSchema);
  const statements: SqlStatement[] = [
    generateEntityProfileSql(spec, dialect, effectiveSchema),
    generateTrustScoringSql(spec, dialect, effectiveSchema),
    ...generateActivationSql(spec, dialect, effectiveSchema),
    ...viewResult.statements,
  ];
  const tableNames = statements
    .filter((statement) => statement.tableCreated)
    .map((statement) => statement.tableCreated!);

  return {
    ok: true,
    statements,
    entityName: spec.entity,
    tableNames,
    warnings: [...viewResult.warnings],
  };
}

/**
 * Compile the clustering stage.
 * This is the `bobsled entity-graph resolve cluster` pipeline — clusters + crosswalks.
 */
export function compileResolutionCluster(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string,
  opts?: { goldenRules?: GoldenAttributeRule[] }
): ResolutionCompileResult {
  const warnings: string[] = [];
  const statements: SqlStatement[] = [];
  const effectiveSchema = spec.targetSchema ?? targetSchema;

  // Stage 5: Connected components + stable entity ID assignment.
  statements.push(...generateEntityIdBootstrapDdl(spec.entity, dialect, effectiveSchema));
  statements.push(generateEntityIdBackfillSql(spec, dialect, effectiveSchema));
  statements.push(
    generateEntityIdRecordMapSql(spec, dialect, effectiveSchema, 'bootstrap_entity_id_record_map')
  );
  statements.push(
    generateEntityIdAliasesSql(spec, dialect, effectiveSchema, 'bootstrap_entity_id_aliases')
  );
  statements.push(generateComponentsSql(spec, dialect, effectiveSchema));
  statements.push(generateEntityIdAssignmentEventsSql(spec, dialect, effectiveSchema));
  statements.push(generateEntityIdRecordMapSql(spec, dialect, effectiveSchema));
  statements.push(generateEntityIdAliasesSql(spec, dialect, effectiveSchema));
  statements.push(generateEntityIdCurrentSql(spec, dialect, effectiveSchema));
  statements.push(generateStableClustersSql(spec, dialect, effectiveSchema));

  // Stage 6: Crosswalks
  statements.push(generateCrosswalkSql(spec, dialect, effectiveSchema));

  // Stage 7: Golden record. The EAV (`__golden_record`) is populated by default
  // from profile.attributes (no survivorship spec required); the wide
  // (`__golden`) pivots it into a query-ready, one-row-per-entity table. A
  // co-located survivorship spec refines the per-attribute rules via goldenRules.
  statements.push(generateGoldenRecordSql(spec, dialect, effectiveSchema, opts?.goldenRules));
  statements.push(generateGoldenWideSql(spec, dialect, effectiveSchema, opts?.goldenRules));
  const maskedGolden = generateMaskedGoldenViewSql(spec, dialect, effectiveSchema);
  if (maskedGolden) {
    statements.push(maskedGolden);
  }

  const tableNames = statements.filter((s) => s.tableCreated).map((s) => s.tableCreated!);

  return {
    ok: true,
    statements,
    entityName: spec.entity,
    tableNames,
    warnings,
  };
}

/**
 * Compile the full resolution pipeline (run + cluster).
 * Used for compile-to-file output (`bobsled entity-graph resolve compile`).
 */
export function compileResolution(
  spec: ResolvedResolutionSpec,
  dialect: SupportedDialect,
  targetSchema: string
): ResolutionCompileResult {
  const runResult = compileResolutionRun(spec, dialect, targetSchema);
  const clusterResult = compileResolutionCluster(spec, dialect, targetSchema);
  const profileResult = compileResolutionProfile(spec, dialect, targetSchema);

  return {
    ok: true,
    statements: [...runResult.statements, ...clusterResult.statements, ...profileResult.statements],
    entityName: spec.entity,
    tableNames: [...runResult.tableNames, ...clusterResult.tableNames, ...profileResult.tableNames],
    warnings: [...runResult.warnings, ...clusterResult.warnings, ...profileResult.warnings],
    preamble: runResult.preamble,
  };
}
