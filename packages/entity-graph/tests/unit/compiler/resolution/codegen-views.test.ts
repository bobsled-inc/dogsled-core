import { describe, expect, it } from 'vitest';

import { compileResolutionProfile } from '../../../../src/compiler/identity/codegen.js';
import {
  DEFAULT_INCLUDE_ENTITY_GRAPH_METADATA,
  DEFAULT_VIEW_NAME_PATTERN,
  generateCleanViewsSql,
  resolveCleanViewName,
  resolveEffectiveViewsConfig,
} from '../../../../src/compiler/identity/codegen-views.js';

import type {
  ResolvedProfileConfig,
  ResolvedResolutionSpec,
} from '../../../../src/compiler/identity/types.js';

const PROFILE: ResolvedProfileConfig = {
  displayName: {
    field: 'company_name',
    sourcePrecedence: ['revops.salesforce_accounts'],
  },
  attributes: [{ field: 'billing_country', alias: 'hq_country' }],
  quality: {
    freshnessWindows: [{ days: 7, score: 0.8 }],
    sourceDiversityCap: 3,
    trustWeights: {
      identity: 0.4,
      freshness: 0.25,
      diversity: 0.2,
      coverage: 0.15,
    },
    trustTierThresholds: {
      trusted: 0.85,
      monitor: 0.6,
      review: 0.4,
    },
  },
  activations: [],
};

const SPEC: ResolvedResolutionSpec = {
  name: 'company_resolution',
  entity: 'company',
  description: 'Resolve companies.',
  inputs: [
    {
      ref: 'revops.salesforce_accounts',
      fqTableName: 'RAW.SALESFORCE_ACCOUNTS',
      alias: 's0',
      role: 'internal',
      trustTier: 'gold',
      idFields: ['salesforce_account_id'],
      sourceColumns: ['salesforce_account_id', 'company_name', 'billing_country', 'notes'],
    },
    {
      ref: 'marketing.enrichment_vendor_companies',
      fqTableName: 'RAW.ENRICHMENT_VENDOR_COMPANIES',
      alias: 's1',
      role: 'provider',
      trustTier: 'silver',
      idFields: ['enrichment_vendor_company_id'],
    },
  ],
  standardize: [
    {
      field: 'company_name',
      transforms: ['lowercase'],
    },
    {
      field: 'billing_country',
      transforms: ['lowercase'],
    },
  ],
  blocking: {
    rules: [{ name: 'exact_name', key: 'standardized_company_name' }],
  },
  deterministicRules: [
    {
      name: 'exact_name',
      conditions: [{ field: 'company_name', operator: 'exact', bothNotNull: true }],
      action: 'auto_merge',
      confidence: 1,
    },
  ],
  thresholds: {
    autoMerge: 0.95,
    review: 0.6,
    autoReject: 0.55,
  },
  entityIdPolicy: {
    strategy: 'stable',
    newId: 'component_id',
    merge: 'oldest_entity_id',
    split: 'preserve_anchor',
  },
  targetSchema: 'ENTITY_GRAPH',
};

describe('resolveCleanViewName', () => {
  it('replaces source_table and entity placeholders', () => {
    expect(
      resolveCleanViewName(
        'revops.salesforce_accounts',
        'company',
        '{entity}_{source_table}_golden'
      )
    ).toBe('company_salesforce_accounts_golden');
  });

  it('treats $1 in the source table segment as a literal, not a regex backreference', () => {
    expect(resolveCleanViewName('raw.$1_table', 'company', '{source_table}_clean')).toBe(
      '$1_table_clean'
    );
  });
});

describe('resolveEffectiveViewsConfig', () => {
  it('returns null when no profile is configured', () => {
    expect(resolveEffectiveViewsConfig(SPEC)).toBeNull();
  });

  it('returns null when views are disabled', () => {
    expect(
      resolveEffectiveViewsConfig({
        ...SPEC,
        profile: {
          ...PROFILE,
          views: { enabled: false, namePattern: 'x', includeEntityGraphMetadata: true },
        },
      })
    ).toBeNull();
  });

  it('defaults name pattern and metadata flag when profile is present', () => {
    expect(resolveEffectiveViewsConfig({ ...SPEC, profile: PROFILE })).toEqual({
      enabled: true,
      namePattern: DEFAULT_VIEW_NAME_PATTERN,
      includeEntityGraphMetadata: DEFAULT_INCLUDE_ENTITY_GRAPH_METADATA,
    });
  });
});

describe('generateCleanViewsSql', () => {
  it('returns no statements when profile is absent', () => {
    expect(generateCleanViewsSql(SPEC, 'snowflake', 'PUBLIC')).toEqual({
      statements: [],
      warnings: [],
    });
  });

  it('returns no statements when views are disabled', () => {
    const result = generateCleanViewsSql(
      {
        ...SPEC,
        profile: {
          ...PROFILE,
          views: {
            enabled: false,
            namePattern: '{source_table}_clean',
            includeEntityGraphMetadata: true,
          },
        },
      },
      'snowflake',
      'PUBLIC'
    );

    expect(result).toEqual({ statements: [], warnings: [] });
  });

  it('emits a view only for inputs with known source columns and warns on the rest', () => {
    const result = generateCleanViewsSql(
      {
        ...SPEC,
        profile: PROFILE,
      },
      'snowflake',
      'PUBLIC'
    );

    expect(result.statements.map((statement) => statement.name)).toEqual(['clean_view_s0']);
    expect(result.warnings).toContain(
      "Input 'marketing.enrichment_vendor_companies' has no known source columns; skipping clean view generation. " +
        'Add schema.columns to the source spec so the Entity Graph clean view can avoid column collisions.'
    );
  });

  it('skips inputs without idFields and emits a warning', () => {
    const result = generateCleanViewsSql(
      {
        ...SPEC,
        inputs: [
          SPEC.inputs[0]!,
          {
            ...SPEC.inputs[1]!,
            idFields: undefined,
          },
        ],
        profile: PROFILE,
      },
      'snowflake',
      'PUBLIC'
    );

    expect(result.statements).toHaveLength(1);
    expect(result.warnings).toContain(
      "Input 'marketing.enrichment_vendor_companies' has no idFields; skipping clean view generation."
    );
  });

  it('replaces known golden fields with COALESCE expressions and appends metadata by default', () => {
    const statement = generateCleanViewsSql(
      {
        ...SPEC,
        profile: PROFILE,
      },
      'snowflake',
      'PUBLIC'
    ).statements[0]!;

    expect(statement.sql).toContain(
      'COALESCE(ep."DISPLAY_NAME", src."COMPANY_NAME") AS "COMPANY_NAME"'
    );
    expect(statement.sql).toContain(
      'COALESCE(ep."PROFILE_ATTRS":hq_country::VARCHAR, src."BILLING_COUNTRY") AS "BILLING_COUNTRY"'
    );
    expect(statement.sql).toContain('src."NOTES" AS "NOTES"');
    expect(statement.sql).toContain('cw."ENTITY_ID" AS "ENTITY_GRAPH_ENTITY_ID"');
    expect(statement.sql).toContain('cw."CLUSTER_ID" AS "ENTITY_GRAPH_CLUSTER_ID"');
    expect(statement.sql).toContain('cw."COMPONENT_ID" AS "ENTITY_GRAPH_COMPONENT_ID"');
    expect(statement.sql).toContain('cw."CONFIDENCE_SCORE" AS "ENTITY_GRAPH_CONFIDENCE_SCORE"');
    expect(statement.sql).toContain('LEFT JOIN "PUBLIC"."COMPANY__CROSSWALKS" cw');
    expect(statement.sql).toContain(
      'ON CAST(src."SALESFORCE_ACCOUNT_ID" AS VARCHAR) = cw."SOURCE_ENTITY_ID"'
    );
    expect(statement.sql).toContain(`AND cw."SOURCE_REF" = 'revops.salesforce_accounts'`);
    expect(statement.sql).toContain('LEFT JOIN "PUBLIC"."COMPANY__ENTITY_PROFILE" ep');
    expect(statement.sql).toContain('ON cw."ENTITY_ID" = ep."ENTITY_ID"');
  });

  it('matches display_name and attribute fields case-insensitively against source columns', () => {
    const statement = generateCleanViewsSql(
      {
        ...SPEC,
        profile: PROFILE,
        inputs: [
          {
            ...SPEC.inputs[0]!,
            sourceColumns: ['SALESFORCE_ACCOUNT_ID', 'COMPANY_NAME', 'Billing_Country', 'NOTES'],
          },
        ],
      },
      'snowflake',
      'PUBLIC'
    ).statements[0]!;

    expect(statement.sql).toContain(
      'COALESCE(ep."DISPLAY_NAME", src."COMPANY_NAME") AS "COMPANY_NAME"'
    );
    expect(statement.sql).toContain(
      'COALESCE(ep."PROFILE_ATTRS":hq_country::VARCHAR, src."BILLING_COUNTRY") AS "BILLING_COUNTRY"'
    );
  });

  it('builds composite source_entity_id expressions when idFields has multiple entries', () => {
    const statement = generateCleanViewsSql(
      {
        ...SPEC,
        profile: PROFILE,
        inputs: [
          {
            ...SPEC.inputs[0]!,
            idFields: ['tenant_id', 'salesforce_account_id'],
            sourceColumns: [
              'tenant_id',
              'salesforce_account_id',
              'company_name',
              'billing_country',
            ],
          },
        ],
      },
      'snowflake',
      'PUBLIC'
    ).statements[0]!;

    expect(statement.sql).toContain(
      "CONCAT('tenant_id=', COALESCE(CAST(src.\"TENANT_ID\" AS VARCHAR), '<null>'), '|salesforce_account_id=', COALESCE(CAST(src.\"SALESFORCE_ACCOUNT_ID\" AS VARCHAR), '<null>'))"
    );
    expect(statement.sql).toContain('= cw."SOURCE_ENTITY_ID"');
  });

  it('throws when two inputs resolve to the same clean view name', () => {
    expect(() =>
      generateCleanViewsSql(
        {
          ...SPEC,
          profile: PROFILE,
          inputs: [
            { ...SPEC.inputs[0]!, ref: 'revops.accounts', sourceColumns: ['id', 'company_name'] },
            {
              ...SPEC.inputs[0]!,
              alias: 's2',
              ref: 'marketing.accounts',
              sourceColumns: ['id', 'company_name'],
            },
          ],
        },
        'snowflake',
        'PUBLIC'
      )
    ).toThrow(/Clean view name collision/);
  });

  it('omits metadata columns when includeEntityGraphMetadata is false', () => {
    const statement = generateCleanViewsSql(
      {
        ...SPEC,
        profile: {
          ...PROFILE,
          views: {
            enabled: true,
            namePattern: '{source_table}_clean',
            includeEntityGraphMetadata: false,
          },
        },
      },
      'snowflake',
      'PUBLIC'
    ).statements[0]!;

    expect(statement.sql).not.toContain('ENTITY_GRAPH_ENTITY_ID');
    expect(statement.sql).not.toContain('ENTITY_GRAPH_CLUSTER_ID');
    expect(statement.sql).not.toContain('ENTITY_GRAPH_COMPONENT_ID');
    expect(statement.sql).not.toContain('ENTITY_GRAPH_CONFIDENCE_SCORE');
  });

  it('rejects source columns that collide with reserved metadata aliases', () => {
    expect(() =>
      generateCleanViewsSql(
        {
          ...SPEC,
          profile: PROFILE,
          inputs: [
            {
              ...SPEC.inputs[0]!,
              sourceColumns: ['salesforce_account_id', 'company_name', 'ENTITY_GRAPH_ENTITY_ID'],
            },
          ],
        },
        'snowflake',
        'PUBLIC'
      )
    ).toThrow(/reserved Entity Graph metadata columns: ENTITY_GRAPH_ENTITY_ID/);
  });

  it.each([
    ['snowflake', 'ep."PROFILE_ATTRS":hq_country::VARCHAR', '"PUBLIC"."SALESFORCE_ACCOUNTS_CLEAN"'],
    [
      'bigquery',
      "JSON_VALUE(ep.`profile_attrs`, '$.hq_country')",
      '`public`.`salesforce_accounts_clean`',
    ],
    [
      'databricks',
      "get_json_object(ep.`profile_attrs`, '$.hq_country')",
      '`public`.`salesforce_accounts_clean`',
    ],
    [
      'duckdb',
      `json_extract_string(ep."profile_attrs", '$.hq_country')`,
      '"public"."salesforce_accounts_clean"',
    ],
    ['postgres', `ep."profile_attrs" ->> 'hq_country'`, '"public"."salesforce_accounts_clean"'],
    ['pgvector', `ep."profile_attrs" ->> 'hq_country'`, '"public"."salesforce_accounts_clean"'],
    [
      'redshift',
      `json_extract_path_text(ep."profile_attrs", 'hq_country')`,
      '"public"."salesforce_accounts_clean"',
    ],
    [
      'mysql',
      "JSON_UNQUOTE(JSON_EXTRACT(ep.`profile_attrs`, '$.hq_country'))",
      '`public`.`salesforce_accounts_clean`',
    ],
  ] as const)(
    'emits dialect-specific JSON extraction and identifier quoting for %s',
    (dialect, jsonFragment, fqViewName) => {
      const statement = generateCleanViewsSql(
        {
          ...SPEC,
          profile: PROFILE,
          inputs: [SPEC.inputs[0]!],
        },
        dialect,
        'PUBLIC'
      ).statements[0]!;

      expect(statement.sql).toContain(jsonFragment);
      expect(statement.sql).toContain(`CREATE OR REPLACE VIEW ${fqViewName}`);
    }
  );
});

describe('compileResolutionProfile', () => {
  it('includes clean views after profile tables without counting them as tables', () => {
    const result = compileResolutionProfile(
      {
        ...SPEC,
        profile: PROFILE,
      },
      'snowflake',
      'PUBLIC'
    );

    expect(result.statements.map((statement) => statement.name)).toEqual([
      'entity_profile',
      'entity_quality',
      'clean_view_s0',
    ]);
    expect(result.tableNames).toEqual(['company__entity_profile', 'company__entity_quality']);
    expect(result.statements[2]?.tableCreated).toBeUndefined();
    expect(result.warnings).toContain(
      "Input 'marketing.enrichment_vendor_companies' has no known source columns; skipping clean view generation. " +
        'Add schema.columns to the source spec so the Entity Graph clean view can avoid column collisions.'
    );
  });
});
