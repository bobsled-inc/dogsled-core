/**
 * `bobsled entity-graph resolve report` handler.
 *
 * Extracted from resolve.ts to keep that module under the source-file budget.
 */

import type { Command } from 'commander';
import { CommandError } from '@bobsled-inc/protocol';
import type { ResolvedResolutionSpec } from '../compiler/identity/types.js';
import type { SupportedDialect } from '@bobsled-inc/model-spec';
import { buildFqName, quoteIdentifier, quoteLiteral } from '@bobsled-inc/model-spec';
import {
  resolveCleanViewName,
  resolveEffectiveViewsConfig,
} from '../compiler/identity/codegen-views.js';
import { out } from '@bobsled-inc/model-spec/shared';
import { createDialectOption, loadRunnerModule } from '@bobsled-inc/model-spec/shared';
import { ENTITY_GRAPH_SCHEMA } from '../compiler/audit/codegen.js';
import { outputTableName } from '../compiler/output-tables/index.js';

export interface ResolveReportScoringFeature {
  field: string;
  algorithm: string;
  weight: number;
}

export interface ResolveReportScoringComparison {
  field: string;
  level_count: number;
}

export interface ResolveReportJsonEntity {
  entity: string;
  inputs: Array<{ ref: string; alias: string }>;
  blocking_rules: string[];
  deterministic_rules: string[];
  scoring_features: ResolveReportScoringFeature[] | undefined;
  scoring_method?: 'weighted_features' | 'fellegi_sunter';
  scoring_comparisons?: ResolveReportScoringComparison[];
  thresholds: {
    auto_merge: number | null;
    review: number;
    auto_reject: number;
  };
  entity_id_policy: {
    strategy: string;
    new_id: string;
    merge: string;
    split: string;
  };
  clean_views?: Array<{
    input_ref: string;
    view_name: string;
    include_entity_graph_metadata: boolean;
    column_count: number | null;
  }>;
}

export interface ReportOptions {
  dialect?: string;
  schema?: string;
  json?: boolean;
}

interface OverviewReportOptions {
  dialect?: string;
  schema?: string;
  runner?: string;
  json?: boolean;
  entity: string;
  format?: OverviewFormat;
}

interface OverviewResolveContext {
  specs: ResolvedResolutionSpec[];
  dialect: SupportedDialect;
  targetSchema: string;
}

type BuildOverviewContext = (
  globalOptions: { verbose?: boolean; quiet?: boolean },
  localOptions: { dialect?: string; schema?: string },
  entityNames: string[]
) => OverviewResolveContext;

export type OverviewFormat = 'table' | 'json' | 'markdown';

function entityTypePredicate(entity: string, dialect: SupportedDialect): string {
  const entityType = quoteIdentifier('entity_type', dialect);
  return `(${entityType} = ${quoteLiteral(entity, dialect)} OR ${entityType} LIKE ${quoteLiteral(`%.${entity}`, dialect)})`;
}

export function buildResolveOverviewQuery(
  entity: string,
  targetSchema: string,
  dialect: SupportedDialect,
  contractSchema = ENTITY_GRAPH_SCHEMA
): string {
  const entityPredicate = entityTypePredicate(entity, dialect);
  const clusters = buildFqName(contractSchema, 'clusters', dialect);
  const crosswalks = buildFqName(contractSchema, 'crosswalks', dialect);
  const quality = buildFqName(contractSchema, 'entity_quality_current', dialect);
  const reviewQueue = buildFqName(targetSchema, outputTableName(entity, '__review_queue'), dialect);
  const decisions = buildFqName(
    targetSchema,
    outputTableName(entity, '__review_decisions'),
    dialect
  );
  const clusterId = quoteIdentifier('cluster_id', dialect);
  const recordId = quoteIdentifier('record_id', dialect);
  const pairId = quoteIdentifier('pair_id', dialect);

  return [
    `WITH cluster_sizes AS (`,
    `  SELECT ${clusterId}, COUNT(DISTINCT ${recordId}) AS ${quoteIdentifier('record_count', dialect)}`,
    `  FROM ${clusters}`,
    `  WHERE ${entityPredicate}`,
    `  GROUP BY ${clusterId}`,
    `), latest_decisions AS (`,
    `  SELECT ${pairId}`,
    `  FROM (`,
    `    SELECT`,
    `      ${pairId},`,
    `      ROW_NUMBER() OVER (PARTITION BY ${pairId} ORDER BY ${quoteIdentifier('decided_at', dialect)} DESC, ${quoteIdentifier('applied_at', dialect)} DESC) AS rn`,
    `    FROM ${decisions}`,
    `  ) ranked`,
    `  WHERE rn = 1`,
    `)`,
    `SELECT ${quoteLiteral('clusters', dialect)} AS ${quoteIdentifier('section', dialect)}, ${quoteLiteral('cluster_count', dialect)} AS ${quoteIdentifier('metric', dialect)}, NULL AS ${quoteIdentifier('dimension', dialect)}, COUNT(*) AS ${quoteIdentifier('value', dialect)} FROM cluster_sizes`,
    `UNION ALL`,
    `SELECT ${quoteLiteral('clusters', dialect)}, ${quoteLiteral('average_size', dialect)}, NULL, AVG(${quoteIdentifier('record_count', dialect)}) FROM cluster_sizes`,
    `UNION ALL`,
    `SELECT ${quoteLiteral('source_coverage', dialect)}, ${quoteLiteral('records_by_source', dialect)}, ${quoteIdentifier('source_system', dialect)}, COUNT(*) FROM ${crosswalks} WHERE ${entityPredicate} GROUP BY ${quoteIdentifier('source_system', dialect)}`,
    `UNION ALL`,
    `SELECT ${quoteLiteral('trust_tier', dialect)}, ${quoteLiteral('cluster_count', dialect)}, ${quoteIdentifier('trust_tier', dialect)}, COUNT(*) FROM ${quality} WHERE ${entityPredicate} GROUP BY ${quoteIdentifier('trust_tier', dialect)}`,
    `UNION ALL`,
    `SELECT ${quoteLiteral('review', dialect)}, ${quoteLiteral('backlog', dialect)}, ${quoteIdentifier('threshold_band', dialect)}, COUNT(*) FROM ${reviewQueue} rq LEFT JOIN latest_decisions ld ON rq.${pairId} = ld.${pairId} WHERE ld.${pairId} IS NULL GROUP BY ${quoteIdentifier('threshold_band', dialect)}`,
  ].join('\n');
}

export function emitOverviewRows(rows: unknown[], format: OverviewFormat): void {
  if (format === 'json') {
    out.json({ command: 'resolve.report.overview', rows });
    return;
  }
  if (format === 'markdown') {
    out.text('| Section | Metric | Dimension | Value |');
    out.text('| --- | --- | --- | --- |');
    for (const row of rows as Array<Record<string, unknown>>) {
      out.text(
        `| ${String(row.section ?? '')} | ${String(row.metric ?? '')} | ${String(row.dimension ?? '')} | ${String(row.value ?? '')} |`
      );
    }
    return;
  }
  out.yaml({ rows });
}

async function overviewReportHandler(
  options: OverviewReportOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean },
  buildContext: BuildOverviewContext
): Promise<void> {
  const { specs, dialect, targetSchema } = buildContext(globalOptions, options, [options.entity]);
  const spec = specs[0];
  if (!spec) {
    throw new CommandError(`No resolution specs found matching: ${options.entity}`, 2);
  }
  const schema = spec.targetSchema ?? targetSchema;
  const query = buildResolveOverviewQuery(spec.entity, schema, dialect);
  const runner = options.runner ? await loadRunnerModule(options.runner) : undefined;
  if (options.runner && runner?.query == null) {
    throw new CommandError('Runner module does not implement query(sql).', 2);
  }
  const format = options.format ?? (options.json ? 'json' : 'table');

  if (runner?.query == null) {
    if (format === 'json') {
      out.json({
        command: 'resolve.report.overview',
        entity: spec.entity,
        dialect,
        schema,
        executed: false,
        query,
      });
      return;
    }
    out.text(`${query}\n`);
    return;
  }

  const rows = await runner.query(query);
  emitOverviewRows(rows, format);
}

export function registerOverviewReportCommand(
  report: Command,
  program: Command,
  buildContext: BuildOverviewContext
): void {
  report
    .command('overview')
    .description('Warehouse-truth overview metrics for one entity')
    .requiredOption('--entity <name>', 'Entity name to report on')
    .option('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--format <format>', 'Output format: table, json, or markdown', 'table')
    .option('--json', 'Output as JSON')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(async (opts: OverviewReportOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await overviewReportHandler(opts, globalOptions, buildContext);
    });
}

export function buildResolveReport(spec: ResolvedResolutionSpec): ResolveReportJsonEntity {
  const viewConfig = resolveEffectiveViewsConfig(spec);
  const cleanViews = viewConfig
    ? spec.inputs
        .filter((input) => (input.idFields?.length ?? 0) > 0)
        .map((input) => ({
          input_ref: input.ref,
          view_name: resolveCleanViewName(input.ref, spec.entity, viewConfig.namePattern),
          include_entity_graph_metadata: viewConfig.includeEntityGraphMetadata,
          column_count: input.sourceColumns?.length ?? null,
        }))
    : undefined;

  return {
    entity: spec.entity,
    inputs: spec.inputs.map((i) => ({ ref: i.ref, alias: i.alias })),
    blocking_rules: spec.blocking?.rules.map((r) => r.name) ?? [],
    deterministic_rules: spec.deterministicRules.map((r) => r.name),
    scoring_features:
      spec.scoring?.method === 'weighted_features'
        ? spec.scoring.features.map((f) => ({
            field: f.field,
            algorithm: f.algorithm,
            weight: f.weight,
          }))
        : undefined,
    scoring_method: spec.scoring?.method,
    scoring_comparisons:
      spec.scoring?.method === 'fellegi_sunter'
        ? spec.scoring.comparisons.map((c) => ({ field: c.field, level_count: c.levels.length }))
        : undefined,
    thresholds: {
      auto_merge: spec.thresholds.autoMerge,
      review: spec.thresholds.review,
      auto_reject: spec.thresholds.autoReject,
    },
    entity_id_policy: {
      strategy: spec.entityIdPolicy.strategy,
      new_id: spec.entityIdPolicy.newId,
      merge: spec.entityIdPolicy.merge,
      split: spec.entityIdPolicy.split,
    },
    ...(cleanViews !== undefined ? { clean_views: cleanViews } : {}),
  };
}

export function printResolveReport(spec: ResolvedResolutionSpec): void {
  const viewConfig = resolveEffectiveViewsConfig(spec);
  const hasProfile = spec.profile != null;
  const cleanViews = viewConfig
    ? spec.inputs
        .filter((input) => (input.idFields?.length ?? 0) > 0)
        .map((input) => ({
          view_name: resolveCleanViewName(input.ref, spec.entity, viewConfig.namePattern),
        }))
    : undefined;

  out.info(`Entity: ${spec.entity}`);
  out.info(`  Inputs: ${spec.inputs.length}`);
  out.info(`  Blocking rules: ${spec.blocking?.rules.length ?? 0}`);
  out.info(`  Deterministic rules: ${spec.deterministicRules.length}`);
  if (spec.scoring?.method === 'weighted_features') {
    out.info(`  Scoring features: ${spec.scoring.features.length}`);
  } else if (spec.scoring?.method === 'fellegi_sunter') {
    out.info(`  Scoring comparisons: ${spec.scoring.comparisons.length}`);
  }
  out.info(
    `  Thresholds: merge=${spec.thresholds.autoMerge ?? 'disabled (deterministic rules only)'} review=${spec.thresholds.review} reject=${spec.thresholds.autoReject}`
  );
  out.info(
    `  Entity IDs: ${spec.entityIdPolicy.strategy} (new=${spec.entityIdPolicy.newId}, merge=${spec.entityIdPolicy.merge}, split=${spec.entityIdPolicy.split})`
  );
  if (!hasProfile) {
    out.info(`  Clean views: (none - profile not configured)`);
  } else if (!viewConfig) {
    out.info(`  Clean views: (none - views disabled)`);
  } else if (cleanViews === undefined || cleanViews.length === 0) {
    out.info(`  Clean views: (none - no id_fields configured)`);
  } else {
    out.info(`  Clean views: ${cleanViews.map((view) => view.view_name).join(', ')}`);
  }
}

export function emitResolveReport(specs: ResolvedResolutionSpec[], options: ReportOptions): void {
  const reports: ResolveReportJsonEntity[] = [];

  for (const spec of specs) {
    if (options.json) {
      reports.push(buildResolveReport(spec));
    } else {
      printResolveReport(spec);
    }
  }

  if (options.json) {
    out.json({
      command: 'resolve.report',
      entities: reports,
    });
  }
}
