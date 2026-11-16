import { isLeasePlaceholderMetadataRow, type MetadataRow } from './metadata.js';

export type FreshnessVerdict =
  | { verdict: 'fresh'; ageSec: number; recordCount: number; etag?: string }
  | { verdict: 'missing' }
  | { verdict: 'slice_changed'; priorFilterHash: string }
  | { verdict: 'aged_out'; ageSec: number; recordCount: number; etag?: string }
  | { verdict: 'refresh_due'; ageSec: number; recordCount: number; etag?: string }
  | {
      verdict: 'incremental_eligible';
      ageSec: number;
      recordCount: number;
      cursorField: string;
      cursorValue: string;
    };

export interface ProbeFreshnessArgs {
  readRow: (args: {
    schema: string;
    sourceName: string;
    filterHash: string;
  }) => Promise<MetadataRow | undefined>;
  schema: string;
  sourceName: string;
  currentFilterHash: string;
  maxAgeSec: number | undefined;
  nowIso: string;
  incrementalEnabled?: boolean;
  persistentMode?: boolean;
}

export async function probeFreshness(args: ProbeFreshnessArgs): Promise<FreshnessVerdict> {
  const row = await args.readRow({
    schema: args.schema,
    sourceName: args.sourceName,
    filterHash: args.currentFilterHash,
  });
  if (!row) return { verdict: 'missing' };
  if (isLeasePlaceholderMetadataRow(row)) return { verdict: 'missing' };
  if (row.filter_hash !== args.currentFilterHash) {
    return { verdict: 'slice_changed', priorFilterHash: row.filter_hash };
  }

  const ageSec = Math.floor((Date.parse(args.nowIso) - Date.parse(row.loaded_at)) / 1000);
  if (args.maxAgeSec === undefined) {
    return {
      verdict: 'fresh',
      ageSec,
      recordCount: row.record_count,
      ...(row.etag !== undefined ? { etag: row.etag } : {}),
    };
  }
  if (args.maxAgeSec === 0 || ageSec >= args.maxAgeSec) {
    if (args.incrementalEnabled && row.cursor_field && row.cursor_value) {
      return {
        verdict: 'incremental_eligible',
        ageSec,
        recordCount: row.record_count,
        cursorField: row.cursor_field,
        cursorValue: row.cursor_value,
      };
    }
    if (args.persistentMode) {
      return {
        verdict: 'refresh_due',
        ageSec,
        recordCount: row.record_count,
        ...(row.etag !== undefined ? { etag: row.etag } : {}),
      };
    }
    return {
      verdict: 'aged_out',
      ageSec,
      recordCount: row.record_count,
      ...(row.etag !== undefined ? { etag: row.etag } : {}),
    };
  }
  return {
    verdict: 'fresh',
    ageSec,
    recordCount: row.record_count,
    ...(row.etag !== undefined ? { etag: row.etag } : {}),
  };
}
