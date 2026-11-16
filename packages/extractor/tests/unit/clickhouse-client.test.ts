import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClickHouseWarehouseClient } from '../../src/runtime/clickhouse-client.js';
import { resetDnsLookupForTests, setDnsLookupForTests } from '../../src/framework/core/ssrf.js';
import type { LookupFunction } from 'node:net';
import * as http from 'node:http';

interface MockRow {
  json: ReturnType<typeof vi.fn>;
}

function createClientMocks(rows: Record<string, unknown>[]) {
  const query = vi.fn().mockResolvedValue({
    stream: () =>
      (async function* (): AsyncGenerator<MockRow[]> {
        yield rows.map((row) => ({ json: vi.fn(() => row) }));
      })(),
  });
  const close = vi.fn().mockResolvedValue(undefined);
  const createClient = vi.fn(() => ({ query, close }));
  vi.doMock('@clickhouse/client', () => ({ createClient }));
  return { createClient, query, close };
}

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    host: 'ch.example.com',
    port: 8443,
    database: 'analytics',
    auth: { type: 'password', username: 'default', password: 'secret' },
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@clickhouse/client');
  resetDnsLookupForTests();
});

describe('ClickHouseWarehouseClient', () => {
  it('uses HTTPS when SSL mode is require', async () => {
    const { createClient } = createClientMocks([]);
    const client = new ClickHouseWarehouseClient(config({ ssl: { mode: 'require' } }));

    await client.testConnection();

    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://ch.example.com:8443' })
    );
  });

  it('uses HTTP when SSL is disabled', async () => {
    const { createClient } = createClientMocks([]);
    const client = new ClickHouseWarehouseClient(config({ ssl: { mode: 'disable' } }));

    await client.testConnection();

    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://ch.example.com:8443' })
    );
  });

  it('uses a connection-time SSRF-safe agent for ClickHouse requests', async () => {
    const { createClient } = createClientMocks([]);
    const originalAllowPrivateHosts = process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
    delete process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
    setDnsLookupForTests(async () => ({ address: '127.0.0.1', family: 4 }));
    const client = new ClickHouseWarehouseClient(config());

    try {
      await client.testConnection();

      const agent = createClient.mock.calls[0]?.[0].http_agent as http.Agent;
      const lookup = agent.options.lookup as LookupFunction;
      await expect(
        new Promise<string>((resolve, reject) => {
          lookup('ch.example.com', {}, (error, address) => {
            if (error) {
              reject(error);
            } else {
              resolve(address);
            }
          });
        })
      ).rejects.toThrow(/private address/);
    } finally {
      if (originalAllowPrivateHosts === undefined) {
        delete process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
      } else {
        process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'] = originalAllowPrivateHosts;
      }
    }
  });

  it.each([
    ['missing auth', { auth: undefined }, '"auth" must be an object'],
    ['array auth', { auth: [] }, '"auth" must be an object'],
    [
      'unsupported auth type',
      { auth: { type: 'oauth', username: 'default', password: 'secret' } },
      'unsupported auth type',
    ],
    ['unsupported ssl mode', { ssl: { mode: 'verify' } }, 'unsupported ssl.mode'],
    ['non-object ssl', { ssl: 'require' }, '"ssl" must be an object'],
    ['non-string CA certificate', { ssl: { mode: 'require', caCert: 42 } }, 'caCert'],
    ['non-finite port', { port: Number.NaN }, 'port'],
    ['fractional port', { port: 8123.5 }, 'positive integer'],
    ['non-positive port', { port: 0 }, 'positive integer'],
    ['excessive port', { port: 65_536 }, 'positive integer'],
    ['fractional statement timeout', { statement_timeout_ms: 1.5 }, 'positive integer'],
    ['non-positive statement timeout', { statement_timeout_ms: 0 }, 'positive integer'],
    ['excessive statement timeout', { statement_timeout_ms: 86_401_000 }, '<='],
  ])('rejects %s at the configuration boundary', (_label, overrides, message) => {
    expect(() => new ClickHouseWarehouseClient(config(overrides))).toThrow(message);
  });

  it('passes ClickHouse named query parameters', async () => {
    const { query } = createClientMocks([{ id: 1 }]);
    const client = new ClickHouseWarehouseClient(config());

    const batches = [];
    for await (const batch of client.execute(
      'SELECT * FROM events WHERE updated_at > {p1:String}',
      ['2024-01-01T00:00:00Z']
    )) {
      batches.push(batch);
    }

    expect(query).toHaveBeenCalledWith({
      query: 'SELECT * FROM events WHERE updated_at > {p1:String}',
      format: 'JSONEachRow',
      query_params: { p1: '2024-01-01T00:00:00Z' },
    });
    expect(batches).toEqual([[{ id: 1 }]]);
  });

  it('yields bounded batches and honors maxRows', async () => {
    const rows = Array.from({ length: 25_000 }, (_, index) => ({ id: index }));
    createClientMocks(rows);
    const client = new ClickHouseWarehouseClient(config());

    const batches = [];
    for await (const batch of client.execute('SELECT * FROM events')) {
      batches.push(batch);
    }
    expect(batches.map((batch) => batch.length)).toEqual([10_000, 10_000, 5_000]);

    const limitedClient = new ClickHouseWarehouseClient(config());
    const limited = [];
    for await (const batch of limitedClient.execute('SELECT * FROM events', [], { maxRows: 7 })) {
      limited.push(...batch);
    }
    expect(limited).toHaveLength(7);
  });

  it('discovers ClickHouse primary-key hints and nullability', async () => {
    createClientMocks([
      {
        table_name: 'events',
        column_name: 'id',
        data_type: 'UInt64',
        is_in_primary_key: 1,
        comment: 'Event id',
      },
      {
        table_name: 'events',
        column_name: 'name',
        data_type: 'Nullable(String)',
        is_in_primary_key: 0,
      },
    ]);
    const client = new ClickHouseWarehouseClient(config());

    await expect(client.introspect('analytics', '')).resolves.toEqual([
      {
        tableName: 'events',
        schema: 'analytics',
        database: 'analytics',
        columns: [
          {
            name: 'id',
            sourceType: 'UInt64',
            nullable: false,
            isPrimaryKey: true,
            comment: 'Event id',
          },
          {
            name: 'name',
            sourceType: 'Nullable(String)',
            nullable: true,
            isPrimaryKey: false,
          },
        ],
      },
    ]);
  });

  it('returns a structured failure from testConnection', async () => {
    const { query } = createClientMocks([]);
    query.mockRejectedValue(new Error('authentication failed'));
    const client = new ClickHouseWarehouseClient(config());

    await expect(client.testConnection()).resolves.toEqual({
      success: false,
      error: 'authentication failed',
    });
  });

  it('closes the SDK client once and is idempotent', async () => {
    const { close } = createClientMocks([]);
    const client = new ClickHouseWarehouseClient(config());
    await client.testConnection();
    await client.close();
    await client.close();

    expect(close).toHaveBeenCalledTimes(1);
  });
});
