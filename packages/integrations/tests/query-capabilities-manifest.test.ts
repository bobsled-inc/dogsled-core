import { describe, expect, it } from 'vitest';

import { QUERY_OPERATORS } from '@bobsled-inc/extractor/extractor';

import {
  QUERY_CAPABILITIES_MANIFEST_JSON_SCHEMA,
  buildQueryCapabilitiesManifest,
  renderQueryCapabilitiesManifestJson,
} from '../src/query-resources/capabilities-manifest.js';

describe('query capabilities manifest invariants', () => {
  const manifest = buildQueryCapabilitiesManifest();

  it('renders deterministic JSON for machine consumers', () => {
    expect(JSON.parse(renderQueryCapabilitiesManifestJson(manifest))).toEqual(manifest);
  }, 30_000);

  it('keeps schemaVersion pinned to 1', () => {
    expect(manifest.schemaVersion).toBe(1);
  });

  it('uses declared per-resource filter syntax', () => {
    expect(manifest.filterSyntax).toBe('mixed');
    const syntaxes = new Set<string>();
    for (const integration of manifest.integrations) {
      for (const resource of integration.resources) {
        syntaxes.add(resource.filterSyntax);
      }
    }
    expect(syntaxes).toEqual(new Set(['mongodb-compatible', 'mcp']));
  });

  it('keeps llmEval non-shipping until a harness exists', () => {
    expect(manifest.llmEval.status).toBe('not_implemented');
    expect(manifest.llmEval.requiredForShipping).toBe(true);
    expect(manifest.llmEval.note).toMatch(/\S/);
  });

  it('includes at least one resource per integration', () => {
    for (const integration of manifest.integrations) {
      expect(integration.integration).toMatch(/\S/);
      expect(integration.resources.length).toBeGreaterThan(0);
    }
  }, 30_000);

  it('requires every filter field to declare at least one known operator with a bind input', () => {
    const knownOperators = new Set(QUERY_OPERATORS);

    for (const integration of manifest.integrations) {
      for (const resource of integration.resources) {
        for (const filter of resource.filters) {
          expect(filter.field).toMatch(/\S/);
          expect(filter.operators.length).toBeGreaterThan(0);
          for (const operator of filter.operators) {
            expect(knownOperators.has(operator.operator)).toBe(true);
            expect(operator.bindInput).toMatch(/\S/);
          }
        }
      }
    }
  }, 30_000);

  it('ships a JSON schema for manifest consumers', () => {
    expect(QUERY_CAPABILITIES_MANIFEST_JSON_SCHEMA).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: {
        integrations: {
          type: 'array',
        },
      },
    });
  });
});
