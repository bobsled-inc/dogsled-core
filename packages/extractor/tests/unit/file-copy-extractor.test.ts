import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileCopyResourceSpecSchema } from '../../src/framework/extractor/file-copy-resource.js';
import { GcsFileStorageClient } from '../../src/runtime/clients/gcs-file-client.js';
import { globToRegExp } from '../../src/runtime/clients/path-glob.js';
import { ControlLogger } from '../../src/runtime/control.js';
import { Emitter } from '../../src/runtime/emitter.js';
import { createFileStorageClient } from '../../src/runtime/file-storage-client.js';
import { extractFileCopyResource } from '../../src/runtime/file-copy-extractor.js';
import { ExtractorStateSchema } from '../../src/schemas/state.js';
import { FakeWritable } from '../helpers/fixtures.js';

import type { FileStorageClient, ListedFile } from '../../src/framework/core/index.js';
import type { ExtractorState, IntegrationSpec } from '../../src/types/index.js';
import type { StateStore } from '../../src/runtime/state.js';

vi.mock('../../src/runtime/file-storage-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime/file-storage-client.js')>();
  return { createFileStorageClient: vi.fn(actual.createFileStorageClient) };
});

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Minutes after noon UTC; negative values go back. */
const at = (minutes: number): string => new Date(Date.UTC(2026, 10, 19, 12, minutes)).toISOString();

const integration = (source_type: 's3' | 'gcs' | 'sftp' | 'local', baseDirectory = '/unused') =>
  ({
    spec_version: '1',
    type: 'integration',
    name: 'landing',
    source_type,
    // Only `source_type` matters here; the client is faked.
    connection:
      source_type === 'local' ? { base_directory: baseDirectory } : { bucket: 'landing-bucket' },
    auth: { type: 'none' },
  }) as IntegrationSpec;

const resource = (overrides: Record<string, unknown> = {}) =>
  FileCopyResourceSpecSchema.parse({
    spec_version: '1',
    type: 'resource',
    name: 'drops',
    integration: 'landing',
    source: { kind: 'copy', path: 'incoming/**/*' },
    replication: { method: 'incremental_append', cursor: { field: 'last_modified' } },
    ...overrides,
  });

interface StoredFile {
  key: string;
  body: Buffer;
  modified: string;
  etag: string;
}

/** An S3-like store in memory. Counts downloads that overlap and the bytes held on disk. */
function fakeStore(files: StoredFile[], options: { failOn?: string; unlistedSize?: boolean } = {}) {
  const probe = {
    activeDownloads: 0,
    peakDownloads: 0,
    heldBytes: 0,
    peakHeldBytes: 0,
  };
  const client: FileStorageClient = {
    async *list({ path: pattern }) {
      const matcher = globToRegExp(pattern, 'fake');
      for (const file of files.filter((candidate) => matcher.test(candidate.key))) {
        yield {
          path: file.key,
          uri: `s3://landing-bucket/${file.key}`,
          last_modified: file.modified,
          etag: file.etag,
          size: options.unlistedSize ? undefined : file.body.length,
        } satisfies ListedFile;
      }
    },
    async download(file, target) {
      probe.activeDownloads += 1;
      probe.peakDownloads = Math.max(probe.peakDownloads, probe.activeDownloads);
      await sleep(5);
      if (file.path === options.failOn) {
        probe.activeDownloads -= 1;
        throw new Error(`connection reset while reading ${file.path}`);
      }
      const stored = files.find((candidate) => candidate.key === file.path)!;
      await writeFile(target, stored.body);
      probe.activeDownloads -= 1;
      probe.heldBytes += stored.body.length;
      probe.peakHeldBytes = Math.max(probe.peakHeldBytes, probe.heldBytes);
      return { file, path: target, bytes_downloaded: stored.body.length };
    },
    async close() {},
  };
  return { client, probe };
}

/**
 * Stands in for the loader: reads each FILE's temp file, then deletes it after a delay, as the
 * loader does once its write is done.
 */
class LoaderStandIn extends FakeWritable {
  readonly copies: Array<{ key: string; bytes: Buffer; size: number }> = [];
  readonly events: string[] = [];
  readonly messages: Array<Record<string, unknown>> = [];
  private readonly consuming: Promise<void>[] = [];

  constructor(
    private readonly onDeleted: (bytes: number) => void = () => {},
    private readonly deleteAfterMs = 15,
    private readonly consumes = true
  ) {
    super();
  }

  override write(chunk: string): boolean {
    super.write(chunk);
    if (chunk.trim() === '') return true; // the keep-alive line, which readers skip
    const message = JSON.parse(chunk) as Record<string, unknown>;
    this.messages.push(message);
    if (message['type'] === 'FILE' && this.consumes) this.consuming.push(this.consume(message));
    if (message['type'] === 'STATE') this.events.push('state');
    return true;
  }

  async settled(): Promise<void> {
    await Promise.all(this.consuming);
  }

  private async consume(message: Record<string, unknown>): Promise<void> {
    const file = fileURLToPath(message['uri'] as string);
    const bytes = await readFile(file);
    this.copies.push({
      key: message['relative_key'] as string,
      bytes,
      size: message['size'] as number,
    });
    await sleep(this.deleteAfterMs);
    // A run that failed has already removed its folder.
    await rm(file, { force: true });
    this.onDeleted(bytes.length);
    this.events.push(`deleted:${message['relative_key'] as string}`);
  }
}

function stateStore(state: ExtractorState, events?: string[]): StateStore {
  return {
    load: vi.fn().mockResolvedValue(state),
    save: vi.fn().mockImplementation(async (next: ExtractorState) => {
      events?.push('saved');
      state.streams = next.streams;
    }),
  };
}

async function run(
  client: FileStorageClient | undefined,
  state: ExtractorState,
  options: {
    spec?: ReturnType<typeof resource>;
    source?: IntegrationSpec;
    onDeleted?: (bytes: number) => void;
    loader?: LoaderStandIn;
    pingMs?: number;
    budget?: number;
    limit?: number;
    advanceState?: boolean;
    signal?: AbortSignal;
    nowMs?: () => number;
  } = {}
) {
  if (client) vi.mocked(createFileStorageClient).mockResolvedValueOnce(client);
  const loader = options.loader ?? new LoaderStandIn(options.onDeleted);
  const stderr = new FakeWritable();
  const store = stateStore(state, loader.events);
  const result = await extractFileCopyResource({
    integration: options.source ?? integration('s3'),
    resource: options.spec ?? resource(),
    integrationName: 'landing',
    emitter: new Emitter('stdout', 'output', { stdoutStream: loader }),
    logger: new ControlLogger({ stream: stderr }),
    state,
    stateStore: store,
    advanceState: options.advanceState ?? true,
    limit: options.limit,
    stagingBudgetBytes: options.budget,
    pollMs: 2,
    pingMs: options.pingMs,
    signal: options.signal,
    // After every time in these tests, so the clock does not decide what they expect.
    nowMs: options.nowMs ?? (() => Date.UTC(2030, 0, 1)),
  });
  await loader.settled();
  const metrics = stderr.chunks
    .map((line) => JSON.parse(line) as { type: string; metrics?: Record<string, number> })
    .filter((line) => line.type === 'METRIC');
  return { loader, result, metrics, store };
}

const file = (
  key: string,
  minutes: number,
  body = key,
  etag = `etag-${key}-${body}`
): StoredFile => ({
  key: `incoming/${key}`,
  body: Buffer.from(body),
  modified: at(minutes),
  etag,
});
const keys = (loader: LoaderStandIn): string[] => loader.copies.map((copy) => copy.key).sort();

afterEach(() => {
  vi.mocked(createFileStorageClient).mockReset();
});

describe('copy extractor: S3 and GCS time-based state', () => {
  it('copies a new file, skips an unchanged one, copies an overwritten one again', async () => {
    const files = [file('a.csv', 0), file('2026/b.csv', 10)];
    const state: ExtractorState = { streams: {} };

    const first = await run(fakeStore(files).client, state);
    expect(keys(first.loader)).toEqual(['2026/b.csv', 'a.csv']);
    expect(first.loader.copies.find((copy) => copy.key === 'a.csv')?.bytes.toString()).toBe(
      'a.csv'
    );
    expect(state.streams['landing/drops']).toMatchObject({ watermark: at(10) });
    // Hosts and the file store validate saved state against this schema.
    expect(ExtractorStateSchema.parse(state).streams['landing/drops']?.recent).toEqual({
      'incoming/a.csv': 'etag-a.csv-a.csv',
      'incoming/2026/b.csv': expect.any(String),
    });

    const second = await run(fakeStore(files).client, state);
    expect(second.loader.copies).toEqual([]);

    files[1] = file('2026/b.csv', 20, 'new content');
    const third = await run(fakeStore(files).client, state);
    expect(third.loader.copies.map((copy) => [copy.key, copy.bytes.toString()])).toEqual([
      ['2026/b.csv', 'new content'],
    ]);
    expect(state.streams['landing/drops']).toMatchObject({ watermark: at(20) });
  });

  it('takes a late file inside the lookback, never one outside it, and keeps the watermark', async () => {
    const files = [file('a.csv', 100)];
    const state: ExtractorState = { streams: {} };
    await run(fakeStore(files).client, state);

    files.push(file('late.csv', 100 - 30), file('too-late.csv', 100 - 90));
    const second = await run(fakeStore(files).client, state);

    expect(keys(second.loader)).toEqual(['late.csv']);
    expect(state.streams['landing/drops']).toMatchObject({ watermark: at(100) });
  });

  it('honours a configured lookback', async () => {
    const files = [file('a.csv', 100)];
    const state: ExtractorState = { streams: {} };
    const spec = resource({
      replication: {
        method: 'incremental_append',
        cursor: { field: 'last_modified', lookback_seconds: 0 },
      },
    });
    await run(fakeStore(files).client, state, { spec });

    files.push(file('late.csv', 99));
    const second = await run(fakeStore(files).client, state, { spec });

    expect(second.loader.copies).toEqual([]);
  });

  it('keeps the watermark at the present, so a file dated in the future cannot hide later ones', async () => {
    const state: ExtractorState = { streams: {} };
    const ahead = file('clock.csv', 60 * 24); // a store whose clock runs a day ahead

    await run(fakeStore([file('a.csv', 0), ahead]).client, state, {
      nowMs: () => Date.parse(at(60)),
    });
    expect(state.streams['landing/drops']).toMatchObject({ watermark: at(60) });

    const files = [file('a.csv', 0), ahead, file('late.csv', 100)];
    const second = await run(fakeStore(files).client, state, { nowMs: () => Date.parse(at(120)) });

    expect(keys(second.loader)).toEqual(['late.csv']);
  });

  it('finishes a backlog past the cap on the next run, oldest first, ties by key', async () => {
    const files = [
      file('e.csv', 5),
      file('b.csv', 2),
      file('a.csv', 1),
      file('d.csv', 4),
      file('c.csv', 3),
      file('z.csv', 1),
    ];
    const state: ExtractorState = { streams: {} };
    const spec = resource({ limits: { max_files_per_run: 2 } });

    const batches: string[][] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const next = await run(fakeStore(files).client, state, { spec });
      batches.push(keys(next.loader));
    }

    expect(batches).toEqual([['a.csv', 'z.csv'], ['b.csv', 'c.csv'], ['d.csv', 'e.csv'], []]);
  });

  it('fails an oversize file by name, before it copies anything', async () => {
    const files = [file('small.csv', 0, 'tiny'), file('huge.bin', 1, 'x'.repeat(32))];
    const state: ExtractorState = { streams: {} };

    await expect(
      run(fakeStore(files).client, state, {
        spec: resource({ limits: { max_file_size_bytes: 10 } }),
      })
    ).rejects.toThrow(/s3:\/\/landing-bucket\/incoming\/huge\.bin.*max_file_size_bytes/);
    expect(state.streams).toEqual({});
  });

  it('keeps up to 8 downloads in flight and the files on disk under the budget', async () => {
    const files = Array.from({ length: 20 }, (_, index) =>
      file(`f${String(index).padStart(2, '0')}.bin`, index, 'x'.repeat(100))
    );
    const store = fakeStore(files);

    const wide = await run(
      store.client,
      { streams: {} },
      {
        onDeleted: (bytes) => (store.probe.heldBytes -= bytes),
        budget: 10_000,
      }
    );
    expect(wide.loader.copies).toHaveLength(20);
    expect(store.probe.peakDownloads).toBe(8);

    const narrow = fakeStore(files);
    const run2 = await run(
      narrow.client,
      { streams: {} },
      {
        onDeleted: (bytes) => (narrow.probe.heldBytes -= bytes),
        budget: 350,
      }
    );
    expect(run2.loader.copies).toHaveLength(20);
    expect(narrow.probe.peakHeldBytes).toBeLessThanOrEqual(350);
  });

  it('reserves the largest size a file may have for a file whose listing gives none', async () => {
    const files = ['a', 'b', 'c'].map((name, index) => file(`${name}.bin`, index, 'x'.repeat(100)));
    const store = fakeStore(files, { unlistedSize: true });

    const { loader } = await run(
      store.client,
      { streams: {} },
      {
        spec: resource({ limits: { max_file_size_bytes: 5000 } }),
        onDeleted: (bytes) => (store.probe.heldBytes -= bytes),
        budget: 6000,
      }
    );

    expect(keys(loader)).toEqual(['a.bin', 'b.bin', 'c.bin']);
    // Two such files would need 10,000 bytes of the 6,000 budget, so they go one at a time.
    expect(store.probe.peakDownloads).toBe(1);
  });

  it('always admits one file, even one bigger than the whole budget', async () => {
    const files = [file('big.bin', 0, 'x'.repeat(500)), file('small.bin', 1, 'y')];
    const store = fakeStore(files);

    const { loader } = await run(
      store.client,
      { streams: {} },
      {
        onDeleted: (bytes) => (store.probe.heldBytes -= bytes),
        budget: 100,
      }
    );

    expect(keys(loader)).toEqual(['big.bin', 'small.bin']);
  });

  it('saves state and sends STATE only after the loader has deleted every temp file', async () => {
    const files = [file('a.csv', 0), file('b.csv', 1), file('c.csv', 2)];

    const { loader } = await run(fakeStore(files).client, { streams: {} });

    const last = loader.events.length - 1;
    expect(loader.events.slice(0, 3).sort()).toEqual([
      'deleted:a.csv',
      'deleted:b.csv',
      'deleted:c.csv',
    ]);
    expect(loader.events.slice(last - 1)).toEqual(['saved', 'state']);
  });

  it('leaves state alone when a download fails, so the next run copies the file', async () => {
    const files = [file('a.csv', 0), file('b.csv', 1)];
    const state: ExtractorState = { streams: {} };

    const loader = new LoaderStandIn();
    await expect(
      run(fakeStore(files, { failOn: 'incoming/b.csv' }).client, state, { loader })
    ).rejects.toThrow(/connection reset/);
    expect(state.streams).toEqual({});
    // The file already sent was written before the run gave up, not cut off by its cleanup.
    expect(loader.events).toContain('deleted:a.csv');

    const retry = await run(fakeStore(files).client, state);
    expect(keys(retry.loader)).toEqual(['a.csv', 'b.csv']);
  });

  it('reports files and bytes copied in one metric line per run', async () => {
    const files = [file('a.csv', 0, 'aaaa'), file('b.csv', 1, 'bb')];
    const state: ExtractorState = { streams: {} };

    const first = await run(fakeStore(files).client, state);
    const second = await run(fakeStore(files).client, state);

    expect(first.metrics).toHaveLength(1);
    expect(first.metrics[0]?.metrics).toMatchObject({
      files_listed: 2,
      files_processed: 2,
      bytes_downloaded: 6,
    });
    expect(second.metrics).toHaveLength(1);
    expect(second.metrics[0]?.metrics).toMatchObject({ files_processed: 0, bytes_downloaded: 0 });
  });

  it('reports files_processed and bytes_downloaded as 0 when a run copies nothing', async () => {
    // A copy run always reports both metrics, with the value 0 when it copies nothing.
    const files = [file('a.csv', 0)];
    const state: ExtractorState = { streams: {} };
    const emptyListing = await run(fakeStore([]).client, { streams: {} });
    await run(fakeStore(files).client, state);
    const nothingNew = await run(fakeStore(files).client, state);

    for (const quiet of [emptyListing, nothingNew]) {
      expect(quiet.metrics).toHaveLength(1);
      expect(quiet.metrics[0]?.metrics).toHaveProperty('files_processed', 0);
      expect(quiet.metrics[0]?.metrics).toHaveProperty('bytes_downloaded', 0);
    }
  });

  it('does not save state for a limited run', async () => {
    const files = [file('a.csv', 0), file('b.csv', 1)];
    const state: ExtractorState = { streams: {} };

    const { loader, store } = await run(fakeStore(files).client, state, { limit: 1 });

    expect(keys(loader)).toEqual(['a.csv']);
    expect(store.save).not.toHaveBeenCalled();
  });
});

describe('copy extractor: names, scope and the reader', () => {
  it('copies a file whose key is longer than a file name can be', async () => {
    const longName = `${'k'.repeat(480)}.csv`;
    const files = [file(longName, 0)];

    const { loader } = await run(fakeStore(files).client, { streams: {} });

    expect(keys(loader)).toEqual([longName]);
  });

  it.each(['s3', 'sftp'] as const)(
    'starts over when the path changes, so a wider path takes the older files too (%s)',
    async (sourceType) => {
      const files = [file('old.txt', 0), file('new.csv', 500)];
      const state: ExtractorState = { streams: {} };
      const source = integration(sourceType);
      const narrow = resource({ source: { kind: 'copy', path: 'incoming/*.csv' } });
      const wide = resource({ source: { kind: 'copy', path: 'incoming/*' } });

      const first = await run(fakeStore(files).client, state, { spec: narrow, source });
      expect(keys(first.loader)).toEqual(['new.csv']);

      const second = await run(fakeStore(files).client, state, { spec: wide, source });
      expect(keys(second.loader)).toEqual(['new.csv', 'old.txt']);
    }
  );

  it('tells the loader the source key and when the source says the file changed', async () => {
    const store = fakeStore([file('2026/a.csv', 5)]);
    const { loader } = await run(store.client, { streams: {} });

    expect(loader.messages.find((message) => message['type'] === 'FILE')).toMatchObject({
      relative_key: '2026/a.csv',
      source_key: 'incoming/2026/a.csv',
      modified: at(5),
    });

    // A source that gives no time, such as an SFTP server, leaves `modified` out.
    const timeless: FileStorageClient = {
      ...store.client,
      async *list(options) {
        for await (const listed of store.client.list(options)) {
          yield { ...listed, last_modified: undefined };
        }
      },
    };
    const { loader: noTime } = await run(
      timeless,
      { streams: {} },
      { source: integration('sftp') }
    );
    const sent = noTime.messages.find((message) => message['type'] === 'FILE');
    expect(sent).toMatchObject({ source_key: 'incoming/2026/a.csv' });
    expect(sent).not.toHaveProperty('modified');
  });

  it('leaves out a modified time that FILE cannot carry, and still sends the file', async () => {
    const store = fakeStore([file('a.csv', 5)]);
    // A year past 9999 is written with a sign and six digits, which the loader refuses. Some disks
    // can hold such a time, and it is no reason to stop a run that could copy the file.
    const distant: FileStorageClient = {
      ...store.client,
      async *list(options) {
        for await (const listed of store.client.list(options)) {
          yield { ...listed, last_modified: new Date(Date.UTC(10000, 0, 1)) };
        }
      },
    };

    const { loader } = await run(distant, { streams: {} }, { source: integration('sftp') });

    const sent = loader.messages.find((message) => message['type'] === 'FILE');
    expect(sent).toMatchObject({ source_key: 'incoming/a.csv' });
    expect(sent).not.toHaveProperty('modified');
  });

  it('starts over when the bucket changes', async () => {
    const files = [file('a.csv', 0)];
    const state: ExtractorState = { streams: {} };
    await run(fakeStore(files).client, state);

    const other = {
      ...integration('s3'),
      connection: { bucket: 'other-bucket' },
    } as IntegrationSpec;
    const again = await run(fakeStore(files).client, state, { source: other });

    expect(keys(again.loader)).toEqual(['a.csv']);
  });

  it('removes its temp folder when the process exits before it can clean up', async () => {
    const before = new Set(process.listeners('exit'));
    const loader = new LoaderStandIn(undefined, 15, false); // nothing deletes the files
    const controller = new AbortController();

    const settled = run(
      fakeStore([file('a.csv', 0)]).client,
      { streams: {} },
      {
        loader,
        signal: controller.signal,
      }
    ).catch((error: unknown) => error);
    await vi.waitFor(() => expect(loader.messages.some((m) => m['type'] === 'FILE')).toBe(true));
    const sent = loader.messages.find((message) => message['type'] === 'FILE')!;
    const folder = path.dirname(fileURLToPath(sent['uri'] as string));
    const added = process.listeners('exit').filter((listener) => !before.has(listener));
    expect(added).toHaveLength(1);
    expect(existsSync(folder)).toBe(true);

    added[0]!(0); // what the process runs as it exits
    expect(existsSync(folder)).toBe(false);

    controller.abort();
    await settled;
    expect(process.listeners('exit').filter((listener) => !before.has(listener))).toHaveLength(0);
  });

  it('prints a file name with control characters as escapes', async () => {
    const files = [file('evil\u001b[2Kname.bin', 0, 'x'.repeat(32))];

    const error = await run(
      fakeStore(files).client,
      { streams: {} },
      {
        spec: resource({ limits: { max_file_size_bytes: 10 } }),
      }
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('evil\\u001b[2Kname.bin');
    expect((error as Error).message).not.toContain('\u001b');
  });

  it('sends a STATE line with the run time only, since the saved state holds the rest', async () => {
    const { loader } = await run(fakeStore([file('a.csv', 0)]).client, { streams: {} });

    const state = loader.messages.find((message) => message['type'] === 'STATE');
    expect(Object.keys(state?.['value'] as object).sort()).toEqual(['last_run_at', 'record_count']);
  });

  it('fails instead of waiting for ever when its reader has gone', async () => {
    // Nothing reads or deletes the files, and a write of an empty line fails, as it does on a closed pipe.
    const gone = new LoaderStandIn(undefined, 15, false);
    const write = gone.write.bind(gone);
    gone.write = (chunk: string) => {
      if (chunk === '\n') throw new Error('write EPIPE');
      return write(chunk);
    };

    await expect(
      run(fakeStore([file('a.csv', 0)]).client, { streams: {} }, { loader: gone, pingMs: 5 })
    ).rejects.toThrow('write EPIPE');
  });
});

describe('copy extractor: GCS', () => {
  it('reads an object as stored, so a gzip-encoded object keeps its bytes', async () => {
    const stored = gzipSync('id,name\n1,Ada\n');
    const decompressFlags: unknown[] = [];
    const object = {
      name: 'incoming/events.csv',
      metadata: { updated: at(0), etag: 'CJ+q', generation: '1', size: stored.length },
      async download(options: { destination: string; decompress?: boolean }) {
        decompressFlags.push(options.decompress);
        await writeFile(
          options.destination,
          options.decompress === false ? stored : gunzipSync(stored)
        );
      },
    };
    const client = await GcsFileStorageClient.create(
      { bucket: 'landing-bucket' },
      { type: 'adc' },
      {
        bucket: {
          getFiles: async () => [[object], undefined],
          file: () => object,
        },
      }
    );

    const { loader } = await run(client, { streams: {} }, { source: integration('gcs') });

    expect(decompressFlags).toEqual([false]);
    expect(loader.copies[0]?.key).toBe('events.csv');
    expect(sha256(loader.copies[0]!.bytes)).toBe(sha256(stored));

    // A label change moves `updated` and `etag` but not `generation`, so it is not a new file.
    const state = { streams: {} } as ExtractorState;
    await run(client, state, { source: integration('gcs') });
    object.metadata.updated = at(30);
    object.metadata.etag = 'CJ+r';
    const again = await run(client, state, { source: integration('gcs') });
    expect(again.loader.copies).toEqual([]);
  });
});

describe('copy extractor: GCS creation time', () => {
  it('does not copy an object again when only its metadata time moves', async () => {
    const stored = Buffer.from('a');
    const objects = [
      { name: 'incoming/a.csv', created: at(0) },
      { name: 'incoming/b.csv', created: at(120) },
    ].map(({ name, created }) => ({
      name,
      metadata: {
        updated: created,
        timeCreated: created,
        etag: `etag-${name}`,
        generation: `generation-${name}`,
        size: stored.length,
      },
      async download(options: { destination: string }) {
        await writeFile(options.destination, stored);
      },
    }));
    const client = await GcsFileStorageClient.create(
      { bucket: 'landing-bucket' },
      { type: 'adc' },
      {
        bucket: {
          getFiles: async () => [objects, undefined],
          file: (name: string) => objects.find((object) => object.name === name),
        },
      }
    );
    const state = { streams: {} } as ExtractorState;
    const source = integration('gcs');

    const first = await run(client, state, { source });
    expect(keys(first.loader)).toEqual(['a.csv', 'b.csv']);

    // A lifecycle rule that moves the old object to colder storage changes its `updated` time,
    // but not its content or the time it was created.
    objects[0]!.metadata.updated = at(130);
    const again = await run(client, state, { source });

    expect(again.loader.copies).toEqual([]);
  });
});

describe('copy extractor: SFTP', () => {
  it('keeps a record of each file instead of a watermark, since a client can set any time', async () => {
    const files = [file('a.csv', 0), file('b.csv', 1)];
    const state: ExtractorState = { streams: {} };
    const source = integration('sftp');

    const first = await run(fakeStore(files).client, state, { source });
    expect(keys(first.loader)).toEqual(['a.csv', 'b.csv']);
    expect(Object.keys(state.streams['landing/drops']?.files ?? {})).toHaveLength(2);
    expect(state.streams['landing/drops']).not.toHaveProperty('watermark');

    files[0] = file('a.csv', 0, 'changed');
    const second = await run(fakeStore(files).client, state, { source });
    expect(keys(second.loader)).toEqual(['a.csv']);
  });

  it('copies a file again that a structured Resource of the same name already read', async () => {
    const files = [file('a.csv', 0)];
    const state: ExtractorState = { streams: {} };
    const source = integration('sftp');
    await run(fakeStore(files).client, state, { source });
    // State a structured Resource wrote has the same file bookmarks but no scope.
    delete state.streams['landing/drops']!.scope;

    const again = await run(fakeStore(files).client, state, { source });

    expect(keys(again.loader)).toEqual(['a.csv']);
  });

  it('reads one file at a time, so read_concurrency still caps the reads on the connection', async () => {
    const files = [file('a.csv', 0), file('b.csv', 1), file('c.csv', 2)];
    const store = fakeStore(files);

    const { loader } = await run(store.client, { streams: {} }, { source: integration('sftp') });

    expect(keys(loader)).toEqual(['a.csv', 'b.csv', 'c.csv']);
    expect(store.probe.peakDownloads).toBe(1);
  });

  it('starts over when the base directory changes, since the same relative path is another file', async () => {
    const files = [file('a.csv', 0)];
    const state: ExtractorState = { streams: {} };
    const at = (baseDirectory: string) =>
      ({
        ...integration('sftp'),
        connection: { host: 'sftp.example.com', base_directory: baseDirectory },
      }) as IntegrationSpec;
    await run(fakeStore(files).client, state, { source: at('/incoming') });

    const again = await run(fakeStore(files).client, state, { source: at('/other') });

    expect(keys(again.loader)).toEqual(['a.csv']);
  });
});

describe('copy extractor: local folder', () => {
  it('copies every kind of file unchanged, then only new and changed files', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'copy-local-'));
    try {
      const fixtures: Record<string, Buffer> = {
        'orders.csv': Buffer.from('id,name\n1,Ada\n'),
        'orders.csv.gz': gzipSync('id,name\n1,Ada\n'),
        'part.parquet': Buffer.concat([
          Buffer.from('PAR1'),
          Buffer.from([0, 1, 2, 255, 254]),
          Buffer.from('PAR1'),
        ]),
        'invoice.pdf': Buffer.concat([
          Buffer.from('%PDF-1.7\n'),
          Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0]),
        ]),
        'bundle.zip': Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from([20, 0, 0, 0, 8, 0])]),
        'empty.dat': Buffer.alloc(0),
        'deep/er/note.txt': Buffer.from('nested'),
      };
      for (const [name, body] of Object.entries(fixtures)) {
        await mkdir(path.dirname(path.join(base, name)), { recursive: true });
        await writeFile(path.join(base, name), body);
      }
      const state: ExtractorState = { streams: {} };
      const spec = resource({ source: { kind: 'copy', path: '**/*' } });
      const source = integration('local', base);

      const first = await run(undefined, state, { spec, source });
      expect(first.loader.copies.map((copy) => copy.key).sort()).toEqual(
        Object.keys(fixtures).sort()
      );
      for (const copy of first.loader.copies) {
        expect(sha256(copy.bytes)).toBe(sha256(fixtures[copy.key]!));
        expect(copy.size).toBe(fixtures[copy.key]!.length);
      }

      expect((await run(undefined, state, { spec, source })).loader.copies).toEqual([]);

      await writeFile(path.join(base, 'orders.csv'), 'id,name\n1,Ada\n2,Grace\n');
      await utimes(path.join(base, 'orders.csv'), new Date(), new Date(Date.now() + 5000));
      await writeFile(path.join(base, 'fresh.csv'), 'id\n9\n');
      const third = await run(undefined, state, { spec, source });
      expect(keys(third.loader)).toEqual(['fresh.csv', 'orders.csv']);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
