import { describe, expect, it } from 'vitest';

import { SeedSpecSchema, ResolutionSpecSchema } from '@bobsled-inc/model-spec';
import { SurvivorshipSpecSchema } from '../../../../src/compiler/survivorship/schema.js';

// ---------------------------------------------------------------------------
// SeedSpecSchema
// ---------------------------------------------------------------------------

describe('SeedSpecSchema', () => {
  const validSeed = {
    spec_version: '0.2',
    name: 'legal_suffixes',
    type: 'seed',
    payload: { format: 'csv', path: 'data/legal_suffixes.csv' },
    schema: {
      columns: [
        { name: 'suffix', type: 'STRING', primary_key: true },
        { name: 'normalized_form', type: 'STRING' },
      ],
    },
  };

  it('parses a valid seed spec', () => {
    const result = SeedSpecSchema.safeParse(validSeed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('legal_suffixes');
      expect(result.data.payload.delimiter).toBe(',');
      expect(result.data.materialization.on_conflict).toBe('replace');
    }
  });

  it('rejects seed with no columns', () => {
    const result = SeedSpecSchema.safeParse({
      ...validSeed,
      schema: { columns: [] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects seed with invalid name', () => {
    const result = SeedSpecSchema.safeParse({
      ...validSeed,
      name: '123-invalid',
    });
    expect(result.success).toBe(false);
  });

  it('applies default materialization', () => {
    const result = SeedSpecSchema.safeParse(validSeed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.materialization.type).toBe('table');
      expect(result.data.materialization.on_conflict).toBe('replace');
    }
  });
});

// ---------------------------------------------------------------------------
// ResolutionSpecSchema
// ---------------------------------------------------------------------------

describe('ResolutionSpecSchema', () => {
  const validResolution = {
    spec_version: '0.2',
    name: 'company_resolution',
    type: 'resolution',
    description: 'Resolve company entities.',
    inputs: [{ ref: 'sources.crm_companies', role: 'internal', id_fields: ['id'] }],
    blocking: {
      rules: [{ name: 'exact_domain', key: 'domain' }],
    },
    deterministic_rules: [
      {
        name: 'duns_match',
        conditions: [{ field: 'duns_number', operator: 'exact' }],
        action: 'auto_merge',
        confidence: 1.0,
      },
    ],
    thresholds: {
      auto_merge: 0.92,
      review: 0.55,
      auto_reject: 0.55,
    },
  };

  it('parses a valid resolution spec', () => {
    const result = ResolutionSpecSchema.safeParse(validResolution);
    expect(result.success).toBe(true);
  });

  it('parses a deterministic rule with action flag_for_review', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...validResolution,
      deterministic_rules: [
        ...validResolution.deterministic_rules,
        {
          name: 'same_name_no_domain',
          conditions: [{ field: 'company_name', operator: 'exact' }],
          action: 'flag_for_review',
          confidence: 0.85,
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.deterministic_rules[1]?.action).toBe('flag_for_review');
    }
  });

  it('accepts optional entity semantics for mention disambiguation', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...validResolution,
      entity_semantics: {
        definition: 'External customer account served by the business.',
        categories: [
          {
            name: 'design_partner',
            description: 'External account used for roadmap feedback.',
          },
        ],
        positive_examples: ['Initech', 'Globex AI data'],
        negative_examples: ['MCP', 'API', 'internal tools'],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entity_semantics?.negative_examples).toContain('MCP');
    }
  });

  it('rejects when auto_merge <= review', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...validResolution,
      thresholds: { auto_merge: 0.55, review: 0.55, auto_reject: 0.55 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message.includes('auto_merge must be > review'))
      ).toBe(true);
    }
  });

  it('rejects when review < auto_reject', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...validResolution,
      thresholds: { auto_merge: 0.92, review: 0.5, auto_reject: 0.55 },
    });
    expect(result.success).toBe(false);
  });

  it('accepts when review == auto_reject', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...validResolution,
      thresholds: { auto_merge: 0.92, review: 0.55, auto_reject: 0.55 },
    });
    expect(result.success).toBe(true);
  });

  it('accepts legacy agent_review threshold band key', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...validResolution,
      thresholds: {
        auto_merge: 0.92,
        agent_review: 0.55,
        auto_reject: 0.55,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.thresholds.review).toBe(0.55);
    }
  });

  it('rejects legacy human_review threshold band key', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...validResolution,
      thresholds: {
        auto_merge: 0.92,
        human_review: 0.55,
        auto_reject: 0.55,
      },
    });

    expect(result.success).toBe(false);
  });

  it('accepts when blocking is omitted', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...validResolution,
      blocking: undefined,
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty blocking rules when candidate_limit is set', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...validResolution,
      blocking: {
        rules: [],
        candidate_limit: 5000,
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts pair_count_warn_limit when set', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...validResolution,
      pair_count_warn_limit: 250000,
    });
    expect(result.success).toBe(true);
  });

  it('accepts explicit stable entity ID policy fields', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...validResolution,
      entity_id_policy: {
        strategy: 'stable',
        new_id: 'component_id',
        merge: 'oldest_entity_id',
        split: 'preserve_anchor',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects unsupported entity ID policy strategies', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...validResolution,
      entity_id_policy: { strategy: 'stable_uuid' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects when no matching rules provided', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...validResolution,
      deterministic_rules: [],
      scoring: undefined,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.message.includes('At least one deterministic rule'))
      ).toBe(true);
    }
  });

  it('accepts with scoring only (no deterministic rules)', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...validResolution,
      deterministic_rules: [],
      scoring: {
        method: 'weighted_features',
        features: [{ field: 'name', algorithm: 'jaro_winkler', weight: 1.0 }],
      },
    });
    expect(result.success).toBe(true);
  });

  it('validates agent_policy fields', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...validResolution,
      agent_policy: {
        enabled: true,
        model: 'claude-sonnet-4',
        max_pairs_per_run: 5000,
        max_cost_usd: 50.0,
        batch_size: 100,
        auto_apply_threshold: 0.8,
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts profile configuration for entity serving and activations', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...validResolution,
      profile: {
        display_name: {
          field: 'company_name',
          source_precedence: ['sources.crm_companies'],
        },
        attributes: [{ field: 'domain' }, { field: 'industry', alias: 'segment' }],
        quality: {
          freshness_windows: [
            { days: 1, score: 1 },
            { days: 7, score: 0.8 },
          ],
          source_diversity_cap: 4,
          trust_weights: {
            identity: 0.5,
            freshness: 0.2,
            diversity: 0.2,
            coverage: 0.1,
          },
        },
        activations: [
          {
            name: 'salesforce_sync',
            version: 'v1',
            trust_gate: 0.8,
            fields: [
              { field: 'display_name', target: 'account_name' },
              { field: 'domain', target: 'website' },
            ],
            identity_map: {
              source_system: 'sources.crm_companies',
              id_alias: 'salesforce_account_id',
            },
          },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects dangerous blocking key expression', () => {
    const result = ResolutionSpecSchema.safeParse({
      ...validResolution,
      blocking: {
        rules: [{ name: 'bad_rule', key: 'DROP TABLE foo' }],
      },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SurvivorshipSpecSchema
// ---------------------------------------------------------------------------

describe('SurvivorshipSpecSchema', () => {
  it('parses a valid survivorship spec', () => {
    const result = SurvivorshipSpecSchema.safeParse({
      spec_version: '0.2',
      name: 'company_survivorship',
      type: 'survivorship',
      description: 'Company golden record rules.',
      resolution_ref: 'company_resolution',
      attribute_rules: [
        { attribute: 'company_name', strategy: 'source_priority', source_order: ['crm', 'zi'] },
        { attribute: 'domain', strategy: 'recency', timestamp_field: 'updated_at' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('parses a survivorship spec without attribute_rules', () => {
    const result = SurvivorshipSpecSchema.safeParse({
      spec_version: '0.2',
      name: 'company_survivorship',
      type: 'survivorship',
      description: 'Rules.',
      resolution_ref: 'company_resolution',
      default_timestamp_field: 'updated_at',
    });
    expect(result.success).toBe(true);
  });

  it('parses a survivorship spec with an empty attribute_rules array', () => {
    const result = SurvivorshipSpecSchema.safeParse({
      spec_version: '0.2',
      name: 'company_survivorship',
      type: 'survivorship',
      description: 'Rules.',
      resolution_ref: 'company_resolution',
      default_timestamp_field: 'updated_at',
      attribute_rules: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid recency timestamp fields', () => {
    const result = SurvivorshipSpecSchema.safeParse({
      spec_version: '0.2',
      name: 'company_survivorship',
      type: 'survivorship',
      description: 'Rules.',
      resolution_ref: 'company_resolution',
      entity_id_policy: { strategy: 'stable_uuid' },
      attribute_rules: [
        {
          attribute: 'domain',
          strategy: 'recency',
          timestamp_field: 'updated_at DESC',
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
