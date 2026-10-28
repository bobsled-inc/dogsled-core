import type { SnapshotKind } from './metadata.js';

export type ReceiptAction = 'materialized' | 'reused' | 'live' | 'coalesced';

export type RefreshReason =
  | 'first_load'
  | 'filter_changed'
  | 'max_age'
  | 'refresh_due'
  | 'table_missing'
  | 'explicit_refresh'
  | 'live'
  | 'incremental_merge'
  | 'incremental_append'
  | 'incremental_fallback_cursor_regression'
  | 'incremental_fallback_schema_drift'
  | 'incremental_fallback_missing_keys'
  | 'incremental_fallback_null_cursor'
  | 'partial_reuse'
  | 'partial_rebuild';

export interface Receipt {
  source: string;
  target: 'bigquery' | 'snowflake' | 'duckdb' | 'ducklake' | 'in_memory';
  table: string;
  filterHash: string;
  snapshotAgeSeconds: number;
  records: number;
  action: ReceiptAction;
  durationMs: number;
  refreshReason?: RefreshReason;
  rateBudgetRemaining?: number;
  rateBudgetLimit?: number;
  etagHit?: boolean;
  cursorValue?: string;
  deltaRowCount?: number;
  totalRowCount?: number;
  snapshotKind?: SnapshotKind;
  snapshotVariant?: string | null;
}

type ReceiptInput = Omit<Receipt, 'action'>;

export function materializedReceipt(input: ReceiptInput): Receipt {
  return { ...input, action: 'materialized' };
}

export function reusedReceipt(input: ReceiptInput): Receipt {
  return { ...input, action: 'reused' };
}

export function liveReceipt(input: ReceiptInput): Receipt {
  return { ...input, action: 'live', refreshReason: 'live' };
}

export function coalescedReceipt(receipt: Receipt, durationMs: number): Receipt {
  return { ...receipt, action: 'coalesced', durationMs };
}
