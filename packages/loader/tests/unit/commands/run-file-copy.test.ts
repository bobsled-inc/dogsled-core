import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runDryRun } from '../../../src/commands/run-dry-run.js';
import { runDatabaseLoader, runFileLoader } from '../../../src/commands/run.js';
import { GcsDestination } from '../../../src/runtime/destinations/gcs.js';
import { LocalDestination } from '../../../src/runtime/destinations/local.js';
import { S3Destination } from '../../../src/runtime/destinations/s3.js';
import { BufferingWritable } from '../../helpers/stream.js';

import type { FileDestConfig } from '../../../src/schemas/config.js';
import type { FileDestination } from '../../../src/runtime/destinations/types.js';

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (file: string): Promise<boolean> =>
  fs.access(file).then(
    () => true,
    () => false
  );

const baseConfig = {
  dest: 'local',
  format: 'parquet',
  outputDir: '/unused',
  bufferSize: 1,
  logFormat: 'text',
} as const satisfies FileDestConfig;

describe('runFileLoader: FILE messages', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-copy-loader-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** A temp file the extractor made, and the FILE line that names it. */
  async function staged(name: string, body: Buffer, key = name, claimedSize = body.length) {
    // The extractor keeps its temp files in a folder with this prefix.
    const folder = path.join(tempDir, 'dogsled-copy-test');
    await fs.mkdir(folder, { recursive: true });
    const file = path.join(folder, name);
    await fs.writeFile(file, body);
    const line = `${JSON.stringify({
      _v: 1,
      type: 'FILE',
      stream: 'drops',
      uri: pathToFileURL(file).href,
      relative_key: key,
      size: claimedSize,
    })}\n`;
    return { file, line, key, body };
  }

  async function load(
    lines: string[],
    destination: FileDestination,
    config: FileDestConfig = baseConfig,
    stdout: Writable = new BufferingWritable()
  ) {
    const result = await runFileLoader(config, {
      createDestination: () => destination,
      createDuckDbWriter: async () => ({ async convertFile() {}, async close() {} }),
      input: Readable.from(lines),
      stdout,
      stderr: new BufferingWritable(),
    });
    return result;
  }

  it('moves every kind of file, unchanged, to <stream>/<subfolder>/<key> on local disk', async () => {
    const outputDir = path.join(tempDir, 'out');
    const files = await Promise.all([
      staged('orders.csv', Buffer.from('id,name\n1,Ada\n'), 'orders.csv'),
      staged('orders.csv.gz', gzipSync('id,name\n1,Ada\n'), 'orders.csv.gz'),
      staged(
        'part.parquet',
        Buffer.from([0x50, 0x41, 0x52, 0x31, 0, 255, 254]),
        'data/part.parquet'
      ),
      staged('empty.dat', Buffer.alloc(0), 'a/b/empty.dat'),
    ]);

    const result = await load(
      files.map((file) => file.line),
      new LocalDestination({ outputDir }),
      { ...baseConfig, outputDir, streamSubfolder: 'run-1' }
    );

    for (const file of files) {
      const written = await fs.readFile(path.join(outputDir, 'drops', 'run-1', file.key));
      expect(sha256(written)).toBe(sha256(file.body));
      expect(await exists(file.file)).toBe(false);
    }
    expect(result.publishedFiles.map((entry) => entry.destinationPath).sort()).toEqual(
      files.map((file) => `drops/run-1/${file.key}`).sort()
    );
  });

  it('puts the bytes in S3 under <prefix>/<stream>/<key> with no content type', async () => {
    const sent: Array<{ key: string; contentType?: string; checksum?: string; bytes: Buffer }> = [];
    const client = {
      async send(command: { input: Record<string, unknown> }) {
        const chunks: Buffer[] = [];
        for await (const chunk of command.input['Body'] as AsyncIterable<Buffer>) {
          chunks.push(chunk);
        }
        sent.push({
          key: command.input['Key'] as string,
          contentType: command.input['ContentType'] as string | undefined,
          checksum: command.input['ChecksumAlgorithm'] as string | undefined,
          bytes: Buffer.concat(chunks),
        });
        return {};
      },
    };
    const file = await staged('a.pdf', Buffer.from('%PDF-1.7 ÿþ'), '2026/a.pdf');

    await load(
      [file.line],
      new S3Destination({ bucket: 'landing-bucket', prefix: 'raw', format: 'parquet', client })
    );

    expect(sent).toEqual([
      {
        key: 'raw/drops/2026/a.pdf',
        contentType: undefined,
        checksum: 'SHA256',
        bytes: file.body,
      },
    ]);
    expect(await exists(file.file)).toBe(false);
  });

  it('uploads to GCS as stored, with the CRC32C check and no content type', async () => {
    const uploads: Array<{ options: Record<string, unknown>; bytes: Buffer }> = [];
    const storage = {
      bucket: () => ({
        async upload(localPath: string, options: Record<string, unknown>) {
          uploads.push({ options, bytes: await fs.readFile(localPath) });
        },
      }),
    };
    const stored = gzipSync('id,name\n1,Ada\n');
    const file = await staged('events.csv', stored, 'events.csv');

    await load(
      [file.line],
      new GcsDestination({ bucket: 'landing-bucket', prefix: 'raw', format: 'parquet', storage })
    );

    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.options).toEqual({
      destination: 'raw/drops/events.csv',
      validation: 'crc32c',
    });
    expect(sha256(uploads[0]!.bytes)).toBe(sha256(stored));
    expect(await exists(file.file)).toBe(false);
  });

  const emptyOrDot = /empty, "\." or "\.\." folder/;
  const unsafeKeys: Array<[string, string, RegExp]> = [
    ['a backslash', 'a\\b.csv', /backslash/],
    ['an empty folder', 'a//b.csv', emptyOrDot],
    ['a leading slash', '/abs.csv', emptyOrDot],
    ['a dot folder', './a.csv', emptyOrDot],
    ['a dot folder inside the key', 'a/./b.csv', emptyOrDot],
    ['a dot-dot folder', 'a/../b.csv', emptyOrDot],
    ['a leading dot-dot folder', '../a.csv', emptyOrDot],
    ['a trailing slash', 'dir/', emptyOrDot],
    ['a control character', 'a\u0001b.csv', /control character/],
    ['a delete character', 'a\u007fb.csv', /control character/],
    ['a C1 control character', 'a\u0085b.csv', /control character/],
  ];

  it.each(unsafeKeys)('refuses a key with %s and writes nothing', async (_label, key, reason) => {
    const published: string[] = [];
    const file = await staged('safe-name.csv', Buffer.from('x'), key);

    await expect(
      load([file.line], {
        async publish(_local, destinationPath) {
          published.push(destinationPath);
          return destinationPath;
        },
      })
    ).rejects.toThrow(reason);

    expect(published).toEqual([]);
    expect(await exists(file.file)).toBe(true);
  });

  it.each([
    [
      'S3',
      (prefix: string) =>
        new S3Destination({ bucket: 'landing-bucket', prefix, client: { send: async () => ({}) } }),
    ],
    [
      'GCS',
      (prefix: string) =>
        new GcsDestination({
          bucket: 'landing-bucket',
          prefix,
          storage: { bucket: () => ({ upload: async () => undefined }) },
        }),
    ],
  ])('refuses a %s key over 1,024 bytes, counting the prefix and stream', async (_label, make) => {
    // <100 byte prefix>/drops/<key>: a 917 byte key makes exactly 1,024 bytes.
    const prefix = 'p'.repeat(100);
    const fits = await staged('fits.bin', Buffer.from('x'), 'k'.repeat(917));
    const tooLong = await staged('long.bin', Buffer.from('x'), 'k'.repeat(918));

    await load([fits.line], make(prefix));
    expect(await exists(fits.file)).toBe(false);

    await expect(load([tooLong.line], make(prefix))).rejects.toThrow(/1,024 bytes/);
    expect(await exists(tooLong.file)).toBe(true);
  });

  it('leaves alone a file that is not in an extractor temp folder', async () => {
    const stranger = path.join(tempDir, 'notes.txt');
    await fs.writeFile(stranger, 'mine');
    const line = `${JSON.stringify({
      _v: 1,
      type: 'FILE',
      stream: 'drops',
      uri: pathToFileURL(stranger).href,
      relative_key: 'notes.txt',
      size: 4,
    })}\n`;

    await expect(load([line], { publish: async () => 'never' })).rejects.toThrow(
      'not in a dogsled-copy- folder'
    );
    expect(await fs.readFile(stranger, 'utf8')).toBe('mine');
  });

  it('refuses a file whose size is not the size the message states', async () => {
    const file = await staged('a.csv', Buffer.from('12345'), 'a.csv', 9);

    await expect(load([file.line], { publish: async () => 'never' })).rejects.toThrow(/size/);
  });

  it('writes up to 8 files at once and finishes them all', async () => {
    let active = 0;
    let peak = 0;
    const done: string[] = [];
    const files = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        staged(`f${index}.bin`, Buffer.from(`body ${index}`))
      )
    );

    const result = await load(
      files.map((file) => file.line),
      {
        async publish(local, destinationPath) {
          active += 1;
          peak = Math.max(peak, active);
          await sleep(15);
          active -= 1;
          done.push(destinationPath);
          void local;
          return `mem://${destinationPath}`;
        },
      }
    );

    expect(peak).toBe(8);
    expect(done).toHaveLength(12);
    expect(result.publishedFiles).toHaveLength(12);
    for (const file of files) expect(await exists(file.file)).toBe(false);
  });

  it('forwards STATE only after the files before it are written', async () => {
    const events: string[] = [];
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        events.push('state forwarded');
        callback();
      },
    });
    const file = await staged('a.csv', Buffer.from('x'));
    const state = `${JSON.stringify({ _v: 1, type: 'STATE', stream: 'drops', value: { record_count: 0 } })}\n`;

    await load(
      [file.line, state],
      {
        async publish() {
          await sleep(30);
          events.push('file written');
          return 'mem://a.csv';
        },
      },
      baseConfig,
      stdout
    );

    expect(events).toEqual(['file written', 'state forwarded']);
  });

  it('fails when a write fails, even though the sender keeps the stream open', async () => {
    const input = new PassThrough();
    const file = await staged('a.csv', Buffer.from('x'));
    input.write(file.line);

    const run = runFileLoader(baseConfig, {
      createDestination: () => ({
        async publish() {
          throw new Error('access denied by the bucket');
        },
      }),
      createDuckDbWriter: async () => ({ async convertFile() {}, async close() {} }),
      input,
      stdout: new BufferingWritable(),
      stderr: new BufferingWritable(),
    });

    await expect(run).rejects.toThrow('access denied by the bucket');
    expect(await exists(file.file)).toBe(true);
  });
});

describe('runDatabaseLoader: FILE messages', () => {
  it('fails instead of ignoring a file it cannot copy', async () => {
    const line = `${JSON.stringify({
      _v: 1,
      type: 'FILE',
      stream: 'drops',
      uri: 'file:///tmp/a.csv',
      relative_key: 'a.csv',
      size: 1,
    })}\n`;

    await expect(
      runDatabaseLoader(
        {
          dest: 'mysql',
          host: 'localhost',
          database: 'analytics',
          user: 'mysql',
          bufferSize: 1,
          logFormat: 'text',
        },
        {
          createDatabaseDestination: () =>
            ({
              initialize: async () => undefined,
              close: async () => undefined,
              getTruncatedTables: () => new Set(),
              setTruncatedTables: () => undefined,
            }) as never,
          input: Readable.from([line]),
          stdout: new BufferingWritable(),
          stderr: new BufferingWritable(),
        }
      )
    ).rejects.toThrow(/file destination/);
  });
});

describe('runDryRun: FILE messages', () => {
  it('fails instead of reading to the end, which would leave the sender waiting', async () => {
    const line = `${JSON.stringify({
      _v: 1,
      type: 'FILE',
      stream: 'drops',
      uri: 'file:///tmp/dogsled-copy-x/1',
      relative_key: 'a.csv',
      size: 1,
    })}\n`;

    await expect(
      runDryRun({}, { input: Readable.from([line]), stderr: new BufferingWritable() })
    ).rejects.toThrow('--dry-run cannot preview it');
  });
});
