import { beforeAll, describe, expect, it } from 'vitest';

import {
  analyzeQueryEnumAlignmentResource,
  auditQueryEnumAlignment,
} from '../src/query-resources/enum-alignment.js';

describe('query resource enum alignment guard', () => {
  let report: ReturnType<typeof auditQueryEnumAlignment>;

  beforeAll(() => {
    report = auditQueryEnumAlignment();
  }, 30_000);

  it('keeps query filter enums statically aligned to provider input enums', () => {
    expect(report.summary).toMatchObject({
      queryResourcesChecked: 106,
      queryEnumFiltersChecked: 22,
      providerBackedEnumFilters: 22,
      manualEnumFilters: 0,
      errors: 0,
      warnings: 0,
    });
    expect(report.findings).toEqual([]);
  });

  it('documents the missing provider rejection fixture layer', () => {
    expect(report.fixtureCoverage.positiveFixtures).toBeGreaterThan(0);
    expect(report.fixtureCoverage.providerRejectionFixtures).toBe(0);
    expect(report.fixtureCoverage.note).toContain('No first-class provider-rejection fixture');
  });

  it('preserves intentional output-semantic enum narrowing', () => {
    expect(getCheck(report, 'github', 'workflow_runs', 'status')).toMatchObject({
      enum: ['completed', 'in_progress', 'queued', 'requested', 'waiting', 'pending'],
      boundInputs: [
        {
          operator: 'eq',
          input: 'status',
          providerEnum: expect.arrayContaining(['completed', 'success', 'timed_out']),
        },
      ],
      providerBacked: true,
    });
  });

  it('flags query enum literals that providers do not declare as acceptable input', () => {
    const analysis = analyzeQueryEnumAlignmentResource({
      integration: 'fixture',
      resource: 'runs',
      spec: {
        input: {
          status: {
            enum: ['open', 'closed'],
          },
        },
        query: {
          filters: {
            status: {
              operators: ['eq'],
              enum: ['open', 'archived'],
              bind: {
                eq: {
                  input: 'status',
                },
              },
            },
          },
        },
      },
    });

    expect(analysis.findings).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'query_enum_literal_not_in_provider_input_enum',
        field: 'status',
        input: 'status',
        literal: 'archived',
      }),
    ]);
  });

  it('uses provider item enums for array inputs bound to $in filters', () => {
    const analysis = analyzeQueryEnumAlignmentResource({
      integration: 'fixture',
      resource: 'issues',
      spec: {
        input: {
          states: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['open', 'closed'],
            },
          },
        },
        query: {
          filters: {
            state: {
              operators: ['in'],
              enum: ['open', 'archived'],
              bind: {
                in: {
                  input: 'states',
                },
              },
            },
          },
        },
      },
    });

    expect(analysis.checks[0]).toMatchObject({
      providerBacked: true,
      boundInputs: [
        {
          operator: 'in',
          input: 'states',
          providerEnum: ['open', 'closed'],
        },
      ],
    });
    expect(analysis.findings).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'query_enum_literal_not_in_provider_input_enum',
        field: 'state',
        operator: 'in',
        input: 'states',
        literal: 'archived',
      }),
    ]);
  });
});

function getCheck(
  report: ReturnType<typeof auditQueryEnumAlignment>,
  integration: string,
  resource: string,
  field: string
): ReturnType<typeof auditQueryEnumAlignment>['checks'][number] | undefined {
  return report.checks.find(
    (check) =>
      check.integration === integration && check.resource === resource && check.field === field
  );
}
