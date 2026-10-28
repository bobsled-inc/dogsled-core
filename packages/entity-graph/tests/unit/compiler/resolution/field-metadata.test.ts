import { describe, expect, it } from 'vitest';

import {
  buildEntitySchemaCatalogMetadata,
  inferCatalogRole,
  mergeFieldMetadata,
} from '../../../../src/compiler/entity-graph/field-metadata.js';

import type { ResolvedResolutionSpec } from '../../../../src/compiler/identity/types.js';

const SPEC: ResolvedResolutionSpec = {
  name: 'company_resolution',
  entity: 'company',
  description: 'Resolve companies.',
  inputs: [
    {
      ref: 'crm.accounts',
      fqTableName: 'RAW.ACCOUNTS',
      alias: 's0',
      idFields: ['account_id'],
    },
  ],
  standardize: [
    { field: 'company_name', transforms: ['trim'] },
    { field: 'domain', transforms: ['lowercase'] },
  ],
  profile: {
    displayName: { field: 'company_name' },
    attributes: [{ field: 'domain', alias: 'website' }],
    quality: {
      freshnessWindows: [{ days: 7, score: 1 }],
      sourceDiversityCap: 3,
      trustWeights: {
        identity: 0.4,
        freshness: 0.25,
        diversity: 0.2,
        coverage: 0.15,
      },
      trustTierThresholds: {
        trusted: 0.85,
        monitor: 0.7,
        review: 0.5,
      },
    },
    activations: [],
  },
  deterministicRules: [],
  thresholds: {
    autoMerge: 0.9,
    review: 0.6,
    autoReject: 0.4,
  },
};

describe('entity schema catalog field metadata', () => {
  it('treats id-suffixed fields as identifiers before lexical role hints', () => {
    expect(inferCatalogRole('email_id')).toBe('identifier');
    expect(inferCatalogRole('customer_name_id')).toBe('identifier');
  });

  it('merges inherited Model Spec metadata, profile aliases, and semantic overrides', () => {
    const [companyName, website] = buildEntitySchemaCatalogMetadata(
      {
        ...SPEC,
        semanticOverrides: {
          website: {
            description: 'Primary website used for account matching.',
            pii: false,
            tags: ['go_to_market'],
          },
        },
      },
      'entity-graph.company',
      {
        inheritedMetadata: {
          domain: {
            name: 'domain',
            type: 'string',
            description: 'Raw web domain.',
            semantic_role: 'url',
            format: 'hostname',
          },
        },
      }
    );

    expect(companyName).toMatchObject({
      attribute: 'company_name',
      sourceField: 'company_name',
      fieldMetadata: {
        name: 'company_name',
        type: 'string',
        semantic_role: 'name',
      },
    });
    expect(website).toEqual({
      attribute: 'website',
      sourceField: 'domain',
      fieldMetadata: {
        name: 'website',
        type: 'string',
        description: 'Primary website used for account matching.',
        semantic_role: 'url',
        format: 'hostname',
        pii: false,
        tags: ['go_to_market'],
      },
    });
  });

  it('lets source-field overrides apply when a profile alias has no direct override', () => {
    const metadata = mergeFieldMetadata(
      'entity-graph.company',
      { attribute: 'website', sourceField: 'domain' },
      {
        name: 'domain',
        type: 'string',
        semantic_role: 'url',
      },
      {
        domain: {
          owner: 'revops',
          quality_notes: 'Normalized before identity resolution.',
        },
      }
    );

    expect(metadata).toMatchObject({
      name: 'website',
      type: 'string',
      semantic_role: 'url',
      owner: 'revops',
      quality_notes: 'Normalized before identity resolution.',
    });
  });
});
