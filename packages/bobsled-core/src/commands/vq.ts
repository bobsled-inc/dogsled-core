import {
  loadIndexedMetadataRegistry,
  loadVqsDirectory,
  type VqParameter,
  type VqSpec,
} from '@bobsled-inc/model-spec/project';
import { resolveProjectIndex } from '@bobsled-inc/project-index';
import { CommandError } from '@bobsled-inc/protocol';
import type { Command } from 'commander';

import * as fmt from '../lib/output/formatter.js';
import { projectQuerySpecLoader } from '../runtime/source-materializer/project-query-specs.js';
import { runQueryCommand, type RunQueryArgs, type RunQueryResult } from './query.js';
import type { GlobalOptions } from '../types/index.js';
import type {
  SourceFilterParamValue,
  SourceFilterRuntimeContext,
} from '../runtime/source-materializer/filter-params.js';
import {
  loadApiResourceEntries,
  sourceNameOf,
  type ApiResourceEntry,
} from '../runtime/source-materializer/load-specs.js';

export interface RunVqArgs extends Pick<
  RunQueryArgs,
  | 'projectRoot'
  | 'queryResourceImpl'
  | 'integrationSpecLoader'
  | 'onReceipt'
  | 'nowIso'
  | 'resolveDestinationImpl'
  | 'createSqlRunnerImpl'
  | 'featureFlags'
> {
  name: string;
  params?: Record<string, string>;
  session?: Record<string, string>;
  /** Only read VQ files from this directory; every `type: vq` file in the project otherwise. */
  vqsDir?: string;
  loadVqsImpl?: typeof loadVqs;
  loadApiResourceEntriesImpl?: typeof loadApiResourceEntries;
  runQueryCommandImpl?: typeof runQueryCommand;
}

export interface RunVqResult extends RunQueryResult {
  sql: string;
}

type CoercedParamValue = SourceFilterParamValue | null;
type VqParamLiteral = string | number | boolean | null;
type VqToken = { raw: string; segments: string[] };

function sqlLiteral(value: CoercedParamValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
}

function normalizeDateParam(param: VqParameter, raw: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new CommandError(`VQ parameter "${param.name}" must be a YYYY-MM-DD date`, 2);
  }

  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw new CommandError(`VQ parameter "${param.name}" must be a valid calendar date`, 2);
  }

  return raw;
}

function normalizeTimestampParam(param: VqParameter, raw: string): string {
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(raw)) {
    throw new CommandError(
      `VQ parameter "${param.name}" must include a timezone offset (e.g. "Z" or "+00:00")`,
      2
    );
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new CommandError(`VQ parameter "${param.name}" must be a valid timestamp`, 2);
  }
  return parsed.toISOString();
}

function coerceParamLiteral(param: VqParameter, value: VqParamLiteral): CoercedParamValue {
  if (value === null) return null;

  switch (param.type) {
    case 'integer': {
      if (typeof value === 'boolean') {
        throw new CommandError(`VQ parameter "${param.name}" must be an integer`, 2);
      }
      const normalized = normalizeNumericParam(param, value, 'integer');
      const parsed = Number(normalized);
      if (!Number.isSafeInteger(parsed)) {
        throw new CommandError(`VQ parameter "${param.name}" must be an integer`, 2);
      }
      return parsed;
    }
    case 'number': {
      if (typeof value === 'boolean') {
        throw new CommandError(`VQ parameter "${param.name}" must be a number`, 2);
      }
      const normalized = normalizeNumericParam(param, value, 'number');
      const parsed = Number(normalized);
      if (!Number.isFinite(parsed)) {
        throw new CommandError(`VQ parameter "${param.name}" must be a number`, 2);
      }
      return parsed;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new CommandError(`VQ parameter "${param.name}" must be true or false`, 2);
    }
    case 'date': {
      if (typeof value !== 'string') {
        throw new CommandError(`VQ parameter "${param.name}" must be a YYYY-MM-DD date`, 2);
      }
      return normalizeDateParam(param, value);
    }
    case 'timestamp': {
      if (typeof value !== 'string') {
        throw new CommandError(`VQ parameter "${param.name}" must be a valid timestamp`, 2);
      }
      return normalizeTimestampParam(param, value);
    }
    case 'string': {
      if (typeof value !== 'string') {
        throw new CommandError(`VQ parameter "${param.name}" must be a string`, 2);
      }
      return value;
    }
  }
}

function normalizeNumericParam(
  param: VqParameter,
  value: string | number,
  kind: 'integer' | 'number'
): string | number {
  if (typeof value === 'number') return value;
  const label = kind === 'integer' ? 'an integer' : 'a number';
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new CommandError(`VQ parameter "${param.name}" must be ${label}`, 2);
  }

  const pattern =
    kind === 'integer' ? /^[+-]?\d+$/ : /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;
  if (!pattern.test(trimmed)) {
    throw new CommandError(`VQ parameter "${param.name}" must be ${label}`, 2);
  }
  return trimmed;
}

function coerceParamValue(param: VqParameter, raw: string | undefined): CoercedParamValue {
  if (raw === undefined) {
    if (param.default !== undefined) return coerceParamLiteral(param, param.default);
    if (param.required === false) return null;
    throw new CommandError(`missing required VQ parameter "${param.name}"`, 2);
  }

  return coerceParamLiteral(param, raw);
}

function coerceParams(
  vq: VqSpec,
  provided: Record<string, string>
): Record<string, CoercedParamValue> {
  const declared = new Map((vq.parameters ?? []).map((param) => [param.name, param] as const));
  for (const name of Object.keys(provided)) {
    if (!declared.has(name)) {
      throw new CommandError(`unknown VQ parameter "${name}" for "${vq.name}"`, 2);
    }
  }

  const out: Record<string, CoercedParamValue> = {};
  for (const param of vq.parameters ?? []) {
    out[param.name] = coerceParamValue(param, provided[param.name]);
  }
  return out;
}

function sourceFilterParams(
  params: Record<string, CoercedParamValue>
): Record<string, SourceFilterParamValue> {
  const out: Record<string, SourceFilterParamValue> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) out[key] = value;
  }
  return out;
}

const VQ_TOKEN_RE = /\{([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)?)\}/y;

function renderVqSql(
  vq: VqSpec,
  params: Record<string, CoercedParamValue>,
  sourceIntegrations: Map<string, string>
): string {
  return transformVqSqlTokens(vq.sql, (token) => {
    if (token.segments.length === 1) {
      const name = token.segments[0]!;
      if (Object.prototype.hasOwnProperty.call(params, name)) {
        return sqlLiteral(params[name]!);
      }
    }

    if (token.segments.length === 2) {
      const [integration, sourceName] = token.segments;
      const expectedIntegration = sourceIntegrations.get(sourceName!);
      if (!expectedIntegration) {
        throw new CommandError(
          `VQ "${vq.name}" contains unknown source token ${token.raw}; no sources.${sourceName} source exists.`,
          2
        );
      }
      if (expectedIntegration !== integration) {
        throw new CommandError(
          `VQ "${vq.name}" source token ${token.raw} targets sources.${sourceName}, but that source uses integration "${expectedIntegration}".`,
          2
        );
      }
      return `sources.${sourceName}`;
    }

    throw new CommandError(
      `VQ "${vq.name}" contains unresolved model token ${token.raw}; bobsled vq run currently supports sources.* SQL and {integration.source} source tokens.`,
      2
    );
  });
}

function transformVqSqlTokens(sql: string, transform: (token: VqToken) => string): string {
  let out = '';
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    VQ_TOKEN_RE.lastIndex = index;
    const match = VQ_TOKEN_RE.exec(sql);
    if (match?.index === index) {
      out += transform({ raw: match[0], segments: match[1]!.split('.') });
      index = VQ_TOKEN_RE.lastIndex;
      continue;
    }

    if (char === "'") {
      const start = index;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      out += sql.slice(start, index);
      continue;
    }

    if (char === '"' || char === '`') {
      const quote = char;
      const start = index;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      out += sql.slice(start, index);
      continue;
    }

    if (char === '$') {
      const opener = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (opener) {
        const tag = opener[0];
        const end = sql.indexOf(tag, index + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        out += sql.slice(index, stop);
        index = stop;
        continue;
      }
    }

    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index + 2);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(index, stop);
      index = stop;
      continue;
    }

    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(index, stop);
      index = stop;
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

function sourceIntegrationsByName(entries: ApiResourceEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of entries) {
    out.set(sourceNameOf(entry), entry.integration);
  }
  return out;
}

function parseParamAssignment(value: string): [string, string] {
  const index = value.indexOf('=');
  if (index <= 0) {
    throw new CommandError(`Invalid --param "${value}". Use name=value.`, 2);
  }
  return [value.slice(0, index), value.slice(index + 1)];
}

function parseParamAssignments(values: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values ?? []) {
    const [name, raw] = parseParamAssignment(value);
    out[name] = raw;
  }
  return out;
}

async function loadVqs(projectRoot: string, vqsDir?: string): Promise<Map<string, VqSpec>> {
  if (vqsDir !== undefined) return loadVqsDirectory(projectRoot, vqsDir);
  return loadIndexedMetadataRegistry(resolveProjectIndex(projectRoot)).vqs;
}

export async function runVqCommand(args: RunVqArgs): Promise<RunVqResult> {
  const loadVqsImpl = args.loadVqsImpl ?? loadVqs;
  const loadApiResourceEntriesImpl = args.loadApiResourceEntriesImpl ?? loadApiResourceEntries;
  const runQueryCommandImpl = args.runQueryCommandImpl ?? runQueryCommand;
  const registry = await loadVqsImpl(args.projectRoot, args.vqsDir);
  const vq = registry.get(args.name);
  if (!vq) {
    throw new CommandError(`unknown VQ "${args.name}"`, 2);
  }

  const params = coerceParams(vq, args.params ?? {});
  const session = args.session ?? {};
  const sql = renderVqSql(
    vq,
    params,
    sourceIntegrationsByName(await loadApiResourceEntriesImpl(args.projectRoot))
  );
  const filterContext: SourceFilterRuntimeContext = {
    params: sourceFilterParams(params),
    session: sourceFilterParams(session),
  };
  const result = await runQueryCommandImpl({
    projectRoot: args.projectRoot,
    sql,
    queryResourceImpl: args.queryResourceImpl,
    integrationSpecLoader: args.integrationSpecLoader,
    onReceipt: args.onReceipt,
    nowIso: args.nowIso,
    resolveDestinationImpl: args.resolveDestinationImpl,
    createSqlRunnerImpl: args.createSqlRunnerImpl,
    featureFlags: args.featureFlags,
    sourceFilterParams: filterContext,
  });
  return { ...result, sql };
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) =>
    typeof nested === 'bigint' ? nested.toString() : nested
  );
}

async function executeVq(
  name: string,
  options: { param?: string[]; session?: string[]; vqsDir?: string },
  globalOptions: GlobalOptions
): Promise<void> {
  const outputOpts = fmt.toOutputOptions(globalOptions);
  try {
    const result = await runVqCommand({
      projectRoot: globalOptions.projectRoot ?? process.cwd(),
      name,
      integrationSpecLoader: projectQuerySpecLoader(globalOptions.projectRoot ?? process.cwd()),
      params: parseParamAssignments(options.param),
      session: parseParamAssignments(options.session),
      vqsDir: options.vqsDir,
      onReceipt: (line) => {
        if (!outputOpts.json && !outputOpts.quiet) process.stderr.write(`${line}\n`);
      },
    });

    if (outputOpts.json) {
      process.stdout.write(
        `${stringifyJson({
          sql: result.sql,
          rows: result.rows,
          receipts: result.receipts,
          total_ms: result.totalMs,
        })}\n`
      );
      return;
    }

    for (const row of result.rows) {
      process.stdout.write(`${stringifyJson(row)}\n`);
    }
    if (!outputOpts.quiet) process.stderr.write(`query_total_ms=${result.totalMs}\n`);
  } catch (err) {
    const exitCode = err instanceof CommandError ? err.exitCode : 1;
    const message = err instanceof Error ? err.message : String(err);
    if (outputOpts.json) {
      process.stdout.write(`${stringifyJson({ error: message, exit_code: exitCode })}\n`);
    } else {
      fmt.error(message, outputOpts);
    }
    process.exitCode = exitCode;
  }
}

function addVqOptions(cmd: Command): Command {
  return cmd
    .option('--param <name=value>', 'VQ parameter value', (value, previous: string[] = []) => [
      ...previous,
      value,
    ])
    .option(
      '--session <name=value>',
      'VQ session context value',
      (value, previous: string[] = []) => [...previous, value]
    )
    .option(
      '--vqs-dir <dir>',
      'Only read VQ files from this directory (default: every type: vq file in the project)'
    );
}

export function registerVqCommand(program: Command): void {
  const vq = program
    .command('vq')
    .description('Run parameterized verified queries')
    .option('--project-root <path>', 'Bobsled Core Project root (default: current directory)');

  // Primary: vq <name>
  addVqOptions(vq.argument('<name>', 'Name of the verified query to run')).action(
    async (
      name: string,
      options: { param?: string[]; session?: string[]; vqsDir?: string },
      command: Command
    ) => {
      await executeVq(
        name,
        options,
        command.parent?.optsWithGlobals<GlobalOptions>() ?? {
          json: false,
          verbose: false,
          quiet: false,
          noColor: false,
        }
      );
    }
  );

  // Deprecated alias: vq run <name> — run (this) → vq → program
  addVqOptions(
    vq.command('run <name>').description('(deprecated) Use `vq <name>` directly')
  ).action(
    async (
      name: string,
      options: { param?: string[]; session?: string[]; vqsDir?: string },
      command: Command
    ) => {
      const globalOpts = command.parent?.parent?.optsWithGlobals<GlobalOptions>() ?? {
        json: false,
        verbose: false,
        quiet: false,
        noColor: false,
      };
      if (!globalOpts.json && !globalOpts.quiet) {
        process.stderr.write('`vq run <name>` is deprecated; use `vq <name>` directly.\n');
      }
      await executeVq(name, options, globalOpts);
    }
  );
}
