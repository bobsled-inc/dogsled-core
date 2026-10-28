import { describe, expect, it, vi } from 'vitest';

import { SnowflakeDestination } from '../../../src/runtime/destinations/snowflake.js';

function makeDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeConn() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue({
      getRows: () => [],
      getAffectedRows: () => 3,
      getColumns: () => [],
    }),
    uploadFile: vi.fn().mockResolvedValue({ status: 'UPLOADED' }),
    isClosed: vi.fn().mockReturnValue(false),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SnowflakeDestination — OAuth path', () => {
  it('fetches access token at initialize() and passes it to the connection factory', async () => {
    const tokenFetcher = vi.fn().mockResolvedValue({
      accessToken: 'access-abc',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const connectionFactory = vi.fn().mockReturnValue({
      connect: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn(),
      uploadFile: vi.fn(),
      isClosed: vi.fn().mockReturnValue(false),
      destroy: vi.fn().mockResolvedValue(undefined),
    });

    const dest = new SnowflakeDestination({
      account: 'acct',
      username: 'svc_user',
      authenticator: 'OAUTH',
      oauthClientId: 'cid',
      oauthClientSecret: 'csecret',
      oauthTokenUrl: 'https://example.com/oauth/token',
      oauthTokenFetcher: tokenFetcher,
      warehouse: 'WH',
      database: 'DB',
      schema: 'PUBLIC',
      connectionFactory,
    });

    await dest.initialize();

    expect(tokenFetcher).toHaveBeenCalledWith({
      tokenUrl: 'https://example.com/oauth/token',
      clientId: 'cid',
      clientSecret: 'csecret',
    });
    const connArgs = connectionFactory.mock.calls[0]![0];
    expect(connArgs).toMatchObject({
      account: 'acct',
      username: 'svc_user',
      authenticator: 'OAUTH',
      token: 'access-abc',
      warehouse: 'WH',
      database: 'DB',
      schema: 'PUBLIC',
    });
  });

  it('uses a static accessToken as Snowflake OAUTH without calling the oauth fetcher', async () => {
    const tokenFetcher = vi.fn();
    const connectionFactory = vi.fn().mockReturnValue({
      connect: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn(),
      uploadFile: vi.fn(),
      isClosed: vi.fn().mockReturnValue(false),
      destroy: vi.fn().mockResolvedValue(undefined),
    });

    const dest = new SnowflakeDestination({
      account: 'acct',
      username: 'svc_user',
      accessToken: 'static-oidc-token',
      oauthTokenFetcher: tokenFetcher,
      warehouse: 'WH',
      database: 'DB',
      schema: 'PUBLIC',
      connectionFactory,
    });

    await dest.initialize();

    expect(tokenFetcher).not.toHaveBeenCalled();
    expect(connectionFactory.mock.calls[0]![0]).toMatchObject({
      authenticator: 'OAUTH',
      token: 'static-oidc-token',
    });
  });

  it('prefers tokenProvider over a static accessToken when both are supplied', async () => {
    const tokenProvider = vi
      .fn()
      .mockResolvedValue({ accessToken: 'provider-token', expiresAt: 9_999_999_999 });
    const connectionFactory = vi.fn().mockReturnValue({
      connect: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn(),
      uploadFile: vi.fn(),
      isClosed: vi.fn().mockReturnValue(false),
      destroy: vi.fn().mockResolvedValue(undefined),
    });

    const dest = new SnowflakeDestination({
      account: 'acct',
      username: 'svc_user',
      accessToken: 'static-oidc-token',
      tokenProvider,
      warehouse: 'WH',
      database: 'DB',
      schema: 'PUBLIC',
      connectionFactory,
    });

    await dest.initialize();

    expect(tokenProvider).toHaveBeenCalledTimes(1);
    expect(connectionFactory.mock.calls[0]![0]).toMatchObject({
      authenticator: 'OAUTH',
      token: 'provider-token',
    });
    expect(connectionFactory.mock.calls[0]![0].token).not.toBe('static-oidc-token');
  });

  it('does not call the token fetcher when authenticator is not OAUTH', async () => {
    const tokenFetcher = vi.fn();
    const connectionFactory = vi.fn().mockReturnValue({
      connect: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn(),
      uploadFile: vi.fn(),
      isClosed: vi.fn().mockReturnValue(false),
      destroy: vi.fn().mockResolvedValue(undefined),
    });

    const dest = new SnowflakeDestination({
      account: 'acct',
      username: 'svc_user',
      password: 'pat-token',
      oauthTokenFetcher: tokenFetcher,
      warehouse: 'WH',
      database: 'DB',
      schema: 'PUBLIC',
      connectionFactory,
    });

    await dest.initialize();

    expect(tokenFetcher).not.toHaveBeenCalled();
    const connArgs = connectionFactory.mock.calls[0]![0];
    expect(connArgs.authenticator).toBeUndefined();
    expect(connArgs.token).toBeUndefined();
    expect(connArgs.password).toBe('pat-token');
  });

  it('refreshes the OAuth token and reconnects mid-run when it is near expiry', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const tokenFetcher = vi
      .fn()
      .mockResolvedValueOnce({ accessToken: 'expired', expiresAt: nowSec - 1 })
      .mockResolvedValueOnce({ accessToken: 'fresh', expiresAt: nowSec + 3_600 });
    const firstConn = makeConn();
    const secondConn = makeConn();
    const conns = [firstConn, secondConn];
    const connectionFactory = vi.fn().mockImplementation(() => conns.shift());

    const dest = new SnowflakeDestination({
      account: 'acct',
      username: 'svc_user',
      authenticator: 'OAUTH',
      oauthClientId: 'cid',
      oauthClientSecret: 'csecret',
      oauthTokenUrl: 'https://example.com/oauth/token',
      oauthTokenFetcher: tokenFetcher,
      warehouse: 'LOAD_MEDIUM',
      database: 'DB',
      schema: 'PUBLIC',
      queryTag: 'managed:run-42',
      connectionFactory,
    });

    await dest.initialize();
    const result = await dest.loadAndFinalize(
      'PUBLIC',
      'tbl',
      '/tmp/data.jsonl',
      [{ name: 'id', type: 'integer' }],
      'append',
      []
    );

    expect(tokenFetcher).toHaveBeenCalledTimes(2);
    expect(connectionFactory).toHaveBeenCalledTimes(2);
    expect(connectionFactory.mock.calls[1]![0].token).toBe('fresh');
    for (const [config] of connectionFactory.mock.calls) {
      expect(config).toMatchObject({
        warehouse: 'LOAD_MEDIUM',
        queryTag: 'managed:run-42',
      });
    }
    expect(firstConn.destroy).toHaveBeenCalledTimes(1);
    expect(result.rowsAffected).toBe(3);
  });

  it('does not reconnect when the OAuth token is still comfortably valid', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const tokenFetcher = vi
      .fn()
      .mockResolvedValue({ accessToken: 'valid', expiresAt: nowSec + 3_600 });
    const conns = [makeConn(), makeConn()];
    const connectionFactory = vi.fn().mockImplementation(() => conns.shift());

    const dest = new SnowflakeDestination({
      account: 'acct',
      username: 'svc_user',
      authenticator: 'OAUTH',
      oauthClientId: 'cid',
      oauthClientSecret: 'csecret',
      oauthTokenUrl: 'https://example.com/oauth/token',
      oauthTokenFetcher: tokenFetcher,
      warehouse: 'WH',
      database: 'DB',
      schema: 'PUBLIC',
      connectionFactory,
    });

    await dest.initialize();
    await dest.loadAndFinalize(
      'PUBLIC',
      'tbl',
      '/tmp/data.jsonl',
      [{ name: 'id', type: 'integer' }],
      'append',
      []
    );

    expect(tokenFetcher).toHaveBeenCalledTimes(1);
    expect(connectionFactory).toHaveBeenCalledTimes(1);
  });

  it('refreshes and reacquires the connection between URI loads', async () => {
    let now = 0;
    const tokenProvider = vi
      .fn()
      .mockResolvedValueOnce({ accessToken: 'initial', expiresAt: 3_600 })
      .mockResolvedValueOnce({ accessToken: 'refreshed', expiresAt: 7_000 });
    const firstConn = makeConn();
    const secondConn = makeConn();
    firstConn.execute.mockImplementation(async ({ sqlText }: { sqlText: string }) => {
      if (sqlText.includes('COPY INTO')) now = 3_400;
      return {
        getRows: () => [],
        getAffectedRows: () => 3,
        getColumns: () => [],
      };
    });
    const connectionFactory = vi
      .fn()
      .mockReturnValueOnce(firstConn)
      .mockReturnValueOnce(secondConn);

    const dest = new SnowflakeDestination({
      account: 'acct',
      username: 'svc_user',
      tokenProvider,
      now: () => now,
      skewSeconds: 300,
      warehouse: 'WH',
      database: 'DB',
      schema: 'PUBLIC',
      connectionFactory,
    });

    await dest.initialize();
    const result = await dest.loadFromUri(
      'PUBLIC',
      'tbl',
      ['s3://stage/part-0.parquet', 's3://stage/part-1.parquet'],
      [{ name: 'id', type: 'integer' }]
    );

    expect(result.rowsAffected).toBe(6);
    expect(tokenProvider).toHaveBeenCalledTimes(2);
    expect(connectionFactory).toHaveBeenCalledTimes(2);
    expect(connectionFactory.mock.calls[1]![0].token).toBe('refreshed');
    expect(firstConn.destroy).toHaveBeenCalledTimes(1);
    expect(secondConn.execute).toHaveBeenCalledWith(
      expect.objectContaining({ sqlText: expect.stringContaining('part-1.parquet') })
    );
  });

  it('errors clearly when OAuth fields are incomplete', async () => {
    const dest = new SnowflakeDestination({
      account: 'acct',
      username: 'u',
      authenticator: 'OAUTH',
      oauthClientId: 'cid',
      warehouse: 'W',
      database: 'D',
      schema: 'S',
      connectionFactory: vi.fn(),
    });

    await expect(dest.initialize()).rejects.toThrow(
      /oauthClientId.*oauthClientSecret.*oauthTokenUrl/
    );
  });

  it('redacts the active Snowflake token from connection errors', async () => {
    const connectionFactory = vi.fn().mockReturnValue({
      connect: vi
        .fn()
        .mockRejectedValue(new Error('Snowflake rejected token static-oidc-token during connect')),
      execute: vi.fn(),
      uploadFile: vi.fn(),
      isClosed: vi.fn().mockReturnValue(false),
      destroy: vi.fn().mockResolvedValue(undefined),
    });

    const dest = new SnowflakeDestination({
      account: 'acct',
      username: 'svc_user',
      accessToken: 'static-oidc-token',
      warehouse: 'WH',
      database: 'DB',
      schema: 'PUBLIC',
      connectionFactory,
    });

    await expect(dest.initialize()).rejects.toThrow(
      /Snowflake rejected token \[REDACTED\] during connect/
    );
    await dest.initialize().catch((error: Error) => {
      expect(error.message).not.toContain('static-oidc-token');
    });
  });

  it('redacts the active Snowflake token from synchronous factory errors', async () => {
    const connectionFactory = vi.fn(() => {
      throw new Error('factory received static-oidc-token');
    });

    const dest = new SnowflakeDestination({
      account: 'acct',
      username: 'svc_user',
      accessToken: 'static-oidc-token',
      warehouse: 'WH',
      database: 'DB',
      schema: 'PUBLIC',
      connectionFactory,
    });

    await expect(dest.initialize()).rejects.toThrow(/factory received \[REDACTED\]/);
  });

  it('cancels safely before creating the initial connection when tokenProvider is still resolving', async () => {
    const deferred = makeDeferred<{ accessToken: string; expiresAt: number }>();
    const tokenProvider = vi.fn().mockReturnValue(deferred.promise);
    const connectionFactory = vi.fn();

    const dest = new SnowflakeDestination({
      account: 'acct',
      username: 'svc_user',
      tokenProvider,
      warehouse: 'WH',
      database: 'DB',
      schema: 'PUBLIC',
      connectionFactory,
    });

    const initializePromise = dest.initialize();
    await Promise.resolve();
    await dest.cancel();
    deferred.resolve({ accessToken: 'provider-token', expiresAt: 9_999_999_999 });

    await expect(initializePromise).rejects.toThrow(/operation cancelled/i);
    expect(connectionFactory).not.toHaveBeenCalled();
  });

  it('cancels safely during token refresh before creating a replacement connection', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const refreshDeferred = makeDeferred<{ accessToken: string; expiresAt: number }>();
    const tokenProvider = vi
      .fn()
      .mockResolvedValueOnce({ accessToken: 'stale', expiresAt: nowSec - 1 })
      .mockReturnValueOnce(refreshDeferred.promise);
    const existingConn = makeConn();
    const connectionFactory = vi.fn().mockImplementation(() => existingConn);

    const dest = new SnowflakeDestination({
      account: 'acct',
      username: 'svc_user',
      tokenProvider,
      warehouse: 'WH',
      database: 'DB',
      schema: 'PUBLIC',
      connectionFactory,
    });

    await dest.initialize();
    const loadPromise = dest.loadAndFinalize(
      'PUBLIC',
      'tbl',
      '/tmp/data.jsonl',
      [{ name: 'id', type: 'integer' }],
      'append',
      []
    );
    await Promise.resolve();
    await dest.cancel();
    refreshDeferred.resolve({ accessToken: 'fresh', expiresAt: nowSec + 3_600 });

    await expect(loadPromise).rejects.toThrow(/operation cancelled/i);
    expect(connectionFactory).toHaveBeenCalledTimes(1);
  });
});
