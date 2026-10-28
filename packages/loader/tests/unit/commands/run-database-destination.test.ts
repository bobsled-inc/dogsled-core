import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SnowflakeDestConfig } from '../../../src/schemas/config.js';
import type { ClickHouseDestConfig, TurbopufferDestConfig } from '../../../src/schemas/config.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('../../../src/runtime/destinations/snowflake.js');
  vi.doUnmock('../../../src/runtime/bigquery-auth.js');
  vi.doUnmock('../../../src/runtime/destinations/clickhouse.js');
  vi.doUnmock('../../../src/runtime/destinations/turbopuffer.js');
});

describe('createDefaultDatabaseDestination', () => {
  it('passes ClickHouse SSL and vector index settings to the destination', async () => {
    let receivedOptions: Record<string, unknown> | undefined;
    vi.doMock('../../../src/runtime/destinations/clickhouse.js', () => ({
      ClickHouseDestination: class {
        constructor(options: Record<string, unknown>) {
          receivedOptions = options;
        }
      },
    }));

    const { createDefaultDatabaseDestination } =
      await import('../../../src/commands/run-database-destination.js');
    const config: ClickHouseDestConfig = {
      dest: 'clickhouse',
      host: 'ch.example.com',
      port: 8443,
      database: 'analytics',
      username: 'default',
      password: 'secret',
      ssl: true,
      vectorIndex: true,
      bufferSize: 1,
      logFormat: 'text',
      maxConcurrentLoads: 1,
    };

    await createDefaultDatabaseDestination(config);

    expect(receivedOptions).toMatchObject({
      host: 'ch.example.com',
      port: 8443,
      database: 'analytics',
      ssl: true,
      vectorIndex: true,
    });
  });

  it('passes Turbopuffer options to the destination', async () => {
    let receivedOptions: Record<string, unknown> | undefined;
    vi.doMock('../../../src/runtime/destinations/turbopuffer.js', () => ({
      TurbopufferDestination: class {
        constructor(options: Record<string, unknown>) {
          receivedOptions = options;
        }
      },
    }));

    const { createDefaultDatabaseDestination } =
      await import('../../../src/commands/run-database-destination.js');
    const config: TurbopufferDestConfig = {
      dest: 'turbopuffer',
      apiKey: 'k',
      region: 'gcp-us-central1',
      namespacePrefix: 'raw_',
      bufferSize: 1,
      logFormat: 'text',
      maxConcurrentLoads: 1,
    };

    await createDefaultDatabaseDestination(config);

    expect(receivedOptions).toMatchObject({
      apiKey: 'k',
      region: 'gcp-us-central1',
      namespacePrefix: 'raw_',
    });
  });

  it('passes the Snowflake workload identity token to the destination', async () => {
    let receivedOptions: Record<string, unknown> | undefined;

    vi.doMock('../../../src/runtime/destinations/snowflake.js', () => ({
      SnowflakeDestination: class {
        constructor(options: Record<string, unknown>) {
          receivedOptions = options;
        }
      },
    }));

    const { createDefaultDatabaseDestination } =
      await import('../../../src/commands/run-database-destination.js');

    const config: SnowflakeDestConfig = {
      dest: 'snowflake',
      account: 'acct',
      username: 'loader',
      workloadIdentityToken: 'header.payload.signature',
      warehouse: 'WH',
      database: 'DB',
      targetSchema: 'PUBLIC',
      bufferSize: 1,
      logFormat: 'text',
      maxConcurrentLoads: 1,
    };

    await createDefaultDatabaseDestination(config);

    expect(receivedOptions).toMatchObject({
      account: 'acct',
      username: 'loader',
      workloadIdentityToken: 'header.payload.signature',
      warehouse: 'WH',
      database: 'DB',
      schema: 'PUBLIC',
    });
  });

  it('rejects workload identity conflicts before constructing SnowflakeDestination', async () => {
    const SnowflakeDestination = vi.fn();
    vi.doMock('../../../src/runtime/destinations/snowflake.js', () => ({
      SnowflakeDestination,
    }));

    const { createDefaultDatabaseDestination } =
      await import('../../../src/commands/run-database-destination.js');

    const config: SnowflakeDestConfig = {
      dest: 'snowflake',
      account: 'acct',
      username: 'loader',
      password: 'pat-token',
      workloadIdentityToken: 'header.payload.signature',
      warehouse: 'WH',
      database: 'DB',
      targetSchema: 'PUBLIC',
      bufferSize: 1,
      logFormat: 'text',
      maxConcurrentLoads: 1,
    };

    await expect(createDefaultDatabaseDestination(config)).rejects.toThrow(
      /workload identity.*password/i
    );
    expect(SnowflakeDestination).not.toHaveBeenCalled();
  });

  it('passes Snowflake accessToken through and wraps tokenCommand with the shared provider', async () => {
    const tokenProvider = vi.fn();
    const createTokenCommandProvider = vi.fn().mockReturnValue(tokenProvider);
    let receivedOptions: Record<string, unknown> | undefined;

    vi.doMock('../../../src/runtime/bigquery-auth.js', () => ({
      createTokenCommandProvider,
    }));
    vi.doMock('../../../src/runtime/destinations/snowflake.js', () => ({
      SnowflakeDestination: class {
        constructor(options: Record<string, unknown>) {
          receivedOptions = options;
        }
      },
    }));

    const { createDefaultDatabaseDestination } =
      await import('../../../src/commands/run-database-destination.js');

    const config: SnowflakeDestConfig = {
      dest: 'snowflake',
      account: 'acct',
      username: 'loader',
      accessToken: 'static-token',
      tokenCommand: 'mint-snowflake-token --json',
      warehouse: 'WH',
      database: 'DB',
      targetSchema: 'PUBLIC',
      bufferSize: 1,
      logFormat: 'text',
      maxConcurrentLoads: 1,
    };

    await createDefaultDatabaseDestination(config);

    expect(createTokenCommandProvider).toHaveBeenCalledWith('mint-snowflake-token --json');
    expect(receivedOptions).toMatchObject({
      account: 'acct',
      username: 'loader',
      accessToken: 'static-token',
      tokenProvider,
      warehouse: 'WH',
      database: 'DB',
      schema: 'PUBLIC',
    });
  });

  it('prefers a caller-provided provider for Snowflake destinations', async () => {
    let receivedOptions: Record<string, unknown> | undefined;
    const tokenProvider = vi.fn();

    vi.doMock('../../../src/runtime/destinations/snowflake.js', () => ({
      SnowflakeDestination: class {
        constructor(options: Record<string, unknown>) {
          receivedOptions = options;
        }
      },
    }));

    const { createDefaultDatabaseDestination } =
      await import('../../../src/commands/run-database-destination.js');

    const config: SnowflakeDestConfig = {
      dest: 'snowflake',
      account: 'acct',
      username: 'loader',
      accessToken: 'static-token',
      warehouse: 'WH',
      database: 'DB',
      targetSchema: 'PUBLIC',
      bufferSize: 1,
      logFormat: 'text',
      maxConcurrentLoads: 1,
    };

    await createDefaultDatabaseDestination(config, { tokenProvider });

    expect(receivedOptions?.tokenProvider).toBe(tokenProvider);
  });

  it('validates and forwards a trusted Snowflake query tag', async () => {
    let receivedOptions: Record<string, unknown> | undefined;
    vi.doMock('../../../src/runtime/destinations/snowflake.js', () => ({
      SnowflakeDestination: class {
        constructor(options: Record<string, unknown>) {
          receivedOptions = options;
        }
      },
    }));
    const { createDefaultDatabaseDestination } =
      await import('../../../src/commands/run-database-destination.js');
    const config: SnowflakeDestConfig = {
      dest: 'snowflake',
      account: 'acct',
      username: 'loader',
      password: 'token',
      warehouse: 'WH',
      database: 'DB',
      targetSchema: 'PUBLIC',
      bufferSize: 1,
      logFormat: 'text',
      maxConcurrentLoads: 1,
    };

    await createDefaultDatabaseDestination(config, {
      queryTag: 'custom:model-run:123',
      destinationWarehouse: 'LOAD_MEDIUM',
    });

    expect(receivedOptions?.queryTag).toBe('custom:model-run:123');
    expect(receivedOptions?.warehouse).toBe('LOAD_MEDIUM');
    await expect(
      createDefaultDatabaseDestination(config, { queryTag: 'unsafe\u0085metadata' })
    ).rejects.toThrow(/control characters/);
  });

  it('rejects a destination warehouse override for non-Snowflake configs', async () => {
    const { createDefaultDatabaseDestination } =
      await import('../../../src/commands/run-database-destination.js');
    const config = {
      dest: 'duckdb' as const,
      dbPath: ':memory:',
      targetSchema: 'main',
      bufferSize: 1,
      logFormat: 'text' as const,
      maxConcurrentLoads: 1,
    };

    await expect(
      createDefaultDatabaseDestination(config, { destinationWarehouse: 'LOAD_MEDIUM' })
    ).rejects.toThrow(/materialized Snowflake destination/);
  });
});
