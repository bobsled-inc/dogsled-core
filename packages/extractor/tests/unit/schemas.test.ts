import { describe, expect, it } from 'vitest';

import { ExtractorConfigSchema } from '../../src/schemas/config.js';
import { ExtractIntentsSchema } from '../../src/schemas/extract-intents.js';
import { IntegrationSpecSchema } from '../../src/schemas/integration.js';
import { ResourceSpecSchema } from '../../src/schemas/resource.js';
import { getResourceCapabilities } from '../../src/framework/extractor/index.js';
import { ExtractorStateSchema } from '../../src/schemas/state.js';

describe('IntegrationSpecSchema', () => {
  it('parses a valid integration with transport defaults', () => {
    const result = IntegrationSpecSchema.safeParse({
      auth_env_vars: ['GITHUB_TOKEN'],
      spec_version: '1',
      name: 'github',
      type: 'integration',
      transport: {
        base_url: 'https://api.github.com',
        auth: { type: 'bearer', token: '${{ env.GITHUB_TOKEN }}' },
        headers: { Accept: 'application/json' },
        retry: {
          retry_on: [429, 503],
          max_retries: 3,
          backoff: 'exponential',
          retry_after_header: true,
        },
        rate_limit: {
          requests_per_second: 10,
          burst: 20,
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects insecure base URLs and restricted headers', () => {
    const httpResult = IntegrationSpecSchema.safeParse({
      spec_version: '1',
      name: 'bad',
      type: 'integration',
      transport: {
        base_url: 'http://api.example.com',
      },
    });
    const headerResult = IntegrationSpecSchema.safeParse({
      spec_version: '1',
      name: 'bad',
      type: 'integration',
      transport: {
        base_url: 'https://api.example.com',
        headers: { Authorization: 'blocked' },
      },
    });

    expect(httpResult.success).toBe(false);
    expect(headerResult.success).toBe(false);
  });
});

describe('ResourceSpecSchema', () => {
  it('parses a lookup-only resource without an extraction operation', () => {
    const result = ResourceSpecSchema.safeParse({
      type: 'resource',
      name: 'users',
      via: 'default',
      description: 'Users from the identity API',
      output: {
        id: { type: 'string', path: '$.id' },
        name: { type: 'string', path: '$.name' },
      },
      lookup: {
        description: 'Look up one user by ID',
        api: {
          endpoint: '/users/${{ input.user_id }}',
          method: 'GET',
        },
        input: {
          user_id: { type: 'string', required: true },
        },
        extract: {
          record_path: '$.data.user',
        },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      name: 'users',
      lookup: {
        description: 'Look up one user by ID',
      },
    });
    expect('extract' in result.data).toBe(false);
    expect(getResourceCapabilities(result.data)).toEqual({
      extract: false,
      lookup: true,
      query: false,
    });
  });

  it('parses resource and lookup operations with nested output fields', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      name: 'graphql_query',
      type: 'resource',
      integration: 'api',
      description: 'GraphQL query',
      api: {
        endpoint: '/graphql',
        method: 'POST',
        headers: { 'X-Repo': '${{ input.repo }}' },
        request_body: {
          query: 'query',
          variables: {
            ids: ['${{ input.first_id }}', '${{ input.second_id }}'],
          },
        },
      },
      input: {
        repo: { type: 'string', required: true },
        first_id: { type: 'string', required: true },
        second_id: { type: 'string', required: true },
      },
      output: {
        nodes: {
          type: 'array',
          path: '$.data.nodes',
          items: {
            type: 'object',
            path: '$',
            properties: {
              id: { type: 'string', path: '$.id' },
            },
          },
        },
      },
      extract: {
        record_path: '$.data.nodes',
      },
      lookup: {
        description: 'Lookup node',
        api: {
          endpoint: '/graphql',
          method: 'POST',
          headers: { 'X-Lookup': '1' },
          request_body: [{ query: '${{ input.repo }}' }],
        },
        input: {
          repo: { type: 'string', required: true },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects missing incremental and primary key field references', () => {
    const cursorResult = ResourceSpecSchema.safeParse({
      spec_version: '1',
      name: 'events',
      type: 'resource',
      integration: 'api',
      description: 'Events',
      api: {
        endpoint: '/events',
        method: 'GET',
      },
      input: {},
      output: {
        id: { type: 'integer', path: '$.id' },
      },
      extract: {
        record_path: '$',
        incremental: { cursor_field: 'updated_at', cursor_param: 'since' },
        table: {
          primary_key: ['id', 'external_id'],
        },
      },
    });

    expect(cursorResult.success).toBe(false);
  });

  it('validates record_filters references, scalar field types, and operators', () => {
    const baseResource = {
      spec_version: '1',
      name: 'repos',
      type: 'resource',
      integration: 'github',
      description: 'Repositories',
      api: {
        endpoint: '/orgs/${{ input.org }}/repos',
        method: 'GET',
      },
      input: {
        org: { type: 'string', default: 'bobsled-inc' },
        repo_names: { type: 'string' },
      },
      output: {
        id: { type: 'integer', path: '$.id' },
        name: { type: 'string', path: '$.name' },
        owner: {
          type: 'object',
          path: '$.owner',
          properties: { login: { type: 'string', path: '$.login' } },
        },
      },
      extract: {
        record_path: '$',
        record_filters: [{ field: 'name', input: 'repo_names', operator: 'in' }],
      },
    };

    expect(ResourceSpecSchema.safeParse(baseResource).success).toBe(true);

    const missingRefs = ResourceSpecSchema.safeParse({
      ...baseResource,
      extract: {
        record_path: '$',
        record_filters: [{ field: 'missing', input: 'missing_input', operator: 'in' }],
      },
    });
    expect(missingRefs.success).toBe(false);
    if (!missingRefs.success) {
      expect(missingRefs.error.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          'record_filters field "missing" must reference an output field',
          'record_filters input "missing_input" must reference a resource input',
        ])
      );
    }

    const nonScalarField = ResourceSpecSchema.safeParse({
      ...baseResource,
      extract: {
        record_path: '$',
        record_filters: [{ field: 'owner', input: 'repo_names', operator: 'in' }],
      },
    });
    expect(nonScalarField.success).toBe(false);
    if (!nonScalarField.success) {
      expect(nonScalarField.error.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          'record_filters field "owner" must reference a scalar output field ' +
            '(string, integer, number, boolean, timestamp) but got "object"',
        ])
      );
    }

    expect(
      ResourceSpecSchema.safeParse({
        ...baseResource,
        extract: {
          record_path: '$',
          record_filters: [{ field: 'name', input: 'repo_names', operator: 'equals' }],
        },
      }).success
    ).toBe(false);

    const overLimit = ResourceSpecSchema.safeParse({
      ...baseResource,
      extract: {
        record_path: '$',
        record_filters: Array.from({ length: 17 }, (_, index) => ({
          field: 'name',
          input: 'repo_names',
          operator: 'in' as const,
          delimiter: `${index}`,
        })),
      },
    });
    expect(overLimit.success).toBe(false);
  });

  it('rejects restricted resource and lookup headers', () => {
    const result = ResourceSpecSchema.safeParse({
      spec_version: '1',
      name: 'items',
      type: 'resource',
      integration: 'api',
      description: 'Items',
      api: {
        endpoint: '/items',
        method: 'GET',
        headers: { Authorization: 'blocked' },
      },
      input: {},
      output: {
        id: { type: 'integer', path: '$.id' },
      },
      extract: {
        record_path: '$',
      },
      lookup: {
        description: 'Lookup item',
        api: {
          endpoint: '/items/${{ input.id }}',
          method: 'GET',
          headers: { Host: 'blocked' },
        },
        input: {
          id: { type: 'string', required: true },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it('parses billable resource metadata and rejects non-plan-authorized billing', () => {
    const validResult = ResourceSpecSchema.safeParse({
      spec_version: '1',
      name: 'person_enrich',
      type: 'resource',
      integration: 'peopledatalabs',
      description: 'Billable enrichment',
      api: {
        endpoint: '/person/enrich',
        method: 'POST',
      },
      input: {
        profile: { type: 'string', required: true },
      },
      output: {
        id: { type: 'string', path: '$.id' },
      },
      extract: {
        record_path: '$',
      },
      billing: {
        mode: 'billable',
        ownership: 'third_party',
        unit: 'credit',
        estimation: {
          model: 'per_input_row',
          amount: 1,
          currency: 'provider_credit',
        },
        authorization: {
          requires_plan: true,
        },
      },
    });

    const invalidResult = ResourceSpecSchema.safeParse({
      spec_version: '1',
      name: 'person_enrich',
      type: 'resource',
      integration: 'peopledatalabs',
      description: 'Billable enrichment',
      api: {
        endpoint: '/person/enrich',
        method: 'POST',
      },
      input: {
        profile: { type: 'string', required: true },
      },
      output: {
        id: { type: 'string', path: '$.id' },
      },
      extract: {
        record_path: '$',
      },
      billing: {
        mode: 'billable',
        ownership: 'third_party',
        unit: 'credit',
        estimation: {
          model: 'per_input_row',
          amount: 1,
          currency: 'provider_credit',
        },
        authorization: {
          requires_plan: false,
        },
      },
    });

    expect(validResult.success).toBe(true);
    expect(invalidResult.success).toBe(false);
  });
});

describe('ExtractIntentsSchema', () => {
  it('parses a valid extract-intents manifest', () => {
    const result = ExtractIntentsSchema.safeParse({
      spec_version: '1',
      type: 'extract-intents',
      plans: {
        enrich_targets: {
          description: 'Enrich outbound targets',
          budget: {
            max_estimated_credits: 500,
            on_exceed: 'fail',
          },
          seeds: {
            candidates: {
              format: 'csv',
              path: './seeds/candidates.csv',
            },
          },
          steps: [
            {
              id: 'person_enrich',
              integration: 'peopledatalabs',
              resource: 'person_enrich',
              seed: 'candidates',
              input: {
                profile: '${{ seed.linkedin_url }}',
              },
              limits: {
                max_input_rows: 100,
              },
            },
          ],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects unknown seeds and malformed seed bindings', () => {
    const result = ExtractIntentsSchema.safeParse({
      spec_version: '1',
      type: 'extract-intents',
      plans: {
        enrich_targets: {
          description: 'Enrich outbound targets',
          budget: {
            max_estimated_credits: 500,
            on_exceed: 'fail',
          },
          seeds: {
            candidates: {
              format: 'csv',
              path: './seeds/candidates.csv',
            },
          },
          steps: [
            {
              id: 'person_enrich',
              integration: 'peopledatalabs',
              resource: 'person_enrich',
              seed: 'missing_seed',
              input: {
                profile: '${{ seed }}',
              },
              limits: {
                max_input_rows: 100,
              },
            },
          ],
        },
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('ExtractorConfigSchema', () => {
  it('parses a valid extractor config', () => {
    expect(
      ExtractorConfigSchema.safeParse({
        integrations_dir: 'integrations',
        resources_dir: 'resources',
        state_dir: '.extractor',
        output_dir: 'output',
        default_batch_format: 'parquet',
        default_output: 'stdout',
      }).success
    ).toBe(true);
  });

  it('defaults batch_dir to "batch"', () => {
    const result = ExtractorConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.batch_dir).toBe('batch');
      expect(result.data.default_batch_format).toBe('jsonl');
    }
  });
});

describe('ExtractorStateSchema', () => {
  it('parses a valid extractor state file', () => {
    expect(
      ExtractorStateSchema.safeParse({
        streams: {
          'github/issues': {
            cursor_field: 'updated_at',
            cursor_value: '2026-03-22T00:00:00Z',
            last_run_at: '2026-03-22T00:00:00Z',
            record_count: 10,
          },
        },
      }).success
    ).toBe(true);
  });
});
