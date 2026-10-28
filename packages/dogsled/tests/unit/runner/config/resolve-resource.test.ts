import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  IntegrationsLib,
  ResolvedPipeline,
  ValidationIssue,
} from '../../../../src/runner/config/loader.js';
import { openDogsledProject } from '../../../../src/runner/config/project-files.js';
import {
  validateResourceResolution,
  validateResourceSourceAlignment,
} from '../../../../src/runner/config/resolve-resource.js';

function makeLib(): IntegrationsLib {
  return {
    getIntegration: () => {
      throw new Error('not used in these tests');
    },
    getResources: () => [],
    listEntities: () => [],
    getEntityVariants: () => [],
  };
}

function makePipeline(name: string): ResolvedPipeline {
  return {
    name: 'p',
    schedule: 'daily',
    cron: '0 0 * * *',
    trigger: 'cron',
    source: 'linear',
    destinationNames: ['warehouse'],
    resources: [{ name }],
    tablePrefix: 'p__',
    enabled: true,
    runner: 'managed',
  };
}

describe('validateResourceResolution — path traversal containment', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-resolve-resource-'));
    fs.mkdirSync(path.join(projectRoot, 'resources', 'linear'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('rejects path-like names that escape the source root via ..', () => {
    const errors: ValidationIssue[] = [];
    const warnings: string[] = [];
    validateResourceResolution(
      makePipeline('../../etc/passwd'),
      makeLib(),
      openDogsledProject(projectRoot),
      errors,
      warnings
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/escapes resources\/linear\//);
  });

  it('rejects Windows backslash traversal in path-like names', () => {
    const errors: ValidationIssue[] = [];
    const warnings: string[] = [];
    validateResourceResolution(
      makePipeline('..\\..\\etc\\passwd'),
      makeLib(),
      openDogsledProject(projectRoot),
      errors,
      warnings
    );

    expect(errors).toHaveLength(1);
    // The exact branch (traversal vs not-found) depends on platform path
    // semantics; what matters is the canonical not-found-or-traversal error
    // fires instead of the path landing outside the source root.
    expect(errors[0]?.message).toMatch(/escapes resources\/linear\/|not found at/);
  });

  it('accepts legitimate nested project-local paths under the source root', () => {
    fs.mkdirSync(path.join(projectRoot, 'resources', 'linear', 'custom'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'resources', 'linear', 'custom', 'issues.yml'),
      'type: resource\nname: issues\n'
    );

    const errors: ValidationIssue[] = [];
    const warnings: string[] = [];
    validateResourceResolution(
      makePipeline('custom/issues'),
      makeLib(),
      openDogsledProject(projectRoot),
      errors,
      warnings
    );

    expect(errors).toEqual([]);
  });
});

describe('validateResourceSourceAlignment — traversal containment', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-resolve-resource-'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('silently skips traversal names — no spurious cross-check, validateResourceResolution owns the error', () => {
    const errors: ValidationIssue[] = [];
    validateResourceSourceAlignment(
      makePipeline('../escape'),
      openDogsledProject(projectRoot),
      errors
    );

    // No cross-check error here; the canonical traversal error is emitted by
    // validateResourceResolution which runs alongside this validator.
    expect(errors).toEqual([]);
  });
});
