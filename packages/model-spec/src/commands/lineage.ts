/**
 * `model lineage` command — thin CLI wrapper over `lineageProject`.
 *
 * Lineage graph assembly lives in `../api/lineage-project.ts`. This file owns
 * only arg parsing and ASCII rendering via `renderLineage`.
 */

import type { Command } from 'commander';

import { lineageProject } from '../api/lineage-project.js';
import { renderLineage } from '../compiler/index.js';
import { CommandError } from '../errors.js';
import * as out from '../output.js';

import { createIntegrationOption, parseGlobalFlags } from './common.js';

import type { ColumnLineageEntry, ColumnLineageUpstream, TrustTier } from '../compiler/index.js';
import type {
  LineageProjectIntegrationResult,
  LineageProjectResult,
} from '../api/lineage-project.js';

interface LineageOptions {
  integration?: string;
  json?: boolean;
  yaml?: boolean;
  column?: string;
}

type ColumnFilter = { model: string; column: string };

interface LineageStructuredModel {
  name: string;
  refs: string[];
  source_refs: string[];
  materialization: LineageProjectIntegrationResult['models'][number]['materialization'];
  trust_tier: TrustTier;
  effective_trust_tier: TrustTier | null;
}

interface LineageStructuredIntegration {
  handle: string;
  dialect: LineageProjectIntegrationResult['dialect'];
  models: LineageStructuredModel[];
  column_lineage: ColumnLineageEntry[];
}

interface LineageStructuredPayload {
  command: 'model.lineage';
  executed: string;
  warnings: string[];
  skipped: LineageProjectResult['skipped'];
  integrations: LineageStructuredIntegration[];
}

/**
 * Handles CLI lineage rendering while keeping project assembly inside the API layer.
 */
async function lineageHandler(
  modelNames: string[],
  localOptions: LineageOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  if (localOptions.json && localOptions.yaml) {
    throw new CommandError('--json and --yaml cannot be used together', 2);
  }
  if (localOptions.column && modelNames.length > 0) {
    throw new CommandError('--column cannot be combined with positional model arguments', 2);
  }
  const flags = parseGlobalFlags({ ...globalOptions, json: localOptions.json });

  const columnFilter = localOptions.column ? parseColumnFilter(localOptions.column) : undefined;
  const result = await lineageProject(process.cwd(), {
    integration: localOptions.integration,
    models: columnFilter ? [columnFilter.model] : modelNames,
  });

  if (flags.json || localOptions.yaml) {
    const payload = toStructuredPayload(result, columnFilter);
    if (localOptions.yaml) {
      out.yaml(payload);
    } else {
      out.json(payload);
    }
    return;
  }

  for (const w of result.warnings) out.warn(w);
  for (const s of result.skipped) out.warn(s.message);

  const multi = result.byIntegration.length > 1;

  for (const group of result.byIntegration) {
    if (multi) {
      out.text(`── integration: ${group.handle} ──\n`);
    }
    if (columnFilter) {
      out.text(renderColumnLineage(group, columnFilter) + '\n');
    } else {
      out.text(renderLineage(group.models, group.effectiveTiers) + '\n');
    }
  }
}

/**
 * Registers the `model lineage` subcommand and its text/structured output options.
 */
export function registerLineageCommand(program: Command): void {
  program
    .command('lineage')
    .description('Show model dependency lineage with trust tiers')
    .argument('[model...]', 'Model names to show (default: all)')
    .addOption(createIntegrationOption())
    .option('--json', 'Output results as JSON to stdout')
    .option('--yaml', 'Output results as YAML to stdout')
    .option('--column <model.column>', 'Show column-level lineage for a single model column')
    .action(async (modelNames: string[], opts: LineageOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await lineageHandler(modelNames, opts, globalOptions);
    });
}

/**
 * Parses `<model.column>` into normalized filter parts for CLI and JSON output.
 */
function parseColumnFilter(value: string): ColumnFilter {
  const dot = value.indexOf('.');
  if (dot <= 0 || dot === value.length - 1) {
    throw new CommandError(`--column must be in the form <model.column>; received "${value}"`, 2);
  }
  return {
    model: value.slice(0, dot).toLowerCase(),
    column: value.slice(dot + 1).toLowerCase(),
  };
}

/**
 * Converts lineage project data into the stable structured envelope consumed by agents.
 */
function toStructuredPayload(
  result: LineageProjectResult,
  columnFilter?: ColumnFilter
): LineageStructuredPayload {
  return {
    command: 'model.lineage',
    executed: new Date().toISOString(),
    warnings: result.warnings,
    skipped: result.skipped,
    integrations: result.byIntegration.map((group) => ({
      handle: group.handle,
      dialect: group.dialect,
      models: group.models.map((node) => ({
        name: node.name,
        refs: node.refs,
        source_refs: node.sourceRefs,
        materialization: node.materialization,
        trust_tier:
          (node.parsedSpec.model_kind === 'agentic' ? 'bronze' : node.parsedSpec.trust_tier) ??
          'bronze',
        effective_trust_tier: group.effectiveTiers.get(node.name) ?? null,
      })),
      column_lineage: filterColumnLineage(group.columnLineage, columnFilter),
    })),
  };
}

/**
 * Renders a focused text view for one output column's upstream references.
 */
function renderColumnLineage(
  group: LineageProjectIntegrationResult,
  columnFilter: ColumnFilter
): string {
  const entries = filterColumnLineage(group.columnLineage, columnFilter);
  if (entries.length === 0) {
    return `No column lineage found for ${columnFilter.model}.${columnFilter.column}`;
  }

  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`${entry.model}.${entry.column}${entry.isComplete ? '' : ' [incomplete]'}`);
    for (const upstream of entry.upstream) {
      lines.push(`  ← ${formatUpstream(upstream)}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * Applies the optional model/column filter to a column-lineage collection.
 */
function filterColumnLineage(
  lineage: ColumnLineageEntry[],
  columnFilter?: ColumnFilter
): ColumnLineageEntry[] {
  if (!columnFilter) return lineage;
  return lineage.filter(
    (entry) =>
      entry.model.toLowerCase() === columnFilter.model &&
      entry.column.toLowerCase() === columnFilter.column
  );
}

/**
 * Formats an upstream reference for the text lineage renderer.
 */
function formatUpstream(upstream: ColumnLineageUpstream): string {
  const source = upstream.source ?? '(unresolved)';
  return `${source}.${upstream.column}`;
}
