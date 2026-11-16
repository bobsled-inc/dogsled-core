import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runLoader } from '../../src/commands/run.js';
import { createDuckDbWriter } from '../../src/runtime/duckdb-writer.js';
import { queryPersistentDb, readRowsFromFile, sortRowsByNumericField } from '../helpers/duckdb.js';
import { BufferingWritable } from '../helpers/stream.js';

import type { SchemaColumn, StateMessage } from '@bobsled-inc/protocol';

const outputFormats = ['jsonl', 'csv', 'parquet', 'arrow'] as const;

const issueSchemaColumns: SchemaColumn[] = [
  { name: 'id', type: 'integer', primary_key: true },
  { name: 'title', type: 'string' },
];

function buildSchema(
  stream: string,
  columns: SchemaColumn[],
  loadStrategy: 'append' | 'merge' | 'full_refresh' = 'append',
  cursorField?: string
): string {
  return JSON.stringify({
    _v: 1,
    type: 'SCHEMA',
    stream,
    schema: { columns },
    key_properties: columns.filter((column) => column.primary_key).map((column) => column.name),
    load_strategy: loadStrategy,
    ...(cursorField ? { cursor_field: cursorField } : {}),
  });
}

function buildState(stream: string, recordCount: number): StateMessage {
  return {
    _v: 1,
    type: 'STATE',
    stream,
    value: {
      record_count: recordCount,
    },
  };
}

async function writeJsonlBatch(
  filePath: string,
  records: Record<string, unknown>[]
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf-8'
  );
}

async function writeParquetBatch(
  filePath: string,
  records: Record<string, unknown>[]
): Promise<void> {
  const scratchPath = `${filePath}.scratch.jsonl`;
  await writeJsonlBatch(scratchPath, records);
  const writer = await createDuckDbWriter();
  try {
    await writer.convertFile({
      sourcePath: scratchPath,
      outputPath: filePath,
      format: 'parquet',
      sourceEncoding: { format: 'jsonl' },
      columns: issueSchemaColumns,
    });
  } finally {
    try {
      await writer.close();
    } finally {
      await fs.rm(scratchPath, { force: true });
    }
  }
}

describe('runLoader', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'target-pipe-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.each(outputFormats)(
    'converts batch protocol files and forwards STATE messages for %s output',
    async (format) => {
      const batchFile = path.join(tempDir, 'batch', `issues-0-${format}.jsonl`);
      const outputDir = path.join(tempDir, `output-${format}`);
      const stdout = new BufferingWritable();
      const stderr = new BufferingWritable();
      const state = buildState('issues', 2);

      await writeJsonlBatch(batchFile, [
        { id: 1, title: 'alpha' },
        { id: 2, title: 'beta' },
      ]);

      await runLoader(
        {
          format,
          dest: 'local',
          outputDir,
          bufferSize: 2,
        },
        {
          input: Readable.from([
            `${buildSchema('issues', issueSchemaColumns)}\n`,
            `${JSON.stringify({
              _v: 1,
              type: 'BATCH',
              stream: 'issues',
              encoding: { format: 'jsonl' },
              manifest: [pathToFileURL(batchFile).href],
            })}\n`,
            `${JSON.stringify(state)}\n`,
          ]),
          stdout,
          stderr,
        }
      );

      const rows = await readRowsFromFile(
        path.join(outputDir, 'issues', `issues-0.${format}`),
        format
      );
      expect(sortRowsByNumericField(rows, 'id')).toEqual([
        { id: 1, title: 'alpha' },
        { id: 2, title: 'beta' },
      ]);
      expect(
        stdout
          .toString()
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      ).toEqual([state]);
      expect(stderr.toString()).toContain('wrote');
    }
  );

  it('publishes parquet batch files directly when output format is parquet', async () => {
    const batchFile = path.join(tempDir, 'batch', 'issues-0.parquet');
    const outputDir = path.join(tempDir, 'output-parquet-direct');

    await writeParquetBatch(batchFile, [
      { id: 1, title: 'alpha' },
      { id: 2, title: 'beta' },
    ]);

    await runLoader(
      {
        format: 'parquet',
        dest: 'local',
        outputDir,
        bufferSize: 2,
      },
      {
        input: Readable.from([
          `${buildSchema('issues', issueSchemaColumns)}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'BATCH',
            stream: 'issues',
            encoding: { format: 'parquet' },
            manifest: [pathToFileURL(batchFile).href],
          })}\n`,
          `${JSON.stringify(buildState('issues', 2))}\n`,
        ]),
        stdout: new BufferingWritable(),
        stderr: new BufferingWritable(),
      }
    );

    const rows = await readRowsFromFile(
      path.join(outputDir, 'issues', 'issues-0.parquet'),
      'parquet'
    );
    expect(sortRowsByNumericField(rows, 'id')).toEqual([
      { id: 1, title: 'alpha' },
      { id: 2, title: 'beta' },
    ]);
    expect(await fs.stat(batchFile)).toBeTruthy();
  });

  it('converts parquet batch files to jsonl output when formats differ', async () => {
    const batchFile = path.join(tempDir, 'batch', 'issues-0.parquet');
    const outputDir = path.join(tempDir, 'output-jsonl-from-parquet');

    await writeParquetBatch(batchFile, [
      { id: 1, title: 'alpha' },
      { id: 2, title: 'beta' },
    ]);

    await runLoader(
      {
        format: 'jsonl',
        dest: 'local',
        outputDir,
        bufferSize: 2,
      },
      {
        input: Readable.from([
          `${buildSchema('issues', issueSchemaColumns)}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'BATCH',
            stream: 'issues',
            encoding: { format: 'parquet' },
            manifest: [pathToFileURL(batchFile).href],
          })}\n`,
          `${JSON.stringify(buildState('issues', 2))}\n`,
        ]),
      }
    );

    const rows = await readRowsFromFile(path.join(outputDir, 'issues', 'issues-0.jsonl'), 'jsonl');
    expect(sortRowsByNumericField(rows, 'id')).toEqual([
      { id: 1, title: 'alpha' },
      { id: 2, title: 'beta' },
    ]);
  });

  it.each(outputFormats)(
    'flushes streaming records at the configured threshold across multiple streams for %s output',
    async (format) => {
      const outputDir = path.join(tempDir, `output-${format}`);
      const stdout = new BufferingWritable();

      await runLoader(
        {
          format,
          dest: 'local',
          outputDir,
          bufferSize: 2,
        },
        {
          input: Readable.from([
            `${buildSchema('issues', issueSchemaColumns)}\n`,
            `${JSON.stringify({
              _v: 1,
              type: 'RECORD',
              stream: 'issues',
              record: { id: 1, title: 'alpha' },
              time_extracted: '2026-03-23T00:00:00.000Z',
            })}\n`,
            `${JSON.stringify({
              _v: 1,
              type: 'RECORD',
              stream: 'issues',
              record: { id: 2, title: 'beta' },
              time_extracted: '2026-03-23T00:00:01.000Z',
            })}\n`,
            `${buildSchema('repos', issueSchemaColumns)}\n`,
            `${JSON.stringify({
              _v: 1,
              type: 'RECORD',
              stream: 'repos',
              record: { id: 10, title: 'repo-one' },
              time_extracted: '2026-03-23T00:00:02.000Z',
            })}\n`,
            `${JSON.stringify(buildState('repos', 1))}\n`,
            `${JSON.stringify({
              _v: 1,
              type: 'RECORD',
              stream: 'issues',
              record: { id: 3, title: 'gamma' },
              time_extracted: '2026-03-23T00:00:03.000Z',
            })}\n`,
            `${JSON.stringify(buildState('issues', 3))}\n`,
          ]),
          stdout,
        }
      );

      const issueRows0 = await readRowsFromFile(
        path.join(outputDir, 'issues', `issues-0.${format}`),
        format
      );
      const issueRows1 = await readRowsFromFile(
        path.join(outputDir, 'issues', `issues-1.${format}`),
        format
      );
      const repoRows = await readRowsFromFile(
        path.join(outputDir, 'repos', `repos-0.${format}`),
        format
      );

      expect(sortRowsByNumericField([...issueRows0, ...issueRows1], 'id')).toEqual([
        { id: 1, title: 'alpha' },
        { id: 2, title: 'beta' },
        { id: 3, title: 'gamma' },
      ]);
      expect(repoRows).toEqual([{ id: 10, title: 'repo-one' }]);
      expect(
        stdout
          .toString()
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      ).toEqual([buildState('repos', 1), buildState('issues', 3)]);
    }
  );

  it('flushes buffered streaming records at EOF even without a trailing STATE message', async () => {
    const outputDir = path.join(tempDir, 'output-eof');

    await runLoader(
      {
        format: 'parquet',
        dest: 'local',
        outputDir,
        bufferSize: 10,
      },
      {
        input: Readable.from([
          `${buildSchema('issues', issueSchemaColumns)}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'issues',
            record: { id: 1, title: 'alpha' },
            time_extracted: '2026-03-23T00:00:00.000Z',
          })}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'issues',
            record: { id: 2, title: 'beta' },
            time_extracted: '2026-03-23T00:00:01.000Z',
          })}\n`,
        ]),
      }
    );

    const rows = await readRowsFromFile(
      path.join(outputDir, 'issues', 'issues-0.parquet'),
      'parquet'
    );
    expect(sortRowsByNumericField(rows, 'id')).toEqual([
      { id: 1, title: 'alpha' },
      { id: 2, title: 'beta' },
    ]);
  });

  it('does not emit empty files for schema-only streams', async () => {
    const outputDir = path.join(tempDir, 'output');

    await runLoader(
      {
        format: 'jsonl',
        dest: 'local',
        outputDir,
        bufferSize: 10,
      },
      {
        input: Readable.from([
          `${buildSchema('issues', issueSchemaColumns)}\n`,
          `${JSON.stringify(buildState('issues', 0))}\n`,
        ]),
      }
    );

    await expect(fs.access(path.join(outputDir, 'issues', 'issues-0.jsonl'))).rejects.toThrow();
  });

  it('preserves caller-provided tempRootDir but cleans owned artifacts', async () => {
    const callerTempRoot = path.join(tempDir, 'caller-temp');
    await fs.mkdir(callerTempRoot, { recursive: true });

    // Place a sentinel file in the caller temp root
    const sentinelPath = path.join(callerTempRoot, 'sentinel.txt');
    await fs.writeFile(sentinelPath, 'do-not-delete', 'utf-8');

    const outputDir = path.join(tempDir, 'output-sentinel');

    await runLoader(
      {
        format: 'jsonl',
        dest: 'local',
        outputDir,
        bufferSize: 10,
      },
      {
        input: Readable.from([
          `${buildSchema('issues', issueSchemaColumns)}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'issues',
            record: { id: 1, title: 'alpha' },
            time_extracted: '2026-03-23T00:00:00.000Z',
          })}\n`,
          `${JSON.stringify(buildState('issues', 1))}\n`,
        ]),
        tempRootDir: callerTempRoot,
      }
    );

    // Sentinel file should survive the run
    const sentinelContent = await fs.readFile(sentinelPath, 'utf-8');
    expect(sentinelContent).toBe('do-not-delete');

    // The owned temp subdirectory (bobsled-loader-*) should be cleaned up
    const remaining = await fs.readdir(callerTempRoot);
    expect(remaining).toEqual(['sentinel.txt']);
  });
});

describe('runLoader — DuckDB destination', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'duckdb-pipe-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('DuckDB append: SCHEMA→RECORD→STATE → rows in .duckdb file with _time_extracted', async () => {
    const dbPath = path.join(tempDir, 'test.duckdb');
    const stdout = new BufferingWritable();
    const stderr = new BufferingWritable();
    const state = buildState('issues', 2);

    await runLoader(
      {
        dest: 'duckdb',
        dbPath,
        targetSchema: 'main',
        bufferSize: 10,
      },
      {
        input: Readable.from([
          `${buildSchema('issues', issueSchemaColumns, 'append')}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'issues',
            record: { id: 1, title: 'alpha' },
            time_extracted: '2026-03-26T00:00:00.000Z',
          })}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'issues',
            record: { id: 2, title: 'beta' },
            time_extracted: '2026-03-26T00:00:01.000Z',
          })}\n`,
          `${JSON.stringify(state)}\n`,
        ]),
        stdout,
        stderr,
      }
    );

    const rows = await queryPersistentDb(dbPath, 'SELECT id, title FROM main.issues ORDER BY id');
    expect(rows).toEqual([
      { id: BigInt(1), title: 'alpha' },
      { id: BigInt(2), title: 'beta' },
    ]);

    // Verify _time_extracted and _bobsled_loaded_at are populated
    const tsRows = await queryPersistentDb(
      dbPath,
      'SELECT "_time_extracted", "_bobsled_loaded_at" FROM main.issues'
    );
    expect(tsRows.length).toBe(2);
    for (const row of tsRows) {
      expect(row['_time_extracted']).toBeInstanceOf(Date);
      expect(row['_bobsled_loaded_at']).toBeInstanceOf(Date);
    }

    // STATE forwarded
    expect(
      stdout
        .toString()
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    ).toEqual([state]);

    // Stderr has load messages
    expect(stderr.toString()).toContain('loaded 2 rows');
  });

  it('DuckDB merge: load twice with overlapping PKs → no duplicates, latest wins', async () => {
    const dbPath = path.join(tempDir, 'merge.duckdb');

    // First load
    await runLoader(
      {
        dest: 'duckdb',
        dbPath,
        targetSchema: 'main',
        bufferSize: 10,
      },
      {
        input: Readable.from([
          `${buildSchema('issues', issueSchemaColumns, 'merge')}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'issues',
            record: { id: 1, title: 'alpha' },
            time_extracted: '2026-03-26T00:00:00.000Z',
          })}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'issues',
            record: { id: 2, title: 'beta' },
            time_extracted: '2026-03-26T00:00:01.000Z',
          })}\n`,
        ]),
      }
    );

    // Second load with overlapping PK
    await runLoader(
      {
        dest: 'duckdb',
        dbPath,
        targetSchema: 'main',
        bufferSize: 10,
      },
      {
        input: Readable.from([
          `${buildSchema('issues', issueSchemaColumns, 'merge')}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'issues',
            record: { id: 2, title: 'beta-updated' },
            time_extracted: '2026-03-26T00:01:00.000Z',
          })}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'issues',
            record: { id: 3, title: 'gamma' },
            time_extracted: '2026-03-26T00:01:01.000Z',
          })}\n`,
        ]),
      }
    );

    const rows = await queryPersistentDb(dbPath, 'SELECT id, title FROM main.issues ORDER BY id');
    expect(rows).toEqual([
      { id: BigInt(1), title: 'alpha' },
      { id: BigInt(2), title: 'beta-updated' },
      { id: BigInt(3), title: 'gamma' },
    ]);
  });

  it('DuckDB multi-stream: issues + teams → both tables created', async () => {
    const dbPath = path.join(tempDir, 'multi.duckdb');
    const teamColumns: SchemaColumn[] = [
      { name: 'team_id', type: 'integer', primary_key: true },
      { name: 'name', type: 'string' },
    ];

    await runLoader(
      {
        dest: 'duckdb',
        dbPath,
        targetSchema: 'main',
        bufferSize: 10,
      },
      {
        input: Readable.from([
          `${buildSchema('issues', issueSchemaColumns, 'append')}\n`,
          `${buildSchema('teams', teamColumns, 'append')}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'issues',
            record: { id: 1, title: 'issue-1' },
            time_extracted: '2026-03-26T00:00:00.000Z',
          })}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'teams',
            record: { team_id: 100, name: 'Engineering' },
            time_extracted: '2026-03-26T00:00:00.000Z',
          })}\n`,
        ]),
      }
    );

    const issueRows = await queryPersistentDb(dbPath, 'SELECT id, title FROM main.issues');
    expect(issueRows).toEqual([{ id: BigInt(1), title: 'issue-1' }]);

    const teamRows = await queryPersistentDb(dbPath, 'SELECT team_id, name FROM main.teams');
    expect(teamRows).toEqual([{ team_id: BigInt(100), name: 'Engineering' }]);
  });

  it('DuckDB schema evolution: load then load with extra column → ALTER TABLE', async () => {
    const dbPath = path.join(tempDir, 'evolve.duckdb');

    // First load with base columns
    await runLoader(
      {
        dest: 'duckdb',
        dbPath,
        targetSchema: 'main',
        bufferSize: 10,
      },
      {
        input: Readable.from([
          `${buildSchema('issues', issueSchemaColumns, 'append')}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'issues',
            record: { id: 1, title: 'alpha' },
            time_extracted: '2026-03-26T00:00:00.000Z',
          })}\n`,
        ]),
      }
    );

    // Second load with extra column
    const extendedColumns: SchemaColumn[] = [
      ...issueSchemaColumns,
      { name: 'status', type: 'string' },
    ];
    await runLoader(
      {
        dest: 'duckdb',
        dbPath,
        targetSchema: 'main',
        bufferSize: 10,
      },
      {
        input: Readable.from([
          `${buildSchema('issues', extendedColumns, 'append')}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'issues',
            record: { id: 2, title: 'beta', status: 'open' },
            time_extracted: '2026-03-26T00:01:00.000Z',
          })}\n`,
        ]),
      }
    );

    const rows = await queryPersistentDb(
      dbPath,
      'SELECT id, title, status FROM main.issues ORDER BY id'
    );
    expect(rows).toEqual([
      { id: BigInt(1), title: 'alpha', status: null },
      { id: BigInt(2), title: 'beta', status: 'open' },
    ]);
  });

  it.each([
    {
      name: 'an added upstream column',
      existingColumns: issueSchemaColumns,
      incomingColumns: [...issueSchemaColumns, { name: 'status', type: 'string' as const }],
      existingRecord: { id: 1, title: 'alpha' },
      driftRecord: { id: 2, title: 'beta', status: 'open' },
      error: /Schema contract violation \(strict\).*unexpected new columns: status/,
      expectedColumns: ['id', 'title', '_time_extracted', '_bobsled_loaded_at'],
      expectedRows: [{ id: BigInt(1), title: 'alpha' }],
    },
    {
      name: 'a removed upstream column',
      existingColumns: [...issueSchemaColumns, { name: 'status', type: 'string' as const }],
      incomingColumns: issueSchemaColumns,
      existingRecord: { id: 1, title: 'alpha', status: 'open' },
      driftRecord: { id: 2, title: 'beta' },
      error: /Schema contract violation \(strict\).*missing expected columns: status/,
      expectedColumns: ['id', 'title', 'status', '_time_extracted', '_bobsled_loaded_at'],
      expectedRows: [{ id: BigInt(1), title: 'alpha', status: 'open' }],
    },
  ])(
    'DuckDB strict stream schema behavior rejects $name without evolving the table',
    async (test) => {
      const dbPath = path.join(tempDir, `strict-${test.name.replaceAll(' ', '-')}.duckdb`);

      await runLoader(
        {
          dest: 'duckdb',
          dbPath,
          targetSchema: 'main',
          bufferSize: 10,
        },
        {
          input: Readable.from([
            `${buildSchema('issues', test.existingColumns, 'append')}\n`,
            `${JSON.stringify({
              _v: 1,
              type: 'RECORD',
              stream: 'issues',
              record: test.existingRecord,
              time_extracted: '2026-03-26T00:00:00.000Z',
            })}\n`,
          ]),
        }
      );

      await expect(
        runLoader(
          {
            dest: 'duckdb',
            dbPath,
            targetSchema: 'main',
            bufferSize: 10,
            streamSchemaBehaviors: { issues: 'strict' },
          },
          {
            input: Readable.from([
              `${buildSchema('issues', test.incomingColumns, 'append')}\n`,
              `${JSON.stringify({
                _v: 1,
                type: 'RECORD',
                stream: 'issues',
                record: test.driftRecord,
                time_extracted: '2026-03-26T00:01:00.000Z',
              })}\n`,
            ]),
          }
        )
      ).rejects.toThrow(test.error);

      const columns = await queryPersistentDb(
        dbPath,
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'main' AND table_name = 'issues' ORDER BY ordinal_position"
      );
      expect(columns.map((column) => column['column_name'])).toEqual(test.expectedColumns);

      const rows = await queryPersistentDb(
        dbPath,
        'SELECT * EXCLUDE (_time_extracted, _bobsled_loaded_at) FROM main.issues'
      );
      expect(rows).toEqual(test.expectedRows);
    }
  );

  it('DuckDB EOF flush: records without trailing STATE are flushed', async () => {
    const dbPath = path.join(tempDir, 'eof.duckdb');

    await runLoader(
      {
        dest: 'duckdb',
        dbPath,
        targetSchema: 'main',
        bufferSize: 100,
      },
      {
        input: Readable.from([
          `${buildSchema('issues', issueSchemaColumns, 'append')}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'issues',
            record: { id: 1, title: 'alpha' },
            time_extracted: '2026-03-26T00:00:00.000Z',
          })}\n`,
        ]),
      }
    );

    const rows = await queryPersistentDb(dbPath, 'SELECT id, title FROM main.issues');
    expect(rows).toEqual([{ id: BigInt(1), title: 'alpha' }]);
  });

  it('DuckDB merge fallback: merge + empty key_properties → append with warning', async () => {
    const dbPath = path.join(tempDir, 'fallback.duckdb');
    const stderr = new BufferingWritable();

    // Schema with no primary keys
    const noPkColumns: SchemaColumn[] = [
      { name: 'id', type: 'integer' },
      { name: 'title', type: 'string' },
    ];

    await runLoader(
      {
        dest: 'duckdb',
        dbPath,
        targetSchema: 'main',
        bufferSize: 10,
      },
      {
        input: Readable.from([
          `${JSON.stringify({
            _v: 1,
            type: 'SCHEMA',
            stream: 'events',
            schema: { columns: noPkColumns },
            key_properties: [],
            load_strategy: 'merge',
          })}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'events',
            record: { id: 1, title: 'event-1' },
            time_extracted: '2026-03-26T00:00:00.000Z',
          })}\n`,
        ]),
        stderr,
      }
    );

    // Should fall back to append
    const rows = await queryPersistentDb(dbPath, 'SELECT id, title FROM main.events');
    expect(rows).toEqual([{ id: BigInt(1), title: 'event-1' }]);

    // Should have warning on stderr
    expect(stderr.toString()).toContain('merge requested but no key_properties');
    expect(stderr.toString()).toContain('falling back to append');
  });

  it('DuckDB full_refresh: second load replaces first', async () => {
    const dbPath = path.join(tempDir, 'full-refresh.duckdb');

    // First load
    await runLoader(
      {
        dest: 'duckdb',
        dbPath,
        targetSchema: 'main',
        bufferSize: 10,
      },
      {
        input: Readable.from([
          `${buildSchema('issues', issueSchemaColumns, 'full_refresh')}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'issues',
            record: { id: 1, title: 'alpha' },
            time_extracted: '2026-03-26T00:00:00.000Z',
          })}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'issues',
            record: { id: 2, title: 'beta' },
            time_extracted: '2026-03-26T00:00:01.000Z',
          })}\n`,
        ]),
      }
    );

    const rows1 = await queryPersistentDb(dbPath, 'SELECT id, title FROM main.issues ORDER BY id');
    expect(rows1).toEqual([
      { id: BigInt(1), title: 'alpha' },
      { id: BigInt(2), title: 'beta' },
    ]);

    // Second load — should replace all data
    await runLoader(
      {
        dest: 'duckdb',
        dbPath,
        targetSchema: 'main',
        bufferSize: 10,
      },
      {
        input: Readable.from([
          `${buildSchema('issues', issueSchemaColumns, 'full_refresh')}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'issues',
            record: { id: 3, title: 'gamma' },
            time_extracted: '2026-03-26T00:01:00.000Z',
          })}\n`,
        ]),
      }
    );

    const rows2 = await queryPersistentDb(dbPath, 'SELECT id, title FROM main.issues ORDER BY id');
    expect(rows2).toEqual([{ id: BigInt(3), title: 'gamma' }]);
  });

  it('DuckDB loadAndFinalize error includes stream name and destination type', async () => {
    const dbPath = path.join(tempDir, 'err-context.duckdb');

    const fakeDestination = {
      async initialize(): Promise<void> {},
      async ensureTable(): Promise<void> {},
      async loadAndFinalize(): Promise<never> {
        throw new Error('connection refused');
      },
      async close(): Promise<void> {},
    };

    await expect(
      runLoader(
        {
          dest: 'duckdb',
          dbPath,
          targetSchema: 'main',
          bufferSize: 10,
        },
        {
          createDatabaseDestination: () => fakeDestination,
          input: Readable.from([
            `${buildSchema('issues', issueSchemaColumns, 'append')}\n`,
            `${JSON.stringify({
              _v: 1,
              type: 'RECORD',
              stream: 'issues',
              record: { id: 1, title: 'alpha' },
              time_extracted: '2026-03-26T00:00:00.000Z',
            })}\n`,
          ]),
        }
      )
    ).rejects.toThrow(
      /Failed to load stream "issues" to duckdb: connection refused.*bobsled load check --dest duckdb/
    );
  });

  it('DuckDB RECORD without SCHEMA → error', async () => {
    const dbPath = path.join(tempDir, 'no-schema.duckdb');

    await expect(
      runLoader(
        {
          dest: 'duckdb',
          dbPath,
          targetSchema: 'main',
          bufferSize: 10,
        },
        {
          input: Readable.from([
            `${JSON.stringify({
              _v: 1,
              type: 'RECORD',
              stream: 'issues',
              record: { id: 1, title: 'alpha' },
              time_extracted: '2026-03-26T00:00:00.000Z',
            })}\n`,
          ]),
        }
      )
    ).rejects.toThrow(/before SCHEMA/);
  });

  it('File loader RECORD without SCHEMA → error', async () => {
    const outputDir = path.join(tempDir, 'output-no-schema');

    await expect(
      runLoader(
        {
          format: 'jsonl',
          dest: 'local',
          outputDir,
          bufferSize: 10,
        },
        {
          input: Readable.from([
            `${JSON.stringify({
              _v: 1,
              type: 'RECORD',
              stream: 'issues',
              record: { id: 1, title: 'alpha' },
              time_extracted: '2026-03-26T00:00:00.000Z',
            })}\n`,
          ]),
        }
      )
    ).rejects.toThrow(/before SCHEMA/);
  });

  it('Invalid --dest value is rejected by Zod validation', async () => {
    await expect(
      runLoader(
        {
          dest: 'invalid_dest' as 'local',
          format: 'jsonl',
          outputDir: path.join(tempDir, 'output'),
          bufferSize: 10,
        } as never,
        {
          input: Readable.from([]),
        }
      )
    ).rejects.toThrow();
  });

  it('DuckDB: SCHEMA re-declaration flushes buffered records before updating schema', async () => {
    const dbPath = path.join(tempDir, 'schema-flush.duckdb');

    const extendedColumns: SchemaColumn[] = [
      ...issueSchemaColumns,
      { name: 'status', type: 'string' },
    ];

    await runLoader(
      {
        dest: 'duckdb',
        dbPath,
        targetSchema: 'main',
        bufferSize: 100, // High threshold — records stay buffered until forced flush
      },
      {
        input: Readable.from([
          // SCHEMA v1 (no status column)
          `${buildSchema('issues', issueSchemaColumns, 'append')}\n`,
          // Records under v1 — below bufferSize, so they stay buffered
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'issues',
            record: { id: 1, title: 'alpha' },
            time_extracted: '2026-03-26T00:00:00.000Z',
          })}\n`,
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'issues',
            record: { id: 2, title: 'beta' },
            time_extracted: '2026-03-26T00:00:01.000Z',
          })}\n`,
          // SCHEMA v2 (adds status column) — should flush v1 records first
          `${buildSchema('issues', extendedColumns, 'append')}\n`,
          // Record under v2
          `${JSON.stringify({
            _v: 1,
            type: 'RECORD',
            stream: 'issues',
            record: { id: 3, title: 'gamma', status: 'open' },
            time_extracted: '2026-03-26T00:01:00.000Z',
          })}\n`,
        ]),
      }
    );

    const rows = await queryPersistentDb(
      dbPath,
      'SELECT id, title, status FROM main.issues ORDER BY id'
    );
    expect(rows).toEqual([
      { id: BigInt(1), title: 'alpha', status: null },
      { id: BigInt(2), title: 'beta', status: null },
      { id: BigInt(3), title: 'gamma', status: 'open' },
    ]);
  });
});
