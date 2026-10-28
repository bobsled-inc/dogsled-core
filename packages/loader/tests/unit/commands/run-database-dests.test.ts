import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BufferingWritable } from '../../helpers/stream.js';

function buildSchemaLine(stream: string): string {
  return JSON.stringify({
    _v: 1,
    type: 'SCHEMA',
    stream,
    schema: {
      columns: [{ name: 'id', type: 'integer' }],
    },
    key_properties: [],
    load_strategy: 'append',
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('../../../src/runtime/destinations/mysql.js');
  vi.doUnmock('../../../src/runtime/destinations/databricks.js');
  vi.doUnmock('../../../src/runtime/destinations/turbopuffer.js');
});

describe('runDatabaseLoader destination selection', () => {
  it('creates and runs the MySQL destination when --dest mysql is used', async () => {
    let receivedOptions: Record<string, unknown> | undefined;
    const initialize = vi.fn().mockResolvedValue(undefined);
    const ensureTable = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);

    vi.doMock('../../../src/runtime/destinations/mysql.js', () => ({
      MySqlDestination: class {
        constructor(options: Record<string, unknown>) {
          receivedOptions = options;
        }
        initialize = initialize;
        ensureTable = ensureTable;
        loadAndFinalize = vi.fn().mockResolvedValue({ rowsAffected: 0 });
        close = close;
        getTruncatedTables(): Set<string> {
          return new Set();
        }
        setTruncatedTables(): void {}
      },
    }));

    const { runDatabaseLoader } = await import('../../../src/commands/run.js');
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loader-run-mysql-'));

    await runDatabaseLoader(
      {
        dest: 'mysql',
        host: 'localhost',
        database: 'analytics',
        user: 'mysql',
        password: 'secret',
        bufferSize: 1,
        logFormat: 'text',
      },
      {
        input: Readable.from([`${buildSchemaLine('issues')}\n`]),
        stdout: new BufferingWritable(),
        stderr: new BufferingWritable(),
        tempRootDir,
      }
    );

    expect(receivedOptions).toMatchObject({
      host: 'localhost',
      database: 'analytics',
      user: 'mysql',
    });
    expect(initialize).toHaveBeenCalled();
    expect(ensureTable).toHaveBeenCalledWith(
      'analytics',
      'issues',
      [{ name: 'id', type: 'integer' }],
      expect.objectContaining({
        keyProperties: [],
        cursorField: undefined,
        loadStrategy: 'append',
      })
    );
    expect(close).toHaveBeenCalled();
  });

  it('creates and runs the Databricks destination when --dest databricks is used', async () => {
    let receivedOptions: Record<string, unknown> | undefined;
    const initialize = vi.fn().mockResolvedValue(undefined);
    const ensureTable = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);

    vi.doMock('../../../src/runtime/destinations/databricks.js', () => ({
      DatabricksDestination: class {
        constructor(options: Record<string, unknown>) {
          receivedOptions = options;
        }
        initialize = initialize;
        ensureTable = ensureTable;
        loadAndFinalize = vi.fn().mockResolvedValue({ rowsAffected: 0 });
        close = close;
        getTruncatedTables(): Set<string> {
          return new Set();
        }
        setTruncatedTables(): void {}
      },
    }));

    const { runDatabaseLoader } = await import('../../../src/commands/run.js');
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loader-run-databricks-'));

    await runDatabaseLoader(
      {
        dest: 'databricks',
        serverHostname: 'example.cloud.databricks.com',
        httpPath: '/sql/1.0/warehouses/abc123',
        accessToken: 'dapi-test-token',
        catalog: 'main',
        schema: 'analytics',
        bufferSize: 1,
        logFormat: 'text',
      },
      {
        input: Readable.from([`${buildSchemaLine('issues')}\n`]),
        stdout: new BufferingWritable(),
        stderr: new BufferingWritable(),
        tempRootDir,
      }
    );

    expect(receivedOptions).toMatchObject({
      serverHostname: 'example.cloud.databricks.com',
      httpPath: '/sql/1.0/warehouses/abc123',
      catalog: 'main',
      schema: 'analytics',
    });
    expect(initialize).toHaveBeenCalled();
    expect(ensureTable).toHaveBeenCalledWith(
      'analytics',
      'issues',
      [{ name: 'id', type: 'integer' }],
      expect.objectContaining({
        keyProperties: [],
        cursorField: undefined,
        loadStrategy: 'append',
      })
    );
    expect(close).toHaveBeenCalled();
  });

  it('creates and runs the Turbopuffer destination when --dest turbopuffer is used', async () => {
    let receivedOptions: Record<string, unknown> | undefined;
    const initialize = vi.fn().mockResolvedValue(undefined);
    const ensureTable = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);

    vi.doMock('../../../src/runtime/destinations/turbopuffer.js', () => ({
      TurbopufferDestination: class {
        constructor(options: Record<string, unknown>) {
          receivedOptions = options;
        }
        initialize = initialize;
        ensureTable = ensureTable;
        loadAndFinalize = vi.fn().mockResolvedValue({ rowsAffected: 0 });
        close = close;
        getTruncatedTables(): Set<string> {
          return new Set();
        }
        setTruncatedTables(): void {}
      },
    }));

    const { runDatabaseLoader } = await import('../../../src/commands/run.js');
    const tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loader-run-turbopuffer-'));

    await runDatabaseLoader(
      {
        dest: 'turbopuffer',
        apiKey: 'k',
        region: 'gcp-us-central1',
        bufferSize: 1,
        logFormat: 'text',
      },
      {
        input: Readable.from([`${buildSchemaLine('issues')}\n`]),
        stdout: new BufferingWritable(),
        stderr: new BufferingWritable(),
        tempRootDir,
      }
    );

    expect(receivedOptions).toMatchObject({
      apiKey: 'k',
      region: 'gcp-us-central1',
    });
    expect(initialize).toHaveBeenCalled();
    expect(ensureTable).toHaveBeenCalledWith(
      'default',
      'issues',
      [{ name: 'id', type: 'integer' }],
      expect.objectContaining({
        keyProperties: [],
        cursorField: undefined,
        loadStrategy: 'append',
      })
    );
    expect(close).toHaveBeenCalled();
  });
});
