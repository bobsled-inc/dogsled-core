import { describe, expect, it } from 'vitest';
import { createRunnerGroup } from '../../../src/runner/index.js';

describe('runner command surface', () => {
  it('retains local validation and execution', () => {
    expect(createRunnerGroup().commands.map((command) => command.name())).toEqual([
      'validate',
      'run',
    ]);
  });
});
