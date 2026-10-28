export interface ExplorerDogsledCommand {
  command: string;
  args: string[];
}

export interface ExplorerCommandSequence {
  sequence: ExplorerDogsledCommand[];
}

export type ExplorerCommand = ExplorerDogsledCommand | ExplorerCommandSequence;

export function isExplorerDogsledCommand(value: unknown): value is ExplorerDogsledCommand {
  return (
    typeof value === 'object' &&
    value !== null &&
    'command' in value &&
    typeof value.command === 'string' &&
    'args' in value &&
    Array.isArray(value.args) &&
    value.args.every((arg) => typeof arg === 'string') &&
    !('sequence' in value)
  );
}

export function isExplorerCommandSequence(value: unknown): value is ExplorerCommandSequence {
  return (
    typeof value === 'object' &&
    value !== null &&
    'sequence' in value &&
    Array.isArray(value.sequence) &&
    value.sequence.length > 0 &&
    value.sequence.every((entry) => isExplorerDogsledCommand(entry))
  );
}

export function encodeCommandParam(command: ExplorerCommand): string {
  return encodeURIComponent(JSON.stringify(command));
}

export function buildTerminalHref(command: ExplorerCommand): string {
  return `/terminal?cmd=${encodeCommandParam(command)}`;
}

function getCommands(command: ExplorerCommand): ExplorerDogsledCommand[] {
  return isExplorerCommandSequence(command) ? command.sequence : [command];
}

export function getFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

export function getDuckDbPathFromArgs(args: string[]): string | undefined {
  return getFlagValue(args, '--db-path');
}

export function getDuckDbPathFromExplorerCommand(command: ExplorerCommand): string | undefined {
  let dbPath: string | undefined;
  for (const entry of getCommands(command)) {
    const candidate = getDuckDbPathFromArgs(entry.args);
    if (candidate) {
      dbPath = candidate;
    }
  }

  return dbPath;
}

const FLAGS_WITH_VALUES = new Set(['--db-path', '--integration', '--profile', '--type']);

function getFirstPositionalArg(args: string[], startIndex = 0): string | undefined {
  for (let index = startIndex; index < args.length; index += 1) {
    const value = args[index];
    if (!value) {
      continue;
    }
    if (value.startsWith('--') && value.includes('=')) {
      continue;
    }
    if (FLAGS_WITH_VALUES.has(value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith('-')) {
      return value;
    }
  }
  return undefined;
}

export function getIntegrationFromCommand(command: string, args: string[]): string | undefined {
  if (command === 'pipeline') {
    const explicitIntegration = getFlagValue(args, '--integration');
    if (explicitIntegration) {
      return explicitIntegration;
    }
    const legacyIntegration = args[0];
    return legacyIntegration && !legacyIntegration.startsWith('-') ? legacyIntegration : undefined;
  }

  if (command === 'extract') {
    const explicitIntegration = getFlagValue(args, '--integration');
    if (explicitIntegration) {
      return explicitIntegration;
    }
    const subcommand = getFirstPositionalArg(args);
    if (!subcommand) return undefined;
    return getFirstPositionalArg(args, args.indexOf(subcommand) + 1);
  }

  if (command === 'integrations') {
    const subcommand = getFirstPositionalArg(args);
    if (subcommand === 'show') {
      return getFirstPositionalArg(args, args.indexOf(subcommand) + 1);
    }
  }

  return undefined;
}

export function getIntegrationFromExplorerCommand(command: ExplorerCommand): string | undefined {
  if (isExplorerCommandSequence(command)) {
    for (const entry of command.sequence) {
      const integration = getIntegrationFromCommand(entry.command, entry.args);
      if (integration) {
        return integration;
      }
    }
    return undefined;
  }

  return getIntegrationFromCommand(command.command, command.args);
}

export function getIntegrationsFromExplorerCommand(command: ExplorerCommand): string[] {
  const entries = isExplorerCommandSequence(command) ? command.sequence : [command];
  const integrations = entries
    .map((entry) => getIntegrationFromCommand(entry.command, entry.args))
    .filter((value): value is string => typeof value === 'string');
  return Array.from(new Set(integrations));
}

export function formatExplorerCommandForHistory(command: ExplorerCommand): ExplorerDogsledCommand {
  if (!isExplorerCommandSequence(command)) {
    return command;
  }

  const integrations = command.sequence
    .map((entry) => getIntegrationFromCommand(entry.command, entry.args))
    .filter((value): value is string => typeof value === 'string');

  if (integrations.length > 0 && command.sequence.every((entry) => entry.command === 'pipeline')) {
    return {
      command: 'pipeline-batch',
      args: integrations,
    };
  }

  return {
    command: 'sequence',
    args: [`${command.sequence.length} commands`],
  };
}
