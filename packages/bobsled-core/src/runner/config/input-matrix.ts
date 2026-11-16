import { CommandError } from '@bobsled-inc/protocol';

export const MAX_INPUT_MATRIX_COMBINATIONS = 10_000;
export const MAX_INPUT_MATRIX_AXIS_VALUES = 10_000;

export type InputMatrixScalar = string | number | boolean;

export interface InputMatrixDefinition {
  axes: Record<string, InputMatrixScalar[]>;
  concurrency: number;
}

/**
 * Expand a static input matrix in authored axis order. The first axis is the
 * outer loop, so the output is stable in YAML order and easy to reproduce in
 * a dry run or a failed-tuple diagnostic.
 */
export function expandInputMatrix(
  matrix: InputMatrixDefinition
): Array<Record<string, InputMatrixScalar>> {
  const axes = Object.entries(matrix.axes);
  if (axes.length === 0) return [];

  const combinations = axes.reduce((size, [name, values]) => {
    if (values.length === 0) {
      throw new CommandError(`input_matrix axis "${name}" must contain at least one value.`);
    }
    if (values.length > MAX_INPUT_MATRIX_AXIS_VALUES) {
      throw new CommandError(
        `input_matrix axis "${name}" contains ${values.length} values; ` +
          `the maximum is ${MAX_INPUT_MATRIX_AXIS_VALUES}.`
      );
    }
    return size > MAX_INPUT_MATRIX_COMBINATIONS / values.length
      ? MAX_INPUT_MATRIX_COMBINATIONS + 1
      : size * values.length;
  }, 1);
  if (combinations > MAX_INPUT_MATRIX_COMBINATIONS) {
    throw new CommandError(
      `input_matrix expands to ${combinations} combinations; the maximum is ${MAX_INPUT_MATRIX_COMBINATIONS}.`
    );
  }

  const expanded: Array<Record<string, InputMatrixScalar>> = [];
  const current: Record<string, InputMatrixScalar> = Object.create(null);
  const visit = (index: number): void => {
    if (index === axes.length) {
      expanded.push({ ...current });
      return;
    }
    const [name, values] = axes[index]!;
    for (const value of values) {
      current[name] = value;
      visit(index + 1);
    }
  };
  visit(0);
  return expanded;
}

export function matrixTupleLabel(tuple: Record<string, unknown>): string {
  return JSON.stringify(tuple, Object.keys(tuple).sort());
}
