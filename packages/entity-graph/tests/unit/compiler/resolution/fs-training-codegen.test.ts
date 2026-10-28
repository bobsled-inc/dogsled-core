import { describe, expect, it } from 'vitest';

import {
  buildDeterministicPriorAnchorQuery,
  buildLabeledLevelOutcomeQuery,
  buildRandomPairLevelOutcomeQuery,
} from '../../../../src/compiler/identity/codegen-fs-training.js';

import type { ResolvedResolutionSpec } from '../../../../src/compiler/identity/types.js';

const spec: ResolvedResolutionSpec = {
  name: 'company_resolution',
  entity: 'company',
  description: 'Company identity resolution.',
  inputs: [
    {
      ref: 'crm_companies',
      fqTableName: '"raw"."crm_companies"',
      alias: 's0',
      idFields: ['id'],
    },
  ],
  standardize: [],
  blocking: { rules: [] },
  deterministicRules: [
    {
      name: 'exact_email',
      action: 'auto_merge',
      confidence: 1,
      conditions: [{ field: 'standardized_email', operator: 'exact', bothNotNull: true }],
    },
    {
      name: 'same_name_review',
      action: 'flag_for_review',
      confidence: 0.8,
      conditions: [{ field: 'standardized_name', operator: 'exact', bothNotNull: true }],
    },
  ],
  scoring: {
    method: 'fellegi_sunter',
    prior: 0.001,
    comparisons: [
      {
        field: 'standardized_email',
        levels: [
          { op: 'exact', m: 0.9, u: 0.001 },
          { op: 'else', m: 0.1, u: 0.999 },
        ],
      },
      {
        field: 'standardized_name',
        levels: [
          { op: 'jaro_winkler', gte: 0.95, m: 0.7, u: 0.05 },
          { op: 'else', m: 0.3, u: 0.95 },
        ],
      },
    ],
  },
  thresholds: { autoMerge: 0.9, review: 0.7, autoReject: 0.3 },
  entityIdPolicy: {
    strategy: 'stable',
    newId: 'component_id',
    merge: 'oldest_entity_id',
    split: 'preserve_anchor',
  },
};

const portableRandomSpec: ResolvedResolutionSpec = {
  ...spec,
  scoring: {
    method: 'fellegi_sunter',
    prior: 0.001,
    comparisons: [
      {
        field: 'standardized_email',
        levels: [
          { op: 'exact', m: 0.9, u: 0.001 },
          { op: 'else', m: 0.1, u: 0.999 },
        ],
      },
    ],
  },
};

describe('Fellegi-Sunter training query builders', () => {
  it('builds labeled level-outcome SQL from pair_scores and standardized records', () => {
    const sql = buildLabeledLevelOutcomeQuery(spec, ['pair-1'], 'mdm', 'duckdb');

    expect(sql).toContain('FROM "mdm"."company__pair_scores" ps');
    expect(sql).toContain('JOIN "mdm"."company__standardized" a');
    expect(sql).toContain('WHEN a."standardized_email" = b."standardized_email" THEN 0');
    expect(sql).toContain('END AS "level_0"');
    expect(sql).toContain('WHERE ps."pair_id" IN (\'pair-1\')');
  });

  it('rejects empty labeled pair batches before emitting SQL', () => {
    expect(() => buildLabeledLevelOutcomeQuery(spec, [], 'mdm', 'duckdb')).toThrow(
      /requires at least one pair id/
    );
  });

  it.each([
    ['snowflake', 'RANDOM()'],
    ['bigquery', 'RAND()'],
    ['postgres', 'RANDOM()'],
    ['databricks', 'RAND()'],
    ['mysql', 'RAND()'],
    ['duckdb', 'RANDOM()'],
  ] as const)(
    'samples random cross-pairs from standardized records without blocking on %s',
    (dialect, randomFunction) => {
      const sql = buildRandomPairLevelOutcomeQuery(portableRandomSpec, 1000, 'mdm', dialect);
      const lowerSql = sql.toLowerCase();

      expect(lowerSql).toContain('company__standardized');
      expect(lowerSql).toContain('record_id');
      expect(lowerSql).toContain('with sampled_records as');
      expect(lowerSql).toContain('from sampled_records a');
      expect(sql).toContain(`ORDER BY ${randomFunction}`);
      expect(sql).toContain('LIMIT 1000');
    }
  );

  it('counts prior anchors from auto-merge deterministic rules only', () => {
    const sql = buildDeterministicPriorAnchorQuery(spec, 'mdm', 'duckdb');

    expect(sql).toContain('deterministic_matches');
    expect(sql).toContain('WITH sampled_records AS');
    expect(sql).toContain('a."standardized_email" = b."standardized_email"');
    expect(sql).not.toContain('a."standardized_name" = b."standardized_name"');
  });
});
