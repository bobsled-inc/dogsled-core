import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiResourceSpec } from '@bobsled-inc/extractor/extractor';
import { describe, it, expect, beforeAll } from 'vitest';
import type { z } from 'zod';

import {
  getIntegrationsDir,
  clearCache,
  readYamlFile,
  listIntegrationDirs,
  listActionFiles,
  listResourceFiles,
  getResourcePath,
} from '../src/loader.js';
import {
  ActionSpecSchema,
  MetaSpecSchema,
  SourceSpecSchema,
  ResourceSpecSchema,
} from '../src/validate.js';
import { getOutputFieldNames } from './helpers/output-fields.js';

type ParsedResource = z.output<typeof ResourceSpecSchema>;

function isApiResource(resource: ParsedResource): resource is ApiResourceSpec {
  return 'input' in resource && 'output' in resource && 'extract' in resource;
}

beforeAll(() => clearCache());

const PAGINATION_INPUT_NAMES = new Set([
  'after',
  'before',
  'cursor',
  'ending_before',
  'limit',
  'next_cursor',
  'offset',
  'page',
  'page_number',
  'page_size',
  'page_token',
  'per_page',
  'starting_after',
]);

function hasPaginationSignals(resource: Record<string, unknown>): boolean {
  const api = resource['api'] as Record<string, unknown> | undefined;
  const input = resource['input'] as Record<string, unknown> | undefined;
  const queryParams = api?.['query_params'] as Record<string, unknown> | undefined;

  if (input && Object.keys(input).some((key) => PAGINATION_INPUT_NAMES.has(key))) {
    return true;
  }

  if (!queryParams) {
    return false;
  }

  return Object.entries(queryParams).some(([key, value]) => {
    if (PAGINATION_INPUT_NAMES.has(key)) {
      return true;
    }

    return (
      typeof value === 'string' &&
      Array.from(PAGINATION_INPUT_NAMES).some((name) => value.includes(`input.${name}`))
    );
  });
}

describe('schema validation', () => {
  const sources = listIntegrationDirs();

  it('has at least one source', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  for (const sourceName of sources) {
    describe(sourceName, () => {
      const sourceDir = join(getIntegrationsDir(), sourceName);
      clearCache();

      it('source.yml passes schema validation', () => {
        const data = readYamlFile(join(sourceDir, 'source.yml'));
        const result = SourceSpecSchema.safeParse(data);
        if (!result.success) {
          throw new Error(
            `source.yml validation failed:\n${JSON.stringify(result.error.issues, null, 2)}`
          );
        }
      });

      it('meta.yml passes schema validation', () => {
        const data = readYamlFile(join(sourceDir, 'meta.yml'));
        const result = MetaSpecSchema.safeParse(data);
        if (!result.success) {
          throw new Error(
            `meta.yml validation failed:\n${JSON.stringify(result.error.issues, null, 2)}`
          );
        }
      });

      const resourceNames = listResourceFiles(sourceName);
      const actionNames = listActionFiles(sourceName);

      for (const resourceName of resourceNames) {
        it(`resource ${resourceName} passes schema validation`, () => {
          const data = readYamlFile(getResourcePath(sourceName, resourceName));
          const result = ResourceSpecSchema.safeParse(data);
          if (!result.success) {
            throw new Error(
              `resources/${resourceName}.yml validation failed:\n${JSON.stringify(result.error.issues, null, 2)}`
            );
          }
        });
      }

      for (const actionName of actionNames) {
        it(`actions/${actionName}.yml passes schema validation`, () => {
          const data = readYamlFile(join(sourceDir, 'actions', `${actionName}.yml`));
          const result = ActionSpecSchema.safeParse(data);
          if (!result.success) {
            throw new Error(
              `actions/${actionName}.yml validation failed:\n${JSON.stringify(result.error.issues, null, 2)}`
            );
          }
        });
      }
    });
  }
});

describe('for_each dependency checks', () => {
  const sources = listIntegrationDirs();

  for (const sourceName of sources) {
    clearCache();
    const resourceNames = listResourceFiles(sourceName);

    // Load all resources for cross-referencing
    const allResources = new Map<string, ParsedResource>();
    for (const name of resourceNames) {
      const data = ResourceSpecSchema.parse(readYamlFile(getResourcePath(sourceName, name)));
      allResources.set(name, data);
    }

    // Derive singular→plural resource name mappings for sibling lookup.
    // e.g. input "campaign_id" → strip suffix → "campaign" → match "campaigns"
    const resourceNameSet = new Set(resourceNames);

    for (const resourceName of resourceNames) {
      const parsed = allResources.get(resourceName)!;
      if (!isApiResource(parsed)) continue;
      const input = parsed.input;
      const forEachConfig = parsed.extract.for_each;
      const endpoint = parsed.api?.endpoint ?? '';

      it(`${sourceName}/${resourceName}: for_each references an existing resource`, () => {
        if (!forEachConfig) return;
        expect(resourceNameSet.has(forEachConfig.resource)).toBe(true);
      });

      it(`${sourceName}/${resourceName}: for_each bindings reference declared parent fields and child inputs`, () => {
        if (!forEachConfig) return;
        const parent = allResources.get(forEachConfig.resource);
        expect(parent).toBeDefined();
        expect(parent && isApiResource(parent)).toBe(true);
        if (!parent || !isApiResource(parent)) return;

        const bindings =
          'bindings' in forEachConfig
            ? forEachConfig.bindings
            : [
                {
                  field: forEachConfig.field,
                  input: forEachConfig.input,
                  source: 'output' as const,
                },
              ];
        for (const binding of bindings) {
          const parentFields = binding.source === 'input' ? parent.input : parent.output;
          expect(Object.hasOwn(parentFields, binding.field)).toBe(true);
          expect(Object.hasOwn(input, binding.input)).toBe(true);
        }
      });

      if (!input) continue;

      const requiredInputs = Object.entries(input).filter(
        ([, config]) => config['required'] === true
      );

      // Resources with multiple required inputs are typically targeted lookups
      // where the user provides specific IDs, not iteration candidates.
      if (requiredInputs.length > 1) continue;

      for (const [inputName] of requiredInputs) {
        // Check if the endpoint uses this input as a path parameter with
        // child segments after it (e.g. /campaigns/${{ input.campaign_id }}/leads).
        // Detail endpoints like /campaigns/${{ input.campaign_id }} don't need for_each.
        const inputPattern = `\\$\\{\\{\\s*input\\.${inputName}\\s*\\}\\}`;
        const pathParamRegex = new RegExp(inputPattern + '/.+');
        if (!pathParamRegex.test(endpoint)) continue;

        // Check if a sibling resource exists that could provide this input.
        // e.g. "campaign_id" → "campaign" → sibling "campaigns" exists?
        const stem = inputName.replace(/_(id|token|key)$/, '');
        const siblingCandidates = [stem, `${stem}s`, `${stem}es`];
        const hasSibling = siblingCandidates.some(
          (c) => resourceNameSet.has(c) && c !== resourceName
        );
        if (!hasSibling) continue;

        it(`${sourceName}/${resourceName}: required input "${inputName}" has sibling parent resource — needs for_each`, () => {
          expect(forEachConfig).toBeDefined();
          if (forEachConfig) {
            const boundInputs =
              'bindings' in forEachConfig
                ? forEachConfig.bindings.map((binding) => binding.input)
                : [forEachConfig.input];
            expect(boundInputs).toContain(inputName);
          }
        });
      }
    }
  }
});

describe('per-integration quality checks', () => {
  const sources = listIntegrationDirs();

  for (const sourceName of sources) {
    describe(sourceName, () => {
      clearCache();
      const resourceNames = listResourceFiles(sourceName);

      for (const resourceName of resourceNames) {
        describe(`resource ${resourceName}`, () => {
          const resourcePath = getResourcePath(sourceName, resourceName);
          const data = readYamlFile(resourcePath);
          const parsed = data as Record<string, unknown>;

          it('has no # REVIEW: annotations', () => {
            const rawContent = readFileSync(resourcePath, 'utf-8');
            expect(rawContent).not.toContain('# REVIEW:');
          });

          it('has at least one output field', () => {
            const output = parsed['output'] as Record<string, unknown> | undefined;
            expect(output).toBeDefined();
            if (!output) return;
            expect(Object.keys(output).length).toBeGreaterThan(0);
          });

          it('declares pagination or an explicit opt-out when pagination signals are present', () => {
            const extract = parsed['extract'] as Record<string, unknown> | undefined;
            if (!extract || !hasPaginationSignals(parsed)) return;

            expect(
              extract['pagination'] !== undefined || extract['paginated'] === false,
              `${sourceName}/${resourceName}: pagination-shaped resource must declare extract.pagination or set extract.paginated: false`
            ).toBe(true);
          });

          it('declares incremental cursor fields in output', () => {
            const incremental = parsed['incremental'] as Record<string, unknown> | undefined;
            const cursorField = incremental?.['cursor_field'];
            if (typeof cursorField !== 'string' || cursorField.length === 0) return;

            const outputFieldNames = getOutputFieldNames(parsed) ?? new Set<string>();
            expect(
              outputFieldNames.has(cursorField),
              `${sourceName}/${resourceName}: incremental cursor_field "${cursorField}" must exist in output fields`
            ).toBe(true);
          });

          it('does not require server_filter on first run without a seed window', () => {
            const incremental = parsed['incremental'] as Record<string, unknown> | undefined;
            if (incremental?.['strategy'] !== 'server_filter') return;

            expect(
              incremental['initial_lookback_seconds'],
              `${sourceName}/${resourceName}: server_filter incremental needs initial_lookback_seconds; use strategy: cursor for cursor-param resources`
            ).toBeDefined();
          });

          it('has a primary key defined', () => {
            const extract = parsed['extract'] as Record<string, unknown> | undefined;
            const table = extract?.['table'] as Record<string, unknown> | undefined;
            const primaryKey = table?.['primary_key'] as string[] | undefined;
            expect(primaryKey).toBeDefined();
            if (!primaryKey) return;
            expect(primaryKey.length).toBeGreaterThan(0);
          });

          it('has a non-empty description', () => {
            expect(parsed['description']).toBeTruthy();
          });

          it('does not redeclare source-level fields', () => {
            expect(parsed['integration']).toBeUndefined();
            expect(parsed['spec_version']).toBeUndefined();
          });
        });
      }
    });
  }
});
