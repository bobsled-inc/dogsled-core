import { describe, expect, it } from 'vitest';

import {
  SourceSchema,
  findTransport,
  getSqlDialect,
  isSqlTransport,
  listTransportTypes,
  resolveVia,
} from '../../../src/framework/core/index.js';
import { ResourceSpecSchema } from '../../../src/framework/extractor/index.js';

const postgresTransport = {
  id: 'warehouse',
  type: 'sql_postgres',
  connection: {
    host_env: 'PGHOST',
    port: 5432,
    database: 'analytics',
    schema: 'public',
  },
  auth: {
    type: 'password',
    username_env: 'PGUSER',
    password_env: 'PGPASSWORD',
  },
} as const;

const sourceSpec = {
  spec_version: '2',
  type: 'source',
  name: 'product_data',
  default_transport: 'api',
  transports: [
    {
      id: 'api',
      type: 'http',
      base_url: 'https://api.example.com',
    },
    {
      id: 'mcp',
      type: 'mcp_stdio',
      command: 'node',
      args: ['server.mjs'],
      policy: {
        timeout_ms: 5000,
        retry: {
          max_retries: 2,
          backoff: 'exponential',
        },
      },
    },
    postgresTransport,
  ],
} as const;

const baseResource = {
  type: 'resource',
  name: 'issues',
  via: 'api',
  entity: 'issue',
  description: 'Issue resource',
  api: {
    endpoint: '/issues',
    method: 'GET',
  },
  input: {
    updated_since: { type: 'string' },
    state: { type: 'string' },
    search: { type: 'string' },
  },
  output: {
    id: { type: 'integer', path: '$.id' },
    state: { type: 'string', path: '$.state' },
    updated_at: { type: 'timestamp', path: '$.updated_at' },
  },
  extract: {
    record_path: '$',
  },
} as const;

describe('SourceSchema', () => {
  it('requires source spec_version 2', () => {
    const result = SourceSchema.safeParse({
      ...sourceSpec,
      spec_version: '1',
    });

    expect(result.success).toBe(false);
  });

  it('parses spec v2 HTTP, MCP, and flat SQL transport type literals', () => {
    const result = SourceSchema.safeParse(sourceSpec);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(listTransportTypes(result.data)).toEqual(['http', 'mcp_stdio', 'sql_postgres']);
    const transport = findTransport(result.data, 'warehouse');
    expect(transport).toBeDefined();
    expect(transport && isSqlTransport(transport)).toBe(true);
    expect(transport && getSqlDialect(transport)).toBe('postgres');
  });

  it('rejects duplicate transport ids', () => {
    const result = SourceSchema.safeParse({
      ...sourceSpec,
      transports: [
        sourceSpec.transports[0],
        {
          ...sourceSpec.transports[1],
          id: 'api',
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('must be unique');
  });
});

describe('resolveVia', () => {
  it('resolves explicit, default, and single-transport routes', () => {
    const result = SourceSchema.parse(sourceSpec);

    expect(resolveVia(result, 'warehouse').id).toBe('warehouse');
    expect(resolveVia(result).id).toBe('api');

    const single = SourceSchema.parse({
      spec_version: '2',
      type: 'source',
      name: 'warehouse_only',
      transports: [postgresTransport],
    });
    expect(resolveVia(single).id).toBe('warehouse');
  });

  it('fails when a route cannot be resolved', () => {
    const result = SourceSchema.parse(sourceSpec);
    expect(() => resolveVia(result, 'missing')).toThrow('not found');

    const ambiguous = SourceSchema.parse({
      spec_version: '2',
      type: 'source',
      name: 'ambiguous',
      transports: [sourceSpec.transports[0], postgresTransport],
    });
    expect(() => resolveVia(ambiguous)).toThrow('requires via');
  });
});

describe('ResourceSpecSchema first-class resource fields', () => {
  it('parses via/entity without legacy integration or spec_version', () => {
    const result = ResourceSpecSchema.safeParse(baseResource);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      via: 'api',
      entity: 'issue',
    });
  });

  it('rejects legacy integration and spec_version once via is used', () => {
    const result = ResourceSpecSchema.safeParse({
      ...baseResource,
      spec_version: '1',
      integration: 'github',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual(
      expect.arrayContaining(['integration', 'spec_version'])
    );
  });

  it('parses top-level full_refresh and server_filter incremental configs', () => {
    const fullRefresh = ResourceSpecSchema.safeParse({
      ...baseResource,
      incremental: {
        strategy: 'full_refresh',
      },
    });

    const serverFilter = ResourceSpecSchema.safeParse({
      ...baseResource,
      incremental: {
        strategy: 'server_filter',
        cursor_field: 'updated_at',
        since_argument: 'updated_since',
        until_argument: 'updated_until',
        cursor_type: 'timestamp',
        value_format: 'iso8601',
        lookback_seconds: 60,
        initial_lookback_seconds: 3600,
        window_size_seconds: 86400,
      },
    });

    expect(fullRefresh.success).toBe(true);
    expect(serverFilter.success).toBe(true);
  });

  it('rejects server_filter incremental configs without a since or filter argument', () => {
    const result = ResourceSpecSchema.safeParse({
      ...baseResource,
      incremental: {
        strategy: 'server_filter',
        cursor_field: 'updated_at',
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('since_argument or filter_argument');
  });

  it.each([
    [{ mode: 'http_query', param: 'state' }],
    [{ mode: 'direct_arg', argument: 'state' }],
    [{ mode: 'filter_dsl', expression: 'state = {{ value }}' }],
  ] as const)('parses query filter compile variant %o', (compile) => {
    const result = ResourceSpecSchema.safeParse({
      ...baseResource,
      query: {
        filters: {
          state: {
            compile,
            operators: ['eq'],
            bind: {
              eq: { input: 'state' },
            },
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects query filter compile modes outside the v2 plan', () => {
    const result = ResourceSpecSchema.safeParse({
      ...baseResource,
      query: {
        filters: {
          state: {
            compile: { mode: 'server_filter' },
            operators: ['eq'],
            bind: {
              eq: { input: 'state' },
            },
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it('allows query metadata on MCP tool resources for later cross-source validation', () => {
    const result = ResourceSpecSchema.safeParse({
      type: 'resource',
      name: 'mcp_issues',
      via: 'mcp',
      description: 'MCP issues',
      tool: {
        tool_name: 'list_issues',
      },
      input: {
        state: { type: 'string' },
      },
      output: {
        id: { type: 'string', path: '$.id' },
        state: { type: 'string', path: '$.state' },
      },
      extract: {
        record_path: '$.issues',
      },
      query: {
        filters: {
          state: {
            compile: { mode: 'direct_arg', argument: 'state' },
            operators: ['eq'],
            bind: {
              eq: { input: 'state' },
            },
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });
});

describe('SourceSchema — orchestrator extension keys', () => {
  it('accepts top-level keys with the `dogsled_` prefix and strips them', () => {
    const result = SourceSchema.safeParse({
      ...sourceSpec,
      dogsled_connection_ref: 'product_data',
      dogsled_internal_id: 42,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Extension keys are stripped before strict validation runs and
      // do not appear on the parsed object — Dogsled itself never reads
      // them, so they're invisible from the consumer's perspective.
      expect(result.data).not.toHaveProperty('dogsled_connection_ref');
      expect(result.data).not.toHaveProperty('dogsled_internal_id');
    }
  });

  it('accepts top-level keys with the OpenAPI-style `x-` prefix', () => {
    const result = SourceSchema.safeParse({
      ...sourceSpec,
      'x-orchestrator': 'langsmith',
      'x-version': '1.2.3',
    });
    expect(result.success).toBe(true);
  });

  it('still rejects unknown keys without the extension prefix', () => {
    const result = SourceSchema.safeParse({
      ...sourceSpec,
      mystery_field: 'oops',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /Unrecognized key/.test(i.message))).toBe(true);
    }
  });
});

describe('SourceSchema — concrete SQL connections', () => {
  it.each([
    'sql_snowflake',
    'sql_bigquery',
    'sql_postgres',
    'sql_redshift',
    'sql_mysql',
    'sql_clickhouse',
    'sql_iceberg',
    'sql_delta',
  ])('rejects unresolved connection strings for %s', (type) => {
    for (const connection of [
      '${{ bobsled.connection.warehouse-prod }}',
      '${{ dogsled.connection.warehouse-prod }}',
    ]) {
      expect(
        SourceSchema.safeParse({
          spec_version: '2',
          type: 'source',
          name: 'warehouse',
          transports: [{ id: 'sql', type, connection }],
        }).success
      ).toBe(false);
    }
  });

  it('accepts the bobsled_connection_ref spelling of the connection key', () => {
    expect(
      SourceSchema.safeParse({ ...sourceSpec, bobsled_connection_ref: 'warehouse-prod' }).success
    ).toBe(true);
  });
});

describe('SourceSchema — metadata-only sources (no transports)', () => {
  // Orchestrator-managed bundles that exist purely as Model Spec source
  // metadata don't need transports — Dogsled CLI never invokes them.
  it('accepts a source with an empty transports array', () => {
    const result = SourceSchema.safeParse({
      spec_version: '2',
      type: 'source',
      name: 'warehouse',
      transports: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.transports).toEqual([]);
    }
  });

  it('accepts a source with no transports field at all (defaults to [])', () => {
    const result = SourceSchema.safeParse({
      spec_version: '2',
      type: 'source',
      name: 'warehouse',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.transports).toEqual([]);
    }
  });

  it('still rejects sources with malformed transports (non-array)', () => {
    const result = SourceSchema.safeParse({
      spec_version: '2',
      type: 'source',
      name: 'warehouse',
      transports: 'not an array',
    });
    expect(result.success).toBe(false);
  });
});
