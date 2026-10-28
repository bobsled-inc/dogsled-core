import { describe, expect, it } from 'vitest';

import { loadResolvedSurvivorshipFixture } from './test-helpers.js';

describe('survivorship parser', () => {
  it('synthesizes recency rules when attribute_rules are omitted', () => {
    const resolved = loadResolvedSurvivorshipFixture('company_survivorship');

    expect(resolved.defaultRecencyMode).toBe(true);
    expect(resolved.attributeRules).toEqual([
      {
        attribute: 'company_name',
        strategy: 'recency',
        sourceOrder: ['ecom.crm_companies', 'ecom.enrichment_vendor_companies'],
        timestampField: 'updated_at',
        fallback: undefined,
        valuePriority: [],
        pinnedValue: undefined,
      },
      {
        attribute: 'domain',
        strategy: 'recency',
        sourceOrder: ['ecom.crm_companies', 'ecom.enrichment_vendor_companies'],
        timestampField: 'updated_at',
        fallback: undefined,
        valuePriority: [],
        pinnedValue: undefined,
      },
    ]);
  });
});
