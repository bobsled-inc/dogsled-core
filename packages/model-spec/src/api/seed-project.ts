/**
 * Seed orchestrators — Layer 3 for `dogsled model seed validate|load|diff`.
 *
 * Split into three entry points to keep host code honest about what it wants:
 *   - `validateSeeds` — parse + CSV validation only (no runner)
 *   - `loadSeeds`     — compile seed SQL and optionally execute via runner
 *   - `diffSeeds`     — compare warehouse state vs local CSV (requires runner)
 *
 * Seeds do not fan out per integration; they operate against a single
 * `{ dialect, schema }` pair resolved from `model-spec.yml` (or overridden by caller).
 */

import path from 'node:path';
import type { ProjectIndex } from '@bobsled-inc/project-index';

import type { SqlRunner, SupportedDialect } from '../compiler/index.js';
import { generateSeedSql, generateSeedStatements } from '../compiler/seed/codegen.js';
import { CommandError } from '../errors.js';
import { readSeedCsv, resolveSeedEnv } from './seed-env.js';

import type { DiscoveredBareSeedCsv } from './project-seeds.js';

export {
  diffSeeds,
  type DiffSeedsOptions,
  type DiffSeedsResult,
  type SeedDiffEntry,
  type SeedDiffResultEntry,
} from './seed-diff.js';

// ---------------------------------------------------------------------------
// validateSeeds
// ---------------------------------------------------------------------------

export interface SeedValidationEntry {
  name: string;
  /** Project-relative POSIX path to the seed spec. */
  specPath: string;
  status: 'valid' | 'invalid';
  csvPath: string;
  rowCount?: number;
  columnCount?: number;
  error?: string;
  /** Max exit code seen for this seed (1 = runtime, 2 = validation). */
  exitCode?: number;
}

export interface ValidateSeedsOptions {
  /** Override project dialect. Rarely needed — seeds don't emit DDL during validate. */
  dialect?: SupportedDialect;
  /** Override project schema. */
  schema?: string;
  /** Optional seed folder override, relative to the project root. */
  seedsDir?: string;
  /** Reuse an index already built for this Project. */
  index?: ProjectIndex;
}

export interface ValidateSeedsResult {
  ok: boolean;
  seeds: SeedValidationEntry[];
  bareCsvFiles: readonly DiscoveredBareSeedCsv[];
  /** Max exit code across all failing seeds; 0 when all pass. */
  exitCode: number;
}

export function validateSeeds(cwd: string, opts: ValidateSeedsOptions = {}): ValidateSeedsResult {
  const env = resolveSeedEnv(cwd, opts);

  const seeds: SeedValidationEntry[] = [];
  let exitCode = 0;

  for (const [name, parsed] of env.specs) {
    try {
      const { csvData } = readSeedCsv(parsed);
      seeds.push({
        name,
        specPath: path.relative(env.projectRoot, parsed.filePath).split(path.sep).join('/'),
        status: 'valid',
        csvPath: parsed.csvPath,
        rowCount: csvData.rowCount,
        columnCount: csvData.headers.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof CommandError ? err.exitCode : 1;
      exitCode = Math.max(exitCode, code);
      seeds.push({
        name,
        specPath: path.relative(env.projectRoot, parsed.filePath).split(path.sep).join('/'),
        status: 'invalid',
        csvPath: parsed.csvPath,
        error: message,
        exitCode: code,
      });
    }
  }

  return {
    ok: exitCode === 0 && env.bareCsvFiles.every((file) => file.error === undefined),
    seeds,
    bareCsvFiles: env.bareCsvFiles,
    exitCode: env.bareCsvFiles.some((file) => file.error !== undefined)
      ? Math.max(exitCode, 2)
      : exitCode,
  };
}

// ---------------------------------------------------------------------------
// loadSeeds
// ---------------------------------------------------------------------------

export interface SeedLoadEntry {
  name: string;
  schema: string;
  executed: boolean;
  rowsLoaded: number;
  rowsAffected?: number;
  sql?: string;
  error?: string;
  exitCode?: number;
}

export interface LoadSeedsOptions {
  dialect?: SupportedDialect;
  schema?: string;
  /** Optional seed folder override, relative to the project root. */
  seedsDir?: string;
  /** Optional runner — when omitted, `loadSeeds` compiles SQL without executing. */
  runner?: SqlRunner;
}

export interface LoadSeedsResult {
  ok: boolean;
  dialect: SupportedDialect;
  schema: string;
  seeds: SeedLoadEntry[];
  exitCode: number;
}

export async function loadSeeds(
  cwd: string,
  opts: LoadSeedsOptions = {}
): Promise<LoadSeedsResult> {
  if (opts.dialect == null) {
    throw new CommandError(
      'seed load requires --dialect. Top-level dialect in model-spec.yml is no longer supported; pass --dialect <dialect> on the command line.',
      2
    );
  }
  const env = resolveSeedEnv(cwd, opts);

  const seeds: SeedLoadEntry[] = [];
  let exitCode = 0;

  for (const [name, parsed] of env.specs) {
    const effectiveSchema = parsed.spec.materialization.target_schema ?? env.schema;
    let rowsLoaded = 0;
    let executed = false;

    try {
      const { csvData } = readSeedCsv(parsed);
      rowsLoaded = csvData.rowCount;
      if (!opts.runner) {
        const sql = generateSeedSql(parsed, csvData, env.dialect, effectiveSchema);
        seeds.push({
          name,
          schema: effectiveSchema,
          executed: false,
          rowsLoaded,
          sql,
        });
        continue;
      }

      // One statement per runner call: warehouse drivers such as BigQuery's
      // and Snowflake's reject a multi-statement script in a single call.
      const statements = generateSeedStatements(parsed, csvData, env.dialect, effectiveSchema);
      executed = true;
      let rowsAffected: number | undefined;
      for (const statement of statements) {
        const execution = await opts.runner(statement);
        // Count only INSERT rows: drivers report DDL differently (Snowflake
        // returns -1), so CREATE and DROP results are ignored.
        if (
          /^INSERT\b/.test(statement) &&
          execution.rowCount !== undefined &&
          execution.rowCount >= 0
        ) {
          rowsAffected = (rowsAffected ?? 0) + execution.rowCount;
        }
      }
      seeds.push({
        name,
        schema: effectiveSchema,
        executed: true,
        rowsLoaded,
        rowsAffected,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof CommandError ? err.exitCode : 1;
      exitCode = Math.max(exitCode, code);
      seeds.push({
        name,
        schema: effectiveSchema,
        executed,
        rowsLoaded,
        error: message,
        exitCode: code,
      });
    }
  }

  return {
    ok: exitCode === 0,
    dialect: env.dialect,
    schema: env.schema,
    seeds,
    exitCode,
  };
}
