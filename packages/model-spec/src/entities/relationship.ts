/**
 * Relationship spec — describes how two Model Spec datasets join to each other.
 *
 * Multi-column joins are first-class. No SQL is emitted for relationship files
 * directly; downstream consumers (BI tool, host application, agent) use them to plan
 * joins when a query spans more than one source or derived model.
 *
 * Cross-reference validation (do `left_model` / `right_model` point at real Model Spec datasets?)
 * lives in `src/entities/cross-references.ts`.
 */

import { z } from 'zod';

import { identifierMsg, identifierRegex } from '../compiler/shared-validators.js';
import { EntityInterchangeSchema } from '../interchange/storage.js';
import { AiContextSchema, DatasetReferenceSchema } from './semantic-metadata.js';

const columnRefSchema = z
  .string()
  .trim()
  .min(1, 'Column name is required')
  .regex(identifierRegex, identifierMsg);

/**
 * Join type governs the SQL that downstream planners emit. `inner` and `left`
 * cover every real use case; we omit `right` (users are expected to reorder
 * the models) and `full` (rarely analytically meaningful) to keep the decision
 * surface tight.
 */
export const JoinTypeSchema = z.enum(['inner', 'left']);
export type JoinType = z.infer<typeof JoinTypeSchema>;

/**
 * Cardinality hint used by downstream planners (and surfaced in the UI). We
 * spell the four common cardinalities out rather than combine them, so the
 * `many-to-many` case is always explicit rather than inferable.
 */
export const RelationshipTypeSchema = z.enum([
  'one_to_one',
  'one_to_many',
  'many_to_one',
  'many_to_many',
]);
export type RelationshipType = z.infer<typeof RelationshipTypeSchema>;

/**
 * One equality clause on the join — `<left_model>.<left_column> = <right_model>.<right_column>`.
 * A relationship's `join_columns` is an array of these; every entry becomes an
 * AND in the generated `ON` clause.
 */
export const JoinColumnPairSchema = z
  .object({
    left: columnRefSchema,
    right: columnRefSchema,
  })
  .strict();
export type JoinColumnPair = z.infer<typeof JoinColumnPairSchema>;

export const RelationshipSpecSchema = z
  .object({
    spec_version: z.literal('0.2'),
    type: z.literal('relationship'),
    name: z
      .string()
      .trim()
      .min(1, 'Relationship name is required')
      .regex(identifierRegex, identifierMsg),
    description: z.string().optional(),

    left_model: DatasetReferenceSchema,
    right_model: DatasetReferenceSchema,

    /**
     * Equality clauses forming the join. At least one is required;
     * multi-column joins are supported by listing multiple entries.
     */
    join_columns: z.array(JoinColumnPairSchema).min(1, 'At least one join column pair is required'),

    join_type: JoinTypeSchema.default('inner'),
    relationship_type: RelationshipTypeSchema,

    tags: z.array(z.string().trim().min(1)).optional(),
    ai_context: AiContextSchema.optional(),
    interchange: EntityInterchangeSchema.optional(),
  })
  .strict();

export type RelationshipSpec = z.infer<typeof RelationshipSpecSchema>;
