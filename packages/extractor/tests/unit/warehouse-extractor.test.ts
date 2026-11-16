/**
 * Tests for the warehouse extraction orchestrator.
 *
 * Uses vi.mock to replace createWarehouseClient with a mock factory,
 * allowing tests to verify protocol message emission (SCHEMA, RECORD, STATE)
 * without requiring real database connections.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  isWarehouseSource,
  isWarehouseResource,
  extractWarehouseResource,
  getIntegrationDefault,
} from '../../src/runtime/warehouse-extractor.js';
import { Emitter } from '../../src/runtime/emitter.js';
import { ControlLogger } from '../../src/runtime/control.js';
import { createWarehouseClient } from '../../src/runtime/warehouse-client.js';
import { BigQueryWarehouseClient } from '../../src/runtime/bigquery-client.js';
import { FakeWritable } from '../helpers/fixtures.js';

import type { Writable } from 'node:stream';
import type { WarehouseClient } from '../../src/runtime/warehouse-client.js';
import type { IntegrationSpec, ResourceSpec, ExtractorState } from '../../src/types/index.js';
import type { WarehouseResourceSpec } from '../../src/framework/extractor/index.js';
import type { StateStore } from '../../src/runtime/state.js';

// ── Mock createWarehouseClient ──

let mockClient: WarehouseClient;

vi.mock('../../src/runtime/warehouse-client.js', () => ({
  createWarehouseClient: vi.fn().mockImplementation(() => Promise.resolve(mockClient)),
}));

// Set dummy env vars so resolveConnectionConfig passes without real credentials
beforeEach(() => {
  process.env['SNOWFLAKE_ACCOUNT'] = 'test-account';
  process.env['SNOWFLAKE_WAREHOUSE'] = 'test-warehouse';
  process.env['SNOWFLAKE_TOKEN'] = 'test-token';
  process.env['PG_HOST'] = 'localhost';
  process.env['PG_USER'] = 'test-user';
  process.env['PG_PASSWORD'] = 'test-password';
  process.env['MYSQL_HOST'] = 'localhost';
  process.env['MYSQL_USER'] = 'test-user';
  process.env['MYSQL_PASSWORD'] = 'test-password';
  process.env['CLICKHOUSE_HOST'] = 'localhost';
  process.env['CLICKHOUSE_USER'] = 'test-user';
  process.env['CLICKHOUSE_PASSWORD'] = 'test-password';
});

interface ExecutedQuery {
  sql: string;
  params?: unknown[];
}

function createMockClient(
  batches: Record<string, unknown>[][] = [],
  dialect: WarehouseClient['dialect'] = 'snowflake',
  queries?: ExecutedQuery[]
): WarehouseClient {
  return {
    dialect,
    async *execute(sql: string, params?: unknown[]): AsyncGenerator<Record<string, unknown>[]> {
      queries?.push({ sql, params });
      for (const batch of batches) {
        yield batch;
      }
    },
    testConnection: vi.fn().mockResolvedValue({ success: true }),
    introspect: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Mock StateStore ──

function createMockStateStore(initialState: ExtractorState = { streams: {} }): StateStore {
  let state = initialState;
  return {
    load: vi.fn().mockImplementation(() => Promise.resolve(state)),
    save: vi.fn().mockImplementation((newState: ExtractorState) => {
      state = newState;
      return Promise.resolve();
    }),
  };
}

// ── Test fixtures ──

function snowflakeIntegration(): IntegrationSpec {
  return {
    auth_env_vars: [
      'SNOWFLAKE_ACCOUNT',
      'SNOWFLAKE_TOKEN',
      'SNOWFLAKE_WAREHOUSE',
      'BOBSLED_CORE_TEST_LARGE_WAREHOUSE',
    ],
    spec_version: '1',
    type: 'integration',
    name: 'test_snowflake',
    source_type: 'snowflake',
    connection: {
      account_identifier_env: 'SNOWFLAKE_ACCOUNT',
      warehouse_env: 'SNOWFLAKE_WAREHOUSE',
      database: 'TEST_DB',
      schema: 'PUBLIC',
      role: 'TEST_ROLE',
    },
    auth: {
      type: 'pat',
      token_env: 'SNOWFLAKE_TOKEN',
    },
  } as IntegrationSpec;
}

function clickhouseIntegration(): IntegrationSpec {
  return {
    auth_env_vars: ['CLICKHOUSE_HOST', 'CLICKHOUSE_PASSWORD', 'CLICKHOUSE_USER'],
    spec_version: '1',
    type: 'integration',
    name: 'test_clickhouse',
    source_type: 'clickhouse',
    connection: {
      host_env: 'CLICKHOUSE_HOST',
      port: 8123,
      database: 'analytics',
    },
    auth: {
      type: 'password',
      username_env: 'CLICKHOUSE_USER',
      password_env: 'CLICKHOUSE_PASSWORD',
    },
    ssl: { mode: 'require' },
  } as IntegrationSpec;
}

function clickhouseV2Integration(): IntegrationSpec {
  return {
    auth_env_vars: ['CLICKHOUSE_HOST', 'CLICKHOUSE_PASSWORD', 'CLICKHOUSE_USER'],
    spec_version: '2',
    type: 'source',
    name: 'test_clickhouse_v2',
    transports: [
      {
        id: 'warehouse',
        type: 'sql_clickhouse',
        connection: {
          host_env: 'CLICKHOUSE_HOST',
          database: 'analytics',
        },
        auth: {
          type: 'password',
          username_env: 'CLICKHOUSE_USER',
          password_env: 'CLICKHOUSE_PASSWORD',
        },
        ssl: { mode: 'require' },
      },
    ],
  } as unknown as IntegrationSpec;
}

function clickhouseResource(
  replication: WarehouseResourceSpec['replication'] = {
    method: 'incremental_append',
    cursor_field: 'updated_at',
    cursor_type: 'timestamp',
  }
): WarehouseResourceSpec {
  const loadStrategy = replication.method === 'full_refresh' ? 'full_refresh' : 'append';
  return {
    ...ordersResource(),
    name: 'events',
    integration: 'test_clickhouse',
    source: {
      table: 'events',
      database: 'analytics',
    },
    replication,
    extract: {
      table: {
        primary_key: ['order_id'],
        load_strategy: loadStrategy,
        trust_tier: 'bronze',
      },
    },
  };
}

function ordersResource(): WarehouseResourceSpec {
  return {
    spec_version: '1',
    type: 'resource',
    name: 'orders',
    integration: 'test_snowflake',
    source: {
      table: 'ORDERS',
      database: 'ANALYTICS',
      schema: 'PUBLIC',
    },
    replication: {
      method: 'incremental_merge',
      cursor_field: 'updated_at',
      cursor_type: 'timestamp',
      primary_key: ['order_id'],
    },
    output: {
      order_id: { type: 'integer' },
      customer_id: { type: 'integer' },
      amount: { type: 'number' },
      updated_at: { type: 'timestamp' },
    },
    extract: {
      table: {
        primary_key: ['order_id'],
        load_strategy: 'merge',
        trust_tier: 'bronze',
      },
    },
  };
}

function fullRefreshResource(): WarehouseResourceSpec {
  return {
    spec_version: '1',
    type: 'resource',
    name: 'products',
    integration: 'test_mysql',
    source: {
      table: 'products',
      database: 'inventory',
    },
    replication: {
      method: 'full_refresh',
    },
    output: {
      id: { type: 'integer' },
      sku: { type: 'string' },
      name: { type: 'string' },
      price: { type: 'number' },
    },
    extract: {
      table: {
        primary_key: ['id'],
        load_strategy: 'full_refresh',
        trust_tier: 'bronze',
      },
    },
  };
}

function cdcResource(): WarehouseResourceSpec {
  return {
    spec_version: '1',
    type: 'resource',
    name: 'orders_cdc',
    integration: 'test_snowflake',
    source: {
      table: 'ORDERS',
      database: 'ANALYTICS',
      schema: 'PUBLIC',
    },
    replication: {
      method: 'change_tracking',
      change_tracking: { information: 'default' },
      primary_key: ['order_id'],
    },
    output: {
      order_id: { type: 'integer' },
      updated_at: { type: 'timestamp' },
      _change_type: { type: 'string' },
      _is_update: { type: 'boolean' },
    },
    extract: {
      table: {
        primary_key: ['order_id'],
        load_strategy: 'merge',
        trust_tier: 'bronze',
      },
    },
  };
}

// ── isWarehouseSource ──

describe('isWarehouseSource', () => {
  it('returns true for snowflake integration', () => {
    expect(isWarehouseSource(snowflakeIntegration())).toBe(true);
  });

  it('returns true for bigquery integration', () => {
    const integration = {
      spec_version: '1',
      type: 'integration',
      name: 'test_bigquery',
      source_type: 'bigquery',
      connection: {
        project_ids: ['test-project'],
        billing_project_id: 'test-billing',
        default_location: 'US',
      },
      auth: { type: 'adc' },
    } as IntegrationSpec;
    expect(isWarehouseSource(integration)).toBe(true);
  });

  it('returns true for postgres integration', () => {
    const integration = {
      auth_env_vars: ['PG_HOST', 'PG_PASSWORD', 'PG_USER'],
      spec_version: '1',
      type: 'integration',
      name: 'test_postgres',
      source_type: 'postgres',
      connection: {
        host_env: 'PG_HOST',
        port: 5432,
        database: 'test_db',
        schema: 'public',
      },
      auth: { type: 'password', username_env: 'PG_USER', password_env: 'PG_PASSWORD' },
    } as IntegrationSpec;
    expect(isWarehouseSource(integration)).toBe(true);
  });

  it('returns true for mysql integration', () => {
    const integration = {
      auth_env_vars: ['MYSQL_HOST', 'MYSQL_PASSWORD', 'MYSQL_USER'],
      spec_version: '1',
      type: 'integration',
      name: 'test_mysql',
      source_type: 'mysql',
      connection: {
        host_env: 'MYSQL_HOST',
        port: 3306,
        database: 'test_db',
      },
      auth: { type: 'password', username_env: 'MYSQL_USER', password_env: 'MYSQL_PASSWORD' },
    } as IntegrationSpec;
    expect(isWarehouseSource(integration)).toBe(true);
  });

  it('returns true for clickhouse integration', () => {
    const integration = clickhouseIntegration();

    expect(isWarehouseSource(integration)).toBe(true);
    expect(getIntegrationDefault(integration, 'database')).toBe('analytics');
  });

  it('returns true for V2 source with sql_postgres transport', () => {
    const integration = {
      auth_env_vars: ['PG_HOST', 'PG_PASSWORD', 'PG_USER'],
      spec_version: '2',
      type: 'source',
      name: 'test_pg_v2',
      transports: [
        {
          id: 'warehouse',
          type: 'sql_postgres',
          connection: {
            host_env: 'PG_HOST',
            port: 5432,
            database: 'test_db',
            schema: 'public',
          },
          auth: { type: 'password', username_env: 'PG_USER', password_env: 'PG_PASSWORD' },
        },
      ],
    } as unknown as IntegrationSpec;
    expect(isWarehouseSource(integration)).toBe(true);
    expect(getIntegrationDefault(integration, 'schema')).toBe('public');
  });

  it('returns true for V2 source with sql_snowflake transport', () => {
    const integration = {
      auth_env_vars: [
        'SNOWFLAKE_ACCOUNT',
        'SNOWFLAKE_TOKEN',
        'SNOWFLAKE_WAREHOUSE',
        'BOBSLED_CORE_TEST_LARGE_WAREHOUSE',
      ],
      spec_version: '2',
      type: 'source',
      name: 'test_sf_v2',
      transports: [
        {
          id: 'warehouse',
          type: 'sql_snowflake',
          connection: {
            account_identifier_env: 'SNOWFLAKE_ACCOUNT',
            warehouse_env: 'SNOWFLAKE_WAREHOUSE',
            database: 'TEST_DB',
            schema: 'PUBLIC',
            role: 'TEST_ROLE',
          },
          auth: { type: 'pat', token_env: 'SNOWFLAKE_TOKEN' },
        },
      ],
    } as unknown as IntegrationSpec;
    expect(isWarehouseSource(integration)).toBe(true);
    expect(getIntegrationDefault(integration, 'database')).toBe('TEST_DB');
  });

  it('resolves ${{ env.X }} references in connection defaults used to qualify tables', () => {
    const integration = {
      auth_env_vars: ['SF_ACCOUNT', 'SF_DOCS_TEST_DATABASE'],
      spec_version: '1',
      type: 'integration',
      name: 'sf_source',
      source_type: 'snowflake',
      connection: {
        account_identifier: '${{ env.SF_ACCOUNT }}',
        database: '${{ env.SF_DOCS_TEST_DATABASE }}',
        schema: 'PUBLIC',
      },
      auth: { type: 'rsa_key', private_key_path: '/tmp/key.p8' },
    } as unknown as IntegrationSpec;
    vi.stubEnv('SF_DOCS_TEST_DATABASE', 'ANALYTICS');
    try {
      expect(getIntegrationDefault(integration, 'database')).toBe('ANALYTICS');
      expect(getIntegrationDefault(integration, 'schema')).toBe('PUBLIC');
      expect(getIntegrationDefault(integration, 'role')).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('returns true for V2 source with sql_clickhouse transport', () => {
    const integration = clickhouseV2Integration();

    expect(isWarehouseSource(integration)).toBe(true);
    expect(getIntegrationDefault(integration, 'database')).toBe('analytics');
  });

  it('honors V2 default_transport when the SQL transport is not first', () => {
    const integration = {
      auth_env_vars: ['PG_HOST', 'PG_PASSWORD', 'PG_USER'],
      spec_version: '2',
      type: 'source',
      name: 'test_mixed_v2',
      default_transport: 'warehouse',
      transports: [
        {
          id: 'api',
          type: 'http',
          base_url: 'https://api.example.com',
        },
        {
          id: 'warehouse',
          type: 'sql_postgres',
          connection: {
            host_env: 'PG_HOST',
            port: 5432,
            database: 'test_db',
            schema: 'public',
          },
          auth: { type: 'password', username_env: 'PG_USER', password_env: 'PG_PASSWORD' },
        },
      ],
    } as unknown as IntegrationSpec;
    expect(isWarehouseSource(integration)).toBe(true);
    expect(getIntegrationDefault(integration, 'database')).toBe('test_db');
  });

  it('does not treat a V2 source as warehouse when default_transport is HTTP', () => {
    const integration = {
      auth_env_vars: ['PG_HOST', 'PG_PASSWORD', 'PG_USER'],
      spec_version: '2',
      type: 'source',
      name: 'test_http_default_v2',
      default_transport: 'api',
      transports: [
        {
          id: 'api',
          type: 'http',
          base_url: 'https://api.example.com',
        },
        {
          id: 'warehouse',
          type: 'sql_postgres',
          connection: {
            host_env: 'PG_HOST',
            port: 5432,
            database: 'test_db',
            schema: 'public',
          },
          auth: { type: 'password', username_env: 'PG_USER', password_env: 'PG_PASSWORD' },
        },
      ],
    } as unknown as IntegrationSpec;
    expect(isWarehouseSource(integration)).toBe(false);
  });

  it('fails fast when reading warehouse defaults from a non-SQL default_transport', () => {
    const integration = {
      auth_env_vars: ['PG_HOST', 'PG_PASSWORD', 'PG_USER'],
      spec_version: '2',
      type: 'source',
      name: 'test_http_default_v2',
      default_transport: 'api',
      transports: [
        {
          id: 'api',
          type: 'http',
          base_url: 'https://api.example.com',
        },
        {
          id: 'warehouse',
          type: 'sql_postgres',
          connection: {
            host_env: 'PG_HOST',
            port: 5432,
            database: 'test_db',
            schema: 'public',
          },
          auth: { type: 'password', username_env: 'PG_USER', password_env: 'PG_PASSWORD' },
        },
      ],
    } as unknown as IntegrationSpec;
    expect(() => getIntegrationDefault(integration, 'database')).toThrow(
      /default_transport "api" points to non-SQL transport type "http"/
    );
  });

  it('fails fast when V2 default_transport references a missing transport id', () => {
    const integration = {
      auth_env_vars: ['PG_HOST', 'PG_PASSWORD', 'PG_USER'],
      spec_version: '2',
      type: 'source',
      name: 'test_missing_default_transport_v2',
      default_transport: 'missing',
      transports: [
        {
          id: 'warehouse',
          type: 'sql_postgres',
          connection: {
            host_env: 'PG_HOST',
            database: 'test_db',
          },
          auth: { type: 'password', username_env: 'PG_USER', password_env: 'PG_PASSWORD' },
        },
      ],
    } as unknown as IntegrationSpec;
    expect(() => isWarehouseSource(integration)).toThrow(
      /default_transport "missing" does not match any transport\.id/
    );
  });

  it('returns false for V2 source with http transport', () => {
    const integration = {
      spec_version: '2',
      type: 'source',
      name: 'test_api_v2',
      transports: [
        {
          id: 'api',
          type: 'http',
          base_url: 'https://api.example.com',
        },
      ],
    } as unknown as IntegrationSpec;
    expect(isWarehouseSource(integration)).toBe(false);
  });

  it('returns false for API integration without source_type', () => {
    const integration = {
      spec_version: '1',
      type: 'integration',
      name: 'test_api',
      transport: {
        base_url: 'https://api.example.com',
        auth: { type: 'none' },
      },
    } as IntegrationSpec;
    expect(isWarehouseSource(integration)).toBe(false);
  });

  it('returns false for API integration with explicit source_type', () => {
    const integration = {
      spec_version: '1',
      type: 'integration',
      name: 'test_api',
      source_type: 'api',
      transport: {
        base_url: 'https://api.example.com',
        auth: { type: 'none' },
      },
    } as IntegrationSpec;
    expect(isWarehouseSource(integration)).toBe(false);
  });

  it('returns false for self-describing custom API sources', () => {
    const integration = {
      spec_version: '2',
      type: 'source',
      source_type: 'custom_api',
      name: 'test_custom_api',
      transports: [
        {
          id: 'default',
          type: 'http',
          base_url: 'https://api.example.com',
          auth: { type: 'none' },
        },
      ],
      default_transport: 'default',
    } as unknown as IntegrationSpec;

    expect(isWarehouseSource(integration)).toBe(false);
  });

  it('returns false for self-describing custom MCP sources', () => {
    const integration = {
      spec_version: '2',
      type: 'source',
      source_type: 'custom_mcp',
      name: 'test_custom_mcp',
      transports: [
        {
          id: 'default',
          type: 'mcp_http',
          url: 'https://mcp.example.com/mcp',
          auth: { type: 'none' },
        },
      ],
      default_transport: 'default',
    } as unknown as IntegrationSpec;

    expect(isWarehouseSource(integration)).toBe(false);
  });
});

// ── isWarehouseResource ──

describe('isWarehouseResource', () => {
  it('returns true for resource with source block', () => {
    expect(isWarehouseResource(ordersResource())).toBe(true);
  });

  it('returns false for API resource with api block', () => {
    const apiResource = {
      spec_version: '1',
      type: 'resource',
      name: 'issues',
      integration: 'github',
      description: 'Issues',
      api: { endpoint: '/issues', method: 'GET' },
      input: {},
      output: { id: { type: 'integer', path: '$.id' } },
      extract: { record_path: '$' },
    } as ResourceSpec;
    expect(isWarehouseResource(apiResource)).toBe(false);
  });
});

// ── extractWarehouseResource ──

describe('extractWarehouseResource', () => {
  let stdoutStream: FakeWritable;
  let stderrStream: FakeWritable;
  let emitter: Emitter;
  let logger: ControlLogger;

  beforeEach(() => {
    stdoutStream = new FakeWritable();
    stderrStream = new FakeWritable();
    emitter = new Emitter('stdout', 'output', {
      stdoutStream: stdoutStream as unknown as Writable,
    });
    logger = new ControlLogger({
      logFormat: 'json',
      quiet: true,
      stream: stderrStream as unknown as Writable,
    });
    vi.clearAllMocks();
  });

  it('resolves a managed Snowflake warehouse selector by map key and forwards the query tag', async () => {
    mockClient = createMockClient([[]]);
    const integration = snowflakeIntegration();
    (integration.connection as Record<string, unknown>)['warehouses'] = {
      small: 'SMALL_WH',
      large: 'BIG_WH',
    };

    await extractWarehouseResource({
      integration,
      resource: ordersResource(),
      integrationName: 'test_snowflake',
      emitter,
      logger,
      state: { streams: {} },
      stateStore: createMockStateStore(),
      warehouse: 'large',
      queryTag: 'managed:run-42',
    });

    expect(createWarehouseClient).toHaveBeenCalledWith(
      'snowflake',
      expect.objectContaining({ warehouse: 'BIG_WH', queryTag: 'managed:run-42' })
    );
  });

  it('resolves an env-backed warehouse name selected from the named map', async () => {
    mockClient = createMockClient([[]]);
    const integration = snowflakeIntegration();
    (integration.connection as Record<string, unknown>)['warehouses'] = {
      small: 'SMALL_WH',
      large: '${{ env.BOBSLED_CORE_TEST_LARGE_WAREHOUSE }}',
    };
    process.env['BOBSLED_CORE_TEST_LARGE_WAREHOUSE'] = 'LARGE_WH';

    try {
      await extractWarehouseResource({
        integration,
        resource: ordersResource(),
        integrationName: 'test_snowflake',
        emitter,
        logger,
        state: { streams: {} },
        stateStore: createMockStateStore(),
        warehouse: 'large',
      });
    } finally {
      delete process.env['BOBSLED_CORE_TEST_LARGE_WAREHOUSE'];
    }

    expect(createWarehouseClient).toHaveBeenCalledWith(
      'snowflake',
      expect.objectContaining({ warehouse: 'LARGE_WH' })
    );
  });

  it('rejects a physical warehouse value when the source declares named selectors', async () => {
    mockClient = createMockClient([[]]);
    const integration = snowflakeIntegration();
    (integration.connection as Record<string, unknown>)['warehouses'] = { large: 'BIG_WH' };

    await expect(
      extractWarehouseResource({
        integration,
        resource: ordersResource(),
        integrationName: 'test_snowflake',
        emitter,
        logger,
        state: { streams: {} },
        stateStore: createMockStateStore(),
        warehouse: 'BIG_WH',
      })
    ).rejects.toThrow(/must name a configured warehouses key/);
  });

  it('requires a named warehouse map when a selector is supplied', async () => {
    mockClient = createMockClient([[]]);

    await expect(
      extractWarehouseResource({
        integration: snowflakeIntegration(),
        resource: ordersResource(),
        integrationName: 'test_snowflake',
        emitter,
        logger,
        state: { streams: {} },
        stateStore: createMockStateStore(),
        warehouse: 'large',
      })
    ).rejects.toThrow(/requires connection\.warehouses/);
  });

  it('rejects a warehouse selector for a non-Snowflake warehouse source', async () => {
    mockClient = createMockClient([[]], 'mysql');
    const integration = {
      auth_env_vars: ['MYSQL_HOST', 'MYSQL_PASSWORD', 'MYSQL_USER'],
      spec_version: '1',
      type: 'integration',
      name: 'test_mysql',
      source_type: 'mysql',
      connection: { host_env: 'MYSQL_HOST', port: 3306, database: 'inventory' },
      auth: { type: 'password', username_env: 'MYSQL_USER', password_env: 'MYSQL_PASSWORD' },
    } as IntegrationSpec;

    await expect(
      extractWarehouseResource({
        integration,
        resource: fullRefreshResource(),
        integrationName: 'test_mysql',
        emitter,
        logger,
        state: { streams: {} },
        stateStore: createMockStateStore(),
        warehouse: 'not_allowed',
      })
    ).rejects.toThrow(/only supported for Snowflake/);
  });

  it('emits SCHEMA message with correct load_strategy and key_properties', async () => {
    mockClient = createMockClient([
      [{ order_id: 1, customer_id: 10, amount: 99.99, updated_at: '2026-01-01T00:00:00Z' }],
    ]);
    const stateStore = createMockStateStore();

    await extractWarehouseResource({
      integration: snowflakeIntegration(),
      resource: ordersResource(),
      integrationName: 'test_snowflake',
      emitter,
      logger,
      state: { streams: {} },
      stateStore,
      fullRefresh: false,
    });

    const messages = stdoutStream.chunks.map((chunk) => JSON.parse(chunk));
    const schemaMsg = messages.find((msg: Record<string, unknown>) => msg.type === 'SCHEMA');

    expect(schemaMsg).toBeDefined();
    expect(schemaMsg.key_properties).toEqual(['order_id']);
  });

  it('carries a warehouse resource schema_behavior through the SCHEMA adapter', async () => {
    mockClient = createMockClient([[]]);
    const resource = ordersResource();
    resource.load = { defaults: { schema_behavior: 'strict' } };

    await extractWarehouseResource({
      integration: snowflakeIntegration(),
      resource,
      integrationName: 'test_snowflake',
      emitter,
      logger,
      state: { streams: {} },
      stateStore: createMockStateStore(),
      fullRefresh: false,
    });

    const schemaMsg = stdoutStream.chunks
      .map((chunk) => JSON.parse(chunk) as Record<string, unknown>)
      .find((message) => message.type === 'SCHEMA');
    expect(schemaMsg?.schema_behavior).toBe('strict');
  });

  it('emits RECORD messages for each row', async () => {
    const rows = [
      { order_id: 1, customer_id: 10, amount: 99.99, updated_at: '2026-01-01T00:00:00Z' },
      { order_id: 2, customer_id: 20, amount: 49.99, updated_at: '2026-01-02T00:00:00Z' },
    ];
    mockClient = createMockClient([rows]);
    const stateStore = createMockStateStore();

    const result = await extractWarehouseResource({
      integration: snowflakeIntegration(),
      resource: ordersResource(),
      integrationName: 'test_snowflake',
      emitter,
      logger,
      state: { streams: {} },
      stateStore,
      fullRefresh: false,
    });

    const messages = stdoutStream.chunks.map((chunk) => JSON.parse(chunk));
    const recordMsgs = messages.filter((msg: Record<string, unknown>) => msg.type === 'RECORD');

    expect(recordMsgs).toHaveLength(2);
    expect(recordMsgs[0].record.order_id).toBe(1);
    expect(recordMsgs[1].record.order_id).toBe(2);
    expect(result.recordCount).toBe(2);
  });

  it('extracts warehouse resources from V2 SQL transport integrations', async () => {
    mockClient = createMockClient([[{ order_id: 1, updated_at: '2026-01-01T00:00:00Z' }]]);
    const stateStore = createMockStateStore();
    const integration = {
      auth_env_vars: [
        'SNOWFLAKE_ACCOUNT',
        'SNOWFLAKE_TOKEN',
        'SNOWFLAKE_WAREHOUSE',
        'BOBSLED_CORE_TEST_LARGE_WAREHOUSE',
      ],
      spec_version: '2',
      type: 'source',
      name: 'test_sf_v2',
      transports: [
        {
          id: 'warehouse',
          type: 'sql_snowflake',
          connection: {
            account_identifier_env: 'SNOWFLAKE_ACCOUNT',
            warehouse_env: 'SNOWFLAKE_WAREHOUSE',
            database: 'TEST_DB',
            schema: 'PUBLIC',
          },
          auth: { type: 'pat', token_env: 'SNOWFLAKE_TOKEN' },
        },
      ],
    } as unknown as IntegrationSpec;

    const result = await extractWarehouseResource({
      integration,
      resource: {
        ...ordersResource(),
        source: { table: 'ORDERS' },
      },
      integrationName: 'test_sf_v2',
      emitter,
      logger,
      state: { streams: {} },
      stateStore,
      fullRefresh: false,
    });

    expect(result.recordCount).toBe(1);
  });

  it('coerces non-CDC rows through the output schema before emission', async () => {
    mockClient = createMockClient([
      [
        {
          order_id: 1n,
          customer_id: '10',
          amount: '99.99',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    ]);
    const stateStore = createMockStateStore();

    await extractWarehouseResource({
      integration: snowflakeIntegration(),
      resource: ordersResource(),
      integrationName: 'test_snowflake',
      emitter,
      logger,
      state: { streams: {} },
      stateStore,
      fullRefresh: false,
    });

    const messages = stdoutStream.chunks.map((chunk) => JSON.parse(chunk));
    const recordMsg = messages.find((msg: Record<string, unknown>) => msg.type === 'RECORD');

    expect(recordMsg).toBeDefined();
    expect(recordMsg.record).toEqual({
      amount: 99.99,
      customer_id: 10,
      order_id: 1,
      updated_at: '2026-01-01T00:00:00Z',
    });
  });

  it('emits STATE message with updated cursor value', async () => {
    const rows = [
      { order_id: 1, customer_id: 10, amount: 99.99, updated_at: '2026-01-01T00:00:00Z' },
      { order_id: 2, customer_id: 20, amount: 49.99, updated_at: '2026-01-02T00:00:00Z' },
    ];
    mockClient = createMockClient([rows]);
    const stateStore = createMockStateStore();

    await extractWarehouseResource({
      integration: snowflakeIntegration(),
      resource: ordersResource(),
      integrationName: 'test_snowflake',
      emitter,
      logger,
      state: { streams: {} },
      stateStore,
      fullRefresh: false,
    });

    const messages = stdoutStream.chunks.map((chunk) => JSON.parse(chunk));
    const stateMsg = messages.find((msg: Record<string, unknown>) => msg.type === 'STATE');

    expect(stateMsg).toBeDefined();
    expect(stateMsg.value.cursor_field).toBe('updated_at');
    expect(stateMsg.value.cursor_value).toBe('2026-01-02T00:00:00Z');
  });

  it('handles multiple batches from the client', async () => {
    const batch1 = [
      { order_id: 1, customer_id: 10, amount: 99.99, updated_at: '2026-01-01T00:00:00Z' },
    ];
    const batch2 = [
      { order_id: 2, customer_id: 20, amount: 49.99, updated_at: '2026-01-02T00:00:00Z' },
      { order_id: 3, customer_id: 30, amount: 29.99, updated_at: '2026-01-03T00:00:00Z' },
    ];
    mockClient = createMockClient([batch1, batch2]);
    const stateStore = createMockStateStore();

    const result = await extractWarehouseResource({
      integration: snowflakeIntegration(),
      resource: ordersResource(),
      integrationName: 'test_snowflake',
      emitter,
      logger,
      state: { streams: {} },
      stateStore,
      fullRefresh: false,
    });

    expect(result.recordCount).toBe(3);
  });

  it('emits message sequence: SCHEMA, RECORD(s), STATE', async () => {
    const rows = [
      { order_id: 1, customer_id: 10, amount: 99.99, updated_at: '2026-01-01T00:00:00Z' },
    ];
    mockClient = createMockClient([rows]);
    const stateStore = createMockStateStore();

    await extractWarehouseResource({
      integration: snowflakeIntegration(),
      resource: ordersResource(),
      integrationName: 'test_snowflake',
      emitter,
      logger,
      state: { streams: {} },
      stateStore,
      fullRefresh: false,
    });

    const messages = stdoutStream.chunks.map((chunk) => JSON.parse(chunk));
    const types = messages.map((msg: Record<string, unknown>) => msg.type);

    expect(types[0]).toBe('SCHEMA');
    expect(types.slice(1, -1).every((t: string) => t === 'RECORD')).toBe(true);
    expect(types[types.length - 1]).toBe('STATE');
  });

  it('uses full_refresh when --full-refresh flag is set (ignores existing cursor)', async () => {
    mockClient = createMockClient([[{ id: 1, sku: 'ABC', name: 'Widget', price: 9.99 }]], 'mysql');
    const stateStore = createMockStateStore({
      streams: {
        'test_mysql/products': {
          cursor_field: 'updated_at',
          cursor_value: '2026-01-01T00:00:00Z',
          last_run_at: '2026-01-01T00:00:00Z',
          record_count: 50,
        },
      },
    });

    const result = await extractWarehouseResource({
      integration: snowflakeIntegration(),
      resource: fullRefreshResource(),
      integrationName: 'test_mysql',
      emitter,
      logger,
      state: {
        streams: {
          'test_mysql/products': {
            cursor_field: 'updated_at',
            cursor_value: '2026-01-01T00:00:00Z',
            last_run_at: '2026-01-01T00:00:00Z',
            record_count: 50,
          },
        },
      },
      stateStore,
      fullRefresh: true,
    });

    // Should still extract records even with fullRefresh flag
    expect(result.recordCount).toBe(1);
    const messages = stdoutStream.chunks.map((chunk) => JSON.parse(chunk));
    const schemaMsg = messages.find((msg: Record<string, unknown>) => msg.type === 'SCHEMA');
    expect(schemaMsg).toBeDefined();
    expect(schemaMsg.stream).toBe('products');
  });

  it('extracts a ClickHouse full refresh through the warehouse client', async () => {
    mockClient = createMockClient(
      [[{ order_id: 1, customer_id: 10, amount: 99.99, updated_at: '2026-01-01T00:00:00Z' }]],
      'clickhouse'
    );

    const result = await extractWarehouseResource({
      integration: clickhouseIntegration(),
      resource: clickhouseResource({ method: 'full_refresh' }),
      integrationName: 'test_clickhouse',
      emitter,
      logger,
      state: { streams: {} },
      stateStore: createMockStateStore(),
    });

    expect(result.recordCount).toBe(1);
    expect(createWarehouseClient).toHaveBeenCalledWith(
      'clickhouse',
      expect.objectContaining({
        host: 'localhost',
        port: 8123,
        database: 'analytics',
        ssl: { mode: 'require' },
      })
    );
  });

  it('extracts ClickHouse incremental rows with a cursor bookmark', async () => {
    const queries: ExecutedQuery[] = [];
    mockClient = createMockClient(
      [[{ order_id: 2, customer_id: 20, amount: 49.99, updated_at: '2026-01-02T00:00:00Z' }]],
      'clickhouse',
      queries
    );
    const state = {
      streams: {
        'test_clickhouse/events': {
          cursor_field: 'updated_at',
          cursor_type: 'timestamp' as const,
          cursor_value: '2026-01-01T00:00:00Z',
          last_run_at: '2026-01-01T00:00:00Z',
          record_count: 1,
        },
      },
    };

    const result = await extractWarehouseResource({
      integration: clickhouseIntegration(),
      resource: clickhouseResource(),
      integrationName: 'test_clickhouse',
      emitter,
      logger,
      state,
      stateStore: createMockStateStore(state),
    });

    expect(result.recordCount).toBe(1);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain('WHERE `updated_at` > {p1:String} ORDER BY `updated_at`');
    expect(queries[0]?.params).toEqual(['2026-01-01T00:00:00Z']);
    expect(result.durableBookmark?.cursor_value).toBe('2026-01-02T00:00:00Z');
  });

  it('rejects ClickHouse change_tracking before executing a query', async () => {
    const queries: ExecutedQuery[] = [];
    mockClient = createMockClient([], 'clickhouse', queries);

    await expect(
      extractWarehouseResource({
        integration: clickhouseIntegration(),
        resource: clickhouseResource({
          method: 'change_tracking',
          primary_key: ['order_id'],
        }),
        integrationName: 'test_clickhouse',
        emitter,
        logger,
        state: { streams: {} },
        stateStore: createMockStateStore(),
      })
    ).rejects.toThrow('change_tracking is not supported for clickhouse');

    expect(queries).toEqual([]);
  });

  it('handles empty result set gracefully', async () => {
    mockClient = createMockClient([]);
    const stateStore = createMockStateStore();

    const result = await extractWarehouseResource({
      integration: snowflakeIntegration(),
      resource: ordersResource(),
      integrationName: 'test_snowflake',
      emitter,
      logger,
      state: { streams: {} },
      stateStore,
      fullRefresh: false,
    });

    expect(result.recordCount).toBe(0);
    const messages = stdoutStream.chunks.map((chunk) => JSON.parse(chunk));
    const schemaMsg = messages.find((msg: Record<string, unknown>) => msg.type === 'SCHEMA');
    expect(schemaMsg).toBeDefined();
  });

  it('closes the warehouse client after extraction', async () => {
    mockClient = createMockClient([
      [{ order_id: 1, customer_id: 10, amount: 99.99, updated_at: '2026-01-01T00:00:00Z' }],
    ]);
    const stateStore = createMockStateStore();

    await extractWarehouseResource({
      integration: snowflakeIntegration(),
      resource: ordersResource(),
      integrationName: 'test_snowflake',
      emitter,
      logger,
      state: { streams: {} },
      stateStore,
      fullRefresh: false,
    });

    expect(mockClient.close).toHaveBeenCalledTimes(1);
  });

  it('normalizes CDC metadata columns for Snowflake change_tracking', async () => {
    const rows = [
      {
        order_id: 1,
        updated_at: '2026-01-01T00:00:00Z',
        METADATA$ACTION: 'INSERT',
        METADATA$ISUPDATE: false,
        METADATA$ROW_ID: 'abc123',
      },
    ];
    mockClient = createMockClient([rows]);
    const stateStore = createMockStateStore({
      streams: {
        'test_snowflake/orders_cdc': {
          cursor_field: '_last_sync_ts',
          cursor_value: '2026-01-01T00:00:00Z',
          last_run_at: '2026-01-01T00:00:00Z',
          record_count: 0,
        },
      },
    });

    await extractWarehouseResource({
      integration: snowflakeIntegration(),
      resource: cdcResource(),
      integrationName: 'test_snowflake',
      emitter,
      logger,
      state: {
        streams: {
          'test_snowflake/orders_cdc': {
            cursor_field: '_last_sync_ts',
            cursor_value: '2026-01-01T00:00:00Z',
            last_run_at: '2026-01-01T00:00:00Z',
            record_count: 0,
          },
        },
      },
      stateStore,
      fullRefresh: false,
    });

    const messages = stdoutStream.chunks.map((chunk) => JSON.parse(chunk));
    const recordMsg = messages.find((msg: Record<string, unknown>) => msg.type === 'RECORD');

    expect(recordMsg).toBeDefined();
    // CDC metadata should be normalized to _change_type / _is_update
    expect(recordMsg.record._change_type).toBe('INSERT');
    expect(recordMsg.record._is_update).toBe(false);
  });

  it('skips durable warehouse state advancement when advanceState is false', async () => {
    mockClient = createMockClient([
      [{ order_id: 1, customer_id: 10, amount: 99.99, updated_at: '2026-01-01T00:00:00Z' }],
    ]);
    const stateStore = createMockStateStore();

    const result = await extractWarehouseResource({
      integration: snowflakeIntegration(),
      resource: ordersResource(),
      integrationName: 'test_snowflake',
      emitter,
      logger,
      state: { streams: {} },
      stateStore,
      advanceState: false,
    });

    expect(result.durableBookmark).toBeUndefined();
    expect(vi.mocked(stateStore.save)).not.toHaveBeenCalled();

    const messages = stdoutStream.chunks.map((chunk) => JSON.parse(chunk));
    expect(messages.some((m: Record<string, unknown>) => m.type === 'STATE')).toBe(true);
  });
});

// ── BigQuery two-run orchestrator regression ──

describe('BigQuery incremental — two-run orchestrator regression (INT64 cursor, no declared type)', () => {
  it('run 2 resolves INT64 column type from metadata and uses CAST(? AS INT64) in the WHERE clause', async () => {
    // Scenario: a user has an INT64 `id` cursor column but has not declared
    // cursor_type in the resource spec. On run 1 no WHERE clause is emitted
    // (no cursor value yet). On run 2 the extractor resolves the column type
    // from BigQuery table metadata and emits CAST(? AS INT64) so the parameter
    // matches the column type. Without this fix the extractor would bind the
    // STRING "8" against INT64, which BigQuery rejects.
    const capturedOpts: Record<string, unknown>[] = [];

    const mockJob = {
      getQueryResults: async () =>
        [[{ id: 42, name: 'alice' }], undefined, {}] as [
          Record<string, unknown>[],
          unknown,
          object,
        ],
    };

    const mockSdk = {
      createQueryJob: async (opts: Record<string, unknown>) => {
        capturedOpts.push(opts);
        return [mockJob];
      },
      dataset: (_datasetId: string, _opts?: unknown) => ({
        table: (_tableId: string) => ({
          getMetadata: async () => [
            {
              schema: {
                fields: [
                  { name: 'id', type: 'INT64' },
                  { name: 'name', type: 'STRING' },
                ],
              },
            },
            {},
          ],
        }),
      }),
    };

    const bqClient = new BigQueryWarehouseClient({ projectId: 'proj' });
    (bqClient as unknown as { sdkClient: unknown }).sdkClient = mockSdk;
    mockClient = bqClient;

    const integration = {
      auth_env_vars: [],
      spec_version: '1',
      type: 'integration',
      name: 'bq_source',
      source_type: 'bigquery',
      connection: { projectId: 'proj', dataset: 'ds' },
    } as unknown as IntegrationSpec;

    const resource = {
      spec_version: '1',
      type: 'resource',
      name: 'orders',
      integration: 'bq_source',
      source: { table: 'orders', dataset: 'ds' },
      replication: {
        method: 'incremental_append',
        cursor_field: 'id',
        // cursor_type intentionally absent — the common real-world case
      },
      output: {
        id: { type: 'integer' },
        name: { type: 'string' },
      },
    } as unknown as WarehouseResourceSpec;

    // Run 2: state already has a bookmark with cursor_value "8"
    const state: ExtractorState = {
      streams: {
        'bq_source/orders': {
          cursor_field: 'id',
          cursor_value: '8',
          last_run_at: '2026-01-01T00:00:00Z',
          record_count: 1,
        },
      },
    };

    const stateStore = createMockStateStore(state);

    const stdoutStream = new FakeWritable();
    const stderrStream = new FakeWritable();
    const testEmitter = new Emitter('stdout', 'output', {
      stdoutStream: stdoutStream as unknown as Writable,
    });
    const testLogger = new ControlLogger({
      logFormat: 'json',
      quiet: true,
      stream: stderrStream as unknown as Writable,
    });

    await extractWarehouseResource({
      integration,
      resource,
      integrationName: 'bq_source',
      emitter: testEmitter,
      logger: testLogger,
      state,
      stateStore,
    });

    expect(capturedOpts).toHaveLength(1);
    const query = String(capturedOpts[0]!['query']);
    // The WHERE clause must use CAST(? AS INT64), not a plain ?
    expect(query).toContain('CAST(? AS INT64)');
    expect(query).not.toMatch(/WHERE `id` > \?/);
    // The cursor value must be bound as a positional parameter
    expect(capturedOpts[0]!['params']).toEqual(['8']);
    expect(capturedOpts[0]!['parameterMode']).toBe('positional');
  });
});
