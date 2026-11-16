import { describe, expect, it } from 'vitest';

import type { ValidationIssue } from '../../../../src/runner/config/loader.js';
import { validateUniqueResolvedResources } from '../../../../src/runner/config/validate-resource-selection.js';
import { makePipeline } from '../fixtures.js';

describe('validateUniqueResolvedResources', () => {
  it('rejects duplicate authored resource references', () => {
    const pipeline = makePipeline({
      name: 'duplicates',
      resources: [{ name: 'issues' }, { name: 'issues' }],
    });
    const errors: ValidationIssue[] = [];

    validateUniqueResolvedResources(pipeline, errors);

    expect(errors).toEqual([
      expect.objectContaining({
        path: 'dogsled.yml:pipelines.duplicates.resources',
        message: expect.stringContaining('issues / issues → issues'),
      }),
    ]);
  });

  it('rejects an entity alias and concrete variant that resolve to one stream', () => {
    const pipeline = makePipeline({
      name: 'alias_collision',
      resources: [
        { name: 'issues_mcp', requestedName: 'issues' },
        { name: 'issues_mcp', requestedName: 'issues_mcp' },
      ],
    });
    const errors: ValidationIssue[] = [];

    validateUniqueResolvedResources(pipeline, errors);

    expect(errors[0]!.message).toContain('issues / issues_mcp → issues_mcp');
  });
});
