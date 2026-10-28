import { describe, expect, it } from 'vitest';

import { getIntegration, getResources } from '../src/index.js';
import {
  getEntityVariants,
  listEntities,
  listResourceFiles,
  listSourceDirs,
} from '../src/loader.js';
import { INTEGRATION_VALIDATION_CATALOG } from '../src/validation/generated-data.js';
import {
  buildIntegrationValidationCatalogFromYaml,
  resourceOutput,
} from '../src/validation/yaml-walker.js';

describe('integration validation catalog', () => {
  it('reads warehouse V2 schema.columns as output fields', () => {
    const columns = {
      id: { type: 'integer' },
      created_at: { type: 'timestamp' },
    };
    expect(resourceOutput({ name: 'orders', schema: { columns } })).toEqual(columns);
  });

  it('matches the filesystem-backed validation semantics for every built-in source', () => {
    for (const source of INTEGRATION_VALIDATION_CATALOG.sources) {
      const loadedSource = getIntegration(source.name);
      const sourceSpec = loadedSource.spec as unknown as Record<string, unknown>;
      const connection = sourceSpec['connection'] as Record<string, unknown> | undefined;

      expect(source.auth_setup).toEqual(loadedSource.meta.auth_setup ?? []);
      expect(source.transports).toEqual(loadedSource.spec.transports.map(({ id }) => id));
      expect(source.default_transport).toBe(loadedSource.spec.default_transport);
      expect(source.warehouses).toEqual(connection?.['warehouses']);
      expect(source.resources.map(({ name }) => name)).toEqual(loadedSource.resource_names);
      expect([...new Set(source.resources.map(({ entity }) => entity))].sort()).toEqual(
        listEntities(source.name)
      );

      for (const entity of listEntities(source.name)) {
        expect(
          source.resources
            .filter((resource) => resource.entity === entity)
            .map(({ name, via }) => ({ name, via }))
        ).toEqual(getEntityVariants(source.name, entity));
      }

      const loadedResources = new Map(
        getResources(source.name).map(({ resource }) => [
          resource.name,
          resource as unknown as Record<string, unknown>,
        ])
      );
      for (const resource of source.resources) {
        const loaded = loadedResources.get(resource.name);
        expect(loaded, `${source.name}.${resource.name}`).toBeDefined();
        const input = loaded?.['input'] as Record<string, unknown> | undefined;
        const output = loaded?.['output'] as Record<string, unknown> | undefined;
        const extract = loaded?.['extract'] as Record<string, unknown> | undefined;
        const replication = loaded?.['replication'] as Record<string, unknown> | undefined;
        const forEach = extract?.['for_each'] as Record<string, unknown> | undefined;
        const bindings = forEach?.['bindings'] as Array<Record<string, unknown>> | undefined;
        const boundInputs = bindings
          ? bindings.map(({ input: name }) => name)
          : forEach?.['input'] !== undefined
            ? [forEach['input']]
            : undefined;

        expect(resource.input_names).toEqual(Object.keys(input ?? {}));
        expect(resource.output_fields).toEqual(Object.keys(output ?? {}));
        expect(resource.embedding_candidates).toEqual(
          Object.entries(output ?? {})
            .filter(([, field]) => {
              return (
                typeof field === 'object' &&
                field !== null &&
                (field as Record<string, unknown>)['embedding_candidate'] === true
              );
            })
            .map(([name]) => name)
        );
        expect(resource.incremental).toBe(
          loaded?.['incremental'] !== undefined || extract?.['incremental'] !== undefined
        );
        expect(resource.replication_method).toBe(replication?.['method']);
        expect(resource.for_each).toEqual(
          forEach
            ? {
                resource: forEach['resource'],
                bound_inputs: boundInputs,
              }
            : undefined
        );
      }
    }
  }, 30_000);

  it('preserves each concrete YAML resource spec without collapsing variants', () => {
    const fresh = buildIntegrationValidationCatalogFromYaml();
    expect(INTEGRATION_VALIDATION_CATALOG).toEqual(fresh);

    const notion = INTEGRATION_VALIDATION_CATALOG.sources.find(
      (source) => source.name === 'notion'
    );
    const pages = notion?.resources.filter((resource) => resource.entity === 'pages');
    expect(pages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'pages_mcp', entity: 'pages', via: 'mcp' }),
        expect.objectContaining({ name: 'pages_rest', entity: 'pages', via: 'rest' }),
      ])
    );
  });

  it('has exactly one snapshot resource for every authored resource YAML', () => {
    expect(INTEGRATION_VALIDATION_CATALOG.sources.map((source) => source.name)).toEqual(
      listSourceDirs()
    );
    for (const sourceName of listSourceDirs()) {
      const snapshot = INTEGRATION_VALIDATION_CATALOG.sources.find(
        (source) => source.name === sourceName
      );
      expect(snapshot?.resources.map((resource) => resource.name)).toEqual(
        listResourceFiles(sourceName)
      );
    }
  });

  it('retains all multi-binding for_each target inputs in authored order', () => {
    const github = INTEGRATION_VALIDATION_CATALOG.sources.find(
      (source) => source.name === 'github'
    );
    const checkRuns = github?.resources.find((resource) => resource.name === 'check_runs');
    expect(checkRuns?.for_each).toEqual({
      resource: 'commits',
      bound_inputs: ['owner', 'repo', 'repository_full_name', 'ref'],
    });
  });

  it('keeps validation field names and incremental status compactly', () => {
    const posthog = INTEGRATION_VALIDATION_CATALOG.sources.find(
      (source) => source.name === 'posthog'
    );
    const events = posthog?.resources.find((resource) => resource.name === 'events');
    expect(events).toMatchObject({
      input_names: expect.arrayContaining(['project_id']),
      output_fields: expect.arrayContaining(['id', 'timestamp']),
      incremental: true,
      for_each: { resource: 'projects', bound_inputs: ['project_id'] },
    });
  });
});
