import * as path from 'node:path';

import { withRetry } from './retry.js';

/**
 * Dependency-injection interface for a GCS bucket client.
 * Mirrors the subset of `@google-cloud/storage` Bucket used for staging.
 */
export interface GcsStagingClientLike {
  upload(
    localPath: string,
    options: { destination: string; validation?: boolean | string }
  ): Promise<unknown>;
  file(name: string): { delete(): Promise<unknown> };
}

export interface GcsStagingManagerOptions {
  bucket: string;
  prefix?: string;
  client?: GcsStagingClientLike;
  /**
   * Shared google-auth `AuthClient` to construct the `Storage` client with.
   * Passed when the BigQuery destination uses a refreshable token provider so
   * staging uploads refresh on the same credential. When omitted, the Storage
   * client falls back to Application Default Credentials (existing behavior).
   */
  authClient?: unknown;
}

/**
 * Manages temporary staging files in GCS for BigQuery LOAD jobs.
 *
 * Tracks every uploaded file so they can be cleaned up after the load
 * completes (or fails).
 */
export class GcsStagingManager {
  private readonly bucketName: string;
  private readonly prefix: string;
  private readonly providedClient?: GcsStagingClientLike;
  private readonly authClient?: unknown;
  private cachedClient?: GcsStagingClientLike;
  private readonly uploadedFiles: string[] = [];

  constructor(options: GcsStagingManagerOptions) {
    this.bucketName = options.bucket;
    this.prefix = options.prefix ? options.prefix.replace(/\/+$/, '') : '';
    this.providedClient = options.client;
    this.authClient = options.authClient;
  }

  /**
   * Upload a local file to the staging area and return its `gs://` URI.
   */
  async upload(localPath: string, remoteName: string): Promise<string> {
    const destination = this.prefix ? path.posix.join(this.prefix, remoteName) : remoteName;

    const client = await this.getClient();
    await client.upload(localPath, {
      destination,
      validation: 'crc32c',
    });

    this.uploadedFiles.push(destination);
    return `gs://${this.bucketName}/${destination}`;
  }

  /**
   * Upload multiple local files in parallel with bounded concurrency.
   */
  async uploadAll(files: string[], concurrency: number = 5): Promise<string[]> {
    const results: string[] = new Array(files.length);
    let nextIndex = 0;

    async function worker(this: GcsStagingManager): Promise<void> {
      while (nextIndex < files.length) {
        const idx = nextIndex++;
        const filePath = files[idx]!;
        const remoteName = path.basename(filePath);
        results[idx] = await this.upload(filePath, remoteName);
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, files.length) }, () =>
      worker.call(this)
    );
    await Promise.all(workers);

    return results;
  }

  /**
   * Remove a single staged file from GCS.
   */
  async cleanup(remoteName: string): Promise<void> {
    const destination = this.prefix ? path.posix.join(this.prefix, remoteName) : remoteName;

    const client = await this.getClient();
    await withRetry(() => client.file(destination).delete(), {
      maxAttempts: 3,
      initialDelayMs: 1_000,
    });
  }

  /**
   * Best-effort cleanup of all files uploaded by this manager.
   * Individual delete failures are swallowed so remaining files still get cleaned up.
   */
  async cleanupAll(): Promise<void> {
    const client = await this.getClient();

    await Promise.all(
      this.uploadedFiles.map(async (destination) => {
        try {
          await client.file(destination).delete();
        } catch {
          // best-effort: log would go here, but we intentionally swallow
        }
      })
    );
  }

  private async getClient(): Promise<GcsStagingClientLike> {
    if (this.providedClient) {
      return this.providedClient;
    }

    if (this.cachedClient) {
      return this.cachedClient;
    }

    try {
      const module = await import('@google-cloud/storage');
      const storage = this.authClient
        ? new module.Storage({ authClient: this.authClient as never })
        : new module.Storage();
      this.cachedClient = storage.bucket(this.bucketName);
      return this.cachedClient;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to load @google-cloud/storage. Install it to use GCS staging. ${message}`
      );
    }
  }
}
