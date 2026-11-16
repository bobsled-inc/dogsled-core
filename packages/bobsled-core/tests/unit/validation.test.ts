import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_VALIDATION_CATALOG,
  createValidationCatalog,
  type ValidationCatalogSourceSnapshot,
} from '../../src/validation.js';

const source: ValidationCatalogSourceSnapshot = {
  name: 'fixture',
  auth_setup: [
    {
      env: 'FIXTURE_TOKEN',
      description: 'Fixture token',
      docs_url: 'https://example.com/auth',
    },
  ],
  transports: ['rest', 'mcp'],
  default_transport: 'rest',
  warehouses: { primary: 'COMPUTE_WH' },
  resources: [
    {
      name: 'accounts_rest',
      entity: 'accounts',
      via: 'rest',
      input_names: ['since'],
      output_fields: ['id', 'description'],
      embedding_candidates: ['description'],
      incremental: true,
      replication_method: 'cursor',
    },
    {
      name: 'accounts_mcp',
      entity: 'accounts',
      via: 'mcp',
      input_names: [],
      output_fields: ['id'],
      embedding_candidates: [],
      incremental: false,
    },
    {
      name: 'contacts',
      entity: 'contacts',
      input_names: ['account_id'],
      output_fields: ['id'],
      embedding_candidates: [],
      incremental: false,
      for_each: { resource: 'accounts_rest', bound_inputs: ['account_id'] },
    },
  ],
};

describe('validation catalog adapter', () => {
  it('projects source, variant, field, incremental, and for_each metadata', () => {
    const catalog = createValidationCatalog([source]);

    expect(catalog.getIntegration('fixture')).toEqual({
      meta: { auth_setup: source.auth_setup },
      resource_names: ['accounts_rest', 'accounts_mcp', 'contacts'],
      transports: [{ id: 'rest' }, { id: 'mcp' }],
      default_transport: 'rest',
      warehouses: { primary: 'COMPUTE_WH' },
    });
    expect(catalog.listEntities('fixture')).toEqual(['accounts', 'contacts']);
    expect(catalog.getEntityVariants('fixture', 'accounts')).toEqual([
      { name: 'accounts_rest', via: 'rest' },
      { name: 'accounts_mcp', via: 'mcp' },
    ]);
    expect(catalog.getResources('fixture')).toEqual([
      {
        resource: {
          name: 'accounts_rest',
          input: { since: {} },
          output: { id: {}, description: { embedding_candidate: true } },
          extract: { incremental: true },
          replication: { method: 'cursor' },
        },
      },
      {
        resource: {
          name: 'accounts_mcp',
          input: {},
          output: { id: {} },
        },
      },
      {
        resource: {
          name: 'contacts',
          input: { account_id: {} },
          output: { id: {} },
          extract: {
            for_each: {
              resource: 'accounts_rest',
              bindings: [{ input: 'account_id' }],
            },
          },
        },
      },
    ]);
  });

  it('rejects unknown sources and returns no variants for unknown entities', () => {
    const catalog = createValidationCatalog([source]);

    expect(() => catalog.getIntegration('missing')).toThrow('Source "missing" not found');
    expect(() => catalog.getResources('missing')).toThrow('Source "missing" not found');
    expect(catalog.getEntityVariants('fixture', 'missing')).toEqual([]);
  });

  it('contains managed PostHog and Notion validation metadata', () => {
    expect(
      BUILT_IN_VALIDATION_CATALOG.getIntegration('posthog').resource_names.length
    ).toBeGreaterThan(0);
    expect(
      BUILT_IN_VALIDATION_CATALOG.getIntegration('notion').resource_names.length
    ).toBeGreaterThan(0);
  });
});
