import { describe, expect, it } from 'vitest';

import { semanticSimilarityExpr } from '../../../../src/compiler/core/dialect-semantic.js';

describe('semanticSimilarityExpr', () => {
  it('emits DuckDB array cosine similarity', () => {
    expect(
      semanticSimilarityExpr({
        leftVector: 'left_cache.embedding',
        rightVector: 'right_cache.embedding',
        dialect: 'duckdb',
      })
    ).toBe('array_cosine_similarity(left_cache.embedding, right_cache.embedding)');
  });

  it('emits warehouse-native cosine similarity for non-DuckDB dialects', () => {
    expect(
      semanticSimilarityExpr({
        leftVector: 'left_embedding',
        rightVector: 'right_embedding',
        dialect: 'snowflake',
      })
    ).toContain('FLATTEN');
  });
});
