import { assertDriverVersion } from '@bobsled-inc/connections';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { S3ClientConfig } from '@aws-sdk/client-s3';

import { contentTypeForFormat, type OutputFormat } from '../formats.js';
import { isRetryableError, withRetry } from '../retry.js';
import {
  assertObjectKeyLength,
  normalizeDestinationPath,
  type FileDestination,
  type PublishOptions,
} from './types.js';

const S3_TRANSIENT_ERROR_NAMES = new Set([
  'ThrottlingException',
  'SlowDown',
  'ServiceUnavailable',
  'RequestTimeout',
]);

function isS3RetryableError(error: unknown): boolean {
  if (isRetryableError(error)) return true;
  if (error instanceof Error) {
    if (S3_TRANSIENT_ERROR_NAMES.has(error.name)) return true;
  }
  return false;
}

export interface S3ClientLike {
  send(command: unknown): Promise<unknown>;
}

export interface S3DestinationOptions {
  bucket: string;
  prefix?: string;
  region?: string;
  roleArn?: string;
  externalId?: string;
  format?: OutputFormat;
  client?: S3ClientLike;
}

function validateBucketName(name: string): void {
  if (name.length < 3 || name.length > 63) {
    throw new Error(`Invalid S3 bucket name "${name}": must be 3-63 characters`);
  }
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name)) {
    throw new Error(`Invalid S3 bucket name "${name}": invalid characters or start/end`);
  }
}

/**
 * Build an S3ClientConfig with optional STS role assumption.
 * Shared between S3Destination and the check command.
 */
export async function buildS3ClientConfig(options: {
  region?: string;
  roleArn?: string;
  externalId?: string;
}): Promise<S3ClientConfig> {
  const config: S3ClientConfig = {};
  if (options.region) {
    config.region = options.region;
  }

  if (options.roleArn) {
    let fromTemporaryCredentials;
    try {
      ({ fromTemporaryCredentials } = await import('@aws-sdk/credential-providers'));
    } catch {
      throw new Error(
        `Failed to load @aws-sdk/credential-providers. Install it to use --s3-role-arn.`
      );
    }
    config.credentials = fromTemporaryCredentials({
      params: {
        RoleArn: options.roleArn,
        ...(options.externalId ? { ExternalId: options.externalId } : {}),
      },
    });
  }

  return config;
}

const S3_RETRY_OPTIONS = {
  maxAttempts: 4,
  initialDelayMs: 1_000,
  maxDelayMs: 8_000,
  retryable: isS3RetryableError,
  onRetry: (attempt: number, delay: number, error: Error) => {
    process.stderr.write(`[S3Destination] retry ${attempt} after ${delay}ms: ${error.message}\n`);
  },
} as const;

export class S3Destination implements FileDestination {
  private readonly bucketName: string;
  private readonly prefix: string;
  private readonly region: string | undefined;
  private readonly roleArn: string | undefined;
  private readonly externalId: string | undefined;
  private readonly format: OutputFormat | undefined;
  private readonly providedClient?: S3ClientLike;
  private cachedClient?: S3ClientLike;

  constructor(options: S3DestinationOptions) {
    validateBucketName(options.bucket);

    this.bucketName = options.bucket;
    this.prefix = options.prefix
      ? normalizeDestinationPath(options.prefix).replace(/\/+$/, '')
      : '';
    this.region = options.region;
    this.roleArn = options.roleArn;
    this.externalId = options.externalId;
    this.format = options.format;
    this.providedClient = options.client;
  }

  async publish(localPath: string, destPath: string, options?: PublishOptions): Promise<string> {
    const normalizedPath = normalizeDestinationPath(destPath);
    const objectKey = this.prefix ? path.posix.join(this.prefix, normalizedPath) : normalizedPath;
    assertObjectKeyLength(objectKey);
    const contentType =
      this.format && !options?.copy ? contentTypeForFormat(this.format) : undefined;
    const client = await this.getClient();

    await withRetry(async () => {
      const body = fs.createReadStream(localPath);
      try {
        const input = {
          Bucket: this.bucketName,
          Key: objectKey,
          Body: body,
          ChecksumAlgorithm: 'SHA256' as const,
          ContentType: contentType,
        };
        if (this.providedClient) {
          await client.send({ input });
        } else {
          const { PutObjectCommand } = await import('@aws-sdk/client-s3');
          await client.send(new PutObjectCommand(input));
        }
      } catch (err) {
        body.destroy();
        throw err;
      }
    }, S3_RETRY_OPTIONS);

    return `s3://${this.bucketName}/${objectKey}`;
  }

  private async getClient(): Promise<S3ClientLike> {
    if (this.providedClient) {
      return this.providedClient;
    }

    if (this.cachedClient) {
      return this.cachedClient;
    }

    assertDriverVersion('@aws-sdk/client-s3', '3.1017.0', createRequire(import.meta.url));
    try {
      const { S3Client } = await import('@aws-sdk/client-s3');
      const clientConfig = await buildS3ClientConfig({
        region: this.region,
        roleArn: this.roleArn,
        externalId: this.externalId,
      });

      this.cachedClient = new S3Client(clientConfig) as S3ClientLike;
      return this.cachedClient;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Install it to use')) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load @aws-sdk/client-s3. Install it to use --dest s3. ${message}`);
    }
  }
}
