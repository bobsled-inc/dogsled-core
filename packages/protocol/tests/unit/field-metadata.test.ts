import { describe, expect, it } from 'vitest';

import { EMBEDDING_DISTANCE_METRICS } from '../../src/definitions.js';
import {
  FieldMetadataSchema,
  FIELD_METADATA_TYPES,
  SEMANTIC_ROLES,
} from '../../src/field-metadata.js';

describe('FieldMetadataSchema', () => {
  it('keeps canonical protocol metadata types stable', () => {
    expect(FIELD_METADATA_TYPES).toEqual([
      'string',
      'integer',
      'number',
      'boolean',
      'timestamp',
      'date',
      'array',
      'object',
    ]);
  });

  it('keeps canonical semantic roles stable', () => {
    expect(SEMANTIC_ROLES).toEqual([
      'entity_id',
      'measure',
      'event_timestamp',
      'extraction_timestamp',
      'time_dimension',
      'categorical',
      'identifier',
      'name',
      'address',
      'email',
      'phone',
      'url',
      'currency',
      'count',
      'rate',
    ]);
  });

  it.each(FIELD_METADATA_TYPES)('accepts metadata type %s', (type) => {
    expect(FieldMetadataSchema.parse({ name: 'customer_id', type })).toMatchObject({
      name: 'customer_id',
      type,
    });
  });

  it.each(SEMANTIC_ROLES)('accepts semantic role %s', (semantic_role) => {
    expect(
      FieldMetadataSchema.parse({
        name: 'customer_id',
        type: 'string',
        semantic_role,
      })
    ).toMatchObject({ semantic_role });
  });

  it('rejects unknown fields so downstream packages share one contract', () => {
    expect(() =>
      FieldMetadataSchema.parse({
        name: 'customer_id',
        type: 'string',
        semantic_role: 'identifier',
        unexpected: true,
      })
    ).toThrow();
  });

  describe('embedded_from', () => {
    it('keeps canonical embedding distance metrics stable', () => {
      expect(EMBEDDING_DISTANCE_METRICS).toEqual(['cosine', 'l2', 'dot']);
    });

    it('accepts a minimal embedded_from block', () => {
      const parsed = FieldMetadataSchema.parse({
        name: 'description_embedding',
        type: 'array',
        embedded_from: {
          column: 'description',
          provider: 'openai',
          model: 'text-embedding-3-small',
        },
      });
      expect(parsed.embedded_from).toEqual({
        column: 'description',
        provider: 'openai',
        model: 'text-embedding-3-small',
      });
    });

    it('accepts an embedded_from block with distance_metric', () => {
      const parsed = FieldMetadataSchema.parse({
        name: 'description_embedding',
        type: 'array',
        embedded_from: {
          column: 'description',
          provider: 'openai',
          model: 'text-embedding-3-small',
          distance_metric: 'cosine',
        },
      });
      expect(parsed.embedded_from?.distance_metric).toBe('cosine');
    });

    it.each(EMBEDDING_DISTANCE_METRICS)('accepts distance_metric %s', (distance_metric) => {
      expect(() =>
        FieldMetadataSchema.parse({
          name: 'description_embedding',
          type: 'array',
          embedded_from: {
            column: 'description',
            provider: 'openai',
            model: 'text-embedding-3-small',
            distance_metric,
          },
        })
      ).not.toThrow();
    });

    it('rejects an unknown distance_metric', () => {
      expect(() =>
        FieldMetadataSchema.parse({
          name: 'description_embedding',
          type: 'array',
          embedded_from: {
            column: 'description',
            provider: 'openai',
            model: 'text-embedding-3-small',
            distance_metric: 'hamming',
          },
        })
      ).toThrow();
    });

    it('rejects an embedded_from block missing required fields', () => {
      expect(() =>
        FieldMetadataSchema.parse({
          name: 'description_embedding',
          type: 'array',
          embedded_from: { column: 'description', provider: 'openai' },
        })
      ).toThrow();
    });

    it('rejects unknown fields inside embedded_from', () => {
      expect(() =>
        FieldMetadataSchema.parse({
          name: 'description_embedding',
          type: 'array',
          embedded_from: {
            column: 'description',
            provider: 'openai',
            model: 'text-embedding-3-small',
            dimension: 1536,
          },
        })
      ).toThrow();
    });
  });
});
