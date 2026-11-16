import { CommandError } from '@bobsled-inc/protocol';
import { entriesOfKind, scanProject } from '@bobsled-inc/project-index';
import type { Command } from 'commander';

import * as fmt from '../lib/output/formatter.js';
import { projectQuerySpecLoader } from '../runtime/source-materializer/project-query-specs.js';
import { LazyQueryEngine } from '../runtime/lazy-query-engine.js';
import { resolveModelReferences } from '../runtime/model-query.js';
import type { GlobalOptions } from '../types/index.js';

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) =>
    typeof nested === 'bigint' ? Number(nested) : nested
  );
}

export function registerSourceQueryCommand(program: Command): void {
  program
    .command('source-query <sql...>')
    .description('Run a SQL query over sources.* with lazy API resource materialization')
    .option('--project-root <path>', 'Dogsled Project root (default: current directory)')
    .action(async (sqlParts: string[], options: { projectRoot?: string }, command: Command) => {
      const globalOptions = command.optsWithGlobals<GlobalOptions>();
      const projectRoot = options.projectRoot ?? globalOptions.projectRoot ?? process.cwd();
      const engine = new LazyQueryEngine({
        projectRoot,
        integrationSpecLoader: projectQuerySpecLoader(projectRoot),
        onReceipt: (line) => {
          if (!globalOptions.json && !globalOptions.quiet) process.stderr.write(`${line}\n`);
        },
      });

      try {
        // Resolve derived-model references (Phase 2) before the engine runs.
        // This splices any referenced model's self-contained SELECT in as a
        // leading CTE, introducing the `sources.X` the engine then hydrates.
        // A query referencing no models is returned unchanged.
        const index = scanProject(projectRoot);
        const resolved =
          entriesOfKind(index, 'model').length === 0
            ? sqlParts.join(' ')
            : await resolveModelReferences(sqlParts.join(' '), projectRoot);
        const result = await engine.runQuery(resolved);

        if (globalOptions.json) {
          process.stdout.write(
            `${stringifyJson({
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
        if (!globalOptions.quiet) process.stderr.write(`query_total_ms=${result.totalMs}\n`);
      } catch (err) {
        const exitCode = err instanceof CommandError ? err.exitCode : 1;
        const message = err instanceof Error ? err.message : String(err);
        if (globalOptions.json) {
          process.stdout.write(`${stringifyJson({ error: message, exit_code: exitCode })}\n`);
        } else {
          fmt.error(message, {
            json: false,
            quiet: globalOptions.quiet ?? false,
            verbose: false,
            noColor: false,
          });
        }
        process.exitCode = exitCode;
      }
    });
}
