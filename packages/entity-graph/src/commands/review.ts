/**
 * `dogsled entity-graph review` command group.
 *
 * Provides export and apply subcommands for human review workflow:
 *   dogsled entity-graph review export [entity...] --format=csv|json|yaml
 *   dogsled entity-graph review apply --input=file.csv|json|yaml
 *
 * Exit codes:
 *   0 = success
 *   2 = validation error (all stale pair IDs, empty input, etc.)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { Option, type Command } from 'commander';
import { z } from 'zod';
import { CommandError } from '@bobsled-inc/protocol';

import {
  formatExport,
  generateExportQuery,
  type ReviewExportFormat,
} from '../compiler/identity/review-export.js';
import { generateApplySql } from '../compiler/identity/review-apply.js';
import {
  generateAuditLogDdl,
  generateReviewApplyAuditSql,
  generateSurvivorshipAuditSql,
} from '../compiler/audit/codegen.js';
import { generateMaterializeDdl } from '../compiler/identity/materializer.js';
import {
  compileResolutionCluster,
  compileResolutionProfile,
} from '../compiler/identity/codegen.js';
import { generateUnmergeSql } from '../compiler/identity/codegen-unmerge.js';
import { compileSurvivorship } from '../compiler/survivorship/codegen.js';
import { buildResolveContext } from './resolve-context.js';
import { validateKeepRecordIdsForCluster } from './review-unmerge.js';
import { discoverColocatedSurvivorshipSpec } from './survivorship-discovery.js';
import { AgentThresholdBandSchema, AGENT_THRESHOLD_BANDS } from '../compiler/agent/schema.js';
import { out } from '@bobsled-inc/model-spec/shared';

import type { ModelExecutionResult, SupportedDialect } from '@bobsled-inc/model-spec';
import { executeSqlStatements } from '@bobsled-inc/model-spec';
import type { ReviewExportRow } from '../compiler/identity/types.js';
import { quoteIdentifier, quoteLiteral } from '@bobsled-inc/model-spec';

import {
  createDialectOption,
  loadRunnerModule,
  parsePositiveIntOption,
} from '@bobsled-inc/model-spec/shared';
import { registerFeedbackSubcommand } from './review-feedback.js';
import { applyHandler, type ApplyOptions } from './review-apply-command.js';
import {
  buildContentHash,
  buildDecisionBatchId,
  resolveReviewTargets,
  type ReviewGlobalFlags,
  type ReviewTarget,
} from './review-support.js';

type ReviewConfidenceThresholds = {
  default: number;
  byBand?: Partial<Record<(typeof AGENT_THRESHOLD_BANDS)[number], number>>;
};

interface ReviewExportJsonEntity {
  entity: string;
  name: string;
  schema: string;
  format: ReviewExportFormat;
  materialized: boolean;
  row_count?: number;
  output_path?: string;
  query?: string;
  rows?: ReviewExportRow[];
}

const ReviewExportRowsSchema = z.array(
  z.object({
    pair_id: z.string(),
    record_a_id: z.string(),
    record_b_id: z.string(),
    source_a: z.string(),
    source_b: z.string(),
    composite_score: z.number(),
    threshold_band: AgentThresholdBandSchema,
    blocking_rules: z.string(),
    field_diffs: z.string(),
    recommended_action: z.enum(['merge', 'not_match']),
    // `escalate` retained for backward compatibility — `review export/list/show`
    // must still parse historical `__review_decisions` rows from before the
    // defer/escalate collapse. New runs only emit merge/not_match/defer.
    decision: z.enum(['merge', 'not_match', 'defer', 'escalate']).nullable().optional(),
    confidence: z.coerce.number().min(0).max(1).nullable().optional(),
    reviewer: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
    proposed_decision: z.enum(['merge', 'not_match', 'defer', 'escalate']).nullable().optional(),
    proposed_confidence: z.coerce.number().min(0).max(1).nullable().optional(),
    confidence_gap: z.coerce.number().nullable().optional(),
    decided_at: z.string().nullable().optional(),
    decision_source: z.string().nullable().optional(),
    decision_batch_id: z.string().nullable().optional(),
    applied_at: z.string().nullable().optional(),
  })
);

function buildReviewConfidenceThresholds(target: ReviewTarget): ReviewConfidenceThresholds {
  return {
    default: target.defaultApplyThreshold,
  };
}

function buildReviewPairQuery(
  entityName: string,
  targetSchema: string,
  pairId: string,
  dialect: SupportedDialect,
  confidenceThresholds?: ReviewConfidenceThresholds
): string {
  const queueQuery = generateExportQuery(entityName, targetSchema, 0.5, dialect, {
    pendingOnly: false,
    includeDecisionColumns: true,
    confidenceThresholds,
  });
  return [
    `SELECT *`,
    `FROM (`,
    queueQuery,
    `) queue_with_decisions`,
    `WHERE ${quoteIdentifier('pair_id', dialect)} = ${quoteLiteral(pairId, dialect)}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Export command
// ---------------------------------------------------------------------------

interface ExportOptions {
  format?: ReviewExportFormat;
  output?: string;
  schema?: string;
  dialect?: SupportedDialect;
  runner?: string;
  template?: boolean;
  all?: boolean;
  limit?: number;
  json?: boolean;
}

/** Export review queue rows or SQL for one or more resolved entities. */
async function exportHandler(
  entityNames: string[],
  options: ExportOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  if (entityNames.length === 0) {
    throw new CommandError('At least one entity name is required for review export.', 2);
  }

  if (options.output && entityNames.length > 1) {
    throw new CommandError('--output supports one entity at a time for review export.', 2);
  }

  const { targets, dialect, quiet } = resolveReviewTargets(entityNames, options, globalOptions);
  const runner = options.runner ? await loadRunnerModule(options.runner) : undefined;
  const format = options.format ?? 'csv';
  const outputPath = options.output ? path.resolve(options.output) : undefined;
  const exportsJson: ReviewExportJsonEntity[] = [];
  const pendingOnly = !options.all;
  const template = options.template ?? false;
  const limit = options.limit;

  if (!outputPath && !options.json && runner?.query != null && targets.length > 1) {
    throw new CommandError(
      'Materialized review export for multiple entities requires --json or --output.',
      2
    );
  }

  for (const target of targets) {
    const query = generateExportQuery(target.entity, target.schema, target.midpoint, dialect, {
      pendingOnly,
      includeDecisionColumns: template || !pendingOnly,
      limit,
      confidenceThresholds: buildReviewConfidenceThresholds(target),
    });
    let rows: ReviewExportRow[] | undefined;
    if (runner?.query != null) {
      const rawRows = await runner.query(query);
      const parsedRows = ReviewExportRowsSchema.safeParse(rawRows);
      if (!parsedRows.success) {
        const issue = parsedRows.error.issues[0];
        throw new CommandError(
          `Runner query for ${target.entity} returned invalid review rows: ${issue?.message ?? 'schema validation failed'}`,
          1
        );
      }
      rows = parsedRows.data;
    }
    const content = rows != null ? formatExport(rows, format, { template }) : `${query}\n`;

    if (outputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, content, 'utf-8');
      if (!quiet && !options.json) {
        out.info(
          rows != null
            ? `Exported review queue for ${target.entity} to ${outputPath}`
            : `Wrote review export SQL for ${target.entity} to ${outputPath}`
        );
      }
    } else if (!options.json) {
      if (rows == null && !quiet) {
        out.info(
          `No --runner query interface provided. Emitting SQL for ${target.entity} instead of materialized ${format.toUpperCase()}.`
        );
      }

      out.text(content);
    }

    exportsJson.push({
      entity: target.entity,
      name: target.name,
      schema: target.schema,
      format,
      materialized: rows != null,
      row_count: rows?.length,
      output_path: outputPath,
      query: rows == null ? query : undefined,
      rows: outputPath || rows == null ? undefined : rows,
    });
  }

  if (options.json) {
    out.json({
      command: 'review.export',
      dialect,
      format,
      pending_only: pendingOnly,
      template,
      limit,
      entities: exportsJson,
    });
  }
}

interface ReviewListOptions {
  schema?: string;
  dialect?: SupportedDialect;
  runner?: string;
  all?: boolean;
  limit?: number;
  thresholdBand?: (typeof AGENT_THRESHOLD_BANDS)[number];
  json?: boolean;
}

async function listHandler(
  entityNames: string[],
  options: ReviewListOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const { targets, dialect } = resolveReviewTargets(entityNames, options, globalOptions);
  const runner = options.runner ? await loadRunnerModule(options.runner) : undefined;
  const pendingOnly = !options.all;
  const limit = options.limit;
  const thresholdBands = options.thresholdBand ? [options.thresholdBand] : undefined;
  const entities: Array<{
    entity: string;
    schema: string;
    row_count?: number;
    query?: string;
    rows?: ReviewExportRow[];
  }> = [];

  for (const target of targets) {
    const query = generateExportQuery(target.entity, target.schema, target.midpoint, dialect, {
      pendingOnly,
      includeDecisionColumns: !pendingOnly,
      thresholdBands,
      limit,
      confidenceThresholds: buildReviewConfidenceThresholds(target),
    });

    if (runner?.query == null) {
      entities.push({ entity: target.entity, schema: target.schema, query });
      continue;
    }

    const rawRows = await runner.query(query);
    const parsedRows = ReviewExportRowsSchema.safeParse(rawRows);
    if (!parsedRows.success) {
      throw new CommandError(
        `Runner query for ${target.entity} returned invalid review rows: ${parsedRows.error.issues[0]?.message ?? 'schema validation failed'}`,
        1
      );
    }

    entities.push({
      entity: target.entity,
      schema: target.schema,
      row_count: parsedRows.data.length,
      rows: parsedRows.data,
    });
  }

  const listResult = {
    command: 'review.list',
    dialect,
    pending_only: pendingOnly,
    limit,
    threshold_bands: thresholdBands,
    entities,
  };
  if (options.json) {
    out.json(listResult);
    return;
  }
  if (runner?.query != null) {
    out.yaml(listResult);
    return;
  }

  for (const entity of entities) {
    if (entity.query) {
      out.text(`${entity.query}\n`);
    }
  }
}

interface ReviewShowOptions {
  entity: string;
  pairId: string;
  schema?: string;
  dialect?: SupportedDialect;
  runner?: string;
  json?: boolean;
}

async function showHandler(
  options: ReviewShowOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const { targets, dialect } = resolveReviewTargets([options.entity], options, globalOptions);
  const target = targets[0];
  if (!target) {
    throw new CommandError(`No resolution specs found matching: ${options.entity}`, 2);
  }

  const query = buildReviewPairQuery(
    target.entity,
    target.schema,
    options.pairId,
    dialect,
    buildReviewConfidenceThresholds(target)
  );
  const runner = options.runner ? await loadRunnerModule(options.runner) : undefined;

  if (runner?.query == null) {
    if (options.json) {
      out.json({
        command: 'review.show',
        entity: target.entity,
        pair_id: options.pairId,
        dialect,
        schema: target.schema,
        executed: false,
        query,
      });
      return;
    }
    out.text(`${query}\n`);
    return;
  }

  const rawRows = await runner.query(query);
  const parsedRows = ReviewExportRowsSchema.safeParse(rawRows);
  if (!parsedRows.success) {
    throw new CommandError(
      `Runner query for ${target.entity} returned invalid review rows: ${parsedRows.error.issues[0]?.message ?? 'schema validation failed'}`,
      1
    );
  }

  const showResult = {
    command: 'review.show',
    entity: target.entity,
    pair_id: options.pairId,
    dialect,
    schema: target.schema,
    executed: true,
    row: parsedRows.data[0] ?? null,
  };
  if (options.json) {
    out.json(showResult);
  } else {
    out.yaml(showResult);
  }
}

interface ReviewDecideOptions {
  entity: string;
  pairId: string;
  decision: 'merge' | 'not_match' | 'defer';
  reviewer?: string;
  reason?: string;
  batchId?: string;
  decisionSource?: string;
  schema?: string;
  dialect?: SupportedDialect;
  runner?: string;
  json?: boolean;
}

interface ReviewUnmergeOptions {
  entity: string;
  clusterId: string;
  keep: string;
  reason: string;
  schema?: string;
  dialect?: SupportedDialect;
  runner?: string;
  dryRun?: boolean;
  json?: boolean;
}

async function decideHandler(
  options: ReviewDecideOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const decisionBatchId =
    options.batchId ??
    buildDecisionBatchId(
      JSON.stringify({
        entity: options.entity,
        pairId: options.pairId,
        decision: options.decision,
        reviewer: options.reviewer,
        reason: options.reason,
      })
    );

  const { targets, dialect, quiet } = resolveReviewTargets(
    [options.entity],
    options,
    globalOptions
  );
  const target = targets[0];
  if (!target) {
    throw new CommandError(`No resolution specs found matching: ${options.entity}`, 2);
  }

  const decisionRow = {
    pair_id: options.pairId,
    decision: options.decision,
    reviewer: options.reviewer ?? 'human',
    reason: options.reason,
    decision_batch_id: decisionBatchId,
    decision_source: options.decisionSource ?? 'human',
  } as const;
  const contentHash = buildContentHash(decisionRow);
  const decisionSource = options.decisionSource ?? 'human';

  const statements = [
    ...generateMaterializeDdl(target.entity, dialect, target.schema),

    ...generateAuditLogDdl(dialect),
    generateReviewApplyAuditSql({
      entityName: target.entity,
      targetSchema: target.schema,
      dialect,
      decisionBatchId,
      contentHash,
      decisionCount: 1,
      mergeCount: options.decision === 'merge' ? 1 : 0,
      notMatchCount: options.decision === 'not_match' ? 1 : 0,
      deferredCount: options.decision === 'defer' ? 1 : 0,
      // Always 0 — Commander.choices() restricts options.decision to the
      // live three-value union, so 'escalate' is unreachable here.
      escalatedCount: 0,
      decisionSource,
    }),
    ...generateApplySql([decisionRow], target.entity, dialect, target.schema, {
      defaultBatchId: decisionBatchId,
      defaultContentHash: contentHash,
      defaultDecisionSource: decisionSource,
    }),
  ];

  let executionResults: ModelExecutionResult[] = [];
  if (options.runner) {
    const { run } = await loadRunnerModule(options.runner);
    executionResults = await executeSqlStatements(
      statements.map((statement) => ({
        modelName: `${target.entity}:${statement.name}`,
        sql: statement.sql,
        ignoreErrorPatterns: statement.ignoreErrorPatterns,
      })),
      run,
      {
        onInfo: quiet || Boolean(options.json) ? undefined : (msg) => out.info(msg),
        onError: (msg) => out.error(msg),
        onSuccess: quiet || Boolean(options.json) ? undefined : (msg) => out.success(msg),
      }
    );

    const failed = executionResults.filter((row) => row.status === 'failed');
    if (failed.length > 0) {
      if (options.json) {
        out.json({
          command: 'review.decide',
          entity: target.entity,
          pair_id: options.pairId,
          dialect,
          schema: target.schema,
          executed: true,
          decision_batch_id: decisionBatchId,
          content_hash: contentHash,
          decision_source: decisionSource,
          overall_status: 'failed',
          statements: statements.map((statement, index) => ({
            name: statement.name,
            sql: statement.sql,
            status: executionResults[index]?.status,
            error: executionResults[index]?.error,
            rows_affected: executionResults[index]?.rowsAffected,
          })),
        });
      }
      throw new CommandError(
        `Failed to record ${options.decision} for ${options.pairId} [batch=${decisionBatchId}].`,
        1
      );
    }
  }

  if (options.json) {
    out.json({
      command: 'review.decide',
      entity: target.entity,
      pair_id: options.pairId,
      dialect,
      schema: target.schema,
      executed: Boolean(options.runner),
      decision_batch_id: decisionBatchId,
      content_hash: contentHash,
      decision_source: decisionSource,
      statements: options.runner
        ? statements.map((statement, index) => ({
            name: statement.name,
            sql: statement.sql,
            status: executionResults[index]?.status,
            error: executionResults[index]?.error,
            rows_affected: executionResults[index]?.rowsAffected,
          }))
        : statements,
    });
    return;
  }

  if (!options.runner) {
    for (const statement of statements) {
      out.text(`-- ${statement.name}\n${statement.sql};\n\n`);
    }
    return;
  }

  out.success(`Recorded ${options.decision} for ${options.pairId} [batch=${decisionBatchId}]`);
}

function parseKeepRecordIds(value: string): string[] {
  const ids = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [...new Set(ids)].sort();
}

async function unmergeHandler(
  options: ReviewUnmergeOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  let keepRecordIds = parseKeepRecordIds(options.keep);
  if (keepRecordIds.length === 0) {
    throw new CommandError('--keep must include at least one record id.', 2);
  }

  const { specs, dialect, targetSchema, entityGraphDir, quiet } = buildResolveContext(
    globalOptions,
    options,
    [options.entity]
  );
  const spec = specs[0];
  if (!spec) {
    throw new CommandError(`No resolution specs found matching: ${options.entity}`, 2);
  }

  const schema = spec.targetSchema ?? targetSchema;
  const clusterResult = compileResolutionCluster(spec, dialect, schema);
  const profileResult = compileResolutionProfile(spec, dialect, schema);
  const runner =
    options.runner && !options.dryRun ? await loadRunnerModule(options.runner) : undefined;
  if (runner == null && !quiet && !options.json) {
    out.warn(
      options.dryRun
        ? '--keep validation skipped in dry-run mode; provide --runner without --dry-run to validate record IDs before executing.'
        : '--keep validation skipped because no --runner query interface was provided; add --runner to validate record IDs before executing generated SQL.'
    );
  }
  if (runner != null) {
    if (runner.query == null) {
      throw new CommandError(
        'review unmerge with --runner requires a runner module that exports query(sql) to validate --keep before executing.',
        2
      );
    }
    const keepValidation = await validateKeepRecordIdsForCluster(
      runner.query,
      spec.entity,
      schema,
      options.clusterId,
      keepRecordIds,
      dialect
    );
    keepRecordIds = keepValidation.keepRecordIds;
    if (keepRecordIds.length === 0) {
      throw new CommandError(
        `--keep must include at least one record id from the target cluster (${options.clusterId}).`,
        2
      );
    }
    if (keepValidation.missingRecordIds.length > 0) {
      throw new CommandError(
        `--keep contains record ids not found in cluster ${options.clusterId}: ${keepValidation.missingRecordIds.join(', ')}`,
        2
      );
    }
    if (keepValidation.keepsEntireCluster) {
      throw new CommandError(
        `--keep includes every record in cluster ${options.clusterId}; unmerge would not move any records.`,
        2
      );
    }
  }

  const contentHash = buildContentHash({
    entity: spec.entity,
    cluster_id: options.clusterId,
    keep_record_ids: keepRecordIds,
    reason: options.reason,
  });
  const decisionBatchId = `unmerge-${contentHash.slice(0, 16)}`;
  const survivorshipSpec = discoverColocatedSurvivorshipSpec(spec, schema, entityGraphDir);
  const survivorshipStatements = survivorshipSpec
    ? [
        ...compileSurvivorship(survivorshipSpec, dialect).statements,
        generateSurvivorshipAuditSql(survivorshipSpec, dialect),
      ]
    : [];
  const statements = [
    ...generateMaterializeDdl(spec.entity, dialect, schema),

    ...generateAuditLogDdl(dialect),
    ...generateUnmergeSql({
      entityName: spec.entity,
      targetSchema: schema,
      dialect,
      clusterId: options.clusterId,
      keepRecordIds,
      reason: options.reason,
      decisionBatchId,
      contentHash,
    }),
    ...clusterResult.statements,
    ...profileResult.statements,
    ...survivorshipStatements,
  ];
  let executionResults: ModelExecutionResult[] = [];

  if (runner) {
    executionResults = await executeSqlStatements(
      statements.map((statement) => ({
        modelName: `${spec.entity}:${statement.name}`,
        sql: statement.sql,
        ignoreErrorPatterns: statement.ignoreErrorPatterns,
      })),
      runner.run,
      {
        onInfo: quiet || Boolean(options.json) ? undefined : (msg) => out.info(msg),
        onError: (msg) => out.error(msg),
        onSuccess: quiet || Boolean(options.json) ? undefined : (msg) => out.success(msg),
      }
    );
  } else if (!options.json && !quiet) {
    for (const statement of statements) {
      out.text(`-- ${statement.name}\n${statement.sql};\n\n`);
    }
  }

  const failed = executionResults.filter((row) => row.status === 'failed');
  if (options.json) {
    out.json({
      command: 'review.unmerge',
      entity: spec.entity,
      cluster_id: options.clusterId,
      keep_record_ids: keepRecordIds,
      reason: options.reason,
      dialect,
      schema,
      executed: Boolean(options.runner) && !options.dryRun,
      dry_run: Boolean(options.dryRun) || !options.runner,
      decision_batch_id: decisionBatchId,
      content_hash: contentHash,
      statements: statements.map((statement, index) => ({
        name: statement.name,
        sql: statement.sql,
        status: executionResults[index]?.status,
        error: executionResults[index]?.error,
        rows_affected: executionResults[index]?.rowsAffected,
      })),
    });
  }

  if (failed.length > 0) {
    throw new CommandError(`${failed.length} unmerge statement(s) failed.`, 1);
  }

  if (!options.json && !quiet && options.runner && !options.dryRun) {
    out.success(
      `Unmerged cluster ${options.clusterId}; kept ${keepRecordIds.length} record(s) [batch=${decisionBatchId}]`
    );
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

/** Register the review export/apply command group with Commander. */
export function registerReviewCommand(program: Command): void {
  const review = program
    .command('review')
    .description('Review export/import for entity resolution');

  review
    .command('export')
    .description('Export review queue for human review')
    .argument('<entity...>', 'Entity names to export review queue for')
    .option('--format <format>', 'Output format: csv, json, or yaml', 'csv')
    .option('--output <path>', 'Write to file instead of stdout')
    .option('--template', 'Include editable decision columns in CSV/JSON output')
    .option('--all', 'Include already-decided pairs instead of only pending pairs')
    .addOption(
      new Option('--limit <n>', 'Maximum number of rows to return').argParser(
        parsePositiveIntOption
      )
    )
    .option('--json', 'Output results as JSON to stdout')
    .option('--runner <path>', 'Path to SQL runner module with optional query() export')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(async (entityNames: string[], opts: ExportOptions) => {
      const globalOptions = program.opts<ReviewGlobalFlags>();
      await exportHandler(entityNames, opts, globalOptions);
    });

  review
    .command('apply')
    .description('Import review decisions from CSV/JSON/YAML or entity_graph_decision_bundle.v1')
    .requiredOption('--input <path>', 'Path to decisions file, or "-" to read stdin')
    .requiredOption('--entity <name>', 'Entity name for the resolution')
    .option('--batch-id <value>', 'Stable decision batch identifier')
    .option(
      '--decision-source <value>',
      'Decision source label (defaults to the bundle value, otherwise human)'
    )
    .option('--policy-file <path>', 'Explicit path to a policy YAML file')
    .option('--spec-dir <path>', 'Directory to discover *.policy.yml files')
    .option(
      '--materialize <mode>',
      'Materialize applied merge decisions into __crosswalks/__golden immediately: none | incremental',
      'none'
    )
    .option('--json', 'Output results as JSON to stdout')
    .option('--yaml', 'Output results as YAML to stdout')
    .option('--runner <path>', 'Path to SQL runner module')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(async (opts: ApplyOptions) => {
      const globalOptions = program.opts<ReviewGlobalFlags>();
      await applyHandler(opts, globalOptions);
    });

  review
    .command('list')
    .description('List pending or historical review pairs')
    .argument('<entity...>', 'Entity names to inspect')
    .option('--all', 'Include already-decided pairs instead of only pending pairs')
    .addOption(
      new Option('--limit <n>', 'Maximum number of rows to return').argParser(
        parsePositiveIntOption
      )
    )
    .addOption(
      new Option('--threshold-band <value>', 'Filter to one threshold band').choices([
        ...AGENT_THRESHOLD_BANDS,
      ])
    )
    .option('--json', 'Output results as JSON to stdout')
    .option('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(async (entityNames: string[], opts: ReviewListOptions) => {
      const globalOptions = program.opts<ReviewGlobalFlags>();
      await listHandler(entityNames, opts, globalOptions);
    });

  review
    .command('show')
    .description('Inspect a single review pair')
    .requiredOption('--entity <name>', 'Entity name for the resolution')
    .requiredOption('--pair-id <value>', 'Pair ID to inspect')
    .option('--json', 'Output results as JSON to stdout')
    .option('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(async (opts: ReviewShowOptions) => {
      const globalOptions = program.opts<ReviewGlobalFlags>();
      await showHandler(opts, globalOptions);
    });

  review
    .command('decide')
    .description('Record a single review decision')
    .requiredOption('--entity <name>', 'Entity name for the resolution')
    .requiredOption('--pair-id <value>', 'Pair ID to decide')
    .addOption(
      new Option('--decision <value>', 'Decision: merge, not_match, or defer')
        .choices(['merge', 'not_match', 'defer'])
        .makeOptionMandatory()
    )
    .option('--reviewer <value>', 'Reviewer or agent name', 'human')
    .option('--reason <value>', 'Optional reason')
    .option('--batch-id <value>', 'Stable decision batch identifier')
    .option('--decision-source <value>', 'Decision source label', 'human')
    .option('--json', 'Output results as JSON to stdout')
    .option('--runner <path>', 'Path to SQL runner module')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(async (opts: ReviewDecideOptions) => {
      const globalOptions = program.opts<ReviewGlobalFlags>();
      await decideHandler(opts, globalOptions);
    });

  review
    .command('unmerge')
    .description('Split records out of an existing cluster')
    .requiredOption('--entity <name>', 'Entity name for the resolution')
    .requiredOption('--cluster-id <value>', 'Cluster ID to split')
    .requiredOption('--keep <record_ids>', 'Comma-separated record IDs to keep together')
    .requiredOption('--reason <text>', 'Reason for the unmerge')
    .option('--dry-run', 'Show SQL without executing')
    .option('--json', 'Output results as JSON to stdout')
    .option('--runner <path>', 'Path to SQL runner module')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(async (opts: ReviewUnmergeOptions) => {
      const globalOptions = program.opts<ReviewGlobalFlags>();
      await unmergeHandler(opts, globalOptions);
    });

  registerFeedbackSubcommand(review, program, resolveReviewTargets);
}
