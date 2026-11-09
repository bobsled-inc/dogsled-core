/**
 * Narrow public entry for the SFTP client, so a host does not load the whole extractor.
 */

export { DogsledRuntimeError } from '@bobsled-inc/protocol';

export type {
  DownloadedFile,
  DownloadFileOptions,
  DownloadProgress,
  ExpectedRemoteFile,
  ListedFile,
  ListFilesOptions,
  SftpFileStorageAuth,
  SftpFileStorageConnection,
  SftpHostKeyPin,
} from '../framework/core/index.js';
export { SFTP_ERROR_CODES } from './clients/sftp-errors.js';
export type { SftpErrorCode } from './clients/sftp-errors.js';
export { SftpFileStorageClient } from './clients/sftp-file-client.js';
export { ExtractorConfigError, ExtractorDataError } from './errors.js';
