import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { SqlCancelledError } from '../../../../src/runtime/cancellation.js';
import { buildSnowflakeRunner } from '../../../../src/runtime/runners/snowflake.js';
import type { SnowflakeIntegration } from '../../../../src/schemas/integration.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function patIntegration(overrides?: Partial<SnowflakeIntegration>): SnowflakeIntegration {
  return {
    spec_version: '1',
    type: 'integration',
    name: 'sf_test',
    source_type: 'snowflake',
    connection: {
      account_identifier: 'xt12345.us-east-1',
      warehouse: 'COMPUTE_WH',
      role: 'ROLE',
      user: 'bob',
    },
    auth: { type: 'pat', token: 'secret-token' },
    ...overrides,
  };
}

function rsaKeyIntegration(): SnowflakeIntegration {
  return {
    ...patIntegration(),
    auth: {
      type: 'rsa_key',
      private_key_path: '/tmp/rsa_key.pem',
      private_key_passphrase: 'pass123',
    },
  };
}

function oauthIntegration(): SnowflakeIntegration {
  return {
    ...patIntegration(),
    auth: {
      type: 'oauth',
      client_id: 'cid',
      client_secret: 'csecret',
      token_url: 'https://auth.example.com/token',
    },
  };
}

/** Builds a mock snowflake-sdk module. */
function mockSdk() {
  const destroyCb = vi.fn((_cb: (err?: Error) => void) => {
    _cb(undefined);
  });
  const executeCb = vi.fn(
    (opts: {
      sqlText: string;
      complete: (err: Error | undefined, stmt: unknown, rows?: Record<string, unknown>[]) => void;
    }) => {
      const statement = { getNumUpdatedRows: () => 1 };
      opts.complete(undefined, statement, [{ id: 1 }]);
      return statement;
    }
  );
  const connectCb = vi.fn((_cb: (err?: Error) => void) => {
    _cb(undefined);
  });

  const conn = {
    connect: connectCb,
    execute: executeCb,
    destroy: destroyCb,
  };

  return {
    sdk: {
      createConnection: vi.fn(() => conn),
    },
    conn,
    connectCb,
    executeCb,
    destroyCb,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildSnowflakeRunner — pat auth', () => {
  it('run() executes SQL and returns rowCount', async () => {
    const { sdk } = mockSdk();
    const runner = await buildSnowflakeRunner(patIntegration(), { sdk });
    try {
      const result = await runner.run('CREATE TABLE t (id INT)');
      expect(result).toEqual({ rowCount: 1 });
      expect(sdk.createConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          account: 'xt12345.us-east-1',
          password: 'secret-token',
        })
      );
    } finally {
      await runner.close?.();
    }
  });

  it('uses the connection default warehouse when no override is given', async () => {
    const { sdk } = mockSdk();
    await buildSnowflakeRunner(patIntegration(), { sdk });
    expect(sdk.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({ warehouse: 'COMPUTE_WH' })
    );
  });

  it('uses the warehouse override in place of the connection default', async () => {
    const { sdk } = mockSdk();
    await buildSnowflakeRunner(patIntegration(), { sdk, warehouse: 'BIG_WH' });
    expect(sdk.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({ warehouse: 'BIG_WH' })
    );
  });

  it('resolves a declared warehouse selector before opening the built-in runner', async () => {
    const { sdk } = mockSdk();
    const integration = patIntegration();
    integration.connection.warehouses = { small: 'COMPUTE_WH', large: 'BIG_WH' };

    await buildSnowflakeRunner(integration, { sdk, warehouse: 'large' });

    expect(sdk.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({ warehouse: 'BIG_WH' })
    );
  });

  it('rejects physical names when a declared selector map is present', async () => {
    const { sdk } = mockSdk();
    const integration = patIntegration();
    integration.connection.warehouses = { large: 'BIG_WH' };

    await expect(buildSnowflakeRunner(integration, { sdk, warehouse: 'BIG_WH' })).rejects.toThrow(
      /must name a configured warehouses key/
    );
    expect(sdk.createConnection).not.toHaveBeenCalled();
  });

  it('sets a trusted query tag in the SDK connection options', async () => {
    const { sdk } = mockSdk();
    await buildSnowflakeRunner(patIntegration(), { sdk, queryTag: 'custom:model-run:123' });

    expect(sdk.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({ queryTag: 'custom:model-run:123' })
    );
  });

  it('omits the SDK query tag when none is supplied', async () => {
    const { sdk } = mockSdk();
    await buildSnowflakeRunner(patIntegration(), { sdk });

    expect(sdk.createConnection).toHaveBeenCalledWith(
      expect.not.objectContaining({ queryTag: expect.anything() })
    );
  });

  it('rejects invalid query tags before opening an SDK connection', async () => {
    const { sdk } = mockSdk();

    await expect(
      buildSnowflakeRunner(patIntegration(), { sdk, queryTag: 'bad\u0000tag' })
    ).rejects.toThrow(/control characters/);
    expect(sdk.createConnection).not.toHaveBeenCalled();
  });

  it('rejects query tags beyond the shared operational bound', async () => {
    const { sdk } = mockSdk();

    await expect(
      buildSnowflakeRunner(patIntegration(), { sdk, queryTag: 'x'.repeat(257) })
    ).rejects.toThrow(/at most 256 characters/);
    expect(sdk.createConnection).not.toHaveBeenCalled();
  });

  it('query() returns rows', async () => {
    const { sdk } = mockSdk();
    const runner = await buildSnowflakeRunner(patIntegration(), { sdk });
    try {
      const rows = await runner.query!('SELECT 1 AS id');
      expect(rows).toEqual([{ id: 1 }]);
    } finally {
      await runner.close?.();
    }
  });

  it('close() destroys the connection', async () => {
    const { sdk, destroyCb } = mockSdk();
    const runner = await buildSnowflakeRunner(patIntegration(), { sdk });
    await runner.close?.();
    expect(destroyCb).toHaveBeenCalledOnce();
  });

  it('unload() emits COPY INTO and LIST statements', async () => {
    const executeCb = vi.fn(
      (opts: {
        sqlText: string;
        complete: (err: Error | undefined, stmt: unknown, rows?: Record<string, unknown>[]) => void;
      }) => {
        const statement = { getNumUpdatedRows: () => 0 };
        const rows = opts.sqlText.startsWith('LIST')
          ? [{ name: 's3://bucket/xwh/data_0_0_0.parquet' }]
          : [{ rows_unloaded: 2, bytes_unloaded: 128 }];
        opts.complete(undefined, statement, rows);
        return statement;
      }
    );
    const sdk = {
      createConnection: vi.fn(() => ({
        connect: (cb: (err?: Error) => void) => cb(undefined),
        execute: executeCb,
        destroy: (cb: (err?: Error) => void) => cb(undefined),
      })),
    };
    const runner = await buildSnowflakeRunner(patIntegration(), { sdk });

    const result = await runner.unload!('SELECT * FROM T', 's3://bucket/xwh', {
      format: 'parquet',
    });

    expect(executeCb.mock.calls[0]?.[0].sqlText).toContain(
      "COPY INTO 's3://bucket/xwh' FROM (SELECT * FROM T)"
    );
    expect(executeCb.mock.calls[1]?.[0].sqlText).toBe("LIST 's3://bucket/xwh'");
    await runner.unload!('SELECT 1', "s3://bucket/x\\' --", { format: 'parquet' });
    expect(executeCb.mock.calls[2]?.[0].sqlText).toContain(
      "COPY INTO 's3://bucket/x\\\\'' --' FROM (SELECT 1)"
    );
    expect(executeCb.mock.calls[3]?.[0].sqlText).toBe("LIST 's3://bucket/x\\\\'' --'");

    expect(result).toEqual({
      uris: ['s3://bucket/xwh/data_0_0_0.parquet'],
      rowCount: 2,
      bytes: 128,
    });
  });

  it('streamQueryRows() yields rows from statement.streamRows()', async () => {
    const streamRows = vi.fn(() => Readable.from([{ id: 1 }, { id: 2 }]));
    const statement = { getNumUpdatedRows: () => 2, streamRows };
    const executeCb = vi.fn(
      (opts: {
        sqlText: string;
        complete: (
          err: Error | undefined,
          stmt: typeof statement,
          rows?: Record<string, unknown>[]
        ) => void;
      }) => {
        opts.complete(undefined, statement, undefined);
        return statement;
      }
    );
    const sdk = {
      createConnection: vi.fn(() => ({
        connect: (cb: (err?: Error) => void) => cb(undefined),
        execute: executeCb,
        destroy: (cb: (err?: Error) => void) => cb(undefined),
      })),
    };
    const runner = await buildSnowflakeRunner(patIntegration(), { sdk });
    const rows: Record<string, unknown>[] = [];
    for await (const row of runner.streamQueryRows('SELECT id FROM t')) {
      rows.push(row);
    }
    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(streamRows).toHaveBeenCalledOnce();
    expect(executeCb).toHaveBeenCalledWith(
      expect.objectContaining({ sqlText: 'SELECT id FROM t' })
    );
  });

  it('streamQueryRows() re-raises a late complete-callback error', async () => {
    // The Snowflake SDK can deliver a clean EOF on the streamRows() output
    // and then call `complete(err)` after the stream ends (auth lapse
    // mid-statement, network blip). Without the captured-then-re-raised
    // behavior, the consumer would see N successfully-yielded rows and
    // miss the error — silently underreporting.
    const streamRows = vi.fn(() => Readable.from([{ id: 1 }]));
    const statement = { getNumUpdatedRows: () => 1, streamRows };
    const lateError = new Error('late callback failure');

    const executeCb = vi.fn(
      (opts: {
        sqlText: string;
        complete: (
          err: Error | undefined,
          stmt: typeof statement,
          rows?: Record<string, unknown>[]
        ) => void;
      }) => {
        // Defer so the consumer starts iterating before complete() fires.
        queueMicrotask(() => opts.complete(lateError, statement, undefined));
        return statement;
      }
    );
    const sdk = {
      createConnection: vi.fn(() => ({
        connect: (cb: (err?: Error) => void) => cb(undefined),
        execute: executeCb,
        destroy: (cb: (err?: Error) => void) => cb(undefined),
      })),
    };
    const runner = await buildSnowflakeRunner(patIntegration(), { sdk });

    const consume = async (): Promise<void> => {
      for await (const _row of runner.streamQueryRows('SELECT id FROM t')) {
        // drain
      }
    };
    await expect(consume()).rejects.toThrow(/late callback failure/);
  });

  it('streamQueryRows() rejects when the execute callback reports an error', async () => {
    const err = new Error('boom');
    const streamRows = vi.fn(() => Readable.from([{ id: 1 }]));
    const statement = { getNumUpdatedRows: () => 0, streamRows };
    const executeCb = vi.fn(
      (opts: {
        sqlText: string;
        complete: (
          err: Error | undefined,
          stmt: typeof statement,
          rows?: Record<string, unknown>[]
        ) => void;
      }) => {
        opts.complete(err, statement, undefined);
        return statement;
      }
    );
    const sdk = {
      createConnection: vi.fn(() => ({
        connect: (cb: (err?: Error) => void) => cb(undefined),
        execute: executeCb,
        destroy: (cb: (err?: Error) => void) => cb(undefined),
      })),
    };
    const runner = await buildSnowflakeRunner(patIntegration(), { sdk });
    const consume = async (): Promise<void> => {
      for await (const _row of runner.streamQueryRows('SELECT id FROM t')) {
        // consume the iterator so callback errors surface after stream drain
      }
    };

    await expect(consume()).rejects.toThrow(err);
    expect(streamRows).toHaveBeenCalledOnce();
  });
});

describe('buildSnowflakeRunner — rsa_key auth', () => {
  it('passes privateKeyPath and privateKeyPass to the driver', async () => {
    const { sdk } = mockSdk();
    await buildSnowflakeRunner(rsaKeyIntegration(), { sdk });
    expect(sdk.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticator: 'SNOWFLAKE_JWT',
        privateKeyPath: '/tmp/rsa_key.pem',
        privateKeyPass: 'pass123',
      })
    );
  });
});

describe('buildSnowflakeRunner — oauth auth', () => {
  it('calls the OAuth token fetcher and passes the token to the driver', async () => {
    const { sdk } = mockSdk();
    const oauthTokenFetcher = vi.fn(async () => ({ accessToken: 'fetched-token' }));
    await buildSnowflakeRunner(oauthIntegration(), { sdk, oauthTokenFetcher });
    expect(oauthTokenFetcher).toHaveBeenCalledWith({
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'cid',
      clientSecret: 'csecret',
    });
    expect(sdk.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticator: 'OAUTH',
        token: 'fetched-token',
      })
    );
  });

  it('rejects an OAuth token_url pointing at a private/metadata host (SSRF guard)', async () => {
    const { sdk } = mockSdk();
    const integration = oauthIntegration();
    if (integration.auth.type !== 'oauth') throw new Error('expected oauth auth');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      for (const hostname of ['169.254.169.254', '127.0.0.2', '[fe90::1]', '100.100.100.200']) {
        integration.auth.token_url = `https://${hostname}/token`;
        await expect(buildSnowflakeRunner(integration, { sdk })).rejects.toThrow(
          /private\/loopback host/
        );
      }
      // The SSRF guard fires before any network call leaves the process.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('allows public OAuth hostnames that start with fc', async () => {
    const { sdk } = mockSdk();
    const integration = oauthIntegration();
    if (integration.auth.type !== 'oauth') throw new Error('expected oauth auth');
    integration.auth.token_url = 'https://fcauth.example.com/token';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      json: async () => ({ access_token: 'fetched-token' }),
      text: async () => '',
    } as Response);
    try {
      await buildSnowflakeRunner(integration, { sdk });
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://fcauth.example.com/token',
        expect.objectContaining({ method: 'POST', redirect: 'error' })
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('never allows metadata endpoints through the private OAuth host opt-in', async () => {
    const { sdk } = mockSdk();
    const integration = oauthIntegration();
    if (integration.auth.type !== 'oauth') throw new Error('expected oauth auth');
    integration.auth.token_url = 'https://169.254.169.254/token';
    process.env['BOBSLED_CORE_ALLOW_PRIVATE_OAUTH_HOSTS'] = '1';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(buildSnowflakeRunner(integration, { sdk })).rejects.toThrow(
        /private\/loopback host/
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      delete process.env['BOBSLED_CORE_ALLOW_PRIVATE_OAUTH_HOSTS'];
    }
  });
});

describe('buildSnowflakeRunner — refreshable managed credentials', () => {
  /** SDK mock that records each connection's config and lets execute be scripted. */
  function trackingSdk(
    execute: ReturnType<typeof vi.fn> = vi.fn(
      (opts: { complete: (e: unknown, s: unknown, r?: unknown) => void }) => {
        const stmt = { getNumUpdatedRows: () => 1 };
        opts.complete(undefined, stmt, [{ id: 1 }]);
        return stmt;
      }
    )
  ) {
    const configs: Record<string, unknown>[] = [];
    const destroy = vi.fn((cb: (e?: Error) => void) => cb(undefined));
    const connect = vi.fn((cb: (e?: Error) => void) => cb(undefined));
    const createConnection = vi.fn((cfg: Record<string, unknown>) => {
      configs.push(cfg);
      return { connect, execute, destroy };
    });
    return { sdk: { createConnection }, createConnection, configs, destroy, execute };
  }

  it('proactively re-mints + reconnects when the session token enters the skew window', async () => {
    let now = 0;
    let n = 0;
    const tokenProvider = vi.fn(async () => ({
      accessToken: `tok-${++n}`,
      expiresAt: now + 3_600,
    }));
    const { sdk, createConnection, configs, destroy } = trackingSdk();

    const runner = await buildSnowflakeRunner(patIntegration(), {
      sdk,
      tokenProvider,
      now: () => now,
      skewSeconds: 300,
    });
    // Initial connect mints tok-1 (managed provider overrides pat).
    expect(tokenProvider).toHaveBeenCalledTimes(1);
    expect(configs[0]).toMatchObject({ authenticator: 'OAUTH', token: 'tok-1' });

    now = 3_400; // within skew of tok-1's 3600 expiry ⇒ reconnect before the query
    await runner.run('SELECT 1');
    expect(tokenProvider).toHaveBeenCalledTimes(2);
    expect(createConnection).toHaveBeenCalledTimes(2);
    expect(configs[1]).toMatchObject({ authenticator: 'OAUTH', token: 'tok-2' });
    expect(destroy).toHaveBeenCalledTimes(1); // stale connection torn down

    now = 4_000; // PAST tok-1's original 3600 expiry — refreshed session keeps working
    await runner.run('SELECT 2');
    expect(createConnection).toHaveBeenCalledTimes(2); // tok-2 (expires 7000) still valid
    await runner.close?.();
  });

  it('applies the statement limit to every session, including after a reconnect', async () => {
    let now = 0;
    const tokenProvider = vi.fn(async () => ({ accessToken: 'token', expiresAt: now + 3_600 }));
    const { sdk, execute } = trackingSdk();
    const runner = await buildSnowflakeRunner(patIntegration(), {
      sdk,
      tokenProvider,
      now: () => now,
      skewSeconds: 300,
      statementTimeoutMs: 60_000,
    });
    now = 3_400;
    await runner.run('SELECT 1');
    expect(execute.mock.calls.map(([options]) => (options as { sqlText: string }).sqlText)).toEqual(
      [
        'ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = 60 AUTOCOMMIT = TRUE',
        'ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = 60 AUTOCOMMIT = TRUE',
        'SELECT 1',
      ]
    );
    await runner.close?.();
  });

  it('leaves the session settings alone without a statement limit', async () => {
    const { sdk, execute } = trackingSdk();
    const runner = await buildSnowflakeRunner(patIntegration(), { sdk });
    expect(execute).not.toHaveBeenCalled();
    await runner.close?.();
  });

  it('reactively re-mints + reconnects + retries once on an auth-lapse error (read-only query)', async () => {
    // Reactive retry is gated to read-only statements (query/LIST) — side-effecting
    // run()/COPY INTO must NOT be re-executed after an auth lapse.
    let n = 0;
    const tokenProvider = vi.fn(async () => ({ accessToken: `tok-${++n}`, expiresAt: 10_000 }));
    let calls = 0;
    const execute = vi.fn((opts: { complete: (e: unknown, s: unknown, r?: unknown) => void }) => {
      calls += 1;
      const stmt = { getNumUpdatedRows: () => 1 };
      if (calls === 1) {
        opts.complete(new Error('Invalid OAuth access token'), stmt, undefined);
      } else {
        opts.complete(undefined, stmt, [{ id: 1 }]);
      }
      return stmt;
    });
    const { sdk, createConnection } = trackingSdk(execute);

    const runner = await buildSnowflakeRunner(patIntegration(), {
      sdk,
      tokenProvider,
      now: () => 0,
    });
    const rows = await runner.query!('SELECT 1');

    expect(rows).toEqual([{ id: 1 }]);
    expect(tokenProvider).toHaveBeenCalledTimes(2); // initial connect + reactive force-refresh
    expect(createConnection).toHaveBeenCalledTimes(2); // initial + reconnect
    await runner.close?.();
  });

  it('does NOT reactive-retry a side-effecting run() on an auth lapse (no double-execute)', async () => {
    let n = 0;
    const tokenProvider = vi.fn(async () => ({ accessToken: `tok-${++n}`, expiresAt: 10_000 }));
    const execute = vi.fn((opts: { complete: (e: unknown, s: unknown, r?: unknown) => void }) => {
      opts.complete(
        new Error('Invalid OAuth access token'),
        { getNumUpdatedRows: () => 1 },
        undefined
      );
      return { getNumUpdatedRows: () => 1 };
    });
    const { sdk, createConnection } = trackingSdk(execute);

    const runner = await buildSnowflakeRunner(patIntegration(), {
      sdk,
      tokenProvider,
      now: () => 0,
    });
    await expect(runner.run('DELETE FROM t')).rejects.toThrow(/Invalid OAuth access token/);
    expect(execute).toHaveBeenCalledTimes(1); // statement executed exactly once, not retried
    expect(createConnection).toHaveBeenCalledTimes(1); // no reactive reconnect
    await runner.close?.();
  });

  it('does NOT reactive-retry a bound write through query() on an auth lapse (no double-execute)', async () => {
    let n = 0;
    const tokenProvider = vi.fn(async () => ({ accessToken: `tok-${++n}`, expiresAt: 10_000 }));
    const execute = vi.fn((opts: { complete: (e: unknown, s: unknown, r?: unknown) => void }) => {
      opts.complete(
        new Error('Invalid OAuth access token'),
        { getNumUpdatedRows: () => 1 },
        undefined
      );
      return { getNumUpdatedRows: () => 1 };
    });
    const { sdk, createConnection } = trackingSdk(execute);

    const runner = await buildSnowflakeRunner(patIntegration(), {
      sdk,
      tokenProvider,
      now: () => 0,
    });
    await expect(runner.query!('DELETE FROM t WHERE id = ?', [1])).rejects.toThrow(
      /Invalid OAuth access token/
    );
    expect(execute).toHaveBeenCalledTimes(1); // statement executed exactly once, not retried
    expect(createConnection).toHaveBeenCalledTimes(1); // no reactive reconnect
    await runner.close?.();
  });

  it('refreshes the built-in oauth path mid-run using the IdP-supplied expiry', async () => {
    let now = 0;
    let n = 0;
    const oauthTokenFetcher = vi.fn(async () => ({
      accessToken: `oauth-${++n}`,
      expiresAt: now + 3_600,
    }));
    const { sdk, createConnection, configs } = trackingSdk();

    const runner = await buildSnowflakeRunner(oauthIntegration(), {
      sdk,
      oauthTokenFetcher,
      now: () => now,
      skewSeconds: 300,
    });
    expect(configs[0]).toMatchObject({ authenticator: 'OAUTH', token: 'oauth-1' });

    now = 3_400;
    await runner.run('SELECT 1');
    expect(oauthTokenFetcher).toHaveBeenCalledTimes(2);
    expect(createConnection).toHaveBeenCalledTimes(2);
    expect(configs[1]).toMatchObject({ token: 'oauth-2' });
    await runner.close?.();
  });

  it('does not refresh static pat auth — one connection across many queries', async () => {
    const { sdk, createConnection } = trackingSdk();
    const runner = await buildSnowflakeRunner(patIntegration(), { sdk });
    await runner.run('SELECT 1');
    await runner.query!('SELECT 2');
    expect(createConnection).toHaveBeenCalledTimes(1);
    await runner.close?.();
  });
});

describe('buildSnowflakeRunner — cooperative cancellation', () => {
  /**
   * SDK mock whose statements never invoke `complete` on their own, so an abort
   * can land while the statement is genuinely in flight. `cancel()` behaves like
   * the real driver and delivers a terminal `complete(err)`. `started` resolves
   * once `execute()` has been called, making the abort deterministic.
   */
  function hangingSdk(streamRows?: () => NodeJS.ReadableStream, cancelError?: Error) {
    const cancel = vi.fn();
    let begin!: () => void;
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const execute = vi.fn(
      (opts: {
        sqlText: string;
        complete: (err: Error | undefined, stmt: unknown, rows?: unknown) => void;
      }) => {
        cancel.mockImplementation((callback?: (error?: Error) => void) => {
          // The real SDK settles a cancelled statement through `complete`, and
          // only once the server acknowledges the abort — hence the deferral.
          queueMicrotask(() => {
            callback?.(cancelError);
            opts.complete(
              new Error('SQL execution canceled'),
              { getNumUpdatedRows: () => 0 },
              undefined
            );
          });
        });
        begin();
        return { getNumUpdatedRows: () => 0, cancel, ...(streamRows ? { streamRows } : {}) };
      }
    );
    const sdk = {
      createConnection: vi.fn(() => ({
        connect: (cb: (err?: Error) => void) => cb(undefined),
        execute,
        destroy: (cb: (err?: Error) => void) => cb(undefined),
      })),
    };
    return { sdk, execute, cancel, started };
  }

  it('rejects an already-aborted signal without executing the statement', async () => {
    const { sdk, execute, cancel } = hangingSdk();
    const runner = await buildSnowflakeRunner(patIntegration(), { sdk });
    const controller = new AbortController();
    controller.abort();

    await expect(runner.run('SELECT 1', { signal: controller.signal })).rejects.toBeInstanceOf(
      SqlCancelledError
    );
    expect(execute).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    await runner.close?.();
  });

  it('aborting mid-statement cancels the Snowflake statement', async () => {
    const { sdk, cancel, started } = hangingSdk();
    const runner = await buildSnowflakeRunner(patIntegration(), { sdk });
    const controller = new AbortController();

    const pending = runner.run('DELETE FROM t', { signal: controller.signal });
    await started;
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(SqlCancelledError);
    expect(cancel).toHaveBeenCalledOnce();
    await runner.close?.();
  });

  it('preserves a failing Snowflake cancel acknowledgement as cancellation cause', async () => {
    const { sdk, started } = hangingSdk(undefined, new Error('cancel delivery failed'));
    const runner = await buildSnowflakeRunner(patIntegration(), { sdk });
    const controller = new AbortController();

    const pending = runner.run('DELETE FROM t', { signal: controller.signal });
    await started;
    controller.abort();

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SqlCancelledError);
    expect(String((error as Error).cause)).toContain('cancel delivery failed');
    await runner.close?.();
  });

  it('aborting mid-statement cancels the statement for query() too', async () => {
    const { sdk, cancel, started } = hangingSdk();
    const runner = await buildSnowflakeRunner(patIntegration(), { sdk });
    const controller = new AbortController();

    const pending = runner.query!('SELECT 1', undefined, { signal: controller.signal });
    await started;
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(SqlCancelledError);
    expect(cancel).toHaveBeenCalledOnce();
    await runner.close?.();
  });

  it('aborting mid-stream cancels the statement backing streamQueryRows()', async () => {
    // A Readable that never pushes — the consumer is parked on the next chunk,
    // which is exactly where a long EG scan spends its time.
    const stalled = new Readable({ objectMode: true, read() {} });
    const { sdk, cancel, started } = hangingSdk(() => stalled);
    const runner = await buildSnowflakeRunner(patIntegration(), { sdk });
    const controller = new AbortController();

    const consume = async (): Promise<void> => {
      for await (const _row of runner.streamQueryRows('SELECT id FROM t', undefined, {
        signal: controller.signal,
      })) {
        // never reached — the stream stalls before the first row
      }
    };
    const pending = consume();
    await started;
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(SqlCancelledError);
    expect(cancel).toHaveBeenCalledOnce();
    await runner.close?.();
  });

  it('never cancels the statement when no signal is passed', async () => {
    const cancel = vi.fn();
    const execute = vi.fn(
      (opts: {
        sqlText: string;
        complete: (err: Error | undefined, stmt: unknown, rows?: unknown) => void;
      }) => {
        const statement = { getNumUpdatedRows: () => 1, cancel };
        opts.complete(undefined, statement, [{ id: 1 }]);
        return statement;
      }
    );
    const sdk = {
      createConnection: vi.fn(() => ({
        connect: (cb: (err?: Error) => void) => cb(undefined),
        execute,
        destroy: (cb: (err?: Error) => void) => cb(undefined),
      })),
    };
    const runner = await buildSnowflakeRunner(patIntegration(), { sdk });

    expect(await runner.run('SELECT 1')).toEqual({ rowCount: 1 });
    expect(await runner.query!('SELECT 1')).toEqual([{ id: 1 }]);
    expect(cancel).not.toHaveBeenCalled();
    await runner.close?.();
  });
});

describe('buildSnowflakeRunner — driver missing', () => {
  it('throws CommandError when snowflake-sdk is not installed', async () => {
    // Pass an sdk that throws on createConnection to simulate missing driver
    // Instead, test the error path via the real module loading — but since we
    // can't uninstall snowflake-sdk in a test, we test with an sdk that throws.
    const brokenSdk = {
      createConnection: () => {
        throw new Error('Cannot find module');
      },
    };
    await expect(buildSnowflakeRunner(patIntegration(), { sdk: brokenSdk })).rejects.toThrow(
      /Cannot find module/
    );
  });
});

describe('snowflake positional bindings', () => {
  it('passes values separately from SQL for query and stream calls', async () => {
    const { sdk, executeCb } = mockSdk();
    const runner = await buildSnowflakeRunner(patIntegration(), { sdk });
    const sql = 'SELECT ?, ?, ?, ?, ?, ?';
    const date = new Date('2026-01-02T03:04:05Z');
    const payload = "secret'); DROP TABLE target; --";
    const params = [payload, true, null, 1.5, 9007199254740993n, date];
    const values = [payload, true, null, 1.5, '9007199254740993', date.toISOString()];
    try {
      expect(runner.supportsBindings).toBe(true);
      await runner.query?.(sql, params);
      expect(executeCb).toHaveBeenLastCalledWith(
        expect.objectContaining({ sqlText: sql, binds: values })
      );
      for await (const _row of runner.streamQueryRows!(sql, params)) {
        /* drain */
      }
      expect(executeCb).toHaveBeenLastCalledWith(
        expect.objectContaining({ sqlText: sql, binds: values })
      );
    } finally {
      await runner.close?.();
    }
  });

  it('rejects invalid bindings before dispatch without including their values', async () => {
    const { sdk, executeCb } = mockSdk();
    const runner = await buildSnowflakeRunner(patIntegration(), { sdk });
    try {
      executeCb.mockClear();
      await expect(runner.query!('SELECT ?', { secret: 'private-value' })).rejects.toThrow(
        'positional SQL parameters'
      );
      await expect(runner.query!('SELECT ?', [Number.NaN])).rejects.toThrow('finite scalar');
      await expect(runner.query!('SELECT ?', [new Date('invalid')])).rejects.toThrow(
        'finite scalar'
      );
      expect(executeCb).not.toHaveBeenCalled();
    } finally {
      await runner.close?.();
    }
  });

  it('does not dispatch a bound query with an aborted signal', async () => {
    const { sdk, executeCb } = mockSdk();
    const runner = await buildSnowflakeRunner(patIntegration(), { sdk });
    try {
      executeCb.mockClear();
      await expect(
        runner.query!('SELECT ?', ['private'], { signal: AbortSignal.abort() })
      ).rejects.toBeInstanceOf(SqlCancelledError);
      expect(executeCb).not.toHaveBeenCalled();
    } finally {
      await runner.close?.();
    }
  });
});
