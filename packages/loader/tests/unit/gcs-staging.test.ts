import { describe, expect, it, vi } from 'vitest';

import type { GcsStagingClientLike } from '../../src/runtime/gcs-staging.js';
import { GcsStagingManager } from '../../src/runtime/gcs-staging.js';

function createMockClient(): GcsStagingClientLike & {
  uploads: Array<{ localPath: string; destination: string }>;
  deletedFiles: string[];
} {
  const uploads: Array<{ localPath: string; destination: string }> = [];
  const deletedFiles: string[] = [];

  return {
    uploads,
    deletedFiles,
    upload: vi.fn(async (localPath: string, options: { destination: string }) => {
      uploads.push({ localPath, destination: options.destination });
    }),
    file: vi.fn((name: string) => ({
      delete: vi.fn(async () => {
        deletedFiles.push(name);
      }),
    })),
  };
}

describe('GcsStagingManager', () => {
  it('upload() returns correct gs:// URI', async () => {
    const client = createMockClient();
    const manager = new GcsStagingManager({
      bucket: 'staging-bucket',
      prefix: 'tmp/loads',
      client,
    });

    const uri = await manager.upload('/tmp/data.parquet', 'data-0.parquet');

    expect(uri).toBe('gs://staging-bucket/tmp/loads/data-0.parquet');
  });

  it('upload() calls client.upload with correct destination (with prefix)', async () => {
    const client = createMockClient();
    const manager = new GcsStagingManager({
      bucket: 'staging-bucket',
      prefix: 'staging/job-123',
      client,
    });

    await manager.upload('/local/file.parquet', 'part-0.parquet');

    expect(client.upload).toHaveBeenCalledWith('/local/file.parquet', {
      destination: 'staging/job-123/part-0.parquet',
      validation: 'crc32c',
    });
  });

  it('upload() calls client.upload with correct destination (without prefix)', async () => {
    const client = createMockClient();
    const manager = new GcsStagingManager({
      bucket: 'staging-bucket',
      client,
    });

    await manager.upload('/local/file.parquet', 'part-0.parquet');

    expect(client.upload).toHaveBeenCalledWith('/local/file.parquet', {
      destination: 'part-0.parquet',
      validation: 'crc32c',
    });
    expect(client.uploads[0]?.destination).toBe('part-0.parquet');
  });

  it('cleanup() calls file().delete()', async () => {
    const client = createMockClient();
    const manager = new GcsStagingManager({
      bucket: 'staging-bucket',
      prefix: 'staging',
      client,
    });

    await manager.cleanup('part-0.parquet');

    expect(client.file).toHaveBeenCalledWith('staging/part-0.parquet');
    expect(client.deletedFiles).toEqual(['staging/part-0.parquet']);
  });

  it('cleanupAll() handles partial failures', async () => {
    let callCount = 0;
    const deletedFiles: string[] = [];
    const client: GcsStagingClientLike = {
      upload: vi.fn(async () => undefined),
      file: vi.fn((name: string) => ({
        delete: vi.fn(async () => {
          callCount++;
          if (callCount === 2) {
            throw new Error('Network error');
          }
          deletedFiles.push(name);
        }),
      })),
    };

    const manager = new GcsStagingManager({
      bucket: 'staging-bucket',
      client,
    });

    // Upload three files to track them
    await manager.upload('/tmp/a.parquet', 'a.parquet');
    await manager.upload('/tmp/b.parquet', 'b.parquet');
    await manager.upload('/tmp/c.parquet', 'c.parquet');

    // cleanupAll should not throw even though the second delete fails
    await expect(manager.cleanupAll()).resolves.toBeUndefined();

    // The first and third files should still be cleaned up
    expect(deletedFiles).toEqual(['a.parquet', 'c.parquet']);
  });

  it('cleanupAll() cleans up all tracked files', async () => {
    const client = createMockClient();
    const manager = new GcsStagingManager({
      bucket: 'staging-bucket',
      prefix: 'job-456',
      client,
    });

    await manager.upload('/tmp/a.parquet', 'a.parquet');
    await manager.upload('/tmp/b.parquet', 'b.parquet');

    await manager.cleanupAll();

    expect(client.deletedFiles).toEqual(['job-456/a.parquet', 'job-456/b.parquet']);
  });

  it('uploadAll() uploads multiple files and returns URIs', async () => {
    const client = createMockClient();
    const manager = new GcsStagingManager({
      bucket: 'staging-bucket',
      prefix: 'bulk',
      client,
    });

    const uris = await manager.uploadAll([
      '/tmp/part-0.parquet',
      '/tmp/part-1.parquet',
      '/tmp/part-2.parquet',
    ]);

    expect(uris).toEqual([
      'gs://staging-bucket/bulk/part-0.parquet',
      'gs://staging-bucket/bulk/part-1.parquet',
      'gs://staging-bucket/bulk/part-2.parquet',
    ]);
    expect(client.uploads).toHaveLength(3);
  });

  it('uploadAll() respects concurrency limit', async () => {
    let peakConcurrency = 0;
    let activeConcurrency = 0;

    const client: GcsStagingClientLike = {
      upload: vi.fn(async (localPath: string, options: { destination: string }) => {
        activeConcurrency++;
        peakConcurrency = Math.max(peakConcurrency, activeConcurrency);
        // Simulate async work so concurrency is observable
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeConcurrency--;
        void localPath;
        void options;
      }),
      file: vi.fn((name: string) => ({
        delete: vi.fn(async () => {
          void name;
        }),
      })),
    };

    const manager = new GcsStagingManager({
      bucket: 'staging-bucket',
      client,
    });

    const files = Array.from({ length: 10 }, (_, i) => `/tmp/part-${i}.parquet`);

    const uris = await manager.uploadAll(files, 3);

    expect(uris).toHaveLength(10);
    expect(peakConcurrency).toBeLessThanOrEqual(3);
    expect(peakConcurrency).toBeGreaterThanOrEqual(1);
  });
});
