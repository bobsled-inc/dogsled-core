import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

import {
  getIntegrationsDir,
  listIntegrationDirs,
  listResourceFiles,
  getResourcePath,
  readYamlFile,
  clearCache,
} from '../src/loader.js';
import { MetaSpecSchema, SourceSpecSchema } from '../src/validate.js';

import type { MetaSpec } from '../src/types.js';
import { getOutputFieldNames } from './helpers/output-fields.js';

beforeAll(() => clearCache());

function getLoadStrategy(resource: Record<string, unknown>): string | undefined {
  const extract = resource['extract'] as Record<string, unknown> | undefined;
  const table = extract?.['table'] as Record<string, unknown> | undefined;
  return (table?.['load_strategy'] ?? resource['load_strategy']) as string | undefined;
}

function getKeyProperties(resource: Record<string, unknown>): string[] {
  const extract = resource['extract'] as Record<string, unknown> | undefined;
  const table = extract?.['table'] as Record<string, unknown> | undefined;
  const primaryKey = table?.['primary_key'] ?? resource['key_properties'];
  return Array.isArray(primaryKey) ? primaryKey.map((value) => String(value)) : [];
}

function buildEndpointKey(api: Record<string, unknown>): string {
  const method = String(api['method']);
  const endpoint = String(api['endpoint']);
  const queryParams =
    api['query_params'] && typeof api['query_params'] === 'object'
      ? Object.fromEntries(
          Object.entries(api['query_params'] as Record<string, unknown>).sort(([left], [right]) =>
            left.localeCompare(right)
          )
        )
      : undefined;
  const requestBody =
    api['request_body'] && typeof api['request_body'] === 'object'
      ? (api['request_body'] as Record<string, unknown>)
      : undefined;
  const requestQuery =
    method === 'POST' && typeof requestBody?.['query'] === 'string' ? requestBody['query'] : '';

  return JSON.stringify({
    method,
    endpoint,
    queryParams,
    requestQuery,
  });
}

describe('structural completeness', () => {
  const sources = listIntegrationDirs();

  for (const sourceName of sources) {
    describe(sourceName, () => {
      const sourceDir = join(getIntegrationsDir(), sourceName);

      it('has source.yml', () => {
        expect(existsSync(join(sourceDir, 'source.yml'))).toBe(true);
      });

      it('has meta.yml', () => {
        expect(existsSync(join(sourceDir, 'meta.yml'))).toBe(true);
      });

      it('has at least one resource', () => {
        const resources = listResourceFiles(sourceName);
        expect(resources.length).toBeGreaterThan(0);
      });

      it('auth env vars in source.yml match meta.yml auth_setup or source.yml auth_env_vars', () => {
        const sourceContent = readFileSync(join(sourceDir, 'source.yml'), 'utf-8');
        const meta = MetaSpecSchema.parse(readYamlFile(join(sourceDir, 'meta.yml'))) as MetaSpec;
        const source = SourceSpecSchema.parse(readYamlFile(join(sourceDir, 'source.yml')));

        const envVarPattern = /\$\{\{\s*env\.(\w+)\s*\}\}/g;
        const usedEnvVars = new Set<string>();
        let match;
        while ((match = envVarPattern.exec(sourceContent)) !== null) {
          usedEnvVars.add(match[1]!);
        }

        // custom_api sources declare env vars inline via auth_env_vars in lieu
        // of a meta.yml auth_setup block. A variable referenced only by a
        // transport's optional_headers is host-supplied per request, so the
        // header itself is its declaration; one that a required field also
        // references stays a credential.
        const declaredEnvVars = new Set<string>([
          ...(meta.auth_setup ?? []).map((a) => a.env),
          ...((source.auth_env_vars as string[] | undefined) ?? []),
        ]);
        const optionalOnly = new Set<string>();
        const requiredRefs = new Set<string>();
        for (const transport of source.transports) {
          const { optional_headers: optionalHeaders = {}, ...rest } =
            transport.type === 'http' ? transport : { ...transport, optional_headers: {} };
          for (const requiredMatch of JSON.stringify(rest).matchAll(envVarPattern)) {
            requiredRefs.add(requiredMatch[1]!);
          }
          for (const value of Object.values(optionalHeaders)) {
            for (const optionalMatch of value.matchAll(envVarPattern)) {
              optionalOnly.add(optionalMatch[1]!);
            }
          }
        }
        for (const envVar of optionalOnly) {
          if (!requiredRefs.has(envVar)) declaredEnvVars.add(envVar);
        }

        for (const envVar of usedEnvVars) {
          expect(declaredEnvVars.has(envVar)).toBe(true);
        }
      });

      it('all base_url and docs_url values use HTTPS', () => {
        const source = SourceSpecSchema.parse(readYamlFile(join(sourceDir, 'source.yml')));
        for (const transport of source.transports) {
          const baseUrl = transport['base_url'] as string | undefined;
          if (baseUrl) {
            expect(baseUrl.startsWith('https://')).toBe(true);
          }
        }

        const meta = MetaSpecSchema.parse(readYamlFile(join(sourceDir, 'meta.yml'))) as MetaSpec;
        expect(meta.docs_url.startsWith('https://')).toBe(true);
      });

      it('no two REST resources hit the same endpoint + method', () => {
        const resources = listResourceFiles(sourceName);
        const endpoints = new Set<string>();

        for (const resourceName of resources) {
          const data = readYamlFile(getResourcePath(sourceName, resourceName)) as Record<
            string,
            unknown
          >;
          const api = data['api'] as Record<string, unknown> | undefined;
          if (api) {
            // GraphQL endpoints share the same POST /graphql path;
            // they are differentiated by query, so skip uniqueness check.
            const endpoint = api['endpoint'] as string;
            if (api['method'] === 'POST' && endpoint.endsWith('/graphql')) continue;

            const key = buildEndpointKey(api);
            expect(endpoints.has(key)).toBe(false);
            endpoints.add(key);
          }
        }
      });

      it('merge load_strategy resources have key properties', () => {
        const resources = listResourceFiles(sourceName);
        for (const resourceName of resources) {
          const data = readYamlFile(getResourcePath(sourceName, resourceName)) as Record<
            string,
            unknown
          >;
          const loadStrategy = getLoadStrategy(data);
          if (loadStrategy === 'merge' || loadStrategy === 'incremental_merge') {
            const keyProperties = getKeyProperties(data);
            expect(
              keyProperties && keyProperties.length > 0,
              `${sourceName}/${resourceName}: ${loadStrategy} load_strategy requires primary keys`
            ).toBe(true);
          }
        }
      });

      it('key properties exist in output', () => {
        const resources = listResourceFiles(sourceName);
        for (const resourceName of resources) {
          const data = readYamlFile(getResourcePath(sourceName, resourceName)) as Record<
            string,
            unknown
          >;
          const loadStrategy = getLoadStrategy(data);
          const keyProperties = getKeyProperties(data);
          if (keyProperties.length === 0) continue;

          const fieldNames = getOutputFieldNames(data);
          expect(
            fieldNames && fieldNames.size > 0,
            `${sourceName}/${resourceName}: ${loadStrategy ?? 'keyed'} resource requires output fields to validate primary keys`
          ).toBe(true);
          if (!fieldNames || fieldNames.size === 0) continue;

          for (const key of keyProperties) {
            expect(
              fieldNames.has(key),
              `${sourceName}/${resourceName}: primary key "${key}" must exist in output fields`
            ).toBe(true);
          }
        }
      });
    });
  }
});
