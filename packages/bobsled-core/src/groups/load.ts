import { Command } from 'commander';

const LOAD_COMMANDS = [
  ['run', 'Read protocol messages from stdin and load them into a destination'],
  ['assert', 'Run SQL assertions against a DuckDB or BigQuery destination'],
  ['check', 'Validate destination connectivity and permissions'],
  ['query', 'Run a SQL query against a DuckDB or BigQuery database and print results'],
] as const;

export const LOAD_SUBCOMMANDS = LOAD_COMMANDS.map(([name]) => name);

export function createLoadGroup(): Command {
  const group = new Command('load');

  group.description('Loader commands').showHelpAfterError();

  for (const [name, description] of LOAD_COMMANDS) {
    group
      .command(`${name} [args...]`)
      .description(description)
      .allowUnknownOption()
      .allowExcessArguments()
      .helpOption(false);
  }

  return group;
}
