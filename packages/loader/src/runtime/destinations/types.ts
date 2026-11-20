import * as path from 'node:path';

import {
  CommandError,
  encodeMetadataValue,
  OBJECT_METADATA_MAX_BYTES,
  objectMetadataBytes,
} from '@bobsled-inc/protocol';

import { escapeUnprintable } from '../utils.js';

export interface PublishOptions {
  /** Write a file as it is: do not label it with the output format's content type. */
  copy?: boolean;
  /**
   * Metadata to store on the object, as plain text. S3 and GCS write it for a copy, each value
   * percent-encoded; other destinations ignore it.
   */
  metadata?: Readonly<Record<string, string>>;
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

/**
 * The metadata a copy writes to an object, with each value percent-encoded so that it is US-ASCII.
 * S3 takes at most 2,048 bytes of it, and a copy holds GCS to the same limit.
 */
export function encodeObjectMetadata(
  metadata: Readonly<Record<string, string>> | undefined
): Record<string, string> | undefined {
  if (!metadata || Object.keys(metadata).length === 0) return undefined;
  const bytes = objectMetadataBytes(metadata);
  if (bytes > OBJECT_METADATA_MAX_BYTES) {
    throw new CommandError(
      `Object metadata is ${bytes} bytes, over the ${OBJECT_METADATA_MAX_BYTES} bytes S3 allows. ` +
        `It holds ${Object.keys(metadata).join(', ')}. Shorten the object_metadata values.`,
      2
    );
  }
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key, encodeMetadataValue(value)])
  );
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
