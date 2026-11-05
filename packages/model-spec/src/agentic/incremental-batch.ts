import type { JsonValue } from '@bobsled-inc/protocol';
import { normalizeCursor } from './cursor.js';
import { boundedAgenticRows, isBoundedAgenticJson } from './rows.js';
import { AgenticStateError } from './state-errors.js';

/**
 * Take the next incremental batch from rows a host returned in cursor order.
 *
 * The host may return more rows than fit. The batch is the longest prefix within the row
 * and byte limits. When rows are left over, trailing rows that share the first excluded
 * row's cursor value are dropped too: the next run reads `cursor > last`, so splitting a
 * group of equal values would skip part of it for good.
 */
export function takeIncrementalBatch(
  raw: unknown,
  options: {
    label: string;
    cursorField: string;
    cursorType: string;
    maxRows: number;
    maxBytes: number;
  }
): { rows: JsonValue[]; more: boolean } {
  const { label, cursorField, cursorType, maxRows, maxBytes } = options;
  if (!Array.isArray(raw)) {
    return {
      rows: boundedAgenticRows(raw, label, { maxRows, maxBatchBytes: maxBytes }),
      more: false,
    };
  }
  const cursor = (row: unknown, index: number) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new AgenticStateError('limit', {
        reason: 'invalid_rows',
        message: `${label} row ${index + 1} is not an object.`,
      });
    }
    return normalizeCursor((row as Record<string, unknown>)[cursorField], cursorType);
  };
  let bytes = 2;
  let fit = 0;
  let previous: string | number | undefined;
  for (const [index, row] of raw.entries()) {
    const value = cursor(row, index);
    if (previous !== undefined && value < previous) {
      throw new AgenticStateError('limit', {
        reason: 'unordered_incremental_input',
        message: `${label} returned incremental rows out of ${cursorField} order, so a partial batch could skip rows.`,
        hint: 'The agentic host must return incremental rows ordered by the cursor field.',
      });
    }
    previous = value;
    const size = isBoundedAgenticJson(row) ? Buffer.byteLength(JSON.stringify(row)) + 1 : Infinity;
    if (fit === index && fit < maxRows && bytes + size <= maxBytes) {
      bytes += size;
      fit = index + 1;
    }
  }
  if (fit === raw.length) return { rows: raw as JsonValue[], more: false };
  if (fit === 0) {
    // Even the first row does not fit; report it with the regular per-row limits.
    boundedAgenticRows([raw[0]], label);
    throw new AgenticStateError('limit', {
      reason: 'batch_too_large',
      message: `${label} row 1 is larger than the ${Math.round((maxBytes / 1048576) * 100) / 100} MiB batch limit.`,
    });
  }
  const boundary = cursor(raw[fit], fit);
  let end = fit;
  while (end > 0 && cursor(raw[end - 1], end - 1) === boundary) end--;
  if (end === 0) {
    throw new AgenticStateError('limit', {
      reason: 'cursor_tie_too_large',
      message: `${label} has more rows with one ${cursorField} value than fit in one batch, so they cannot be split safely.`,
      hint: 'Use a cursor_field with more distinct values, such as a higher-precision timestamp or an increasing ID.',
    });
  }
  return { rows: raw.slice(0, end) as JsonValue[], more: true };
}
