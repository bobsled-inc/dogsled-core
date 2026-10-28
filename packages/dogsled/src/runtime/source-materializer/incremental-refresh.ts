import {
  compareCursors,
  maxCursor,
  type QueryFilterInput,
  type QueryResourceResult,
} from '@bobsled-inc/extractor';

import type { CursorType } from './metadata.js';

type IncrementalQueryableResource = {
  output?: Record<string, { type?: string } | undefined>;
};

export type IncrementalFallbackReason =
  | 'null_cursor'
  | 'cursor_regression'
  | 'schema_drift'
  | 'missing_keys';

export interface IncrementalRefreshArgs {
  strategy?: 'merge' | 'append';
  integration: unknown;
  resource: IncrementalQueryableResource;
  priorCursorValue: string;
  cursorField: string;
  cursorType: CursorType;
  keyProperties: string[];
  queryResourceImpl: (opts: {
    integration: unknown;
    resource: unknown;
    filter?: QueryFilterInput;
  }) => Promise<QueryResourceResult<Record<string, unknown>>>;
  mergeImpl: (records: Record<string, unknown>[]) => Promise<void>;
  appendImpl?: (records: Record<string, unknown>[]) => Promise<void>;
}

export interface IncrementalRefreshResult {
  outcome: 'merged' | 'appended' | 'zero_delta' | 'fallback';
  fallbackReason?: IncrementalFallbackReason;
  newCursorValue?: string;
  deltaRowCount: number;
}

function hasField(resource: IncrementalQueryableResource, field: string): boolean {
  return resource.output !== undefined && Object.hasOwn(resource.output, field);
}

export async function runIncrementalRefresh(
  args: IncrementalRefreshArgs
): Promise<IncrementalRefreshResult> {
  const strategy = args.strategy ?? 'merge';
  if (!hasField(args.resource, args.cursorField)) {
    return { outcome: 'fallback', fallbackReason: 'schema_drift', deltaRowCount: 0 };
  }

  if (strategy === 'merge') {
    const effectiveKeyProperties =
      args.keyProperties.length > 0
        ? args.keyProperties
        : hasField(args.resource, 'id')
          ? ['id']
          : [];
    if (effectiveKeyProperties.length === 0) {
      return { outcome: 'fallback', fallbackReason: 'missing_keys', deltaRowCount: 0 };
    }
  }

  const result = await args.queryResourceImpl({
    integration: args.integration,
    resource: args.resource,
    filter: {
      [args.cursorField]: {
        $gte: args.priorCursorValue,
      },
    },
  });

  if (result.records.length === 0) {
    return {
      outcome: 'zero_delta',
      newCursorValue: args.priorCursorValue,
      deltaRowCount: 0,
    };
  }

  let maxSeen = args.priorCursorValue;
  const appendRecords: Record<string, unknown>[] = [];
  for (const row of result.records) {
    const raw = row[args.cursorField];
    if (raw === null || raw === undefined) {
      return { outcome: 'fallback', fallbackReason: 'null_cursor', deltaRowCount: 0 };
    }
    const value = String(raw);
    const cursorComparison = compareCursors(value, args.priorCursorValue, args.cursorType);
    if (cursorComparison < 0) {
      return { outcome: 'fallback', fallbackReason: 'cursor_regression', deltaRowCount: 0 };
    }
    if (strategy === 'append' && cursorComparison > 0) {
      appendRecords.push(row);
    }
    maxSeen = maxCursor(maxSeen, value, args.cursorType);
  }

  if (strategy === 'append') {
    if (appendRecords.length === 0) {
      return {
        outcome: 'zero_delta',
        newCursorValue: args.priorCursorValue,
        deltaRowCount: 0,
      };
    }
    await (args.appendImpl ?? args.mergeImpl)(appendRecords);
    return {
      outcome: 'appended',
      newCursorValue: maxSeen,
      deltaRowCount: appendRecords.length,
    };
  }

  await args.mergeImpl(result.records);
  return {
    outcome: 'merged',
    newCursorValue: maxSeen,
    deltaRowCount: result.records.length,
  };
}
