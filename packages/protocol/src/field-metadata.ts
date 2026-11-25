import { z } from 'zod';

import { EMBEDDING_DISTANCE_METRICS } from './definitions.js';

export const FIELD_METADATA_TYPES = [
  'string',
  'integer',
  'number',
  'boolean',
  'timestamp',
  'date',
  'array',
  'object',
] as const;

export const SEMANTIC_ROLES = [
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
] as const;

export const FieldMetadataTypeSchema = z.enum(FIELD_METADATA_TYPES);
export const SemanticRoleSchema = z.enum(SEMANTIC_ROLES);

export const EmbeddingDistanceMetricSchema = z.enum(EMBEDDING_DISTANCE_METRICS);

/**
 * Provenance for an embedding column. Declared on the embedding column
 * itself (e.g. `description_embedding`) so downstream consumers — the
 * loader's DDL inference, the SDK IR, the host agent — can recover
 * which source column was embedded and which provider/model produced it.
 * The model identity is required to generate a query embedding in the
 * same family at vector-search time.
 */
export const EmbeddedFromSchema = z
  .object({
    column: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    /** Vector length the model produced. Absent in specs written before it was recorded. */
    dimension: z.number().int().positive().optional(),
    distance_metric: EmbeddingDistanceMetricSchema.optional(),
  })
  .strict();

export const FieldMetadataSchema = z
  .object({
    name: z.string().min(1),
    type: FieldMetadataTypeSchema,
    description: z.string().optional(),
    semantic_role: SemanticRoleSchema.optional(),
    tags: z.array(z.string()).optional(),
    unit: z.string().optional(),
    format: z.string().optional(),
    pii: z.boolean().optional(),
    enum_values: z.array(z.string()).optional(),
    examples: z.array(z.unknown()).optional(),
    references: z.string().optional(),
    business_rule: z.string().optional(),
    quality_notes: z.string().optional(),
    owner: z.string().optional(),
    deprecated: z.boolean().optional(),
    embedding_candidate: z.boolean().optional(),
    embedded_from: EmbeddedFromSchema.optional(),
  })
  .strict();

export type FieldMetadataType = z.infer<typeof FieldMetadataTypeSchema>;
export type SemanticRole = z.infer<typeof SemanticRoleSchema>;
export type EmbeddedFrom = z.infer<typeof EmbeddedFromSchema>;
export type FieldMetadata = z.infer<typeof FieldMetadataSchema>;
