import { describe, expect, it } from 'vitest';

import { emitLoadCountWarnings } from '../../../src/commands/pipeline-fanout.js';

function summary(streams: Record<string, { records_emitted?: number; rows_loaded?: number }>) {
  return {
    streams: new Map(
      Object.entries(streams).map(([name, stream]) => [
        name,
        { records_emitted: stream.records_emitted ?? 0, rows_loaded: stream.rows_loaded ?? 0 },
      ])
    ),
  };
}

function warnings(
  destination: { name: string; type: string },
  loaded: Parameters<typeof summary>[0]
): string[] {
  const lines: string[] = [];
  emitLoadCountWarnings(
    summary({ orders: { records_emitted: 5 } }),
    summary(loaded),
    destination,
    (line) => lines.push((JSON.parse(line) as { message: string }).message)
  );
  return lines;
}

describe('fan-out load count warnings', () => {
  it('does not warn when a file destination reports no row counts', () => {
    expect(warnings({ name: 'archive', type: 'local' }, {})).toEqual([]);
    expect(warnings({ name: 'bucket', type: 's3' }, {})).toEqual([]);
  });

  it('still warns when a database destination reports no rows', () => {
    expect(warnings({ name: 'warehouse', type: 'duckdb' }, {})).toEqual([
      'Destination "warehouse" did not report any loaded rows for stream "orders" after extracting 5 records.',
    ]);
  });

  it('still warns when a file destination reports a different row count', () => {
    expect(warnings({ name: 'archive', type: 'local' }, { orders: { rows_loaded: 4 } })).toEqual([
      'Destination "archive" loaded 4 rows for stream "orders" after extracting 5 records.',
    ]);
  });
});
