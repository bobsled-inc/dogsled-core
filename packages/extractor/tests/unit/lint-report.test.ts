import { describe, expect, it } from 'vitest';

import { emitLintAndDriftWarnings } from '../../src/runtime/lint-report.js';
import type { ControlLogger } from '../../src/runtime/control.js';
import { makeResource } from '../helpers/fixtures.js';

describe('emitLintAndDriftWarnings', () => {
  it('excludes contextual outputs from raw-response lint and drift checks', async () => {
    const resource = makeResource({
      name: 'events',
      output: {
        id: { type: 'integer', path: '$.id' },
        project_id: {
          type: 'integer',
          from: { resource: 'projects', path: '$.id' },
        },
      },
    });
    const warnings: string[] = [];
    const logger = {
      warn(message: string) {
        warnings.push(message);
        return Promise.resolve();
      },
    } as unknown as ControlLogger;

    await emitLintAndDriftWarnings({
      resource,
      rawRecords: [{ id: 1 }],
      pageData: { id: 1 },
      logger,
    });

    expect(warnings).toEqual([]);
  });
});
