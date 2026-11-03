import { describe, expect, it } from 'vitest';
import { AgenticStateError, isBoundedAgenticJson } from '../../../src/agentic/index.js';
import { boundedAgenticRows } from '../../../src/agentic/rows.js';

const wideRow = (index: number) =>
  Object.fromEntries(Array.from({ length: 30 }, (_, column) => [`c${column}`, `${index}`]));

function failure(value: unknown) {
  try {
    boundedAgenticRows(value, 'Agentic input "pairs"');
  } catch (error) {
    return error as AgenticStateError;
  }
  throw new Error('Expected a failure');
}

describe('boundedAgenticRows', () => {
  it('accepts 1,000 wide rows that a whole-batch value limit would reject', () => {
    const rows = Array.from({ length: 1000 }, (_, index) => wideRow(index));
    expect(isBoundedAgenticJson(rows)).toBe(false);
    expect(boundedAgenticRows(rows, 'Agentic input "pairs"')).toHaveLength(1000);
  });

  it('names the limit that was exceeded', () => {
    const many = failure(Array.from({ length: 1001 }, () => ({ id: 'a' })));
    expect(many.reason).toBe('too_many_rows');
    expect(many.message).toContain('Agentic input "pairs" has 1,001 rows; the limit is 1,000.');

    const deep = failure([{ id: 'a' }, { nested: Array.from({ length: 17000 }, () => 1) }]);
    expect(deep.reason).toBe('row_too_large');
    expect(deep.message).toContain('row 2 exceeds the per-row limits');

    const large = failure(Array.from({ length: 3 }, () => ({ text: 'x'.repeat(400_000) })));
    expect(large.reason).toBe('batch_too_large');
    expect(large.message).toMatch(/is 1\.\d\d MiB; the limit is 1 MiB across its 3 rows/);

    expect(failure({ id: 'a' }).reason).toBe('invalid_rows');
  });
});
