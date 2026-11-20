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
  async function staged(
    name: string,
    body: Buffer,
    key = name,
    claimedSize = body.length,
    extra: Record<string, unknown> = {}
  ) {
    // The extractor keeps its temp files in a folder with this prefix.
    const folder = path.join(tempDir, 'dogsled-copy-test');
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, name);
    await fs.writeFile(file, body);
    const line = `${JSON.stringify({
      _v: 1,
      type: 'FILE',
      stream: 'drops',
      uri: pathToFileURL(file).href,
      relative_key: key,
      size: claimedSize,
      ...extra,
    })}\n`;
    return { file, line, key, body };
  }

  async function load(
    lines: string[],
    destination: FileDestination,
    config: FileDestConfig = baseConfig,
    stdout: Writable = new BufferingWritable(),
    stderr: Writable = new BufferingWritable()
  ) {
    const result = await runFileLoader(config, {
      createDestination: () => destination,
      createDuckDbWriter: async () => ({ async convertFile() {}, async close() {} }),
      input: Readable.from(lines),
      stdout,
      stderr,
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

  const s3Config = (objectMetadata?: Record<string, string>): FileDestConfig => ({
    dest: 's3',
    format: 'parquet',
    outputDir: '/unused',
    s3Bucket: 'landing-bucket',
    bufferSize: 1,
    logFormat: 'text',
    ...(objectMetadata ? { objectMetadata } : {}),
  });
  const gcsConfig = (objectMetadata?: Record<string, string>): FileDestConfig => ({
    dest: 'gcs',
    format: 'parquet',
    outputDir: '/unused',
    gcsBucket: 'landing-bucket',
    bufferSize: 1,
    logFormat: 'text',
    ...(objectMetadata ? { objectMetadata } : {}),
  });
  const source = { source_key: 'incoming/2026/café.pdf', modified: '2026-11-20T15:24:53.408Z' };
  // Each value is US-ASCII on the object: a space and an accented letter are percent-encoded.
  const expectedMetadata = {
    team: 'data',
    'run-id': 'run%201',
    'dogsled-source': 'incoming/2026/caf%C3%A9.pdf',
    'dogsled-source-modified': '2026-11-20T15:24:53.408Z',
  };

  it('stores the configured metadata, the source key and the modified time on an S3 object', async () => {
    const inputs: Array<Record<string, unknown>> = [];
    const client = {
      async send(command: { input: Record<string, unknown> }) {
        for await (const chunk of command.input['Body'] as AsyncIterable<Buffer>) void chunk;
        inputs.push(command.input);
        return {};
      },
    };
    const file = await staged('a.pdf', Buffer.from('%PDF'), '2026/café.pdf', 4, source);

    await load(
      [file.line],
      new S3Destination({ bucket: 'landing-bucket', format: 'parquet', client }),
      s3Config({ team: 'data', 'run-id': 'run 1' })
    );

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      Key: 'drops/2026/café.pdf',
      ChecksumAlgorithm: 'SHA256',
      Metadata: expectedMetadata,
    });
  });

  it('stores the same metadata on a GCS object, and leaves out what the sender did not give', async () => {
    const uploads: Array<Record<string, unknown>> = [];
    const storage = {
      bucket: () => ({
        async upload(_localPath: string, options: Record<string, unknown>) {
          uploads.push(options);
        },
      }),
    };
    const dated = await staged('a.pdf', Buffer.from('%PDF'), '2026/café.pdf', 4, source);
    const undated = await staged('b.pdf', Buffer.from('%PDF'), 'b.pdf', 4, { source_key: 'b.pdf' });
    // A sender that gives no source key must not get the relative key written in its place.
    const bare = await staged('c.pdf', Buffer.from('%PDF'), 'c.pdf');

    await load(
      [dated.line, undated.line, bare.line],
      new GcsDestination({ bucket: 'landing-bucket', format: 'parquet', storage }),
      gcsConfig({ team: 'data', 'run-id': 'run 1' })
    );

    const byKey = new Map(uploads.map((upload) => [upload['destination'], upload]));
    expect(byKey.get('drops/2026/café.pdf')).toMatchObject({
      validation: 'crc32c',
      metadata: { metadata: expectedMetadata },
    });
    expect(byKey.get('drops/b.pdf')?.['metadata']).toEqual({
      metadata: { team: 'data', 'run-id': 'run%201', 'dogsled-source': 'b.pdf' },
    });
    expect(byKey.get('drops/c.pdf')?.['metadata']).toEqual({
      metadata: { team: 'data', 'run-id': 'run%201' },
    });
  });

  it('stores the source key and modified time on every copy, with no object_metadata set', async () => {
    const inputs: Array<Record<string, unknown>> = [];
    const client = {
      async send(command: { input: Record<string, unknown> }) {
        for await (const chunk of command.input['Body'] as AsyncIterable<Buffer>) void chunk;
        inputs.push(command.input);
        return {};
      },
    };
    const file = await staged('a.pdf', Buffer.from('%PDF'), 'a.pdf', 4, source);

    await load(
      [file.line],
      new S3Destination({ bucket: 'landing-bucket', format: 'parquet', client }),
      s3Config()
    );

    expect(inputs[0]?.['Metadata']).toEqual({
      'dogsled-source': 'incoming/2026/caf%C3%A9.pdf',
      'dogsled-source-modified': '2026-11-20T15:24:53.408Z',
    });
  });

  it('leaves dogsled-source off files whose key would not fit, says so once, and still writes them', async () => {
    const inputs: Array<Record<string, unknown>> = [];
    const client = {
      async send(command: { input: Record<string, unknown> }) {
        for await (const chunk of command.input['Body'] as AsyncIterable<Buffer>) void chunk;
        inputs.push(command.input);
        return {};
      },
    };
    // A legal key of about 700 bytes. Each character takes 3 bytes, and 9 once percent-encoded, so
    // it would pass the 2,048 bytes an object may hold by itself. It is no reason to stop a run.
    const longKey = `incoming/${'界'.repeat(230)}.pdf`;
    const short = await staged('a.pdf', Buffer.from('%PDF'), 'a.pdf', 4, {
      source_key: 'incoming/a.pdf',
      modified: source.modified,
    });
    const long = await staged('b.pdf', Buffer.from('%PDF'), 'b.pdf', 4, {
      source_key: longKey,
      modified: source.modified,
    });
    const longer = await staged('c.pdf', Buffer.from('%PDF'), 'c.pdf', 4, {
      source_key: `${longKey}.1`,
      modified: source.modified,
    });
    const stderr = new BufferingWritable();

    await load(
      [short.line, long.line, longer.line],
      new S3Destination({ bucket: 'landing-bucket', format: 'parquet', client }),
      s3Config(),
      new BufferingWritable(),
      stderr
    );

    const metadataByKey = new Map(inputs.map((input) => [input['Key'], input['Metadata']]));
    expect(metadataByKey.get('drops/a.pdf')).toEqual({
      'dogsled-source': 'incoming/a.pdf',
      'dogsled-source-modified': source.modified,
    });
    for (const key of ['drops/b.pdf', 'drops/c.pdf']) {
      expect(metadataByKey.get(key)).toEqual({ 'dogsled-source-modified': source.modified });
    }
    // One warning names a file, and the run ends with a count, so a stream that loses the entry
    // on every file does not log a line for each.
    const warnings = stderr
      .toString()
      .split('\n')
      .filter((line) => line.includes('WARN'));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(
      /^\[loader\] WARN drops: left dogsled-source off "[bc]\.pdf": it would take the object's metadata past 2048 bytes$/
    );
    expect(warnings[1]).toBe('[loader] WARN drops: left dogsled-source off 2 files in all');
    expect(await exists(long.file)).toBe(false);
    expect(await exists(longer.file)).toBe(false);
  });

  it('refuses a write whose own object_metadata passes what S3 keeps, and writes nothing', async () => {
    const sends: unknown[] = [];
    const client = {
      async send(command: unknown) {
        sends.push(command);
        return {};
      },
    };
    // The config check refuses this before a run starts. It is built by hand here to reach the
    // last check, which no key a file can have should ever reach.
    const file = await staged('a.pdf', Buffer.from('%PDF'), 'a.pdf', 4, source);

    await expect(
      load(
        [file.line],
        new S3Destination({ bucket: 'landing-bucket', format: 'parquet', client }),
        s3Config({ note: 'x'.repeat(2100) })
      )
    ).rejects.toThrow(
      /Failed to load stream "drops" to s3: Object metadata is \d+ bytes, over the 2048/
    );
    expect(sends).toEqual([]);
    expect(await exists(file.file)).toBe(true);
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

    await expect(load([tooLong.line], make(prefix))).rejects.toMatchObject({
      message: expect.stringMatching(/1,024 bytes/),
      exitCode: 2,
    });
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

  it('names the stream and destination in the error, so a pipeline can attribute the failure', async () => {
    const item = await staged('odd\\name.txt', Buffer.from('odd'));

    await expect(load([item.line], { publish: async () => 'never' })).rejects.toThrow(
      /^Failed to load stream "drops" to local: Refusing to copy/
    );
  });

  it('logs a key with a format character as an escape, so it cannot rewrite a line', async () => {
    const item = await staged('bidi.txt', Buffer.from('x'), 'a\u202Eb.txt');
    const stderr = new BufferingWritable();

    await load(
      [item.line],
      { publish: async (_file, destPath) => `file:///out/${destPath}` },
      baseConfig,
      undefined,
      stderr
    );

    expect(stderr.toString()).toContain('a\\u202eb.txt');
    expect(stderr.toString()).not.toContain('\u202e');
  });

  const fileLine = (file: string, key: string, size: number): string =>
    `${JSON.stringify({
      _v: 1,
      type: 'FILE',
      stream: 'drops',
      uri: pathToFileURL(file).href,
      relative_key: key,
      size,
    })}\n`;

  it('leaves alone a file that a uri places on another host', async () => {
    const line = fileLine('/share/dogsled-copy-x/1', 'a.csv', 1).replace(
      'file:///share',
      'file://files.example.com/share'
    );

    await expect(load([line], { publish: async () => 'never' })).rejects.toThrow(
      'its temp file is on another host'
    );
  });

  it('leaves alone a file in a folder that is a link to another folder', async () => {
    const elsewhere = path.join(tempDir, 'elsewhere');
    await fs.mkdir(elsewhere, { mode: 0o700 });
    await fs.writeFile(path.join(elsewhere, 'secret.txt'), 'secret');
    const link = path.join(tempDir, 'dogsled-copy-link');
    await fs.symlink(elsewhere, link);

    await expect(
      load([fileLine(path.join(link, 'secret.txt'), 'loot.txt', 6)], {
        publish: async () => 'never',
      })
    ).rejects.toThrow('is a link, or is not a folder');
    expect(await fs.readFile(path.join(elsewhere, 'secret.txt'), 'utf8')).toBe('secret');
  });

  it.skipIf(process.platform === 'win32')(
    'leaves alone a file in a folder that others can write to',
    async () => {
      const item = await staged('shared.txt', Buffer.from('mine'));
      await fs.chmod(path.dirname(item.file), 0o777);

      await expect(load([item.line], { publish: async () => 'never' })).rejects.toThrow(
        'can be written by other users (mode 777)'
      );
      expect(await exists(item.file)).toBe(true);
    }
  );

  it('leaves alone a file that has a second link', async () => {
    const item = await staged('linked.txt', Buffer.from('mine'));
    const other = path.join(tempDir, 'other-name.txt');
    await fs.link(item.file, other);

    await expect(load([item.line], { publish: async () => 'never' })).rejects.toThrow('one link');
    expect(await exists(item.file)).toBe(true);
    expect(await exists(other)).toBe(true);
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
    ).rejects.toThrow(/^Failed to load stream "drops" to mysql: it copies files/);
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
