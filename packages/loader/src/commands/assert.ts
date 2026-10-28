import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { CommandError } from '@bobsled-inc/protocol';
import { stringify as stringifyYaml } from 'yaml';
import YAML from 'yaml';
import { z } from 'zod';

import { runBigQueryQuery, runQuery, type BigQueryQueryOptions } from './query.js';

import type { Command } from 'commander';

const ComparableValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const AssertionComparatorSchema = z
  .object({
    min: z.number().optional(),
    max: z.number().optional(),
    equals: ComparableValueSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.min !== undefined || value.max !== undefined || 'equals' in value,
    'at least one of min, max, or equals is required'
  );

const CheckSchema = z
  .object({
    name: z.string().min(1),
    sql: z.string().min(1),
    expect: z.record(z.string(), AssertionComparatorSchema).optional(),
    assertions: z.record(z.string(), AssertionComparatorSchema).optional(),
  })
  .strict()
  .refine(
    (value) => value.expect !== undefined || value.assertions !== undefined,
    'expect or assertions is required'
  );

const CheckFileSchema = z.union([
  z.array(CheckSchema).min(1),
  z
    .object({
      version: z.union([z.literal(1), z.literal('1')]).optional(),
      checks: z.array(CheckSchema).min(1),
    })
    .strict(),
]);

export type LoadAssertDestination = 'duckdb' | 'bigquery';
export type LoadAssertOutputMode = 'text' | 'json' | 'yaml';

export interface LoadAssertOptions {
  checks: string;
  dest?: string;
  dbPath?: string;
  projectId?: string;
  location?: string;
  keyFilename?: string;
  json?: boolean;
  yaml?: boolean;
  cwd?: string;
}

export interface LoadAssertDependencies {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  readFile?: (filePath: string) => Promise<string>;
  runDuckDbQuery?: (dbPath: string, sql: string) => Promise<Record<string, unknown>[]>;
  runBigQueryQuery?: (
    sql: string,
    options: BigQueryQueryOptions
  ) => Promise<Record<string, unknown>[]>;
}

interface ParsedCheck {
  name: string;
  sql: string;
  assertions: Record<string, z.infer<typeof AssertionComparatorSchema>>;
}

export interface LoadAssertAssertionResult {
  field: string;
  operator: 'min' | 'max' | 'equals';
  expected: string | number | boolean | null;
  actual: unknown;
  passed: boolean;
  message?: string;
}

export interface LoadAssertCheckResult {
  name: string;
  sql: string;
  row_count: number;
  passed: boolean;
  assertions: LoadAssertAssertionResult[];
}

export interface LoadAssertResult {
  valid: boolean;
  destination: LoadAssertDestination;
  checked_at: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
  checks: LoadAssertCheckResult[];
}

function normalizeChecks(value: z.infer<typeof CheckFileSchema>): ParsedCheck[] {
  const checks = Array.isArray(value) ? value : value.checks;
  return checks.map((check) => ({
    name: check.name,
    sql: check.sql,
    assertions: check.expect ?? check.assertions ?? {},
  }));
}

function parseCheckFile(content: string): ParsedCheck[] {
  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CommandError(`Invalid YAML in checks file: ${message}`, 2);
  }

  const result = CheckFileSchema.safeParse(parsed);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new CommandError(`Invalid checks file: ${message}`, 2);
  }

  return normalizeChecks(result.data);
}

function detectOutputMode(options: { json?: boolean; yaml?: boolean }): LoadAssertOutputMode {
  if (options.json && options.yaml) {
    throw new CommandError('--json and --yaml are mutually exclusive.', 2);
  }
  if (options.yaml) return 'yaml';
  if (options.json) return 'json';
  const envFormat = process.env['DOGSLED_OUTPUT_FORMAT']?.toLowerCase();
  if (envFormat === 'json') return 'json';
  if (envFormat === 'yaml') return 'yaml';
  return 'text';
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => {
    if (typeof inner === 'bigint') {
      const asNumber = Number(inner);
      return Number.isSafeInteger(asNumber) ? asNumber : inner.toString();
    }
    if (inner instanceof Date) return inner.toISOString();
    return inner;
  });
}

function safeYaml(value: unknown): string {
  return stringifyYaml(JSON.parse(safeJson(value)), { lineWidth: 120 });
}

function normalizeActualValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && value !== null && 'value' in value) {
    return normalizeActualValue((value as { value: unknown }).value);
  }
  return value;
}

function asFiniteNumber(value: unknown): number | undefined {
  const normalized = normalizeActualValue(value);
  if (typeof normalized === 'number' && Number.isFinite(normalized)) return normalized;
  if (typeof normalized === 'string' && normalized.trim() !== '') {
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function compareEquals(actual: unknown, expected: string | number | boolean | null): boolean {
  const normalized = normalizeActualValue(actual);
  if (typeof expected === 'number') {
    const actualNumber = asFiniteNumber(normalized);
    return actualNumber !== undefined && Object.is(actualNumber, expected);
  }
  return Object.is(normalized, expected);
}

function evaluateAssertions(
  check: ParsedCheck,
  rows: Record<string, unknown>[]
): LoadAssertAssertionResult[] {
  if (rows.length === 0) {
    return Object.keys(check.assertions).map((field) => ({
      field,
      operator: 'equals',
      expected: null,
      actual: null,
      passed: false,
      message: `query returned no rows; cannot read field "${field}"`,
    }));
  }

  const firstRow = rows[0]!;
  const results: LoadAssertAssertionResult[] = [];

  for (const [field, assertion] of Object.entries(check.assertions)) {
    const actual = normalizeActualValue(firstRow[field]);
    if (!(field in firstRow)) {
      for (const operator of Object.keys(assertion) as Array<'min' | 'max' | 'equals'>) {
        results.push({
          field,
          operator,
          expected: assertion[operator]!,
          actual: null,
          passed: false,
          message: `field "${field}" was not present in the first result row`,
        });
      }
      continue;
    }

    if (assertion.min !== undefined) {
      const actualNumber = asFiniteNumber(actual);
      const passed = actualNumber !== undefined && actualNumber >= assertion.min;
      results.push({
        field,
        operator: 'min',
        expected: assertion.min,
        actual,
        passed,
        ...(passed
          ? {}
          : { message: `${field} expected >= ${assertion.min}; received ${String(actual)}` }),
      });
    }

    if (assertion.max !== undefined) {
      const actualNumber = asFiniteNumber(actual);
      const passed = actualNumber !== undefined && actualNumber <= assertion.max;
      results.push({
        field,
        operator: 'max',
        expected: assertion.max,
        actual,
        passed,
        ...(passed
          ? {}
          : { message: `${field} expected <= ${assertion.max}; received ${String(actual)}` }),
      });
    }

    if ('equals' in assertion) {
      const expected = assertion.equals ?? null;
      const passed = compareEquals(actual, expected);
      results.push({
        field,
        operator: 'equals',
        expected,
        actual,
        passed,
        ...(passed
          ? {}
          : { message: `${field} expected ${String(expected)}; received ${String(actual)}` }),
      });
    }
  }

  return results;
}

function resolveDestination(value: string | undefined): LoadAssertDestination {
  const dest = value ?? 'duckdb';
  if (dest === 'duckdb' || dest === 'bigquery') return dest;
  throw new CommandError(`unsupported destination "${dest}" for load assert`, 2);
}

export async function executeLoadAssert(
  options: LoadAssertOptions,
  dependencies: LoadAssertDependencies = {}
): Promise<LoadAssertResult> {
  const dest = resolveDestination(options.dest);
  const cwd = options.cwd ?? process.cwd();
  const checksPath = path.resolve(cwd, options.checks);
  const readFile = dependencies.readFile ?? ((filePath: string) => fs.readFile(filePath, 'utf8'));
  const checks = parseCheckFile(await readFile(checksPath));
  const runDuck =
    dependencies.runDuckDbQuery ??
    ((dbPath: string, sql: string) => runQuery(dbPath, sql, { format: false }));
  const runBigQuery =
    dependencies.runBigQueryQuery ??
    ((sql: string, queryOptions: BigQueryQueryOptions) =>
      runBigQueryQuery(sql, queryOptions, { format: false }));

  if (dest === 'duckdb' && !options.dbPath) {
    throw new CommandError('--db-path is required for DuckDB load assert.', 2);
  }

  const checkResults: LoadAssertCheckResult[] = [];
  for (const check of checks) {
    const rows =
      dest === 'duckdb'
        ? await runDuck(path.resolve(cwd, options.dbPath!), check.sql)
        : await runBigQuery(check.sql, {
            projectId: options.projectId,
            location: options.location,
            keyFilename: options.keyFilename,
          });
    const assertions = evaluateAssertions(check, rows);
    checkResults.push({
      name: check.name,
      sql: check.sql,
      row_count: rows.length,
      passed: assertions.every((assertion) => assertion.passed),
      assertions,
    });
  }

  const failed = checkResults.filter((check) => !check.passed).length;
  return {
    valid: failed === 0,
    destination: dest,
    checked_at: new Date().toISOString(),
    summary: {
      total: checkResults.length,
      passed: checkResults.length - failed,
      failed,
    },
    checks: checkResults,
  };
}

function renderTextResult(result: LoadAssertResult): string {
  const lines = [
    `Load assertions ${result.valid ? 'passed' : 'failed'}: ${result.summary.passed}/${result.summary.total}`,
  ];
  for (const check of result.checks) {
    lines.push(`${check.passed ? 'ok' : 'fail'} ${check.name}`);
    for (const assertion of check.assertions) {
      if (!assertion.passed) {
        lines.push(`  - ${assertion.message ?? `${assertion.field} failed ${assertion.operator}`}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

function emitPayload(
  payload: unknown,
  mode: LoadAssertOutputMode,
  stdout: NodeJS.WritableStream
): void {
  if (mode === 'yaml') {
    stdout.write(safeYaml(payload));
  } else if (mode === 'json') {
    stdout.write(`${safeJson(payload)}\n`);
  } else if ('valid' in (payload as Record<string, unknown>)) {
    stdout.write(renderTextResult(payload as LoadAssertResult));
  }
}

export async function runLoadAssertCommand(
  options: LoadAssertOptions,
  dependencies: LoadAssertDependencies = {}
): Promise<void> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  let mode: LoadAssertOutputMode = 'text';

  try {
    mode = detectOutputMode(options);
    const result = await executeLoadAssert(options, dependencies);
    emitPayload(result, mode, stdout);
    if (!result.valid) {
      process.exitCode = 2;
    }
  } catch (error) {
    const exitCode =
      error instanceof CommandError ? error.exitCode : error instanceof z.ZodError ? 2 : 1;
    const message = error instanceof Error ? error.message : String(error);
    if (mode === 'text') {
      stderr.write(`Error: ${message}\n`);
    } else {
      emitPayload({ valid: false, error: message, exit_code: exitCode }, mode, stdout);
    }
    process.exitCode = exitCode;
  }
}

export function registerAssertCommand(program: Command): void {
  program
    .command('assert')
    .description('Run SQL assertions against a DuckDB or BigQuery destination')
    .requiredOption('--checks <path>', 'YAML file containing named SQL checks')
    .option('--dest <dest>', 'Destination: duckdb or bigquery (default: duckdb)')
    .option('--db-path <path>', 'DuckDB database file path')
    .option('--project-id <id>', 'BigQuery project ID')
    .option('--dataset-id <id>', 'BigQuery dataset ID (accepted for CLI compatibility)')
    .option('--location <location>', 'BigQuery location')
    .option('--key-filename <path>', 'BigQuery service account key file')
    .option('--json', 'Emit results as JSON')
    .option('--yaml', 'Emit results as YAML')
    .action(async (options: Record<string, unknown>) => {
      await runLoadAssertCommand({
        checks: options.checks as string,
        dest: options.dest as string | undefined,
        dbPath: options.dbPath as string | undefined,
        projectId: options.projectId as string | undefined,
        location: options.location as string | undefined,
        keyFilename: options.keyFilename as string | undefined,
        json: options.json as boolean | undefined,
        yaml: options.yaml as boolean | undefined,
      });
    });
}
