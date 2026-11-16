import * as path from 'node:path';

import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const formatter = vi.hoisted(() => ({
  toOutputOptions: vi.fn((options) => options),
  output: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

const loader = vi.hoisted(() => ({
  resolveCliBobsledProject: vi.fn(),
  loadBobsledConfig: vi.fn(),
  validateBobsledConfig: vi.fn(),
}));
const projectResolver = vi.hoisted(() => ({
  loadProjectPipelineConfig: vi.fn(),
  validateProjectPipelines: vi.fn(),
}));

vi.mock('../../../../src/lib/output/formatter.js', () => formatter);
vi.mock('../../../../src/runner/config/loader.js', () => loader);
vi.mock('../../../../src/runner/config/cli-project-location.js', () => ({
  resolveCliBobsledProject: loader.resolveCliBobsledProject,
}));
vi.mock('../../../../src/runner/config/project-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/runner/config/project-resolver.js')>()),
  ...projectResolver,
}));

import { registerRunnerValidateCommand } from '../../../../src/runner/commands/validate.js';
import { resolveCliBobsledProject } from '../../../../src/runner/config/cli-project-location.js';
import { loadBobsledConfig, validateBobsledConfig } from '../../../../src/runner/config/loader.js';

function createProgram(): Command {
  const program = new Command();
  program.option('--json', '', false);
  program.option('--verbose', '', false);
  program.option('--quiet', '', false);
  program.option('--no-color', '', false);
  registerRunnerValidateCommand(program.command('runner'));
  return program;
}

describe('registerRunnerValidateCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    projectResolver.loadProjectPipelineConfig.mockImplementation(
      ({ projectRoot, configPath }: { projectRoot: string; configPath?: string }) => ({
        config: loader.loadBobsledConfig(configPath),
        configPaths: configPath ? [path.relative(projectRoot, configPath)] : [],
        pipelinePathByName: new Map(),
        destinationPathByName: new Map(),
        sectionPathByName: new Map(),
      })
    );
    vi.mocked(resolveCliBobsledProject).mockImplementation((options) => {
      const resolved = options.configPath ?? '/tmp/dogsled.yml';
      const projectRoot = options.projectRoot ?? path.dirname(resolved);
      return { projectRoot, configPaths: [resolved] };
    });
    vi.mocked(loadBobsledConfig).mockReturnValue({
      destination: { type: 'duckdb', db_path: './data.duckdb' },
      pipelines: { stripe: 'hourly' },
    });
    projectResolver.validateProjectPipelines.mockImplementation(
      async ({
        projectRoot,
        index,
        configPath,
      }: {
        projectRoot: string;
        index?: unknown;
        configPath?: string;
      }) => {
        const loaded = projectResolver.loadProjectPipelineConfig({
          projectRoot,
          index,
          configPath,
        });
        const config = loader.loadBobsledConfig(configPath);
        const validation = await loader.validateBobsledConfig(
          config,
          projectRoot,
          undefined,
          index
        );
        return {
          status: validation.valid ? 'valid' : 'invalid',
          warnings: validation.warnings ?? [],
          issues: validation.errors ?? [],
          project: validation.valid
            ? {
                ...loaded,
                projectRoot,
                index,
                config,
                extractPipelines: validation.pipelines ?? [],
                modelPipelines: validation.modelPipelines ?? [],
                entityGraphPipelines: validation.entityGraphPipelines ?? [],
                secrets: validation.secrets ?? [],
              }
            : undefined,
        };
      }
    );
  });

  it('honors inherited JSON mode when choosing output format', async () => {
    const result = {
      valid: true,
      errors: [],
      warnings: [],
      secrets: [],
      pipelines: [],
      modelPipelines: [],
      entityGraphPipelines: [],
    };
    vi.mocked(validateBobsledConfig).mockResolvedValue(result);

    await createProgram().parseAsync(['--json', 'runner', 'validate'], {
      from: 'user',
    });

    expect(formatter.output).toHaveBeenCalledWith(result, expect.objectContaining({ json: true }));
    expect(formatter.success).not.toHaveBeenCalled();
  });

  it('does not emit a success banner when strict mode fails on warnings', async () => {
    vi.mocked(validateBobsledConfig).mockResolvedValue({
      valid: true,
      errors: [],
      warnings: ['warn'],
      secrets: [],
      pipelines: [],
      modelPipelines: [],
    });

    await createProgram().parseAsync(['runner', 'validate', '--strict'], {
      from: 'user',
    });

    expect(formatter.success).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });
});
