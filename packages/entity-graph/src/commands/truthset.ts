import * as fs from 'node:fs';
import { CommandError } from '@bobsled-inc/protocol';

import type { Command } from 'commander';
import { z } from 'zod';

import {
  buildFqName,
  quoteIdentifier,
  quoteLiteral,
  type SupportedDialect,
} from '@bobsled-inc/model-spec';
import { discoverResolutionSpecs } from '../compiler/identity/parser.js';
import { isMissingTableError } from './resolve-support.js';
import {
  discoverTruthsetSpecs,
  loadTruthsetLabels,
  resolveTruthsetSpec,
} from '../compiler/truthset/parser.js';
import { loadProjectConfig, resolveConfig } from '@bobsled-inc/model-spec/shared';
import { out } from '@bobsled-inc/model-spec/shared';

import type { TruthsetLabel, ResolvedTruthsetSpec } from '../compiler/truthset/parser.js';

import {
  createDialectOption,
  loadRunnerModule,
  parseGlobalFlags,
  resolvePathWithinDir,
  validateScaffoldName,
} from '@bobsled-inc/model-spec/shared';
import { registerTruthsetTrainCommand } from './truthset-train.js';

export interface TruthsetContext {
  specs: ResolvedTruthsetSpec[];
  dialect: SupportedDialect;
  entityGraphDir: string;
  schema: string;
}

const TruthsetScoreRowsSchema = z.array(
  z.object({
    pair_id: z.string(),
    composite_score: z.coerce.number(),
  })
);

const TruthsetSemanticScoreRowsSchema = z.array(
  z.object({
    pair_id: z.string(),
    semantic_score: z.coerce.number(),
  })
);

function initHandler(entity: string, globalOptions: { verbose?: boolean; quiet?: boolean }): void {
  const safeEntity = validateScaffoldName(entity, 'Entity name');
  const cwd = process.cwd();
  const { config } = loadProjectConfig(cwd);
  const resolved = resolveConfig({}, config);
  const entityGraphDir = resolvePathWithinDir(
    cwd,
    resolved.entityGraphDir,
    'Entity Graph directory'
  );
  const dataDir = resolvePathWithinDir(entityGraphDir, 'data', 'Truthset data directory');
  const specPath = resolvePathWithinDir(
    entityGraphDir,
    `${safeEntity}_truthset.yml`,
    'Truthset path'
  );
  const csvPath = resolvePathWithinDir(dataDir, `${safeEntity}_truthset.csv`, 'Truthset CSV path');
  fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(specPath) || fs.existsSync(csvPath)) {
    throw new CommandError(`Truthset scaffold already exists for ${safeEntity}.`, 2);
  }

  fs.writeFileSync(
    specPath,
    [
      `spec_version: '0.2'`,
      `name: ${safeEntity}_truthset`,
      `type: truthset`,
      `description: Regression labels for ${safeEntity} matching.`,
      `resolution_ref: ${safeEntity}_resolution`,
      ``,
      `labels:`,
      `  format: csv`,
      `  path: data/${safeEntity}_truthset.csv`,
      ``,
      `targets:`,
      `  min_auto_merge_precision: 0.98`,
      ``,
    ].join('\n'),
    'utf-8'
  );
  fs.writeFileSync(csvPath, 'pair_id,label\n', 'utf-8');

  if (!globalOptions.quiet) {
    out.success(`Created truthset scaffold ${specPath}`);
    out.info(csvPath);
  }
}

export function buildTruthsetContext(
  globalOptions: { verbose?: boolean; quiet?: boolean },
  localOptions: { dialect?: string; schema?: string },
  names: string[]
): TruthsetContext {
  parseGlobalFlags(globalOptions);
  const cwd = process.cwd();
  const { config } = loadProjectConfig(cwd);

  const resolved = resolveConfig(
    {
      dialect: localOptions.dialect as SupportedDialect | undefined,
      schema: localOptions.schema,
    },
    config
  );
  const entityGraphDir = resolvePathWithinDir(
    cwd,
    resolved.entityGraphDir,
    'Entity Graph directory'
  );
  if (!fs.existsSync(entityGraphDir)) {
    throw new CommandError(`No ${resolved.entityGraphDir}/ directory found.`, 2);
  }

  let specs = discoverTruthsetSpecs(entityGraphDir).map((spec) =>
    resolveTruthsetSpec(spec, entityGraphDir)
  );
  if (names.length > 0) {
    specs = specs.filter(
      (spec) =>
        names.includes(spec.name) ||
        names.includes(spec.entity) ||
        names.includes(spec.resolutionEntity)
    );
  }
  if (specs.length === 0) {
    throw new CommandError('No truthset specs found matching the requested names.', 2);
  }

  return {
    specs,
    dialect: resolved.dialect,
    entityGraphDir,
    schema: resolved.schema,
  };
}

export function buildPairScoreQuery(
  spec: ResolvedTruthsetSpec,
  pairIds: string[],
  schema: string,
  dialect: SupportedDialect
): string {
  const scoresTable = buildFqName(schema, `${spec.resolutionEntity}__pair_scores`, dialect);
  const pairId = quoteIdentifier('pair_id', dialect);
  const compositeScore = quoteIdentifier('composite_score', dialect);
  const values = pairIds.map((value) => quoteLiteral(value, dialect)).join(', ');
  return [
    `SELECT ${pairId}, ${compositeScore}`,
    `FROM ${scoresTable}`,
    `WHERE ${pairId} IN (${values})`,
  ].join('\n');
}

export function buildSemanticPairScoreQuery(
  spec: ResolvedTruthsetSpec,
  pairIds: string[],
  schema: string,
  dialect: SupportedDialect
): string {
  const semanticTable = buildFqName(
    schema,
    `${spec.resolutionEntity}__pair_semantic_scores`,
    dialect
  );
  const pairId = quoteIdentifier('pair_id', dialect);
  const semanticScore = quoteIdentifier('semantic_score', dialect);
  const values = pairIds.map((value) => quoteLiteral(value, dialect)).join(', ');
  return [
    `SELECT ${pairId}, AVG(${semanticScore}) AS ${semanticScore}`,
    `FROM ${semanticTable}`,
    `WHERE ${pairId} IN (${values})`,
    `GROUP BY ${pairId}`,
  ].join('\n');
}

export function resolveThresholds(
  truthset: ResolvedTruthsetSpec,
  entityGraphDir: string
): { auto_merge: number; review: number; auto_reject: number } {
  const resolution = discoverResolutionSpecs(entityGraphDir).find(
    (spec) => spec.raw.name === truthset.resolutionRef
  );
  if (!resolution) {
    throw new CommandError(`Unable to resolve thresholds for ${truthset.name}.`, 2);
  }
  const thresholds = resolution.raw.thresholds;
  if (thresholds.auto_merge === null) {
    // Threshold tuning/evaluation optimizes the score-driven auto-merge
    // cutoff, which auto_merge: null deliberately disables.
    throw new CommandError(
      `Truthset ${truthset.name}: auto_merge is null (deterministic-only merging) — threshold evaluation and tuning require a numeric auto_merge.`,
      2
    );
  }
  return { ...thresholds, auto_merge: thresholds.auto_merge };
}

function resolveSemanticTriageThresholds(
  truthset: ResolvedTruthsetSpec,
  entityGraphDir: string
): { promote_to_merge_threshold: number; promote_to_reject_threshold: number } | undefined {
  const resolution = discoverResolutionSpecs(entityGraphDir).find(
    (spec) => spec.raw.name === truthset.resolutionRef
  );
  const triage = resolution?.raw.semantic_triage;
  return triage
    ? {
        promote_to_merge_threshold: triage.promote_to_merge_threshold,
        promote_to_reject_threshold: triage.promote_to_reject_threshold,
      }
    : undefined;
}

export function scoreLabels(
  labels: TruthsetLabel[],
  scores: Map<string, number>,
  thresholds: { auto_merge: number; review: number }
): {
  matched_label_count: number;
  missing_pair_count: number;
  auto_merge_precision: number;
  auto_merge_recall: number;
  review_recall: number;
  auto_reject_precision: number;
} {
  let matched = 0;
  let autoMergePredictions = 0;
  let autoMergeTruePositive = 0;
  let mergeLabels = 0;
  let reviewRecallHits = 0;
  let autoRejectPredictions = 0;
  let autoRejectTrueNegative = 0;

  for (const label of labels) {
    const score = scores.get(label.pair_id);
    if (score == null) {
      continue;
    }
    matched += 1;
    const isPositive = label.label === 'merge';
    if (isPositive) {
      mergeLabels += 1;
    }
    if (score >= thresholds.auto_merge) {
      autoMergePredictions += 1;
      if (isPositive) {
        autoMergeTruePositive += 1;
      }
    }
    if (score >= thresholds.review && isPositive) {
      reviewRecallHits += 1;
    }
    if (score < thresholds.review) {
      autoRejectPredictions += 1;
      if (!isPositive) {
        autoRejectTrueNegative += 1;
      }
    }
  }

  return {
    matched_label_count: matched,
    missing_pair_count: labels.length - matched,
    auto_merge_precision:
      autoMergePredictions === 0 ? 0 : autoMergeTruePositive / autoMergePredictions,
    auto_merge_recall: mergeLabels === 0 ? 0 : autoMergeTruePositive / mergeLabels,
    review_recall: mergeLabels === 0 ? 0 : reviewRecallHits / mergeLabels,
    auto_reject_precision:
      autoRejectPredictions === 0 ? 0 : autoRejectTrueNegative / autoRejectPredictions,
  };
}

export function scoreSemanticTriageLabels(
  labels: TruthsetLabel[],
  baseScores: Map<string, number>,
  semanticScores: Map<string, number>,
  thresholds: { auto_merge: number; review: number },
  semanticThresholds: { promote_to_merge_threshold: number; promote_to_reject_threshold: number }
): {
  evaluated_label_count: number;
  promoted_merge_count: number;
  promoted_merge_precision: number;
  promoted_reject_count: number;
  promoted_reject_precision: number;
  kept_for_review_count: number;
} {
  let evaluated = 0;
  let promotedMerge = 0;
  let promotedMergeTruePositive = 0;
  let promotedReject = 0;
  let promotedRejectTrueNegative = 0;
  let kept = 0;

  for (const label of labels) {
    const baseScore = baseScores.get(label.pair_id);
    const semanticScore = semanticScores.get(label.pair_id);
    if (
      baseScore == null ||
      semanticScore == null ||
      baseScore < thresholds.review ||
      baseScore >= thresholds.auto_merge
    ) {
      continue;
    }

    evaluated += 1;
    if (semanticScore >= semanticThresholds.promote_to_merge_threshold) {
      promotedMerge += 1;
      if (label.label === 'merge') {
        promotedMergeTruePositive += 1;
      }
    } else if (semanticScore <= semanticThresholds.promote_to_reject_threshold) {
      promotedReject += 1;
      if (label.label === 'not_match') {
        promotedRejectTrueNegative += 1;
      }
    } else {
      kept += 1;
    }
  }

  return {
    evaluated_label_count: evaluated,
    promoted_merge_count: promotedMerge,
    promoted_merge_precision: promotedMerge === 0 ? 0 : promotedMergeTruePositive / promotedMerge,
    promoted_reject_count: promotedReject,
    promoted_reject_precision:
      promotedReject === 0 ? 0 : promotedRejectTrueNegative / promotedReject,
    kept_for_review_count: kept,
  };
}

export function tuneThresholds(
  labels: TruthsetLabel[],
  scores: Map<string, number>,
  minAutoMergePrecision: number
): { auto_merge: number; review: number; auto_reject: number } {
  const observed = labels
    .map((label) => ({ label: label.label, score: scores.get(label.pair_id) }))
    .filter((row): row is { label: 'merge' | 'not_match'; score: number } => row.score != null)
    .sort((left, right) => right.score - left.score);

  if (observed.length === 0) {
    throw new CommandError('Truthset tuning requires at least one scored pair.', 2);
  }

  const candidateThresholds = [...new Set(observed.map((row) => row.score))].sort((a, b) => b - a);

  const initialReview = candidateThresholds[candidateThresholds.length - 1];
  if (initialReview == null) {
    throw new CommandError('Truthset tuning could not derive candidate thresholds.', 1);
  }

  let bestAutoMerge: number | undefined;
  let bestReview = initialReview;
  let bestF1 = -1;

  for (const threshold of candidateThresholds) {
    let predictedPositive = 0;
    let truePositive = 0;

    for (const row of observed) {
      if (row.score >= threshold) {
        predictedPositive += 1;
        if (row.label === 'merge') {
          truePositive += 1;
        }
      }
    }

    const precision = predictedPositive === 0 ? 0 : truePositive / predictedPositive;
    if (precision >= minAutoMergePrecision) {
      bestAutoMerge = threshold;
    }
  }

  if (bestAutoMerge == null) {
    throw new CommandError(
      `Truthset tuning could not satisfy min_auto_merge_precision=${minAutoMergePrecision}.`,
      2
    );
  }

  for (const threshold of candidateThresholds) {
    let predictedPositive = 0;
    let truePositive = 0;
    let actualPositive = 0;
    for (const row of observed) {
      if (row.label === 'merge') {
        actualPositive += 1;
      }
      if (row.score >= threshold) {
        predictedPositive += 1;
        if (row.label === 'merge') {
          truePositive += 1;
        }
      }
    }

    const precision = predictedPositive === 0 ? 0 : truePositive / predictedPositive;
    const recall = actualPositive === 0 ? 0 : truePositive / actualPositive;
    const score = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    if (score > bestF1) {
      bestF1 = score;
      bestReview = threshold;
    }
  }

  const reviewCandidate =
    bestReview < bestAutoMerge
      ? bestReview
      : candidateThresholds.find((threshold) => threshold < bestAutoMerge);
  if (reviewCandidate == null) {
    throw new CommandError(
      'Truthset tuning could not derive a review threshold below auto_merge.',
      1
    );
  }

  const autoMergeRounded = Number(bestAutoMerge.toFixed(4));
  const reviewRounded = Number(reviewCandidate.toFixed(4));
  if (reviewRounded >= autoMergeRounded) {
    throw new CommandError('Rounding caused review threshold to reach or exceed auto_merge.', 1);
  }

  return {
    auto_merge: autoMergeRounded,
    review: reviewRounded,
    auto_reject: reviewRounded,
  };
}

export function tuneSemanticTriageThresholds(
  labels: TruthsetLabel[],
  baseScores: Map<string, number>,
  semanticScores: Map<string, number>,
  thresholds: { auto_merge: number; review: number },
  minPrecision: number
): { promote_to_merge_threshold: number; promote_to_reject_threshold: number } {
  const observed = labels
    .map((label) => ({
      label: label.label,
      baseScore: baseScores.get(label.pair_id),
      semanticScore: semanticScores.get(label.pair_id),
    }))
    .filter(
      (row): row is { label: 'merge' | 'not_match'; baseScore: number; semanticScore: number } =>
        row.baseScore != null &&
        row.semanticScore != null &&
        row.baseScore >= thresholds.review &&
        row.baseScore < thresholds.auto_merge
    );

  if (observed.length === 0) {
    throw new CommandError(
      'Semantic triage tuning requires at least one scored review-band pair.',
      2
    );
  }

  const mergeCandidates = [...new Set(observed.map((row) => row.semanticScore))].sort(
    (left, right) => right - left
  );
  let mergeThreshold: number | undefined;
  for (const threshold of mergeCandidates) {
    const predicted = observed.filter((row) => row.semanticScore >= threshold);
    const precision =
      predicted.length === 0
        ? 0
        : predicted.filter((row) => row.label === 'merge').length / predicted.length;
    if (precision >= minPrecision) {
      mergeThreshold = threshold;
    }
  }

  if (mergeThreshold == null) {
    throw new CommandError(
      `Semantic triage tuning could not satisfy min_auto_merge_precision=${minPrecision}.`,
      2
    );
  }

  const rejectCandidates = [...new Set(observed.map((row) => row.semanticScore))].sort(
    (left, right) => left - right
  );
  let rejectThreshold: number | undefined;
  for (const threshold of rejectCandidates) {
    const predicted = observed.filter((row) => row.semanticScore <= threshold);
    const precision =
      predicted.length === 0
        ? 0
        : predicted.filter((row) => row.label === 'not_match').length / predicted.length;
    if (precision >= minPrecision && threshold < mergeThreshold) {
      rejectThreshold = threshold;
    }
  }

  if (rejectThreshold == null) {
    throw new CommandError(
      `Semantic triage tuning could not satisfy reject precision=${minPrecision}.`,
      2
    );
  }

  const roundedMerge = Number(mergeThreshold.toFixed(4));
  const roundedReject = Number(rejectThreshold.toFixed(4));
  if (roundedReject >= roundedMerge) {
    throw new CommandError(
      'Rounding caused promote_to_reject_threshold to reach or exceed promote_to_merge_threshold.',
      1
    );
  }

  return {
    promote_to_merge_threshold: roundedMerge,
    promote_to_reject_threshold: roundedReject,
  };
}

async function fetchScores(
  spec: ResolvedTruthsetSpec,
  dialect: SupportedDialect,
  schema: string,
  runnerPath: string
): Promise<Map<string, number>> {
  const { query } = await loadRunnerModule(runnerPath);
  if (!query) {
    throw new CommandError('Truthset commands require a runner module with query(sql).');
  }

  const labels = loadTruthsetLabels(spec);
  const scores = new Map<string, number>();

  for (let index = 0; index < labels.length; index += 500) {
    const batch = labels.slice(index, index + 500);
    const querySql = buildPairScoreQuery(
      spec,
      batch.map((label) => label.pair_id),
      schema,
      dialect
    );
    const rawRows = await query(querySql);
    const parsedRows = TruthsetScoreRowsSchema.safeParse(rawRows);
    if (!parsedRows.success) {
      const issue = parsedRows.error.issues[0];
      throw new CommandError(
        `Runner query for ${spec.name} returned invalid truthset score rows: ${issue?.message ?? 'schema validation failed'}`,
        1
      );
    }

    for (const row of parsedRows.data) {
      scores.set(row.pair_id, row.composite_score);
    }
  }

  return scores;
}

async function fetchSemanticScores(
  spec: ResolvedTruthsetSpec,
  dialect: SupportedDialect,
  schema: string,
  runnerPath: string
): Promise<Map<string, number> | undefined> {
  const { query } = await loadRunnerModule(runnerPath);
  if (!query) {
    throw new CommandError('Truthset commands require a runner module with query(sql).');
  }

  const labels = loadTruthsetLabels(spec);
  const scores = new Map<string, number>();

  try {
    for (let index = 0; index < labels.length; index += 500) {
      const batch = labels.slice(index, index + 500);
      const querySql = buildSemanticPairScoreQuery(
        spec,
        batch.map((label) => label.pair_id),
        schema,
        dialect
      );
      const rawRows = await query(querySql);
      const parsedRows = TruthsetSemanticScoreRowsSchema.safeParse(rawRows);
      if (!parsedRows.success) {
        const issue = parsedRows.error.issues[0];
        throw new CommandError(
          `Runner query for ${spec.name} returned invalid semantic score rows: ${issue?.message ?? 'schema validation failed'}`,
          1
        );
      }

      for (const row of parsedRows.data) {
        scores.set(row.pair_id, row.semantic_score);
      }
    }
  } catch (error) {
    if (isMissingTableError(error)) {
      out.warn(
        `Semantic scores table not found for ${spec.name}; skipping semantic metrics. Run resolve with semantic triage or remove --include-semantic-triage.`
      );
      return undefined;
    }
    throw error;
  }

  return scores;
}

function validateHandler(
  names: string[],
  options: { dialect?: string; schema?: string; json?: boolean },
  globalOptions: { verbose?: boolean; quiet?: boolean }
): void {
  const { specs, dialect } = buildTruthsetContext(globalOptions, options, names);
  const payload = specs.map((spec) => ({
    name: spec.name,
    entity: spec.entity,
    resolution_ref: spec.resolutionRef,
    label_count: loadTruthsetLabels(spec).length,
    min_auto_merge_precision: spec.minAutoMergePrecision,
  }));

  if (options.json) {
    out.json({
      command: 'truthset.validate',
      dialect,
      specs: payload,
    });
    return;
  }

  for (const spec of payload) {
    out.success(`Validated truthset ${spec.name} (${spec.label_count} labels)`);
  }
}

async function scoreHandler(
  names: string[],
  options: {
    dialect?: string;
    schema?: string;
    runner?: string;
    json?: boolean;
    includeSemanticTriage?: boolean;
  },
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  if (!options.runner) {
    throw new CommandError('--runner is required for truthset score.');
  }

  const { specs, dialect, entityGraphDir, schema } = buildTruthsetContext(
    globalOptions,
    options,
    names
  );
  const results = [];

  for (const spec of specs) {
    const labels = loadTruthsetLabels(spec);
    const scores = await fetchScores(spec, dialect, schema, options.runner);
    const thresholds = resolveThresholds(spec, entityGraphDir);
    const semanticThresholds = options.includeSemanticTriage
      ? resolveSemanticTriageThresholds(spec, entityGraphDir)
      : undefined;
    const semanticScores =
      semanticThresholds !== undefined
        ? await fetchSemanticScores(spec, dialect, schema, options.runner)
        : undefined;
    results.push({
      name: spec.name,
      entity: spec.entity,
      thresholds,
      metrics: scoreLabels(labels, scores, thresholds),
      ...(semanticThresholds && semanticScores
        ? {
            semantic_triage: {
              thresholds: semanticThresholds,
              metrics: scoreSemanticTriageLabels(
                labels,
                scores,
                semanticScores,
                thresholds,
                semanticThresholds
              ),
            },
          }
        : {}),
    });
  }

  const scoreResult = { command: 'truthset.score', dialect, results };
  if (options.json) {
    out.json(scoreResult);
  } else {
    out.yaml(scoreResult);
  }
}

export async function buildTruthsetTuneResult(
  names: string[],
  options: {
    dialect?: string;
    schema?: string;
    runner?: string;
    includeSemanticTriage?: boolean;
  },
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<{
  command: 'truthset.tune';
  dialect: SupportedDialect;
  results: Array<{
    name: string;
    entity: string;
    recommended_thresholds: { auto_merge: number; review: number; auto_reject: number };
    recommended_semantic_triage_thresholds?: {
      promote_to_merge_threshold: number;
      promote_to_reject_threshold: number;
    };
  }>;
}> {
  if (!options.runner) {
    throw new CommandError('--runner is required for truthset tune.');
  }

  const { specs, dialect, schema, entityGraphDir } = buildTruthsetContext(
    globalOptions,
    options,
    names
  );
  const results = [];

  for (const spec of specs) {
    const labels = loadTruthsetLabels(spec);
    const scores = await fetchScores(spec, dialect, schema, options.runner);
    const semanticThresholds = options.includeSemanticTriage
      ? resolveSemanticTriageThresholds(spec, entityGraphDir)
      : undefined;
    const thresholds =
      semanticThresholds !== undefined ? resolveThresholds(spec, entityGraphDir) : undefined;
    const semanticScores =
      thresholds !== undefined
        ? await fetchSemanticScores(spec, dialect, schema, options.runner)
        : undefined;
    results.push({
      name: spec.name,
      entity: spec.entity,
      recommended_thresholds: tuneThresholds(labels, scores, spec.minAutoMergePrecision),
      ...(thresholds && semanticThresholds && semanticScores
        ? {
            recommended_semantic_triage_thresholds: tuneSemanticTriageThresholds(
              labels,
              scores,
              semanticScores,
              thresholds,
              spec.minAutoMergePrecision
            ),
          }
        : {}),
    });
  }

  return { command: 'truthset.tune', dialect, results };
}

async function tuneHandler(
  names: string[],
  options: {
    dialect?: string;
    schema?: string;
    runner?: string;
    json?: boolean;
    includeSemanticTriage?: boolean;
  },
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const tuneResult = await buildTruthsetTuneResult(names, options, globalOptions);
  if (options.json) {
    out.json(tuneResult);
  } else {
    out.yaml(tuneResult);
  }
}

export function registerTruthsetCommand(program: Command): void {
  const truthset = program.command('truthset').description('Truthset scoring and threshold tuning');

  truthset
    .command('init')
    .argument('<entity>', 'Entity name')
    .description('Scaffold a new truthset spec and CSV')
    .action((entity: string) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      initHandler(entity, globalOptions);
    });

  truthset
    .command('validate')
    .argument('[name...]', 'Truthset spec names (default: all)')
    .option('--json', 'Output results as JSON')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action((names: string[], opts: { dialect?: string; schema?: string; json?: boolean }) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      validateHandler(names, opts, globalOptions);
    });

  truthset
    .command('score')
    .argument('[name...]', 'Truthset spec names (default: all)')
    .requiredOption('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--include-semantic-triage', 'Report semantic triage promotion metrics')
    .option('--json', 'Output results as JSON')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(
      async (
        names: string[],
        opts: {
          dialect?: string;
          schema?: string;
          runner?: string;
          json?: boolean;
          includeSemanticTriage?: boolean;
        }
      ) => {
        const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
        await scoreHandler(names, opts, globalOptions);
      }
    );

  truthset
    .command('tune')
    .argument('[name...]', 'Truthset spec names (default: all)')
    .requiredOption('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--include-semantic-triage', 'Recommend semantic triage thresholds')
    .option('--json', 'Output results as JSON')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(
      async (
        names: string[],
        opts: {
          dialect?: string;
          schema?: string;
          runner?: string;
          json?: boolean;
          includeSemanticTriage?: boolean;
        }
      ) => {
        const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
        await tuneHandler(names, opts, globalOptions);
      }
    );

  registerTruthsetTrainCommand(truthset, program, {
    buildTruthsetContext,
    loadTruthsetLabels,
    scoreLabels,
    tuneThresholds,
  });
}
