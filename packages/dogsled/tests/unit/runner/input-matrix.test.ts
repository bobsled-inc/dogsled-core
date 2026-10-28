import { describe, expect, it } from 'vitest';

import {
  MAX_INPUT_MATRIX_COMBINATIONS,
  expandInputMatrix,
} from '../../../src/runner/config/input-matrix.js';

describe('expandInputMatrix', () => {
  it('expands axes in authored order with the first axis outermost', () => {
    expect(
      expandInputMatrix({
        axes: {
          tour: ['pga', 'euro'],
          year: [2024, 2025],
        },
        concurrency: 2,
      })
    ).toEqual([
      { tour: 'pga', year: 2024 },
      { tour: 'pga', year: 2025 },
      { tour: 'euro', year: 2024 },
      { tour: 'euro', year: 2025 },
    ]);
  });

  it('rejects a product larger than the platform bound', () => {
    expect(() =>
      expandInputMatrix({
        axes: {
          left: Array.from({ length: 101 }, (_, index) => index),
          right: Array.from({ length: 100 }, (_, index) => index),
        },
        concurrency: 1,
      })
    ).toThrow(new RegExp(`${MAX_INPUT_MATRIX_COMBINATIONS}`));
  });

  it('rejects an empty axis when called outside schema validation', () => {
    expect(() => expandInputMatrix({ axes: { tour: [] }, concurrency: 1 })).toThrow(
      /must contain at least one value/
    );
  });
});
