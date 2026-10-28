import { CommandError } from '@bobsled-inc/protocol';

export const OWNERSHIP_LABEL = 'dogsled_temp_dataset';

export function validateOwnershipMarker(marker: string): void {
  if (!/^[a-z0-9_-]{1,63}$/.test(marker)) {
    throw new CommandError('BigQuery table ownership marker must be a valid label value.', 2);
  }
}

export function assertOwnedBigQueryMetadata(
  metadata: {
    labels?: Record<string, string>;
    type?: string;
    externalDataConfiguration?: unknown;
  },
  marker: string
): void {
  if (metadata.labels?.[OWNERSHIP_LABEL] !== marker) {
    throw new CommandError('BigQuery table ownership marker does not match.', 2);
  }
  if (metadata.type !== 'TABLE' || metadata.externalDataConfiguration !== undefined) {
    throw new CommandError('Reserved BigQuery table must be a managed base table.', 2);
  }
}
