import { CommandError } from '@bobsled-inc/protocol';

import type { SqlParams } from './types.js';

/** Native scalar binds; dates and big integers retain their exact text value. */
export function positionalBindings(
  params: SqlParams | undefined
): Array<string | number | boolean | null> | undefined {
  if (params === undefined) return undefined;
  if (!Array.isArray(params)) {
    throw new CommandError('This runner requires positional SQL parameters.', 2);
  }
  return params.map((value: unknown) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
    throw new CommandError('SQL parameters must be finite scalar values or valid dates.', 2);
  });
}
