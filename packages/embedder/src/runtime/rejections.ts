import type { JsonObject } from '@bobsled-inc/protocol';

const MAX_REPORTED_CODES = 20;
const OTHER_CODES = 'other';

/** The `event` of the LOG message that reports a stream's refused inputs. */
export const INPUTS_REJECTED_EVENT = 'embedding.inputs_rejected';

/** Add one result's refused inputs to a stream's counts and return how many there were. */
export function addRejections(
  counts: Map<string, number>,
  rejections: ReadonlyMap<string, number>
): number {
  let total = 0;
  for (const [code, count] of rejections) {
    // The provider chooses the codes, so cap how many distinct ones are kept.
    const key = counts.has(code) || counts.size < MAX_REPORTED_CODES ? code : OTHER_CODES;
    counts.set(key, (counts.get(key) ?? 0) + count);
    total += count;
  }
  return total;
}

/** A stream's refused inputs for people and, as attributes, for programs. */
export function describeRejections(
  stream: string,
  counts: ReadonlyMap<string, number>
): { message: string; event: string; attributes: JsonObject } {
  const sorted = [...counts].sort(([leftCode, left], [rightCode, right]) =>
    right === left ? (leftCode < rightCode ? -1 : 1) : right - left
  );
  const total = sorted.reduce((sum, [, count]) => sum + count, 0);
  return {
    message:
      `The embedding provider refused ${total} input${total === 1 ? '' : 's'} in stream ` +
      `"${stream}", and their vectors are null ` +
      `(${sorted.map(([code, count]) => `${code}: ${count}`).join(', ')})`,
    event: INPUTS_REJECTED_EVENT,
    // `fromEntries` defines own keys, so a code such as `__proto__` is only a key.
    attributes: { stream, counts: Object.fromEntries(sorted) },
  };
}
