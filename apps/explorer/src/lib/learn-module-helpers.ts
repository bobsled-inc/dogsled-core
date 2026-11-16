import { buildTerminalHref, type ExplorerBobsledCommand } from './command-links';
import type { LearnAction } from './learn-curriculum';

export const command = (commandName: string, args: string[]): ExplorerBobsledCommand => ({
  command: commandName,
  args,
});

export const terminalAction = (label: string, cmd: ExplorerBobsledCommand): LearnAction => ({
  label,
  href: buildTerminalHref(cmd),
  autoCompletes: true,
});
