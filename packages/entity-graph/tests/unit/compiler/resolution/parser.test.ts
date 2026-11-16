import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ResolutionSpecSchema } from '@bobsled-inc/model-spec';

import {
  parseResolutionSpec,
  resolveResolutionSpec,
} from '../../../../src/compiler/identity/parser.js';

describe('resolveResolutionSpec', () => {
  it('parses semantic overrides from resolution YAML and preserves them when resolving', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'entity-graph-resolution-'));
    const filePath = path.join(tmpDir, 'company_resolution.yml');
    await fs.writeFile(
      filePath,
      [
        "spec_version: '0.2'",
        'name: company_resolution',
        'type: resolution',
        'description: Resolve companies.',
        'inputs:',
        '  - ref: raw.crm_companies',
        '    id_fields: [id]',
        'standardize:',
        '  - field: company_name',
        '    transforms: [trim]',
        'deterministic_rules:',
        '  - name: exact_name',
        '    conditions:',
        '      - field: company_name',
        '        operator: exact',
        '        both_not_null: true',
        '    action: auto_merge',
        '    confidence: 1',
        'thresholds:',
        '  auto_merge: 0.95',
        '  review: 0.6',
        '  auto_reject: 0.4',
        'semantic_overrides:',
        '  company_name:',
        '    description: Canonical company display name.',
        '    semantic_role: name',
        '    pii: false',
        '    tags: [identity, mastered]',
      ].join('\n')
    );

    const parsed = parseResolutionSpec(filePath);
    const resolved = resolveResolutionSpec(
      parsed,
      new Map([['raw.crm_companies', '"RAW"."CRM_COMPANIES"']]),
      'snowflake',
      'ENTITY_GRAPH'
    );

    expect(parsed.raw.semantic_overrides?.company_name).toMatchObject({
      description: 'Canonical company display name.',
      semantic_role: 'name',
      pii: false,
      tags: ['identity', 'mastered'],
    });
    expect(resolved.semanticOverrides?.company_name?.semantic_role).toBe('name');
  });

  it('preserves the flag_for_review action when resolving deterministic rules', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'entity-graph-resolution-'));
    const filePath = path.join(tmpDir, 'company_resolution.yml');
    await fs.writeFile(
      filePath,
      [
        "spec_version: '0.2'",
        'name: company_resolution',
        'type: resolution',
        'description: Resolve companies.',
        'inputs:',
        '  - ref: raw.crm_companies',
        '    id_fields: [id]',
        'standardize:',
        '  - field: company_name',
        '    transforms: [trim]',
        'deterministic_rules:',
        '  - name: exact_name',
        '    conditions:',
        '      - field: company_name',
        '        operator: exact',
        '        both_not_null: true',
        '    action: auto_merge',
        '    confidence: 1',
        '  - name: same_name_no_domain',
        '    conditions:',
        '      - field: company_name',
        '        operator: exact',
        '        both_not_null: true',
        '    action: flag_for_review',
        '    confidence: 0.85',
        'thresholds:',
        '  auto_merge: 0.95',
        '  review: 0.6',
        '  auto_reject: 0.4',
      ].join('\n')
    );

    const parsed = parseResolutionSpec(filePath);
    const resolved = resolveResolutionSpec(
      parsed,
      new Map([['raw.crm_companies', '"RAW"."CRM_COMPANIES"']]),
      'snowflake',
      'ENTITY_GRAPH'
    );

    expect(resolved.deterministicRules.map((rule) => rule.action)).toEqual([
      'auto_merge',
      'flag_for_review',
    ]);
    expect(resolved.deterministicRules[1]?.confidence).toBe(0.85);
  });

  it('maps review thresholds and agent policy into resolved types', () => {
    const resolved = resolveResolutionSpec(
      {
        name: 'company_resolution',
        filePath: '/tmp/company_resolution.yml',
        raw: {
          spec_version: '0.2',
          name: 'company_resolution',
          type: 'resolution',
          description: 'Resolve companies.',
          pair_count_warn_limit: 100000,
          inputs: [{ ref: 'raw.crm_companies', id_fields: ['id'] }],
          standardize: [{ field: 'company_name', transforms: ['lowercase'] }],
          blocking: { rules: [{ name: 'exact_name', key: 'standardized_company_name' }] },
          deterministic_rules: [
            {
              name: 'duns_match',
              conditions: [{ field: 'duns_number', operator: 'exact', both_not_null: true }],
              action: 'auto_merge',
              confidence: 1,
            },
          ],
          thresholds: {
            auto_merge: 0.95,
            review: 0.6,
            auto_reject: 0.55,
          },
          agent_policy: {
            enabled: true,
            auto_apply_threshold: 0.81,
            max_embedding_cost_usd: 0.5,
          },
          semantic_triage: {
            provider: 'openai_text_embedding_3_small',
            fields: ['company_name', 'domain'],
            promote_to_merge_threshold: 0.94,
            promote_to_reject_threshold: 0.55,
          },
          profile: {
            display_name: {
              field: 'company_name',
              source_precedence: ['raw.crm_companies'],
            },
            attributes: [{ field: 'domain', alias: 'website' }],
            views: {
              enabled: true,
              name_pattern: '{entity}_{source_table}_golden',
              include_entity_graph_metadata: false,
            },
            activations: [
              {
                name: 'salesforce_sync',
                version: 'v1',
                trust_gate: 0.8,
                fields: [{ field: 'display_name', target: 'account_name' }],
                identity_map: {
                  source_system: 'raw.crm_companies',
                  id_alias: 'salesforce_account_id',
                },
              },
            ],
          },
        },
      },
      new Map([['raw.crm_companies', '"RAW"."CRM_COMPANIES"']]),
      'snowflake',
      'ENTITY_GRAPH'
    );

    expect(resolved.agentPolicy).toMatchObject({
      autoApplyThreshold: 0.81,
      maxEmbeddingCostUsd: 0.5,
    });
    expect(resolved.semanticTriage).toEqual({
      provider: 'openai_text_embedding_3_small',
      fields: ['company_name', 'domain'],
      promoteToMergeThreshold: 0.94,
      promoteToRejectThreshold: 0.55,
    });
    expect(resolved.pairCountWarnLimit).toBe(100000);
    expect(resolved.thresholds.review).toBe(0.6);
    expect(resolved.entityIdPolicy).toEqual({
      strategy: 'stable',
      newId: 'component_id',
      merge: 'oldest_entity_id',
      split: 'preserve_anchor',
    });
    expect(resolved.profile).toMatchObject({
      displayName: {
        field: 'company_name',
        sourcePrecedence: ['raw.crm_companies'],
      },
      attributes: [{ field: 'domain', alias: 'website' }],
      views: {
        enabled: true,
        namePattern: '{entity}_{source_table}_golden',
        includeEntityGraphMetadata: false,
      },
      activations: [
        {
          name: 'salesforce_sync',
          version: 'v1',
          trustGate: 0.8,
          identityMap: {
            sourceSystem: 'raw.crm_companies',
            idAlias: 'salesforce_account_id',
          },
        },
      ],
    });
  });

  it('maps agent_policy.reviewer into camelCase ReviewerConfig for both kinds', () => {
    interface RawHttpReviewer {
      kind: 'http';
      url: string;
      auth_token?: string;
      timeout_s?: number;
      poll_interval_s?: number;
    }
    interface RawCommandReviewer {
      kind: 'command';
      command: string;
      timeout_s?: number;
    }
    type RawReviewer = RawHttpReviewer | RawCommandReviewer;

    const base = {
      spec_version: '0.2' as const,
      name: 'company_resolution',
      type: 'resolution' as const,
      description: 'Resolve companies.',
      inputs: [{ ref: 'raw.crm_companies', id_fields: ['id'] }],
      standardize: [{ field: 'company_name', transforms: ['lowercase'] }],
      blocking: { rules: [{ name: 'exact_name', key: 'standardized_company_name' }] },
      scoring: {
        method: 'weighted_features',
        features: [{ field: 'company_name', algorithm: 'exact', weight: 1 }],
      },
      thresholds: { auto_merge: 0.95, review: 0.6, auto_reject: 0.55 },
    };
    const resolve = (reviewer: RawReviewer) =>
      resolveResolutionSpec(
        {
          name: 'company_resolution',
          filePath: '/tmp/company_resolution.yml',
          raw: ResolutionSpecSchema.parse({
            ...base,
            agent_policy: { enabled: true, reviewer },
          }),
        },
        new Map([['raw.crm_companies', '"RAW"."CRM_COMPANIES"']]),
        'snowflake',
        'ENTITY_GRAPH'
      );

    const http = resolve({
      kind: 'http',
      url: 'https://reviewer.example/review',
      auth_token: '${{ env.BOBSLED_CORE_REVIEWER_TOKEN }}',
      timeout_s: 120,
      poll_interval_s: 2,
    });
    expect(http.agentPolicy?.reviewer).toEqual({
      kind: 'http',
      url: 'https://reviewer.example/review',
      authToken: '${{ env.BOBSLED_CORE_REVIEWER_TOKEN }}',
      timeoutS: 120,
      pollIntervalS: 2,
    });

    const command = resolve({ kind: 'command', command: 'claude -p --output-format json' });
    expect(command.agentPolicy?.reviewer).toEqual({
      kind: 'command',
      command: 'claude -p --output-format json',
      timeoutS: undefined,
    });
  });

  it('maps agent_policy.judge tier into AgentPolicy and leaves it undefined when absent', () => {
    const base = {
      spec_version: '0.2' as const,
      name: 'company_resolution',
      type: 'resolution' as const,
      description: 'Resolve companies.',
      inputs: [{ ref: 'raw.crm_companies', id_fields: ['id'] }],
      blocking: { rules: [{ name: 'exact_name', key: 'standardized_company_name' }] },
      scoring: {
        method: 'weighted_features' as const,
        features: [{ field: 'company_name', algorithm: 'exact' as const, weight: 1 }],
      },
      thresholds: { auto_merge: 0.95, review: 0.6, auto_reject: 0.55 },
    };
    interface JudgePolicyInput {
      enabled: boolean;
      judge?: 'model' | 'agent';
    }
    const resolve = (agentPolicy: JudgePolicyInput) =>
      resolveResolutionSpec(
        {
          name: 'company_resolution',
          filePath: '/tmp/company_resolution.yml',
          raw: ResolutionSpecSchema.parse({ ...base, agent_policy: agentPolicy }),
        },
        new Map([['raw.crm_companies', '"RAW"."CRM_COMPANIES"']]),
        'snowflake',
        'ENTITY_GRAPH'
      );

    expect(resolve({ enabled: true, judge: 'model' }).agentPolicy?.judge).toBe('model');
    expect(resolve({ enabled: true, judge: 'agent' }).agentPolicy?.judge).toBe('agent');
    expect(resolve({ enabled: true }).agentPolicy?.judge).toBeUndefined();
  });

  it('allows resolution specs without blocking rules', () => {
    const resolved = resolveResolutionSpec(
      {
        name: 'company_resolution',
        filePath: '/tmp/company_resolution.yml',
        raw: {
          spec_version: '0.2',
          name: 'company_resolution',
          type: 'resolution',
          description: 'Resolve companies.',
          inputs: [{ ref: 'raw.crm_companies', id_fields: ['id'] }],
          standardize: [{ field: 'company_name', transforms: ['lowercase'] }],
          deterministic_rules: [
            {
              name: 'duns_match',
              conditions: [{ field: 'duns_number', operator: 'exact', both_not_null: true }],
              action: 'auto_merge',
              confidence: 1,
            },
          ],
          thresholds: {
            auto_merge: 0.95,
            review: 0.6,
            auto_reject: 0.55,
          },
        },
      },
      new Map([['raw.crm_companies', '"RAW"."CRM_COMPANIES"']]),
      'snowflake',
      'ENTITY_GRAPH'
    );

    expect(resolved.blocking).toBeUndefined();
  });

  it('rejects implicit default profile exposure of hashed fields', () => {
    expect(() =>
      resolveResolutionSpec(
        {
          name: 'person_resolution',
          filePath: '/tmp/person_resolution.yml',
          raw: {
            spec_version: '0.2',
            name: 'person_resolution',
            type: 'resolution',
            description: 'Resolve people.',
            inputs: [{ ref: 'raw.people', id_fields: ['id'] }],
            standardize: [
              { field: 'full_name', transforms: ['lowercase'] },
              { field: 'email', transforms: ['normalize_email', 'sha256'] },
            ],
            deterministic_rules: [
              {
                name: 'email_key',
                conditions: [{ field: 'email', operator: 'exact', both_not_null: true }],
                action: 'auto_merge',
                confidence: 1,
              },
            ],
            thresholds: { auto_merge: 0.95, review: 0.6, auto_reject: 0.55 },
          },
        },
        new Map([['raw.people', '"RAW"."PEOPLE"']]),
        'snowflake',
        'ENTITY_GRAPH'
      )
    ).toThrow(/without hashed: true/);
  });

  it('maps explicit stable entity ID policy fields into resolved types', () => {
    const resolved = resolveResolutionSpec(
      {
        name: 'company_resolution',
        filePath: '/tmp/company_resolution.yml',
        raw: {
          spec_version: '0.2',
          name: 'company_resolution',
          type: 'resolution',
          description: 'Resolve companies.',
          inputs: [{ ref: 'raw.crm_companies', id_fields: ['id'] }],
          standardize: [{ field: 'company_name', transforms: ['lowercase'] }],
          deterministic_rules: [
            {
              name: 'duns_match',
              conditions: [{ field: 'duns_number', operator: 'exact', both_not_null: true }],
              action: 'auto_merge',
              confidence: 1,
            },
          ],
          thresholds: {
            auto_merge: 0.95,
            review: 0.6,
            auto_reject: 0.55,
          },
          entity_id_policy: {
            strategy: 'stable',
            new_id: 'component_id',
            merge: 'oldest_entity_id',
            split: 'preserve_anchor',
          },
        },
      },
      new Map([['raw.crm_companies', '"RAW"."CRM_COMPANIES"']]),
      'snowflake',
      'ENTITY_GRAPH'
    );

    expect(resolved.entityIdPolicy).toEqual({
      strategy: 'stable',
      newId: 'component_id',
      merge: 'oldest_entity_id',
      split: 'preserve_anchor',
    });
  });
});

describe('resolveResolutionSpec auto_merge: null', () => {
  const rawBase = {
    spec_version: '0.2',
    name: 'company_resolution',
    type: 'resolution',
    description: 'Resolve companies.',
    inputs: [{ ref: 'raw.crm_companies', id_fields: ['id'] }],
    standardize: [{ field: 'company_name', transforms: ['lowercase'] }],
    blocking: { rules: [{ name: 'exact_name', key: 'standardized_company_name' }] },
    deterministic_rules: [
      {
        name: 'duns_match',
        conditions: [{ field: 'duns_number', operator: 'exact', both_not_null: true }],
        action: 'auto_merge',
        confidence: 1,
      },
    ],
  };
  const registry = new Map([['raw.crm_companies', '"RAW"."CRM_COMPANIES"']]);

  it('accepts a null auto_merge with valid review >= auto_reject ordering', () => {
    const resolved = resolveResolutionSpec(
      {
        name: 'company_resolution',
        filePath: '/tmp/company_resolution.yml',
        raw: {
          ...rawBase,
          thresholds: { auto_merge: null, review: 0.6, auto_reject: 0.4 },
        },
      },
      registry,
      'snowflake',
      'ENTITY_GRAPH'
    );
    expect(resolved.thresholds.autoMerge).toBeNull();
    expect(resolved.thresholds.review).toBe(0.6);
  });

  it('still rejects review < auto_reject when auto_merge is null', () => {
    expect(() =>
      resolveResolutionSpec(
        {
          name: 'company_resolution',
          filePath: '/tmp/company_resolution.yml',
          raw: {
            ...rawBase,
            thresholds: { auto_merge: null, review: 0.4, auto_reject: 0.6 },
          },
        },
        registry,
        'snowflake',
        'ENTITY_GRAPH'
      )
    ).toThrow(/auto_merge > review >= auto_reject/);
  });
});

describe('resolveResolutionSpec dialect fuzzy support', () => {
  const registry = new Map([['raw.crm_companies', '"RAW"."CRM_COMPANIES"']]);
  const base = {
    spec_version: '0.2',
    name: 'company_resolution',
    type: 'resolution',
    description: 'Resolve companies.',
    inputs: [{ ref: 'raw.crm_companies', id_fields: ['id'] }],
    standardize: [{ field: 'company_name', transforms: ['lowercase'] }],
    deterministic_rules: [],
    thresholds: { auto_merge: 0.95, review: 0.6, auto_reject: 0.4 },
  };

  it('rejects unsupported weighted fuzzy algorithms during resolution validation', () => {
    expect(() =>
      resolveResolutionSpec(
        {
          name: 'company_resolution',
          filePath: '/tmp/company_resolution.yml',
          raw: {
            ...base,
            scoring: {
              method: 'weighted_features',
              features: [
                { field: 'standardized_company_name', algorithm: 'jaro_winkler', weight: 1 },
              ],
            },
          },
        },
        registry,
        'redshift',
        'ENTITY_GRAPH'
      )
    ).toThrow(
      /compiler target "redshift" does not support scoring\.features\[0\]\.algorithm \(jaro_winkler\).*Supported comparators: exact, soundex, numeric_distance, date_proximity, token_cosine/s
    );
  });

  it('rejects token_cosine on MySQL during resolution validation', () => {
    expect(() =>
      resolveResolutionSpec(
        {
          name: 'company_resolution',
          filePath: '/tmp/company_resolution.yml',
          raw: {
            ...base,
            scoring: {
              method: 'weighted_features',
              features: [
                { field: 'standardized_company_name', algorithm: 'token_cosine', weight: 1 },
              ],
            },
          },
        },
        registry,
        'mysql',
        'ENTITY_GRAPH'
      )
    ).toThrow(/scoring\.features\[0\]\.algorithm \(token_cosine\)/);
  });

  it('rejects unsupported Fellegi-Sunter level ops during resolution validation', () => {
    expect(() =>
      resolveResolutionSpec(
        {
          name: 'company_resolution',
          filePath: '/tmp/company_resolution.yml',
          raw: {
            ...base,
            scoring: {
              method: 'fellegi_sunter',
              prior: 0.0001,
              comparisons: [
                {
                  field: 'standardized_company_name',
                  levels: [
                    { op: 'edit_distance', gte: 0.9, m: 0.8, u: 0.01 },
                    { op: 'else', m: 0.2, u: 0.99 },
                  ],
                },
              ],
            },
          },
        },
        registry,
        'mysql',
        'ENTITY_GRAPH'
      )
    ).toThrow(/scoring\.comparisons\[0\]\.levels\[0\]\.op \(edit_distance\)/);
  });
});
