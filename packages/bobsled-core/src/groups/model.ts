import { Command } from 'commander';

const MODEL_COMMANDS = [
  ['compile', 'Compile YAML specs into warehouse SQL'],
  ['dry-run', 'Inline draft model deps and execute against the warehouse without persisting'],
  ['generate', 'Generate Model Spec YAML model specs from existing SQL'],
  ['run', 'Compile and execute models in DAG order'],
  ['profile', 'Profile warehouse table data and suggest cleaning'],
  ['test', 'Generate test SQL from model definitions'],
  ['expect', 'Compile or run model expectations'],
  ['lineage', 'Show model dependency lineage'],
  ['init', 'Scaffold a new project with example files'],
  ['validate', 'Validate model specs for correctness'],
  ['seed', 'Manage reference data (seeds)'],
  ['models', 'Browse and install prebuilt model bundles'],
  ['ossie', 'Import and export Ossie with native Bobsled Core models'],
] as const;

export const MODEL_SUBCOMMANDS = MODEL_COMMANDS.map(([name]) => name);

export function createModelGroup(): Command {
  const group = new Command('model');

  group
    .description('Modeling commands')
    .option('-v, --verbose', 'Verbose output')
    .option('-q, --quiet', 'Suppress non-error output')
    .showHelpAfterError();

  for (const [name, description] of MODEL_COMMANDS) {
    group
      .command(`${name} [args...]`)
      .description(description)
      .allowUnknownOption()
      .allowExcessArguments()
      .helpOption(false);
  }

  return group;
}
