import type { Receipt } from './receipt.js';

export function formatReceipt(receipt: Receipt): string {
  const parts = [
    `source=${receipt.source}`,
    `target=${receipt.target}`,
    `table=${receipt.table}`,
    `filter_hash=${receipt.filterHash}`,
    `snapshot_age=${receipt.snapshotAgeSeconds}s`,
    `records=${receipt.records}`,
    `action=${receipt.action}`,
    `duration_ms=${receipt.durationMs}`,
  ];
  if (receipt.refreshReason !== undefined) parts.push(`refresh_reason=${receipt.refreshReason}`);
  if (receipt.rateBudgetRemaining !== undefined) {
    parts.push(`rate_budget_remaining=${receipt.rateBudgetRemaining}`);
  }
  if (receipt.rateBudgetLimit !== undefined) {
    parts.push(`rate_budget_limit=${receipt.rateBudgetLimit}`);
  }
  if (receipt.etagHit !== undefined) parts.push(`etag_hit=${receipt.etagHit}`);
  if (receipt.cursorValue !== undefined) parts.push(`cursor_value=${receipt.cursorValue}`);
  if (receipt.deltaRowCount !== undefined) parts.push(`delta_rows=${receipt.deltaRowCount}`);
  if (receipt.totalRowCount !== undefined) parts.push(`total_rows=${receipt.totalRowCount}`);
  if (receipt.snapshotKind !== undefined) parts.push(`snapshot_kind=${receipt.snapshotKind}`);
  if (receipt.snapshotVariant !== undefined) {
    parts.push(`snapshot_variant=${receipt.snapshotVariant ?? 'canonical'}`);
  }
  return parts.join(' ');
}
