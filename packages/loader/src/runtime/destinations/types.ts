import * as path from 'node:path';

import { CommandError } from '@bobsled-inc/protocol';

import { escapeUnprintable } from '../utils.js';

export interface PublishOptions {
  /** Write a file as it is: do not label it with the output format's content type. */
  copy?: boolean;
}

export interface FileDestination {
  publish(localPath: string, destPath: string, options?: PublishOptions): Promise<string>;
}

/** S3 and GCS reject an object key over 1,024 bytes. */
export function assertObjectKeyLength(key: string): void {
  const bytes = Buffer.byteLength(key);
  if (bytes > 1024) {
    throw new CommandError(
      `Object key is ${bytes} bytes, over the 1,024 bytes S3 and GCS allow: ${escapeUnprintable(key.slice(0, 80))}...`,
      2
    );
  }
}

export function normalizeDestinationPath(destPath: string): string {
  const normalized = path.posix.normalize(destPath.replaceAll('\\', '/')).replace(/^\/+/, '');

  if (
    normalized.length === 0 ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(`Invalid destination path "${destPath}"`);
  }

  return normalized;
}
