/**
 * Resolution spec parser — parse and resolve resolution YAML specs.
 *
 * Validates specs against ResolutionSpecSchema, resolves input refs
 * to concrete warehouse table names via the source registry.
 */

import * as fs from 'node:fs';
import YAML from 'yaml';

import { ResolutionSpecSchema, collectYamlFiles, buildFqName } from '@bobsled-inc/model-spec';
import {
  DEFAULT_FRESHNESS_WINDOWS,
  DEFAULT_TRUST_WEIGHTS,
  DEFAULT_TRUST_TIER_THRESHOLDS,
} from '@bobsled-inc/model-spec/shared';
import { formatSpecValidationMessage } from '@bobsled-inc/protocol';

import type { ResolutionSpec } from '@bobsled-inc/model-spec';
import type { SupportedDialect } from '@bobsled-inc/model-spec';
import type { SourceColumnRegistry, SourceRegistry } from '@bobsled-inc/model-spec';
import { SemanticOverridesSchema } from '../entity-graph/field-metadata.js';
import { getSupportedFuzzyAlgorithms } from '../core/dialect-similarity.js';
import { resolveEffectiveProfileConfig } from './profile-config.js';
import type {
  ResolvedResolutionSpec,
  ResolvedInput,
  StandardizeTransform,
  BlockingRule,
  DeterministicRule,
  DeterministicCondition,
  ScoringFeature,
  ScoringConfig,
  FellegiSunterComparison,
  FellegiSunterLevel,
  ThresholdBands,
  AgentPolicy,
  ReviewerConfig,
  ResolvedProfileConfig,
  SemanticOverrides,
  SourceFieldMetadataRegistry,
  ResolvedEntityIdPolicy,
  FuzzyAlgorithm,
} from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedResolutionSpec {
  name: string;
  filePath: string;
  raw: EntityGraphResolutionSpec;
  warnings?: string[];
}

export type EntityGraphResolutionSpec = Omit<ResolutionSpec, 'standardize' | 'profile'> & {
  semantic_overrides?: SemanticOverrides;
  standardize: Array<{
    field: string;
    transforms: StandardizeTransform['transforms'];
    pre_hashed?: boolean;
  }>;
  profile?: Omit<NonNullable<ResolutionSpec['profile']>, 'attributes'> & {
    attributes?: Array<{
      field: string;
      alias?: string;
      hashed?: boolean;
    }>;
    pii_controls?: {
      attributes: Array<{
        field: string;
        masking: 'none' | 'hash' | 'partial' | 'null';
        classification?: string;
      }>;
    };
  };
};

function resolveProfileConfig(raw: ParsedResolutionSpec['raw']['profile']): ResolvedProfileConfig {
  return {
    displayName: raw?.display_name
      ? {
          field: raw.display_name.field,
          sourcePrecedence: raw.display_name.source_precedence,
        }
      : undefined,
    attributes:
      raw?.attributes?.map((attribute) => ({
        field: attribute.field,
        alias: attribute.alias ?? attribute.field,
        hashed: attribute.hashed,
      })) ?? [],
    quality: {
      freshnessWindows:
        raw?.quality?.freshness_windows?.map((window) => ({
          days: window.days,
          score: window.score,
        })) ??
        DEFAULT_FRESHNESS_WINDOWS.map((window) => ({
          days: window.days,
          score: window.score,
        })),
      sourceDiversityCap: raw?.quality?.source_diversity_cap ?? 3,
      trustWeights: {
        identity: raw?.quality?.trust_weights?.identity ?? DEFAULT_TRUST_WEIGHTS.identity,
        freshness: raw?.quality?.trust_weights?.freshness ?? DEFAULT_TRUST_WEIGHTS.freshness,
        diversity: raw?.quality?.trust_weights?.diversity ?? DEFAULT_TRUST_WEIGHTS.diversity,
        coverage: raw?.quality?.trust_weights?.coverage ?? DEFAULT_TRUST_WEIGHTS.coverage,
      },
      trustTierThresholds: {
        trusted:
          raw?.quality?.trust_tier_thresholds?.trusted ?? DEFAULT_TRUST_TIER_THRESHOLDS.trusted,
        monitor:
          raw?.quality?.trust_tier_thresholds?.monitor ?? DEFAULT_TRUST_TIER_THRESHOLDS.monitor,
        review: raw?.quality?.trust_tier_thresholds?.review ?? DEFAULT_TRUST_TIER_THRESHOLDS.review,
      },
    },
    activations:
      raw?.activations?.map((activation) => ({
        name: activation.name,
        version: activation.version,
        trustGate: activation.trust_gate,
        fields: activation.fields.map((field) => ({
          field: field.field,
          target: field.target,
        })),
        identityMap: activation.identity_map
          ? {
              sourceSystem: activation.identity_map.source_system,
              idAlias: activation.identity_map.id_alias,
            }
          : undefined,
      })) ?? [],
    views: raw?.views
      ? {
          enabled: raw.views.enabled,
          namePattern: raw.views.name_pattern,
          includeEntityGraphMetadata: raw.views.include_entity_graph_metadata,
        }
      : undefined,
    piiControls: raw?.pii_controls
      ? {
          attributes: raw.pii_controls.attributes.map((control) => ({
            field: control.field,
            masking: control.masking,
            classification: control.classification,
          })),
        }
      : undefined,
  };
}

function resolveEntityIdPolicy(
  raw: ParsedResolutionSpec['raw']['entity_id_policy']
): ResolvedEntityIdPolicy {
  return {
    strategy: raw?.strategy ?? 'stable',
    newId: raw?.new_id ?? 'component_id',
    merge: raw?.merge ?? 'oldest_entity_id',
    split: raw?.split ?? 'preserve_anchor',
  };
}

function resolveReviewerConfig(
  raw: NonNullable<ParsedResolutionSpec['raw']['agent_policy']>['reviewer']
): ReviewerConfig | undefined {
  if (!raw) return undefined;
  if (raw.kind === 'http') {
    return {
      kind: 'http',
      url: raw.url,
      authToken: raw.auth_token,
      timeoutS: raw.timeout_s,
      pollIntervalS: raw.poll_interval_s,
    };
  }
  return {
    kind: 'command',
    command: raw.command,
    timeoutS: raw.timeout_s,
  };
}

const HASH_STANDARDIZE_TRANSFORMS = new Set(['sha256', 'hmac_sha256']);

function hashedStandardizeFields(standardize: StandardizeTransform[]): Set<string> {
  const fields = new Set<string>();
  for (const transform of standardize) {
    if (
      transform.preHashed ||
      transform.transforms.some((step) => HASH_STANDARDIZE_TRANSFORMS.has(step))
    ) {
      fields.add(transform.field);
      fields.add(`standardized_${transform.field}`);
    }
  }
  return fields;
}

function fieldIsHashed(fields: Set<string>, field: string): boolean {
  return fields.has(field) || fields.has(field.replace(/^standardized_/, ''));
}

function validateHashedFieldUsage(spec: ResolvedResolutionSpec): void {
  const hashedFields = hashedStandardizeFields(spec.standardize);
  if (hashedFields.size === 0) return;

  for (const rule of spec.deterministicRules) {
    for (const condition of rule.conditions) {
      if (fieldIsHashed(hashedFields, condition.field) && condition.operator !== 'exact') {
        throw new Error(
          `Resolution "${spec.name}" hashes field "${condition.field}" but deterministic rules on hashed fields must use exact matching.`
        );
      }
    }
  }

  if (spec.scoring?.method === 'weighted_features') {
    for (const feature of spec.scoring.features) {
      if (fieldIsHashed(hashedFields, feature.field) && feature.algorithm !== 'exact') {
        throw new Error(
          `Resolution "${spec.name}" hashes field "${feature.field}" but hashed scoring features must use algorithm: exact.`
        );
      }
    }
  } else if (spec.scoring?.method === 'fellegi_sunter') {
    for (const comparison of spec.scoring.comparisons) {
      if (!fieldIsHashed(hashedFields, comparison.field)) continue;
      for (const level of comparison.levels) {
        if (level.op !== 'exact' && level.op !== 'else') {
          throw new Error(
            `Resolution "${spec.name}" hashes field "${comparison.field}" but hashed Fellegi-Sunter levels must be exact or else.`
          );
        }
      }
    }
  }

  for (const field of spec.semanticTriage?.fields ?? []) {
    if (fieldIsHashed(hashedFields, field)) {
      throw new Error(
        `Resolution "${spec.name}" hashes field "${field}" and cannot use it for semantic triage.`
      );
    }
  }

  const profile = resolveEffectiveProfileConfig(spec);
  if (profile.displayName && fieldIsHashed(hashedFields, profile.displayName.field)) {
    throw new Error(
      `Resolution "${spec.name}" hashes field "${profile.displayName.field}" and cannot use it as profile.display_name.`
    );
  }
  for (const attribute of profile.attributes) {
    if (fieldIsHashed(hashedFields, attribute.field) && attribute.hashed !== true) {
      throw new Error(
        `Resolution "${spec.name}" profile attribute "${attribute.alias}" exposes hashed field "${attribute.field}" without hashed: true.`
      );
    }
  }
}

function validateDialectFuzzySupport(
  raw: ParsedResolutionSpec['raw'],
  dialect: SupportedDialect,
  filePath: string
): void {
  const supported = getSupportedFuzzyAlgorithms(dialect);
  const supportedSet = new Set<FuzzyAlgorithm>(supported);
  const unsupported: string[] = [];

  if (raw.scoring?.method === 'weighted_features') {
    raw.scoring.features.forEach((feature, index) => {
      if (!supportedSet.has(feature.algorithm)) {
        unsupported.push(`scoring.features[${index}].algorithm (${feature.algorithm})`);
      }
    });
  } else if (raw.scoring?.method === 'fellegi_sunter') {
    raw.scoring.comparisons.forEach((comparison, comparisonIndex) => {
      comparison.levels.forEach((level, levelIndex) => {
        if (level.op !== 'else' && !supportedSet.has(level.op)) {
          unsupported.push(
            `scoring.comparisons[${comparisonIndex}].levels[${levelIndex}].op (${level.op})`
          );
        }
      });
    });
  }

  if (unsupported.length === 0) return;

  throw new Error(
    `Invalid resolution spec ${filePath}: compiler target "${dialect}" does not support ${unsupported.join(
      ', '
    )}. Supported comparators: ${supported.join(', ')}.`
  );
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse and Zod-validate a single resolution spec file.
 * Throws on invalid YAML or schema violations.
 */
function parseResolutionSpecFromRaw(filePath: string, raw: unknown): ParsedResolutionSpec {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid YAML in ${filePath}`);
  }

  const rawObj = raw as Record<string, unknown>;
  if (rawObj.type !== 'resolution') {
    throw new Error(`${filePath} is not a resolution spec (type: ${String(rawObj.type)})`);
  }

  const parsed = ResolutionSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      formatSpecValidationMessage('resolution', filePath, parsed.error, {
        schema: ResolutionSpecSchema,
      })
    );
  }

  const overrides = SemanticOverridesSchema.safeParse(rawObj.semantic_overrides);
  if (!overrides.success) {
    // Issues sit under `semantic_overrides` because we feed it the nested
    // value directly, not the full spec; re-prefix the paths so the user
    // sees the YAML-level field name.
    const rebased = {
      ...overrides.error,
      issues: overrides.error.issues.map((i) => ({
        ...i,
        path: ['semantic_overrides', ...i.path],
      })),
    } as typeof overrides.error;
    throw new Error(
      formatSpecValidationMessage('resolution', filePath, rebased, {
        schema: SemanticOverridesSchema,
      })
    );
  }

  const warnings: string[] = [];

  if (rawObj.agent_policy && typeof rawObj.agent_policy === 'object') {
    const agentPolicy = rawObj.agent_policy as Record<string, unknown>;
    if ('cost_ceiling_usd' in agentPolicy) {
      warnings.push(
        `${filePath}: agent_policy.cost_ceiling_usd is deprecated, use max_cost_usd instead`
      );
    }
  }

  return {
    name: parsed.data.name,
    filePath,
    raw: {
      ...parsed.data,
      ...(overrides.data !== undefined ? { semantic_overrides: overrides.data } : {}),
    },
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export function parseResolutionSpec(filePath: string): ParsedResolutionSpec {
  const content = fs.readFileSync(filePath, 'utf-8');
  const raw: unknown = YAML.parse(content);
  return parseResolutionSpecFromRaw(filePath, raw);
}

/**
 * Scan a directory for resolution spec YAML files.
 * Returns all valid specs; throws on the first invalid one.
 */
export function discoverResolutionSpecs(entityGraphDir: string): ParsedResolutionSpec[] {
  const specs: ParsedResolutionSpec[] = [];

  if (!fs.existsSync(entityGraphDir)) return specs;

  const yamlFiles = collectYamlFiles(entityGraphDir);

  for (const filePath of yamlFiles) {
    // Only parse resolution specs
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const raw: unknown = YAML.parse(content);
      if (
        !raw ||
        typeof raw !== 'object' ||
        (raw as Record<string, unknown>).type !== 'resolution'
      ) {
        continue;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse resolution spec ${filePath}: ${msg}`);
    }

    specs.push(parseResolutionSpec(filePath));
  }

  return specs;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a parsed spec to a fully resolved spec with concrete table names.
 *
 * Input refs like "sources.crm_companies" resolve via the source registry.
 * Aliases are assigned sequentially: s0, s1, s2, etc.
 */
export function resolveResolutionSpec(
  parsed: ParsedResolutionSpec,
  sourceRegistry: SourceRegistry,
  dialect: SupportedDialect,
  targetSchema: string,
  columnRegistry?: SourceColumnRegistry,
  fieldMetadataRegistry?: SourceFieldMetadataRegistry
): ResolvedResolutionSpec {
  const raw = parsed.raw;
  validateDialectFuzzySupport(raw, dialect, parsed.filePath);

  // Derive entity name: strip '_resolution' suffix if present
  const entity = raw.name.replace(/_resolution$/, '');

  // Resolve inputs
  const inputs: ResolvedInput[] = raw.inputs.map((input, index) => {
    const ref = input.ref;
    const alias = `s${index}`;

    // Try to resolve via source registry
    // Ref format: "connection.source_name" for sources
    let fqTableName: string;
    const sourceFqName = sourceRegistry.get(ref);
    if (sourceFqName) {
      fqTableName = sourceFqName;
    } else {
      // Fallback: treat ref as a direct table reference
      // Split on dot and use as schema.table or just table
      const parts = ref.split('.');
      if (parts.length >= 2) {
        fqTableName = buildFqName(parts.slice(0, -1).join('.'), parts[parts.length - 1]!, dialect);
      } else {
        fqTableName = buildFqName(targetSchema, ref, dialect);
      }
    }

    const sourceColumns = columnRegistry?.get(ref);
    const sourceFieldMetadata = fieldMetadataRegistry?.get(ref);

    return {
      ref,
      fqTableName,
      alias,
      role: input.role,
      trustTier: input.trust_tier,
      idFields: input.id_fields,
      ...(sourceColumns !== undefined ? { sourceColumns } : {}),
      ...(sourceFieldMetadata !== undefined ? { sourceFieldMetadata } : {}),
    };
  });

  // Map standardize transforms
  const standardize: StandardizeTransform[] = raw.standardize.map((s) => ({
    field: s.field,
    transforms: [...s.transforms],
    preHashed: s.pre_hashed,
  }));

  // Map blocking rules
  const blockingRules: BlockingRule[] =
    raw.blocking?.rules.map((r) => ({
      name: r.name,
      key: r.key,
    })) ?? [];

  // Map deterministic rules
  const deterministicRules: DeterministicRule[] = raw.deterministic_rules.map((r) => ({
    name: r.name,
    conditions: r.conditions.map((c): DeterministicCondition => ({
      field: c.field,
      operator: c.operator,
      bothNotNull: c.both_not_null,
    })),
    action: r.action,
    confidence: r.confidence,
  }));

  // Map scoring config (discriminated on method)
  let scoring: ScoringConfig | undefined;
  if (raw.scoring?.method === 'fellegi_sunter') {
    scoring = {
      method: 'fellegi_sunter',
      prior: raw.scoring.prior,
      comparisons: raw.scoring.comparisons.map((c): FellegiSunterComparison => ({
        field: c.field,
        levels: c.levels.map((l): FellegiSunterLevel => ({
          op: l.op,
          ...(l.gte !== undefined ? { gte: l.gte } : {}),
          m: l.m,
          u: l.u,
        })),
      })),
    };
  } else if (raw.scoring) {
    scoring = {
      method: 'weighted_features',
      features: raw.scoring.features.map((f): ScoringFeature => ({
        field: f.field,
        algorithm: f.algorithm,
        weight: f.weight,
      })),
    };
  }

  // Map thresholds
  const thresholds: ThresholdBands = {
    autoMerge: raw.thresholds.auto_merge,
    review: raw.thresholds.review,
    autoReject: raw.thresholds.auto_reject,
  };
  const thresholdsOrdered =
    thresholds.autoMerge === null
      ? thresholds.review >= thresholds.autoReject
      : thresholds.autoMerge > thresholds.review && thresholds.review >= thresholds.autoReject;
  if (!thresholdsOrdered) {
    throw new Error(
      `Invalid resolution spec ${parsed.filePath}: thresholds must satisfy auto_merge > review >= auto_reject (auto_merge: null disables score-driven auto-merge)`
    );
  }

  // Map agent policy
  const agentPolicy: AgentPolicy | undefined = raw.agent_policy
    ? {
        enabled: raw.agent_policy.enabled,
        instructionsPath: raw.agent_policy.instructions_path,
        approvalPolicy: raw.agent_policy.approval_policy,
        maxPairsPerRun: raw.agent_policy.max_pairs_per_run,
        maxCostUsd: raw.agent_policy.max_cost_usd,
        batchSize: raw.agent_policy.batch_size,
        tokenBudgetPerPair: raw.agent_policy.token_budget_per_pair,
        contextFields: raw.agent_policy.context_fields,
        confirmBeforeWrite: raw.agent_policy.confirm_before_write,
        legacyModel: raw.agent_policy.model,
        promptTemplate: raw.agent_policy.prompt_template,
        autoApplyThreshold: raw.agent_policy.auto_apply_threshold,
        agentConfidenceFloor: raw.agent_policy.agent_confidence_floor,
        maxEmbeddingCostUsd: raw.agent_policy.max_embedding_cost_usd,
        panel: raw.agent_policy.panel?.enabled
          ? {
              enabled: true,
              mode: raw.agent_policy.panel.mode,
              firstPanel: raw.agent_policy.panel.first_panel,
              resolutionPanel: raw.agent_policy.panel.resolution_panel,
              consensus: raw.agent_policy.panel.consensus,
              onUnresolved: raw.agent_policy.panel.on_unresolved,
              unanimousConfidence: raw.agent_policy.panel.unanimous_confidence,
              resolutionConfidence: raw.agent_policy.panel.resolution_confidence,
            }
          : undefined,
        reviewer: resolveReviewerConfig(raw.agent_policy.reviewer),
        judge: raw.agent_policy.judge,
      }
    : undefined;

  const profile = raw.profile ? resolveProfileConfig(raw.profile) : undefined;
  const semanticTriage = raw.semantic_triage
    ? {
        provider: raw.semantic_triage.provider,
        ...(raw.semantic_triage.model ? { model: raw.semantic_triage.model } : {}),
        ...(raw.semantic_triage.dimensions ? { dimensions: raw.semantic_triage.dimensions } : {}),
        ...(raw.semantic_triage.price_per_million_tokens_usd !== undefined
          ? { pricePerMillionTokensUsd: raw.semantic_triage.price_per_million_tokens_usd }
          : {}),
        fields: [...raw.semantic_triage.fields],
        promoteToMergeThreshold: raw.semantic_triage.promote_to_merge_threshold,
        promoteToRejectThreshold: raw.semantic_triage.promote_to_reject_threshold,
      }
    : undefined;

  const resolved: ResolvedResolutionSpec = {
    name: raw.name,
    entity,
    description: raw.description,
    inputs,
    standardize,
    semanticOverrides: raw.semantic_overrides,
    semanticTriage,
    blocking:
      raw.blocking == null
        ? undefined
        : {
            rules: blockingRules,
            candidateLimit: raw.blocking.candidate_limit,
          },
    deterministicRules,
    scoring,
    thresholds,
    entityIdPolicy: resolveEntityIdPolicy(raw.entity_id_policy),
    agentPolicy,
    entitySemantics: raw.entity_semantics
      ? {
          ...(raw.entity_semantics.definition
            ? { definition: raw.entity_semantics.definition }
            : {}),
          ...(raw.entity_semantics.categories
            ? { categories: raw.entity_semantics.categories.map((c) => ({ ...c })) }
            : {}),
          ...(raw.entity_semantics.positive_examples
            ? { positiveExamples: [...raw.entity_semantics.positive_examples] }
            : {}),
          ...(raw.entity_semantics.negative_examples
            ? { negativeExamples: [...raw.entity_semantics.negative_examples] }
            : {}),
        }
      : undefined,
    profile,
    targetSchema: raw.outputs?.target_schema ?? targetSchema,
    pairCountWarnLimit: raw.pair_count_warn_limit,
  };
  validateHashedFieldUsage(resolved);
  return resolved;
}
