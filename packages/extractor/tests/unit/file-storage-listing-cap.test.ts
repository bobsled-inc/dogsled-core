import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { withPrivateHostAllowlist } from '../../src/framework/core/index.js';
import { GcsFileStorageClient } from '../../src/runtime/clients/gcs-file-client.js';
import { S3FileStorageClient } from '../../src/runtime/clients/s3-file-client.js';
import { SftpFileStorageClient } from '../../src/runtime/clients/sftp-file-client.js';
import { ControlLogger } from '../../src/runtime/control.js';
import { extractDocumentResource } from '../../src/runtime/document-extraction.js';
import { Emitter } from '../../src/runtime/emitter.js';
import { createFileStorageClient } from '../../src/runtime/file-storage-client.js';
import { extractFileStorageResource } from '../../src/runtime/file-storage-extractor.js';
import { FakeWritable } from '../helpers/fixtures.js';
import { generateTestKey, startTestSftpServer } from './sftp-test-server.js';

import type { FileStorageClient } from '../../src/framework/core/index.js';
import type { StateStore } from '../../src/runtime/state.js';
import type { ExtractorState, FileResourceSpec, IntegrationSpec } from '../../src/types/index.js';

// These tests run the extractor over the real S3, GCS and SFTP clients with fake
// transport. A fake client that ignores `maxFiles` would pass on code that still
// caps the listing, so none of the structured-path tests use one.
vi.mock('../../src/runtime/file-storage-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime/file-storage-client.js')>();
  return { createFileStorageClient: vi.fn(actual.createFileStorageClient) };
});

const CAP = 3;
const PAGE_SIZE = 2;
const DAYS = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05'];

interface StoredFile {
  key: string;
  body: string;
  modified: Date;
}

interface Storage {
  open(): Promise<FileStorageClient>;
  close(): Promise<void>;
}

interface Provider {
  name: string;
  integration: IntegrationSpec;
  path: string;
  create(files: StoredFile[]): Promise<Storage>;
}

function storedFiles(days: string[] = DAYS, bodyOf?: (index: number) => string): StoredFile[] {
  return days.map((day, index) => ({
    key: `exports/${day}/orders.csv`,
    body: bodyOf?.(index) ?? `id,name\n${index + 1},Order ${index + 1}\n`,
    modified: new Date(`${day}T00:00:00.000Z`),
  }));
}

function createStateStore(state: ExtractorState): StateStore {
  return {
    load: vi.fn().mockResolvedValue(state),
    save: vi.fn().mockImplementation(async (next: ExtractorState) => {
      state.streams = next.streams;
    }),
  };
}

function ordersResource(
  filePath: string,
  overrides: Partial<Pick<FileResourceSpec, 'limits' | 'replication'>> = {}
): FileResourceSpec {
  return {
    spec_version: '1',
    type: 'resource',
    name: 'orders',
    description: '',
    input: {},
    source: {
      path: filePath,
      format: 'csv',
      options: { header: true },
      include_file_metadata: true,
    },
    replication: { method: 'incremental_append', cursor: { field: 'last_modified' } },
    limits: { max_files_per_run: CAP },
    extract: {},
    output: {
      id: { type: 'integer' },
      name: { type: 'string' },
      _file_path: { type: 'string' },
      _file_uri: { type: 'string' },
      _file_modified_at: { type: 'timestamp' },
      _file_etag: { type: 'string' },
      _file_size: { type: 'integer' },
    },
    ...overrides,
  };
}

function s3Provider(): Provider {
  return {
    name: 'S3',
    integration: {
      spec_version: '1',
      type: 'integration',
      name: 'exports',
      source_type: 's3',
      connection: { bucket: 'raw', region: 'us-east-1' },
      auth: { type: 'default_chain' },
    } as unknown as IntegrationSpec,
    path: 'exports/*/orders.csv',
    create: async (files) => ({
      open: async () => fakeS3Client(files),
      close: async () => undefined,
    }),
  };
}

function fakeS3Client(
  files: StoredFile[],
  hooks: { onDownload?: (key: string) => void; failDownloads?: boolean } = {}
): S3FileStorageClient {
  class ListObjectsV2Command {
    constructor(readonly input: { Prefix?: string; ContinuationToken?: string }) {}
  }
  class GetObjectCommand {
    constructor(readonly input: { Key: string }) {}
  }
  const sorted = [...files].sort((a, b) => a.key.localeCompare(b.key));
  return new S3FileStorageClient(
    { bucket: 'raw', region: 'us-east-1' },
    { type: 'default_chain' },
    {
      ListObjectsV2Command,
      GetObjectCommand,
      client: {
        send: async (command: unknown) => {
          if (command instanceof ListObjectsV2Command) {
            const matching = sorted.filter((file) =>
              file.key.startsWith(command.input.Prefix ?? '')
            );
            const start = Number(command.input.ContinuationToken ?? 0);
            const next = start + PAGE_SIZE;
            return {
              Contents: matching.slice(start, next).map((file) => ({
                Key: file.key,
                LastModified: file.modified,
                ETag: `"etag-${file.key}"`,
                Size: Buffer.byteLength(file.body),
              })),
              NextContinuationToken: next < matching.length ? String(next) : undefined,
            };
          }
          if (command instanceof GetObjectCommand) {
            hooks.onDownload?.(command.input.Key);
            if (hooks.failDownloads) throw new Error('access denied');
            const file = sorted.find((candidate) => candidate.key === command.input.Key);
            if (!file) throw new Error(`no such key: ${command.input.Key}`);
            return {
              Body: Readable.from([Buffer.from(file.body)]),
              ContentLength: Buffer.byteLength(file.body),
            };
          }
          throw new Error('unexpected S3 command');
        },
      },
    }
  );
}

function gcsProvider(): Provider {
  return {
    name: 'GCS',
    integration: {
      spec_version: '1',
      type: 'integration',
      name: 'exports',
      source_type: 'gcs',
      connection: { bucket: 'raw' },
      auth: { type: 'default_chain' },
    } as unknown as IntegrationSpec,
    path: 'exports/*/orders.csv',
    create: async (files) => ({
      open: async () => fakeGcsClient(files),
      close: async () => undefined,
    }),
  };
}

function fakeGcsClient(files: StoredFile[]): GcsFileStorageClient {
  const sorted = [...files].sort((a, b) => a.key.localeCompare(b.key));
  const objectFor = (file: StoredFile) => ({
    name: file.key,
    metadata: {
      updated: file.modified.toISOString(),
      generation: '1',
      etag: `etag-${file.key}`,
      size: String(Buffer.byteLength(file.body)),
    },
    download: async ({ destination }: { destination: string }) => {
      await writeFile(destination, file.body);
    },
  });
  const bucket = {
    getFiles: async (options: { prefix?: string; pageToken?: string }) => {
      const matching = sorted.filter((file) => file.key.startsWith(options.prefix ?? ''));
      const start = Number(options.pageToken ?? 0);
      const next = start + PAGE_SIZE;
      return [
        matching.slice(start, next).map(objectFor),
        next < matching.length ? { pageToken: String(next) } : undefined,
        undefined,
      ];
    },
    file: (name: string) => {
      const file = sorted.find((candidate) => candidate.key === name);
      if (!file) throw new Error(`no such object: ${name}`);
      return objectFor(file);
    },
  };
  return new GcsFileStorageClient({ bucket: 'raw' }, bucket as never);
}

function sftpProvider(): Provider {
  return {
    name: 'SFTP',
    integration: {
      spec_version: '1',
      type: 'integration',
      name: 'exports',
      source_type: 'sftp',
      connection: { host: '127.0.0.1', username: 'agent', base_directory: '/exports' },
      auth: { type: 'password', password_env: 'LISTING_CAP_SFTP_PASSWORD' },
    } as unknown as IntegrationSpec,
    path: '*/orders.csv',
    create: async (files) => {
      const root = await mkdtemp(path.join(tmpdir(), 'listing-cap-sftp-'));
      for (const file of files) {
        await mkdir(path.dirname(path.join(root, file.key)), { recursive: true });
        await writeFile(path.join(root, file.key), file.body);
      }
      const hostKey = generateTestKey('ed25519');
      vi.stubEnv('LISTING_CAP_SFTP_PASSWORD', 'secret');
      const server = await startTestSftpServer({ root, hostKeys: [hostKey], password: 'secret' });
      const open = () =>
        withPrivateHostAllowlist(['127.0.0.1'], () =>
          SftpFileStorageClient.create(
            {
              host: '127.0.0.1',
              port: server.port,
              username: 'agent',
              base_directory: '/exports',
              host_keys: [
                {
                  algorithm: hostKey.algorithm as 'ssh-ed25519',
                  fingerprint: hostKey.fingerprint,
                },
              ],
              read_concurrency: 4,
            },
            { type: 'password', password_env: 'LISTING_CAP_SFTP_PASSWORD' },
            { timeouts: { idleMs: 30_000, readyMs: 5_000 } },
            ['LISTING_CAP_SFTP_PASSWORD']
          )
        );
      return {
        open,
        close: async () => {
          await server.close();
          await rm(root, { recursive: true, force: true });
        },
      };
    },
  };
}

type Message = Record<string, unknown> & { type?: string; level?: string; message?: string };

function messagesOf(stream: FakeWritable): Message[] {
  return stream.chunks
    .flatMap((chunk) => chunk.split('\n'))
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Message);
}

interface RunResult {
  records: Array<{ stream?: string; record: Record<string, unknown> }>;
  warnings: string[];
  states: Message[];
}

function seededBookmarks(count: number): Record<string, { last_modified: string; etag: string }> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `s3://raw/archive/${index}.csv`,
      { last_modified: '2026-01-01T00:00:00.000Z', etag: `"etag-${index}"` },
    ])
  );
}

function stateKeys(message: Message | undefined): string[] {
  return Object.keys((message?.['value'] ?? {}) as object).sort();
}

async function runStructured(args: {
  client: FileStorageClient;
  integration: IntegrationSpec;
  resource: FileResourceSpec;
  state: ExtractorState;
  fullRefresh?: boolean;
}): Promise<RunResult> {
  vi.mocked(createFileStorageClient).mockResolvedValueOnce(args.client);
  const stdout = new FakeWritable();
  const stderr = new FakeWritable();
  await extractFileStorageResource({
    integration: args.integration,
    resource: args.resource,
    integrationName: 'exports',
    emitter: new Emitter('stdout', 'output', { stdoutStream: stdout }),
    logger: new ControlLogger({ stream: stderr }),
    state: args.state,
    stateStore: createStateStore(args.state),
    advanceState: true,
    fullRefresh: args.fullRefresh,
  });
  return {
    records: messagesOf(stdout).filter(
      (message) => message.type === 'RECORD'
    ) as unknown as RunResult['records'],
    warnings: messagesOf(stderr)
      .filter((message) => message.type === 'LOG' && message.level === 'warn')
      .map((message) => String(message.message)),
    states: messagesOf(stdout).filter((message) => message.type === 'STATE'),
  };
}

function fileUris(result: RunResult): string[] {
  return result.records.map((entry) => String(entry.record['_file_uri'])).sort();
}

function capWarnings(result: RunResult): string[] {
  return result.warnings.filter((message) => message.includes('max_files_per_run'));
}

function bookmarkedUris(state: ExtractorState): string[] {
  const stream = state.streams['exports/orders'] as { files?: Record<string, unknown> } | undefined;
  return Object.keys(stream?.files ?? {}).sort();
}

const storages: Storage[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(storages.splice(0).map((storage) => storage.close()));
});

async function storageFor(provider: Provider, files: StoredFile[]): Promise<Storage> {
  const storage = await provider.create(files);
  storages.push(storage);
  return storage;
}

describe.each([s3Provider(), gcsProvider(), sftpProvider()])(
  'incremental $name run over more than max_files_per_run matching files',
  (provider) => {
    it('picks up the newer files on the next run instead of relisting the first batch', async () => {
      const storage = await storageFor(provider, storedFiles());
      const resource = ordersResource(provider.path);
      const state: ExtractorState = { streams: {} };
      const run = async () =>
        runStructured({
          client: await storage.open(),
          integration: provider.integration,
          resource,
          state,
        });

      const first = await run();
      expect(first.records).toHaveLength(CAP);
      expect(bookmarkedUris(state)).toHaveLength(CAP);

      const second = await run();
      expect(second.records).toHaveLength(DAYS.length - CAP);
      expect(fileUris(second).filter((uri) => fileUris(first).includes(uri))).toEqual([]);
      expect(bookmarkedUris(state)).toHaveLength(DAYS.length);

      const third = await run();
      expect(third.records).toHaveLength(0);
    });

    it('warns when it stops at the limit with files left, and only then', async () => {
      const storage = await storageFor(provider, storedFiles());
      const resource = ordersResource(provider.path);
      const state: ExtractorState = { streams: {} };
      const run = async () =>
        runStructured({
          client: await storage.open(),
          integration: provider.integration,
          resource,
          state,
        });

      const first = await run();
      expect(first.records).toHaveLength(CAP);
      expect(capWarnings(first)).toHaveLength(1);
      expect(capWarnings(first)[0]).toContain('orders');
      expect(capWarnings(first)[0]).toContain(`(${CAP})`);
      expect(capWarnings(first)[0]).toContain('next run continues');
      expect(capWarnings(first)[0]).not.toContain('narrow');

      const second = await run();
      expect(second.records).toHaveLength(DAYS.length - CAP);
      expect(capWarnings(second)).toEqual([]);

      const third = await run();
      expect(capWarnings(third)).toEqual([]);
    });
  }
);

describe('limit edge cases on the S3 client', () => {
  const provider = s3Provider();

  it('does not warn when the run ends at the limit and the rest is already processed', async () => {
    const files = storedFiles();
    const state: ExtractorState = { streams: {} };
    const resource = ordersResource(provider.path);

    const seeded = await runStructured({
      client: fakeS3Client(files.slice(CAP)),
      integration: provider.integration,
      resource: ordersResource(provider.path, { limits: { max_files_per_run: 10 } }),
      state,
    });
    expect(seeded.records).toHaveLength(DAYS.length - CAP);

    const result = await runStructured({
      client: fakeS3Client(files),
      integration: provider.integration,
      resource,
      state,
    });
    expect(result.records).toHaveLength(CAP);
    expect(capWarnings(result)).toEqual([]);
    expect(bookmarkedUris(state)).toHaveLength(DAYS.length);
  });

  const oversizeLimits = { max_files_per_run: CAP, max_file_size_bytes: 100 };
  const oversizeBody = (index: number) => `id,name\n${index + 1},${'x'.repeat(200)}\n`;

  it('does not count an oversize file toward the limit', async () => {
    const files = storedFiles(DAYS.slice(0, CAP + 1), (index) =>
      index === 0 ? oversizeBody(index) : undefined
    );
    const result = await runStructured({
      client: fakeS3Client(files),
      integration: provider.integration,
      resource: ordersResource(provider.path, { limits: oversizeLimits }),
      state: { streams: {} },
    });
    expect(result.records).toHaveLength(CAP);
    expect(capWarnings(result)).toEqual([]);
    expect(result.warnings.some((message) => message.includes('max_file_size_bytes'))).toBe(true);
  });

  it('does not warn when only oversize files are left past the limit', async () => {
    const files = storedFiles(DAYS.slice(0, CAP + 1), (index) =>
      index === CAP ? oversizeBody(index) : undefined
    );
    const result = await runStructured({
      client: fakeS3Client(files),
      integration: provider.integration,
      resource: ordersResource(provider.path, { limits: oversizeLimits }),
      state: { streams: {} },
    });
    expect(result.records).toHaveLength(CAP);
    expect(capWarnings(result)).toEqual([]);
    expect(result.warnings.some((message) => message.includes('max_file_size_bytes'))).toBe(true);
  });

  it('stops trying to download at the limit even when every download fails', async () => {
    const attempted: string[] = [];
    const result = await runStructured({
      client: fakeS3Client(storedFiles(), {
        failDownloads: true,
        onDownload: (key) => attempted.push(key),
      }),
      integration: provider.integration,
      resource: ordersResource(provider.path),
      state: { streams: {} },
    });
    expect(result.records).toHaveLength(0);
    expect(attempted).toHaveLength(CAP);
    expect(capWarnings(result)).toHaveLength(1);
  });

  it('keeps full_refresh reading the first files only, and warns that the rest are left out', async () => {
    const files = storedFiles();
    const state: ExtractorState = { streams: {} };
    const resource = ordersResource(provider.path, { replication: { method: 'full_refresh' } });
    const run = () =>
      runStructured({
        client: fakeS3Client(files),
        integration: provider.integration,
        resource,
        state,
      });

    const first = await run();
    const second = await run();

    const firstBatch = files.slice(0, CAP).map((file) => `s3://raw/${file.key}`);
    expect(fileUris(first)).toEqual(firstBatch);
    expect(fileUris(second)).toEqual(firstBatch);
    expect(capWarnings(first)).toHaveLength(1);
    expect(capWarnings(second)).toHaveLength(1);
    expect(capWarnings(first)[0]).toContain('narrow');
  });

  it('lets the next run continue after a one-off full refresh of an incremental resource', async () => {
    const files = storedFiles();
    const state: ExtractorState = { streams: {} };
    const resource = ordersResource(provider.path);
    const run = (fullRefresh?: boolean) =>
      runStructured({
        client: fakeS3Client(files),
        integration: provider.integration,
        resource,
        state,
        fullRefresh,
      });

    const refreshed = await run(true);
    expect(refreshed.records).toHaveLength(CAP);
    expect(capWarnings(refreshed)).toHaveLength(1);
    expect(capWarnings(refreshed)[0]).not.toContain('narrow');

    const next = await run();
    expect(next.records).toHaveLength(DAYS.length - CAP);
    expect(capWarnings(next)).toEqual([]);
  });

  it('leaves the list of files read out of the STATE message', async () => {
    const state: ExtractorState = {
      streams: {
        'exports/orders': {
          last_run_at: '2026-01-01T00:00:00.000Z',
          record_count: 0,
          files: seededBookmarks(20_000),
        },
      },
    };
    const result = await runStructured({
      client: fakeS3Client(storedFiles()),
      integration: provider.integration,
      resource: ordersResource(provider.path),
      state,
    });

    expect(result.states).toHaveLength(1);
    expect(stateKeys(result.states[0])).toEqual(['last_run_at', 'record_count']);
    expect(bookmarkedUris(state)).toHaveLength(20_000 + CAP);
  });
});

describe('document resource over more than max_files_per_run matching files', () => {
  const DOC_CAP = 2;

  function documentResource(): FileResourceSpec {
    return {
      spec_version: '1',
      type: 'resource',
      name: 'docs',
      description: '',
      input: {},
      source: {
        kind: 'document',
        path: '*.md',
        parse: { formats: ['md'], on_error: 'record' },
        chunk: { max_tokens: 200, overlap_tokens: 20, tokenizer: 'cl100k_base' },
        ingest: { mode: 'extract' },
        permissions: { capture: false, enforcement: { enabled: false } },
      },
      replication: { method: 'incremental_append', cursor: { field: 'last_modified' } },
      limits: { max_files_per_run: DOC_CAP },
      extract: {},
      output: { document_id: { type: 'string' } },
    } as unknown as FileResourceSpec;
  }

  const s3Documents = s3Provider();
  const s3DocumentResource = (limits = DOC_CAP): FileResourceSpec => {
    const resource = documentResource();
    return {
      ...resource,
      source: { ...resource.source, path: 'docs/*.md' },
      limits: { max_files_per_run: limits },
    } as FileResourceSpec;
  };

  function markdownFiles(names: string[]): StoredFile[] {
    return names.map((name) => ({
      key: `docs/${name}.md`,
      body: `# ${name}\n\nBody of ${name}.\n`,
      modified: new Date('2026-01-01T00:00:00.000Z'),
    }));
  }

  async function runDocuments(args: {
    integration: IntegrationSpec;
    resource: FileResourceSpec;
    state: ExtractorState;
    client?: FileStorageClient;
    fullRefresh?: boolean;
  }) {
    if (args.client) vi.mocked(createFileStorageClient).mockResolvedValueOnce(args.client);
    const stdout = new FakeWritable();
    const stderr = new FakeWritable();
    await extractDocumentResource({
      integration: args.integration,
      resource: args.resource,
      integrationName: 'docs_source',
      emitter: new Emitter('stdout', 'output', { stdoutStream: stdout }),
      logger: new ControlLogger({ stream: stderr }),
      state: args.state,
      stateStore: createStateStore(args.state),
      advanceState: true,
      fullRefresh: args.fullRefresh,
      startedAt: Date.now(),
    });
    const recordsIn = (stream: string) =>
      messagesOf(stdout).filter(
        (message) => message.type === 'RECORD' && message['stream'] === stream
      );
    return {
      documents: recordsIn('docs__documents').map((message) =>
        String((message['record'] as Record<string, unknown>)['source_uri'])
      ),
      parseErrors: recordsIn('docs__parse_errors').length,
      capWarnings: messagesOf(stderr)
        .filter((message) => message.type === 'LOG' && message.level === 'warn')
        .map((message) => String(message.message))
        .filter((message) => message.includes('max_files_per_run')),
      states: messagesOf(stdout).filter((message) => message.type === 'STATE'),
    };
  }

  it('reads the newer documents on the next run and warns only when it stops early', async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), 'listing-cap-docs-'));
    try {
      for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) {
        await writeFile(path.join(baseDir, name), `# ${name}\n\nbody of ${name}.\n`);
      }
      const state: ExtractorState = { streams: {} };
      const run = () =>
        runDocuments({
          integration: {
            spec_version: '1',
            type: 'integration',
            name: 'docs_source',
            source_type: 'local',
            connection: { base_directory: baseDir },
            auth: { type: 'none' },
          } as unknown as IntegrationSpec,
          resource: documentResource(),
          state,
        });

      const first = await run();
      expect(first.documents).toHaveLength(DOC_CAP);

      const second = await run();
      expect(second.documents).toHaveLength(DOC_CAP);
      expect(second.documents.filter((uri) => first.documents.includes(uri))).toEqual([]);

      const third = await run();
      expect(third.documents).toHaveLength(0);

      expect(first.capWarnings).toHaveLength(1);
      expect(first.capWarnings[0]).toContain('docs');
      expect(second.capWarnings).toEqual([]);
      expect(third.capWarnings).toEqual([]);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it('does not warn when the files left past the limit are already read', async () => {
    const files = markdownFiles(['01', '02', '03', '04']);
    const state: ExtractorState = { streams: {} };

    const seeded = await runDocuments({
      client: fakeS3Client(files.slice(DOC_CAP)),
      integration: s3Documents.integration,
      resource: s3DocumentResource(10),
      state,
    });
    expect(seeded.documents).toHaveLength(files.length - DOC_CAP);

    const result = await runDocuments({
      client: fakeS3Client(files),
      integration: s3Documents.integration,
      resource: s3DocumentResource(),
      state,
    });
    expect(result.documents).toHaveLength(DOC_CAP);
    expect(result.capWarnings).toEqual([]);
  });

  it('does not count an oversize file toward the limit', async () => {
    const [first, ...rest] = markdownFiles(['01', '02', '03', '04']);
    const files = [{ ...first!, body: `# 01\n\n${'x'.repeat(200)}\n` }, ...rest];
    const resource = s3DocumentResource();
    const result = await runDocuments({
      client: fakeS3Client(files),
      integration: s3Documents.integration,
      resource: {
        ...resource,
        source: {
          ...resource.source,
          parse: { formats: ['md'], on_error: 'record', max_file_size_mb: 0.0001 },
        },
      } as FileResourceSpec,
      state: { streams: {} },
    });
    expect(result.parseErrors).toBe(1);
    expect(result.documents).toHaveLength(DOC_CAP);
    expect(result.capWarnings).toHaveLength(1);
  });

  it('keeps full_refresh documents reading the first files only, and warns that the rest are left out', async () => {
    const files = markdownFiles(['01', '02', '03', '04']);
    const state: ExtractorState = { streams: {} };
    const resource = {
      ...s3DocumentResource(),
      replication: { method: 'full_refresh' },
    } as FileResourceSpec;
    const run = () =>
      runDocuments({
        client: fakeS3Client(files),
        integration: s3Documents.integration,
        resource,
        state,
      });

    const first = await run();
    const second = await run();

    expect(first.documents).toHaveLength(DOC_CAP);
    expect(second.documents).toEqual(first.documents);
    expect(first.capWarnings).toHaveLength(1);
    expect(second.capWarnings).toHaveLength(1);
    expect(first.capWarnings[0]).toContain('narrow');
  });

  it('lets the next run continue after a one-off full refresh of an incremental document resource', async () => {
    const files = markdownFiles(['01', '02', '03', '04']);
    const state: ExtractorState = { streams: {} };
    const run = (fullRefresh?: boolean) =>
      runDocuments({
        client: fakeS3Client(files),
        integration: s3Documents.integration,
        resource: s3DocumentResource(),
        state,
        fullRefresh,
      });

    const refreshed = await run(true);
    expect(refreshed.documents).toHaveLength(DOC_CAP);
    expect(refreshed.capWarnings).toHaveLength(1);
    expect(refreshed.capWarnings[0]).not.toContain('narrow');

    const next = await run();
    expect(next.documents).toHaveLength(files.length - DOC_CAP);
    expect(next.capWarnings).toEqual([]);
  });

  it('leaves the list of files read out of the STATE message', async () => {
    const state: ExtractorState = {
      streams: {
        'docs_source/docs': {
          last_run_at: '2026-01-01T00:00:00.000Z',
          record_count: 0,
          files: seededBookmarks(20_000),
        },
      },
    };
    const result = await runDocuments({
      client: fakeS3Client(markdownFiles(['01', '02', '03'])),
      integration: s3Documents.integration,
      resource: s3DocumentResource(),
      state,
    });

    expect(result.states).toHaveLength(1);
    expect(stateKeys(result.states[0])).toEqual(['last_run_at', 'record_count']);
    const saved = state.streams['docs_source/docs'] as { files?: Record<string, unknown> };
    expect(Object.keys(saved.files ?? {})).toHaveLength(20_000 + DOC_CAP);
  });

  it('stops trying to download at the limit even when every download fails', async () => {
    const attempted: string[] = [];
    const result = await runDocuments({
      client: fakeS3Client(markdownFiles(['01', '02', '03', '04']), {
        failDownloads: true,
        onDownload: (key) => attempted.push(key),
      }),
      integration: s3Documents.integration,
      resource: s3DocumentResource(),
      state: { streams: {} },
    });
    expect(result.documents).toHaveLength(0);
    expect(result.parseErrors).toBe(DOC_CAP);
    expect(attempted).toHaveLength(DOC_CAP);
    expect(result.capWarnings).toHaveLength(1);
  });
});
