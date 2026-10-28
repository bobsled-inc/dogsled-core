import type { ProfileFormatKind, ProfileInference } from '../types.js';

import {
  clampConfidence,
  nonNullValues,
  roundRate,
  sampleExamples,
  stringifyValue,
} from './utils.js';

type ConcreteFormat = Exclude<ProfileFormatKind, 'mixed' | null>;

const FORMAT_PATTERNS: Record<ConcreteFormat, RegExp> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  phone: /^\+?[\d().\-\s]{7,}$/,
  url: /^(https?:\/\/|www\.)[^\s]+\.[^\s]+$/i,
  iso8601: /^\d{4}-\d{2}-\d{2}(?:[tT ][0-9:.+-]+(?:Z|[+-]\d{2}:?\d{2})?)?$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
};

export function inferFormat(values: unknown[]): ProfileInference<ProfileFormatKind> {
  const stringValues = nonNullValues(values).filter(
    (value) => typeof value === 'string'
  ) as string[];
  const sampleSize = values.length;
  const candidateCount = stringValues.length;

  if (candidateCount === 0) {
    return {
      kind: null,
      confidence: 0.75,
      evidence: { sampleSize, matches: 0, mismatches: 0, examples: [] },
    };
  }

  const counts = new Map<ConcreteFormat, number>();
  for (const [kind, pattern] of Object.entries(FORMAT_PATTERNS) as Array<
    [ConcreteFormat, RegExp]
  >) {
    const matches = stringValues.filter((value) => pattern.test(value.trim())).length;
    if (matches > 0) counts.set(kind, matches);
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [topKind, topMatches] = ranked[0] ?? [null, 0];
  const topRate = topMatches / candidateCount;
  const totalFormatMatches = stringValues.filter((value) =>
    Object.values(FORMAT_PATTERNS).some((pattern) => pattern.test(value.trim()))
  ).length;
  const coverage = totalFormatMatches / candidateCount;

  if (!topKind || (topRate < 0.4 && coverage < 0.8)) {
    return {
      kind: null,
      confidence: clampConfidence(1 - topRate),
      evidence: {
        sampleSize,
        matches: 0,
        mismatches: candidateCount,
        matchRate: 0,
        examples: sampleExamples(stringValues),
      },
    };
  }

  const kind: ProfileFormatKind =
    topRate >= 0.8 ? topKind : coverage >= 0.8 && ranked.length > 1 ? 'mixed' : topKind;
  const matches = kind === 'mixed' ? totalFormatMatches : topMatches;
  const matchRate = matches / candidateCount;
  const mismatches = stringValues.filter((value) =>
    kind === 'mixed'
      ? !Object.values(FORMAT_PATTERNS).some((pattern) => pattern.test(value.trim()))
      : !FORMAT_PATTERNS[topKind].test(value.trim())
  );

  return {
    kind,
    confidence: clampConfidence(matchRate),
    evidence: {
      sampleSize,
      matches,
      mismatches: candidateCount - matches,
      matchRate: roundRate(matchRate),
      observedFormats: Object.fromEntries(ranked),
      examples: sampleExamples(
        stringValues.filter((value) => FORMAT_PATTERNS[topKind].test(value.trim()))
      ),
      mismatchExamples: sampleExamples(mismatches.map((value) => stringifyValue(value))),
    },
  };
}
