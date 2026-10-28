import * as fs from 'node:fs';
import * as path from 'node:path';

import YAML from 'yaml';
import type { Command } from 'commander';
import { CommandError } from '@bobsled-inc/protocol';
import {
  createDialectOption,
  loadRunnerModule,
  out,
  parseGlobalFlags,
} from '@bobsled-inc/model-spec/shared';
import {
  executeSqlStatements,
  type ModelExecutionResult,
  type SupportedDialect,
} from '@bobsled-inc/model-spec';

import { generateAuditLogDdl } from '../compiler/audit/codegen.js';
import {
  buildForgetRecordRequest,
  generateForgetSql,
  type ForgetPrimaryKeyValue,
  type ForgetRecordInput,
  type ForgetRecordRequest,
} from '../compiler/identity/codegen-forget.js';
import {
  compileResolutionCluster,
  compileResolutionProfile,
} from '../compiler/identity/codegen.js';
import { generateMaterializeDdl } from '../compiler/identity/materializer.js';
import type { SqlStatement } from '../compiler/identity/types.js';
import { toEntityGraphExecutionStatements } from '../runtime/execution.js';
import { buildResolveContext } from './resolve-context.js';
import { emitEntityGraphPayload, resolveEntityGraphOutputFormat } from './utils.js';

interface ForgetOptions {
  entity?: string;
  sourceRef?: string[];
  pk?: string[];
  input?: string;
  reason?: string;
  dryRun?: boolean;
  replay?: boolean;
  runner?: string;
  schema?: string;
  dialect?: SupportedDialect;
  json?: boolean;
  yaml?: boolean;
  verbose?: boolean;
  quiet?: boolean;
}

interface ForgetStatementJson {
  name: string;
  sql?: string;
  table_created?: string;
  status?: ModelExecutionResult['status'];
  error?: string;
  rows_affected?: number;
}

type ForgetInputFormat = 'csv' | 'json' | 'yaml';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function collectValue(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function toScalarPk(
  parsed: Record<string, unknown>,
  label: string
): Record<string, ForgetPrimaryKeyValue> {
  const pk: Record<string, ForgetPrimaryKeyValue> = {};
  for (const [field, value] of Object.entries(parsed)) {
    if (value !== null && typeof value === 'object') {
      throw new CommandError(
        `${label} primary-key field "${field}" must be a string, number, boolean, or null.`,
        2
      );
    }
    pk[field] = value as ForgetPrimaryKeyValue;
  }
  return pk;
}

function parsePkJson(raw: string, label: string): Record<string, ForgetPrimaryKeyValue> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CommandError(`${label} must be a JSON object: ${message}`, 2);
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CommandError(`${label} must be a JSON object.`, 2);
  }
  return toScalarPk(parsed as Record<string, unknown>, label);
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function detectForgetInputFormat(content: string): ForgetInputFormat {
  const trimmed = content.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  if (
    trimmed.startsWith('- ') ||
    trimmed.startsWith('---') ||
    trimmed.startsWith('#') ||
    /^[A-Za-z_][\w.-]*\s*:/.test(trimmed)
  ) {
    return 'yaml';
  }
  return 'csv';
}

function parseForgetRows(parsed: unknown, label: string): ForgetRecordInput[] {
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed != null &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as { requests?: unknown }).requests)
      ? (parsed as { requests: unknown[] }).requests
      : undefined;
  if (!rows) {
    throw new CommandError(`${label} must contain an array of forget requests.`, 2);
  }
  return rows.map((row, index) => {
    if (row == null || typeof row !== 'object' || Array.isArray(row)) {
      throw new CommandError(`${label} entry ${index + 1} must be an object.`, 2);
    }
    const record = row as Record<string, unknown>;
    const sourceRef = String(record.source_ref ?? record.sourceRef ?? '').trim();
    if (!sourceRef) {
      throw new CommandError(`${label} entry ${index + 1} is missing source_ref.`, 2);
    }
    const pk = record.pk;
    if (pk == null || typeof pk !== 'object' || Array.isArray(pk)) {
      throw new CommandError(`${label} entry ${index + 1} must include pk as an object.`, 2);
    }
    return {
      sourceRef,
      pk: toScalarPk(pk as Record<string, unknown>, `${label} entry ${index + 1}`),
    };
  });
}

function parseCsvForgetRequests(content: string): ForgetRecordInput[] {
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]!).map((header) => header.trim().toLowerCase());
  const headerMap = new Map(headers.map((header, index) => [header, index]));
  const sourceRefIndex = headerMap.get('source_ref') ?? headerMap.get('sourceref');
  const pkIndex = headerMap.get('pk');
  if (sourceRefIndex == null || pkIndex == null) {
    throw new CommandError('CSV forget input must include source_ref and pk columns.', 2);
  }
  return lines.slice(1).map((line, index) => {
    const fields = parseCsvLine(line);
    const sourceRef = fields[sourceRefIndex]?.trim() ?? '';
    if (!sourceRef) {
      throw new CommandError(`CSV line ${index + 2} is missing source_ref.`, 2);
    }
    return {
      sourceRef,
      pk: parsePkJson(fields[pkIndex] ?? '', `CSV line ${index + 2} pk`),
    };
  });
}

function parseForgetInput(content: string, format: ForgetInputFormat): ForgetRecordInput[] {
  if (format === 'csv') return parseCsvForgetRequests(content);
  if (format === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CommandError(`Invalid JSON forget input: ${message}`, 2);
    }
    return parseForgetRows(parsed, 'JSON forget input');
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CommandError(`Invalid YAML forget input: ${message}`, 2);
  }
  return parseForgetRows(parsed, 'YAML forget input');
}

async function loadForgetInputs(options: ForgetOptions): Promise<{
  inputs: ForgetRecordInput[];
  inputPath?: string;
  inputFormat?: ForgetInputFormat;
}> {
  const directSourceRefs = options.sourceRef ?? [];
  const directPks = options.pk ?? [];
  if (options.input && (directSourceRefs.length > 0 || directPks.length > 0)) {
    throw new CommandError('--input cannot be combined with --source-ref/--pk.', 2);
  }
  if (directSourceRefs.length !== directPks.length) {
    throw new CommandError('Each --source-ref must have a matching --pk JSON object.', 2);
  }
  if (options.input) {
    const inputPath = options.input === '-' ? '-' : path.resolve(options.input);
    if (options.input !== '-' && !fs.existsSync(inputPath)) {
      throw new CommandError(`Input file not found: ${inputPath}`, 2);
    }
    const content = options.input === '-' ? await readStdin() : fs.readFileSync(inputPath, 'utf-8');
    const inputFormat = detectForgetInputFormat(content);
    return {
      inputs: parseForgetInput(content, inputFormat),
      inputPath,
      inputFormat,
    };
  }
  return {
    inputs: directSourceRefs.map((sourceRef, index) => ({
      sourceRef,
      pk: parsePkJson(directPks[index]!, `--pk ${index + 1}`),
    })),
  };
}

function statementJson(
  statement: SqlStatement,
  execution: ModelExecutionResult | undefined,
  includeSql: boolean
): ForgetStatementJson {
  return {
    name: statement.name,
    // The compiled SQL embeds source_pk_json and reason literals — i.e. the PII
    // being erased. Only surface it for --dry-run (an explicit plan preview);
    // never on an executed run, whose output can land in logs.
    ...(includeSql ? { sql: statement.sql } : {}),
    table_created: statement.tableCreated,
    status: execution?.status,
    error: execution?.error,
    rows_affected: execution?.rowsAffected,
  };
}

function renderForgetText(payload: {
  dry_run: boolean;
  entity: string;
  statements: ForgetStatementJson[];
}): string {
  const lines = payload.dry_run
    ? [`[dry-run] Would execute ${payload.statements.length} statements for ${payload.entity}`]
    : [`Forgot ${payload.entity} record(s) with ${payload.statements.length} statements.`];
  for (const statement of payload.statements) {
    const status = statement.status ? ` [${statement.status}]` : '';
    lines.push(`-- ${statement.name}${status}`);
    // Only echo SQL bodies in dry-run mode (see statementJson).
    if (statement.sql !== undefined) {
      lines.push(`${statement.sql};`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function forgetHandler(
  options: ForgetOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): Promise<void> {
  const format = resolveEntityGraphOutputFormat({
    json: options.json,
    yaml: options.yaml,
    defaultFormat: 'text',
  });
  if (!options.entity) {
    throw new CommandError('--entity <name> is required.', 2);
  }
  const { inputs, inputPath, inputFormat } = await loadForgetInputs(options);
  if (!options.replay && inputs.length === 0) {
    throw new CommandError('Provide --input or one or more --source-ref/--pk requests.', 2);
  }

  const flags = parseGlobalFlags(globalOptions);
  const context = buildResolveContext(globalOptions, options, [options.entity]);
  const spec = context.specs[0];
  if (!spec) {
    throw new CommandError(`No resolution specs found matching: ${options.entity}`, 2);
  }
  const targetSchema = spec.targetSchema ?? context.targetSchema;
  // Dedupe repeated requests for the same record: duplicates in one batch would
  // UNION ALL identical tombstone rows past the per-statement NOT EXISTS guard
  // and emit same-discriminator audit events that fail `audit verify`.
  const requestsByTombstone = new Map<string, ForgetRecordRequest>();
  for (const input of inputs) {
    const request = buildForgetRecordRequest(spec, input, options.reason);
    if (!requestsByTombstone.has(request.tombstoneId)) {
      requestsByTombstone.set(request.tombstoneId, request);
    }
  }
  const requests: ForgetRecordRequest[] = [...requestsByTombstone.values()];
  const forgetStatements = [
    ...generateMaterializeDdl(spec.entity, context.dialect, targetSchema),
    ...generateAuditLogDdl(context.dialect),
    ...generateForgetSql({
      spec,
      dialect: context.dialect,
      targetSchema,
      requests,
      reason: options.reason,
      replay: options.replay,
    }),
  ];
  const repairStatements = [
    ...compileResolutionCluster(spec, context.dialect, targetSchema).statements,
    ...compileResolutionProfile(spec, context.dialect, targetSchema).statements,
  ];
  const statements = [...forgetStatements, ...repairStatements];
  let executionResults: ModelExecutionResult[] = [];
  const executed = Boolean(options.runner) && !options.dryRun;

  if (options.dryRun || !options.runner) {
    if (!options.dryRun && !options.runner) {
      throw new CommandError('--runner <path> is required unless --dry-run is set.', 2);
    }
  } else {
    const runner = await loadRunnerModule(options.runner);
    if (runner.run == null) {
      throw new CommandError('runner must implement run(sql)', 2);
    }
    const suppressHumanOutput = flags.quiet || format !== 'text';
    // Chain each statement on its predecessor: a failed purge must skip every
    // downstream statement — most importantly the erasure audit inserts and the
    // cluster/profile repair — so the audit log never attests an erasure that
    // did not commit (plan Architecture Decision 6).
    executionResults = await executeSqlStatements(
      toEntityGraphExecutionStatements(spec.entity, {
        statements,
        dialect: context.dialect,
      }),
      runner.run,
      {
        onInfo: suppressHumanOutput ? undefined : (message) => out.info(message),
        onError: (message) => out.error(message),
        onSuccess: suppressHumanOutput ? undefined : (message) => out.success(message),
      }
    );
    const failed = executionResults.filter((row) => row.status === 'failed');
    if (failed.length > 0) {
      const payload = {
        command: 'entity-graph.forget',
        entity: spec.entity,
        dialect: context.dialect,
        schema: targetSchema,
        executed: true,
        dry_run: false,
        replay: Boolean(options.replay),
        request_count: requests.length,
        input_path: inputPath,
        input_format: inputFormat,
        statements: statements.map((statement, index) =>
          statementJson(statement, executionResults[index], false)
        ),
      };
      if (format !== 'text') {
        emitEntityGraphPayload(payload, format, () => renderForgetText(payload));
      }
      throw new CommandError(`${failed.length} forget statement(s) failed.`, 1);
    }
  }

  const payload = {
    command: 'entity-graph.forget',
    entity: spec.entity,
    dialect: context.dialect,
    schema: targetSchema,
    executed,
    dry_run: Boolean(options.dryRun),
    replay: Boolean(options.replay),
    request_count: requests.length,
    input_path: inputPath,
    input_format: inputFormat,
    tombstone_ids: requests.map((request) => request.tombstoneId),
    statements: statements.map((statement, index) =>
      statementJson(statement, executionResults[index], Boolean(options.dryRun))
    ),
  };
  emitEntityGraphPayload(payload, format, () => renderForgetText(payload));
}

export function registerForgetCommand(program: Command): void {
  program
    .command('forget')
    .description(
      'Forget source records from entity graph surfaces. On Snowflake PII schemas, keep DATA_RETENTION_TIME_IN_DAYS <= 30 and rerun --replay after restores.'
    )
    .requiredOption('--entity <name>', 'Resolution entity name')
    .option('--source-ref <ref>', 'Source ref for a record to forget', collectValue, [])
    .option(
      '--pk <json>',
      'Primary-key JSON object for the preceding --source-ref',
      collectValue,
      []
    )
    .option('--input <path>', 'CSV/JSON/YAML request file, or "-" for stdin')
    .option('--reason <text>', 'PII-free erasure reason')
    .option('--dry-run', 'Show the execution plan without executing')
    .option('--replay', 'Re-execute deletions for all existing tombstones')
    .option('--runner <path>', 'Path to SQL runner module with run(sql)')
    .option('--json', 'Output results as JSON')
    .option('--yaml', 'Output results as YAML')
    .option('--verbose', 'Verbose output')
    .option('--quiet', 'Suppress non-error output')
    .option('--schema <name>', 'Target schema name')
    .addOption(createDialectOption())
    .action(async (opts: ForgetOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      await forgetHandler(opts, {
        verbose: globalOptions.verbose || opts.verbose,
        quiet: globalOptions.quiet || opts.quiet,
      });
    });
}
