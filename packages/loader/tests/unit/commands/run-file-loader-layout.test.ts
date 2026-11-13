import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runFileLoader } from '../../../src/commands/run.js';
import { queryRows } from '../../helpers/duckdb.js';
import { BufferingWritable } from '../../helpers/stream.js';

import type { FileDestConfig } from '../../../src/schemas/config.js';

interface ConvertCall {
  readonly [key: string]: unknown;
}

const schemaLine = (stream: string) =>
  JSON.stringify({
    _v: 1,
    type: 'SCHEMA',
    stream,
    schema: {
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'created_at', type: 'timestamp' },
      ],
    },
    key_properties: [],
    load_strategy: 'append',
  });

const recordLine = (stream: string, id: number) =>
  JSON.stringify({
    _v: 1,
    type: 'RECORD',
    stream,
    record: { id, created_at: '2026-03-23T00:00:00Z' },
    time_extracted: '2026-03-23T00:00:00Z',
  });

const stateLine = (stream: string) =>
  JSON.stringify({ _v: 1, type: 'STATE', stream, value: { record_count: 1 } });

const baseConfig = {
  dest: 's3',
  format: 'parquet',
  outputDir: '/tmp/test-output',
  s3Bucket: 'example-bucket',
  bufferSize: 1,
  logFormat: 'text',
} as const satisfies FileDestConfig;

describe('runFileLoader: stream subfolder', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-loader-layout-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function run(config: FileDestConfig, lines: string[]) {
    const published: string[] = [];
    const converts: ConvertCall[] = [];
    await runFileLoader(config, {
      createDestination: () => ({
        async publish(_localPath: string, destinationPath: string): Promise<string> {
          published.push(destinationPath);
          return `s3://example-bucket/${destinationPath}`;
        },
      }),
      createDuckDbWriter: () => ({
        async convertFile(options) {
          converts.push({ ...options });
          await fs.writeFile(options.outputPath, 'converted');
        },
        async close(): Promise<void> {},
      }),
      input: Readable.from(lines.map((line) => `${line}\n`)),
      stdout: new BufferingWritable(),
      stderr: new BufferingWritable(),
    });
    return { converts, published };
  }

  it('keeps the legacy path and convert options when the option is not set', async () => {
    const { converts, published } = await run({ ...baseConfig }, [
      schemaLine('orders'),
      recordLine('orders', 1),
      recordLine('orders', 2),
      stateLine('orders'),
    ]);

    expect(published).toEqual(['orders/orders-0.parquet', 'orders/orders-1.parquet']);
    expect(converts).toHaveLength(2);
    for (const call of converts) {
      expect(Object.keys(call).sort()).toEqual([
        'columns',
        'format',
        'outputPath',
        'sourceEncoding',
        'sourcePath',
      ]);
    }
  });

  it('adds the subfolder inside each stream folder and counts files per stream', async () => {
    const { published } = await run(
      { ...baseConfig, streamSubfolder: 'data/20261120T050007Z-9f3a1c2b' },
      [
        schemaLine('orders'),
        schemaLine('customers'),
        recordLine('orders', 1),
        recordLine('customers', 1),
        recordLine('orders', 2),
        stateLine('orders'),
      ]
    );

    expect(published.sort()).toEqual([
      'customers/data/20261120T050007Z-9f3a1c2b/customers-0.parquet',
      'orders/data/20261120T050007Z-9f3a1c2b/orders-0.parquet',
      'orders/data/20261120T050007Z-9f3a1c2b/orders-1.parquet',
    ]);
  });

  it('puts the subfolder under the sanitized stream name', async () => {
    const { published } = await run({ ...baseConfig, streamSubfolder: 'data/run-1' }, [
      schemaLine('sales/2026'),
      recordLine('sales/2026', 1),
      stateLine('sales/2026'),
    ]);

    expect(published).toEqual(['sales_2026/data/run-1/sales_2026-0.parquet']);
  });

  it('writes Parquet under the subfolder through the real local destination', async () => {
    const outputDir = path.join(tempDir, 'out');
    await runFileLoader(
      {
        dest: 'local',
        format: 'parquet',
        outputDir,
        bufferSize: 1,
        logFormat: 'text',
        streamSubfolder: 'data/20261120T050007Z-9f3a1c2b',
      },
      {
        input: Readable.from(
          [schemaLine('orders'), recordLine('orders', 1), stateLine('orders')].map(
            (line) => `${line}\n`
          )
        ),
        stdout: new BufferingWritable(),
        stderr: new BufferingWritable(),
      }
    );

    const file = path.join(
      outputDir,
      'orders',
      'data',
      '20261120T050007Z-9f3a1c2b',
      'orders-0.parquet'
    );
    expect((await fs.stat(file)).isFile()).toBe(true);
    expect(await queryRows(`SELECT id FROM read_parquet('${file}')`)).toEqual([{ id: 1 }]);
  });

  describe('Parquet batches', () => {
    let batchPath: string;
    const batchLines = (stream: string) => [
      schemaLine(stream),
      JSON.stringify({
        _v: 1,
        type: 'BATCH',
        stream,
        encoding: { format: 'parquet' },
        manifest: [pathToFileURL(batchPath).href],
      }),
      stateLine(stream),
    ];

    beforeEach(async () => {
      batchPath = path.join(tempDir, 'batch.parquet');
      await fs.writeFile(batchPath, 'batch');
    });

    it('publishes a matching Parquet batch without converting it when the option is off', async () => {
      const { converts, published } = await run({ ...baseConfig }, batchLines('orders'));

      expect(converts).toHaveLength(0);
      expect(published).toEqual(['orders/orders-0.parquet']);
    });

    it('publishes a matching Parquet batch under the subfolder without converting it', async () => {
      const { converts, published } = await run(
        { ...baseConfig, streamSubfolder: 'data/run-1' },
        batchLines('orders')
      );

      expect(converts).toHaveLength(0);
      expect(published).toEqual(['orders/data/run-1/orders-0.parquet']);
    });
  });
});
