import { describe, expect, it } from 'vitest';

import { compileQueryToMcpArgs } from '../../src/runtime/query/mcp-backend.js';

import type { ResourceSpec } from '../../src/types/index.js';

function makeMcpQueryableResource(): ResourceSpec {
  return {
    spec_version: '1',
    type: 'resource',
    name: 'contacts',
    integration: 'hubspot_mcp',
    description: 'Contacts',
    tool: {
      tool_name: 'search_with_filter_groups',
    },
    input: {},
    output: {
      id: { type: 'string', path: '$.id' },
      status: { type: 'string', path: '$.status' },
      updated_at: { type: 'timestamp', path: '$.updatedAt' },
    },
    extract: {
      record_path: '$.items',
    },
    query: {
      filters: {
        status: {
          operators: ['eq'],
          bind: {
            eq: { input: 'status' },
          },
        },
        updated_at: {
          operators: ['gte', 'lte'],
          bind: {
            gte: { input: 'since' },
            lte: { input: 'until' },
          },
        },
      },
    },
  } as ResourceSpec;
}

describe('compileQueryToMcpArgs', () => {
  it('uses direct_arg mode by default', () => {
    const args = compileQueryToMcpArgs(makeMcpQueryableResource(), {
      filter: {
        updated_at: { gte: '2026-03-01T00:00:00.000Z' },
      },
    });

    expect(args).toEqual({ since: '2026-03-01T00:00:00.000Z' });
  });

  it('passes all predicates to filter_dsl builders at once', () => {
    const args = compileQueryToMcpArgs(makeMcpQueryableResource(), {
      compile: {
        mode: 'filter_dsl',
        builder: 'hubspot/crm-search',
        field_map: {
          updated_at: 'hs_lastmodifieddate',
        },
      },
      filter: {
        status: 'open',
        updated_at: { gte: '2026-03-01T00:00:00.000Z' },
      },
    });

    expect(args).toEqual({
      filterGroups: [
        {
          filters: [
            { propertyName: 'status', operator: 'EQ', value: 'open' },
            {
              propertyName: 'hs_lastmodifieddate',
              operator: 'GTE',
              value: '2026-03-01T00:00:00.000Z',
            },
          ],
        },
      ],
    });
  });
});
