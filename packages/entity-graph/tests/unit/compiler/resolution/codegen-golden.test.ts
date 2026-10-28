import { describe, expect, it } from 'vitest';

import {
  generateGoldenRecordSql,
  generateGoldenWideSql,
  sourceTail,
  synthesizeGoldenRules,
} from '../../../../src/compiler/identity/codegen-golden.js';
import {
  generateGovernanceArtifacts,
  generateMaskedGoldenViewSql,
  generateSnowflakeGovernanceDdl,
} from '../../../../src/compiler/identity/codegen-governance.js';

import type { ResolvedResolutionSpec } from '../../../../src/compiler/identity/types.js';

function baseSpec(overrides: Partial<ResolvedResolutionSpec> = {}): ResolvedResolutionSpec {
  return {
    name: 'person_resolution',
    entity: 'person',
    description: 'Resolve people across Linear and Notion.',
    inputs: [
      {
        ref: 'work.linear',
        fqTableName: 'RAW.LINEAR',
        alias: 's0',
        role: 'internal',
        trustTier: 'gold',
        idFields: ['linear_id'],
      },
      {
        ref: 'work.notion',
        fqTableName: 'RAW.NOTION',
        alias: 's1',
        role: 'internal',
        trustTier: 'silver',
        idFields: ['notion_id'],
      },
    ],
    standardize: [
      { field: 'full_name', transforms: ['lowercase'] },
      { field: 'email', transforms: ['normalize_email'] },
    ],
    deterministicRules: [
      {
        name: 'exact_email',
        conditions: [{ field: 'email', operator: 'exact', bothNotNull: true }],
        action: 'auto_merge',
        confidence: 1,
      },
    ],
    thresholds: { autoMerge: 0.9, review: 0.6, autoReject: 0.5 },
    entityIdPolicy: {
      strategy: 'stable',
      newId: 'component_id',
      merge: 'oldest_entity_id',
      split: 'preserve_anchor',
    },
    profile: {
      displayName: { field: 'full_name' },
      attributes: [
        { field: 'full_name', alias: 'full_name' },
        { field: 'email', alias: 'email' },
      ],
      quality: {
        freshnessWindows: [
          { days: 1, score: 1 },
          { days: 7, score: 0.8 },
        ],
        sourceDiversityCap: 2,
        trustWeights: { identity: 0.4, freshness: 0.25, diversity: 0.2, coverage: 0.15 },
        trustTierThresholds: { trusted: 0.7, monitor: 0.5, review: 0.3 },
      },
      activations: [],
    },
    targetSchema: 'ENTITY_GRAPH',
    ...overrides,
  };
}

describe('sourceTail', () => {
  it('takes the segment after the last dot and sanitizes it', () => {
    expect(sourceTail('revops.salesforce_accounts')).toBe('salesforce_accounts');
    expect(sourceTail('a.b.product_neon')).toBe('product_neon');
    expect(sourceTail('linear')).toBe('linear');
    expect(sourceTail('weird-ref.has spaces')).toBe('has_spaces');
  });
});

describe('synthesizeGoldenRules', () => {
  it('uses inputs[] order as the precedence ladder and standardized columns', () => {
    const rules = synthesizeGoldenRules(baseSpec());
    expect(rules.map((rule) => rule.attributeName)).toEqual(['full_name', 'email']);
    expect(rules[0]?.sourceColumn).toBe('standardized_full_name');
    expect(rules[0]?.strategy).toBe('source_priority');
    expect(rules[0]?.sourceOrder).toEqual(['work.linear', 'work.notion']);
  });
});

describe('generateGoldenRecordSql (EAV, default-populated from profile.attributes)', () => {
  it.each(['snowflake', 'bigquery', 'postgres', 'duckdb', 'databricks', 'mysql'] as const)(
    'emits a populated golden_record from profile.attributes with no survivorship spec for %s',
    (dialect) => {
      const stmt = generateGoldenRecordSql(baseSpec(), dialect, 'ENTITY_GRAPH');
      expect(stmt.name).toBe('golden_record');
      expect(stmt.tableCreated).toBe('person__golden_record');
      expect(stmt.sql).toContain('new_golden_record');
      // attribute labels emitted as the profile aliases
      expect(stmt.sql).toMatch(/full_name/i);
      expect(stmt.sql).toMatch(/email/i);
      // source_priority ranks by inputs[] order
      expect(stmt.sql).toMatch(/work\.linear/);
      expect(stmt.sql).not.toContain('WHERE 1 = 0');
    }
  );

  it('creates an empty (typed) golden_record when no profile attributes are declared', () => {
    const spec = baseSpec({
      profile: undefined,
      standardize: [{ field: 'full_name', transforms: ['lowercase'] }],
    });
    const stmt = generateGoldenRecordSql(spec, 'duckdb', 'ENTITY_GRAPH');
    expect(stmt.sql).toContain('WHERE 1 = 0');
    expect(stmt.sql).not.toContain('new_golden_record');
  });
});

describe('generateGoldenWideSql (__golden)', () => {
  it('emits one row per entity with attribute, per-source id, flag, size, and trust columns', () => {
    const stmt = generateGoldenWideSql(baseSpec(), 'snowflake', 'ENTITY_GRAPH');
    expect(stmt.name).toBe('golden');
    expect(stmt.tableCreated).toBe('person__golden');

    // targets the wide table and reads the EAV
    expect(stmt.sql).toContain('"ENTITY_GRAPH"."PERSON__GOLDEN" AS');
    expect(stmt.sql).toContain('"ENTITY_GRAPH"."PERSON__GOLDEN_RECORD"');

    // pivoted attribute columns
    expect(stmt.sql).toContain('AS "FULL_NAME"');
    expect(stmt.sql).toContain('AS "EMAIL"');

    // per-source id + coverage flag columns
    expect(stmt.sql).toContain('AS "LINEAR_ID"');
    expect(stmt.sql).toContain('AS "HAS_LINEAR"');
    expect(stmt.sql).toContain('AS "NOTION_ID"');
    expect(stmt.sql).toContain('AS "HAS_NOTION"');
    expect(stmt.sql).toContain(
      `MAX(CASE WHEN "SOURCE_REF" = 'work.linear' THEN "SOURCE_ENTITY_ID" END)`
    );

    // cluster size + trust
    expect(stmt.sql).toContain('AS "CLUSTER_SIZE"');
    expect(stmt.sql).toContain('AS "TRUST_SCORE"');
    expect(stmt.sql).toContain('AS "TRUST_BAND"');
  });

  it('derives trust_band from the spec trust_tier_thresholds', () => {
    const stmt = generateGoldenWideSql(baseSpec(), 'duckdb', 'ENTITY_GRAPH');
    expect(stmt.sql).toContain('>= 0.7');
    expect(stmt.sql).toContain('>= 0.5');
    expect(stmt.sql).toContain('>= 0.3');
    expect(stmt.sql).toContain("'trusted'");
    expect(stmt.sql).toContain("'monitor'");
    expect(stmt.sql).toContain("'review'");
    expect(stmt.sql).toContain("'blocked'");
  });

  it('does not error for a single-source (sparse) entity and omits other sources', () => {
    const singleSource = baseSpec({
      inputs: [
        {
          ref: 'work.linear',
          fqTableName: 'RAW.LINEAR',
          alias: 's0',
          role: 'internal',
          trustTier: 'gold',
          idFields: ['linear_id'],
        },
      ],
    });
    const stmt = generateGoldenWideSql(singleSource, 'bigquery', 'entity_graph');
    expect(stmt.sql).toContain('AS `linear_id`');
    expect(stmt.sql).toContain('AS `has_linear`');
    expect(stmt.sql).not.toContain('notion');
  });

  it('emits source + trust columns but no attribute columns when profile is absent', () => {
    const spec = baseSpec({
      profile: undefined,
      standardize: [{ field: 'full_name', transforms: ['lowercase'] }],
    });
    const stmt = generateGoldenWideSql(spec, 'snowflake', 'ENTITY_GRAPH');
    expect(stmt.sql).toContain('AS "LINEAR_ID"');
    expect(stmt.sql).toContain('AS "CLUSTER_SIZE"');
    expect(stmt.sql).toContain('AS "TRUST_SCORE"');
    // coverage degrades to 1.0 and there is no attribute pivot CTE
    expect(stmt.sql).not.toContain('LEFT JOIN attrs');
  });
});

describe('governance masked golden views', () => {
  function governedSpec(): ResolvedResolutionSpec {
    return baseSpec({
      profile: {
        ...baseSpec().profile!,
        piiControls: {
          attributes: [
            { field: 'email', masking: 'hash', classification: 'email' },
            { field: 'full_name', masking: 'partial', classification: 'person_name' },
          ],
        },
      },
    });
  }

  it.each(['snowflake', 'bigquery', 'postgres', 'duckdb', 'databricks', 'mysql'] as const)(
    'emits masked golden view SQL for %s',
    (dialect) => {
      const stmt = generateMaskedGoldenViewSql(governedSpec(), dialect, 'ENTITY_GRAPH');
      expect(stmt?.name).toBe('golden_masked');
      expect(stmt?.tableCreated).toBe('person__golden_masked');
      expect(stmt?.sql).toContain('CREATE OR REPLACE VIEW');
      expect(stmt?.sql).toMatch(/SHA2|SHA256|sha2|sha256|digest/i);
      expect(stmt?.sql).toContain('***');
      // Per-source natural keys are hashed (they are often PII source PKs): the
      // masked attribute `email` (hash) plus `linear_id` + `notion_id` → at
      // least three hash expressions. Before the fix the natural keys leaked
      // unmasked and only one hash (email) appeared.
      const hashOccurrences = (stmt?.sql.match(/SHA2|SHA256|sha2|sha256|digest/gi) ?? []).length;
      expect(hashOccurrences).toBeGreaterThanOrEqual(3);
    }
  );

  it('emits Snowflake tag and masking policy DDL artifact', () => {
    const ddl = generateSnowflakeGovernanceDdl(governedSpec(), 'ENTITY_GRAPH');
    expect(ddl).toContain('CREATE TAG IF NOT EXISTS');
    expect(ddl).toContain('CREATE MASKING POLICY IF NOT EXISTS');
    expect(ddl).toContain('ALTER VIEW "ENTITY_GRAPH"."PERSON__GOLDEN_MASKED"');
  });

  it('emits guidance manifests for BigQuery and Databricks', () => {
    for (const dialect of ['bigquery', 'databricks'] as const) {
      const artifacts = generateGovernanceArtifacts(governedSpec(), dialect, 'entity_graph');
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]?.format).toBe('json');
      expect(artifacts[0]?.content).toContain('person__golden_masked');
    }
  });
});

describe('regression: golden record is populated when profile.attributes is declared', () => {
  // Locks the fix for the "empty <entity>__golden_record when profile.attributes
  // is declared" bug. Encodes the acceptance test at the codegen
  // level: with attributes declared the EAV SELECT must be the populated branch
  // (never the `WHERE 1 = 0` empty shell) and the wide __golden must activate
  // the attribute pivot and carry a named column per attribute. The empty-shell
  // and profile-absent tests above are the negative controls.

  it('EAV golden_record uses the populated branch (never the empty shell) on every dialect', () => {
    for (const dialect of [
      'snowflake',
      'bigquery',
      'postgres',
      'duckdb',
      'databricks',
      'mysql',
    ] as const) {
      const stmt = generateGoldenRecordSql(baseSpec(), dialect, 'ENTITY_GRAPH');
      expect(stmt.tableCreated, dialect).toBe('person__golden_record');
      expect(stmt.sql, dialect).not.toContain('WHERE 1 = 0');
      expect(stmt.sql, dialect).toContain('new_golden_record');
    }
  });

  it('wide __golden activates the attribute pivot and carries the named attribute columns', () => {
    const stmt = generateGoldenWideSql(baseSpec(), 'snowflake', 'ENTITY_GRAPH');
    // Attribute pivot CTE is active — the inverse of the profile-absent case,
    // which asserts `not.toContain('LEFT JOIN attrs')`.
    expect(stmt.sql).toContain('LEFT JOIN attrs');
    // One named output column per declared attribute, read from the EAV.
    expect(stmt.sql).toContain('AS "FULL_NAME"');
    expect(stmt.sql).toContain('AS "EMAIL"');
    expect(stmt.sql).toContain('"ENTITY_GRAPH"."PERSON__GOLDEN_RECORD"');
  });

  it('synthesizes one golden rule per declared attribute (≥ one value per entity per attribute)', () => {
    const rules = synthesizeGoldenRules(baseSpec());
    expect(rules.map((rule) => rule.attributeName)).toEqual(['full_name', 'email']);
  });
});

describe('golden record column-collision guards', () => {
  it('throws when an attribute alias collides with a reserved golden column', () => {
    const spec = baseSpec({
      profile: {
        attributes: [{ field: 'full_name', alias: 'cluster_size' }],
        quality: baseSpec().profile!.quality,
        activations: [],
      },
    });
    expect(() => generateGoldenWideSql(spec, 'duckdb', 'ENTITY_GRAPH')).toThrow(/reserved/i);
    expect(() => generateGoldenRecordSql(spec, 'duckdb', 'ENTITY_GRAPH')).toThrow(/reserved/i);
  });

  it('throws when an attribute alias collides with a per-source id column', () => {
    const spec = baseSpec({
      profile: {
        attributes: [{ field: 'full_name', alias: 'linear_id' }],
        quality: baseSpec().profile!.quality,
        activations: [],
      },
    });
    expect(() => generateGoldenWideSql(spec, 'duckdb', 'ENTITY_GRAPH')).toThrow(/reserved/i);
  });

  it('throws on duplicate attribute aliases', () => {
    const spec = baseSpec({
      profile: {
        attributes: [
          { field: 'full_name', alias: 'name' },
          { field: 'email', alias: 'name' },
        ],
        quality: baseSpec().profile!.quality,
        activations: [],
      },
    });
    expect(() => generateGoldenWideSql(spec, 'duckdb', 'ENTITY_GRAPH')).toThrow(/duplicate/i);
  });
});
