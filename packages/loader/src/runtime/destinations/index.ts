import { GcsDestination } from './gcs.js';
import { LocalDestination } from './local.js';
import { S3Destination } from './s3.js';

import type { OutputFormat } from '../formats.js';
import type { FileDestination } from './types.js';

export type DestinationKind = 'local' | 'gcs' | 's3';

export interface DestinationConfig {
  dest: DestinationKind;
  format?: OutputFormat;
  outputDir: string;
  gcsBucket?: string;
  gcsPrefix?: string;
  s3Bucket?: string;
  s3Prefix?: string;
  s3Region?: string;
  s3RoleArn?: string;
  s3ExternalId?: string;
}

export function createDestination(config: DestinationConfig): FileDestination {
  switch (config.dest) {
    case 'local':
      return new LocalDestination({ outputDir: config.outputDir });
    case 'gcs':
      if (!config.gcsBucket) {
        throw new Error('--gcs-bucket is required when --dest gcs');
      }
      return new GcsDestination({
        bucket: config.gcsBucket,
        prefix: config.gcsPrefix,
        format: config.format,
      });
    case 's3':
      if (!config.s3Bucket) {
        throw new Error('--s3-bucket is required when --dest s3');
      }
      return new S3Destination({
        bucket: config.s3Bucket,
        prefix: config.s3Prefix,
        region: config.s3Region,
        roleArn: config.s3RoleArn,
        externalId: config.s3ExternalId,
        format: config.format,
      });
    default: {
      const exhaustiveCheck: never = config.dest;
      throw new Error(`Unsupported destination: ${exhaustiveCheck}`);
    }
  }
}

export { LocalDestination } from './local.js';
export { GcsDestination } from './gcs.js';
export { S3Destination } from './s3.js';
export type { FileDestination } from './types.js';
