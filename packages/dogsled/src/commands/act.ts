import type { Command } from 'commander';

import { parseInputFlags } from '@bobsled-inc/extractor/runtime';
import { getIntegrationsDir } from '@bobsled-inc/integrations';
import { resolveProjectIndex } from '@bobsled-inc/project-index';
import { CommandError } from '@bobsled-inc/protocol';
import YAML from 'yaml';

import { executeAction } from '../lib/action-executor.js';
import { resolveActionProjectRoot } from '../lib/action-paths.js';
import { filterActions, findAction, loadActions } from '../lib/action-registry.js';
import * as fmt from '../lib/output/formatter.js';

import type { Action } from '../lib/action-registry.js';
import type { GlobalOptions } from '../types/index.js';

interface ActOptions {
  projectRoot?: string;
  input?: string[];
  inputJson?: string;
  dryRun?: boolean;
  list?: boolean;
  describe?: boolean;
  integration?: string;
  tag?: string[];
  yaml?: boolean;
}

function collectValue(value: string, previous: string[] = []): string[] {
  previous.push(value);
  return previous;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new CommandError('Invalid JSON supplied to --input-json. Expected an object.', 2);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CommandError('The value supplied to --input-json must be a JSON object.', 2);
  }

  return parsed as Record<string, unknown>;
}

function resolveInputs(options: ActOptions): Record<string, unknown> {
  if (options.inputJson && options.input && options.input.length > 0) {
    throw new CommandError('Use either --input or --input-json, not both.', 2);
  }

  if (options.inputJson) {
    return parseJsonObject(options.inputJson);
  }

  try {
    return parseInputFlags(options.input ?? []);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Invalid --input format. Expected key=value.';
    throw new CommandError(message, 2);
  }
}

function emitStructured(
  value: unknown,
  outputOpts: ReturnType<typeof fmt.toOutputOptions>,
  yaml?: boolean
): void {
  if (yaml) {
    fmt.output(YAML.stringify(value, { lineWidth: 120 }).trimEnd(), { ...outputOpts, json: false });
    return;
  }
  if (outputOpts.json) {
    fmt.output(value, outputOpts);
    return;
  }

  fmt.output(JSON.stringify(value, null, 2), outputOpts);
}

function emitActionList(
  actions: Action[],
  outputOpts: ReturnType<typeof fmt.toOutputOptions>,
  yaml?: boolean
): void {
  const payload = actions.map((action) => ({
    name: action.qualifiedName,
    description: action.description,
    integration: action.integration,
    transport: action.transport,
    tags: action.tags,
    required_inputs: Object.entries(action.inputs)
      .filter(([, value]) => value.required)
      .map(([key]) => key),
  }));

  if (yaml) {
    fmt.output(YAML.stringify(payload, { lineWidth: 120 }).trimEnd(), {
      ...outputOpts,
      json: false,
    });
    return;
  }

  if (outputOpts.json) {
    fmt.output(payload, outputOpts);
    return;
  }

  if (actions.length === 0) {
    fmt.info('No actions found.', outputOpts);
    return;
  }

  fmt.table(
    ['Name', 'Transport', 'Integration', 'Tags', 'Required Inputs'],
    actions.map((action) => [
      action.qualifiedName,
      action.transport,
      action.integration ?? '',
      action.tags.join(', '),
      Object.entries(action.inputs)
        .filter(([, value]) => value.required)
        .map(([key]) => key)
        .join(', '),
    ]),
    outputOpts
  );
}

async function actHandler(
  actionName: string | undefined,
  localOptions: ActOptions,
  globalOptions: GlobalOptions
): Promise<void> {
  const outputOpts = fmt.toOutputOptions(globalOptions);
  const projectRoot = resolveActionProjectRoot(
    globalOptions.config,
    localOptions.projectRoot ?? globalOptions.projectRoot
  );
  const index = resolveProjectIndex(projectRoot);
  const actions = loadActions(getIntegrationsDir(), index);

  if (localOptions.list) {
    emitActionList(
      filterActions(actions, {
        integration: localOptions.integration,
        tags: localOptions.tag,
      }),
      outputOpts,
      localOptions.yaml
    );
    return;
  }

  if (!actionName) {
    throw new CommandError('Action name required. Use --list to see available actions.', 2);
  }

  const actionResult = findAction(actions, actionName);
  if (actionResult.kind === 'not_found') {
    throw new CommandError(`Action not found: ${actionName}`, 2);
  }

  if (actionResult.kind === 'ambiguous') {
    throw new CommandError(
      `Action name "${actionName}" is ambiguous. Use one of: ${actionResult.actions
        .map((action) => action.qualifiedName)
        .join(', ')}`,
      2
    );
  }
  const action = actionResult.action;

  if (localOptions.describe) {
    emitStructured(
      {
        name: action.qualifiedName,
        description: action.description,
        transport: action.transport,
        integration: action.integration,
        tags: action.tags,
        inputs: action.inputs,
      },
      outputOpts,
      localOptions.yaml
    );
    return;
  }

  const result = await executeAction(action, resolveInputs(localOptions), {
    dryRun: localOptions.dryRun,
    projectRoot,
    index,
  });
  emitStructured(result, outputOpts, localOptions.yaml);

  if (result.status === 'failed') {
    process.exitCode = result.error?.code === 'validation_error' ? 2 : 1;
    return;
  }
}

/** Registers the `dogsled act` command for listing, describing, and executing actions. */
export function registerActCommand(program: Command): void {
  program
    .command('act [action]')
    .description('Execute an action from the Dogsled action registry')
    .option('--input <key=value>', 'Input key-value pairs', collectValue)
    .option('--input-json <json>', 'Input as a JSON object')
    .option('--dry-run', 'Validate and build the request without executing it', false)
    .option('--list', 'List available actions')
    .option('--describe', 'Show the action schema for the specified action')
    .option('--integration <name>', 'Filter by integration when listing actions')
    .option('--tag <tag>', 'Filter by tag when listing actions', collectValue)
    .option('--yaml', 'Emit structured output as YAML')
    .option('--project-root <path>', 'Dogsled Project root (default: current directory)')
    .action(async (actionName: string | undefined, localOptions: ActOptions) => {
      const globalOptions = program.opts<GlobalOptions>();
      await actHandler(actionName, localOptions, globalOptions);
    });
}
