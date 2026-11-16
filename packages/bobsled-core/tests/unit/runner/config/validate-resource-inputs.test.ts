import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ProjectIndexError } from '@bobsled-inc/project-index';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IntegrationsLib, ValidationIssue } from '../../../../src/runner/config/loader.js';
import { openBobsledProject } from '../../../../src/runner/config/project-files.js';
import { validateResourceInputOverrides } from '../../../../src/runner/config/validate-resource-inputs.js';
import { makePipeline } from '../fixtures.js';

describe('validateResourceInputOverrides', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bobsled-resource-inputs-'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeResource(source: string, name: string, input: string): void {
    const directory = path.join(projectRoot, 'resources', source);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, `${name}.yml`),
      `type: resource\nname: ${name}\ninput:\n${input}`,
      'utf8'
    );
  }

  function unavailableCatalog(): IntegrationsLib {
    return {
      getIntegration() {
        throw new Error('project-local source');
      },
      getResources() {
        throw new Error('project-local source');
      },
      listEntities() {
        return [];
      },
      getEntityVariants() {
        return [];
      },
    };
  }

  it('validates targeted inputs against a project-local resource without a bundled source', () => {
    writeResource('custom', 'items', '  account_id:\n    type: string\n');
    const pipeline = makePipeline({
      source: 'custom',
      resources: [{ name: 'items', override: { inputs: { account_id: 'acct_1' } } }],
    });
    const errors: ValidationIssue[] = [];

    validateResourceInputOverrides(
      pipeline,
      unavailableCatalog(),
      openBobsledProject(projectRoot),
      errors
    );

    expect(errors).toEqual([]);
  });

  it('rejects unknown local inputs when the integrations catalog is unavailable', () => {
    writeResource('custom', 'items', '  account_id:\n    type: string\n');
    const pipeline = makePipeline({
      source: 'custom',
      resources: [{ name: 'items', override: { inputs: { acount_id: 'acct_1' } } }],
    });
    const errors: ValidationIssue[] = [];

    validateResourceInputOverrides(pipeline, undefined, openBobsledProject(projectRoot), errors);

    expect(errors).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('Unknown input(s) [acount_id]'),
      }),
    ]);
  });

  it('rejects an unknown targeted input against a project-local shadow schema', () => {
    writeResource('github', 'issues', '  repository:\n    type: string\n');
    const pipeline = makePipeline({
      source: 'github',
      resources: [{ name: 'issues', override: { inputs: { repoistory: 'demo-org/demo-repo' } } }],
    });
    const errors: ValidationIssue[] = [];
    const catalog = {
      ...unavailableCatalog(),
      getResources() {
        return [
          {
            resource: {
              name: 'issues',
              input: { repoistory: { type: 'string' } },
            },
          },
        ] as unknown as ReturnType<IntegrationsLib['getResources']>;
      },
    };

    validateResourceInputOverrides(pipeline, catalog, openBobsledProject(projectRoot), errors);

    expect(errors).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('Unknown input(s) [repoistory]'),
      }),
    ]);
    expect(errors[0]!.message).toContain('Available inputs: repository');
  });

  it('refuses project-local resource symlinks without reading them', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bobsled-resource-outside-'));
    const outsideResource = path.join(outside, 'items.yml');
    fs.writeFileSync(
      outsideResource,
      'type: resource\nname: items\ninput:\n  account_id:\n    type: string\n',
      'utf8'
    );
    const directory = path.join(projectRoot, 'resources', 'custom');
    fs.mkdirSync(directory, { recursive: true });
    fs.symlinkSync(outsideResource, path.join(directory, 'items.yml'));

    try {
      expect(() => openBobsledProject(projectRoot)).toThrow(ProjectIndexError);
      expect(() => openBobsledProject(projectRoot)).toThrow(
        /resources\/custom\/items\.yml: Bobsled Core does not follow symbolic links\./
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
