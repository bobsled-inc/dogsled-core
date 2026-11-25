import { describe, expect, it } from 'vitest';

import {
  SourceSpecSchema,
  TransformSpecSchema,
  SeedSpecSchema,
} from '../../../src/compiler/schemas.js';
import { mapVectorType } from '../../../src/compiler/seed/codegen.js';

const baseSource = {
  spec_version: '0.2' as const,
  name: 'raw_documents',
  type: 'source' as const,
  source_type: 'warehouse_table' as const,
  connection: 'docs',
  table: 'RAW.RAW_DOCUMENTS',
};

const baseTransform = {
  spec_version: '0.2' as const,
  name: 'stg_documents',
  type: 'model' as const,
  description: 'staging',
  grain: 'id',
  source: { ref: 'docs.raw_documents' },
  include_all_columns: true,
  materialization: { type: 'view' as const },
};

const baseSeed = {
  spec_version: '0.2' as const,
  name: 'seed_vectors',
  type: 'seed' as const,
  payload: { format: 'csv' as const, path: './seed_vectors.csv' },
};

describe('VECTOR column type', () => {
  describe('SourceSpecSchema', () => {
    it('accepts VECTOR columns with dimension + embedded_from', () => {
      const result = SourceSpecSchema.safeParse({
        ...baseSource,
        schema: {
          columns: [
            { name: 'ID', type: 'NUMBER' },
            { name: 'description', type: 'STRING' },
            {
              name: 'DESCRIPTION_EMBEDDING',
              type: 'VECTOR',
              dimension: 1536,
              description: 'Vector embedding of description (openai/text-embedding-3-small)',
              embedded_from: {
                column: 'description',
                provider: 'openai',
                model: 'text-embedding-3-small',
              },
            },
          ],
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects embedded_from.column referencing an undeclared column', () => {
      const result = SourceSpecSchema.safeParse({
        ...baseSource,
        schema: {
          columns: [
            {
              name: 'DESCRIPTION_EMBEDDING',
              type: 'VECTOR',
              dimension: 1536,
              embedded_from: {
                column: 'descriptoin', // typo
                provider: 'openai',
                model: 'text-embedding-3-small',
              },
            },
          ],
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => /embedded_from\.column/.test(i.message))).toBe(true);
      }
    });

    it('rejects VECTOR columns missing dimension', () => {
      const result = SourceSpecSchema.safeParse({
        ...baseSource,
        schema: {
          columns: [{ name: 'EMB', type: 'VECTOR' }],
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes('dimension'))).toBe(true);
      }
    });

    it('rejects dimension on non-VECTOR columns', () => {
      const result = SourceSpecSchema.safeParse({
        ...baseSource,
        schema: {
          columns: [{ name: 'EMAIL', type: 'STRING', dimension: 1536 }],
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes('dimension'))).toBe(true);
      }
    });

    it('accepts embedded_from with reserved distance_metric values', () => {
      for (const metric of ['cosine', 'l2', 'dot'] as const) {
        const result = SourceSpecSchema.safeParse({
          ...baseSource,
          schema: {
            columns: [
              { name: 'description', type: 'STRING' },
              {
                name: 'EMB',
                type: 'VECTOR',
                dimension: 1536,
                embedded_from: {
                  column: 'description',
                  provider: 'openai',
                  model: 'text-embedding-3-small',
                  distance_metric: metric,
                },
              },
            ],
          },
        });
        expect(result.success).toBe(true);
      }
    });

    it.each([
      [1536, true],
      [undefined, true],
      [1024, false],
      [0, false],
    ])('checks an embedded_from dimension of %s', (dimension, valid) => {
      const embeddedFrom = {
        column: 'description',
        provider: 'openai',
        model: 'text-embedding-3-small',
        ...(dimension === undefined ? {} : { dimension }),
      };
      const vector = { type: 'VECTOR', dimension: 1536, embedded_from: embeddedFrom };
      const source = SourceSpecSchema.safeParse({
        ...baseSource,
        schema: {
          columns: [
            { name: 'description', type: 'STRING' },
            { name: 'EMB', ...vector },
          ],
        },
      });
      const transform = TransformSpecSchema.safeParse({
        ...baseTransform,
        derived_columns: [{ name: 'emb', expr: 'emb', ...vector }],
      });
      expect([source.success, transform.success]).toEqual([valid, valid]);
      if (dimension === 1024 && !source.success) {
        expect(source.error.issues[0]?.message).toContain('must equal the column dimension');
      }
    });

    it('rejects unknown distance_metric values', () => {
      const result = SourceSpecSchema.safeParse({
        ...baseSource,
        schema: {
          columns: [
            {
              name: 'EMB',
              type: 'VECTOR',
              dimension: 1536,
              embedded_from: {
                column: 'description',
                provider: 'openai',
                model: 'text-embedding-3-small',
                distance_metric: 'hamming',
              },
            },
          ],
        },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('TransformSpecSchema', () => {
    it('accepts VECTOR derived_columns with embedded_from', () => {
      const result = TransformSpecSchema.safeParse({
        ...baseTransform,
        derived_columns: [
          {
            name: 'description_embedding',
            expr: 'description_embedding',
            type: 'VECTOR',
            dimension: 1536,
            embedded_from: {
              column: 'description',
              provider: 'openai',
              model: 'text-embedding-3-small',
            },
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('rejects derived VECTOR columns missing dimension', () => {
      const result = TransformSpecSchema.safeParse({
        ...baseTransform,
        derived_columns: [{ name: 'emb', expr: 'emb', type: 'VECTOR' }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('SeedSpecSchema', () => {
    it('rejects VECTOR seed columns with a clear message (INSERT-value serialization not wired up)', () => {
      const result = SeedSpecSchema.safeParse({
        ...baseSeed,
        schema: {
          columns: [
            { name: 'id', type: 'INTEGER', primary_key: true },
            { name: 'emb', type: 'VECTOR' },
          ],
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => /not supported in seed specs/.test(i.message))).toBe(
          true
        );
      }
    });
  });

  describe('mapVectorType (per-dialect emission)', () => {
    it('emits Snowflake VECTOR(FLOAT, N)', () => {
      expect(mapVectorType('snowflake', 1536)).toBe('VECTOR(FLOAT, 1536)');
    });

    it('emits BigQuery ARRAY<FLOAT64>', () => {
      expect(mapVectorType('bigquery', 1536)).toBe('ARRAY<FLOAT64>');
    });

    it('emits DuckDB FLOAT[N]', () => {
      expect(mapVectorType('duckdb', 1536)).toBe('FLOAT[1536]');
    });

    it('emits ClickHouse Array(Float32), dropping the dimension', () => {
      // ClickHouse has no fixed-length vector type; the similarity index is
      // declared on an ordinary array, which is what the loader writes too.
      expect(mapVectorType('clickhouse', 1536)).toBe('Array(Float32)');
    });

    it('emits pgvector vector(N)', () => {
      expect(mapVectorType('pgvector', 1536)).toBe('vector(1536)');
    });

    it('emits Postgres JSONB fallback (no pgvector extension)', () => {
      expect(mapVectorType('postgres', 1536)).toBe('JSONB');
    });

    it('emits Databricks ARRAY<FLOAT>', () => {
      expect(mapVectorType('databricks', 1536)).toBe('ARRAY<FLOAT>');
    });

    it('emits MySQL JSON fallback', () => {
      expect(mapVectorType('mysql', 1536)).toBe('JSON');
    });

    it('emits Redshift JSONB fallback (Postgres-family canonical)', () => {
      expect(mapVectorType('redshift', 1536)).toBe('JSONB');
    });

    it('throws without a positive dimension', () => {
      expect(() => mapVectorType('snowflake')).toThrow(/positive integer dimension/);
      expect(() => mapVectorType('snowflake', 0)).toThrow(/positive integer dimension/);
    });
  });
});
