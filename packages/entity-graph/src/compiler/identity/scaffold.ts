import YAML from 'yaml';

import {
  DEFAULT_FRESHNESS_WINDOWS,
  DEFAULT_TRUST_TIER_THRESHOLDS,
  DEFAULT_TRUST_WEIGHTS,
} from '@bobsled-inc/model-spec/shared';
import {
  normalizeFieldName,
  type EntityTypeHint,
  type StandardizeRule,
} from './entity-detection.js';

export interface EntityFieldMapping {
  nameFields: string[];
  domainField?: string;
  emailField?: string;
  phoneField?: string;
  countryField?: string;
  reviewMarkers?: string[];
  standardizeRules?: StandardizeRule[];
}

export interface InputSourceConfig {
  ref: string;
  role?: 'internal' | 'provider';
  trustTier?: 'bronze' | 'silver' | 'gold';
  idFields?: string[];
}

export function scaffoldResolutionSpec(
  entityName: string,
  entityType: EntityTypeHint,
  entityMapping: EntityFieldMapping,
  inputSources: InputSourceConfig[]
): string {
  const canonicalEntity = normalizeEntityType(entityType);
  const missingDeterministicEmailReviewMarkers =
    canonicalEntity === 'person' && !entityMapping.emailField
      ? [
          'REVIEW: No email field was detected, so the deterministic email_exact_match rule was skipped.',
        ]
      : [];
  const thresholds =
    canonicalEntity === 'company'
      ? { auto_merge: 0.93, review: 0.7, auto_reject: 0.55 }
      : { auto_merge: 0.9, review: 0.65, auto_reject: 0.5 };
  const blockingRules = buildBlockingRules(canonicalEntity, entityMapping);
  const scoringFeatures = buildScoringFeatures(canonicalEntity, entityMapping);
  if (blockingRules.length === 0 || scoringFeatures.length === 0) {
    throw new Error(
      `Cannot scaffold ${normalizeSpecEntityName(entityName)}_resolution without a concrete match field.`
    );
  }
  const deterministicRules = buildDeterministicRules(canonicalEntity, entityMapping);
  const standardizeRules = deduplicateStandardizeRules([
    ...(entityMapping.standardizeRules ?? []),
    ...buildFallbackStandardizeRules(entityMapping),
  ]);
  const inferredIdFieldReviewMarkers = inputSources
    .filter((source) => (source.idFields?.length ?? 0) === 0)
    .map(
      (source) =>
        `REVIEW: No id_fields were detected for ${source.ref}; defaulting to ['id']. Confirm the real source identity columns.`
    );

  const doc = new YAML.Document({
    spec_version: '0.2',
    name: `${normalizeSpecEntityName(entityName)}_resolution`,
    type: 'resolution',
    description: `Resolve ${canonicalEntity} records discovered during agentic onboarding.`,
    inputs: inputSources.map((source) => ({
      ref: source.ref,
      ...(source.role ? { role: source.role } : {}),
      ...(source.trustTier ? { trust_tier: source.trustTier } : {}),
      id_fields: source.idFields && source.idFields.length > 0 ? source.idFields : ['id'],
    })),
    standardize: standardizeRules.map((rule) => ({
      field: rule.field,
      transforms: rule.transforms,
    })),
    blocking: {
      rules: blockingRules,
      candidate_limit: 250000,
    },
    ...(deterministicRules.length > 0 ? { deterministic_rules: deterministicRules } : {}),
    scoring: {
      method: 'weighted_features',
      features: scoringFeatures,
    },
    thresholds,
    profile: {
      attributes: buildProfileAttributes(entityMapping),
      quality: {
        freshness_windows: DEFAULT_FRESHNESS_WINDOWS.map((window) => ({ ...window })),
        source_diversity_cap: inputSources.length > 0 ? Math.min(3, inputSources.length) : 1,
        trust_weights: { ...DEFAULT_TRUST_WEIGHTS },
        trust_tier_thresholds: { ...DEFAULT_TRUST_TIER_THRESHOLDS },
      },
    },
    outputs: {
      target_schema: 'ENTITY_GRAPH',
    },
  });

  const headerComments = [
    ...(entityMapping.reviewMarkers ?? []),
    ...inferredIdFieldReviewMarkers,
    ...missingDeterministicEmailReviewMarkers,
  ].map((marker) => ` ${marker}`);
  if (headerComments.length > 0) {
    doc.commentBefore = headerComments.join('\n');
  }

  const thresholdsNode = doc.get('thresholds', true);
  if (thresholdsNode && typeof thresholdsNode === 'object') {
    (thresholdsNode as { commentBefore?: string | null }).commentBefore =
      ' REVIEW: Validate thresholds against your dataset with `bobsled model truthset tune` before production deployment.';
  }

  if (!entityMapping.domainField && canonicalEntity === 'company') {
    const blockingNode = doc.get('blocking', true);
    if (blockingNode && typeof blockingNode === 'object') {
      (blockingNode as { comment?: string | null }).comment =
        ' REVIEW: No high-selectivity domain field detected; verify the fallback blocking key.';
    }
  }
  return doc.toString();
}

function normalizeEntityType(entityType: EntityTypeHint): 'company' | 'person' {
  if (entityType === 'unknown') {
    throw new Error(
      'Cannot scaffold a resolution spec for an unknown entity type; choose person or company explicitly.'
    );
  }
  return entityType === 'person' || entityType === 'contact' ? 'person' : 'company';
}

function normalizeSpecEntityName(entityName: string): string {
  return normalizeFieldName(entityName.replace(/_resolution$/i, '')) || 'entity';
}

function buildBlockingRules(
  entityType: 'company' | 'person',
  mapping: EntityFieldMapping
): Array<{ name: string; key: string }> {
  if (entityType === 'company') {
    if (mapping.domainField) {
      return [{ name: 'exact_domain', key: `standardized_${mapping.domainField}` }];
    }
    if (mapping.nameFields[0]) {
      return [
        {
          name: 'name_prefix',
          key: `LEFT(standardized_${mapping.nameFields[0]}, 6)`,
        },
      ];
    }
    if (mapping.phoneField) {
      return [{ name: 'exact_phone', key: `standardized_${mapping.phoneField}` }];
    }
    return [];
  }

  if (mapping.emailField) {
    return [{ name: 'exact_email', key: `standardized_${mapping.emailField}` }];
  }
  if (mapping.nameFields[0]) {
    return [{ name: 'name_prefix', key: `LEFT(standardized_${mapping.nameFields[0]}, 6)` }];
  }
  if (mapping.phoneField) {
    return [{ name: 'exact_phone', key: `standardized_${mapping.phoneField}` }];
  }
  return [];
}

function buildDeterministicRules(
  entityType: 'company' | 'person',
  mapping: EntityFieldMapping
): Array<Record<string, unknown>> {
  if (entityType !== 'person' || !mapping.emailField) {
    return [];
  }

  return [
    {
      name: 'email_exact_match',
      conditions: [
        {
          field: mapping.emailField,
          operator: 'exact',
          both_not_null: true,
        },
      ],
      action: 'auto_merge',
      confidence: 1,
    },
  ];
}

function buildScoringFeatures(
  entityType: 'company' | 'person',
  mapping: EntityFieldMapping
): Array<Record<string, unknown>> {
  const features: Array<Record<string, unknown>> = [];

  if (entityType === 'company') {
    const primaryName = mapping.nameFields[0];
    if (primaryName) {
      features.push({
        field: `standardized_${primaryName}`,
        algorithm: 'jaro_winkler',
        weight: 0.45,
      });
    }
    if (mapping.domainField) {
      features.push({
        field: `standardized_${mapping.domainField}`,
        algorithm: 'exact',
        weight: 0.35,
      });
    }
    if (mapping.phoneField) {
      features.push({
        field: `standardized_${mapping.phoneField}`,
        algorithm: 'exact',
        weight: 0.2,
      });
    }
  } else {
    const nameWeight = mapping.nameFields.length > 1 ? 0.2 : 0.4;
    for (const nameField of mapping.nameFields.slice(0, 2)) {
      features.push({
        field: `standardized_${nameField}`,
        algorithm: 'jaro_winkler',
        weight: nameWeight,
      });
    }
    if (mapping.phoneField) {
      features.push({
        field: `standardized_${mapping.phoneField}`,
        algorithm: 'exact',
        weight: 0.2,
      });
    }
  }

  if (features.length === 0) {
    const fallbackField =
      entityType === 'company'
        ? (mapping.domainField ?? mapping.phoneField)
        : (mapping.emailField ?? mapping.phoneField);
    if (fallbackField) {
      features.push({
        field: `standardized_${fallbackField}`,
        algorithm: 'exact',
        weight: entityType === 'company' ? 0.45 : 0.4,
      });
    }
  }

  return features;
}

function buildFallbackStandardizeRules(mapping: EntityFieldMapping): StandardizeRule[] {
  const rules: StandardizeRule[] = [];

  for (const field of mapping.nameFields) {
    rules.push({
      field,
      transforms: ['lowercase', 'trim', 'collapse_whitespace'],
    });
  }
  if (mapping.domainField) {
    rules.push({
      field: mapping.domainField,
      transforms: ['strip_www', 'strip_protocol', 'lowercase'],
    });
  }
  if (mapping.emailField) {
    rules.push({
      field: mapping.emailField,
      transforms: ['lowercase', 'trim'],
    });
  }
  if (mapping.phoneField) {
    rules.push({
      field: mapping.phoneField,
      transforms: ['digits_only', 'strip_country_code'],
    });
  }

  return rules;
}

function buildProfileAttributes(mapping: EntityFieldMapping): Array<Record<string, unknown>> {
  const attributes: Array<Record<string, unknown>> = [];

  if (mapping.domainField) {
    attributes.push({ field: mapping.domainField });
  }
  if (mapping.emailField) {
    attributes.push({ field: mapping.emailField });
  }
  if (mapping.phoneField) {
    attributes.push({ field: mapping.phoneField });
  }
  if (mapping.countryField) {
    attributes.push({ field: mapping.countryField, alias: 'country' });
  }

  return attributes;
}

function deduplicateStandardizeRules(rules: StandardizeRule[]): StandardizeRule[] {
  const seen = new Set<string>();
  const deduplicated: StandardizeRule[] = [];

  for (const rule of rules) {
    const key = `${rule.field}:${rule.transforms.join(',')}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduplicated.push(rule);
  }

  return deduplicated;
}
