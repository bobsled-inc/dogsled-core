import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@bobsled-inc/extractor', async () => {
  const actual =
    await vi.importActual<typeof import('@bobsled-inc/extractor')>('@bobsled-inc/extractor');
  return {
    ...actual,
    queryResource: vi.fn(),
  };
});

import { queryResource } from '@bobsled-inc/extractor';

import {
  clearCache,
  getResourcePath,
  listIntegrationDirs,
  listResourceFiles,
  readYamlFile,
} from '../src/loader.js';
import {
  FILTER_AND_SEARCH_QUERY_SOURCE_CAPABILITIES,
  getQuerySpec,
  listQueryResources,
  loadQueryableResourceSpecs,
  makeQuerySource,
  queryIntegrationResource,
  queryResources,
} from '../src/index.js';
import { typedWrapperBindings } from '../src/query-resources/typed-wrapper-bindings.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('query resources', () => {
  it('loads a paid spec only with explicit opt-in without changing the default catalog', () => {
    expect(loadQueryableResourceSpecs('exa', 'search')).toBeUndefined();
    expect(loadQueryableResourceSpecs('exa', 'search', { includeBillable: true })).toMatchObject({
      resource: { name: 'search', billing: { mode: 'billable' } },
    });
    expect(loadQueryableResourceSpecs('exa', 'search')).toBeUndefined();
    expect(getQuerySpec('exa', 'search')).toBeUndefined();
  });

  const mockedQueryResource = vi.mocked(queryResource);

  beforeAll(() => {
    clearCache();
  });

  beforeEach(() => {
    mockedQueryResource.mockReset();
    mockedQueryResource.mockResolvedValue({
      records: [],
      limitReached: false,
    });
  });

  it.each([
    {
      label: 'GitHub issues',
      run: () =>
        queryResources.github.issues.list({
          input: {
            owner: 'bobsled-inc',
            repo: 'bobsled',
          },
          filter: {
            state: 'open',
          },
          limit: 25,
        }),
      integration: 'github',
      resource: 'issues',
      input: {
        owner: 'bobsled-inc',
        repo: 'bobsled',
      },
      filter: {
        state: 'open',
      },
      search: undefined,
      limit: 25,
    },
    {
      label: 'GitHub branches',
      run: () =>
        queryResources.github.branches.list({
          input: {
            owner: 'bobsled-inc',
            repo: 'bobsled',
          },
          filter: {
            protected: true,
          },
          limit: 10,
        }),
      integration: 'github',
      resource: 'branches',
      input: {
        owner: 'bobsled-inc',
        repo: 'bobsled',
      },
      filter: {
        protected: true,
      },
      search: undefined,
      limit: 10,
    },
    {
      label: 'Calendly event types',
      run: () =>
        queryResources.calendly.getEventTypes.list({
          input: {
            organization: 'https://api.calendly.com/organizations/ORG',
          },
          filter: {
            active: true,
            admin_managed: false,
          },
          limit: 15,
        }),
      integration: 'calendly',
      resource: 'get_event_types',
      input: {
        organization: 'https://api.calendly.com/organizations/ORG',
      },
      filter: {
        active: true,
        admin_managed: false,
      },
      search: undefined,
      limit: 15,
    },
    {
      label: 'Stripe products',
      run: () =>
        queryResources.stripe.products.list({
          filter: {
            active: true,
            created: { gte: 1_711_929_600 },
          },
          limit: 5,
        }),
      integration: 'stripe',
      resource: 'products',
      input: undefined,
      filter: {
        active: true,
        created: { gte: 1_711_929_600 },
      },
      search: undefined,
      limit: 5,
    },
    {
      label: 'Stripe invoices',
      run: () =>
        queryResources.stripe.invoices.list({
          filter: {
            status: 'paid',
            customer: { eq: 'cus_123' },
          },
          limit: 12,
        }),
      integration: 'stripe',
      resource: 'invoices',
      input: undefined,
      filter: {
        status: 'paid',
        customer: { eq: 'cus_123' },
      },
      search: undefined,
      limit: 12,
    },
    {
      label: 'GitHub pull requests',
      run: () =>
        queryResources.github.pullRequests.list({
          input: {
            owner: 'bobsled-inc',
            repo: 'bobsled',
          },
          filter: {
            state: 'all',
          },
          limit: 30,
        }),
      integration: 'github',
      resource: 'pull_requests',
      input: {
        owner: 'bobsled-inc',
        repo: 'bobsled',
      },
      filter: {
        state: 'all',
      },
      search: undefined,
      limit: 30,
    },
    {
      label: 'Twilio usage records',
      run: () =>
        queryResources.twilio.listUsageRecords.list({
          input: {
            account_sid: 'AC123',
          },
          filter: {
            category: 'sms',
            start_date: { gte: '2026-04-01' },
            end_date: { lte: '2026-04-30' },
          },
          limit: 50,
        }),
      integration: 'twilio',
      resource: 'list_usage_records',
      input: {
        account_sid: 'AC123',
      },
      filter: {
        category: 'sms',
        start_date: { gte: '2026-04-01' },
        end_date: { lte: '2026-04-30' },
      },
      search: undefined,
      limit: 50,
    },
    {
      label: 'Jira search issues',
      run: () =>
        queryResources.jira.searchIssues.list({
          search: 'project = FOO',
          limit: 10,
        }),
      integration: 'jira',
      resource: 'search_issues',
      input: undefined,
      filter: undefined,
      search: 'project = FOO',
      limit: 10,
    },
  ])('wires $label through the shared runtime', async (scenario) => {
    await scenario.run();

    expect(mockedQueryResource).toHaveBeenCalledTimes(1);
    const call = mockedQueryResource.mock.calls[0]?.[0];
    expect((call?.integration as { name?: string }).name).toBe(scenario.integration);
    expect((call?.resource as { name?: string }).name).toBe(scenario.resource);
    expect(call?.input).toEqual(scenario.input);
    expect(call?.filter).toEqual(scenario.filter);
    expect(call?.search).toBe(scenario.search);
    expect(call?.limit).toBe(scenario.limit);
  });

  it('rejects filter and search keys together before querying', async () => {
    const source = makeQuerySource<{ id: string }, never, { active?: boolean }>(
      'example',
      'searchable_records',
      FILTER_AND_SEARCH_QUERY_SOURCE_CAPABILITIES
    );
    const invalidOptions = {
      filter: { active: true },
      search: undefined,
    } as unknown as Parameters<typeof source.list>[0];

    await expect(source.list(invalidOptions)).rejects.toThrow(
      'Provide either `filter` or `search`, not both.'
    );
    expect(mockedQueryResource).not.toHaveBeenCalled();
  });

  it('executes discovery-only query resources through the generic helper', async () => {
    await queryIntegrationResource('stripe', 'payment_methods', {
      filter: {
        customer: 'cus_123',
        type: 'card',
      },
      limit: 20,
    });

    expect(mockedQueryResource).toHaveBeenCalledTimes(1);
    const call = mockedQueryResource.mock.calls[0]?.[0];
    expect((call?.integration as { name?: string }).name).toBe('stripe');
    expect((call?.resource as { name?: string }).name).toBe('payment_methods');
    expect(call?.filter).toEqual({
      customer: 'cus_123',
      type: 'card',
    });
    expect(call?.limit).toBe(20);
  });

  it('keeps query filter bind inputs wired to resource inputs', () => {
    const failures: string[] = [];

    for (const integrationName of listIntegrationDirs()) {
      for (const resourceName of listResourceFiles(integrationName)) {
        const resource = readYamlFile(getResourcePath(integrationName, resourceName));
        if (!isRecord(resource) || !isRecord(resource['query'])) continue;

        const inputNames = new Set(
          isRecord(resource['input']) ? Object.keys(resource['input']) : []
        );
        const filters = isRecord(resource['query']['filters']) ? resource['query']['filters'] : {};

        for (const [fieldName, filter] of Object.entries(filters)) {
          if (!isRecord(filter) || !isRecord(filter['bind'])) continue;
          for (const [operator, binding] of Object.entries(filter['bind'])) {
            if (!isRecord(binding)) {
              failures.push(
                `${integrationName}.${resourceName}: query.filters.${fieldName}.bind.${operator} must be an object`
              );
              continue;
            }

            const inputName = binding['input'];
            if (typeof inputName !== 'string') {
              failures.push(
                `${integrationName}.${resourceName}: query.filters.${fieldName}.bind.${operator}.input must be a string`
              );
              continue;
            }

            if (!inputNames.has(inputName)) {
              failures.push(
                `${integrationName}.${resourceName}: query.filters.${fieldName}.bind.${operator}.input references missing input "${inputName}"`
              );
            }
          }
        }
      }
    }

    expect(failures).toEqual([]);
  }, 30_000);

  it('defines Exa web search as an explicitly billable search query', () => {
    const resource = readYamlFile(getResourcePath('exa', 'search'));

    expect(resource).toMatchObject({
      api: {
        endpoint: '/search',
        method: 'POST',
        request_body: {
          query: '${{ input.query }}',
          numResults: '${{ input.num_results }}',
        },
      },
      query: {
        search: {
          dialect: 'exa_search',
          bind: { input: 'query' },
        },
      },
      billing: {
        mode: 'billable',
        authorization: { requires_plan: true },
      },
    });
  });

  it('executes MCP-backed query resources through the generic helper', async () => {
    await queryIntegrationResource('bigquery', 'query_results', {
      search: 'select 1',
      limit: 5,
    });

    expect(mockedQueryResource).toHaveBeenCalledTimes(1);
    const call = mockedQueryResource.mock.calls[0]?.[0];
    expect((call?.integration as { transport?: { type?: string } }).transport?.type).toBe(
      'mcp_stdio'
    );
    expect((call?.resource as { name?: string }).name).toBe('query_results');
    expect(call?.search).toBe('select 1');
    expect(call?.limit).toBe(5);
  });

  it('lists the broader YAML-backed query catalog and only marks wrapper-backed resources', () => {
    const querySpecs = listQueryResources();
    const specsByKey = new Map(
      querySpecs.map((spec) => [`${spec.integration}.${spec.resource}`, spec] as const)
    );

    expect(querySpecs).toHaveLength(116);
    expect([...specsByKey.keys()].sort()).toEqual(
      expect.arrayContaining([
        'asana.get_projects',
        'bamboohr.list_time_off_requests',
        'bigquery.query_results',
        'confluence.get_audit_records',
        'calendly.get_event_types',
        'github.branches',
        'github.issues',
        'github.pull_requests',
        'jira.search_issues',
        'notion.pages_rest',
        'servicenow.incidents',
        'sentry.list_your_organizations',
        'snowflake.query_results',
        'stripe.customers',
        'stripe.invoices',
        'stripe.prices',
        'stripe.products',
        'stripe.subscriptions',
        'twilio.list_usage_records',
      ])
    );

    expect(specsByKey.get('github.branches')).toMatchObject({
      integration: 'github',
      resource: 'branches',
      filterSyntax: 'mongodb-compatible',
      typedWrapper: 'queryResources.github.branches',
      supports: {
        filters: true,
        search: false,
      },
      filters: [
        expect.objectContaining({
          field: 'protected',
          type: 'boolean',
          operators: ['eq'],
        }),
      ],
    });

    expect(specsByKey.get('stripe.products')).toMatchObject({
      integration: 'stripe',
      resource: 'products',
      typedWrapper: 'queryResources.stripe.products',
      filters: [
        expect.objectContaining({
          field: 'active',
          type: 'boolean',
          operators: ['eq'],
        }),
        expect.objectContaining({
          field: 'created',
          type: 'integer',
          operators: ['gte'],
        }),
      ],
      contextInputs: [
        expect.objectContaining({
          name: 'limit',
          required: false,
        }),
      ],
    });

    expect(specsByKey.get('stripe.prices')).toMatchObject({
      integration: 'stripe',
      resource: 'prices',
      typedWrapper: 'queryResources.stripe.prices',
      filters: [
        expect.objectContaining({
          field: 'active',
          type: 'boolean',
        }),
        expect.objectContaining({
          field: 'created',
          type: 'integer',
        }),
        expect.objectContaining({
          field: 'product',
          type: 'string',
        }),
        expect.objectContaining({
          field: 'type',
          type: 'string',
        }),
      ],
      contextInputs: [
        expect.objectContaining({
          name: 'limit',
        }),
      ],
    });

    expect(specsByKey.get('bamboohr.list_time_off_requests')).toMatchObject({
      integration: 'bamboohr',
      resource: 'list_time_off_requests',
      contextInputs: expect.arrayContaining([
        expect.objectContaining({
          name: 'start',
          required: true,
        }),
        expect.objectContaining({
          name: 'end',
          required: true,
        }),
      ]),
    });

    expect(specsByKey.get('jira.search_issues')).toMatchObject({
      integration: 'jira',
      resource: 'search_issues',
      typedWrapper: 'queryResources.jira.searchIssues',
      supports: {
        filters: false,
        search: true,
      },
      search: {
        dialect: 'jira_jql',
      },
    });

    expect(specsByKey.get('servicenow.incidents')).toMatchObject({
      integration: 'servicenow',
      resource: 'incidents',
      supports: {
        filters: false,
        search: true,
      },
      search: {
        dialect: 'servicenow_sysparm_query',
      },
    });

    expect(specsByKey.get('bigquery.query_results')).toMatchObject({
      integration: 'bigquery',
      resource: 'query_results',
      filterSyntax: 'mcp',
      supports: {
        filters: false,
        search: true,
      },
      search: {
        dialect: 'sql',
      },
    });

    expect(
      querySpecs
        .filter((spec) => spec.typedWrapper)
        .map((spec) => `${spec.integration}.${spec.resource}`)
        .sort()
    ).toEqual([
      'calendly.get_event_types',
      'github.branches',
      'github.issues',
      'github.pull_requests',
      'jira.search_issues',
      'stripe.customers',
      'stripe.invoices',
      'stripe.prices',
      'stripe.products',
      'stripe.subscriptions',
      'twilio.list_usage_records',
    ]);
  }, 30_000);

  it('returns a parsed query spec summary for a single wrapper-backed resource', () => {
    const spec = getQuerySpec('github', 'issues');

    expect(spec).toMatchObject({
      integration: 'github',
      resource: 'issues',
      filterSyntax: 'mongodb-compatible',
      typedWrapper: 'queryResources.github.issues',
      supports: {
        filters: true,
        search: false,
      },
    });

    expect(new Set(spec?.contextInputs.map((input) => input.name))).toEqual(
      new Set(['owner', 'repo', 'repository_full_name', 'sort', 'direction', 'per_page'])
    );
  });

  it('returns defensive copies from the cached query resource catalog', () => {
    const listedSpec = listQueryResources().find(
      (spec) => spec.integration === 'github' && spec.resource === 'issues'
    );
    expect(listedSpec).toBeDefined();
    if (!listedSpec) {
      throw new Error('expected github/issues query resource');
    }

    listedSpec.supports.filters = false;
    listedSpec.filters[0]?.operators.push('ne');
    if (listedSpec.contextInputs[0]) {
      listedSpec.contextInputs[0].name = 'mutated';
    }

    const freshSpec = getQuerySpec('github', 'issues');
    expect(freshSpec).toBeDefined();
    expect(freshSpec?.supports.filters).toBe(true);
    expect(freshSpec?.filters[0]?.operators).not.toContain('ne');
    expect(freshSpec?.contextInputs[0]?.name).not.toBe('mutated');
  });

  it('keeps discovery-only filter enums aligned with query output semantics', () => {
    const customerIoActivitiesTypeFilter = getQuerySpec('customer_io', 'activities')?.filters.find(
      (filter) => filter.field === 'type'
    );
    expect(customerIoActivitiesTypeFilter).toMatchObject({
      field: 'type',
      operators: ['eq'],
    });
    expect(customerIoActivitiesTypeFilter?.enum).toBeUndefined();

    const githubWorkflowRunsStatusFilter = getQuerySpec('github', 'workflow_runs')?.filters.find(
      (filter) => filter.field === 'status'
    );
    expect(githubWorkflowRunsStatusFilter?.enum).toEqual([
      'completed',
      'in_progress',
      'queued',
      'requested',
      'waiting',
      'pending',
    ]);
  });

  it('surfaces query filter types and required context inputs for typed resources', () => {
    const spec = getQuerySpec('twilio', 'list_usage_records');

    expect(spec).toMatchObject({
      integration: 'twilio',
      resource: 'list_usage_records',
      typedWrapper: 'queryResources.twilio.listUsageRecords',
      filters: [
        expect.objectContaining({
          field: 'category',
          type: 'string',
          operators: ['eq'],
        }),
        expect.objectContaining({
          field: 'start_date',
          type: 'timestamp',
          operators: ['gte'],
        }),
        expect.objectContaining({
          field: 'end_date',
          type: 'timestamp',
          operators: ['lte'],
        }),
      ],
    });

    expect(new Set(spec?.contextInputs.map((input) => input.name))).toEqual(
      new Set(['account_sid', 'page_size', 'page', 'include_subaccounts'])
    );
    expect(spec?.contextInputs.find((input) => input.name === 'account_sid')).toMatchObject({
      required: true,
    });
  });

  it('throws when queryIntegrationResource is called on a non-queryable resource', async () => {
    await expect(queryIntegrationResource('stripe', 'invoice_items')).rejects.toThrow(
      /does not expose a query surface/
    );
    expect(mockedQueryResource).not.toHaveBeenCalled();
  });

  it('throws when queryIntegrationResource is called on a missing resource', async () => {
    await expect(queryIntegrationResource('stripe', 'not_a_real_resource')).rejects.toThrow(
      /not found for source/
    );
    expect(mockedQueryResource).not.toHaveBeenCalled();
  });

  it('keeps typedWrapperBindings in sync with the exported queryResources registry', () => {
    const bindingsByResource = new Map(
      typedWrapperBindings.map(
        (binding) => [`${binding.integration}.${binding.resource}`, binding.clientSurface] as const
      )
    );

    let registrySurfaceCount = 0;
    for (const [namespace, methods] of Object.entries(queryResources)) {
      for (const [methodName, source] of Object.entries(methods)) {
        registrySurfaceCount += 1;
        const entry = source as { integration: string; resource: string };
        const expectedSurface = `queryResources.${namespace}.${methodName}`;
        const actualSurface = bindingsByResource.get(`${entry.integration}.${entry.resource}`);
        expect(
          actualSurface,
          `typedWrapperBindings missing entry for ${entry.integration}.${entry.resource}`
        ).toBe(expectedSurface);
      }
    }

    expect(registrySurfaceCount).toBe(typedWrapperBindings.length);
  });
});

it('preserves bundled metadata declarations when adapting query resources', () => {
  const loaded = loadQueryableResourceSpecs('exa', 'search', { includeBillable: true });
  expect(loaded?.integration.auth_env_vars).toContain('EXA_API_KEY');
});
