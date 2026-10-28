import { describe, expect, it } from 'vitest';

import { buildLineageRows } from '../../../../src/compiler/lineage/merge.js';
import type { ResolvedResolutionSpec } from '../../../../src/compiler/identity/types.js';
import type { ResolvedSurvivorshipSpec } from '../../../../src/compiler/survivorship/types.js';

function makeResolutionSpec(
  overrides: Partial<ResolvedResolutionSpec> = {}
): ResolvedResolutionSpec {
  return {
    name: 'company_resolution',
    entity: 'company',
    description: '',
    inputs: [
      {
        ref: 'salesforce_input',
        fqTableName: 'raw.salesforce.accounts',
        alias: 'salesforce',
      },
      {
        ref: 'hubspot.companies',
        fqTableName: 'hubspot.companies',
        alias: 'hubspot',
      },
    ],
    standardize: [
      { field: 'name', transforms: ['normalize_company', 'fingerprint'] },
      { field: 'domain', transforms: ['extract_domain'] },
    ],
    deterministicRules: [],
    thresholds: { autoMerge: 0.9, autoReject: 0.1, review: [0.1, 0.9] },
    entityIdPolicy: { strategy: 'stable_uuid' },
    profile: {
      displayName: { field: 'name' },
      attributes: [
        { field: 'name', alias: 'name' },
        { field: 'domain', alias: 'website' },
      ],
      quality: {
        freshnessWindows: [],
        sourceDiversityCap: 5,
        trustWeights: { identity: 0.4, freshness: 0.2, diversity: 0.2, coverage: 0.2 },
        trustTierThresholds: { trusted: 0.8, monitor: 0.5, review: 0.2 },
      },
      activations: [],
    },
    ...overrides,
  };
}

function makeSurvivorshipSpec(
  overrides: Partial<ResolvedSurvivorshipSpec> = {}
): ResolvedSurvivorshipSpec {
  return {
    name: 'company_survivorship',
    entity: 'company',
    description: '',
    resolutionRef: 'company_resolution',
    resolutionEntity: 'company',
    entityIdPolicy: { strategy: 'stable_uuid' },
    attributeRules: [
      {
        attribute: 'name',
        strategy: 'source_priority',
        sourceOrder: ['salesforce', 'hubspot'],
        valuePriority: [],
      },
      {
        attribute: 'domain',
        strategy: 'recency',
        sourceOrder: ['hubspot', 'salesforce'],
        valuePriority: [],
      },
    ],
    targetSchema: 'main',
    defaultRecencyMode: false,
    ...overrides,
  };
}

describe('buildLineageRows', () => {
  it('produces one row per (attribute × source_system)', () => {
    const { rows, warnings } = buildLineageRows(makeResolutionSpec(), makeSurvivorshipSpec());
    expect(rows).toHaveLength(4); // 2 attributes × 2 sources
    expect(warnings).toHaveLength(0);
  });

  it('sets entity_id to null (schema-level lineage)', () => {
    const { rows } = buildLineageRows(makeResolutionSpec(), makeSurvivorshipSpec());
    for (const row of rows) {
      expect(row.entity_id).toBeNull();
    }
  });

  it('maps source_system alias to source_table ref', () => {
    const { rows } = buildLineageRows(makeResolutionSpec(), makeSurvivorshipSpec());
    const sfRow = rows.find((r) => r.attribute === 'name' && r.source_system === 'salesforce');
    expect(sfRow?.source_table).toBe('raw.salesforce.accounts');
    const hsRow = rows.find((r) => r.attribute === 'name' && r.source_system === 'hubspot');
    expect(hsRow?.source_table).toBe('hubspot.companies');
  });

  it('fills transform_ref from standardize transforms', () => {
    const { rows } = buildLineageRows(makeResolutionSpec(), makeSurvivorshipSpec());
    const nameRow = rows.find((r) => r.attribute === 'name' && r.source_system === 'salesforce');
    expect(nameRow?.transform_ref).toBe('normalize_company,fingerprint');
    expect(nameRow?.transform_step).toBe('standardize');
  });

  it('sets transform_ref/step to null when no standardize rule', () => {
    const spec = makeResolutionSpec({ standardize: [] });
    const { rows } = buildLineageRows(spec, makeSurvivorshipSpec());
    for (const row of rows) {
      expect(row.transform_ref).toBeNull();
      expect(row.transform_step).toBeNull();
    }
  });

  it('marks rows is_complete=true when input alias is resolved', () => {
    const { rows } = buildLineageRows(makeResolutionSpec(), makeSurvivorshipSpec());
    for (const row of rows) {
      expect(row.is_complete).toBe(true);
    }
  });

  it('marks rows is_complete=false and warns when source alias not in resolution inputs', () => {
    const survSpec = makeSurvivorshipSpec({
      attributeRules: [
        {
          attribute: 'name',
          strategy: 'source_priority',
          sourceOrder: ['unknown_system'],
          valuePriority: [],
        },
      ],
    });
    const { rows, warnings } = buildLineageRows(makeResolutionSpec(), survSpec);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_complete).toBe(false);
    expect(rows[0]?.source_table).toBe('');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("'unknown_system'");
  });

  it('marks all rows is_complete=false when every attribute has only unresolvable aliases', () => {
    const survSpec = makeSurvivorshipSpec({
      attributeRules: [
        {
          attribute: 'name',
          strategy: 'source_priority',
          sourceOrder: ['ghost_a'],
          valuePriority: [],
        },
        {
          attribute: 'domain',
          strategy: 'source_priority',
          sourceOrder: ['ghost_b'],
          valuePriority: [],
        },
      ],
    });
    const { rows, warnings } = buildLineageRows(makeResolutionSpec(), survSpec);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.is_complete).toBe(false);
      expect(row.source_table).toBe('');
    }
    expect(warnings).toHaveLength(2);
  });

  it('marks rows is_complete=false and warns when sourceOrder is empty', () => {
    const survSpec = makeSurvivorshipSpec({
      attributeRules: [
        { attribute: 'name', strategy: 'source_priority', sourceOrder: [], valuePriority: [] },
      ],
    });
    const { rows, warnings } = buildLineageRows(makeResolutionSpec(), survSpec);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_complete).toBe(false);
    expect(rows[0]?.source_system).toBeNull();
    expect(warnings.some((w) => w.includes('no source systems'))).toBe(true);
  });

  it('uses profile attribute alias as profile_column', () => {
    const { rows } = buildLineageRows(makeResolutionSpec(), makeSurvivorshipSpec());
    const domainRow = rows.find((r) => r.attribute === 'domain' && r.source_system === 'hubspot');
    expect(domainRow?.profile_column).toBe('website');
  });

  it('falls back to field name when no profile alias defined', () => {
    const resSpec = makeResolutionSpec({ profile: undefined });
    const { rows } = buildLineageRows(resSpec, makeSurvivorshipSpec());
    for (const row of rows) {
      expect(row.profile_column).toBe(row.attribute);
    }
  });

  it('sets entity_type from survivorship spec entity', () => {
    const { rows } = buildLineageRows(makeResolutionSpec(), makeSurvivorshipSpec());
    for (const row of rows) {
      expect(row.entity_type).toBe('company');
    }
  });

  it('sets profile_table from entity type', () => {
    const { rows } = buildLineageRows(makeResolutionSpec(), makeSurvivorshipSpec());
    for (const row of rows) {
      expect(row.profile_table).toBe('company__entity_profile');
    }
  });
});
