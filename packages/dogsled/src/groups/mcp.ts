import { Command } from 'commander';

import { registerMcpServeCommand } from '../commands/mcp-serve.js';

const MCP_COMMANDS = [
  ['discover', 'Scaffold or extend a Source from an MCP server'],
  ['list-builders', 'List MCP query filter builders'],
  ['list-tools', 'List tools exposed by an MCP transport'],
  ['verify-redaction', 'Verify MCP dry-run redaction'],
] as const;

export const MCP_SUBCOMMANDS = MCP_COMMANDS.map(([name]) => name);

export function createMcpGroup(): Command {
  const group = new Command('mcp');

  group
    .description('MCP extractor commands')
    .option('-v, --verbose', 'Verbose output')
    .option('-q, --quiet', 'Suppress non-error output')
    .option('--log-format <format>', 'Control log format: json or pretty')
    .showHelpAfterError();

  for (const [name, description] of MCP_COMMANDS) {
    group
      .command(`${name} [args...]`)
      .description(description)
      .allowUnknownOption()
      .allowExcessArguments()
      .helpOption(false);
  }
  registerMcpServeCommand(group);

  return group;
}
