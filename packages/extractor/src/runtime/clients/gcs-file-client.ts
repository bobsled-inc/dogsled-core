import { assertDeclaredEnvironmentReferences } from '@bobsled-inc/protocol';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';

import type {
  DownloadedFile,
  FileStorageClient,
  ListedFile,
  ListFilesOptions,
} from '../../framework/core/index.js';
import { ExtractorConfigError } from '../errors.js';

async function importModule(specifier: string): Promise<Record<string, unknown>> {
  // The caller supplies only the literal optional dependency name below.
  // Function-based import keeps that dependency optional during bundling; never
  // pass a specifier derived from project config, environment, or record data.
  return (await new Function('s', 'return import(s)')(specifier)) as Record<string, unknown>;
}

function readRequiredEnv(name: string | undefined, field: string): string {
  if (!name) {
    throw new ExtractorConfigError(`GCS auth ${field} is required`);
  }
  const value = process.env[name];
  if (!value) {
    throw new ExtractorConfigError(`GCS auth ${field} references missing env var ${name}`);
  }
  return value;
}

type GcsFile = {
  name: string;
  metadata?: { updated?: string; generation?: string; etag?: string; size?: string | number };
  download(options: { destination: string }): Promise<unknown>;
};

function toIsoString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export class GcsFileStorageClient implements FileStorageClient {
  private readonly bucketName: string;
  private readonly bucket: {
    getFiles(
      options: Record<string, unknown>
    ): Promise<[GcsFile[], { pageToken?: string }?, unknown?]>;
    file(name: string, options?: Record<string, unknown>): GcsFile;
  };

  constructor(connection: { bucket: string }, bucket: GcsFileStorageClient['bucket']) {
    this.bucketName = connection.bucket;
    this.bucket = bucket;
  }

  static async create(
    connection: { bucket: string; project_id?: string },
    auth: { type: string; credentials_json_env?: string; credentials_path_env?: string },
    injected?: { bucket?: GcsFileStorageClient['bucket'] },
    authEnvVars: readonly string[] = []
  ): Promise<GcsFileStorageClient> {
    assertDeclaredEnvironmentReferences(auth, authEnvVars);
    if (injected?.bucket) {
      return new GcsFileStorageClient(connection, injected.bucket);
    }
    const mod = await importModule('@google-cloud/storage');
    const Storage = mod['Storage'] as new (options: Record<string, unknown>) => {
      bucket(name: string): GcsFileStorageClient['bucket'];
    };
    const options: Record<string, unknown> = {};
    if (connection.project_id) {
      options['projectId'] = connection.project_id;
    }
    if (auth.type === 'service_account_json') {
      const rawCredentials = readRequiredEnv(auth.credentials_json_env, 'credentials_json_env');
      try {
        options['credentials'] = JSON.parse(rawCredentials) as Record<string, unknown>;
      } catch (error) {
        throw new ExtractorConfigError(
          `GCS auth credentials_json_env references malformed JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
          error instanceof Error ? error : undefined
        );
      }
    }
    if (auth.type === 'service_account_path') {
      options['keyFilename'] = readRequiredEnv(auth.credentials_path_env, 'credentials_path_env');
    }
    const storage = new Storage(options);
    return new GcsFileStorageClient(connection, storage.bucket(connection.bucket));
  }

  async *list(options: ListFilesOptions): AsyncGenerator<ListedFile> {
    let pageToken: string | undefined;
    let emitted = 0;
    const prefix = options.path.replace(/[*?].*$/, '');
    do {
      const [files, nextQuery] = await this.bucket.getFiles({
        prefix,
        matchGlob: options.path,
        pageToken,
        autoPaginate: false,
      });
      for (const file of files) {
        if (options.maxFiles && emitted >= options.maxFiles) {
          return;
        }
        const size = file.metadata?.size === undefined ? undefined : Number(file.metadata.size);
        yield {
          path: file.name,
          uri: `gs://${this.bucketName}/${file.name}`,
          last_modified: toIsoString(file.metadata?.updated),
          etag: file.metadata?.etag,
          generation: file.metadata?.generation,
          size: Number.isFinite(size) ? size : undefined,
        };
        emitted += 1;
      }
      pageToken = nextQuery?.pageToken;
    } while (pageToken);
  }

  async download(file: ListedFile, targetPath: string): Promise<DownloadedFile> {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await this.bucket
      .file(file.path, file.generation ? { generation: file.generation } : undefined)
      .download({
        destination: targetPath,
      });
    return { file, path: targetPath, bytes_downloaded: file.size ?? 0 };
  }

  async close(): Promise<void> {
    await Promise.resolve();
  }
}
