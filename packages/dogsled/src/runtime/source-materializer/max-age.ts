import { CommandError } from '@bobsled-inc/protocol';

export function parseMaxAge(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+)(s|m|h|d)$/.exec(value);
  if (!match) {
    throw new CommandError(`max_age must match <N><s|m|h|d>: ${value}`, 2);
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 60 * 60 : 24 * 60 * 60;
  return amount * multiplier;
}
