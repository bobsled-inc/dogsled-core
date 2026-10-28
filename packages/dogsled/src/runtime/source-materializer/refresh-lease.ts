import { CommandError } from '@bobsled-inc/protocol';

import type { MetadataRow, SnapshotKind } from './metadata.js';
import type { MetadataLeaseResult } from './metadata-store.js';
import type { Receipt } from './receipt.js';

const REFRESH_LEASE_POLL_MS = 250;
const REFRESH_LEASE_POLL_JITTER_MS = 75;

export interface RefreshLeaseCallbacks {
  beginRefresh?: (args: {
    schema: string;
    sourceName: string;
    filterHash: string;
    snapshotKind?: SnapshotKind;
    snapshotVariant?: string | null;
  }) => Promise<MetadataLeaseResult>;
  finishRefresh?: (args: {
    schema: string;
    sourceName: string;
    filterHash: string;
    snapshotKind?: SnapshotKind;
    snapshotVariant?: string | null;
    inProgressUntil?: string;
  }) => Promise<void>;
}

export interface RefreshLeaseContext extends RefreshLeaseCallbacks {
  target: Receipt['target'];
  schema: string;
  currentFilterHash: string;
  nowIso: string;
  snapshotKind?: SnapshotKind;
  snapshotVariant?: string | null;
  readRow: (args: {
    schema: string;
    sourceName: string;
    filterHash: string;
    snapshotKind?: SnapshotKind;
    snapshotVariant?: string | null;
  }) => Promise<MetadataRow | undefined>;
}

function leaseIsActive(row: MetadataRow | undefined, nowMs: number): boolean {
  if (!row?.in_progress_until) return false;
  const leaseMs = Date.parse(row.in_progress_until);
  return !Number.isNaN(leaseMs) && leaseMs > nowMs;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExternalRefresh(args: {
  context: RefreshLeaseContext;
  sourceName: string;
  leaseUntil: string | undefined;
  retry: () => Promise<Receipt>;
}): Promise<Receipt> {
  const snapshotKind = args.context.snapshotKind ?? 'canonical';
  const snapshotVariant = args.context.snapshotVariant ?? null;
  const leaseUntilMs =
    args.leaseUntil === undefined ? Date.now() + 60_000 : Date.parse(args.leaseUntil);
  const deadline = (Number.isNaN(leaseUntilMs) ? Date.now() + 60_000 : leaseUntilMs) + 2_000;
  while (Date.now() < deadline) {
    await delay(REFRESH_LEASE_POLL_MS + Math.floor(Math.random() * REFRESH_LEASE_POLL_JITTER_MS));
    const row = await args.context.readRow({
      schema: args.context.schema,
      sourceName: args.sourceName,
      filterHash: args.context.currentFilterHash,
      snapshotKind,
      snapshotVariant,
    });
    if (!leaseIsActive(row, Date.now())) return args.retry();
  }
  throw new CommandError(
    `Timed out waiting for another process to finish materializing source "${args.sourceName}".`,
    1
  );
}

export async function withRefreshLease(args: {
  context: RefreshLeaseContext;
  sourceName: string;
  operation: () => Promise<Receipt>;
  retry: () => Promise<Receipt>;
}): Promise<Receipt> {
  const snapshotKind = args.context.snapshotKind ?? 'canonical';
  const snapshotVariant = args.context.snapshotVariant ?? null;

  if (
    !args.context.beginRefresh ||
    !args.context.finishRefresh ||
    args.context.target === 'in_memory'
  ) {
    return args.operation();
  }

  const lease = await args.context.beginRefresh({
    schema: args.context.schema,
    sourceName: args.sourceName,
    filterHash: args.context.currentFilterHash,
    snapshotKind,
    snapshotVariant,
  });
  if (!lease.acquired) {
    return waitForExternalRefresh({
      context: args.context,
      sourceName: args.sourceName,
      leaseUntil: lease.inProgressUntil,
      retry: args.retry,
    });
  }

  try {
    return await args.operation();
  } finally {
    // Release the lease in all cases. On success, the materializer's upsertRow
    // already wrote the real metadata row (clearing in_progress_until), so this
    // is a safe no-op. On failure, this cleans up the lease placeholder.
    await args.context
      .finishRefresh({
        schema: args.context.schema,
        sourceName: args.sourceName,
        filterHash: args.context.currentFilterHash,
        snapshotKind,
        snapshotVariant,
        inProgressUntil: lease.inProgressUntil,
      })
      .catch(() => {});
  }
}
