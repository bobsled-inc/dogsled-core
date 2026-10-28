import { describe, expect, it } from 'vitest';

import { CommandError } from '@bobsled-inc/protocol';
import {
  scoreSemanticTriageLabels,
  tuneSemanticTriageThresholds,
  tuneThresholds,
} from '../../../src/commands/truthset.js';

describe('tuneThresholds', () => {
  it('returns the most permissive valid auto-merge threshold and a lower review threshold', () => {
    const labels = [
      { pair_id: 'pair-1', label: 'merge' as const },
      { pair_id: 'pair-2', label: 'merge' as const },
      { pair_id: 'pair-3', label: 'not_match' as const },
      { pair_id: 'pair-4', label: 'not_match' as const },
    ];
    const scores = new Map([
      ['pair-1', 0.98],
      ['pair-2', 0.87],
      ['pair-3', 0.86],
      ['pair-4', 0.21],
    ]);

    expect(tuneThresholds(labels, scores, 0.95)).toEqual({
      auto_merge: 0.87,
      review: 0.86,
      auto_reject: 0.86,
    });
  });

  it('throws when no threshold satisfies the requested auto-merge precision', () => {
    const labels = [
      { pair_id: 'pair-1', label: 'merge' as const },
      { pair_id: 'pair-2', label: 'not_match' as const },
    ];
    const scores = new Map([
      ['pair-1', 0.91],
      ['pair-2', 0.91],
    ]);

    expect(() => tuneThresholds(labels, scores, 0.95)).toThrow(CommandError);
    expect(() => tuneThresholds(labels, scores, 0.95)).toThrow(
      'Truthset tuning could not satisfy min_auto_merge_precision=0.95.'
    );
  });

  it('throws when no review threshold exists below auto_merge', () => {
    const labels = [
      { pair_id: 'pair-1', label: 'merge' as const },
      { pair_id: 'pair-2', label: 'not_match' as const },
    ];
    const scores = new Map([
      ['pair-1', 0.91],
      ['pair-2', 0.91],
    ]);

    expect(() => tuneThresholds(labels, scores, 0.5)).toThrow(CommandError);
    expect(() => tuneThresholds(labels, scores, 0.5)).toThrow(
      'Truthset tuning could not derive a review threshold below auto_merge.'
    );
  });

  it('throws when rounding collapses review to auto_merge', () => {
    const labels = [
      { pair_id: 'pair-1', label: 'merge' as const },
      { pair_id: 'pair-2', label: 'not_match' as const },
    ];
    const scores = new Map([
      ['pair-1', 0.90004],
      ['pair-2', 0.90003],
    ]);

    expect(() => tuneThresholds(labels, scores, 1)).toThrow(CommandError);
    expect(() => tuneThresholds(labels, scores, 1)).toThrow(
      'Rounding caused review threshold to reach or exceed auto_merge.'
    );
  });
});

describe('semantic triage truthset helpers', () => {
  const labels = [
    { pair_id: 'pair-1', label: 'merge' as const },
    { pair_id: 'pair-2', label: 'not_match' as const },
    { pair_id: 'pair-3', label: 'merge' as const },
  ];
  const baseScores = new Map([
    ['pair-1', 0.8],
    ['pair-2', 0.75],
    ['pair-3', 0.7],
  ]);
  const semanticScores = new Map([
    ['pair-1', 0.98],
    ['pair-2', 0.2],
    ['pair-3', 0.7],
  ]);
  const thresholds = { auto_merge: 0.95, review: 0.6 };

  it('scores semantic triage promotions separately from base scores', () => {
    expect(
      scoreSemanticTriageLabels(labels, baseScores, semanticScores, thresholds, {
        promote_to_merge_threshold: 0.94,
        promote_to_reject_threshold: 0.55,
      })
    ).toEqual({
      evaluated_label_count: 3,
      promoted_merge_count: 1,
      promoted_merge_precision: 1,
      promoted_reject_count: 1,
      promoted_reject_precision: 1,
      kept_for_review_count: 1,
    });
  });

  it('tunes semantic triage thresholds from review-band labels', () => {
    expect(
      tuneSemanticTriageThresholds(labels, baseScores, semanticScores, thresholds, 0.95)
    ).toEqual({
      promote_to_merge_threshold: 0.7,
      promote_to_reject_threshold: 0.2,
    });
  });
});
