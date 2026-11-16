import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GcsFileStorageClient } from '../../src/runtime/clients/gcs-file-client.js';
import { S3FileStorageClient } from '../../src/runtime/clients/s3-file-client.js';
import { SftpFileStorageClient } from '../../src/runtime/clients/sftp-file-client.js';

import type { SFTPWrapper } from 'ssh2';

import type { ListedFile } from '../../src/framework/core/index.js';

const originalPrivateHostsValue = process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];

afterEach(() => {
  if (originalPrivateHostsValue === undefined) {
    delete process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
  } else {
    process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'] = originalPrivateHostsValue;
  }
});

describe('file storage clients', () => {
  it('keeps GCS etag and generation separate when listing and downloading', async () => {
    let downloadOptions: Record<string, unknown> | undefined;
    const bucket = {
      getFiles: async () => [
        [
          {
            name: 'events/a.parquet',
            metadata: {
              updated: '2026-05-01T12:34:56.000Z',
              generation: '1714567890123456',
              etag: 'abc123',
              size: '42',
            },
            download: async () => undefined,
          },
        ],
        undefined,
        undefined,
      ],
      file: (name: string, options?: Record<string, unknown>) => {
        downloadOptions = options;
        return {
          name,
          download: async () => undefined,
        };
      },
    };
    const client = new GcsFileStorageClient({ bucket: 'raw' }, bucket as never);

    const files = [];
    for await (const file of client.list({ path: 'events/*.parquet' })) {
      files.push(file);
    }
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      etag: 'abc123',
      generation: '1714567890123456',
      last_modified: '2026-05-01T12:34:56.000Z',
    });

    await client.download(files[0] as ListedFile, path.join(tmpdir(), 'gcs-client-test.parquet'));

    expect(downloadOptions).toEqual({ generation: '1714567890123456' });
  });

  it('passes the GCS path glob and follows the next-query page token', async () => {
    const requests: Record<string, unknown>[] = [];
    const bucket = {
      getFiles: async (options: Record<string, unknown>) => {
        requests.push(options);
        return options['pageToken']
          ? [
              [{ name: 'events/b.parquet', download: async () => undefined }],
              undefined,
              { pageToken: 'ignored-api-response-token' },
            ]
          : [
              [{ name: 'events/a.parquet', download: async () => undefined }],
              { pageToken: 'next-page' },
              { pageToken: 'ignored-api-response-token' },
            ];
      },
      file: (name: string) => ({ name, download: async () => undefined }),
    };
    const client = new GcsFileStorageClient({ bucket: 'raw' }, bucket as never);

    const files = [];
    for await (const file of client.list({ path: 'events/*.parquet' })) {
      files.push(file.path);
    }

    expect(files).toEqual(['events/a.parquet', 'events/b.parquet']);
    expect(requests).toEqual([
      {
        autoPaginate: false,
        matchGlob: 'events/*.parquet',
        pageToken: undefined,
        prefix: 'events/',
      },
      {
        autoPaginate: false,
        matchGlob: 'events/*.parquet',
        pageToken: 'next-page',
        prefix: 'events/',
      },
    ]);
  });

  it('filters S3 list results by the original glob after prefix listing', async () => {
    class ListObjectsV2Command {
      constructor(readonly input: unknown) {}
    }
    class GetObjectCommand {
      constructor(readonly input: unknown) {}
    }
    const client = new S3FileStorageClient(
      { bucket: 'raw', region: 'us-east-1' },
      { type: 'default_chain' },
      {
        ListObjectsV2Command,
        GetObjectCommand,
        client: {
          send: async () => ({
            Contents: [
              { Key: 'events/a.parquet', LastModified: new Date('2026-05-01'), ETag: '"A"' },
              { Key: 'events/a.csv', LastModified: new Date('2026-05-01'), ETag: '"B"' },
              { Key: 'events/nested/b.parquet', LastModified: new Date('2026-05-01'), ETag: '"C"' },
            ],
          }),
        },
      }
    );

    const files = [];
    for await (const file of client.list({ path: 'events/*.parquet' })) {
      files.push(file.path);
    }

    expect(files).toEqual(['events/a.parquet']);
  });

  it('rejects cleartext public S3 endpoints even with the private-host opt-in', async () => {
    process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'] = '1';
    const injected = {
      client: { send: async () => ({}) },
      ListObjectsV2Command: class {
        constructor(readonly input: unknown) {}
      },
      GetObjectCommand: class {
        constructor(readonly input: unknown) {}
      },
    };

    await expect(
      S3FileStorageClient.create(
        {
          bucket: 'raw',
          region: 'us-east-1',
          endpoint: 'http://public.example.com',
        },
        { type: 'static_env', access_key_id_env: 'ID', secret_access_key_env: 'KEY' },
        injected,
        ['ID', 'KEY']
      )
    ).rejects.toThrow('S3 endpoints must use HTTPS');
  });

  it('allows cleartext loopback S3 endpoints only with the private-host opt-in', async () => {
    delete process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
    const injected = {
      client: { send: async () => ({}) },
      ListObjectsV2Command: class {
        constructor(readonly input: unknown) {}
      },
      GetObjectCommand: class {
        constructor(readonly input: unknown) {}
      },
    };
    const connection = {
      bucket: 'raw',
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:9000',
    };

    await expect(
      S3FileStorageClient.create(
        connection,
        { type: 'static_env', access_key_id_env: 'ID', secret_access_key_env: 'KEY' },
        injected,
        ['ID', 'KEY']
      )
    ).rejects.toThrow('S3 endpoints must use HTTPS');

    process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'] = '1';
    await expect(
      S3FileStorageClient.create(
        connection,
        { type: 'static_env', access_key_id_env: 'ID', secret_access_key_env: 'KEY' },
        injected,
        ['ID', 'KEY']
      )
    ).resolves.toBeInstanceOf(S3FileStorageClient);
  });

  it('rejects unsafe provider-relative SFTP paths before opening a stream', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'sftp-client-test-'));
    let openedPath: string | undefined;
    const client = await SftpFileStorageClient.create(
      {
        host: 'example.com',
        username: 'agent',
        base_directory: '/exports',
        host_keys: [{ algorithm: 'ssh-ed25519', fingerprint: `SHA256:${'A'.repeat(43)}` }],
        read_concurrency: 4,
      },
      { type: 'password', password_env: 'UNUSED' },
      {
        sftp: {
          realpath: (pathname: string) => {
            openedPath = pathname;
          },
          fastGet: (pathname: string) => {
            openedPath = pathname;
          },
          end: () => undefined,
        } as unknown as SFTPWrapper,
      },
      ['UNUSED']
    );

    await expect(
      client.download(
        { path: '../etc/passwd', uri: 'sftp://example.com/../etc/passwd' },
        path.join(tempDir, 'out.txt')
      )
    ).rejects.toThrow('Unsafe SFTP file path');
    expect(openedPath).toBeUndefined();
  });
});
