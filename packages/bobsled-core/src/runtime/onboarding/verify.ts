import type { TutorialDefinition, CheckOptions } from './tutorial.js';
import { resolveTutorial, requireStep } from './tutorials.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandError } from '@bobsled-inc/protocol';
import { z } from 'zod';
import { Evidence, PreviewTable, type StepId } from './schema.js';
import { inputHash, saveCheckpoint, saveAttempt } from './state.js';

export type CliReader = (
  root: string,
  sql: string,
  remote: boolean,
  databasePath?: string
) => Promise<unknown>;
export const readWithCli: CliReader = async (
  root,
  sql,
  remote,
  databasePath = '.dogsled/dogsled.duckdb'
) => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dirname(dir) !== dir) {
    const pkg = join(dir, 'package.json');
    if (
      existsSync(pkg) &&
      (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name ===
        '@bobsled-inc/bobsled-core'
    ) {
      break;
    }
    dir = dirname(dir);
  }
  const cli = join(dir, 'bin/cli.mjs');
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        cli,
        ...(remote ? ['--json', 'source-query', sql] : ['query', sql, '--db-path', databasePath]),
      ],
      {
        cwd: root,
        timeout: 120_000,
        maxBuffer: 5 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1', BOBSLED_CORE_OUTPUT_FORMAT: 'json' },
      }
    );
    return JSON.parse(stdout);
  } catch {
    throw new CommandError(
      'The data check failed. Run the step in your agent and inspect its command output, then verify again.',
      1
    );
  }
};
const Result = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).max(500),
  receipts: z.array(z.string().max(2000)).max(100).optional(),
});
export async function verifyOnboarding(
  root: string,
  step: StepId,
  read: CliReader = readWithCli,
  options: CheckOptions = {},
  tutorial?: TutorialDefinition
): Promise<Evidence> {
  tutorial ??= await resolveTutorial(root);
  requireStep(tutorial, step);
  const plan = tutorial.prepareCheck(step, options);
  if (!plan.queries.length) throw new CommandError('This chapter has no verification queries.', 2);
  const before = await inputHash(root, step, tutorial);
  if (plan.persist) await saveAttempt(root, step, 'running', before, tutorial);
  try {
    const tables: z.infer<typeof PreviewTable>[] = [];
    const receipts = [...plan.receipts];
    for (const query of plan.queries) {
      const sql = query.sql;
      const result = Result.parse(
        await read(root, sql, query.remote ?? plan.remote, tutorial.databasePath)
      );
      const totalRows = Number(result.rows[0]?.['_total_rows'] ?? result.rows.length);
      const rows = result.rows.map((row) =>
        Object.fromEntries(
          Object.entries(tutorial.normalizeRow?.(row) ?? row)
            .filter(([key]) => key !== '_total_rows')
            .map(([key, value]) => [
              key,
              typeof value === 'bigint'
                ? String(value)
                : value !== null && typeof value === 'object'
                  ? JSON.stringify(value, (_key, nested) =>
                      typeof nested === 'bigint' ? String(nested) : nested
                    )
                  : value,
            ])
        )
      );
      tables.push(
        PreviewTable.parse({
          name: query.name,
          columns: Object.keys(rows[0] ?? {}),
          rows,
          totalRows,
        })
      );
      receipts.push(sql, ...(result.receipts ?? []));
    }
    tutorial.validate(step, tables, options);
    if ((await inputHash(root, step, tutorial)) !== before) {
      throw new CommandError('Inputs changed during the check. Verify again.', 3);
    }
    const evidence = Evidence.parse({
      mode: plan.queries.some((query) => query.remote ?? plan.remote) ? 'live' : 'offline',
      tables,
      receipts,
    });
    if (plan.persist) await saveCheckpoint(root, step, evidence, tutorial);
    if (plan.persist) await saveAttempt(root, step, 'complete', before, tutorial);
    return evidence;
  } catch (error) {
    if (plan.persist) await saveAttempt(root, step, 'failed', before, tutorial);
    throw error;
  }
}
