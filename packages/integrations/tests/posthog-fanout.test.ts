import { describe, expect, it } from 'vitest';

import { getResourcePath, readYamlFile } from '../src/loader.js';
import { ResourceSpecSchema } from '../src/validate.js';

const projectScopedResources = ['events', 'persons', 'event_definitions', 'feature_flags'] as const;

function posthogResource(name: string): Record<string, unknown> {
  return readYamlFile(getResourcePath('posthog', name)) as Record<string, unknown>;
}

describe('posthog project-scoped resources', () => {
  it.each(projectScopedResources)('%s projects the parent project ID into its output', (name) => {
    const resource = ResourceSpecSchema.parse(posthogResource(name));

    expect(resource.extract.for_each).toMatchObject({
      resource: 'projects',
      field: 'id',
      input: 'project_id',
    });
    expect(resource.input['project_id']).toMatchObject({
      type: 'integer',
      required: true,
    });
    expect(resource.output['project_id']).toMatchObject({
      type: 'integer',
      from: {
        resource: 'projects',
        path: '$.id',
      },
    });
  });

  it.each(projectScopedResources)('%s uses a project-scoped primary key', (name) => {
    const resource = ResourceSpecSchema.parse(posthogResource(name));

    expect(resource.extract.table?.primary_key).toEqual(['project_id', 'id']);
  });

  it('supports bounded timestamp filters for incremental event extraction', () => {
    const rawResource = posthogResource('events');
    const resource = ResourceSpecSchema.parse(rawResource);

    expect(resource.query?.filters?.timestamp).toMatchObject({
      operators: ['gte', 'lte'],
      bind: {
        gte: { input: 'after' },
        lte: { input: 'before' },
      },
      compile: {
        gte: { mode: 'http_query', param: 'after' },
        lte: { mode: 'http_query', param: 'before' },
      },
    });
    expect(rawResource['incremental']).toEqual({
      strategy: 'server_filter',
      cursor_field: 'timestamp',
      cursor_type: 'timestamp',
      since_argument: 'after',
      until_argument: 'before',
      value_format: 'iso8601',
      lookback_seconds: 86400,
      initial_lookback_seconds: 2592000,
      window_size_seconds: 86400,
    });
  });
});
