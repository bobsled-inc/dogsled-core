import * as path from 'node:path';

import { contentTypeForFormat, type OutputFormat } from '../formats.js';
import { withRetry } from '../retry.js';
import {
  assertObjectKeyLength,
  normalizeDestinationPath,
  type FileDestination,
  type PublishOptions,
} from './types.js';

export interface GcsBucketLike {
  upload(
    localPath: string,
    options: {
      destination: string;
      validation?: boolean | string;
      contentType?: string;
    }
  ): Promise<unknown>;
}

export interface GcsStorageLike {
  bucket(name: string): GcsBucketLike;
}

export interface GcsDestinationOptions {
  bucket: string;
  prefix?: string;
  format?: OutputFormat;
  storage?: GcsStorageLike;
}

/**
 * Best-effort pre-check for GCS bucket naming rules.
 * GCS will reject truly invalid names at upload time — this catches common errors early.
 * @see https://cloud.google.com/storage/docs/buckets#naming
 */
function validateBucketName(name: string): void {
  if (name.length < 3 || name.length > 222) {
    throw new Error(`Invalid GCS bucket name "${name}": must be 3-222 characters`);
  }
  if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(name)) {
    throw new Error(`Invalid GCS bucket name "${name}": invalid characters or start/end`);
  }
}

const GCS_RETRY_OPTIONS = {
  maxAttempts: 4,
  initialDelayMs: 1_000,
  maxDelayMs: 8_000,
  onRetry: (attempt: number, delay: number, error: Error) => {
    process.stderr.write(`[GcsDestination] retry ${attempt} after ${delay}ms: ${error.message}\n`);
  },
} as const;

export class GcsDestination implements FileDestination {
  private readonly bucketName: string;
  private readonly prefix: string;
  private readonly format: OutputFormat | undefined;
  private readonly providedStorage?: GcsStorageLike;
  private cachedStorage?: GcsStorageLike;

  constructor(options: GcsDestinationOptions) {
    validateBucketName(options.bucket);

    this.bucketName = options.bucket;
    this.prefix = options.prefix
      ? normalizeDestinationPath(options.prefix).replace(/\/+$/, '')
      : '';
    this.format = options.format;
    this.providedStorage = options.storage;
  }

  async publish(localPath: string, destPath: string, options?: PublishOptions): Promise<string> {
    const normalizedPath = normalizeDestinationPath(destPath);
    const objectPath = this.prefix ? path.posix.join(this.prefix, normalizedPath) : normalizedPath;
    assertObjectKeyLength(objectPath);
    const storage = await this.getStorage();

    const uploadOptions: { destination: string; validation: string; contentType?: string } = {
      destination: objectPath,
      validation: 'crc32c',
    };
    if (this.format && !options?.copy) {
      uploadOptions.contentType = contentTypeForFormat(this.format);
    }

    await withRetry(
      () => storage.bucket(this.bucketName).upload(localPath, uploadOptions),
      GCS_RETRY_OPTIONS
    );

    return `gs://${this.bucketName}/${objectPath}`;
  }

  private async getStorage(): Promise<GcsStorageLike> {
    if (this.providedStorage) {
      return this.providedStorage;
    }

    if (this.cachedStorage) {
      return this.cachedStorage;
    }

    try {
      const module = await import('@google-cloud/storage');
      this.cachedStorage = new module.Storage();
      return this.cachedStorage;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to load @google-cloud/storage. Install it to use --dest gcs. ${message}`
      );
    }
  }
}
