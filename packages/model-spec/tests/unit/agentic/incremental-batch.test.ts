import { describe, expect, it } from 'vitest';
import { takeIncrementalBatch } from '../../../src/agentic/incremental-batch.js';
import type { AgenticStateError } from '../../../src/agentic/index.js';

const options = (maxRows = 3, maxBytes = 1_048_576) => ({
  label: 'Agentic input "events"',
  cursorField: 'seq',
  cursorType: 'integer',
  maxRows,
  maxBytes,
});
const rows = (...seqs: number[]) => seqs.map((seq, index) => ({ id: `r${index}`, seq }));
const failure = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error as AgenticStateError;
  }
  throw new Error('Expected a failure');
};

describe('takeIncrementalBatch', () => {
  it('returns every row when they all fit', () => {
    expect(takeIncrementalBatch(rows(1, 2, 3), options())).toEqual({
      rows: rows(1, 2, 3),
      more: false,
    });
  });

  it('cuts at the row limit and reports that rows remain', () => {
    const taken = takeIncrementalBatch(rows(1, 2, 3, 4), options());
    expect(taken.rows.map((row) => (row as { seq: number }).seq)).toEqual([1, 2, 3]);
    expect(taken.more).toBe(true);
  });

  it('never splits rows that share the cursor value at the cut', () => {
    const taken = takeIncrementalBatch(rows(1, 2, 2, 2), options());
    expect(taken.rows.map((row) => (row as { seq: number }).seq)).toEqual([1]);
    expect(taken.more).toBe(true);
  });

  it('cuts at the byte limit as well as the row limit', () => {
    const big = (seq: number) => ({ seq, text: 'x'.repeat(400_000) });
    const taken = takeIncrementalBatch([big(1), big(2), big(3)], options(1000));
    expect(taken.rows).toHaveLength(2);
    expect(taken.more).toBe(true);
  });

  it('explains a group of equal cursor values that cannot fit in one batch', () => {
    const error = failure(() => takeIncrementalBatch(rows(5, 5, 5, 5), options()));
    expect(error.reason).toBe('cursor_tie_too_large');
    expect(error.message).toContain('more rows with one seq value than fit in one batch');
  });

  it('refuses rows that are not in cursor order', () => {
    const error = failure(() => takeIncrementalBatch(rows(1, 3, 2, 4), options()));
    expect(error.reason).toBe('unordered_incremental_input');
  });

  it('reports a first row that is too large on its own', () => {
    const error = failure(() =>
      takeIncrementalBatch([{ seq: 1, text: 'x'.repeat(1_100_000) }, { seq: 2 }], options())
    );
    expect(error.reason).toBe('row_too_large');
    expect(error.message).toContain('row 1 exceeds the per-row limits');
  });
});
