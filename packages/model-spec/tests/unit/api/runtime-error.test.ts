import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CommandError,
  BobsledRuntimeError,
  loadProject,
  validateProject,
} from '../../../src/api/index.js';
import type { LoadedProject } from '../../../src/api/load-project.js';
import type { MetricSpec } from '../../../src/entities/metric.js';
import type { VqSpec } from '../../../src/entities/vq.js';

function projectWithMetadata(metadata: {
  metrics?: Map<string, MetricSpec>;
  vqs?: Map<string, VqSpec>;
}): LoadedProject {
  return {
    cwd: '/tmp/model-spec-runtime-error',
    config: {} as LoadedProject['config'],
    integrations: new Map(),
    sources: new Map(),
    sourceColumns: new Map(),
    sourceEntries: new Map(),
    models: [],
    entities: {
      metrics: metadata.metrics ?? new Map(),
      relationships: new Map(),
      entityRelationships: new Map(),
      vqs: metadata.vqs ?? new Map(),
    },
    warnings: [],
  };
}

describe('model-spec runtime failure boundary', () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const path of paths.splice(0)) rmSync(path, { force: true, recursive: true });
  });

  it('wraps a CommandError from a real project load', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dogsled-runtime-error-'));
    paths.push(cwd);
    writeFileSync(join(cwd, 'model-spec.yml'), 'unknown_key: true\n');

    const result = await loadProject(cwd).catch((error) => error);

    expect(result).toMatchObject({
      kind: 'validation',
      code: 'MODEL_PROJECT_LOAD_VALIDATION_FAILED',
      operation: 'model.project.load',
      retryable: false,
      message: 'Dogsled could not validate the request.',
    });
    expect((result as BobsledRuntimeError).cause).toBeInstanceOf(CommandError);
    expect((result as BobsledRuntimeError).cause).toMatchObject({ exitCode: 2 });
  });

  it('wraps a native filesystem error from a real project load', async () => {
    const cwd = join(mkdtempSync(join(tmpdir(), 'dogsled-runtime-error-')), 'not-a-directory');
    paths.push(join(cwd, '..'));
    writeFileSync(cwd, 'not a directory');

    const result = await loadProject(cwd).catch((error) => error);

    expect(result).toMatchObject({
      kind: 'internal',
      code: 'MODEL_PROJECT_LOAD_FILESYSTEM_ENOTDIR',
      operation: 'model.project.load',
      retryable: false,
      message: 'Dogsled could not complete the operation.',
    });
    expect((result as BobsledRuntimeError).cause).toMatchObject({ code: 'ENOTDIR' });
  });

  it('wraps public metadata validation failures with the validate operation', async () => {
    const metric: MetricSpec = {
      spec_version: '0.2',
      type: 'metric',
      name: 'orders_total',
      expression: 'SUM(amount)',
      model: 'missing_model',
    };

    const result = await validateProject('/tmp/model-spec-runtime-error', {
      project: projectWithMetadata({ metrics: new Map([['orders_total', metric]]) }),
    }).catch((error) => error);

    expect(result).toBeInstanceOf(BobsledRuntimeError);
    expect(result).toMatchObject({
      kind: 'validation',
      code: 'MODEL_PROJECT_VALIDATE_VALIDATION_FAILED',
      operation: 'model.project.validate',
      retryable: false,
      message: 'Dogsled could not validate the request.',
    });
    expect((result as BobsledRuntimeError).cause).toMatchObject({ exitCode: 2 });
  });

  it('keeps an operational metadata failure out of the validation class', async () => {
    const vqs = new Map<string, VqSpec>([
      [
        'broken',
        {
          spec_version: '0.2',
          type: 'vq',
          name: 'broken',
          nlq: 'broken',
          sql: 'SELECT 1',
        },
      ],
    ]);
    vqs.values = () => {
      throw new Error('metadata registry read failed');
    };

    const result = await validateProject('/tmp/model-spec-runtime-error', {
      project: projectWithMetadata({ vqs }),
    }).catch((error) => error);

    expect(result).toMatchObject({
      kind: 'internal',
      code: 'MODEL_PROJECT_VALIDATE_FAILURE',
      operation: 'model.project.validate',
      retryable: false,
      message: 'Dogsled could not complete the operation.',
    });
    expect((result as BobsledRuntimeError).cause).toMatchObject({
      message: 'metadata registry read failed',
    });
  });
});
