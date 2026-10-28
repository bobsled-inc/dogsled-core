import type { Command } from 'commander';
import { CommandError } from '@bobsled-inc/protocol';
import {
  createDialectOption,
  loadProjectConfig,
  loadRunnerModule,
  out,
  resolveConfig,
} from '@bobsled-inc/model-spec/shared';

import { type SqlQueryRow, type SupportedDialect } from '@bobsled-inc/model-spec';
import { buildExplainQuery, type ExplainSubject } from '../compiler/explain/codegen.js';

interface ExplainOptions {
  subject: ExplainSubject;
  id: string;
  format?: 'json' | 'yaml' | 'markdown';
  json?: boolean;
  yaml?: boolean;
  runner?: string;
  dialect?: string;
  contractSchema?: string;
}

function normalizeSubject(value: string | undefined): ExplainSubject {
  if (value === 'pair' || value === 'cluster' || value === 'edge' || value === 'entity') {
    return value;
  }
  throw new CommandError('--subject must be one of pair, cluster, edge, or entity', 2);
}

function parsePayload(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeFormat(value: string | undefined): 'json' | 'yaml' | 'markdown' {
  if (value === undefined || value === 'json' || value === 'yaml' || value === 'markdown') {
    return value ?? 'json';
  }
  throw new CommandError('--format must be json, yaml, or markdown', 2);
}

function normalizeRow(row: SqlQueryRow): SqlQueryRow {
  const normalized = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key.toLowerCase(), value])
  ) as SqlQueryRow;
  const payload = normalized.payload_json;
  return {
    ...normalized,
    ...(payload === undefined ? {} : { payload: parsePayload(payload) }),
  };
}

function renderMarkdown(subject: ExplainSubject, id: string, rows: SqlQueryRow[]): string {
  const sections = new Map<string, SqlQueryRow[]>();
  for (const row of rows) {
    const section = String(
      new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value])).get(
        'section'
      ) ?? 'result'
    );
    sections.set(section, [...(sections.get(section) ?? []), row]);
  }

  const lines = [`# ${subject} ${id}`, ''];
  for (const [section, sectionRows] of sections) {
    lines.push(`## ${section}`, '');
    lines.push('```json');
    lines.push(JSON.stringify(sectionRows.map(normalizeRow), null, 2));
    lines.push('```', '');
  }
  return `${lines.join('\n')}\n`;
}

async function explainHandler(
  options: ExplainOptions,
  _globalOptions: { quiet?: boolean }
): Promise<void> {
  const cwd = process.cwd();
  const { config } = loadProjectConfig(cwd);
  if (options.json && options.yaml) {
    throw new CommandError('--json and --yaml are mutually exclusive.', 2);
  }
  const format = options.json ? 'json' : options.yaml ? 'yaml' : normalizeFormat(options.format);
  const dialect = resolveConfig(
    { dialect: options.dialect as SupportedDialect | undefined },
    config
  ).dialect;
  const subject = normalizeSubject(options.subject);
  const query = buildExplainQuery({
    subject,
    id: options.id,
    dialect,
    contractSchema: options.contractSchema,
  });

  const runner = options.runner ? await loadRunnerModule(options.runner) : undefined;
  if (options.runner && runner?.query == null) {
    throw new CommandError('runner must implement query(sql) for entity-graph explain.', 2);
  }

  if (runner?.query == null) {
    const payload = {
      command: 'entity-graph.explain',
      subject,
      id: options.id,
      dialect,
      warnings: [],
      executed: false,
      query,
    };
    if (format === 'json') {
      out.json(payload);
    } else if (format === 'yaml') {
      out.yaml(payload);
    } else {
      out.text(`\`\`\`sql\n${query}\n\`\`\`\n`);
    }
    return;
  }

  const rows = (await runner.query(query)).map(normalizeRow);
  const payload = {
    command: 'entity-graph.explain',
    subject,
    id: options.id,
    dialect,
    warnings: [],
    executed: true,
    rows,
  };
  if (format === 'json') {
    out.json(payload);
  } else if (format === 'yaml') {
    out.yaml(payload);
  } else {
    out.text(renderMarkdown(subject, options.id, rows));
  }
}

export function registerExplainCommand(program: Command): void {
  const explain = program
    .command('explain')
    .description('Explain entity graph pairs, clusters, edges, or entities')
    .requiredOption('--subject <subject>', 'pair | cluster | edge | entity')
    .requiredOption('--id <id>', 'Subject identifier')
    .option('--format <format>', 'json | yaml | markdown', 'json')
    .option('--json', 'Output results as JSON')
    .option('--yaml', 'Output results as YAML')
    .option('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--contract-schema <name>', 'Entity graph contract schema')
    .addOption(createDialectOption())
    .action(async (opts: ExplainOptions) => {
      const globalOpts = program.opts<{ quiet?: boolean }>();
      await explainHandler(opts, globalOpts);
    });

  explain
    .command('pair')
    .description('Explain a resolved pair by pair ID')
    .argument('<pair-id>', 'Pair ID to explain')
    .option('--format <format>', 'json | yaml | markdown', 'yaml')
    .option('--json', 'Output results as JSON')
    .option('--yaml', 'Output results as YAML')
    .option('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--contract-schema <name>', 'Entity graph contract schema')
    .addOption(createDialectOption())
    .action(async (pairId: string, opts: Omit<ExplainOptions, 'subject' | 'id'>) => {
      const globalOpts = program.opts<{ quiet?: boolean }>();
      await explainHandler({ ...opts, subject: 'pair', id: pairId }, globalOpts);
    });
}
