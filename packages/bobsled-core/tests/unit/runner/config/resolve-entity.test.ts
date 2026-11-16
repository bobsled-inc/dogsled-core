import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EntityVariantEntry } from '@bobsled-inc/integrations';

import type {
  IntegrationsLib,
  ResolvedPipeline,
  ValidationIssue,
} from '../../../../src/runner/config/loader.js';
import { openBobsledProject } from '../../../../src/runner/config/project-files.js';
import { resolveEntityVariant } from '../../../../src/runner/config/resolve-entity.js';

function makeLib(opts: {
  resourceNames: string[];
  entities: Record<string, EntityVariantEntry[]>;
}): IntegrationsLib {
  return {
    getIntegration: (name) => {
      if (name !== 'linear') throw new Error(`unexpected source ${name}`);
      return {
        meta: {},
        resource_names: opts.resourceNames,
        transports: [{ id: 'graphql' }, { id: 'mcp' }],
        default_transport: 'graphql',
      };
    },
    getResources: () => [],
    listEntities: () => Object.keys(opts.entities).sort(),
    getEntityVariants: (_sourceName, entity) => opts.entities[entity]?.slice() ?? [],
  };
}

function makePipeline(resources: ResolvedPipeline['resources'], via?: string): ResolvedPipeline {
  return {
    name: 'p',
    schedule: 'daily',
    cron: '0 0 * * *',
    trigger: 'cron',
    source: 'linear',
    destinationNames: ['warehouse'],
    resources,
    tablePrefix: 'p__',
    enabled: true,
    runner: 'managed',
    ...(via !== undefined ? { via } : {}),
  };
}

describe('resolveEntityVariant', () => {
  const lib = makeLib({
    resourceNames: ['issues_graphql', 'issues_mcp', 'initiatives', 'documents_v2'],
    entities: {
      // Multi-variant entity — needs a via to disambiguate.
      issues: [
        { name: 'issues_graphql', via: 'graphql' },
        { name: 'issues_mcp', via: 'mcp' },
      ],
      // Single-variant entity where the entity name equals the variant name
      // (the typical legacy shape). Strict-name match wins; entity path is moot.
      initiatives: [{ name: 'initiatives', via: 'graphql' }],
      // Single-variant entity where the entity name differs from the variant
      // name. This is the case where the auto-resolve single-variant fallback
      // earns its keep — `documents` is not in resource_names, so without
      // the fallback we'd error even though there's only one option.
      documents: [{ name: 'documents_v2', via: 'graphql' }],
    },
  });

  let projectRoot: string;
  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-resolve-entity-'));
  });
  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('rewrites entity-named resources to their variant when pipeline via matches', () => {
    const pipeline = makePipeline([{ name: 'issues' }], 'mcp');
    const errors: ValidationIssue[] = [];
    resolveEntityVariant(pipeline, lib, openBobsledProject(projectRoot), errors);

    expect(errors).toEqual([]);
    expect(pipeline.resources[0]?.name).toBe('issues_mcp');
    expect(pipeline.resources[0]?.requestedName).toBe('issues');
  });

  it('prefers per-resource via over pipeline-level via for entity resolution', () => {
    const pipeline = makePipeline([{ name: 'issues', override: { via: 'graphql' } }], 'mcp');
    const errors: ValidationIssue[] = [];
    resolveEntityVariant(pipeline, lib, openBobsledProject(projectRoot), errors);

    expect(errors).toEqual([]);
    expect(pipeline.resources[0]?.name).toBe('issues_graphql');
    expect(pipeline.resources[0]?.requestedName).toBe('issues');
  });

  it('leaves strict-name resources unchanged even when entity index has matches', () => {
    const pipeline = makePipeline([{ name: 'issues_mcp' }], 'graphql');
    const errors: ValidationIssue[] = [];
    resolveEntityVariant(pipeline, lib, openBobsledProject(projectRoot), errors);

    expect(errors).toEqual([]);
    expect(pipeline.resources[0]?.name).toBe('issues_mcp');
    expect(pipeline.resources[0]?.requestedName).toBeUndefined();
  });

  it('auto-resolves single-variant entities when no via is provided', () => {
    // Regression: single-variant entities
    // shouldn't require a via to disambiguate — there's only one option.
    // `documents` is not in resource_names so strict-name lookup misses, and
    // the single-variant fallback picks `documents_v2`.
    const pipeline = makePipeline([{ name: 'documents' }]);
    const errors: ValidationIssue[] = [];
    resolveEntityVariant(pipeline, lib, openBobsledProject(projectRoot), errors);

    expect(errors).toEqual([]);
    expect(pipeline.resources[0]?.name).toBe('documents_v2');
    expect(pipeline.resources[0]?.requestedName).toBe('documents');
  });

  it('errors when the pipeline via mismatches a single-variant entity', () => {
    const pipeline = makePipeline([{ name: 'documents' }], 'mcp');
    const errors: ValidationIssue[] = [];
    resolveEntityVariant(pipeline, lib, openBobsledProject(projectRoot), errors);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/No variant for entity "documents" with via "mcp"/);
    expect(errors[0]?.message).toMatch(/graphql → documents_v2/);
  });

  it('errors when an entity has multiple variants but no via was provided', () => {
    const pipeline = makePipeline([{ name: 'issues' }]);
    const errors: ValidationIssue[] = [];
    resolveEntityVariant(pipeline, lib, openBobsledProject(projectRoot), errors);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('bobsled.yml:pipelines.p.resources.issues');
    expect(errors[0]?.message).toContain('"issues"');
    expect(errors[0]?.message).toMatch(/multiple transport variants/);
    expect(errors[0]?.message).toMatch(/issues_graphql/);
    expect(errors[0]?.message).toMatch(/issues_mcp/);
  });

  it('errors with available variants when via does not match any', () => {
    const pipeline = makePipeline([{ name: 'issues' }], 'rest');
    const errors: ValidationIssue[] = [];
    resolveEntityVariant(pipeline, lib, openBobsledProject(projectRoot), errors);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('bobsled.yml:pipelines.p.resources.issues');
    expect(errors[0]?.message).toMatch(/No variant for entity "issues"/);
    expect(errors[0]?.message).toMatch(/with via "rest"/);
    expect(errors[0]?.message).toMatch(/graphql → issues_graphql/);
    expect(errors[0]?.message).toMatch(/mcp → issues_mcp/);
  });

  it('does not report when no entity is found — leaves the canonical not-found error to step 5', () => {
    const pipeline = makePipeline([{ name: 'bogus_unknown' }], 'mcp');
    const errors: ValidationIssue[] = [];
    resolveEntityVariant(pipeline, lib, openBobsledProject(projectRoot), errors);

    expect(errors).toEqual([]);
    expect(pipeline.resources[0]?.name).toBe('bogus_unknown');
  });

  it('does not rewrite path-like project-local names', () => {
    const pipeline = makePipeline([{ name: 'custom/issues' }], 'mcp');
    const errors: ValidationIssue[] = [];
    resolveEntityVariant(pipeline, lib, openBobsledProject(projectRoot), errors);

    expect(errors).toEqual([]);
    expect(pipeline.resources[0]?.name).toBe('custom/issues');
  });

  it('lets project-local files shadow bundled entity rewrites', () => {
    // Regression: a project-local file at
    // resources/linear/issues.yml should win over bundled `issues` → `issues_mcp`
    // rewriting, so existing project-local overrides keep working.
    fs.mkdirSync(path.join(projectRoot, 'resources', 'linear'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'resources', 'linear', 'issues.yml'),
      'type: resource\nname: issues\n'
    );

    const pipeline = makePipeline([{ name: 'issues' }], 'mcp');
    const errors: ValidationIssue[] = [];
    resolveEntityVariant(pipeline, lib, openBobsledProject(projectRoot), errors);

    expect(errors).toEqual([]);
    expect(pipeline.resources[0]?.name).toBe('issues');
    expect(pipeline.resources[0]?.requestedName).toBeUndefined();
  });

  it('returns early without errors when the source is unknown', () => {
    const brokenLib: IntegrationsLib = {
      ...lib,
      getIntegration: () => {
        throw new Error('not found');
      },
    };
    const pipeline = makePipeline([{ name: 'issues' }], 'mcp');
    const errors: ValidationIssue[] = [];
    resolveEntityVariant(pipeline, brokenLib, openBobsledProject(projectRoot), errors);

    expect(errors).toEqual([]);
    expect(pipeline.resources[0]?.name).toBe('issues');
  });
});
