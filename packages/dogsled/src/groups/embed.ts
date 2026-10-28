import { Command } from 'commander';

const EMBED_COMMANDS = [
  ['run', 'Read protocol messages from stdin and enrich configured fields'],
] as const;

export const EMBED_SUBCOMMANDS = EMBED_COMMANDS.map(([name]) => name);

export function createEmbedGroup(): Command {
  const group = new Command('embed');

  group.description('Embedding commands').showHelpAfterError();

  for (const [name, description] of EMBED_COMMANDS) {
    group
      .command(`${name} [args...]`)
      .description(description)
      .allowUnknownOption()
      .allowExcessArguments()
      .helpOption(false);
  }

  return group;
}
