import { Command } from 'commander';

const EXTRACT_COMMANDS = [
  ['run', 'Run extraction pipeline'],
  ['estimate', 'Estimate extraction work'],
  ['health-check', 'Run a lightweight integration health check'],
  ['discover', 'List resources for an integration'],
  ['validate', 'Validate integration and resource specs'],
  ['init', 'Scaffold a new extractor project'],
  ['lookup', 'Look up records using a resource lookup operation'],
  ['topup', 'Extract records within a cursor range'],
  ['generate', 'Generate extractor specs from an OpenAPI document'],
  ['check', 'Compare integration specs with an OpenAPI document'],
  ['commit-state', 'Commit captured extraction state'],
  ['activate', 'Dispatch records through API actions'],
  ['mcp', 'Inspect and use MCP integrations'],
  ['verify', 'Verify integration specs offline'],
  ['scaffold-test', 'Test auth, config, and one record per resource'],
  ['smoke-test', 'Alias for scaffold-test'],
  ['test-auth', 'Alias for scaffold-test'],
] as const;

export const EXTRACT_SUBCOMMANDS = EXTRACT_COMMANDS.map(([name]) => name);

export function createExtractGroup(): Command {
  const group = new Command('extract');

  group
    .description('Extractor commands')
    .option('-v, --verbose', 'Verbose output')
    .option('-q, --quiet', 'Suppress non-error output')
    .option('--log-format <format>', 'Control log format: json or pretty')
    .showHelpAfterError();

  for (const [name, description] of EXTRACT_COMMANDS) {
    group
      .command(`${name} [args...]`)
      .description(description)
      .allowUnknownOption()
      .allowExcessArguments()
      .helpOption(false);
  }

  return group;
}
