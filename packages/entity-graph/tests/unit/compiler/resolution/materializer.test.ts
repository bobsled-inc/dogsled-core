import { describe, expect, it } from 'vitest';

import { generateMaterializeDdl } from '../../../../src/compiler/identity/materializer.js';

describe('generateMaterializeDdl', () => {
  it('uses variable-length DuckDB arrays for semantic embeddings', () => {
    const statements = generateMaterializeDdl('company', 'duckdb', 'main');
    const embeddingCache = statements.find((statement) => statement.name === 'ddl_embedding_cache');

    expect(embeddingCache?.sql).toContain('"embedding" DOUBLE[]');
  });

  it('materializes semantic bootstrap tables for non-DuckDB dialects', () => {
    const statements = generateMaterializeDdl('company', 'snowflake', 'ENTITY_GRAPH');

    expect(statements.some((statement) => statement.name === 'ddl_embedding_cache')).toBe(true);
  });

  it('materializes document mention quality as a replaceable view', () => {
    const statements = generateMaterializeDdl('company', 'duckdb', 'main');
    const quality = statements.find(
      (statement) => statement.name === 'ddl_document_mentions__quality'
    );

    expect(quality?.sql).toContain('CREATE OR REPLACE VIEW');
    expect(quality?.sql).toContain('company__document_mentions__quality');
    expect(quality?.sql).toContain('FROM "main"."company__document_mentions"');
    expect(quality?.sql).not.toContain('CREATE TABLE IF NOT EXISTS');
  });
});
