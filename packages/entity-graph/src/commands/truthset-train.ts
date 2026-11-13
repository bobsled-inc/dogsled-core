import YAML from 'yaml';
import { CommandError } from '@bobsled-inc/protocol';
import { type SupportedDialect } from '@bobsled-inc/model-spec';
import { createDialectOption, loadRunnerModule } from '@bobsled-inc/model-spec/shared';

import {
  buildAutoMergeBandLevelOutcomeQuery,
  buildRandomPairLevelOutcomeQuery,
} from '../compiler/identity/codegen-fs-training.js';
import {
  estimateAgreementDiagnostics,
  estimateFellegiSunterFromOutcomes,
  scoreFellegiSunterOutcomes,
  splitTruthsetLabels,
} from '../compiler/truthset/train.js';
import { loadEntityGraphProjectContext } from '../runtime/project-context.js';
import { isMissingTableError } from './resolve-support.js';
import {
  emitEntityGraphPayload,
  resolveEntityGraphOutputFormat,
  type EntityGraphOutputFormat,
} from './utils.js';
import {
  applyFellegiSunterScoringPatch,
  assertFellegiSunterSpec,
  dedupeTruthsetLabels,
  fetchLabeledOutcomes,
  fetchPriorAnchors,
  findResolutionFile,
  labelsFromOutcomes,
  queryLevelOutcomes,
  serializeFellegiSunterScoringPatch,
  type QueryRunner,
} from './truthset-train-support.js';

import type { Command } from 'commander';
import type { ResolvedTruthsetSpec, TruthsetLabel } from '../compiler/truthset/parser.js';
import type { TruthsetContext } from './truthset.js';

export { applyFellegiSunterScoringPatch, serializeFellegiSunterScoringPatch };

type BuildTruthsetContext = (
  globalOptions: { verbose?: boolean; quiet?: boolean },
  localOptions: { dialect?: string; schema?: string },
  names: string[]
) => TruthsetContext;

type ScoreLabels = (
  labels: TruthsetLabel[],
  scores: Map<string, number>,
  thresholds: { auto_merge: number; review: number }
) => {
  matched_label_count: number;
  missing_pair_count: number;
  auto_merge_precision: number;
  auto_merge_recall: number;
  review_recall: number;
  auto_reject_precision: number;
};

type TuneThresholds = (
  labels: TruthsetLabel[],
  scores: Map<string, number>,
  minAutoMergePrecision: number
) => { auto_merge: number; review: number; auto_reject: number };

export interface TruthsetTrainDependencies {
  buildTruthsetContext: BuildTruthsetContext;
  loadTruthsetLabels: (spec: ResolvedTruthsetSpec) => TruthsetLabel[];
  scoreLabels: ScoreLabels;
  tuneThresholds: TuneThresholds;
}

interface TruthsetTrainOptions {
  dialect?: string;
  schema?: string;
  runner?: string;
  entity?: string;
  holdout?: string;
  uSamplePairs?: string;
  deterministicRecall?: string;
  uFloor?: string;
  apply?: boolean;
  json?: boolean;
  yaml?: boolean;
}

const DEFAULT_HOLDOUT_FRACTION = 0.2;
const DEFAULT_U_SAMPLE_PAIRS = 1_000_000;
const MAX_U_SAMPLE_PAIRS = 5_000_000;
const DEFAULT_DETERMINISTIC_RECALL = 0.9;
const DEFAULT_U_FLOOR = 0.001;
const MIN_LABELED_MATCHES = 50;
const AUTO_MERGE_DIAGNOSTIC_LIMIT = 10_000;

function parseNumberOption(value: string | undefined, fallback: number, name: string): number {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CommandError(`${name} must be a finite number.`, 2);
  }
  return parsed;
}

function parseIntegerOption(value: string | undefined, fallback: number, name: string): number {
  const parsed = parseNumberOption(value, fallback, name);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CommandError(`${name} must be a positive integer.`, 2);
  }
  return parsed;
}

function parseBoundedIntegerOption(
  value: string | undefined,
  fallback: number,
  name: string,
  max: number
): number {
  const parsed = parseIntegerOption(value, fallback, name);
  if (parsed > max) {
    throw new CommandError(`${name} must not exceed ${max}.`, 2);
  }
  return parsed;
}

function parseHoldoutOption(value: string | undefined): number {
  const parsed = parseNumberOption(value, DEFAULT_HOLDOUT_FRACTION, '--holdout');
  if (parsed < 0 || parsed >= 1) {
    throw new CommandError('--holdout must be >= 0 and < 1.', 2);
  }
  return parsed;
}

function parseDeterministicRecallOption(value: string | undefined): number {
  const parsed = parseNumberOption(value, DEFAULT_DETERMINISTIC_RECALL, '--deterministic-recall');
  if (parsed <= 0 || parsed > 1) {
    throw new CommandError('--deterministic-recall must be > 0 and <= 1.', 2);
  }
  return parsed;
}

function parseUFloorOption(value: string | undefined): number {
  const parsed = parseNumberOption(value, DEFAULT_U_FLOOR, '--u-floor');
  if (parsed <= 0 || parsed >= 1) {
    throw new CommandError('--u-floor must be > 0 and < 1.', 2);
  }
  return parsed;
}

function trainOutputFormat(options: TruthsetTrainOptions): EntityGraphOutputFormat {
  return resolveEntityGraphOutputFormat({
    json: options.json,
    yaml: options.yaml,
    defaultFormat: 'yaml',
  });
}

export async function buildTruthsetTrainResult(
  names: string[],
  options: TruthsetTrainOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean },
  deps: TruthsetTrainDependencies
): Promise<{
  command: 'truthset.train';
  dialect: SupportedDialect;
  schema: string;
  results: unknown[];
}> {
  if (!options.runner) {
    throw new CommandError('--runner is required for truthset train.', 2);
  }

  const holdoutFraction = parseHoldoutOption(options.holdout);
  const uSamplePairs = parseBoundedIntegerOption(
    options.uSamplePairs,
    DEFAULT_U_SAMPLE_PAIRS,
    '--u-sample-pairs',
    MAX_U_SAMPLE_PAIRS
  );
  const deterministicRecall = parseDeterministicRecallOption(options.deterministicRecall);
  const uFloor = parseUFloorOption(options.uFloor);

  const context = deps.buildTruthsetContext(globalOptions, options, names);
  const specs = options.entity
    ? context.specs.filter(
        (spec) =>
          spec.entity === options.entity ||
          spec.resolutionEntity === options.entity ||
          spec.name === options.entity
      )
    : context.specs;
  if (specs.length === 0) {
    const qualifier = options.entity ? ` matching entity ${options.entity}` : '';
    throw new CommandError(`No truthset specs found${qualifier}.`, 2);
  }

  const graphContext = await loadEntityGraphProjectContext({
    entityNames: [...new Set(specs.map((spec) => spec.resolutionEntity))],
    dialect: context.dialect,
    schema: context.schema,
    verbose: globalOptions.verbose,
    quiet: globalOptions.quiet,
  });
  const resolutionsByName = new Map(graphContext.specs.map((spec) => [spec.name, spec]));
  const loadedRunner = await loadRunnerModule(options.runner);
  if (!loadedRunner.query) {
    throw new CommandError('Truthset commands require a runner module with query(sql).', 2);
  }
  const runner: QueryRunner = { query: (sql: string) => loadedRunner.query?.(sql) };

  const results = [];
  for (const truthset of specs) {
    const resolution = resolutionsByName.get(truthset.resolutionRef);
    if (!resolution) {
      throw new CommandError(
        `Unable to resolve ${truthset.resolutionRef} for ${truthset.name}.`,
        2
      );
    }
    const skeleton = assertFellegiSunterSpec(resolution);
    // Collapse duplicate/conflicting pair labels before splitting so no pair
    // lands in both train and holdout (leakage) or double-counts m.
    const labels = dedupeTruthsetLabels(deps.loadTruthsetLabels(truthset));
    const split = splitTruthsetLabels(labels, holdoutFraction);
    const trainingOutcomes = await fetchLabeledOutcomes({
      runner,
      spec: resolution,
      labels: split.train,
      schema: context.schema,
      dialect: context.dialect,
    });
    const holdoutOutcomes = await fetchLabeledOutcomes({
      runner,
      spec: resolution,
      labels: split.holdout,
      schema: context.schema,
      dialect: context.dialect,
    });
    const uSampleOutcomes = await queryLevelOutcomes({
      runner,
      sql: buildRandomPairLevelOutcomeQuery(
        resolution,
        uSamplePairs,
        context.schema,
        context.dialect
      ),
      comparisons: skeleton.comparisons,
    });
    const priorAnchors = await fetchPriorAnchors({
      runner,
      spec: resolution,
      schema: context.schema,
      dialect: context.dialect,
    });

    const trainResult = estimateFellegiSunterFromOutcomes({
      skeleton,
      labeledOutcomes: trainingOutcomes,
      uSampleOutcomes,
      priorAnchors,
      options: {
        deterministicRecall,
        uFloor,
        minLabeledMatches: MIN_LABELED_MATCHES,
      },
    });

    // Tune thresholds on the TRAINING split only. Tuning over train+holdout and
    // then reporting holdout precision/recall at those thresholds is circular:
    // the holdout labels influence the very thresholds it is measured against,
    // inflating the "held-out" metrics. Train-only tuning keeps the holdout an
    // honest check (the plan's stated purpose for it).
    const trainingScores = scoreFellegiSunterOutcomes(trainResult.scoring, trainingOutcomes);
    const trainingScoredLabels = labelsFromOutcomes(trainingOutcomes);
    const warnings = [...trainResult.warnings];
    let recommendedThresholds:
      { auto_merge: number; review: number; auto_reject: number } | undefined;
    try {
      recommendedThresholds = deps.tuneThresholds(
        trainingScoredLabels,
        trainingScores,
        truthset.minAutoMergePrecision
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Threshold recommendation skipped: ${message}`);
    }

    const holdoutScores = scoreFellegiSunterOutcomes(trainResult.scoring, holdoutOutcomes);
    const holdoutLabels = labelsFromOutcomes(holdoutOutcomes);
    const metricThresholds =
      recommendedThresholds ??
      (resolution.thresholds.autoMerge !== null
        ? {
            auto_merge: resolution.thresholds.autoMerge,
            review: resolution.thresholds.review,
          }
        : undefined);
    const holdout =
      metricThresholds && holdoutLabels.length > 0
        ? {
            fraction: holdoutFraction,
            label_count: split.holdout.length,
            scored_label_count: holdoutLabels.length,
            metrics: deps.scoreLabels(holdoutLabels, holdoutScores, metricThresholds),
          }
        : {
            fraction: holdoutFraction,
            label_count: split.holdout.length,
            scored_label_count: holdoutLabels.length,
            metrics: null,
          };

    let agreementDiagnostics: unknown[] = [];
    if (resolution.thresholds.autoMerge !== null) {
      try {
        const autoMergeBandOutcomes = await queryLevelOutcomes({
          runner,
          sql: buildAutoMergeBandLevelOutcomeQuery(
            resolution,
            resolution.thresholds.autoMerge,
            AUTO_MERGE_DIAGNOSTIC_LIMIT,
            context.schema,
            context.dialect
          ),
          comparisons: skeleton.comparisons,
        });
        agreementDiagnostics = estimateAgreementDiagnostics({
          comparisons: skeleton.comparisons,
          labeledMatchOutcomes: trainingOutcomes.filter((row) => row.label === 'merge'),
          autoMergeBandOutcomes,
        });
      } catch (error) {
        if (isMissingTableError(error)) {
          warnings.push('Estimate-agreement diagnostic skipped because __pair_scores is missing.');
        } else {
          throw error;
        }
      }
    } else {
      warnings.push('Estimate-agreement diagnostic skipped because auto_merge is null.');
    }

    const yamlPatch = serializeFellegiSunterScoringPatch(trainResult.scoring);
    let applied: ReturnType<typeof applyFellegiSunterScoringPatch> | undefined;
    if (options.apply) {
      const resolutionFile = findResolutionFile(context.entityGraphDir, truthset.resolutionRef);
      if (!resolutionFile) {
        throw new CommandError(`Unable to find YAML file for ${truthset.resolutionRef}.`, 2);
      }
      applied = applyFellegiSunterScoringPatch(resolutionFile.filePath, trainResult.scoring);
    }

    results.push({
      name: truthset.name,
      entity: truthset.entity,
      resolution_ref: truthset.resolutionRef,
      training_label_count: split.train.length,
      training_scored_label_count: trainingOutcomes.length,
      training_missing_pair_count: split.train.length - trainingOutcomes.length,
      holdout,
      u_sample_requested_pair_count: uSamplePairs,
      u_sample_observed_pair_count: uSampleOutcomes.length,
      prior: trainResult.prior,
      scoring: trainResult.scoring,
      yaml_patch: yamlPatch,
      recommended_thresholds: recommendedThresholds,
      level_diagnostics: trainResult.level_diagnostics,
      estimate_agreement: agreementDiagnostics,
      warnings,
      ...(applied ? { applied } : {}),
    });
  }

  return {
    command: 'truthset.train',
    dialect: context.dialect,
    schema: context.schema,
    results,
  };
}

export function registerTruthsetTrainCommand(
  truthset: Command,
  program: Command,
  deps: TruthsetTrainDependencies
): void {
  truthset
    .command('train')
    .argument('[name...]', 'Truthset spec names (default: all)')
    .requiredOption('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--entity <name>', 'Train only truthsets for this entity')
    .option('--holdout <fraction>', 'Holdout fraction for stratified validation', '0.2')
    .option('--u-sample-pairs <n>', 'Random cross-pairs used to estimate u', '1000000')
    .option(
      '--deterministic-recall <r>',
      'Estimated recall of strict deterministic auto-merge anchors',
      '0.9'
    )
    .option('--u-floor <value>', 'Minimum u probability per level (caps max match weight)', '0.001')
    .option('--apply', 'Write the trained scoring block back to the resolution spec')
    .option('--json', 'Output results as JSON')
    .option('--yaml', 'Output results as YAML')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(async (names: string[], opts: TruthsetTrainOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      const result = await buildTruthsetTrainResult(names, opts, globalOptions, deps);
      emitEntityGraphPayload(result, trainOutputFormat(opts), () => YAML.stringify(result));
    });
}
