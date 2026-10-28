import { describe, expect, it } from 'vitest';

import { CommandError } from '@bobsled-inc/protocol';
import { ResolutionSpecSchema } from '@bobsled-inc/model-spec';

import {
  estimateAgreementDiagnostics,
  estimateFellegiSunterFromOutcomes,
  scoreFellegiSunterOutcomes,
  splitTruthsetLabels,
  type LevelOutcome,
} from '../../../../src/compiler/truthset/train.js';

import type { FellegiSunterScoring } from '../../../../src/compiler/identity/types.js';

const skeleton: FellegiSunterScoring = {
  method: 'fellegi_sunter',
  prior: 0.01,
  comparisons: [
    {
      field: 'standardized_email',
      levels: [
        { op: 'exact', m: 0.5, u: 0.5 },
        { op: 'else', m: 0.5, u: 0.5 },
      ],
    },
  ],
};

function outcomes(count: number, level: number, label?: 'merge' | 'not_match'): LevelOutcome[] {
  return Array.from({ length: count }, (_, index) => ({
    pair_id: `${label ?? 'u'}-${level}-${index}`,
    ...(label ? { label } : {}),
    levels: { standardized_email: level },
  }));
}

describe('estimateFellegiSunterFromOutcomes', () => {
  it('recovers known m/u rates from synthetic counts within tolerance', () => {
    const result = estimateFellegiSunterFromOutcomes({
      skeleton,
      labeledOutcomes: [
        ...outcomes(400, 0, 'merge'),
        ...outcomes(100, 1, 'merge'),
        ...outcomes(250, 0, 'not_match'),
        ...outcomes(250, 1, 'not_match'),
      ],
      uSampleOutcomes: [...outcomes(25, 0), ...outcomes(475, 1)],
      priorAnchors: { deterministic_matches: 90, total_pairs: 100_000 },
      options: {
        deterministicRecall: 0.9,
        uFloor: 0.001,
        minLabeledMatches: 50,
      },
    });

    const [exact, fallback] = result.scoring.comparisons[0]!.levels;
    expect(exact!.m).toBeCloseTo(0.8, 2);
    expect(fallback!.m).toBeCloseTo(0.2, 2);
    expect(exact!.u).toBeCloseTo(0.05, 2);
    expect(fallback!.u).toBeCloseTo(0.95, 2);
    expect(result.prior.prior).toBeCloseTo(0.001, 6);
  });

  it('uses the comparison level count for Laplace smoothing', () => {
    const threeLevelSkeleton: FellegiSunterScoring = {
      method: 'fellegi_sunter',
      prior: 0.01,
      comparisons: [
        {
          field: 'standardized_name',
          levels: [
            { op: 'exact', m: 0.5, u: 0.5 },
            { op: 'jaro_winkler', gte: 0.9, m: 0.5, u: 0.5 },
            { op: 'else', m: 0.5, u: 0.5 },
          ],
        },
      ],
    };

    const result = estimateFellegiSunterFromOutcomes({
      skeleton: threeLevelSkeleton,
      labeledOutcomes: [
        ...Array.from({ length: 6 }, (_, index) => ({
          pair_id: `m-exact-${index}`,
          label: 'merge' as const,
          levels: { standardized_name: 0 },
        })),
        ...Array.from({ length: 3 }, (_, index) => ({
          pair_id: `m-near-${index}`,
          label: 'merge' as const,
          levels: { standardized_name: 1 },
        })),
        {
          pair_id: 'm-else-0',
          label: 'merge',
          levels: { standardized_name: 2 },
        },
      ],
      uSampleOutcomes: [
        ...Array.from({ length: 2 }, (_, index) => ({
          pair_id: `u-exact-${index}`,
          levels: { standardized_name: 0 },
        })),
        ...Array.from({ length: 8 }, (_, index) => ({
          pair_id: `u-else-${index}`,
          levels: { standardized_name: 2 },
        })),
      ],
      priorAnchors: { deterministic_matches: 1, total_pairs: 1000 },
      options: {
        deterministicRecall: 0.9,
        uFloor: 0.001,
        minLabeledMatches: 1,
      },
    });

    const [exact, near, fallback] = result.scoring.comparisons[0]!.levels;
    expect(exact!.m).toBeCloseTo(7 / 13, 8);
    expect(near!.m).toBeCloseTo(4 / 13, 8);
    expect(fallback!.m).toBeCloseTo(2 / 13, 8);
    expect(exact!.u).toBeCloseTo(3 / 13, 8);
  });

  it('returns a trained block that passes resolution spec validation', () => {
    const result = estimateFellegiSunterFromOutcomes({
      skeleton,
      labeledOutcomes: [...outcomes(60, 0, 'merge'), ...outcomes(20, 1, 'merge')],
      uSampleOutcomes: [...outcomes(5, 0), ...outcomes(95, 1)],
      priorAnchors: { deterministic_matches: 5, total_pairs: 10_000 },
      options: {
        deterministicRecall: 0.9,
        uFloor: 0.001,
        minLabeledMatches: 50,
      },
    });

    const parsed = ResolutionSpecSchema.safeParse({
      spec_version: '0.2',
      name: 'company_resolution',
      type: 'resolution',
      description: 'Company identity resolution.',
      inputs: [{ ref: 'crm_companies', id_fields: ['id'] }],
      standardize: [{ field: 'email', transforms: ['lowercase', 'trim'] }],
      deterministic_rules: [],
      scoring: result.scoring,
      thresholds: { auto_merge: 0.9, review: 0.7, auto_reject: 0.2 },
    });

    expect(parsed.success).toBe(true);
  });

  it('refuses to train with fewer than 50 labeled matches', () => {
    expect(() =>
      estimateFellegiSunterFromOutcomes({
        skeleton,
        labeledOutcomes: outcomes(49, 0, 'merge'),
        uSampleOutcomes: outcomes(10, 1),
        priorAnchors: { deterministic_matches: 1, total_pairs: 1000 },
        options: {
          deterministicRecall: 0.9,
          uFloor: 0.001,
          minLabeledMatches: 50,
        },
      })
    ).toThrow(CommandError);
  });

  it('warns when zero deterministic anchors clamp the prior to the floor', () => {
    const result = estimateFellegiSunterFromOutcomes({
      skeleton,
      labeledOutcomes: [...outcomes(60, 0, 'merge'), ...outcomes(20, 1, 'merge')],
      uSampleOutcomes: [...outcomes(5, 0), ...outcomes(95, 1)],
      priorAnchors: { deterministic_matches: 0, total_pairs: 10_000 },
      options: { deterministicRecall: 0.9, uFloor: 0.001, minLabeledMatches: 50 },
    });
    expect(result.warnings.some((w) => /Prior clamped to the probability floor/.test(w))).toBe(
      true
    );
  });

  it('warns per-level when the u floor raises u above its smoothed estimate', () => {
    const result = estimateFellegiSunterFromOutcomes({
      skeleton,
      // The exact level is never observed in the u-sample → smoothed u is tiny
      // and gets raised to the 0.01 floor.
      labeledOutcomes: [...outcomes(60, 0, 'merge'), ...outcomes(20, 1, 'merge')],
      uSampleOutcomes: outcomes(5000, 1),
      priorAnchors: { deterministic_matches: 100, total_pairs: 10_000 },
      options: { deterministicRecall: 0.9, uFloor: 0.01, minLabeledMatches: 50 },
    });
    expect(result.warnings.some((w) => /u was raised to the floor/.test(w))).toBe(true);
    const exact = result.scoring.comparisons[0]!.levels[0]!;
    expect(exact.u).toBeCloseTo(0.01, 8);
  });

  it('scores held-out outcomes with trained Fellegi-Sunter probabilities', () => {
    const result = estimateFellegiSunterFromOutcomes({
      skeleton,
      labeledOutcomes: [...outcomes(80, 0, 'merge'), ...outcomes(20, 1, 'merge')],
      uSampleOutcomes: [...outcomes(2, 0), ...outcomes(98, 1)],
      priorAnchors: { deterministic_matches: 100, total_pairs: 10_000 },
      options: {
        deterministicRecall: 0.9,
        uFloor: 0.001,
        minLabeledMatches: 50,
      },
    });

    const scores = scoreFellegiSunterOutcomes(result.scoring, [
      { pair_id: 'agree', levels: { standardized_email: 0 } },
      { pair_id: 'disagree', levels: { standardized_email: 1 } },
    ]);

    expect(scores.get('agree')).toBeGreaterThan(scores.get('disagree')!);
  });
});

describe('truthset train helpers', () => {
  it('splits labels into a deterministic stratified holdout', () => {
    const labels = [
      ...Array.from({ length: 10 }, (_, index) => ({
        pair_id: `m-${index}`,
        label: 'merge' as const,
      })),
      ...Array.from({ length: 10 }, (_, index) => ({
        pair_id: `n-${index}`,
        label: 'not_match' as const,
      })),
    ];

    const split = splitTruthsetLabels(labels, 0.2);

    expect(split.holdout.filter((label) => label.label === 'merge')).toHaveLength(2);
    expect(split.holdout.filter((label) => label.label === 'not_match')).toHaveLength(2);
    expect(split.train).toHaveLength(16);
  });

  it('honors holdout fractions above half instead of capping at every other row', () => {
    const labels = [
      ...Array.from({ length: 10 }, (_, index) => ({
        pair_id: `m-${index}`,
        label: 'merge' as const,
      })),
      ...Array.from({ length: 10 }, (_, index) => ({
        pair_id: `n-${index}`,
        label: 'not_match' as const,
      })),
    ];

    const split = splitTruthsetLabels(labels, 0.8);

    expect(split.holdout.filter((label) => label.label === 'merge')).toHaveLength(8);
    expect(split.holdout.filter((label) => label.label === 'not_match')).toHaveLength(8);
    expect(split.train).toHaveLength(4);
  });

  it('compares labeled-m level distribution with auto-merge band distribution', () => {
    const diagnostics = estimateAgreementDiagnostics({
      comparisons: skeleton.comparisons,
      labeledMatchOutcomes: [...outcomes(80, 0, 'merge'), ...outcomes(20, 1, 'merge')],
      autoMergeBandOutcomes: [...outcomes(70, 0), ...outcomes(30, 1)],
    });

    expect(diagnostics[0]).toMatchObject({
      field: 'standardized_email',
      level_index: 0,
      labeled_match_rate: 0.8,
      auto_merge_band_rate: 0.7,
    });
  });
});
