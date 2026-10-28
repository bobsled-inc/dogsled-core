import { buildTerminalHref, type ExplorerDogsledCommand } from './command-links';
import type { LearnAction } from './learn-curriculum';

export const command = (commandName: string, args: string[]): ExplorerDogsledCommand => ({
  command: commandName,
  args,
});

export const terminalAction = (label: string, cmd: ExplorerDogsledCommand): LearnAction => ({
  label,
  href: buildTerminalHref(cmd),
  autoCompletes: true,
});
