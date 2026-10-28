import { CommandError, EXIT_VALIDATION } from '@bobsled-inc/protocol';

import type { SnapshotKind } from './metadata.js';

export interface SnapshotKeyInput {
  filterHash: string;
  limit?: number;
}

export interface SnapshotKey {
  filterHash: string;
  snapshotKind: SnapshotKind;
  snapshotVariant: string | null;
}

export function snapshotKey(input: SnapshotKeyInput): SnapshotKey {
  if (input.limit === undefined) {
    return {
      filterHash: input.filterHash,
      snapshotKind: 'canonical',
      snapshotVariant: null,
    };
  }

  if (!Number.isInteger(input.limit) || input.limit <= 0) {
    throw new CommandError(
      `snapshotKey: limit must be a positive integer, got ${input.limit}`,
      EXIT_VALIDATION
    );
  }

  return {
    filterHash: input.filterHash,
    snapshotKind: 'limited',
    snapshotVariant: `limit=${input.limit}`,
  };
}
