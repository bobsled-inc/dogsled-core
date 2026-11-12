import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDuckDb, type DuckDbDatabaseLike } from '../../src/runtime/duckdb-primitives.js';
import { createDuckDbWriter } from '../../src/runtime/duckdb-writer.js';
import { queryRows } from '../helpers/duckdb.js';

import type { SchemaColumn } from '@bobsled-inc/protocol';

const columns: SchemaColumn[] = [
  { name: 'id', type: 'integer' },
  { name: 'title', type: 'string' },
  { name: 'created_at', type: 'timestamp' },
];

const records = [
  { id: 1, title: 'alpha', created_at: '2026-03-23T00:00:00.000Z' },
  { id: 2, title: 'beta', created_at: '2026-07-04T12:30:45.250Z' },
  { id: 3, title: 'gamma', created_at: null },
];

const instantUs = (iso: string) => Date.parse(iso) * 1000;

async function recordingDatabase(
  afterConnect: string[] = []
): Promise<{ factory: () => Promise<DuckDbDatabaseLike>; statements: string[] }> {
  const statements: string[] = [];
  const real = await openDuckDb(':memory:');
  const factory = async (): Promise<DuckDbDatabaseLike> => ({
    async connect() {
      const connection = await real.connect();
      for (const statement of afterConnect) {
        await connection.run(statement);
      }
      return {
        async run(sql: string) {
          statements.push(sql);
          await connection.run(sql);
        },
        async all(sql: string) {
          statements.push(sql);
          return connection.all(sql);
        },
        close: () => connection.close(),
      };
    },
    close: () => real.close(),
  });
  return { factory, statements };
}

async function columnLogicalType(file: string, column: string): Promise<string> {
  const rows = await queryRows(
    `SELECT logical_type FROM parquet_schema('${file}') WHERE name = '${column}'`
  );
  return String(rows[0]?.['logical_type']);
}

describe('DuckDbWriter: UTC timestamps', () => {
  let tempDir: string;
  let sourcePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'duckdb-writer-utc-'));
    sourcePath = path.join(tempDir, 'input.jsonl');
    await fs.writeFile(
      sourcePath,
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      'utf-8'
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('runs exactly one COPY statement and no time zone statement when the option is off', async () => {
    const outputPath = path.join(tempDir, 'off.parquet');
    const { factory, statements } = await recordingDatabase();
    const writer = await createDuckDbWriter({ databaseFactory: factory });
    try {
      await writer.convertFile({ sourcePath, outputPath, format: 'parquet', columns });
    } finally {
      await writer.close();
    }

    expect(statements).toEqual([
      `COPY (SELECT * FROM read_json('${sourcePath}', format = 'newline_delimited', auto_detect = false, columns = {"id": 'BIGINT', "title": 'VARCHAR', "created_at": 'TIMESTAMP'})) TO '${outputPath}' (FORMAT PARQUET)`,
    ]);
    expect(await columnLogicalType(outputPath, 'created_at')).toContain('isAdjustedToUTC=0');
  });

  it('writes the same bytes as the statement it ran before the option existed', async () => {
    const outputPath = path.join(tempDir, 'off.parquet');
    const legacyPath = path.join(tempDir, 'legacy.parquet');
    const writer = await createDuckDbWriter();
    try {
      await writer.convertFile({ sourcePath, outputPath, format: 'parquet', columns });
    } finally {
      await writer.close();
    }

    const database = await openDuckDb(':memory:');
    const connection = await database.connect();
    try {
      await connection.run(
        `COPY (SELECT * FROM read_json('${sourcePath}', format = 'newline_delimited', auto_detect = false, columns = {"id": 'BIGINT', "title": 'VARCHAR', "created_at": 'TIMESTAMP'})) TO '${legacyPath}' (FORMAT PARQUET)`
      );
    } finally {
      await connection.close();
      await database.close();
    }

    expect(await fs.readFile(outputPath)).toEqual(await fs.readFile(legacyPath));
  });

  it('treats an explicit false the same as an absent option', async () => {
    const outputPath = path.join(tempDir, 'false.parquet');
    const { factory, statements } = await recordingDatabase();
    const writer = await createDuckDbWriter({ databaseFactory: factory });
    try {
      await writer.convertFile({
        sourcePath,
        outputPath,
        format: 'parquet',
        columns,
        utcTimestamps: false,
      });
    } finally {
      await writer.close();
    }

    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^COPY \(SELECT \* FROM read_json\(/u);
  });

  it('writes UTC-adjusted timestamps that keep every instant', async () => {
    const outputPath = path.join(tempDir, 'on.parquet');
    const writer = await createDuckDbWriter();
    try {
      await writer.convertFile({
        sourcePath,
        outputPath,
        format: 'parquet',
        columns,
        utcTimestamps: true,
      });
    } finally {
      await writer.close();
    }

    expect(await columnLogicalType(outputPath, 'created_at')).toContain('isAdjustedToUTC=1');
    const rows = await queryRows(
      `SELECT id, title, epoch_us(created_at) AS us FROM read_parquet('${outputPath}') ORDER BY id`
    );
    expect(rows).toEqual([
      { id: 1, title: 'alpha', us: instantUs('2026-03-23T00:00:00.000Z') },
      { id: 2, title: 'beta', us: instantUs('2026-07-04T12:30:45.250Z') },
      { id: 3, title: 'gamma', us: null },
    ]);
  });

  it('leaves integer and string columns as they were', async () => {
    const offPath = path.join(tempDir, 'off.parquet');
    const onPath = path.join(tempDir, 'on.parquet');
    const writer = await createDuckDbWriter();
    try {
      await writer.convertFile({ sourcePath, outputPath: offPath, format: 'parquet', columns });
      await writer.convertFile({
        sourcePath,
        outputPath: onPath,
        format: 'parquet',
        columns,
        utcTimestamps: true,
      });
    } finally {
      await writer.close();
    }

    for (const column of ['id', 'title']) {
      expect(await columnLogicalType(onPath, column)).toBe(
        await columnLogicalType(offPath, column)
      );
    }
  });

  it('does not depend on the session time zone', async () => {
    const outputPath = path.join(tempDir, 'zone.parquet');
    const { factory } = await recordingDatabase(["SET TimeZone = 'America/Los_Angeles'"]);
    const writer = await createDuckDbWriter({ databaseFactory: factory });
    try {
      await writer.convertFile({
        sourcePath,
        outputPath,
        format: 'parquet',
        columns,
        utcTimestamps: true,
      });
    } finally {
      await writer.close();
    }

    const rows = await queryRows(
      `SELECT epoch_us(created_at) AS us FROM read_parquet('${outputPath}') ORDER BY id`
    );
    expect(rows.map((row) => row['us'])).toEqual([
      instantUs('2026-03-23T00:00:00.000Z'),
      instantUs('2026-07-04T12:30:45.250Z'),
      null,
    ]);
  });

  it('converts Parquet batch input too', async () => {
    const firstPath = path.join(tempDir, 'first.parquet');
    const secondPath = path.join(tempDir, 'second.parquet');
    const writer = await createDuckDbWriter();
    try {
      await writer.convertFile({ sourcePath, outputPath: firstPath, format: 'parquet', columns });
      await writer.convertFile({
        sourcePath: firstPath,
        outputPath: secondPath,
        format: 'parquet',
        sourceEncoding: { format: 'parquet' },
        utcTimestamps: true,
      });
    } finally {
      await writer.close();
    }

    expect(await columnLogicalType(firstPath, 'created_at')).toContain('isAdjustedToUTC=0');
    expect(await columnLogicalType(secondPath, 'created_at')).toContain('isAdjustedToUTC=1');
    const rows = await queryRows(
      `SELECT epoch_us(created_at) AS us FROM read_parquet('${secondPath}') ORDER BY id`
    );
    expect(rows.map((row) => row['us'])).toEqual([
      instantUs('2026-03-23T00:00:00.000Z'),
      instantUs('2026-07-04T12:30:45.250Z'),
      null,
    ]);
  });

  it('keeps nanosecond timestamps as written instead of dropping digits', async () => {
    const nanosPath = path.join(tempDir, 'nanos.parquet');
    const convertedPath = path.join(tempDir, 'nanos-converted.parquet');
    const seed = await openDuckDb(':memory:');
    const seedConnection = await seed.connect();
    await seedConnection.run(
      `COPY (SELECT TIMESTAMP_NS '2026-03-23 00:00:00.123456789' AS seen_at, TIMESTAMP '2026-03-23 00:00:00' AS created_at) TO '${nanosPath}' (FORMAT PARQUET)`
    );
    await seedConnection.close();
    await seed.close();

    const writer = await createDuckDbWriter();
    try {
      await writer.convertFile({
        sourcePath: nanosPath,
        outputPath: convertedPath,
        format: 'parquet',
        sourceEncoding: { format: 'parquet' },
        utcTimestamps: true,
      });
    } finally {
      await writer.close();
    }

    expect(await columnLogicalType(convertedPath, 'seen_at')).toContain('isAdjustedToUTC=0');
    expect(await columnLogicalType(convertedPath, 'created_at')).toContain('isAdjustedToUTC=1');
  });
});
