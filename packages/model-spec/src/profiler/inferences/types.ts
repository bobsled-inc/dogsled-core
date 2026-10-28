import type { ProfileInference, ProfileScalarKind } from '../types.js';

import {
  clampConfidence,
  classifyDeclaredType,
  classifyRuntimeValue,
  nonNullValues,
  roundRate,
  sampleExamples,
} from './utils.js';

export function inferType(
  values: unknown[],
  declaredDataType?: string
): ProfileInference<ProfileScalarKind> {
  const declaredKind = classifyDeclaredType(declaredDataType);
  const observed = nonNullValues(values);
  const sampleSize = values.length;
  const nonNullCount = observed.length;

  if (nonNullCount === 0) {
    return {
      kind: declaredKind ?? 'null',
      confidence: declaredKind ? 0.65 : 0.4,
      evidence: {
        sampleSize,
        matches: 0,
        mismatches: 0,
        nulls: sampleSize,
        declaredType: declaredDataType,
        declaredKind,
        examples: [],
      },
    };
  }

  const counts = new Map<ProfileScalarKind, number>();
  for (const value of observed) {
    const kind = classifyRuntimeValue(value);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  const integerCount = counts.get('integer') ?? 0;
  const decimalCount = counts.get('number') ?? 0;
  if (integerCount > 0 && decimalCount > 0) {
    counts.delete('integer');
    counts.set('number', integerCount + decimalCount);
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [dominantKind, dominantCount] = ranked[0] ?? ['string', 0];
  const compatibleDominant =
    dominantKind === 'integer' && declaredKind === 'number' ? 'number' : dominantKind;
  const finalKind =
    ranked.length > 1 && dominantCount / nonNullCount < 0.8 ? 'mixed' : compatibleDominant;
  const matches =
    finalKind === 'mixed'
      ? dominantCount
      : observed.filter((value) => {
          const kind = classifyRuntimeValue(value);
          return kind === finalKind || (kind === 'integer' && finalKind === 'number');
        }).length;
  const matchRate = matches / nonNullCount;
  const declaredBoost =
    declaredKind &&
    (declaredKind === finalKind || (declaredKind === 'number' && finalKind === 'integer'))
      ? 0.1
      : declaredKind
        ? -0.1
        : 0;
  const nullPenalty = (sampleSize - nonNullCount) / Math.max(sampleSize, 1) > 0.5 ? 0.08 : 0;

  return {
    kind: finalKind,
    confidence: clampConfidence(0.25 + matchRate * 0.65 + declaredBoost - nullPenalty),
    evidence: {
      sampleSize,
      matches,
      mismatches: nonNullCount - matches,
      nulls: sampleSize - nonNullCount,
      matchRate: roundRate(matchRate),
      declaredType: declaredDataType,
      declaredKind,
      observedKinds: Object.fromEntries(ranked),
      examples: sampleExamples(observed),
    },
  };
}
