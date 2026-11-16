import { registerOntologyCommand } from './commands/ontology.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { registerExamplesCommand } from './commands/examples.js';
import { registerOnboardingCommand } from './commands/onboarding.js';
import { registerLearnCommand } from './commands/learn.js';
import { registerPipelineCommand } from './commands/pipeline.js';
import { registerSdkCommand } from '@bobsled-inc/sdk-codegen';
import { createActivateGroup } from './groups/activate.js';
import { createIntegrationsGroup } from './groups/integrations.js';
import { createMcpGroup } from './groups/mcp.js';
import { createSetupGroup } from './groups/setup.js';
import { createSkillGroup } from './groups/skill.js';
import { createRunnerGroup } from './runner/index.js';
import { CommandError } from '@bobsled-inc/protocol';
import { createGroup, maybeRunDelegatedCommand } from './runtime/delegation.js';

// Direct-import commands (no subprocess overhead)
import { registerActCommand } from './commands/act.js';
import { createAiGroup } from './commands/ai.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerInitCommand } from './commands/init.js';
import { registerSourceQueryCommand } from './commands/query-register.js';
import { registerSyncCommand } from './commands/sync.js';
import { registerVqCommand } from './commands/vq.js';

declare const __CLI_VERSION__: string | undefined;

// Build-time version injected by tsup; falls back for dev/source execution (tsx)
const cliVersion = typeof __CLI_VERSION__ !== 'undefined' ? __CLI_VERSION__ : '0.0.0-dev';

// ---------------------------------------------------------------------------
// Auto-detect output format for non-interactive environments.
//
// Priority (highest → lowest):
//   1. Explicit --json flag on the command line
//   2. BOBSLED_CORE_OUTPUT_FORMAT env var ("json" | "text")
//   3. CI=1 env var → JSON
//   4. Non-TTY stdout → JSON
//   5. Default: text (--json false)
// ---------------------------------------------------------------------------

export function resolveJsonDefault(): boolean {
  const envFormat = process.env['BOBSLED_CORE_OUTPUT_FORMAT']?.toLowerCase();
  if (envFormat === 'json') return true;
  if (envFormat === 'text') return false;
  if (process.env['CI'] === '1' || process.env['CI'] === 'true') return true;
  if (!process.stdout.isTTY) return true;
  return false;
}

export function applyJsonDefault(thisCommand: Command, _actionCommand: Command): void {
  const source = thisCommand.getOptionValueSource('json');
  if (source !== 'cli') {
    thisCommand.setOptionValue('json', resolveJsonDefault());
  }
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('bobsled')
    .version(cliVersion, '-V, --version', 'Display the CLI version')
    .description('Extract, load and model data with YAML project files')
    .showHelpAfterError()
    .option('--json', 'Emit all output as newline-delimited JSON', false)
    .option('--verbose', 'Enable verbose / debug-level output', false)
    .option('--quiet', 'Suppress all non-error output', false)
    .option('--config <path>', 'Path to a Bobsled Core project config file')
    .option('--project-root <path>', 'Bobsled Core Project root (default: current directory)')
    .option('--no-color', 'Disable ANSI colour codes');

  // Resolve --json default before each subcommand runs
  program.hook('preAction', applyJsonDefault);

  // First-run
  registerOntologyCommand(program);
  registerInitCommand(program);
  registerDoctorCommand(program);

  // ETL pipeline order — subprocess delegation (duckdb native deps, stdio piping)
  program.addCommand(createGroup('extract'));
  registerPipelineCommand(program);
  program.addCommand(createGroup('load'));
  program.addCommand(createGroup('model'));

  // Query / analysis
  // `query` is a subprocess-delegated command (DuckDB native binding); only a shell for --help
  program
    .command('query <sql>')
    .description('Run a SQL query against a DuckDB or BigQuery database')
    .option('--dest <dest>', 'Destination: duckdb or bigquery (default: duckdb)')
    .option('--db-path <path>', 'DuckDB database file path')
    .option('--project-id <id>', 'BigQuery project ID')
    .option('--dataset-id <id>', 'BigQuery dataset ID')
    .option('--location <location>', 'BigQuery location')
    .option('--key-filename <path>', 'BigQuery service account key file')
    .option('--yaml', 'Emit results as YAML (overrides auto-JSON detection)')
    .allowUnknownOption()
    .allowExcessArguments();
  registerSourceQueryCommand(program);
  registerVqCommand(program);
  registerSyncCommand(program);

  // Entity graph
  program.addCommand(createGroup('entity-graph'));
  program.addCommand(createActivateGroup());

  // Typed SDK codegen
  registerSdkCommand(program);

  // Integration tooling
  program.addCommand(createIntegrationsGroup());
  program.addCommand(createMcpGroup());
  registerActCommand(program);
  program.addCommand(createAiGroup(program));
  program.addCommand(createGroup('embed'));

  // Project / infra
  program.addCommand(createSetupGroup());
  program.addCommand(createSkillGroup());
  program.addCommand(createRunnerGroup());
  registerExamplesCommand(program);
  registerLearnCommand(program);
  registerOnboardingCommand(program);

  return program;
}

export function handleCliError(error: unknown): void {
  if (error instanceof CommandError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode;
    return;
  }

  if (error instanceof Error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  const message = error != null ? String(error) : 'An unknown error occurred';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    const delegation = await maybeRunDelegatedCommand(argv);
    if (delegation.handled) {
      process.exitCode = delegation.exitCode ?? 0;
      return;
    }

    await buildProgram().parseAsync(['node', 'bobsled', ...argv]);
  } catch (error) {
    handleCliError(error);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  await runCli();
}
