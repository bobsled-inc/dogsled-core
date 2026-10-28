import * as path from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const formatter = vi.hoisted(() => ({
  toOutputOptions: vi.fn((options) => options),
}));

const loader = vi.hoisted(() => ({
  resolveCliDogsledProject: vi.fn(),
}));

const pipelineApi = vi.hoisted(() => ({
  runProjectPipeline: vi.fn().mockResolvedValue({ exitCode: 0 }),
}));

vi.mock('../../../../src/lib/output/formatter.js', () => formatter);
vi.mock('../../../../src/runner/config/loader.js', () => loader);
vi.mock('../../../../src/runner/config/cli-project-location.js', () => ({
  resolveCliDogsledProject: loader.resolveCliDogsledProject,
}));
vi.mock('../../../../src/pipeline/index.js', () => pipelineApi);

import { runProjectPipeline } from '../../../../src/pipeline/index.js';
import { registerRunCommand } from '../../../../src/runner/commands/run.js';
import { resolveCliDogsledProject } from '../../../../src/runner/config/cli-project-location.js';

function createProgram(): Command {
  const program = new Command();
  program.option('--config <path>', '', undefined);
  program.option('--json', '', false);
  program.option('--verbose', '', false);
  program.option('--quiet', '', false);
  program.option('--no-color', '', false);
  registerRunCommand(program.command('runner'));
  return program;
}

describe('registerRunCommand', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    vi.mocked(resolveCliDogsledProject).mockImplementation((options) => {
      const resolved = options.configPath ?? '/tmp/project/dogsled.yml';
      const projectRoot = options.projectRoot ?? path.dirname(resolved);
      return { projectRoot, configPaths: [path.resolve(projectRoot, resolved)] };
    });
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('registers the standard output flags', () => {
    const runner = new Command();
    registerRunCommand(runner);

    const run = runner.commands[0];
    expect(run?.options.map((option) => option.long)).toEqual([
      '--config',
      '--project-root',
      '--full-refresh',
      '--reconcile-schema',
      '--resource',
      '--json',
      '--verbose',
      '--quiet',
    ]);
  });

  it('calls runProjectPipeline with the discovered project root', async () => {
    await createProgram().parseAsync(['runner', 'run', 'stripe'], { from: 'user' });

    expect(runProjectPipeline).toHaveBeenCalledWith({
      projectRoot: '/tmp/project',
      pipelineName: 'stripe',
    });
    expect(runProjectPipeline).toHaveBeenCalledTimes(1);
  });

  it('passes through config-derived flags to runProjectPipeline', async () => {
    await createProgram().parseAsync(
      ['runner', 'run', 'stripe', '--resource', 'charges', '--full-refresh', '--json', '--verbose'],
      { from: 'user' }
    );

    expect(runProjectPipeline).toHaveBeenCalledWith({
      projectRoot: '/tmp/project',
      pipelineName: 'stripe',
      resources: ['charges'],
      fullRefresh: true,
      logFormat: 'json',
      verbose: true,
    });
    expect(runProjectPipeline).toHaveBeenCalledTimes(1);
  });

  it('passes a reconciliation override with full refresh to runProjectPipeline', async () => {
    await createProgram().parseAsync(
      [
        'runner',
        'run',
        'stripe',
        '--resource',
        'charges',
        'customers',
        '--full-refresh',
        '--reconcile-schema',
        'charges',
        'customers',
      ],
      { from: 'user' }
    );

    expect(runProjectPipeline).toHaveBeenCalledWith({
      projectRoot: '/tmp/project',
      pipelineName: 'stripe',
      resources: ['charges', 'customers'],
      fullRefresh: true,
      reconcileSchema: ['charges', 'customers'],
    });
  });

  it('honors the parent --config option when resolving dogsled.yml', async () => {
    await createProgram().parseAsync(
      ['--config', '/tmp/alternate/dogsled.yml', 'runner', 'run', 'stripe'],
      { from: 'user' }
    );

    expect(runProjectPipeline).toHaveBeenCalledWith({
      projectRoot: '/tmp/alternate',
      configPath: '/tmp/alternate/dogsled.yml',
      pipelineName: 'stripe',
    });
    expect(runProjectPipeline).toHaveBeenCalledTimes(1);
    expect(resolveCliDogsledProject).toHaveBeenCalledWith({
      configPath: '/tmp/alternate/dogsled.yml',
      projectRoot: undefined,
    });
  });

  it('passes an explicit project root and root-relative config to the pipeline runner', async () => {
    const program = createProgram();
    await program.parseAsync(
      [
        'runner',
        'run',
        'stripe',
        '--project-root',
        '/tmp/project',
        '--config',
        'settings/pipelines.yml',
      ],
      { from: 'user' }
    );

    expect(resolveCliDogsledProject).toHaveBeenCalledWith({
      configPath: 'settings/pipelines.yml',
      projectRoot: '/tmp/project',
    });
    expect(runProjectPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: '/tmp/project',
        configPath: path.join('/tmp/project', 'settings', 'pipelines.yml'),
      })
    );
  });

  it('writes the returned exit code to process.exitCode', async () => {
    vi.mocked(runProjectPipeline).mockResolvedValueOnce({ exitCode: 2 });

    await createProgram().parseAsync(['runner', 'run', 'stripe'], { from: 'user' });

    expect(process.exitCode).toBe(2);
  });
});
