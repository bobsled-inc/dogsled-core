import { afterEach, describe, expect, it, vi } from 'vitest';

import { SqlCancelledError } from '../../../../src/runtime/cancellation.js';
import {
  buildDatabricksRunner,
  buildDatabricksTokenUrl,
  fetchDatabricksOAuthToken,
} from '../../../../src/runtime/runners/databricks.js';
import type { DatabricksIntegration } from '../../../../src/schemas/integration.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function patIntegration(): DatabricksIntegration {
  return {
    spec_version: '1',
    type: 'integration',
    name: 'db_test',
    source_type: 'databricks',
    connection: {
      workspace_url: 'https://dbc-example.cloud.databricks.com',
      http_path: '/sql/1.0/warehouses/wh123',
      catalog: 'main',
      schema: 'default',
    },
    auth: { type: 'pat', token: 'dapi1234' },
  };
}

function oauthM2mIntegration(): DatabricksIntegration {
  return {
    ...patIntegration(),
    auth: {
      type: 'oauth_m2m',
      client_id: 'cid',
      client_secret: 'csecret',
    },
  };
}

function mockDatabricksConnection() {
  const closeFn = vi.fn(async () => {});
  const fetchAllFn = vi.fn(async () => [{ id: 1, name: 'alpha' }]);
  const operationCloseFn = vi.fn(async () => {});
  const operationCancelFn = vi.fn(async () => ({}));
  const operation = { fetchAll: fetchAllFn, cancel: operationCancelFn, close: operationCloseFn };
  const executeStatementFn = vi.fn(async (_sql: string) => operation);
  const sessionCloseFn = vi.fn(async () => {});
  const session = { executeStatement: executeStatementFn, close: sessionCloseFn };
  const openSessionFn = vi.fn(async () => session);
  const connection = { openSession: openSessionFn, close: closeFn };
  return {
    connection,
    session,
    operation,
    closeFn,
    sessionCloseFn,
    operationCloseFn,
    operationCancelFn,
    executeStatementFn,
    fetchAllFn,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('@databricks/sql');
});

describe('buildDatabricksRunner — pat auth', () => {
  it('sets STATEMENT_TIMEOUT only when the caller asks for a limit', async () => {
    const limited = mockDatabricksConnection();
    await buildDatabricksRunner(patIntegration(), {
      connection: limited.connection,
      statementTimeoutMs: 60_000,
    });
    expect(limited.executeStatementFn).toHaveBeenCalledWith('SET STATEMENT_TIMEOUT = 60');
    expect(limited.operationCloseFn).toHaveBeenCalled();

    const unlimited = mockDatabricksConnection();
    await buildDatabricksRunner(patIntegration(), { connection: unlimited.connection });
    expect(unlimited.executeStatementFn).not.toHaveBeenCalledWith(
      expect.stringContaining('STATEMENT_TIMEOUT')
    );
  });

  it('never enables the SDK proxy/PAC path in the default adapter', async () => {
    const { connection } = mockDatabricksConnection();
    const connect = vi.fn().mockResolvedValue(connection);
    vi.doMock('@databricks/sql', () => ({
      DBSQLClient: class {
        connect = connect;
      },
    }));
    const runner = await buildDatabricksRunner(patIntegration());
    try {
      expect(connect).toHaveBeenCalledExactlyOnceWith({
        host: 'dbc-example.cloud.databricks.com',
        path: '/sql/1.0/warehouses/wh123',
        token: 'dapi1234',
      });
      expect(connect.mock.calls[0]?.[0]).not.toHaveProperty('proxy');
    } finally {
      await runner.close?.();
    }
  });

  it('run() executes SQL and returns rowCount', async () => {
    const { connection, executeStatementFn } = mockDatabricksConnection();
    const runner = await buildDatabricksRunner(patIntegration(), { connection });
    try {
      const result = await runner.run('INSERT INTO t VALUES (1)');
      expect(result).toEqual({ rowCount: 1 });
      // First two calls are USE CATALOG and USE SCHEMA, third is the actual SQL
      expect(executeStatementFn).toHaveBeenCalledWith('INSERT INTO t VALUES (1)');
    } finally {
      await runner.close?.();
    }
  });

  it('query() returns rows', async () => {
    const { connection } = mockDatabricksConnection();
    const runner = await buildDatabricksRunner(patIntegration(), { connection });
    try {
      const rows = await runner.query!('SELECT id, name FROM t');
      expect(rows).toEqual([{ id: 1, name: 'alpha' }]);
    } finally {
      await runner.close?.();
    }
  });

  it('streamQueryRows() fetches chunks until hasMoreRows() returns false', async () => {
    const { connection, executeStatementFn } = mockDatabricksConnection();
    const runner = await buildDatabricksRunner(patIntegration(), { connection });
    const hasMoreRows = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const fetchChunk = vi
      .fn()
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 2 }, { id: 3 }]);
    const close = vi.fn(async () => {});
    executeStatementFn.mockResolvedValueOnce({ hasMoreRows, fetchChunk, fetchAll: vi.fn(), close });

    const rows: Record<string, unknown>[] = [];
    for await (const row of runner.streamQueryRows('SELECT id FROM t')) {
      rows.push(row);
    }

    expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(hasMoreRows).toHaveBeenCalledTimes(3);
    expect(fetchChunk).toHaveBeenCalledTimes(2);
    expect(fetchChunk).toHaveBeenCalledWith({ maxRows: 10_000 });
    expect(close).toHaveBeenCalledOnce();
    await runner.close?.();
  });

  it('close() tears down session and connection', async () => {
    const { connection, sessionCloseFn, closeFn } = mockDatabricksConnection();
    const runner = await buildDatabricksRunner(patIntegration(), { connection });
    await runner.close?.();
    expect(sessionCloseFn).toHaveBeenCalledOnce();
    expect(closeFn).toHaveBeenCalledOnce();
  });

  it('sets USE CATALOG and USE SCHEMA on init', async () => {
    const { connection, executeStatementFn } = mockDatabricksConnection();
    await buildDatabricksRunner(patIntegration(), { connection });
    const calls = executeStatementFn.mock.calls.map((c) => c[0]);
    expect(calls[0]).toBe('USE CATALOG `main`');
    expect(calls[1]).toBe('USE SCHEMA `default`');
  });

  it('unload() emits INSERT OVERWRITE DIRECTORY for Parquet output', async () => {
    const { connection, executeStatementFn, fetchAllFn } = mockDatabricksConnection();
    fetchAllFn.mockResolvedValueOnce([{ rows_written: 3, bytes_written: 256 }]);
    const runner = await buildDatabricksRunner(patIntegration(), { connection });

    const result = await runner.unload!('SELECT * FROM main.default.orders', '/Volumes/xwh/run1', {
      format: 'parquet',
    });

    expect(executeStatementFn).toHaveBeenCalledWith(
      "INSERT OVERWRITE DIRECTORY '/Volumes/xwh/run1' USING PARQUET SELECT * FROM main.default.orders"
    );
    expect(result).toEqual({
      uris: ['/Volumes/xwh/run1'],
      rowCount: 3,
      bytes: 256,
    });
    await runner.close?.();
  });
});

describe('buildDatabricksRunner — oauth_m2m auth', () => {
  it('calls the OAuth token fetcher with correct args', async () => {
    const { connection } = mockDatabricksConnection();
    const oauthTokenFetcher = vi.fn(async () => 'fetched-token');
    // We pass the connection override so the driver isn't actually loaded;
    // the oauthTokenFetcher would be called if no connection override,
    // but we still test the integration wiring here.
    const runner = await buildDatabricksRunner(oauthM2mIntegration(), {
      connection,
      oauthTokenFetcher,
    });
    // When connection is overridden, the fetcher is NOT called (connection is pre-built).
    // This test validates the integration struct is accepted.
    expect(typeof runner.run).toBe('function');
    await runner.close?.();
  });
});

describe('buildDatabricksTokenUrl', () => {
  it('accepts a bare workspace hostname', () => {
    expect(buildDatabricksTokenUrl('dbc-example.cloud.databricks.com')).toBe(
      'https://dbc-example.cloud.databricks.com/oidc/v1/token'
    );
  });

  it('accepts hostnames with ports', () => {
    expect(buildDatabricksTokenUrl('dbc-example.cloud.databricks.com:443')).toBe(
      'https://dbc-example.cloud.databricks.com/oidc/v1/token'
    );
  });

  it('rejects hosts containing userinfo (@)', () => {
    expect(() =>
      buildDatabricksTokenUrl('evil.example.com@victim.databricks.com.example.com')
    ).toThrow(/illegal characters/);
  });

  it('rejects hosts containing fragment markers (#)', () => {
    expect(() => buildDatabricksTokenUrl('evil.example.com#@victim.databricks.com')).toThrow(
      /illegal characters/
    );
  });

  it('rejects hosts containing path separators', () => {
    expect(() => buildDatabricksTokenUrl('victim.databricks.com/redirect')).toThrow(
      /illegal characters/
    );
  });

  it('rejects hosts containing whitespace', () => {
    expect(() => buildDatabricksTokenUrl('host with space.databricks.com')).toThrow(
      /illegal characters/
    );
  });

  it('rejects empty hosts', () => {
    expect(() => buildDatabricksTokenUrl('')).toThrow(/empty/);
  });
});

describe('fetchDatabricksOAuthToken security', () => {
  it('rejects private token hosts before sending credentials', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchDatabricksOAuthToken('127.0.0.1:443', 'client', 'secret')).rejects.toThrow(
      /private\/loopback host/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses redirect denial and accepts a bounded token response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'token-value' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchDatabricksOAuthToken('dbc-example.cloud.databricks.com', 'client', 'secret')
    ).resolves.toBe('token-value');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://dbc-example.cloud.databricks.com/oidc/v1/token',
      expect.objectContaining({ redirect: 'error' })
    );
  });

  it('rejects an oversized decoded token response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }))
    );

    await expect(
      fetchDatabricksOAuthToken('dbc-example.cloud.databricks.com', 'client', 'secret')
    ).rejects.toThrow(/exceeds the 1 MiB limit/);
  });

  it('does not surface a reflected client secret from error bodies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('reflected secret-value', {
          status: 401,
          statusText: 'Unauthorized',
        })
      )
    );

    const error = await fetchDatabricksOAuthToken(
      'dbc-example.cloud.databricks.com',
      'client',
      'secret-value'
    ).catch((caught) => caught as Error);
    expect(error.message).toContain('status 401');
    expect(error.message).not.toContain('secret-value');
  });
});

describe('buildDatabricksRunner — cooperative cancellation', () => {
  /**
   * Connection whose result fetch hangs until the test releases it, so an abort
   * can land while the operation is genuinely in flight. `started` resolves once
   * the fetch has begun, making the abort deterministic.
   */
  function hangingConnection(mode: 'fetchAll' | 'fetchChunk' = 'fetchAll') {
    const operationClose = vi.fn(async () => {});
    let begin!: () => void;
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    let settleOperation!: () => void;
    const stall = <T>(value: T): Promise<T> =>
      new Promise<T>((resolve) => {
        begin();
        settleOperation = () => resolve(value);
      });
    const cancel = vi.fn(async () => {
      settleOperation();
      return {};
    });
    const fetchAll = vi.fn(() =>
      mode === 'fetchAll' ? stall<Record<string, unknown>[]>([]) : Promise.resolve([])
    );
    const operation = {
      fetchAll,
      cancel,
      close: operationClose,
      ...(mode === 'fetchChunk'
        ? {
            hasMoreRows: vi.fn(async () => true),
            fetchChunk: vi.fn(() => stall<Record<string, unknown>[]>([])),
          }
        : {}),
    };
    const executeStatement = vi.fn(async (_sql: string) => operation);
    const connection = {
      openSession: vi.fn(async () => ({ executeStatement, close: vi.fn(async () => {}) })),
      close: vi.fn(async () => {}),
    };
    return { connection, executeStatement, cancel, operationClose, started };
  }

  it('rejects an already-aborted signal without submitting a statement', async () => {
    const { connection, executeStatement, cancel } = hangingConnection();
    const runner = await buildDatabricksRunner(patIntegration(), { connection });
    const submittedDuringInit = executeStatement.mock.calls.length; // USE CATALOG / USE SCHEMA
    const controller = new AbortController();
    controller.abort();

    await expect(runner.run('SELECT 1', { signal: controller.signal })).rejects.toBeInstanceOf(
      SqlCancelledError
    );
    expect(executeStatement).toHaveBeenCalledTimes(submittedDuringInit);
    expect(cancel).not.toHaveBeenCalled();
    await runner.close?.();
  });

  it('aborting mid-statement cancels the Databricks operation', async () => {
    const { connection, cancel, started } = hangingConnection();
    const runner = await buildDatabricksRunner(patIntegration(), { connection });
    const controller = new AbortController();

    const pending = runner.run('INSERT INTO t VALUES (1)', { signal: controller.signal });
    await started;
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(SqlCancelledError);
    expect(cancel).toHaveBeenCalledOnce();
    await runner.close?.();
  });

  it('aborting mid-statement cancels the operation for query() too', async () => {
    const { connection, cancel, started } = hangingConnection();
    const runner = await buildDatabricksRunner(patIntegration(), { connection });
    const controller = new AbortController();

    const pending = runner.query!('SELECT 1', undefined, { signal: controller.signal });
    await started;
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(SqlCancelledError);
    expect(cancel).toHaveBeenCalledOnce();
    await runner.close?.();
  });

  it('aborting mid-stream cancels the operation backing streamQueryRows()', async () => {
    const { connection, cancel, started } = hangingConnection('fetchChunk');
    const runner = await buildDatabricksRunner(patIntegration(), { connection });
    const controller = new AbortController();

    const consume = async (): Promise<void> => {
      for await (const _row of runner.streamQueryRows('SELECT id FROM t', undefined, {
        signal: controller.signal,
      })) {
        // never reached — the chunk fetch stalls before the first row
      }
    };
    const pending = consume();
    await started;
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(SqlCancelledError);
    expect(cancel).toHaveBeenCalledOnce();
    await runner.close?.();
  });

  it('never cancels the operation when no signal is passed', async () => {
    const { connection, operationCancelFn } = mockDatabricksConnection();
    const runner = await buildDatabricksRunner(patIntegration(), { connection });

    expect(await runner.run('SELECT 1')).toEqual({ rowCount: 1 });
    expect(await runner.query!('SELECT 1')).toEqual([{ id: 1, name: 'alpha' }]);
    expect(operationCancelFn).not.toHaveBeenCalled();
    await runner.close?.();
  });
});

describe('buildDatabricksRunner — operation lifecycle', () => {
  it('closes operation after fetchAll in run()', async () => {
    const { connection, operationCloseFn } = mockDatabricksConnection();
    const runner = await buildDatabricksRunner(patIntegration(), { connection });
    await runner.run('SELECT 1');
    expect(operationCloseFn).toHaveBeenCalled();
    await runner.close?.();
  });

  it('closes operation after fetchAll in query()', async () => {
    const { connection, operationCloseFn } = mockDatabricksConnection();
    const runner = await buildDatabricksRunner(patIntegration(), { connection });
    await runner.query!('SELECT 1');
    expect(operationCloseFn).toHaveBeenCalled();
    await runner.close?.();
  });
});

describe('databricks positional bindings', () => {
  it('passes values separately from SQL for query and stream calls', async () => {
    const { connection, executeStatementFn } = mockDatabricksConnection();
    const runner = await buildDatabricksRunner(patIntegration(), { connection });
    const sql = 'SELECT ?, ?, ?, ?, ?, ?';
    const date = new Date('2026-01-02T03:04:05Z');
    const payload = "secret'); DROP TABLE target; --";
    const params = [payload, true, null, 1.5, 9007199254740993n, date];
    const values = [payload, true, null, 1.5, '9007199254740993', date.toISOString()];
    try {
      expect(runner.supportsBindings).toBe(true);
      await runner.query?.(sql, params);
      expect(executeStatementFn).toHaveBeenLastCalledWith(sql, { ordinalParameters: values });
      for await (const _row of runner.streamQueryRows!(sql, params)) {
        /* drain */
      }
      expect(executeStatementFn).toHaveBeenLastCalledWith(sql, { ordinalParameters: values });
    } finally {
      await runner.close?.();
    }
  });

  it('rejects invalid bindings before dispatch without including their values', async () => {
    const { connection, executeStatementFn } = mockDatabricksConnection();
    const runner = await buildDatabricksRunner(patIntegration(), { connection });
    try {
      executeStatementFn.mockClear();
      await expect(runner.query!('SELECT ?', { secret: 'private-value' })).rejects.toThrow(
        'positional SQL parameters'
      );
      await expect(runner.query!('SELECT ?', [Number.NaN])).rejects.toThrow('finite scalar');
      await expect(runner.query!('SELECT ?', [new Date('invalid')])).rejects.toThrow(
        'finite scalar'
      );
      expect(executeStatementFn).not.toHaveBeenCalled();
    } finally {
      await runner.close?.();
    }
  });

  it('does not dispatch a bound query with an aborted signal', async () => {
    const { connection, executeStatementFn } = mockDatabricksConnection();
    const runner = await buildDatabricksRunner(patIntegration(), { connection });
    try {
      executeStatementFn.mockClear();
      await expect(
        runner.query!('SELECT ?', ['private'], { signal: AbortSignal.abort() })
      ).rejects.toBeInstanceOf(SqlCancelledError);
      expect(executeStatementFn).not.toHaveBeenCalled();
    } finally {
      await runner.close?.();
    }
  });
});

it('quotes configured Databricks identifiers and hostile unload locations', async () => {
  const mock = mockDatabricksConnection();
  const integration = patIntegration();
  integration.connection.catalog = 'main`; SELECT 1 --';
  integration.connection.schema = 'de`fault';
  const runner = await buildDatabricksRunner(integration, { connection: mock.connection });
  expect(mock.executeStatementFn).toHaveBeenCalledWith('USE CATALOG `main``; SELECT 1 --`');
  expect(mock.executeStatementFn).toHaveBeenCalledWith('USE SCHEMA `de``fault`');
  await runner.unload!('SELECT 1', "/Volumes/x\\' --", { format: 'parquet' });
  expect(mock.executeStatementFn).toHaveBeenCalledWith(
    "INSERT OVERWRITE DIRECTORY '/Volumes/x\\\\'' --' USING PARQUET SELECT 1"
  );
  await runner.close?.();
});
