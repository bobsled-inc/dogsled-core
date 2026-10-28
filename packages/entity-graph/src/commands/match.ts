import * as fs from 'node:fs/promises';

import type { Command } from 'commander';
import { createDialectOption } from '@bobsled-inc/model-spec/shared';
import { CommandError } from '@bobsled-inc/protocol';

import { getEntity } from '../runtime/services/entity-read.js';
import { assignMatch, lookupMatch, stageMatch, type MatchMode } from '../runtime/services/match.js';
import { loadEntityGraphProjectContext } from '../runtime/project-context.js';
import { resolveEntityGraphRunner } from '../runtime/runner-resolver.js';
import { emitEntityGraphPayload, resolveEntityGraphOutputFormat } from './utils.js';

interface AccessPlaneOptions {
  entity: string;
  integration?: string;
  dialect?: string;
  schema?: string;
  runner?: string;
  secrets?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  verbose?: boolean;
  quiet?: boolean;
}

interface MatchOptions extends AccessPlaneOptions {
  input?: string;
  batch?: string;
  mode?: MatchMode;
}

interface GetOptions extends AccessPlaneOptions {
  id: string;
}

function outputFormat(options: { format?: string; json?: boolean; yaml?: boolean }) {
  return resolveEntityGraphOutputFormat({
    format: options.format,
    json: options.json,
    yaml: options.yaml,
    defaultFormat: 'text',
  });
}

async function readJsonRecord(path: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(path, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CommandError(`Failed to read ${path}: ${message}`, 2);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CommandError(`${path} must contain one JSON object.`, 2);
  }
  return parsed as Record<string, unknown>;
}

async function readJsonlRecords(path: string): Promise<Array<Record<string, unknown>>> {
  let content: string;
  try {
    content = await fs.readFile(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CommandError(`Failed to read ${path}: ${message}`, 2);
  }
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CommandError(`Failed to parse ${path}:${index + 1}: ${message}`, 2);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new CommandError(`${path}:${index + 1} must be a JSON object.`, 2);
      }
      return parsed as Record<string, unknown>;
    });
}

async function withAccessPlane<T>(
  options: AccessPlaneOptions,
  fn: (context: {
    spec: Awaited<ReturnType<typeof loadEntityGraphProjectContext>>['specs'][number];
    schema: string;
    dialect: Awaited<ReturnType<typeof loadEntityGraphProjectContext>>['dialect'];
    runner: NonNullable<Awaited<ReturnType<typeof resolveEntityGraphRunner>>>['runner'];
  }) => Promise<T>
): Promise<T> {
  const context = await loadEntityGraphProjectContext({
    entityNames: [options.entity],
    integration: options.integration,
    dialect: options.dialect,
    schema: options.schema,
  });
  const spec = context.specs[0];
  if (!spec) {
    throw new CommandError(`No entity spec found for ${options.entity}.`, 2);
  }
  const runnerHandle = await resolveEntityGraphRunner({
    cwd: context.cwd,
    runnerPath: options.runner,
    integration: context.integration,
    secrets: options.secrets,
    allowLocalRunnerFallback: false,
  });
  if (!runnerHandle?.runner.query) {
    await runnerHandle?.close();
    throw new CommandError(
      'entity-graph access commands require --runner <path> or an integration-backed query runner.',
      2
    );
  }
  try {
    return await fn({
      spec,
      schema: spec.targetSchema ?? context.targetSchema,
      dialect: context.dialect,
      runner: runnerHandle.runner,
    });
  } finally {
    await runnerHandle.close();
  }
}

async function matchHandler(options: MatchOptions): Promise<void> {
  if (!options.input && !options.batch) {
    throw new CommandError(
      'entity-graph match requires --input <record.json> or --batch <records.jsonl>.',
      2
    );
  }
  if (options.input && options.batch) {
    throw new CommandError('--input and --batch are mutually exclusive.', 2);
  }
  const mode = options.mode ?? 'lookup';
  if (mode !== 'lookup' && mode !== 'assign' && mode !== 'stage') {
    throw new CommandError('--mode must be lookup, assign, or stage.', 2);
  }
  const records = options.input
    ? [await readJsonRecord(options.input)]
    : await readJsonlRecords(options.batch!);
  const results = await withAccessPlane(options, async ({ spec, schema, dialect, runner }) => {
    const context = { spec, schema, dialect, runner };
    const outcomes = [];
    for (const record of records) {
      if (mode === 'assign') {
        outcomes.push(await assignMatch(context, record));
      } else if (mode === 'stage') {
        outcomes.push(await stageMatch(context, record));
      } else {
        outcomes.push(await lookupMatch(context, record));
      }
    }
    return outcomes;
  });
  const payload = {
    command: 'entity_graph.match',
    entity: options.entity,
    mode,
    count: results.length,
    results,
  };
  const format = outputFormat(options);
  emitEntityGraphPayload(payload, format, () => {
    const matched = results.filter(Boolean).length;
    return `${mode} ${options.entity}: ${matched}/${results.length} record(s) returned a result.`;
  });
}

async function getHandler(options: GetOptions): Promise<void> {
  const result = await withAccessPlane(options, async ({ schema, dialect, runner }) =>
    getEntity({ runner, schema, dialect }, { entity: options.entity, entityId: options.id })
  );
  const payload = {
    command: 'entity_graph.get',
    entity: options.entity,
    entity_id: options.id,
    result,
  };
  const format = outputFormat(options);
  emitEntityGraphPayload(payload, format, () => {
    if (!result) return `No ${options.entity} entity found for ${options.id}.`;
    return `${options.entity} ${options.id}`;
  });
}

export function registerMatchCommand(parent: Command): void {
  parent
    .command('match')
    .description('Lookup, assign, or stage records against an entity graph')
    .requiredOption('--entity <name>', 'Entity name')
    .option('--input <path>', 'JSON record to match')
    .option('--batch <path>', 'JSONL records to match')
    .option('--mode <mode>', 'lookup, assign, or stage', 'lookup')
    .option('--integration <name>', 'Integration handle to use')
    .addOption(createDialectOption())
    .option('--schema <schema>', 'Target schema override')
    .option('--runner <path>', 'SQL runner module with run/query')
    .option('--secrets <path>', 'Secrets file for integration-backed runners')
    .option('--format <format>', 'Output format: text, json, yaml')
    .option('--json', 'Emit JSON output')
    .option('--yaml', 'Emit YAML output')
    .option('--verbose', 'Enable verbose output')
    .option('--quiet', 'Suppress non-error output')
    .action(async (options: MatchOptions) => {
      await matchHandler(options);
    });
}

export function registerGetCommand(parent: Command): void {
  parent
    .command('get')
    .description('Read a golden entity by entity ID')
    .requiredOption('--entity <name>', 'Entity name')
    .requiredOption('--id <entity_id>', 'Entity ID')
    .option('--integration <name>', 'Integration handle to use')
    .addOption(createDialectOption())
    .option('--schema <schema>', 'Target schema override')
    .option('--runner <path>', 'SQL runner module with run/query')
    .option('--secrets <path>', 'Secrets file for integration-backed runners')
    .option('--format <format>', 'Output format: text, json, yaml')
    .option('--json', 'Emit JSON output')
    .option('--yaml', 'Emit YAML output')
    .option('--verbose', 'Enable verbose output')
    .option('--quiet', 'Suppress non-error output')
    .action(async (options: GetOptions) => {
      await getHandler(options);
    });
}
