import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { S3Destination } from '../../../src/runtime/destinations/s3.js';

interface MockUpload {
  bucket: string;
  key: string;
  body: unknown;
  checksumAlgorithm?: string;
  contentType?: string;
}

let tmpDir: string;
let tmpFile: string;
let tmpFiles: string[];

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 's3-test-'));
  tmpFile = path.join(tmpDir, 'test.parquet');
  await fsp.writeFile(tmpFile, 'test-content');
  tmpFiles = await Promise.all(
    [1, 2, 3].map(async (i) => {
      const p = path.join(tmpDir, `file${i}.parquet`);
      await fsp.writeFile(p, `content-${i}`);
      return p;
    })
  );
});

afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function mockS3Client() {
  const uploads: MockUpload[] = [];
  const client = {
    async send(command: { input: Record<string, unknown> }): Promise<Record<string, never>> {
      const body = command.input.Body;
      // Consume and destroy the ReadStream to prevent uncaught ENOENT
      if (body instanceof fs.ReadStream) {
        await new Promise<void>((resolve) => {
          body.on('end', resolve);
          body.on('error', resolve);
          body.resume();
        });
      }
      uploads.push({
        bucket: command.input.Bucket as string,
        key: command.input.Key as string,
        body,
        checksumAlgorithm: command.input.ChecksumAlgorithm as string | undefined,
        contentType: command.input.ContentType as string | undefined,
      });
      return {};
    },
  };
  return { client, uploads };
}

describe('S3Destination', () => {
  it('uploads files with the configured bucket and prefix', async () => {
    const { client, uploads } = mockS3Client();

    const destination = new S3Destination({
      bucket: 'target-test-bucket',
      prefix: 'exports',
      client,
    });

    const uri = await destination.publish(tmpFile, 'issues/issues-0.parquet');

    expect(uri).toBe('s3://target-test-bucket/exports/issues/issues-0.parquet');
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.bucket).toBe('target-test-bucket');
    expect(uploads[0]!.key).toBe('exports/issues/issues-0.parquet');
  });

  it('uploads files without prefix', async () => {
    const { client, uploads } = mockS3Client();

    const destination = new S3Destination({
      bucket: 'target-test-bucket',
      client,
    });

    const uri = await destination.publish(tmpFile, 'issues/issues-0.parquet');

    expect(uri).toBe('s3://target-test-bucket/issues/issues-0.parquet');
    expect(uploads[0]!.key).toBe('issues/issues-0.parquet');
  });

  it('streams file content in Body, not the file path string', async () => {
    const { client, uploads } = mockS3Client();

    const destination = new S3Destination({
      bucket: 'target-test-bucket',
      client,
    });

    await destination.publish(tmpFile, 'issues/issues-0.parquet');

    expect(uploads[0]!.body).toBeInstanceOf(fs.ReadStream);
  });

  it('includes SHA256 checksum algorithm', async () => {
    const { client, uploads } = mockS3Client();

    const destination = new S3Destination({
      bucket: 'target-test-bucket',
      client,
    });

    await destination.publish(tmpFile, 'issues/issues-0.parquet');

    expect(uploads[0]!.checksumAlgorithm).toBe('SHA256');
  });

  it('sets content-type when format is provided', async () => {
    const { client, uploads } = mockS3Client();

    const destination = new S3Destination({
      bucket: 'target-test-bucket',
      format: 'parquet',
      client,
    });

    await destination.publish(tmpFile, 'issues/issues-0.parquet');

    expect(uploads[0]!.contentType).toBe('application/vnd.apache.parquet');
  });

  it('omits content-type when format is not provided', async () => {
    const { client, uploads } = mockS3Client();

    const destination = new S3Destination({
      bucket: 'target-test-bucket',
      client,
    });

    await destination.publish(tmpFile, 'issues/issues-0.parquet');

    expect(uploads[0]!.contentType).toBeUndefined();
  });

  it('normalizes trailing slash in prefix', async () => {
    const { client, uploads } = mockS3Client();

    const destination = new S3Destination({
      bucket: 'my-bucket',
      prefix: 'exports/',
      client,
    });

    const uri = await destination.publish(tmpFile, 'data/file.parquet');

    expect(uri).toBe('s3://my-bucket/exports/data/file.parquet');
    expect(uploads[0]!.key).toBe('exports/data/file.parquet');
  });

  it('handles empty prefix the same as no prefix', async () => {
    const { client: clientA, uploads: uploadsA } = mockS3Client();
    const { client: clientB, uploads: uploadsB } = mockS3Client();

    const destA = new S3Destination({ bucket: 'my-bucket', client: clientA });
    const destB = new S3Destination({ bucket: 'my-bucket', prefix: '', client: clientB });

    const uriA = await destA.publish(tmpFile, 'dir/file.parquet');
    const uriB = await destB.publish(tmpFile, 'dir/file.parquet');

    expect(uriA).toBe(uriB);
    expect(uploadsA[0]!.key).toBe(uploadsB[0]!.key);
  });

  it('supports multiple sequential uploads', async () => {
    const { client, uploads } = mockS3Client();

    const destination = new S3Destination({
      bucket: 'my-bucket',
      prefix: 'data',
      client,
    });

    await destination.publish(tmpFiles[0]!, 'stream1/file1.parquet');
    await destination.publish(tmpFiles[1]!, 'stream2/file2.parquet');
    await destination.publish(tmpFiles[2]!, 'stream3/file3.parquet');

    expect(uploads).toHaveLength(3);
    expect(uploads.map((u) => u.key)).toEqual([
      'data/stream1/file1.parquet',
      'data/stream2/file2.parquet',
      'data/stream3/file3.parquet',
    ]);
  });

  it('rejects bucket names that are too short', () => {
    expect(() => new S3Destination({ bucket: 'ab' })).toThrow('Invalid S3 bucket name');
  });

  it('accepts bucket names at minimum length', () => {
    expect(() => new S3Destination({ bucket: 'abc' })).not.toThrow();
  });

  it('rejects bucket names that are too long', () => {
    const longName = 'a'.repeat(64);
    expect(() => new S3Destination({ bucket: longName })).toThrow('Invalid S3 bucket name');
  });

  it('accepts bucket names at maximum length', () => {
    const maxName = 'a'.repeat(63);
    expect(() => new S3Destination({ bucket: maxName })).not.toThrow();
  });

  it('rejects bucket names with uppercase characters', () => {
    expect(() => new S3Destination({ bucket: 'BadBucket' })).toThrow('Invalid S3 bucket name');
  });

  it('rejects bucket names with underscores', () => {
    expect(() => new S3Destination({ bucket: 'my_bucket' })).toThrow('Invalid S3 bucket name');
  });

  it('rejects bucket name with leading hyphen', () => {
    expect(() => new S3Destination({ bucket: '-my-bucket' })).toThrow(
      'invalid characters or start/end'
    );
  });

  it('rejects bucket name with trailing hyphen', () => {
    expect(() => new S3Destination({ bucket: 'my-bucket-' })).toThrow(
      'invalid characters or start/end'
    );
  });

  it('accepts bucket name with dots', () => {
    expect(() => new S3Destination({ bucket: 'my.bucket.name' })).not.toThrow();
  });

  it('accepts bucket name with internal hyphens', () => {
    expect(() => new S3Destination({ bucket: 'my-bucket-name' })).not.toThrow();
  });

  it('rejects traversal in prefix', () => {
    expect(() => new S3Destination({ bucket: 'target-test-bucket', prefix: '../escape' })).toThrow(
      'Invalid destination path'
    );
  });

  it('rejects traversal in destination paths', async () => {
    const { client } = mockS3Client();
    const destination = new S3Destination({
      bucket: 'target-test-bucket',
      client,
    });

    await expect(destination.publish(tmpFile, '../escape.parquet')).rejects.toThrow(
      'Invalid destination path'
    );
  });

  it('propagates SDK errors when no client is provided', async () => {
    const destination = new S3Destination({
      bucket: 'target-test-bucket',
    });

    await expect(destination.publish(tmpFile, 'issues/issues-0.parquet')).rejects.toThrow();
  });

  it('propagates errors from PutObject', async () => {
    const client = {
      async send(): Promise<never> {
        throw new Error('Access Denied');
      },
    };

    const destination = new S3Destination({
      bucket: 'target-test-bucket',
      client,
    });

    await expect(destination.publish(tmpFile, 'issues/issues-0.parquet')).rejects.toThrow(
      'Access Denied'
    );
  });

  it('destroys the ReadStream on upload failure', async () => {
    let capturedBody: fs.ReadStream | undefined;
    const client = {
      async send(command: { input: Record<string, unknown> }): Promise<never> {
        const body = command.input.Body;
        if (body instanceof fs.ReadStream) {
          capturedBody = body;
        }
        throw new Error('Access Denied');
      },
    };

    const destination = new S3Destination({
      bucket: 'target-test-bucket',
      client,
    });

    await expect(destination.publish(tmpFile, 'issues/issues-0.parquet')).rejects.toThrow(
      'Access Denied'
    );

    expect(capturedBody).toBeInstanceOf(fs.ReadStream);
    expect(capturedBody!.destroyed).toBe(true);
  });
});
