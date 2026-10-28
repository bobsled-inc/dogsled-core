import { describe, expect, it } from 'vitest';
import { quoteIdentifier } from '@bobsled-inc/model-spec';

import { compileSurvivorship } from '../../../../src/compiler/survivorship/codegen.js';

import type { ResolvedSurvivorshipSpec } from '../../../../src/compiler/survivorship/types.js';
import { loadResolvedSurvivorshipFixture } from './test-helpers.js';

const SPEC: ResolvedSurvivorshipSpec = {
  name: 'company_survivorship',
  entity: 'company',
  description: 'Golden record rules for company.',
  resolutionRef: 'company_resolution',
  resolutionEntity: 'company',
  entityIdPolicy: {
    strategy: 'stable_uuid',
  },
  attributeRules: [
    {
      attribute: 'company_name',
      strategy: 'source_priority',
      sourceOrder: ['crm', 'zi'],
      valuePriority: [],
    },
    {
      attribute: 'domain',
      strategy: 'most_common',
      sourceOrder: [],
      valuePriority: [],
      fallback: 'unknown',
    },
    {
      attribute: 'status',
      strategy: 'value_priority',
      sourceOrder: [],
      valuePriority: ['active', 'prospect', 'inactive'],
    },
    {
      attribute: 'country',
      strategy: 'pinned_value',
      sourceOrder: [],
      valuePriority: [],
      pinnedValue: 'US',
    },
    {
      attribute: 'updated_at',
      strategy: 'recency',
      sourceOrder: [],
      valuePriority: [],
      timestampField: 'modified_at',
    },
    {
      attribute: 'email',
      strategy: 'most_complete',
      sourceOrder: [],
      valuePriority: [],
    },
  ],
  targetSchema: 'ENTITY_GRAPH',
  defaultRecencyMode: false,
};

describe('compileSurvivorship', () => {
  it.each(['snowflake', 'bigquery', 'postgres', 'duckdb', 'databricks', 'mysql'] as const)(
    'emits only the survivorship audit (golden record + history are owned by the cluster phase) for %s',
    (dialect) => {
      const compiled = compileSurvivorship(SPEC, dialect);
      const names = compiled.statements.map((statement) => statement.name);
      const audit = compiled.statements.find(
        (statement) => statement.name === 'survivorship_audit'
      );

      // The EAV golden record and history are no longer emitted here — the
      // cluster phase owns `__golden_record` / `__golden`; survivorship only
      // contributes the per-attribute decision audit trail.
      expect(names).toContain('ddl_survivorship_audit');
      expect(names).toContain('survivorship_audit');
      expect(names).not.toContain('survivorship_history');
      expect(names).not.toContain('golden_record');

      if (!audit) {
        throw new Error('Expected survivorship_audit statement to be present');
      }
      // The audit recomputes the chosen-value CTEs, so all per-attribute
      // strategies are exercised in its SQL.
      expect(audit.sql).toContain('new_golden_record');
      expect(audit.sql).not.toContain('\n,\n,');
      // source_priority: uses a CASE expression to rank by source system order
      expect(audit.sql).toContain('CASE');
      // most_common: uses COUNT(*) OVER window function
      expect(audit.sql).toContain('COUNT(*)');
      const clusterId = quoteIdentifier('cluster_id', dialect);
      const entityId = quoteIdentifier('entity_id', dialect);
      expect(audit.sql).toContain(`ranked.${entityId} = clusters.${entityId}`);
      expect(audit.sql).toContain(`ranked.${clusterId} = clusters.${clusterId}`);
      // value_priority: uses the configured priority values in a CASE expression
      expect(audit.sql).toContain('active');
      expect(audit.sql).toContain('prospect');
      // pinned_value: emits the literal pinned value directly
      expect(audit.sql).toContain('US');
      // recency: references the configured timestampField (may be uppercased in Snowflake)
      expect(audit.sql).toMatch(/modified_at/i);
      // most_complete: uses LENGTH(COALESCE(...)) to prefer non-null values
      expect(audit.sql).toContain('LENGTH(COALESCE(');
    }
  );

  it('emits a warning and recency SQL when default rules were synthesized', () => {
    const compiled = compileSurvivorship(
      loadResolvedSurvivorshipFixture('company_survivorship', 'ENTITY_GRAPH'),
      'snowflake'
    );

    expect(compiled.warnings).toHaveLength(1);
    expect(
      compiled.warnings.some((warning) => warning.includes('No attribute_rules defined'))
    ).toBe(true);
    expect(compiled.statements.some((statement) => /updated_at/i.test(statement.sql))).toBe(true);
  });

  it('throws when no resolved survivorship rules are available', () => {
    expect(() =>
      compileSurvivorship(
        {
          ...SPEC,
          attributeRules: [],
          defaultRecencyMode: false,
        },
        'snowflake'
      )
    ).toThrow('Survivorship requires at least one resolved attribute rule');
  });
});
