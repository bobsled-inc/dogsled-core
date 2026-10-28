import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

function captureOutput(stream: PassThrough): () => string {
  let output = '';
  stream.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  return () => output;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('../../../src/runtime/destinations/postgres.js');
  vi.doUnmock('../../../src/runtime/destinations/turbopuffer.js');
  vi.doUnmock('mysql2/promise');
  vi.doUnmock('@databricks/sql');
});

describe('check command database destinations', () => {
  it('keeps Databricks check out of the SDK proxy/PAC path', async () => {
    const operation = {
      fetchAll: vi.fn().mockResolvedValue([]),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const session = {
      executeStatement: vi.fn().mockResolvedValue(operation),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const connection = {
      openSession: vi.fn().mockResolvedValue(session),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const connect = vi.fn().mockResolvedValue(connection);
    vi.doMock('@databricks/sql', () => ({
      DBSQLClient: class {
        connect = connect;
      },
    }));
    const { checkDatabricks } = await import('../../../src/commands/check.js');
    const setExitCode = vi.fn();
    await checkDatabricks(
      {
        serverHostname: 'warehouse.example.com',
        httpPath: '/sql/test',
        accessToken: 'test-token',
        catalog: 'main',
        schema: 'default',
      },
      { stderr: new PassThrough(), setExitCode }
    );
    expect(connect).toHaveBeenCalledExactlyOnceWith({
      host: 'warehouse.example.com',
      path: '/sql/test',
      token: 'test-token',
    });
    expect(connect.mock.calls[0]?.[0]).not.toHaveProperty('proxy');
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it('checkPostgres succeeds with a reachable destination', async () => {
    let receivedOptions: Record<string, unknown> | undefined;
    vi.doMock('../../../src/runtime/destinations/postgres.js', () => ({
      PostgresDestination: class {
        constructor(options: Record<string, unknown>) {
          receivedOptions = options;
        }
        async initialize(): Promise<void> {}
        async close(): Promise<void> {}
      },
    }));

    const { checkPostgres } = await import('../../../src/commands/check.js');
    const stderr = new PassThrough();
    const getOutput = captureOutput(stderr);
    let exitCode: number | undefined;

    await checkPostgres(
      {
        host: 'localhost',
        port: 5432,
        database: 'analytics',
        schema: 'public',
        username: 'postgres',
        password: 'secret',
      },
      {
        stderr,
        setExitCode: (code) => {
          exitCode = code;
        },
      }
    );

    expect(receivedOptions).toMatchObject({
      host: 'localhost',
      port: 5432,
      database: 'analytics',
      schema: 'public',
      username: 'postgres',
    });
    expect(getOutput()).toContain('Postgres: connected to localhost:5432/analytics');
    expect(exitCode).toBeUndefined();
  });

  it('checkMySql succeeds with a reachable connection', async () => {
    const execute = vi.fn().mockResolvedValue([[], []]);
    const release = vi.fn();
    const end = vi.fn().mockResolvedValue(undefined);
    const createPool = vi.fn().mockReturnValue({
      getConnection: vi.fn().mockResolvedValue({ execute, release }),
      end,
    });
    vi.doMock('mysql2/promise', () => ({ createPool }));

    const { checkMySql } = await import('../../../src/commands/check.js');
    const stderr = new PassThrough();
    const getOutput = captureOutput(stderr);
    let exitCode: number | undefined;

    await checkMySql(
      {
        host: 'localhost',
        port: 3306,
        database: 'analytics',
        user: 'mysql',
        password: 'secret',
      },
      {
        stderr,
        setExitCode: (code) => {
          exitCode = code;
        },
      }
    );

    expect(createPool).toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith('SELECT 1');
    expect(release).toHaveBeenCalled();
    expect(end).toHaveBeenCalled();
    expect(getOutput()).toContain('MySQL: database "analytics" is accessible at localhost:3306');
    expect(exitCode).toBeUndefined();
  });

  it('checkDatabricks succeeds with a reachable catalog and schema', async () => {
    const executedStatements: string[] = [];
    const operations = new Map<
      string,
      { fetchAll: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
    >();
    const makeOperation = (sql: string) => {
      const operation = {
        fetchAll: vi.fn().mockResolvedValue([]),
        close: vi.fn().mockResolvedValue(undefined),
      };
      executedStatements.push(sql);
      operations.set(sql, operation);
      return operation;
    };

    const { checkDatabricks } = await import('../../../src/commands/check.js');
    const stderr = new PassThrough();
    const getOutput = captureOutput(stderr);
    let exitCode: number | undefined;

    await checkDatabricks(
      {
        serverHostname: 'example.cloud.databricks.com',
        httpPath: '/sql/1.0/warehouses/abc123',
        accessToken: 'dapi-test-token',
        catalog: 'main',
        schema: 'analytics',
      },
      {
        stderr,
        setExitCode: (code) => {
          exitCode = code;
        },
        clientFactory: async () => ({
          connect: async () => ({
            openSession: async () => ({
              executeStatement: async (sql: string) => makeOperation(sql),
              close: async () => {},
            }),
            close: async () => {},
          }),
        }),
      }
    );

    expect(executedStatements).toEqual([
      'SELECT 1',
      'USE CATALOG `main`',
      'USE SCHEMA `analytics`',
    ]);
    for (const sql of executedStatements) {
      expect(operations.get(sql)?.fetchAll).toHaveBeenCalled();
      expect(operations.get(sql)?.close).toHaveBeenCalled();
    }
    expect(getOutput()).toContain('Databricks: catalog "main" schema "analytics" is accessible');
    expect(exitCode).toBeUndefined();
  });

  it('checkTurbopuffer succeeds with a reachable region', async () => {
    const initialize = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    let receivedOptions: Record<string, unknown> | undefined;
    vi.doMock('../../../src/runtime/destinations/turbopuffer.js', () => ({
      TurbopufferDestination: class {
        constructor(options: Record<string, unknown>) {
          receivedOptions = options;
        }
        initialize = initialize;
        close = close;
      },
    }));

    const { checkTurbopuffer } = await import('../../../src/commands/check.js');
    const stderr = new PassThrough();
    const getOutput = captureOutput(stderr);
    let exitCode: number | undefined;

    await checkTurbopuffer(
      { apiKey: 'k', region: 'gcp-us-central1' },
      {
        stderr,
        setExitCode: (code) => {
          exitCode = code;
        },
      }
    );

    expect(receivedOptions).toEqual({ apiKey: 'k', region: 'gcp-us-central1' });
    expect(initialize).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(getOutput()).toContain('Turbopuffer: authenticated in region gcp-us-central1');
    expect(exitCode).toBeUndefined();
  });
});

describe('check command option placeholders', () => {
  it('resolves $VAR and ${{ env.VAR }} values like load run', async () => {
    const { resolveOptionPlaceholders } = await import('../../../src/commands/run-cli.js');
    vi.stubEnv('CHECK_PG_PASSWORD', 'from-env');
    expect(
      resolveOptionPlaceholders({
        dest: 'postgres',
        postgresPassword: '$CHECK_PG_PASSWORD',
        sfPassword: '${{ env.CHECK_PG_PASSWORD }}',
        postgresPort: '5432',
      })
    ).toEqual({
      dest: 'postgres',
      postgresPassword: 'from-env',
      sfPassword: 'from-env',
      postgresPort: '5432',
    });
    vi.unstubAllEnvs();
  });
});
