import { describe, expect, it, vi } from 'vitest';

import { SqlCancelledError } from '../../../../src/runtime/cancellation.js';
import { buildPostgresRunner } from '../../../../src/runtime/runners/postgres.js';
import type { PostgresIntegration } from '../../../../src/schemas/integration.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function passwordIntegration(overrides?: Partial<PostgresIntegration>): PostgresIntegration {
  return {
    spec_version: '1',
    type: 'integration',
    name: 'pg_test',
    source_type: 'postgres',
    connection: {
      host: 'localhost',
      port: 5432,
      database: 'testdb',
    },
    auth: { type: 'password', user: 'bob', password: 's3cret' },
    ...overrides,
  };
}

function iamIntegration(): PostgresIntegration {
  return {
    ...passwordIntegration(),
    connection: {
      ...passwordIntegration().connection,
      host: 'example.cluster.us-east-1.rds.amazonaws.com',
    },
    auth: { type: 'iam', user: 'iam_user', region: 'us-east-1' },
  };
}

function mockPgClient() {
  const queryFn = vi.fn(async (_sql: string) => ({
    rows: [{ id: 1, name: 'alpha' }] as Record<string, unknown>[],
    rowCount: 1 as number | null,
  }));
  const connectFn = vi.fn(async () => {});
  const endFn = vi.fn(async () => {});
  return {
    client: { connect: connectFn, query: queryFn, end: endFn },
    connectFn,
    queryFn,
    endFn,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildPostgresRunner — password auth', () => {
  it('run() executes SQL and returns rowCount', async () => {
    const { client } = mockPgClient();
    const runner = await buildPostgresRunner(passwordIntegration(), { client });
    try {
      const result = await runner.run('INSERT INTO t VALUES (1)');
      expect(result).toEqual({ rowCount: 1 });
      expect(client.query).toHaveBeenCalledWith('INSERT INTO t VALUES (1)');
    } finally {
      await runner.close?.();
    }
  });

  it('query() returns rows', async () => {
    const { client } = mockPgClient();
    const runner = await buildPostgresRunner(passwordIntegration(), { client });
    try {
      const rows = await runner.query!('SELECT id, name FROM t');
      expect(rows).toEqual([{ id: 1, name: 'alpha' }]);
    } finally {
      await runner.close?.();
    }
  });

  it('query() passes positional bindings to pg', async () => {
    const { client, queryFn } = mockPgClient();
    const runner = await buildPostgresRunner(passwordIntegration(), { client });
    try {
      await runner.query!('SELECT * FROM t WHERE id = $1', [123]);
      expect(queryFn).toHaveBeenCalledWith('SELECT * FROM t WHERE id = $1', [123]);
      expect(runner.supportsBindings).toBe(true);
    } finally {
      await runner.close?.();
    }
  });

  it('close() ends the client connection', async () => {
    const { client, endFn } = mockPgClient();
    const runner = await buildPostgresRunner(passwordIntegration(), { client });
    await runner.close?.();
    expect(endFn).toHaveBeenCalledOnce();
  });

  it('run() returns empty result when rowCount is null', async () => {
    const { client } = mockPgClient();
    client.query.mockResolvedValueOnce({ rows: [], rowCount: null });
    const runner = await buildPostgresRunner(passwordIntegration(), { client });
    const result = await runner.run('CREATE TABLE t (id INT)');
    expect(result).toEqual({});
  });

  it('sets search_path when schema is configured', async () => {
    const { client, queryFn } = mockPgClient();
    const integration = passwordIntegration({
      connection: {
        host: 'localhost',
        port: 5432,
        database: 'testdb',
        schema: 'my_schema',
      },
    });
    await buildPostgresRunner(integration, { client });
    expect(queryFn).toHaveBeenCalledWith('SET search_path TO "my_schema"');
  });
});

describe('buildPostgresRunner — cooperative cancellation', () => {
  /**
   * Primary client whose query hangs until the test releases it, plus a fake side
   * client so the `pg_cancel_backend` round-trip is observable without a live
   * server. `started` resolves once the hanging query has begun; `sideClosed`
   * resolves once the cancel path has finished with its side connection.
   */
  function cancellableClients() {
    let begin!: () => void;
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    let releasePrimary!: () => void;
    const queryFn = vi.fn(
      (_sql: string, _values?: readonly unknown[]) =>
        new Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>((resolve) => {
          begin();
          releasePrimary = () => resolve({ rows: [], rowCount: null });
        })
    );
    const client = {
      connect: vi.fn(async () => {}),
      query: queryFn,
      end: vi.fn(async () => {}),
      // Populated by pg on connect from the server's BackendKeyData message.
      processID: 4242,
    };

    let closed!: () => void;
    const sideClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const sideQuery = vi.fn(async () => {
      releasePrimary();
      return { rows: [{ pg_cancel_backend: true }], rowCount: 1 };
    });
    const sideClient = {
      connect: vi.fn(async () => {}),
      query: sideQuery,
      end: vi.fn(async () => {
        closed();
      }),
    };
    const createSideClient = vi.fn(() => sideClient);
    return {
      client,
      queryFn,
      sideClient,
      sideQuery,
      createSideClient,
      started,
      sideClosed,
      releasePrimary: () => releasePrimary(),
    };
  }

  it('rejects an already-aborted signal without sending the statement', async () => {
    const { client, queryFn, createSideClient } = cancellableClients();
    const runner = await buildPostgresRunner(passwordIntegration(), { client, createSideClient });
    const controller = new AbortController();
    controller.abort();

    await expect(runner.run('SELECT 1', { signal: controller.signal })).rejects.toBeInstanceOf(
      SqlCancelledError
    );
    expect(queryFn).not.toHaveBeenCalled();
    expect(createSideClient).not.toHaveBeenCalled();
  });

  it('does not create a side client when the backend process id is unavailable', async () => {
    const { client, queryFn, createSideClient, started, releasePrimary } = cancellableClients();
    delete client.processID;
    const runner = await buildPostgresRunner(passwordIntegration(), { client, createSideClient });
    const controller = new AbortController();

    const pending = runner.run('DELETE FROM t', { signal: controller.signal });
    await started;
    controller.abort();
    await vi.waitFor(() => expect(client.end).toHaveBeenCalledOnce());
    releasePrimary();

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SqlCancelledError);
    expect(String((error as Error).cause)).toContain('did not expose');
    expect(createSideClient).not.toHaveBeenCalled();
    expect(queryFn).toHaveBeenCalledOnce();
  });

  it('aborting mid-statement cancels the backend via pg_cancel_backend on a side connection', async () => {
    const { client, sideClient, sideQuery, createSideClient, started, sideClosed } =
      cancellableClients();
    const runner = await buildPostgresRunner(passwordIntegration(), { client, createSideClient });
    const controller = new AbortController();

    const pending = runner.run('DELETE FROM t', { signal: controller.signal });
    await started;
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(SqlCancelledError);
    await sideClosed;
    expect(createSideClient).toHaveBeenCalledOnce();
    expect(sideClient.connect).toHaveBeenCalledOnce();
    expect(sideQuery).toHaveBeenCalledWith('SELECT pg_cancel_backend($1)', [4242]);
    // The side socket is always released, even on the cancel path.
    expect(sideClient.end).toHaveBeenCalledOnce();
  });

  it('aborting mid-statement cancels the backend for query() too', async () => {
    const { client, sideQuery, createSideClient, started, sideClosed } = cancellableClients();
    const runner = await buildPostgresRunner(passwordIntegration(), { client, createSideClient });
    const controller = new AbortController();

    const pending = runner.query!('SELECT id FROM t', undefined, { signal: controller.signal });
    await started;
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(SqlCancelledError);
    await sideClosed;
    expect(sideQuery).toHaveBeenCalledWith('SELECT pg_cancel_backend($1)', [4242]);
  });

  it('waits for an injected uncancellable operation to settle before returning cancellation', async () => {
    // An injected client carries no connection config to clone, so the runner
    // terminates that primary client as its fail-closed fallback. The mock
    // deliberately does not settle on end(), proving the public promise still
    // waits for the active operation too.
    const { client, started, releasePrimary } = cancellableClients();
    const runner = await buildPostgresRunner(passwordIntegration(), { client });
    const controller = new AbortController();

    const pending = runner.run('DELETE FROM t', { signal: controller.signal });
    await started;
    controller.abort();

    let settled = false;
    void pending
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    await Promise.resolve();
    expect(settled).toBe(false);

    releasePrimary();
    await expect(pending).rejects.toBeInstanceOf(SqlCancelledError);
  });

  it('terminates the primary connection when pg_cancel_backend returns false', async () => {
    const { client, sideQuery, createSideClient, started, releasePrimary } = cancellableClients();
    sideQuery.mockImplementationOnce(async () => ({
      rows: [{ pg_cancel_backend: false }],
      rowCount: 1,
    }));
    const runner = await buildPostgresRunner(passwordIntegration(), { client, createSideClient });
    const controller = new AbortController();

    const pending = runner.run('DELETE FROM t', { signal: controller.signal });
    await started;
    controller.abort();
    await vi.waitFor(() => expect(client.end).toHaveBeenCalledOnce());
    releasePrimary();

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SqlCancelledError);
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(String((error as Error).cause)).toContain('rejected the cancellation request');
  });

  it('terminates the primary connection and preserves a side-channel cancellation error', async () => {
    const { client, sideQuery, createSideClient, started, releasePrimary } = cancellableClients();
    sideQuery.mockRejectedValueOnce(new Error('cancel permission denied'));
    const runner = await buildPostgresRunner(passwordIntegration(), { client, createSideClient });
    const controller = new AbortController();

    const pending = runner.run('DELETE FROM t', { signal: controller.signal });
    await started;
    controller.abort();
    await vi.waitFor(() => expect(client.end).toHaveBeenCalledOnce());
    releasePrimary();

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SqlCancelledError);
    expect(String((error as Error).cause)).toContain('cancel permission denied');
  });

  it('never opens a side connection when no signal is passed', async () => {
    const { client } = mockPgClient();
    const createSideClient = vi.fn(() => client);
    const runner = await buildPostgresRunner(passwordIntegration(), { client, createSideClient });

    expect(await runner.run('SELECT 1')).toEqual({ rowCount: 1 });
    expect(await runner.query!('SELECT 1')).toEqual([{ id: 1, name: 'alpha' }]);
    expect(createSideClient).not.toHaveBeenCalled();
    await runner.close?.();
  });
});

describe('buildPostgresRunner — iam auth', () => {
  it('integration object is accepted (iam auth wiring tested via mock client)', async () => {
    // IAM auth requires @aws-sdk/rds-signer at runtime, which we can't mock
    // cleanly without vi.mock. Instead we verify the mock-client path works.
    const { client } = mockPgClient();
    const runner = await buildPostgresRunner(iamIntegration(), { client });
    const result = await runner.run('SELECT 1');
    expect(result).toEqual({ rowCount: 1 });
    await runner.close?.();
  });
});

it.each(['example.com', 'example.rds.amazonaws.com.example.com', '127.0.0.1'])(
  'rejects ambient IAM credentials for custom host %s',
  async (host) => {
    const integration = iamIntegration();
    integration.connection.host = host;
    await expect(buildPostgresRunner(integration)).rejects.toThrow(
      'Postgres IAM authentication requires an AWS RDS endpoint'
    );
  }
);
