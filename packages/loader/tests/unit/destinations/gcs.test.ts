import { afterEach, describe, expect, it, vi } from 'vitest';

import { GcsDestination } from '../../../src/runtime/destinations/gcs.js';

function mockStorage() {
  const uploads: Array<{
    bucket: string;
    destination: string;
    localPath: string;
    contentType?: string;
  }> = [];
  const storage = {
    bucket(bucketName: string) {
      return {
        async upload(
          localPath: string,
          options: { destination: string; contentType?: string }
        ): Promise<void> {
          uploads.push({
            bucket: bucketName,
            destination: options.destination,
            localPath,
            contentType: options.contentType,
          });
        },
      };
    },
  };
  return { storage, uploads };
}

describe('GcsDestination', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('@google-cloud/storage');
  });
  it('uploads files with the configured bucket and prefix', async () => {
    const { storage, uploads } = mockStorage();

    const destination = new GcsDestination({
      bucket: 'target-test-bucket',
      prefix: 'exports',
      storage,
    });

    const uri = await destination.publish('/tmp/issues.parquet', 'issues/issues-0.parquet');

    expect(uri).toBe('gs://target-test-bucket/exports/issues/issues-0.parquet');
    expect(uploads).toEqual([
      {
        bucket: 'target-test-bucket',
        destination: 'exports/issues/issues-0.parquet',
        localPath: '/tmp/issues.parquet',
      },
    ]);
  });

  it('uploads without prefix', async () => {
    const { storage, uploads } = mockStorage();

    const destination = new GcsDestination({
      bucket: 'my-bucket',
      storage,
    });

    const uri = await destination.publish('/tmp/file.parquet', 'file.parquet');

    expect(uri).toBe('gs://my-bucket/file.parquet');
    expect(uploads).toEqual([
      {
        bucket: 'my-bucket',
        destination: 'file.parquet',
        localPath: '/tmp/file.parquet',
      },
    ]);
  });

  it('normalizes trailing slash in prefix', async () => {
    const { storage, uploads } = mockStorage();

    const destination = new GcsDestination({
      bucket: 'my-bucket',
      prefix: 'exports/',
      storage,
    });

    const uri = await destination.publish('/tmp/file.parquet', 'data/file.parquet');

    expect(uri).toBe('gs://my-bucket/exports/data/file.parquet');
    expect(uploads[0]!.destination).toBe('exports/data/file.parquet');
  });

  it('handles empty prefix the same as no prefix', async () => {
    const { storage: storageA, uploads: uploadsA } = mockStorage();
    const { storage: storageB, uploads: uploadsB } = mockStorage();

    const destA = new GcsDestination({ bucket: 'my-bucket', storage: storageA });
    const destB = new GcsDestination({ bucket: 'my-bucket', prefix: '', storage: storageB });

    const uriA = await destA.publish('/tmp/file.parquet', 'dir/file.parquet');
    const uriB = await destB.publish('/tmp/file.parquet', 'dir/file.parquet');

    expect(uriA).toBe(uriB);
    expect(uploadsA[0]!.destination).toBe(uploadsB[0]!.destination);
  });

  it('supports multiple uploads', async () => {
    const { storage, uploads } = mockStorage();

    const destination = new GcsDestination({
      bucket: 'my-bucket',
      prefix: 'data',
      storage,
    });

    await destination.publish('/tmp/file1.parquet', 'stream1/file1.parquet');
    await destination.publish('/tmp/file2.parquet', 'stream2/file2.parquet');
    await destination.publish('/tmp/file3.parquet', 'stream3/file3.parquet');

    expect(uploads).toHaveLength(3);
    expect(uploads.map((u) => u.destination)).toEqual([
      'data/stream1/file1.parquet',
      'data/stream2/file2.parquet',
      'data/stream3/file3.parquet',
    ]);
  });

  it('rejects invalid bucket names', () => {
    expect(() => new GcsDestination({ bucket: 'Bad Bucket' })).toThrow('Invalid GCS bucket name');
  });

  it('rejects single-char bucket name (too short)', () => {
    expect(() => new GcsDestination({ bucket: 'ab' })).toThrow('must be 3-222 characters');
  });

  it('accepts exactly 3-char bucket name', () => {
    expect(() => new GcsDestination({ bucket: 'abc' })).not.toThrow();
  });

  it('accepts 222-char bucket name', () => {
    const name = 'a' + 'b'.repeat(220) + 'c';
    expect(name).toHaveLength(222);
    expect(() => new GcsDestination({ bucket: name })).not.toThrow();
  });

  it('rejects 223-char bucket name (too long)', () => {
    const name = 'a' + 'b'.repeat(221) + 'c';
    expect(name).toHaveLength(223);
    expect(() => new GcsDestination({ bucket: name })).toThrow('must be 3-222 characters');
  });

  it('rejects bucket name with leading hyphen', () => {
    expect(() => new GcsDestination({ bucket: '-my-bucket' })).toThrow(
      'invalid characters or start/end'
    );
  });

  it('rejects bucket name with trailing hyphen', () => {
    expect(() => new GcsDestination({ bucket: 'my-bucket-' })).toThrow(
      'invalid characters or start/end'
    );
  });

  it('accepts bucket name with dots', () => {
    expect(() => new GcsDestination({ bucket: 'my.bucket.name' })).not.toThrow();
  });

  it('accepts bucket name with internal hyphens', () => {
    expect(() => new GcsDestination({ bucket: 'my-bucket-name' })).not.toThrow();
  });

  it('rejects traversal in prefix', () => {
    expect(() => new GcsDestination({ bucket: 'target-test-bucket', prefix: '../escape' })).toThrow(
      'Invalid destination path'
    );
  });

  it('rejects traversal in destination paths', async () => {
    const { storage } = mockStorage();
    const destination = new GcsDestination({
      bucket: 'target-test-bucket',
      storage,
    });

    await expect(destination.publish('/tmp/issues.parquet', '../escape.parquet')).rejects.toThrow(
      'Invalid destination path'
    );
  });

  it('throws clear error when @google-cloud/storage dynamic import fails', async () => {
    // Use a module mock to make the dynamic import throw
    vi.doMock('@google-cloud/storage', () => {
      throw new Error('Cannot find module');
    });

    const { GcsDestination: FreshGcs } = await import('../../../src/runtime/destinations/gcs.js');
    const destination = new FreshGcs({ bucket: 'my-bucket' });

    await expect(destination.publish('/tmp/file.parquet', 'file.parquet')).rejects.toThrow(
      /Failed to load @google-cloud\/storage/
    );

    vi.doUnmock('@google-cloud/storage');
  });

  it('sets content-type when format is provided', async () => {
    const { storage, uploads } = mockStorage();

    const destination = new GcsDestination({
      bucket: 'my-bucket',
      format: 'csv',
      storage,
    });

    await destination.publish('/tmp/file.csv', 'file.csv');

    expect(uploads[0]!.contentType).toBe('text/csv');
  });

  it('omits content-type when format is not provided', async () => {
    const { storage, uploads } = mockStorage();

    const destination = new GcsDestination({
      bucket: 'my-bucket',
      storage,
    });

    await destination.publish('/tmp/file.parquet', 'file.parquet');

    expect(uploads[0]!.contentType).toBeUndefined();
  });

  it('retries on transient errors', async () => {
    let attempts = 0;
    const storage = {
      bucket() {
        return {
          async upload(): Promise<void> {
            attempts++;
            if (attempts < 3) {
              const error = new Error('service unavailable');
              throw error;
            }
          },
        };
      },
    };

    const destination = new GcsDestination({
      bucket: 'my-bucket',
      storage,
    });

    await destination.publish('/tmp/file.parquet', 'file.parquet');

    expect(attempts).toBe(3);
  });
});
