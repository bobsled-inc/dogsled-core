import { describe, expect, it } from 'vitest';

import { buildColumnDef, mapDuckDbType } from '../../src/runtime/duckdb-primitives.js';

describe('duckdb vector type helpers', () => {
  it('maps vector columns to FLOAT[] (LIST) regardless of dimension', () => {
    // DuckDB's fixed-size ARRAY (`FLOAT[N]`) over-materializes NULL rows when
    // writing Parquet (def=0/rep=1 inside an N-slot element group), which
    // BigQuery rejects under `parquetOptions.enableListInference`. Use LIST.
    expect(mapDuckDbType({ name: 'embedding', type: 'vector', dimension: 1536 })).toBe('FLOAT[]');
    expect(mapDuckDbType('vector')).toBe('FLOAT[]');
  });

  it('builds vector column definitions as FLOAT[]', () => {
    expect(buildColumnDef({ name: 'embedding', type: 'vector', dimension: 3 })).toBe(
      '"embedding" FLOAT[]'
    );
  });
});
