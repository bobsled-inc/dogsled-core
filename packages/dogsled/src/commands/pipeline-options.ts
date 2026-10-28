import { InvalidArgumentError } from 'commander';
import { BATCH_FORMATS, type BatchFormat, isBatchFormat } from '@bobsled-inc/protocol';

export function parseBatchFormat(value: string): BatchFormat {
  if (!isBatchFormat(value)) {
    throw new InvalidArgumentError(
      `Invalid --batch-format "${value}". Expected one of: ${BATCH_FORMATS.join(', ')}.`
    );
  }
  return value;
}
