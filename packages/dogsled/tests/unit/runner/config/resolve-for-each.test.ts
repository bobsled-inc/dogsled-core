import { indexProjectFiles } from '@bobsled-inc/project-index';
import { describe, expect, it } from 'vitest';

import type { IntegrationsLib, ValidationIssue } from '../../../../src/runner/config/loader.js';
import type { DogsledProject } from '../../../../src/runner/config/project-files.js';
import {
  enrichForEachParents,
  validateForEachIteration,
} from '../../../../src/runner/config/resolve-for-each.js';
import { resolveEntityVariant } from '../../../../src/runner/config/resolve-entity.js';
import { generatePipelineManifestFiles } from '../../../../src/runner/pipeline-manifest/generate.js';
import type { DogsledConfig } from '../../../../src/runner/config/schema.js';
import { makePipeline } from '../fixtures.js';

const emptyConfig = { destinations: {}, pipelines: {} } as unknown as DogsledConfig;
const emptyProject: DogsledProject = {
  root: '/project',
  index: indexProjectFiles([]),
  resourcesFolder: 'resources',
};

interface ManifestNode {
  resource: string;
  resources: string[];
  command: string[];
}

function parseManifest(files: Array<{ content: string }>): {
  pipelines: Array<{ nodes: ManifestNode[] }>;
} {
  return JSON.parse(files[0]!.content) as { pipelines: Array<{ nodes: ManifestNode[] }> };
}

describe('Notion REST for_each resolution', () => {
  it('resolves and co-schedules bundled page children without project files', () => {
    const lib: IntegrationsLib = {
      getIntegration() {
        return {
          meta: { auth_setup: [] },
          resource_names: ['pages_rest', 'blocks', 'comments_rest'],
          transports: [{ id: 'mcp' }, { id: 'rest' }],
          default_transport: 'rest',
        };
      },
      getResources() {
        return [
          { resource: { name: 'pages_rest', extract: {} } },
          {
            resource: {
              name: 'blocks',
              extract: { for_each: { resource: 'pages_rest', field: 'id', input: 'block_id' } },
            },
          },
          {
            resource: {
              name: 'comments_rest',
              extract: { for_each: { resource: 'pages_rest', field: 'id', input: 'block_id' } },
            },
          },
        ] as unknown as ReturnType<IntegrationsLib['getResources']>;
      },
      listEntities() {
        return ['pages', 'blocks', 'comments'];
      },
      getEntityVariants(_source, entity) {
        if (entity === 'pages') return [{ name: 'pages_rest', via: 'rest' }];
        if (entity === 'blocks') return [{ name: 'blocks', via: 'rest' }];
        if (entity === 'comments') return [{ name: 'comments_rest', via: 'rest' }];
        return [];
      },
    };
    const pipeline = makePipeline({
      name: 'notion_bq',
      source: 'notion',
      via: 'rest',
      resources: [{ name: 'pages' }, { name: 'blocks' }, { name: 'comments' }],
      runner: 'managed',
    });
    const errors: ValidationIssue[] = [];

    resolveEntityVariant(pipeline, lib, emptyProject, errors);
    expect(errors).toEqual([]);
    expect(pipeline.resources).toMatchObject([
      { name: 'pages_rest', requestedName: 'pages' },
      { name: 'blocks' },
      { name: 'comments_rest', requestedName: 'comments' },
    ]);

    enrichForEachParents([pipeline], lib, emptyProject);
    expect(pipeline.resources).toMatchObject([
      { name: 'pages_rest' },
      { name: 'blocks', forEachParent: 'pages_rest' },
      { name: 'comments_rest', forEachParent: 'pages_rest' },
    ]);
    validateForEachIteration(pipeline, lib, emptyProject, errors);
    expect(errors).toEqual([]);

    const manifest = parseManifest(
      generatePipelineManifestFiles(emptyConfig, [pipeline], { integrations: lib })
    );
    expect(manifest.pipelines[0]!.nodes).toEqual([
      expect.objectContaining({
        resource: 'pages_rest',
        resources: ['pages_rest', 'blocks', 'comments_rest'],
        command: [
          'runner',
          'run',
          'notion_bq',
          '--resource',
          'pages_rest',
          'blocks',
          'comments_rest',
          '--json',
        ],
      }),
    ]);
  });

  it('keeps explicitly targeted REST children independent from pages', () => {
    const lib: IntegrationsLib = {
      getIntegration() {
        return {
          meta: { auth_setup: [] },
          resource_names: ['pages_rest', 'blocks', 'comments_rest'],
          transports: [{ id: 'rest' }],
          default_transport: 'rest',
        };
      },
      getResources() {
        return [
          { resource: { name: 'pages_rest', extract: {} } },
          {
            resource: {
              name: 'blocks',
              extract: { for_each: { resource: 'pages_rest', field: 'id', input: 'block_id' } },
            },
          },
          {
            resource: {
              name: 'comments_rest',
              extract: { for_each: { resource: 'pages_rest', field: 'id', input: 'block_id' } },
            },
          },
        ] as unknown as ReturnType<IntegrationsLib['getResources']>;
      },
      listEntities() {
        return ['pages', 'blocks', 'comments'];
      },
      getEntityVariants(_source, entity) {
        if (entity === 'pages') return [{ name: 'pages_rest', via: 'rest' }];
        if (entity === 'blocks') return [{ name: 'blocks', via: 'rest' }];
        if (entity === 'comments') return [{ name: 'comments_rest', via: 'rest' }];
        return [];
      },
    };
    const pipeline = makePipeline({
      name: 'notion_targets',
      source: 'notion',
      via: 'rest',
      resources: [
        { name: 'blocks', override: { inputs: { block_id: 'block-target' } } },
        { name: 'comments', override: { inputs: { block_id: 'comment-target' } } },
      ],
      runner: 'managed',
    });
    const errors: ValidationIssue[] = [];

    resolveEntityVariant(pipeline, lib, emptyProject, errors);
    validateForEachIteration(pipeline, lib, emptyProject, errors);
    enrichForEachParents([pipeline], lib, emptyProject);

    expect(errors).toEqual([]);
    expect(pipeline.resources).toMatchObject([
      { name: 'blocks', override: { inputs: { block_id: 'block-target' } } },
      {
        name: 'comments_rest',
        requestedName: 'comments',
        override: { inputs: { block_id: 'comment-target' } },
      },
    ]);
    expect(pipeline.resources.every((resource) => resource.forEachParent === undefined)).toBe(true);

    const manifest = parseManifest(
      generatePipelineManifestFiles(emptyConfig, [pipeline], { integrations: lib })
    );
    expect(manifest.pipelines[0]!.nodes).toEqual([
      expect.objectContaining({ resource: 'blocks', resources: ['blocks'] }),
      expect.objectContaining({ resource: 'comments_rest', resources: ['comments_rest'] }),
    ]);
  });

  it('uses pipeline-level inputs to target REST children without pages', () => {
    const lib: IntegrationsLib = {
      getIntegration: () => ({
        meta: { auth_setup: [] },
        resource_names: ['pages_rest', 'blocks'],
        transports: [{ id: 'rest' }],
        default_transport: 'rest',
      }),
      getResources: () =>
        [
          { resource: { name: 'pages_rest', extract: {} } },
          {
            resource: {
              name: 'blocks',
              extract: { for_each: { resource: 'pages_rest', field: 'id', input: 'block_id' } },
            },
          },
        ] as unknown as ReturnType<IntegrationsLib['getResources']>,
      listEntities: () => ['pages', 'blocks'],
      getEntityVariants: (_source, entity) =>
        entity === 'pages'
          ? [{ name: 'pages_rest', via: 'rest' }]
          : entity === 'blocks'
            ? [{ name: 'blocks', via: 'rest' }]
            : [],
    };
    const pipeline = makePipeline({
      name: 'notion_pipeline_target',
      source: 'notion',
      via: 'rest',
      inputs: { block_id: 'pipeline-target' },
      resources: [{ name: 'blocks' }],
      runner: 'managed',
    });
    const errors: ValidationIssue[] = [];

    resolveEntityVariant(pipeline, lib, emptyProject, errors);
    validateForEachIteration(pipeline, lib, emptyProject, errors);
    enrichForEachParents([pipeline], lib, emptyProject);

    expect(errors).toEqual([]);
    expect(pipeline.resources[0]?.forEachParent).toBeUndefined();
    const manifest = parseManifest(
      generatePipelineManifestFiles(emptyConfig, [pipeline], { integrations: lib })
    );
    expect(manifest.pipelines[0]!.nodes).toEqual([
      expect.objectContaining({ resource: 'blocks', resources: ['blocks'] }),
    ]);
  });

  it('combines pipeline and resource inputs before deciding a multi-binding target', () => {
    const lib: IntegrationsLib = {
      getIntegration: () => ({
        meta: { auth_setup: [] },
        resource_names: ['parents', 'children'],
        transports: [{ id: 'rest' }],
        default_transport: 'rest',
      }),
      getResources: () =>
        [
          { resource: { name: 'parents', extract: {} } },
          {
            resource: {
              name: 'children',
              extract: {
                for_each: {
                  resource: 'parents',
                  bindings: [
                    { field: 'workspace_id', input: 'workspace_id' },
                    { field: 'block_id', input: 'block_id' },
                  ],
                },
              },
            },
          },
        ] as unknown as ReturnType<IntegrationsLib['getResources']>,
      listEntities: () => [],
      getEntityVariants: () => [],
    };
    const pipeline = makePipeline({
      name: 'mixed_target',
      source: 'custom',
      inputs: { workspace_id: 'pipeline-workspace', block_id: 'pipeline-block' },
      resources: [
        {
          name: 'children',
          override: { inputs: { block_id: 'resource-block' } },
        },
      ],
      runner: 'managed',
    });
    const partial = makePipeline({
      name: 'partial_target',
      source: 'custom',
      inputs: { workspace_id: 'pipeline-workspace' },
      resources: [{ name: 'children' }],
      runner: 'managed',
    });
    const partialErrors: ValidationIssue[] = [];
    validateForEachIteration(partial, lib, emptyProject, partialErrors);
    expect(partialErrors).toEqual([
      expect.objectContaining({ message: expect.stringContaining('parent must run') }),
    ]);

    const errors: ValidationIssue[] = [];

    validateForEachIteration(pipeline, lib, emptyProject, errors);
    enrichForEachParents([pipeline], lib, emptyProject);

    expect(errors).toEqual([]);
    expect(pipeline.resources[0]?.forEachParent).toBeUndefined();
    const manifest = parseManifest(
      generatePipelineManifestFiles(emptyConfig, [pipeline], { integrations: lib })
    );
    expect(manifest.pipelines[0]!.nodes).toEqual([
      expect.objectContaining({ resource: 'children', resources: ['children'] }),
    ]);
  });
});
