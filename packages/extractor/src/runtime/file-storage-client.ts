import type { FileStorageClient } from '../framework/core/index.js';
import type { IntegrationSpec } from '../types/index.js';
import { GcsFileStorageClient } from './clients/gcs-file-client.js';
import { LocalFileStorageClient } from './clients/local-file-client.js';
import { S3FileStorageClient } from './clients/s3-file-client.js';
import { SftpFileStorageClient } from './clients/sftp-file-client.js';
import { VercelBlobFileStorageClient } from './clients/vercel-blob-file-client.js';
import { ExtractorConfigError } from './errors.js';

export async function createFileStorageClient(
  integration: IntegrationSpec
): Promise<FileStorageClient> {
  if (!('source_type' in integration)) {
    throw new ExtractorConfigError('File storage integration must declare source_type');
  }

  switch (integration.source_type) {
    case 'local':
      return new LocalFileStorageClient(integration.connection);
    case 's3':
      return S3FileStorageClient.create(
        integration.connection,
        integration.auth,
        undefined,
        integration.auth_env_vars
      );
    case 'gcs':
      return GcsFileStorageClient.create(
        integration.connection,
        integration.auth,
        undefined,
        integration.auth_env_vars
      );
    case 'sftp':
      return SftpFileStorageClient.create(
        integration.connection,
        integration.auth,
        undefined,
        integration.auth_env_vars
      );
    case 'vercel_blob':
      return VercelBlobFileStorageClient.create(
        integration.connection,
        integration.auth,
        integration.auth_env_vars
      );
    default:
      throw new ExtractorConfigError(
        `Unsupported file storage source_type: ${String(integration.source_type)}`
      );
  }
}
