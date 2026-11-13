import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { CommandError } from '@bobsled-inc/protocol';

const projectIndex = vi.hoisted(() => ({
  root: '/project-root',
  entries: [],
  unrecognized: [],
  issues: [],
}));

vi.mock('@bobsled-inc/project-index', () => ({
  resolveProjectIndex: vi.fn(() => projectIndex),
}));

vi.mock('../../../src/lib/action-registry.js', () => ({
  loadBuiltInActions: vi.fn(),
  findAction: vi.fn(),
  filterActions: vi.fn(),
}));

vi.mock('../../../src/lib/action-executor.js', () => ({
  executeAction: vi.fn(),
}));

vi.mock('../../../src/lib/action-paths.js', () => ({
  resolveActionProjectRoot: vi.fn(() => '/project-root'),
}));

vi.mock('../../../src/lib/output/formatter.js', () => ({
  toOutputOptions: vi.fn(() => ({
    json: false,
    quiet: false,
    verbose: false,
    noColor: true,
  })),
  output: vi.fn(),
  info: vi.fn(),
  table: vi.fn(),
}));

import { resolveProjectIndex } from '@bobsled-inc/project-index';

import { registerActCommand } from '../../../src/commands/act.js';
import { executeAction } from '../../../src/lib/action-executor.js';
import { resolveActionProjectRoot } from '../../../src/lib/action-paths.js';
import { filterActions, findAction, loadBuiltInActions } from '../../../src/lib/action-registry.js';
import * as fmt from '../../../src/lib/output/formatter.js';

import type { Action } from '../../../src/lib/action-registry.js';

function makeAction(): Action {
  return {
    name: 'upsert_contact',
    qualifiedName: 'salesforce/upsert_contact',
    integration: 'salesforce',
    transport: 'api',
    tags: ['crm'],
    description: 'Upsert a contact',
    inputs: {
      email: { type: 'string', required: true },
    },
    spec: {
      spec_version: '1',
      type: 'action',
      transport: 'api',
      name: 'upsert_contact',
      integration: 'salesforce',
      tags: ['crm'],
      description: 'Upsert a contact',
      api: {
        endpoint: '/contacts/${{ input.email }}',
        method: 'PATCH',
      },
      input: {
        email: { type: 'string', required: true },
      },
      field_mapping: {
        fields: {
          email: 'email',
        },
      },
      activate: {
        operation: 'upsert',
        identity: {
          fields: ['email'],
          strategy: 'external_id',
        },
      },
      error_handling: {
        on_record_error: 'skip',
        consecutive_failure_threshold: 10,
        max_retries: 3,
      },
    },
    filePath: '/tmp/upsert_contact.yml',
  };
}

function createProgram(): Command {
  const program = new Command();
  program.option('--json', '', false);
  program.option('--verbose', '', false);
  program.option('--quiet', '', false);
  program.option('--no-color', '', true);
  program.option('--project-root <path>');
  registerActCommand(program);
  return program;
}

async function runActCommand(args: string[]): Promise<void> {
  const program = createProgram();
  await program.parseAsync(['act', ...args], { from: 'user' });
}

describe('act command', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(fmt.toOutputOptions).mockReturnValue({
      json: false,
      quiet: false,
      verbose: false,
      noColor: true,
    });
    vi.mocked(loadBuiltInActions).mockReturnValue([makeAction()]);
    vi.mocked(filterActions).mockReturnValue([makeAction()]);
    vi.mocked(findAction).mockReturnValue({
      kind: 'found',
      action: makeAction(),
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('wraps invalid --input syntax in a CommandError', async () => {
    const error = await runActCommand(['salesforce/upsert_contact', '--input', 'missing_equals'])
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({
      message: 'Invalid --input format "missing_equals". Expected key=value.',
      exitCode: 2,
    });
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('passes the selected project root to action discovery', async () => {
    await runActCommand(['--list', '--project-root', '/tmp/selected-project']);

    expect(resolveActionProjectRoot).toHaveBeenCalledWith(undefined, '/tmp/selected-project');
    expect(resolveProjectIndex).toHaveBeenCalledWith('/project-root');
  });

  it('uses exit code 2 for validation failures', async () => {
    vi.mocked(executeAction).mockResolvedValue({
      status: 'failed',
      action: 'salesforce/upsert_contact',
      transport: 'api',
      attempted_at: '2026-04-23T00:00:00.000Z',
      duration_ms: 0,
      error: {
        code: 'validation_error',
        message: 'email is required',
        retryable: false,
      },
    });

    await runActCommand(['salesforce/upsert_contact', '--input', 'email=alice@example.com']);

    expect(process.exitCode).toBe(2);
    expect(fmt.output).toHaveBeenCalledOnce();
  });

  it('uses the resolved project root for local action discovery and execution', async () => {
    vi.mocked(executeAction).mockResolvedValue({
      status: 'success',
      action: 'salesforce/upsert_contact',
      transport: 'api',
      attempted_at: '2026-04-23T00:00:00.000Z',
      duration_ms: 5,
    });

    await runActCommand(['salesforce/upsert_contact', '--input', 'email=alice@example.com']);

    expect(resolveProjectIndex).toHaveBeenCalledWith('/project-root');
    expect(loadBuiltInActions).toHaveBeenCalledWith(projectIndex);
    expect(executeAction).toHaveBeenCalledWith(
      makeAction(),
      { email: 'alice@example.com' },
      {
        dryRun: false,
        projectRoot: '/project-root',
        index: projectIndex,
      }
    );
  });

  it('surfaces ambiguous bare action names as CommandErrors', async () => {
    vi.mocked(findAction).mockReturnValue({
      kind: 'ambiguous',
      actions: [
        { ...makeAction(), qualifiedName: 'hubspot/upsert_contact', integration: 'hubspot' },
        makeAction(),
      ],
    });

    const error = await runActCommand(['upsert_contact'])
      .then(() => undefined)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({
      message:
        'Action name "upsert_contact" is ambiguous. Use one of: hubspot/upsert_contact, salesforce/upsert_contact',
      exitCode: 2,
    });
  });
});
