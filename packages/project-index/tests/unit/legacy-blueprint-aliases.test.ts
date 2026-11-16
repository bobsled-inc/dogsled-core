import { describe, expect, it } from 'vitest';

import {
  assertValidProjectIndex,
  classifyProjectFile,
  indexProjectFiles,
  type ProjectIndexDeprecation,
} from '../../src/index.js';

const bindings = 'bobsled_connection_ref: api-binding\nbobsled_source_kind: bobsled_api\n';

describe('legacy Blueprint index normalization', () => {
  it.each([
    ['integrations/api.yml', '', 'integration'],
    ['sources/api.yml', '', 'source'],
    ['api.yml', 'type: source\n', 'integration'],
    ['api.yml', 'type: integration\n', 'integration'],
    ['api.yml', 'type: source\nspec_version: "2"\n', 'integration'],
  ])('normalizes %s without changing the authored content', (path, prefix, kind) => {
    const content = prefix + bindings;
    const classification = classifyProjectFile({ path, content });
    expect(classification).toMatchObject({
      status: 'recognized',
      entry: {
        kind,
        content,
        document: { bobsled_connection_ref: 'api-binding', bobsled_source_kind: 'bobsled_api' },
      },
    });
    if (classification.status !== 'recognized') throw new Error('expected recognized source');
    expect(classification.entry.document).not.toHaveProperty('bobsled_connection_ref');
    expect(classification.deprecations).toHaveLength(2);
  });

  it('canonicalizes destination entries while preserving nested data and other document kinds', () => {
    const pipeline =
      'type: pipeline_config\ndestinations:\n  warehouse:\n    type: bobsled_managed\n    bobsled_connection_ref: warehouse-prod\npipelines:\n  api:\n    inputs:\n      bobsled_connection_ref: user-data\n';
    const index = indexProjectFiles([
      { path: 'pipelines.yml', content: pipeline },
      { path: 'resource.yml', content: 'type: resource\nbobsled_connection_ref: user-data\n' },
    ]);
    expect(index.issues).toEqual([]);
    expect(index.entries[0]?.content).toBe(pipeline);
    expect(index.entries[0]?.document).toMatchObject({
      destinations: {
        warehouse: { type: 'bobsled_managed', bobsled_connection_ref: 'warehouse-prod' },
      },
      pipelines: { api: { inputs: { bobsled_connection_ref: 'user-data' } } },
    });
    expect(index.entries[1]?.document).toHaveProperty('bobsled_connection_ref', 'user-data');
    expect(index.deprecations).toHaveLength(2);
  });

  it('exports sorted deprecations separately from errors without exposing values', () => {
    const index = indexProjectFiles([
      { path: 'z.yml', content: 'type: integration\n' + bindings },
      { path: 'a.yml', content: 'type: integration\n' + bindings },
    ]);
    const deprecations: readonly ProjectIndexDeprecation[] = index.deprecations ?? [];
    expect(deprecations.map(({ path }) => path)).toEqual(['a.yml', 'a.yml', 'z.yml', 'z.yml']);
    expect(deprecations[0]).toEqual({
      code: 'BOBSLED_CORE_LEGACY_BLUEPRINT_KEY',
      path: 'a.yml',
      oldKey: 'bobsled_connection_ref',
      newKey: 'bobsled_connection_ref',
    });
    expect(deprecations[1]).toEqual({
      code: 'BOBSLED_CORE_LEGACY_BLUEPRINT_KEY',
      path: 'a.yml',
      oldKey: 'bobsled_source_kind',
      newKey: 'bobsled_source_kind',
    });
    expect(JSON.stringify(deprecations)).not.toContain('api-binding');
    expect(index.issues).toEqual([]);
    expect(() => assertValidProjectIndex(index)).not.toThrow();
  });

  it('accepts equal duplicates with deprecations and rejects differing duplicates as blocking issues', () => {
    const equal = indexProjectFiles([
      {
        path: 'api.yml',
        content: 'type: integration\n' + bindings + 'bobsled_connection_ref: api-binding\n',
      },
    ]);
    expect(equal.issues).toEqual([]);
    expect(equal.deprecations).toHaveLength(2);
    const conflict = indexProjectFiles([
      {
        path: 'api.yml',
        content: 'type: integration\n' + bindings + 'bobsled_connection_ref: private-new\n',
      },
    ]);
    expect(conflict.entries).toEqual([]);
    expect(conflict.issues).toMatchObject([
      { code: 'LEGACY_KEY_CONFLICT', path: 'api.yml', kind: 'integration' },
    ]);
    expect(conflict.issues[0]?.message).toBe(
      'LEGACY_KEY_CONFLICT: api.yml: bobsled_connection_ref conflicts with bobsled_connection_ref'
    );
    expect(() => assertValidProjectIndex(conflict)).toThrow('LEGACY_KEY_CONFLICT');
  });

  it('omits the additive field when canonical input has no deprecations', () => {
    expect(
      indexProjectFiles([
        { path: 'api.yml', content: 'type: integration\nbobsled_connection_ref: api-binding\n' },
      ])
    ).not.toHaveProperty('deprecations');
  });
});
