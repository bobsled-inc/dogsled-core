import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getResourceProgressMetadata,
  buildSchemaBehaviorDefaultWarning,
} from '../../../src/runtime/schema-diagnostics.js';

describe('buildSchemaBehaviorDefaultWarning', () => {
  it('describes replacement semantics and the loader evolve fallback', () => {
    const warning = buildSchemaBehaviorDefaultWarning(
      {
        name: 'orders',
        load: {},
      },
      'strict'
    );

    expect(warning).toMatchObject({
      event: 'schema_behavior.project_default_replaced',
      attributes: {
        resource: 'orders',
        project_default_schema_behavior: 'strict',
        replacement_semantics: 'resource_load_replaces_project_default',
        loader_fallback_schema_behavior: 'evolve',
        fallback_can_be_overridden: true,
      },
    });
    expect(warning?.message).toContain('Resource "orders"');
    expect(warning?.message).toContain('strict');
    expect(warning?.message).toContain('replaces project default');
    expect(warning?.message).toContain('falls back to "evolve"');
    expect(warning?.message).toContain('override');
  });

  it('does not warn when the project default or resource override is absent', () => {
    expect(buildSchemaBehaviorDefaultWarning({ name: 'orders' }, 'strict')).toBeUndefined();
    expect(
      buildSchemaBehaviorDefaultWarning(
        { name: 'orders', load: { defaults: { schema_behavior: 'freeze' } } },
        'strict'
      )
    ).toBeUndefined();
    expect(
      buildSchemaBehaviorDefaultWarning({ name: 'orders', load: {} }, undefined)
    ).toBeUndefined();
  });
});

describe('getResourceProgressMetadata', () => {
  it('reports the resolved resource file and authored schema column count', () => {
    expect(
      getResourceProgressMetadata(
        { output: { id: { type: 'integer' }, name: { type: 'string' } } },
        'resources/orders.yml'
      )
    ).toEqual({
      effective_resource_path: path.resolve('resources/orders.yml'),
      schema_column_count: 2,
    });
  });

  it('treats resources without an output block as having zero authored columns', () => {
    expect(getResourceProgressMetadata({}, 'resources/orders.yml').schema_column_count).toBe(0);
  });
});
