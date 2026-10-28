/**
 * `model expect` command group.
 *
 * Expectations compile to sentinel SELECT statements. With --runner, the
 * runner's query(sql) result decides pass/fail; without --runner the command
 * prints the SQL plan so it can be reviewed or tested without warehouse access.
 */

import type { Command } from 'commander';

import { CommandError } from '@bobsled-inc/protocol';

import { expectProject } from '../api/expect-project.js';
import * as out from '../output.js';

import { createIntegrationOption, loadRunnerModule, parseGlobalFlags } from './common.js';

interface ExpectRunOptions {
  integration?: string;
  model?: string;
  runner?: string;
  json?: boolean;
}

async function expectRunHandler(
  options: ExpectRunOptions,
  globalOptions: { verbose?: boolean; quiet?: boolean; json?: boolean }
): Promise<void> {
  const flags = parseGlobalFlags({ ...globalOptions, json: options.json ?? globalOptions.json });
  const runnerModule = options.runner ? await loadRunnerModule(options.runner) : undefined;
  if (runnerModule && typeof runnerModule.query !== 'function') {
    throw new CommandError('model expect run requires a runner module with query(sql).', 2);
  }

  const result = await expectProject(process.cwd(), {
    integration: options.integration,
    models: options.model ? [options.model] : undefined,
    query: runnerModule?.query,
  });

  const emitWarnings = () => {
    for (const warning of result.warnings) out.warn(warning);
    for (const skipped of result.skipped) out.warn(skipped.message);
  };

  if (flags.json || options.json) {
    out.json({
      command: 'model.expect.run',
      ok: result.ok,
      executed: Boolean(runnerModule?.query),
      warnings: result.warnings,
      skipped: result.skipped.map((skipped) => skipped.message),
      expectations: result.entries.map((entry) => ({
        handle: entry.handle,
        dialect: entry.dialect,
        model_name: entry.modelName,
        kind: entry.kind,
        target: entry.target,
        severity: entry.severity,
        executed: entry.executed,
        status: entry.status,
        violation_count: entry.violationCount,
        sql: entry.sql,
        error: entry.error,
      })),
    });
  } else if (!runnerModule?.query) {
    emitWarnings();
    for (const entry of result.entries) {
      out.text(`-- ${entry.modelName}: ${entry.kind} ${entry.target}\n${entry.sql}\n\n`);
    }
    if (!flags.quiet) {
      out.success(`Compiled ${result.entries.length} expectation statement(s).`);
    }
  } else {
    emitWarnings();
    for (const entry of result.entries) {
      if (entry.status === 'passed') {
        if (!flags.quiet) out.success(`${entry.modelName}: ${entry.kind} ${entry.target}`);
      } else if (entry.status === 'warned') {
        out.warn(
          `${entry.modelName}: ${entry.kind} ${entry.target} warned` +
            (entry.violationCount !== undefined ? ` (${entry.violationCount} violation(s))` : '')
        );
      } else {
        out.error(
          `${entry.modelName}: ${entry.kind} ${entry.target} failed` +
            (entry.violationCount !== undefined
              ? ` (${entry.violationCount} violation(s))`
              : entry.error
                ? ` (${entry.error})`
                : '')
        );
      }
    }
  }

  if (!result.ok) {
    throw new CommandError('One or more expectations failed.', 2);
  }
}

export function registerExpectCommand(program: Command): void {
  const expect = program.command('expect').description('Compile or run model expectations');

  expect
    .command('run')
    .description('Compile expectation sentinel SQL or execute it with a query runner')
    .addOption(createIntegrationOption())
    .option('--model <name>', 'Run expectations for one model')
    .option('--runner <path>', 'Path to SQL runner module with query(sql)')
    .option('--json', 'Output results as JSON to stdout')
    .action(async (opts: ExpectRunOptions) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean; json?: boolean }>();
      await expectRunHandler(opts, globalOptions);
    });
}
