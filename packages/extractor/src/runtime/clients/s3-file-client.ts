import { assertDeclaredEnvironmentReferences } from '@bobsled-inc/protocol';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';

import type {
  DownloadedFile,
  FileStorageClient,
  ListedFile,
  ListFilesOptions,
} from '../../framework/core/index.js';
import {
  isNonPublicHost,
  resolveAndValidateHost as validateRemoteHost,
} from '../../framework/core/index.js';
import { ExtractorConfigError, ExtractorDataError } from '../errors.js';
import { globToRegExp } from './path-glob.js';

async function importModule(specifier: string): Promise<Record<string, unknown>> {
  // The caller supplies only the literal optional dependency name below.
  // Function-based import keeps that dependency optional during bundling; never
  // pass a specifier derived from project config, environment, or record data.
  return (await new Function('s', 'return import(s)')(specifier)) as Record<string, unknown>;
}

function readRequiredEnv(name: string | undefined, field: string): string {
  if (!name) {
    throw new ExtractorConfigError(`S3 auth ${field} is required`);
  }
  const value = process.env[name];
  if (!value) {
    throw new ExtractorConfigError(`S3 auth ${field} references missing env var ${name}`);
  }
  return value;
}

async function validateS3Endpoint(endpoint: string | undefined): Promise<void> {
  if (!endpoint) return;

  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch (error) {
    throw new ExtractorConfigError(
      `Invalid S3 endpoint URL: ${endpoint}`,
      error instanceof Error ? error : undefined
    );
  }
  if (endpointUrl.protocol !== 'http:' && endpointUrl.protocol !== 'https:') {
    throw new ExtractorConfigError(`S3 endpoint must use HTTP or HTTPS: ${endpoint}`);
  }
  if (
    endpointUrl.protocol === 'http:' &&
    (process.env['DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS'] !== '1' ||
      !isNonPublicHost(endpointUrl.hostname))
  ) {
    throw new ExtractorConfigError(
      'S3 endpoints must use HTTPS. Cleartext HTTP is allowed only for an explicit private IP or localhost when DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS=1.'
    );
  }
  await validateRemoteHost(endpointUrl.hostname, 'S3 endpoint');
}

export class S3FileStorageClient implements FileStorageClient {
  private readonly bucket: string;
  private readonly client: { send(command: unknown): Promise<unknown>; destroy?: () => void };
  private readonly constructors: {
    ListObjectsV2Command: new (input: unknown) => unknown;
    GetObjectCommand: new (input: unknown) => unknown;
  };

  constructor(
    connection: { bucket: string; region: string; endpoint?: string; force_path_style?: boolean },
    auth: {
      type: string;
      access_key_id_env?: string;
      secret_access_key_env?: string;
      session_token_env?: string;
    },
    injected?: {
      client?: { send(command: unknown): Promise<unknown>; destroy?: () => void };
      ListObjectsV2Command?: new (input: unknown) => unknown;
      GetObjectCommand?: new (input: unknown) => unknown;
    }
  ) {
    this.bucket = connection.bucket;
    if (injected?.client && injected.ListObjectsV2Command && injected.GetObjectCommand) {
      this.client = injected.client;
      this.constructors = {
        ListObjectsV2Command: injected.ListObjectsV2Command,
        GetObjectCommand: injected.GetObjectCommand,
      };
      return;
    }
    throw new Error(
      'S3FileStorageClient.create() must be used unless SDK constructors are injected'
    );
  }

  static async create(
    connection: { bucket: string; region: string; endpoint?: string; force_path_style?: boolean },
    auth: {
      type: string;
      access_key_id_env?: string;
      secret_access_key_env?: string;
      session_token_env?: string;
    },
    injected?: ConstructorParameters<typeof S3FileStorageClient>[2],
    authEnvVars: readonly string[] = []
  ): Promise<S3FileStorageClient> {
    assertDeclaredEnvironmentReferences(auth, authEnvVars);
    if (connection.endpoint && auth.type !== 'static_env') {
      throw new ExtractorConfigError(
        'Custom S3 endpoints require static_env credentials with every name declared in auth_env_vars.'
      );
    }
    await validateS3Endpoint(connection.endpoint);
    if (injected?.client && injected.ListObjectsV2Command && injected.GetObjectCommand) {
      return new S3FileStorageClient(connection, auth, injected);
    }
    const sdk = await importModule('@aws-sdk/client-s3');
    const S3Client = sdk['S3Client'] as new (input: unknown) => {
      send(command: unknown): Promise<unknown>;
      destroy?: () => void;
    };
    const ListObjectsV2Command = sdk['ListObjectsV2Command'] as new (input: unknown) => unknown;
    const GetObjectCommand = sdk['GetObjectCommand'] as new (input: unknown) => unknown;
    const credentials =
      auth.type === 'static_env'
        ? {
            accessKeyId: readRequiredEnv(auth.access_key_id_env, 'access_key_id_env'),
            secretAccessKey: readRequiredEnv(auth.secret_access_key_env, 'secret_access_key_env'),
            sessionToken: auth.session_token_env
              ? readRequiredEnv(auth.session_token_env, 'session_token_env')
              : undefined,
          }
        : undefined;
    const client = new S3Client({
      region: connection.region,
      endpoint: connection.endpoint,
      forcePathStyle: connection.force_path_style,
      credentials,
    });
    return new S3FileStorageClient(connection, auth, {
      client,
      ListObjectsV2Command,
      GetObjectCommand,
    });
  }

  async *list(options: ListFilesOptions): AsyncGenerator<ListedFile> {
    let continuationToken: string | undefined;
    let emitted = 0;
    const prefix = options.path.replace(/[*?].*$/, '');
    const matcher = globToRegExp(options.path, 'S3');
    do {
      const response = (await this.client.send(
        new this.constructors.ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      )) as {
        Contents?: Array<{ Key?: string; LastModified?: Date; ETag?: string; Size?: number }>;
        NextContinuationToken?: string;
      };
      for (const object of response.Contents ?? []) {
        if (options.maxFiles && emitted >= options.maxFiles) {
          return;
        }
        if (!object.Key) {
          continue;
        }
        if (!matcher.test(object.Key)) {
          continue;
        }
        yield {
          path: object.Key,
          uri: `s3://${this.bucket}/${object.Key}`,
          last_modified: object.LastModified?.toISOString(),
          etag: object.ETag?.replace(/^"|"$/g, '').toLowerCase(),
          size: object.Size,
        };
        emitted += 1;
      }
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);
  }

  async download(file: ListedFile, targetPath: string): Promise<DownloadedFile> {
    await mkdir(path.dirname(targetPath), { recursive: true });
    const response = (await this.client.send(
      new this.constructors.GetObjectCommand({ Bucket: this.bucket, Key: file.path })
    )) as { Body?: NodeJS.ReadableStream; ContentLength?: number };
    if (!response.Body) {
      throw new ExtractorDataError(`S3 object ${file.uri} returned no body`);
    }
    await pipeline(response.Body, createWriteStream(targetPath));
    return { file, path: targetPath, bytes_downloaded: response.ContentLength ?? file.size ?? 0 };
  }

  async close(): Promise<void> {
    this.client.destroy?.();
  }
}
