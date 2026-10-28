import { Command } from 'commander';

export function createActivateGroup(): Command {
  const group = new Command('activate');

  group
    .description('Dispatch entity projection records to external systems via action specs')
    .argument('[sync_name]', 'Sync name identifying this activation run')
    .option('--action <path>', 'Path to action YAML spec (required for dispatch)')
    .option('--integration <path>', 'Path to integration YAML spec')
    .option('--projection <fq_table>', 'Projection table to read from')
    .option('--entity <name>', 'Entity name (used with --schema to compute projection)')
    .option('--schema <schema>', 'Schema where the projection table lives')
    .option('--runner <path>', 'Path to SQL runner module')
    .option('--dry-run', 'Validate without making HTTP calls')
    .option('--limit <n>', 'Max records to dispatch')
    .option('--policy-file <path>', 'Path to policy YAML spec')
    .option('--spec-dir <dir>', 'Directory to discover *.policy.yml files')
    .option('--contract-schema <name>', 'Entity graph audit schema')
    .option('--dialect <dialect>', 'SQL dialect')
    .option('--json', 'Emit JSON summary')
    .option('--verbose', 'Enable verbose output')
    .option('--quiet', 'Suppress non-error output')
    .showHelpAfterError();

  group
    .command('receipts [args...]')
    .description('Query activation dispatch/receipt events from the audit log')
    .option('--json', 'Output as JSON')
    .option('--verbose', 'Enable verbose output')
    .option('--quiet', 'Suppress non-error output')
    .allowUnknownOption()
    .allowExcessArguments()
    .helpOption(false);

  return group;
}
