import { describe, expect, it } from 'vitest';

import {
  RUNNER_CATALOG,
  getRunnerCapabilities,
  listRunnerCapabilities,
} from '../../../../src/runner/config/runner-catalog.js';
import { PipelineRunnerSchema } from '../../../../src/runner/config/schema.js';

describe('RUNNER_CATALOG', () => {
  it('covers exactly the runners in PipelineRunnerSchema (stays in lockstep)', () => {
    const catalogRunners = Object.keys(RUNNER_CATALOG).sort();
    expect(catalogRunners).toEqual([...PipelineRunnerSchema.options].sort());
  });

  it('every entry self-describes its own name', () => {
    for (const [key, caps] of Object.entries(RUNNER_CATALOG)) {
      expect(caps.name).toBe(key);
    }
  });

  it('declares exactly one default runner (github-actions)', () => {
    const defaults = listRunnerCapabilities().filter((caps) => caps.is_default);
    expect(defaults.map((caps) => caps.name)).toEqual(['managed']);
  });

  it('the GitHub Actions runner supports for_each iteration', () => {
    expect(getRunnerCapabilities('managed').supports_for_each_iteration).toBe(true);
  });

  it('listRunnerCapabilities returns one entry per catalog runner', () => {
    expect(listRunnerCapabilities()).toHaveLength(Object.keys(RUNNER_CATALOG).length);
  });
});
