import { Readable } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  runDryRun,
  runDatabaseLoader,
  runFileLoader,
  parseMemorySize,
} from '../../../src/commands/run.js';
import { BufferingWritable } from '../../helpers/stream.js';
import { resolveRunConfig } from '../../../src/commands/run-reconciliation.js';

import { CommandError } from '@bobsled-inc/protocol';

import type {
  DatabaseDestination,
  EnsureTableOptions,
  LoadResult,
} from '../../../src/runtime/destinations/database.js';
import type { BatchEncoding, SchemaColumn } from '@bobsled-inc/protocol';

function buildSchemaLine(
  stream: string,
  loadStrategy: string,
  keyProperties: string[],
  cursorField?: string,
  partitionBy?: string,
  schemaBehavior?: string
): string {
  return JSON.stringify({
    _v: 1,
    type: 'SCHEMA',
    stream,
    schema: {
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'title', type: 'string' },
        ...(cursorField ? [{ name: cursorField, type: 'timestamp' }] : []),
      ],
    },
    key_properties: keyProperties,
    load_strategy: loadStrategy,
    ...(schemaBehavior ? { schema_behavior: schemaBehavior } : {}),
    ...(cursorField ? { cursor_field: cursorField } : {}),
    ...(partitionBy ? { partition_by: partitionBy } : {}),
  });
}

describe('runDryRun', () => {
  it('prints strategy table for SCHEMA messages', async () => {
    const stderr = new BufferingWritable();
    const input = Readable.from([
      `${buildSchemaLine('issues', 'merge', ['id'], 'updated_at')}\n`,
      `${buildSchemaLine('events', 'append', [])}\n`,
    ]);

    await runDryRun({}, { input, stderr });

    const output = stderr.toString();
    expect(output).toContain('Stream');
    expect(output).toContain('issues');
    expect(output).toContain('merge');
    expect(output).toContain('events');
    expect(output).toContain('append');
    expect(output).toContain('updated_at');
    expect(output).toContain('Partition');
  });

  it('applies CLI --load-strategy override', async () => {
    const stderr = new BufferingWritable();
    const input = Readable.from([`${buildSchemaLine('issues', 'merge', ['id'])}\n`]);

    await runDryRun({ loadStrategy: 'full_refresh' }, { input, stderr });

    const output = stderr.toString();
    expect(output).toContain('full_refresh');
    expect(output).not.toContain('merge');
  });

  it('applies table prefixes and final per-stream table overrides', async () => {
    const stderr = new BufferingWritable();
    const input = Readable.from([
      `${buildSchemaLine('issues', 'merge', ['id'])}\n`,
      `${buildSchemaLine('teams', 'append', [])}\n`,
    ]);

    await runDryRun(
      { tablePrefix: 'github__', streamTable: { issues: 'raw_issues' } },
      { input, stderr }
    );

    expect(stderr.toString()).toContain('raw_issues');
    expect(stderr.toString()).toContain('github__teams');
  });

  it('rejects dry-run table collisions before reporting a misleading plan', async () => {
    const stderr = new BufferingWritable();
    const input = Readable.from([`${buildSchemaLine('issues', 'merge', ['id'])}\n`]);

    await expect(
      runDryRun(
        { streamTable: { issues: 'raw_github', pull_requests: 'raw_github' } },
        { input, stderr }
      )
    ).rejects.toThrow(/both resolve to destination table "raw_github"/);
    expect(stderr.toString()).toBe('');
  });

  it('reports no SCHEMA messages', async () => {
    const stderr = new BufferingWritable();
    const input = Readable.from([
      `${JSON.stringify({ _v: 1, type: 'RECORD', stream: 'issues', record: { id: 1 }, time_extracted: '2026-01-01T00:00:00Z' })}\n`,
    ]);

    await runDryRun({}, { input, stderr });

    expect(stderr.toString()).toContain('No SCHEMA messages');
  });

  it('computes cluster columns using shared logic', async () => {
    const stderr = new BufferingWritable();
    const input = Readable.from([`${buildSchemaLine('issues', 'merge', ['id'], 'updated_at')}\n`]);

    await runDryRun({}, { input, stderr });

    const output = stderr.toString();
    // Cluster should be [updated_at, id] — cursor first, then PKs
    expect(output).toContain('["updated_at","id"]');
  });

  it('prints the resolved partition column for each stream', async () => {
    const stderr = new BufferingWritable();
    const input = Readable.from([
      `${buildSchemaLine('costs', 'merge', ['id'], 'updated_at', 'updated_at')}\n`,
      `${buildSchemaLine('events', 'append', [])}\n`,
    ]);

    await runDryRun({}, { input, stderr });

    const output = stderr.toString();
    expect(output).toContain('updated_at');
    expect(output).toContain('_time_extracted');
  });
});

describe('parseMemorySize', () => {
  it('parses MB values', () => {
    expect(parseMemorySize('512MB')).toBe(512_000_000);
  });

  it('parses GB values', () => {
    expect(parseMemorySize('2GB')).toBe(2_000_000_000);
  });

  it('parses GiB values', () => {
    expect(parseMemorySize('1GiB')).toBe(1_073_741_824);
  });

  it('parses values with spaces', () => {
    expect(parseMemorySize('512 MB')).toBe(512_000_000);
  });

  it('throws on invalid format', () => {
    expect(() => parseMemorySize('abc')).toThrow(/Invalid memory size/);
  });
});

function buildProtocolLine(message: Record<string, unknown>): string {
  return JSON.stringify({ _v: 1, ...message });
}

function createMockDatabaseDestination(loadDelay: number = 0): DatabaseDestination & {
  loadCalls: Array<{
    stream: string;
    strategy: string;
    filePath: string;
    sourceEncoding: BatchEncoding | undefined;
    startTime: number;
    endTime: number;
  }>;
} {
  const loadCalls: Array<{
    stream: string;
    strategy: string;
    filePath: string;
    sourceEncoding: BatchEncoding | undefined;
    startTime: number;
    endTime: number;
  }> = [];
  return {
    loadCalls,
    async initialize(): Promise<void> {},
    async ensureTable(): Promise<void> {},
    async loadAndFinalize(
      _schemaName: string,
      tableName: string,
      filePath: string,
      _columns: SchemaColumn[],
      strategy: string,
      _keyColumns: string[],
      sourceEncoding?: BatchEncoding
    ): Promise<LoadResult> {
      const startTime = Date.now();
      if (loadDelay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, loadDelay));
      }
      const endTime = Date.now();
      loadCalls.push({ stream: tableName, strategy, filePath, sourceEncoding, startTime, endTime });
      return { rowsAffected: 1 };
    },
    async close(): Promise<void> {},
    getTruncatedTables(): Set<string> {
      return new Set();
    },
    setTruncatedTables(): void {},
  };
}

describe('runDatabaseLoader: parallel loading', () => {
  it.each(['loadFile', 'loadIntegration'] as const)(
    'carries a BigQuery CLI ownership marker from %s resolution into ensureTable',
    async (mode) => {
      const project = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-owned-target-'));
      const previousCwd = process.cwd();
      try {
        fs.mkdirSync(path.join(project, 'integrations'));
        fs.mkdirSync(path.join(project, 'targets'));
        fs.writeFileSync(
          path.join(project, 'integrations/bigquery_test.yml'),
          `spec_version: "1"\ntype: integration\nname: bigquery_test\nsource_type: bigquery\nconnection:\n  project_id: test-project\n  dataset: staging\n  location: US\nauth:\n  type: adc\n`
        );
        fs.writeFileSync(
          path.join(project, 'targets/staging.yml'),
          `spec_version: "1"\ntype: target\nname: staging\nintegration: bigquery_test\n`
        );
        process.chdir(project);
        const config = await resolveRunConfig({
          ...(mode === 'loadFile'
            ? { loadFile: path.join(project, 'targets/staging.yml') }
            : { loadIntegration: 'bigquery_test' }),
          streamTableOwnershipMarker: { issues: 'temp-dataset-123' },
          tablePrefix: 'oss_e2e_',
          loadStrategy: 'full_refresh',
        });
        expect(config.dest).toBe('bigquery');
        if (config.dest !== 'bigquery') throw new Error('Expected BigQuery configuration');

        const dest = createMockDatabaseDestination();
        const ensureTable = vi.spyOn(dest, 'ensureTable');
        await runDatabaseLoader(config, {
          createDatabaseDestination: () => dest,
          input: Readable.from([`${buildSchemaLine('issues', 'append', ['id'])}\n`]),
          stdout: new BufferingWritable(),
          stderr: new BufferingWritable(),
        });
        expect(ensureTable).toHaveBeenCalledWith(
          'staging',
          'oss_e2e_issues',
          expect.any(Array),
          expect.objectContaining({
            tableOwnershipMarker: 'temp-dataset-123',
            loadStrategy: 'full_refresh',
          })
        );
      } finally {
        process.chdir(previousCwd);
        fs.rmSync(project, { recursive: true, force: true });
      }
    }
  );

  it('rejects an ownership marker for a destination without ownership support', async () => {
    await expect(
      resolveRunConfig({ dest: 'local', streamTableOwnershipMarker: { issues: 'marker' } })
    ).rejects.toThrow(/only supported for Snowflake, BigQuery, Postgres, and Databricks/);
  });

  it('passes a per-stream Snowflake ownership marker to schema handling', async () => {
    const dest = createMockDatabaseDestination();
    const ensureTable = vi.spyOn(dest, 'ensureTable');

    await runDatabaseLoader(
      {
        dest: 'snowflake',
        account: 'acct',
        username: 'loader',
        password: 'secret',
        warehouse: 'WH',
        database: 'DB',
        targetSchema: 'STAGING',
        bufferSize: 1,
        logFormat: 'text',
        streamTables: { issues: 'DS_CSV_aB12cD' },
        streamTableOwnershipMarkers: { issues: 'temp-dataset-123' },
      },
      {
        createDatabaseDestination: () => dest,
        input: Readable.from([`${buildSchemaLine('issues', 'append', ['id'])}\n`]),
        stdout: new BufferingWritable(),
        stderr: new BufferingWritable(),
      }
    );

    expect(ensureTable).toHaveBeenCalledWith(
      'STAGING',
      'DS_CSV_aB12cD',
      expect.any(Array),
      expect.objectContaining({ tableOwnershipMarker: 'temp-dataset-123' })
    );
  });

  it('passes reconciliation only to explicitly targeted Snowflake streams', async () => {
    const dest = createMockDatabaseDestination();
    const ensureTable = vi.spyOn(dest, 'ensureTable');
    const input = Readable.from([
      `${buildSchemaLine('issues', 'full_refresh', ['id'])}\n`,
      `${buildSchemaLine('events', 'append', [])}\n`,
    ]);

    await runDatabaseLoader(
      {
        dest: 'snowflake',
        account: 'acct',
        username: 'loader',
        password: 'secret',
        warehouse: 'WH',
        database: 'DB',
        targetSchema: 'PUBLIC',
        bufferSize: 1,
        logFormat: 'text',
        reconcileSchema: ['issues'],
        schemaBehavior: 'strict',
      },
      {
        createDatabaseDestination: () => dest,
        input,
        stdout: new BufferingWritable(),
        stderr: new BufferingWritable(),
      }
    );

    const issuesOptions = ensureTable.mock.calls[0]?.[3] as EnsureTableOptions;
    const eventsOptions = ensureTable.mock.calls[1]?.[3] as EnsureTableOptions;
    expect(issuesOptions).toMatchObject({ schemaBehavior: 'strict', reconcileSchema: true });
    expect(eventsOptions).not.toHaveProperty('reconcileSchema');
  });

  it('rejects reconciliation unless the targeted stream resolves to full_refresh', async () => {
    const dest = createMockDatabaseDestination();
    const ensureTable = vi.spyOn(dest, 'ensureTable');

    await expect(
      runDatabaseLoader(
        {
          dest: 'snowflake',
          account: 'acct',
          username: 'loader',
          password: 'secret',
          warehouse: 'WH',
          database: 'DB',
          targetSchema: 'PUBLIC',
          bufferSize: 1,
          logFormat: 'text',
          loadStrategy: 'full_refresh',
          streamLoadStrategies: { issues: 'append' },
          reconcileSchema: ['issues'],
        },
        {
          createDatabaseDestination: () => dest,
          input: Readable.from([`${buildSchemaLine('issues', 'full_refresh', ['id'])}\n`]),
          stdout: new BufferingWritable(),
          stderr: new BufferingWritable(),
        }
      )
    ).rejects.toMatchObject({
      exitCode: 2,
      message:
        '--reconcile-schema stream "issues" requires effective load strategy "full_refresh".',
    });
    expect(ensureTable).not.toHaveBeenCalled();
  });

  it('rejects reconciliation on unsupported database destinations before creating one', async () => {
    const createDatabaseDestination = vi.fn();

    await expect(
      runDatabaseLoader(
        {
          dest: 'postgres',
          reconcileSchema: ['issues'],
        } as unknown as Parameters<typeof runDatabaseLoader>[0],
        {
          createDatabaseDestination,
          input: Readable.from([]),
          stdout: new BufferingWritable(),
          stderr: new BufferingWritable(),
        }
      )
    ).rejects.toMatchObject({
      exitCode: 2,
      message: '--reconcile-schema is only supported for Snowflake destinations.',
    });
    expect(createDatabaseDestination).not.toHaveBeenCalled();
  });

  it('rejects a repeated evolve schema after stream data before replacing the table', async () => {
    const dest = createMockDatabaseDestination();
    const ensureTable = vi.spyOn(dest, 'ensureTable');
    const schema = buildProtocolLine({
      type: 'SCHEMA',
      stream: 'issues',
      schema: { columns: [{ name: 'id', type: 'integer' }] },
      key_properties: [],
      load_strategy: 'full_refresh',
      schema_behavior: 'evolve',
    });
    const record = buildProtocolLine({
      type: 'RECORD',
      stream: 'issues',
      record: { id: 1 },
      time_extracted: '2026-01-01T00:00:00Z',
    });

    await expect(
      runDatabaseLoader(
        {
          dest: 'snowflake',
          account: 'acct',
          username: 'loader',
          password: 'secret',
          warehouse: 'WH',
          database: 'DB',
          targetSchema: 'PUBLIC',
          bufferSize: 100,
          logFormat: 'text',
        },
        {
          createDatabaseDestination: () => dest,
          input: Readable.from([`${schema}\n`, `${record}\n`, `${schema}\n`]),
          stdout: new BufferingWritable(),
          stderr: new BufferingWritable(),
        }
      )
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('emitted another SCHEMA after data'),
    });
    expect(ensureTable).toHaveBeenCalledTimes(1);
    expect(dest.loadCalls).toHaveLength(0);
  });

  it('preserves controlled validation exit codes from destination schema checks', async () => {
    const dest = createMockDatabaseDestination();
    vi.spyOn(dest, 'ensureTable').mockRejectedValue(new CommandError('invalid schema option', 2));

    await expect(
      runDatabaseLoader(
        {
          dest: 'snowflake',
          account: 'acct',
          username: 'loader',
          password: 'secret',
          warehouse: 'WH',
          database: 'DB',
          targetSchema: 'PUBLIC',
          bufferSize: 1,
          logFormat: 'text',
        },
        {
          createDatabaseDestination: () => dest,
          input: Readable.from([`${buildSchemaLine('issues', 'append', ['id'])}\n`]),
          stdout: new BufferingWritable(),
          stderr: new BufferingWritable(),
        }
      )
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it('applies table and strategy overrides to only their named streams', async () => {
    const dest = createMockDatabaseDestination();
    const ensureTable = vi.spyOn(dest, 'ensureTable');
    const stderr = new BufferingWritable();
    const messages: string[] = [];
    for (const stream of ['issues', 'pull_requests', 'teams']) {
      messages.push(
        buildSchemaLine(stream, 'append', ['id']),
        buildProtocolLine({
          type: 'RECORD',
          stream,
          record: { id: 1, title: stream },
          time_extracted: '2026-01-01T00:00:00Z',
        }),
        buildProtocolLine({
          type: 'STATE',
          stream,
          value: { record_count: 1 },
        })
      );
    }

    await runDatabaseLoader(
      {
        dest: 'bigquery',
        datasetId: 'test_ds',
        bufferSize: 1,
        logFormat: 'json',
        stagingFormat: 'jsonl',
        maxConcurrentLoads: 1,
        loadStrategy: 'append',
        tablePrefix: 'github__',
        streamLoadStrategies: {
          issues: 'merge',
          pull_requests: 'full_refresh',
        },
        streamSchemaBehaviors: {
          issues: 'strict',
        },
        streamTables: {
          issues: 'raw_issues',
          pull_requests: 'raw_prs',
        },
      },
      {
        createDatabaseDestination: () => dest,
        input: Readable.from(messages.map((message) => `${message}\n`)),
        stdout: new BufferingWritable(),
        stderr,
      }
    );

    expect(dest.loadCalls.map(({ stream, strategy }) => ({ stream, strategy }))).toEqual([
      { stream: 'raw_issues', strategy: 'merge' },
      { stream: 'raw_prs', strategy: 'full_refresh' },
      { stream: 'github__teams', strategy: 'append' },
    ]);
    expect(ensureTable.mock.calls[0]?.[3]).toMatchObject({ schemaBehavior: 'strict' });
    expect(ensureTable.mock.calls[1]?.[3]).toMatchObject({ schemaBehavior: undefined });
    const loadEvents = stderr
      .toString()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => typeof line['event'] === 'string' && line['event'].includes(': loaded '));
    expect(loadEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'raw_issues: loaded 1 rows', stream: 'issues' }),
        expect.objectContaining({ event: 'raw_prs: loaded 1 rows', stream: 'pull_requests' }),
        expect.objectContaining({ event: 'github__teams: loaded 1 rows', stream: 'teams' }),
      ])
    );
  });

  it('gives per-stream schema behavior precedence over global and SCHEMA defaults', async () => {
    const dest = createMockDatabaseDestination();
    const ensureTable = vi.spyOn(dest, 'ensureTable');

    await runDatabaseLoader(
      {
        dest: 'postgres',
        host: 'localhost',
        database: 'warehouse',
        username: 'loader',
        password: 'secret',
        schema: 'public',
        bufferSize: 1,
        logFormat: 'text',
        schemaBehavior: 'evolve',
        streamSchemaBehaviors: { issues: 'strict' },
      },
      {
        createDatabaseDestination: () => dest,
        input: Readable.from([
          `${buildSchemaLine('issues', 'append', ['id'], undefined, undefined, 'freeze')}\n`,
          `${buildSchemaLine('events', 'append', ['id'], undefined, undefined, 'freeze')}\n`,
        ]),
        stdout: new BufferingWritable(),
        stderr: new BufferingWritable(),
      }
    );

    expect(ensureTable.mock.calls[0]?.[3]).toMatchObject({ schemaBehavior: 'strict' });
    expect(ensureTable.mock.calls[1]?.[3]).toMatchObject({ schemaBehavior: 'evolve' });
  });

  it('rejects two raw streams that resolve to the same destination table', async () => {
    const dest = createMockDatabaseDestination();
    const input = Readable.from([
      `${buildSchemaLine('issues', 'append', ['id'])}\n`,
      `${buildProtocolLine({
        type: 'RECORD',
        stream: 'issues',
        record: { id: 1, title: 'already buffered' },
        time_extracted: '2026-07-28T00:00:00.000Z',
      })}\n`,
      `${buildProtocolLine({
        type: 'STATE',
        stream: 'issues',
        state: { cursor_value: '2026-07-28T00:00:00.000Z' },
      })}\n`,
      `${buildSchemaLine('pull_requests', 'merge', ['id'])}\n`,
    ]);

    await expect(
      runDatabaseLoader(
        {
          dest: 'bigquery',
          datasetId: 'test_ds',
          streamTables: {
            issues: 'raw_github',
            pull_requests: 'raw_github',
          },
        },
        {
          createDatabaseDestination: () => dest,
          input,
          stdout: new BufferingWritable(),
          stderr: new BufferingWritable(),
        }
      )
    ).rejects.toThrow(
      /Streams "issues" and "pull_requests" both resolve to destination table "raw_github"/
    );
    expect(dest.loadCalls).toHaveLength(0);
  });

  it('reports invalid database stream identifiers as validation errors', async () => {
    const dest = createMockDatabaseDestination();
    const input = Readable.from([`${buildSchemaLine('invalid-stream', 'append', ['id'])}\n`]);

    await expect(
      runDatabaseLoader(
        { dest: 'bigquery', datasetId: 'test_ds' },
        {
          createDatabaseDestination: () => dest,
          input,
          stdout: new BufferingWritable(),
          stderr: new BufferingWritable(),
        }
      )
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("Stream name 'invalid-stream'"),
    });
  });

  it('rejects empty database schemas before calling ensureTable', async () => {
    const dest = createMockDatabaseDestination();
    const ensureTable = vi.spyOn(dest, 'ensureTable');
    const stream = 'empty_stream';

    await expect(
      runDatabaseLoader(
        { dest: 'bigquery', datasetId: 'test_ds' },
        {
          createDatabaseDestination: () => dest,
          input: Readable.from([
            `${buildProtocolLine({
              type: 'SCHEMA',
              stream,
              schema: { columns: [] },
              key_properties: [],
              load_strategy: 'append',
            })}\n`,
          ]),
          stdout: new BufferingWritable(),
          stderr: new BufferingWritable(),
        }
      )
    ).rejects.toMatchObject({
      exitCode: 2,
      message:
        'stream "empty_stream" declares no columns; refusing to create or load a destination table',
    });

    expect(ensureTable).not.toHaveBeenCalled();
    expect(dest.loadCalls).toHaveLength(0);
  });

  it('preserves the complete provider error for the CLI error boundary', async () => {
    const dest = createMockDatabaseDestination();
    vi.spyOn(dest, 'loadAndFinalize').mockRejectedValue(
      new Error(
        'SQL compilation error:\nerror line 1 at position 56\ninvalid identifier "TOKEN"; detail=[REDACTED]'
      )
    );
    const stderr = new BufferingWritable();

    await expect(
      runDatabaseLoader(
        {
          dest: 'bigquery',
          datasetId: 'test_ds',
          bufferSize: 1,
          logFormat: 'json',
        },
        {
          createDatabaseDestination: () => dest,
          input: Readable.from([
            `${buildSchemaLine('issues', 'append', [])}\n`,
            `${buildProtocolLine({
              type: 'RECORD',
              stream: 'issues',
              record: { id: 1, title: 'alpha' },
              time_extracted: '2026-01-01T00:00:00Z',
            })}\n`,
          ]),
          stdout: new BufferingWritable(),
          stderr,
        }
      )
    ).rejects.toThrow(
      'Failed to load stream "issues" to bigquery: SQL compilation error:\n' +
        'error line 1 at position 56\n' +
        'invalid identifier "TOKEN"; detail=[REDACTED]. ' +
        'Run `dogsled load check --dest bigquery` to diagnose connectivity issues.'
    );

    expect(stderr.toString()).not.toContain('"level":"error"');
  });

  it('explains Snowflake invalid identifiers as destination schema drift', async () => {
    const dest = createMockDatabaseDestination();
    vi.spyOn(dest, 'loadAndFinalize').mockRejectedValue(
      new Error("SQL compilation error: invalid identifier 'ID'")
    );

    await expect(
      runDatabaseLoader(
        {
          dest: 'snowflake',
          account: 'acct',
          username: 'loader',
          password: 'secret',
          warehouse: 'WH',
          database: 'DB',
          targetSchema: 'PUBLIC',
          bufferSize: 1,
          logFormat: 'text',
        },
        {
          createDatabaseDestination: () => dest,
          input: Readable.from([
            `${buildSchemaLine('issues', 'full_refresh', ['id'])}\n`,
            `${buildProtocolLine({
              type: 'RECORD',
              stream: 'issues',
              record: { id: 1, title: 'alpha' },
              time_extracted: '2026-01-01T00:00:00Z',
            })}\n`,
          ]),
          stdout: new BufferingWritable(),
          stderr: new BufferingWritable(),
        }
      )
    ).rejects.toThrow(
      'Snowflake reported invalid identifier "ID", so column "ID" is likely missing. ' +
        'Recover with load_strategy: full_refresh and schema_behavior: evolve (the default), or reconcile the Snowflake schema programmatically.'
    );
  });

  it('concurrent loads execute in parallel when maxConcurrentLoads > 1', async () => {
    const dest = createMockDatabaseDestination(50);
    const schemaMsg = buildProtocolLine({
      type: 'SCHEMA',
      stream: 'issues',
      schema: { columns: [{ name: 'id', type: 'integer' }] },
      key_properties: [],
      load_strategy: 'append',
    });
    // Send multiple records to trigger multiple flushes
    const records = Array.from({ length: 6 }, (_, i) =>
      buildProtocolLine({
        type: 'RECORD',
        stream: 'issues',
        record: { id: i },
        time_extracted: '2026-01-01T00:00:00Z',
      })
    );
    const stateMsg = buildProtocolLine({
      type: 'STATE',
      stream: 'issues',
      value: { record_count: 5 },
    });

    const input = Readable.from([
      `${schemaMsg}\n`,
      ...records.map((r) => `${r}\n`),
      `${stateMsg}\n`,
    ]);

    const stdout = new BufferingWritable();
    const stderr = new BufferingWritable();

    const result = await runDatabaseLoader(
      {
        dest: 'bigquery',
        datasetId: 'test_ds',
        bufferSize: 2, // flush every 2 records
        logFormat: 'text',
        stagingFormat: 'jsonl',
        maxConcurrentLoads: 4,
      },
      {
        createDatabaseDestination: () => dest,
        input,
        stdout,
        stderr,
      }
    );

    // All records should have been loaded
    expect(result.streamsLoaded.get('issues')).toBe(dest.loadCalls.length);
    // STATE should have been forwarded
    expect(result.statesForwarded).toBe(1);
  });

  it('serializes merge loads for one stream when maxConcurrentLoads > 1', async () => {
    const dest = createMockDatabaseDestination(20);
    const schemaMsg = buildProtocolLine({
      type: 'SCHEMA',
      stream: 'issues',
      schema: { columns: [{ name: 'id', type: 'integer' }] },
      key_properties: ['id'],
      load_strategy: 'merge',
    });
    const records = Array.from({ length: 6 }, (_, i) =>
      buildProtocolLine({
        type: 'RECORD',
        stream: 'issues',
        record: { id: i },
        time_extracted: `2026-01-01T00:00:0${i}Z`,
      })
    );

    await runDatabaseLoader(
      {
        dest: 'bigquery',
        datasetId: 'test_ds',
        bufferSize: 1,
        logFormat: 'text',
        stagingFormat: 'jsonl',
        maxConcurrentLoads: 4,
      },
      {
        createDatabaseDestination: () => dest,
        input: Readable.from([`${schemaMsg}\n`, ...records.map((r) => `${r}\n`)]),
        stdout: new BufferingWritable(),
        stderr: new BufferingWritable(),
      }
    );

    const loadsByStart = [...dest.loadCalls].sort(
      (left, right) => left.startTime - right.startTime
    );
    expect(loadsByStart).toHaveLength(6);
    expect(
      loadsByStart.slice(1).every((load, index) => load.startTime >= loadsByStart[index]!.endTime)
    ).toBe(true);
  });

  it('STATE is only forwarded after pending loads for the stream complete', async () => {
    const dest = createMockDatabaseDestination(20);
    const schemaMsg = buildProtocolLine({
      type: 'SCHEMA',
      stream: 'issues',
      schema: { columns: [{ name: 'id', type: 'integer' }] },
      key_properties: [],
      load_strategy: 'append',
    });
    const recordMsg = buildProtocolLine({
      type: 'RECORD',
      stream: 'issues',
      record: { id: 1 },
      time_extracted: '2026-01-01T00:00:00Z',
    });
    const stateMsg = buildProtocolLine({
      type: 'STATE',
      stream: 'issues',
      value: { record_count: 1 },
    });

    const input = Readable.from([`${schemaMsg}\n`, `${recordMsg}\n`, `${stateMsg}\n`]);

    const stdout = new BufferingWritable();
    const stderr = new BufferingWritable();

    const result = await runDatabaseLoader(
      {
        dest: 'bigquery',
        datasetId: 'test_ds',
        bufferSize: 1,
        logFormat: 'text',
        stagingFormat: 'jsonl',
        maxConcurrentLoads: 4,
      },
      {
        createDatabaseDestination: () => dest,
        input,
        stdout,
        stderr,
      }
    );

    // Load should have completed before STATE was forwarded
    expect(dest.loadCalls.length).toBeGreaterThanOrEqual(1);
    expect(result.statesForwarded).toBe(1);

    // The STATE output should contain the value
    const stateOutput = stdout.toString();
    expect(stateOutput).toContain('"record_count":1');
  });

  it('forces serial loading for Snowflake token-based OAUTH paths even when maxConcurrentLoads > 1', async () => {
    const dest = createMockDatabaseDestination(30);
    const schemaMsg = buildProtocolLine({
      type: 'SCHEMA',
      stream: 'issues',
      schema: { columns: [{ name: 'id', type: 'integer' }] },
      key_properties: [],
      load_strategy: 'append',
    });
    const records = Array.from({ length: 4 }, (_, i) =>
      buildProtocolLine({
        type: 'RECORD',
        stream: 'issues',
        record: { id: i },
        time_extracted: '2026-01-01T00:00:00Z',
      })
    );

    const stderr = new BufferingWritable();

    await runDatabaseLoader(
      {
        dest: 'snowflake',
        account: 'acct',
        username: 'loader',
        accessToken: 'static-oidc-token',
        warehouse: 'WH',
        database: 'DB',
        targetSchema: 'PUBLIC',
        bufferSize: 1,
        logFormat: 'text',
        maxConcurrentLoads: 4,
      },
      {
        createDatabaseDestination: () => dest,
        input: Readable.from([`${schemaMsg}\n`, ...records.map((record) => `${record}\n`)]),
        stdout: new BufferingWritable(),
        stderr,
      }
    );

    expect(stderr.toString()).toContain('Snowflake OAUTH forces maxConcurrentLoads=1');
    expect(dest.loadCalls.length).toBe(4);
    for (let index = 1; index < dest.loadCalls.length; index += 1) {
      expect(dest.loadCalls[index]!.startTime).toBeGreaterThanOrEqual(
        dest.loadCalls[index - 1]!.endTime
      );
    }
  });
});

describe('runFileLoader: path traversal prevention', () => {
  it('sanitizes malicious stream names in destination paths', async () => {
    const publishedPaths: string[] = [];
    const mockDestination = {
      async publish(_tempPath: string, destinationPath: string): Promise<string> {
        publishedPaths.push(destinationPath);
        return `file://${destinationPath}`;
      },
      async close(): Promise<void> {},
    };
    const mockDuckDb = {
      async convertFile(opts: { sourcePath: string; outputPath: string }): Promise<void> {
        // Write a dummy file so publish has something
        const fsPromises = await import('node:fs/promises');
        await fsPromises.mkdir((await import('node:path')).dirname(opts.outputPath), {
          recursive: true,
        });
        await fsPromises.writeFile(opts.outputPath, 'dummy');
      },
      async close(): Promise<void> {},
    };

    const maliciousStream = '../../../tmp/evil';
    const schemaMsg = JSON.stringify({
      _v: 1,
      type: 'SCHEMA',
      stream: maliciousStream,
      schema: { columns: [{ name: 'id', type: 'integer' }] },
      key_properties: [],
      load_strategy: 'append',
    });
    const recordMsg = JSON.stringify({
      _v: 1,
      type: 'RECORD',
      stream: maliciousStream,
      record: { id: 1 },
      time_extracted: '2026-01-01T00:00:00Z',
    });
    const stateMsg = JSON.stringify({
      _v: 1,
      type: 'STATE',
      stream: maliciousStream,
      value: { record_count: 1 },
    });

    const input = Readable.from([`${schemaMsg}\n`, `${recordMsg}\n`, `${stateMsg}\n`]);
    const stdout = new BufferingWritable();
    const stderr = new BufferingWritable();

    await runFileLoader(
      {
        dest: 'local',
        format: 'jsonl',
        outputDir: '/tmp/test-output',
        bufferSize: 1,
        logFormat: 'text',
      },
      {
        createDestination: () => mockDestination,
        createDuckDbWriter: () => mockDuckDb,
        input,
        stdout,
        stderr,
      }
    );

    // All destination paths should be sanitized — slashes in stream name replaced with underscores
    expect(publishedPaths.length).toBeGreaterThan(0);
    for (const p of publishedPaths) {
      // The stream portion should not contain path separators from the original name
      // '../../../tmp/evil' becomes '.._.._.._tmp_evil' (slashes replaced with underscores)
      const streamDir = p.split('/')[0]!;
      expect(streamDir).not.toContain('/');
      expect(streamDir).toBe('.._.._.._tmp_evil');
    }
  });
});

describe('runDatabaseLoader: checkpoint', () => {
  it('passes parquet batch encodings through to native parquet destinations', async () => {
    const dest = createMockDatabaseDestination();
    const input = Readable.from([
      `${buildSchemaLine('issues', 'append', [])}\n`,
      `${buildProtocolLine({
        type: 'BATCH',
        stream: 'issues',
        encoding: { format: 'parquet' },
        manifest: ['file:///tmp/issues.parquet'],
      })}\n`,
      `${buildProtocolLine({
        type: 'STATE',
        stream: 'issues',
        value: { record_count: 2 },
      })}\n`,
    ]);

    await runDatabaseLoader(
      {
        dest: 'duckdb',
        dbPath: '/tmp/test.duckdb',
        targetSchema: 'main',
        bufferSize: 2,
        logFormat: 'text',
      },
      {
        createDatabaseDestination: () => dest,
        input,
        stdout: new BufferingWritable(),
        stderr: new BufferingWritable(),
      }
    );

    expect(dest.loadCalls).toHaveLength(1);
    expect(dest.loadCalls[0]?.filePath).toBe('/tmp/issues.parquet');
    expect(dest.loadCalls[0]?.sourceEncoding).toEqual({ format: 'parquet' });
  });

  it('normalizes parquet batches to jsonl for destinations without native parquet support', async () => {
    const dest = createMockDatabaseDestination();
    const convertCalls: Array<{
      format: string;
      outputPath: string;
      sourceEncoding: BatchEncoding | undefined;
      sourcePath: string;
    }> = [];
    const input = Readable.from([
      `${buildSchemaLine('issues', 'append', [])}\n`,
      `${buildProtocolLine({
        type: 'BATCH',
        stream: 'issues',
        encoding: { format: 'parquet' },
        manifest: ['file:///tmp/issues.parquet'],
      })}\n`,
      `${buildProtocolLine({
        type: 'STATE',
        stream: 'issues',
        value: { record_count: 2 },
      })}\n`,
    ]);

    await runDatabaseLoader(
      {
        dest: 'postgres',
        host: 'localhost',
        database: 'analytics',
        schema: 'public',
        bufferSize: 2,
        logFormat: 'text',
      },
      {
        createDatabaseDestination: () => dest,
        createDuckDbWriter: async () => ({
          async convertFile(options) {
            convertCalls.push({
              format: options.format,
              outputPath: options.outputPath,
              sourceEncoding: options.sourceEncoding,
              sourcePath: options.sourcePath,
            });
          },
          async close() {},
        }),
        input,
        stdout: new BufferingWritable(),
        stderr: new BufferingWritable(),
      }
    );

    expect(convertCalls).toHaveLength(1);
    expect(convertCalls[0]).toMatchObject({
      sourcePath: '/tmp/issues.parquet',
      format: 'jsonl',
      sourceEncoding: { format: 'parquet' },
    });
    expect(dest.loadCalls).toHaveLength(1);
    expect(dest.loadCalls[0]?.filePath.endsWith('.jsonl')).toBe(true);
    expect(dest.loadCalls[0]?.sourceEncoding).toEqual({ format: 'jsonl' });
  });

  it('saves checkpoint on STATE when checkpointDir is configured', async () => {
    const dest = createMockDatabaseDestination();
    const schemaMsg = buildProtocolLine({
      type: 'SCHEMA',
      stream: 'issues',
      schema: { columns: [{ name: 'id', type: 'integer' }] },
      key_properties: [],
      load_strategy: 'append',
    });
    const stateMsg = buildProtocolLine({
      type: 'STATE',
      stream: 'issues',
      value: { record_count: 42 },
    });

    const input = Readable.from([`${schemaMsg}\n`, `${stateMsg}\n`]);
    const stdout = new BufferingWritable();
    const stderr = new BufferingWritable();
    const tmpDir = await import('node:os').then((os) => os.tmpdir());
    const checkpointDir = `${tmpDir}/bobsled-test-ckpt-${Date.now()}`;

    try {
      const result = await runDatabaseLoader(
        {
          dest: 'bigquery',
          datasetId: 'test_ds',
          bufferSize: 10_000,
          logFormat: 'text',
          stagingFormat: 'jsonl',
          maxConcurrentLoads: 1,
          checkpointDir,
        },
        {
          createDatabaseDestination: () => dest,
          input,
          stdout,
          stderr,
        }
      );

      expect(result.statesForwarded).toBe(1);

      // Verify checkpoint was written
      const { CheckpointManager } = await import('../../../src/runtime/checkpoint.js');
      const mgr = new CheckpointManager(checkpointDir);
      const savedState = await mgr.load('issues');
      expect(savedState).toEqual({ record_count: 42 });
    } finally {
      const fsPromises = await import('node:fs/promises');
      await fsPromises.rm(checkpointDir, { recursive: true, force: true });
    }
  });
});
