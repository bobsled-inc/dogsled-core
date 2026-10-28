import type { ProfileAnomaly, ProfileInference, ProfileScalarKind } from '../types.js';

import { nonNullValues, roundRate, sampleExamples } from './utils.js';

export interface AnomalyDetectionInput {
  values: unknown[];
  typeInference: ProfileInference<ProfileScalarKind>;
}

export function detectAnomalies(input: AnomalyDetectionInput): ProfileAnomaly[] {
  const anomalies: ProfileAnomaly[] = [];
  const nonNull = nonNullValues(input.values);

  if (input.typeInference.kind === 'mixed') {
    anomalies.push({
      type: 'mixed_types',
      severity: 'high',
      examples: sampleExamples(nonNull),
      evidence: input.typeInference.evidence,
    });
  }

  const strings = nonNull.filter((value) => typeof value === 'string') as string[];
  const alphaStrings = strings.filter((value) => /[a-z]/i.test(value));
  if (alphaStrings.length > 0) {
    let lower = 0;
    let upper = 0;
    let mixed = 0;
    for (const value of alphaStrings) {
      if (value === value.toLowerCase()) {
        lower += 1;
      } else if (value === value.toUpperCase()) {
        upper += 1;
      } else {
        mixed += 1;
      }
    }
    const casingVariance = Math.min(
      1,
      [lower, upper, mixed].filter((count) => count > 0).length / 3
    );
    if (alphaStrings.length >= 3 && casingVariance > 0.6) {
      anomalies.push({
        type: 'inconsistent_casing',
        severity: casingVariance > 0.8 ? 'medium' : 'low',
        examples: sampleExamples(alphaStrings),
        evidence: {
          sampleSize: strings.length,
          casingSampleSize: alphaStrings.length,
          lower,
          upper,
          mixed,
          casingVariance: roundRate(casingVariance),
        },
      });
    }
  }

  if (strings.length > 0) {
    const jsonLike = strings.filter((value) => {
      const trimmed = value.trim();
      const looksJson =
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'));
      if (!looksJson) return false;
      try {
        JSON.parse(trimmed);
        return true;
      } catch {
        return false;
      }
    });
    if (jsonLike.length / strings.length >= 0.5) {
      anomalies.push({
        type: 'parseable_subfields',
        severity: 'medium',
        examples: sampleExamples(jsonLike),
        evidence: {
          sampleSize: strings.length,
          parseableCount: jsonLike.length,
          parseableRate: roundRate(jsonLike.length / strings.length),
        },
      });
    }
  }

  return anomalies;
}
