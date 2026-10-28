import type {
  ResolvedDisplayName,
  ResolvedProfileAttribute,
  ResolvedProfileConfig,
  ResolvedResolutionSpec,
} from './types.js';
import {
  DEFAULT_FRESHNESS_WINDOWS,
  DEFAULT_TRUST_WEIGHTS,
  DEFAULT_TRUST_TIER_THRESHOLDS,
} from '@bobsled-inc/model-spec/shared';

const ENTITY_PROFILE_TOP_LEVEL_FIELDS = new Set([
  'entity_type',
  'entity_id',
  'cluster_id',
  'canonical_name',
  'display_name',
  'profile_attrs',
  'confidence',
  'freshness_age_seconds',
  'source_diversity',
  'profile_coverage',
  'last_seen_at',
  'lineage_run_id',
  'version',
]);

function defaultDisplayName(spec: ResolvedResolutionSpec): ResolvedDisplayName | undefined {
  const [firstField] = spec.standardize;
  if (!firstField) {
    return undefined;
  }
  return { field: firstField.field };
}

function defaultAttributes(spec: ResolvedResolutionSpec): ResolvedProfileAttribute[] {
  const [, ...rest] = spec.standardize;
  return rest.map((transform) => ({
    field: transform.field,
    alias: transform.field,
  }));
}

export function resolveEffectiveProfileConfig(spec: ResolvedResolutionSpec): ResolvedProfileConfig {
  return {
    displayName: spec.profile?.displayName ?? defaultDisplayName(spec),
    attributes:
      spec.profile?.attributes != null && spec.profile.attributes.length > 0
        ? spec.profile.attributes
        : defaultAttributes(spec),
    quality: {
      freshnessWindows:
        spec.profile?.quality.freshnessWindows != null &&
        spec.profile.quality.freshnessWindows.length > 0
          ? spec.profile.quality.freshnessWindows
          : [...DEFAULT_FRESHNESS_WINDOWS],
      sourceDiversityCap: spec.profile?.quality.sourceDiversityCap ?? 3,
      trustWeights: {
        identity: spec.profile?.quality.trustWeights.identity ?? DEFAULT_TRUST_WEIGHTS.identity,
        freshness: spec.profile?.quality.trustWeights.freshness ?? DEFAULT_TRUST_WEIGHTS.freshness,
        diversity: spec.profile?.quality.trustWeights.diversity ?? DEFAULT_TRUST_WEIGHTS.diversity,
        coverage: spec.profile?.quality.trustWeights.coverage ?? DEFAULT_TRUST_WEIGHTS.coverage,
      },
      trustTierThresholds: {
        trusted:
          spec.profile?.quality.trustTierThresholds?.trusted ??
          DEFAULT_TRUST_TIER_THRESHOLDS.trusted,
        monitor:
          spec.profile?.quality.trustTierThresholds?.monitor ??
          DEFAULT_TRUST_TIER_THRESHOLDS.monitor,
        review:
          spec.profile?.quality.trustTierThresholds?.review ?? DEFAULT_TRUST_TIER_THRESHOLDS.review,
      },
    },
    activations: spec.profile?.activations ?? [],
    views: spec.profile?.views,
    piiControls: spec.profile?.piiControls,
  };
}

export function resolveStandardizedColumnName(spec: ResolvedResolutionSpec, field: string): string {
  const standardizedFields = new Set(spec.standardize.map((transform) => transform.field));
  return standardizedFields.has(field) ? `standardized_${field}` : field;
}

export function isEntityProfileTopLevelField(field: string): boolean {
  return ENTITY_PROFILE_TOP_LEVEL_FIELDS.has(field);
}
