import { describe, expect, it, vi } from 'vitest';

import {
  buildClickHouseClientConfig,
  buildClickHouseRunner,
} from '../../../../src/runtime/runners/clickhouse.js';
import { resolveRunner } from '../../../../src/runtime/resolve-runner.js';
import type {
  ClickHouseIntegration,
  IntegrationFile,
} from '../../../../src/schemas/integration.js';

const integration = (
  overrides: Partial<ClickHouseIntegration['connection']> = {},
  auth: Partial<ClickHouseIntegration['auth']> = {}
): ClickHouseIntegration =>
  ({
    spec_version: '1',
    type: 'integration',
    name: 'analytics_ch',
    source_type: 'clickhouse',
    connection: { host: 'clickhouse.internal', database: 'analytics', ...overrides },
    auth: { type: 'password', user: 'default', password: 'private', ...auth },
  }) as ClickHouseIntegration;

interface FakeClient {
  query: ReturnType<typeof vi.fn>;
  command: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const fakeClient = (rows: Record<string, unknown>[] = []): FakeClient => ({
  query: vi.fn().mockResolvedValue({ json: async () => rows }),
  command: vi.fn().mockResolvedValue({}),
  close: vi.fn().mockResolvedValue(undefined),
});

describe('buildClickHouseClientConfig', () => {
  // ClickHouse Cloud is HTTPS-only on 8443, so it must be reachable from host,
  // database and credentials alone — no transport settings to get right.
  it('reaches ClickHouse Cloud with no transport settings', () => {
    const config = buildClickHouseClientConfig(
      integration({ host: 'example.us-central1.gcp.clickhouse.cloud' })
    );
    expect(config).toMatchObject({
      url: 'https://example.us-central1.gcp.clickhouse.cloud:8443',
      database: 'analytics',
      username: 'default',
      password: 'private',
    });
  });

  it('defaults to TLS so a forgotten ssl block cannot send credentials in the clear', () => {
    expect(buildClickHouseClientConfig(integration())['url']).toBe(
      'https://clickhouse.internal:8443'
    );
  });

  it('drops to plain HTTP and 8123 only when ssl is explicitly disabled', () => {
    const config = buildClickHouseClientConfig(integration({ ssl: { mode: 'disable' } }));
    expect(config['url']).toBe('http://clickhouse.internal:8123');
  });

  it('honours an explicit port over the derived one', () => {
    expect(buildClickHouseClientConfig(integration({ port: 9000 }))['url']).toBe(
      'https://clickhouse.internal:9000'
    );
    expect(
      buildClickHouseClientConfig(integration({ port: 8123, ssl: { mode: 'disable' } }))['url']
    ).toBe('http://clickhouse.internal:8123');
  });

  it('sends a custom CA only when TLS is actually in use', () => {
    expect(
      buildClickHouseClientConfig(
        integration({ ssl: { mode: 'require', ca_cert: '-----BEGIN CERTIFICATE-----' } })
      )['tls']
    ).toBeDefined();
    expect(
      buildClickHouseClientConfig(
        integration({ ssl: { mode: 'disable', ca_cert: '-----BEGIN CERTIFICATE-----' } })
      )['tls']
    ).toBeUndefined();
  });

  it('substitutes an empty password for a passwordless user', () => {
    const config = buildClickHouseClientConfig(
      integration({}, { type: 'password', user: 'default', password: undefined })
    );
    expect(config['password']).toBe('');
  });

  it('rounds a sub-second statement timeout up rather than down to no limit', () => {
    const config = buildClickHouseClientConfig(integration({ statement_timeout_ms: 1500 }));
    expect(config['clickhouse_settings']).toEqual({ max_execution_time: 2 });
  });

  it('omits the timeout setting when none is configured', () => {
    expect(buildClickHouseClientConfig(integration())['clickhouse_settings']).toBeUndefined();
  });

  // A Cloud service that has scaled to zero has to wake before it answers, and
  // the driver's own 30s default can expire during that wake.
  it('allows longer than the driver default for a cold start', () => {
    expect(buildClickHouseClientConfig(integration())['request_timeout']).toBe(60_000);
  });

  // The client aborts the request regardless of what the server was told, so a
  // statement timeout longer than the request window could never be reached.
  it('keeps the request window longer than the statement timeout', () => {
    const statementTimeoutMs = 300_000;
    const config = buildClickHouseClientConfig(
      integration({ statement_timeout_ms: statementTimeoutMs })
    );
    expect(config['request_timeout']).toBeGreaterThan(statementTimeoutMs);
  });

  it('does not shrink the request window for a short statement timeout', () => {
    const config = buildClickHouseClientConfig(integration({ statement_timeout_ms: 1000 }));
    expect(config['request_timeout']).toBe(60_000);
  });
});

describe('buildClickHouseRunner', () => {
  it('runs a statement as a command', async () => {
    const client = fakeClient();
    const runner = await buildClickHouseRunner(integration(), { client });

    await runner.run('CREATE TABLE `analytics`.`t` (id Int64) ENGINE = MergeTree() ORDER BY id');

    expect(client.command).toHaveBeenCalledTimes(1);
    expect(client.command.mock.calls[0]?.[0]?.query).toContain('CREATE TABLE');
  });

  it('returns query rows', async () => {
    const client = fakeClient([{ id: 1 }, { id: 2 }]);
    const runner = await buildClickHouseRunner(integration(), { client });

    await expect(runner.query?.('SELECT id FROM t')).resolves.toEqual([{ id: 1 }, { id: 2 }]);
    expect(client.query.mock.calls[0]?.[0]?.format).toBe('JSONEachRow');
  });

  it('maps positional bindings onto ClickHouse named parameters', async () => {
    const client = fakeClient();
    const runner = await buildClickHouseRunner(integration(), { client });

    await runner.query?.('SELECT * FROM t WHERE a = {p1:String} AND b = {p2:String}', ['x', 'y']);

    expect(client.query.mock.calls[0]?.[0]?.query_params).toEqual({ p1: 'x', p2: 'y' });
  });

  it('passes named bindings through unchanged', async () => {
    const client = fakeClient();
    const runner = await buildClickHouseRunner(integration(), { client });

    await runner.query?.('SELECT * FROM t WHERE a = {since:String}', { since: '2026-01-01' });

    expect(client.query.mock.calls[0]?.[0]?.query_params).toEqual({ since: '2026-01-01' });
  });

  it('omits query_params entirely when there are no bindings', async () => {
    const client = fakeClient();
    const runner = await buildClickHouseRunner(integration(), { client });

    await runner.query?.('SELECT 1');

    expect(client.query.mock.calls[0]?.[0]).not.toHaveProperty('query_params');
  });

  it('kills the statement server-side when the caller aborts', async () => {
    const controller = new AbortController();
    const client = fakeClient();
    // Abort once the statement is in flight so the runner reaches its
    // registered canceller rather than short-circuiting before dispatch.
    client.command.mockImplementationOnce(async () => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {};
    });
    const runner = await buildClickHouseRunner(integration(), { client });

    await runner.run('ALTER TABLE t DELETE WHERE 1', { signal: controller.signal }).catch(() => {});

    const kill = client.command.mock.calls.find(([arg]) => String(arg?.query).includes('KILL'));
    expect(kill).toBeDefined();
    // The kill must target the statement's own id, never a literal from the SQL.
    expect(kill?.[0]?.query_params).toHaveProperty('kill_target');
  });

  it('refuses to start once the signal is already aborted', async () => {
    const client = fakeClient();
    const runner = await buildClickHouseRunner(integration(), { client });

    await expect(runner.run('SELECT 1', { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(client.command).not.toHaveBeenCalled();
  });

  it('closes the underlying client', async () => {
    const client = fakeClient();
    const runner = await buildClickHouseRunner(integration(), { client });

    await runner.close?.();

    expect(client.close).toHaveBeenCalledTimes(1);
  });
});

describe('resolveRunner for ClickHouse', () => {
  it('dispatches password auth to the built-in adapter', async () => {
    // Proves the (clickhouse, password) key is registered: an unregistered key
    // throws "No runner available" from resolveRunner instead. The client is
    // lazy over HTTP, so building one opens no connection.
    const runner = await resolveRunner(integration() as IntegrationFile);
    expect(runner.run).toBeTypeOf('function');
    expect(runner.query).toBeTypeOf('function');
    expect(runner.supportsBindings).toBe(true);
    await runner.close?.();
  });

  it('reports no runner for an auth type ClickHouse does not support', async () => {
    const unsupported = {
      ...integration(),
      auth: { type: 'oauth', token: 'private' },
    } as unknown as IntegrationFile;
    await expect(resolveRunner(unsupported)).rejects.toThrow(/No runner available/);
  });
});
