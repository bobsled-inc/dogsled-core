import { CommandError } from '@bobsled-inc/protocol';

import { fsBitWeight } from '../identity/codegen-scoring.js';

import type { FellegiSunterComparison, FellegiSunterScoring } from '../identity/types.js';
import type { TruthsetLabel } from './parser.js';

export interface LevelOutcome {
  pair_id?: string;
  label?: TruthsetLabel['label'];
  levels: Record<string, number>;
}

export interface PriorAnchorCounts {
  deterministic_matches: number;
  total_pairs: number;
}

export interface TrainingOptions {
  deterministicRecall: number;
  uFloor: number;
  minLabeledMatches: number;
}

export interface LevelEstimateDiagnostic {
  field: string;
  level_index: number;
  op: string;
  gte?: number;
  labeled_match_count: number;
  labeled_match_observations: number;
  u_sample_count: number;
  u_sample_observations: number;
  m: number;
  u: number;
  weight_bits: number;
  warnings: string[];
}

export interface PriorDiagnostic {
  deterministic_matches: number;
  total_pairs: number;
  deterministic_recall: number;
  prior: number;
  label_base_rate: number;
}

export interface EstimateAgreementLevelDiagnostic {
  field: string;
  level_index: number;
  op: string;
  gte?: number;
  labeled_match_rate: number;
  auto_merge_band_rate: number;
  absolute_delta: number;
}

export interface TrainFellegiSunterResult {
  scoring: FellegiSunterScoring;
  label_count: number;
  labeled_match_count: number;
  labeled_non_match_count: number;
  u_sample_count: number;
  prior: PriorDiagnostic;
  level_diagnostics: LevelEstimateDiagnostic[];
  warnings: string[];
}

const PROBABILITY_EPSILON = 1e-9;

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return PROBABILITY_EPSILON;
  return Math.min(1 - PROBABILITY_EPSILON, Math.max(PROBABILITY_EPSILON, value));
}

function levelKey(field: string): string {
  return field;
}

function observedLevel(outcome: LevelOutcome, comparison: FellegiSunterComparison): number | null {
  const value = outcome.levels[levelKey(comparison.field)];
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

export function splitTruthsetLabels(
  labels: TruthsetLabel[],
  holdoutFraction: number
): { train: TruthsetLabel[]; holdout: TruthsetLabel[] } {
  if (!Number.isFinite(holdoutFraction) || holdoutFraction < 0 || holdoutFraction >= 1) {
    throw new CommandError('--holdout must be >= 0 and < 1.', 2);
  }
  if (holdoutFraction === 0) return { train: labels, holdout: [] };

  const ordered = [...labels].sort((left, right) => left.pair_id.localeCompare(right.pair_id));
  const grouped: Record<TruthsetLabel['label'], TruthsetLabel[]> = {
    merge: [],
    not_match: [],
  };
  for (const label of ordered) {
    grouped[label.label].push(label);
  }

  const train: TruthsetLabel[] = [];
  const holdout: TruthsetLabel[] = [];
  for (const group of Object.values(grouped)) {
    const targetHoldoutCount = Math.round(group.length * holdoutFraction);
    let selectedHoldoutCount = 0;
    group.forEach((label, index) => {
      const previousBucket = Math.floor((index * targetHoldoutCount) / group.length);
      const nextBucket = Math.floor(((index + 1) * targetHoldoutCount) / group.length);
      if (nextBucket > previousBucket && selectedHoldoutCount < targetHoldoutCount) {
        holdout.push(label);
        selectedHoldoutCount += 1;
      } else {
        train.push(label);
      }
    });
  }

  return {
    train: train.sort((left, right) => left.pair_id.localeCompare(right.pair_id)),
    holdout: holdout.sort((left, right) => left.pair_id.localeCompare(right.pair_id)),
  };
}

export function estimateFellegiSunterFromOutcomes(input: {
  skeleton: FellegiSunterScoring;
  labeledOutcomes: LevelOutcome[];
  uSampleOutcomes: LevelOutcome[];
  priorAnchors: PriorAnchorCounts;
  options: TrainingOptions;
}): TrainFellegiSunterResult {
  const matchOutcomes = input.labeledOutcomes.filter((row) => row.label === 'merge');
  const nonMatchOutcomes = input.labeledOutcomes.filter((row) => row.label === 'not_match');
  if (matchOutcomes.length < input.options.minLabeledMatches) {
    throw new CommandError(
      `truthset train requires at least ${input.options.minLabeledMatches} labeled matches (found ${matchOutcomes.length}).`,
      2
    );
  }
  if (input.uSampleOutcomes.length === 0) {
    throw new CommandError('truthset train requires at least one random u-sample pair.', 2);
  }

  const deterministicRecall = input.options.deterministicRecall;
  if (
    !Number.isFinite(deterministicRecall) ||
    deterministicRecall <= 0 ||
    deterministicRecall > 1
  ) {
    throw new CommandError('--deterministic-recall must be > 0 and <= 1.', 2);
  }

  const totalPairs = Math.max(0, input.priorAnchors.total_pairs);
  const deterministicMatches = Math.max(0, input.priorAnchors.deterministic_matches);
  const anchorRate = totalPairs === 0 ? 0 : deterministicMatches / totalPairs;
  const prior = clampProbability(anchorRate / deterministicRecall);
  const labelBaseRate =
    input.labeledOutcomes.length === 0 ? 0 : matchOutcomes.length / input.labeledOutcomes.length;

  const warnings: string[] = [];
  const diagnostics: LevelEstimateDiagnostic[] = [];

  // A zero deterministic-anchor count clamps the prior to the probability floor
  // (~1e-9, ≈ -30 bits), which silently crushes every match weight. This happens
  // when the spec has no auto_merge deterministic rules, or on a sparse dedupe
  // whose random anchor sample found no matching pair. Surface it instead of
  // emitting a garbage prior with no signal.
  const priorClampedToFloor = deterministicMatches === 0;
  if (priorClampedToFloor) {
    warnings.push(
      'Prior clamped to the probability floor: 0 deterministic-rule anchor matches were found. ' +
        'Add auto_merge deterministic_rules (or treat the trained prior as unreliable) — ' +
        'the reported prior is a floor, not an estimate.'
    );
  }

  const comparisons = input.skeleton.comparisons.map((comparison) => {
    const matchObservationCount = matchOutcomes.filter(
      (row) => observedLevel(row, comparison) != null
    ).length;
    const uObservationCount = input.uSampleOutcomes.filter(
      (row) => observedLevel(row, comparison) != null
    ).length;

    return {
      field: comparison.field,
      levels: comparison.levels.map((level, levelIndex) => {
        const levelCount = comparison.levels.length;
        const labeledMatchCount = matchOutcomes.filter(
          (row) => observedLevel(row, comparison) === levelIndex
        ).length;
        const uSampleCount = input.uSampleOutcomes.filter(
          (row) => observedLevel(row, comparison) === levelIndex
        ).length;

        const m = clampProbability((labeledMatchCount + 1) / (matchObservationCount + levelCount));
        const smoothedU = clampProbability((uSampleCount + 1) / (uObservationCount + levelCount));
        const u = Math.max(input.options.uFloor, smoothedU);
        const levelWarnings: string[] = [];
        if (labeledMatchCount < 10) {
          const warning = `${comparison.field}[${levelIndex}] has ${labeledMatchCount} labeled-match observations; m may be unstable.`;
          levelWarnings.push(warning);
          warnings.push(warning);
        }
        // The floor raised u above its smoothed estimate: the level's coincidental
        // agreement rate is unresolved at this sample size, capping its positive
        // weight. Raise --u-sample-pairs or lower --u-floor to resolve it.
        if (u > smoothedU) {
          const warning = `${comparison.field}[${levelIndex}] u was raised to the floor ${input.options.uFloor} (smoothed estimate ${smoothedU.toExponential(2)}); its match weight is capped. Increase --u-sample-pairs or lower --u-floor.`;
          levelWarnings.push(warning);
          warnings.push(warning);
        }

        diagnostics.push({
          field: comparison.field,
          level_index: levelIndex,
          op: level.op,
          ...(level.gte !== undefined ? { gte: level.gte } : {}),
          labeled_match_count: labeledMatchCount,
          labeled_match_observations: matchObservationCount,
          u_sample_count: uSampleCount,
          u_sample_observations: uObservationCount,
          m,
          u,
          weight_bits: fsBitWeight(m, u),
          warnings: levelWarnings,
        });

        return {
          op: level.op,
          ...(level.gte !== undefined ? { gte: level.gte } : {}),
          m,
          u,
        };
      }),
    };
  });

  return {
    scoring: {
      method: 'fellegi_sunter',
      prior,
      comparisons,
    },
    label_count: input.labeledOutcomes.length,
    labeled_match_count: matchOutcomes.length,
    labeled_non_match_count: nonMatchOutcomes.length,
    u_sample_count: input.uSampleOutcomes.length,
    prior: {
      deterministic_matches: deterministicMatches,
      total_pairs: totalPairs,
      deterministic_recall: deterministicRecall,
      prior,
      label_base_rate: labelBaseRate,
    },
    level_diagnostics: diagnostics,
    warnings,
  };
}

export function scoreFellegiSunterOutcomes(
  scoring: FellegiSunterScoring,
  outcomes: LevelOutcome[]
): Map<string, number> {
  const scores = new Map<string, number>();
  const priorBits = fsBitWeight(scoring.prior, 1 - scoring.prior);
  for (const outcome of outcomes) {
    if (!outcome.pair_id) continue;
    let totalBits = priorBits;
    for (const comparison of scoring.comparisons) {
      const levelIndex = observedLevel(outcome, comparison);
      if (levelIndex == null) continue;
      const level = comparison.levels[levelIndex];
      if (!level) continue;
      totalBits += fsBitWeight(level.m, level.u);
    }
    const probability = clampProbability(1 / (1 + Math.exp(-totalBits * Math.LN2)));
    scores.set(outcome.pair_id, probability);
  }
  return scores;
}

export function estimateAgreementDiagnostics(input: {
  comparisons: FellegiSunterComparison[];
  labeledMatchOutcomes: LevelOutcome[];
  autoMergeBandOutcomes: LevelOutcome[];
}): EstimateAgreementLevelDiagnostic[] {
  return input.comparisons.flatMap((comparison) => {
    const labeledObservationCount = input.labeledMatchOutcomes.filter(
      (row) => observedLevel(row, comparison) != null
    ).length;
    const autoMergeObservationCount = input.autoMergeBandOutcomes.filter(
      (row) => observedLevel(row, comparison) != null
    ).length;

    return comparison.levels.map((level, levelIndex) => {
      const labeledCount = input.labeledMatchOutcomes.filter(
        (row) => observedLevel(row, comparison) === levelIndex
      ).length;
      const autoMergeCount = input.autoMergeBandOutcomes.filter(
        (row) => observedLevel(row, comparison) === levelIndex
      ).length;
      const labeledRate =
        labeledObservationCount === 0 ? 0 : labeledCount / labeledObservationCount;
      const autoMergeRate =
        autoMergeObservationCount === 0 ? 0 : autoMergeCount / autoMergeObservationCount;
      return {
        field: comparison.field,
        level_index: levelIndex,
        op: level.op,
        ...(level.gte !== undefined ? { gte: level.gte } : {}),
        labeled_match_rate: labeledRate,
        auto_merge_band_rate: autoMergeRate,
        absolute_delta: Math.abs(labeledRate - autoMergeRate),
      };
    });
  });
}
