import { CommandError } from '@bobsled-inc/protocol';

import { LEGACY_OWNERSHIP_LABELS } from '../legacy-names.js';

export const OWNERSHIP_LABEL = 'dogsled_temp_dataset';

/** The label Core writes, then earlier labels it still accepts as proof of ownership. */
export const OWNERSHIP_LABELS: readonly string[] = [
  OWNERSHIP_LABEL,
  ...LEGACY_OWNERSHIP_LABELS.filter((label) => label !== OWNERSHIP_LABEL),
];

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
  if (!OWNERSHIP_LABELS.some((label) => metadata.labels?.[label] === marker)) {
    throw new CommandError('BigQuery table ownership marker does not match.', 2);
  }
  if (metadata.type !== 'TABLE' || metadata.externalDataConfiguration !== undefined) {
    throw new CommandError('Reserved BigQuery table must be a managed base table.', 2);
  }
}
