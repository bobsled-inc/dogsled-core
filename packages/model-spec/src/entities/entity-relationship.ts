/**
 * Entity relationship spec — describes how mastered entity profiles link.
 *
 * This intentionally shares the Model Spec relationship vocabulary (`join_columns`,
 * `join_type`, and `relationship_type`) while keeping entity-graph-only fields
 * additive and separately typed.
 */

import { z } from 'zod';

import { identifierSchemaWithRequiredMessage } from '../compiler/shared-validators.js';
import { JoinTypeSchema, RelationshipTypeSchema } from './relationship.js';

const entityRefSchema = identifierSchemaWithRequiredMessage('Entity reference is required');

const attrPathSchema = z
  .string()
  .trim()
  .min(1, 'Attribute path is required')
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/,
    'Attribute path must be dot-separated identifiers'
  );

const relationNameSchema = identifierSchemaWithRequiredMessage('Relationship name is required');

export const EntityRelationshipJoinColumnPairSchema = z
  .object({
    left: attrPathSchema,
    right: attrPathSchema,
  })
  .strict();
export type EntityRelationshipJoinColumnPair = z.infer<
  typeof EntityRelationshipJoinColumnPairSchema
>;

export const EntityRelationshipScoringAlgorithmSchema = z.enum([
  'exact',
  'jaro_winkler',
  'edit_distance',
  'soundex',
  'numeric_distance',
]);
export type EntityRelationshipScoringAlgorithm = z.infer<
  typeof EntityRelationshipScoringAlgorithmSchema
>;

export const EntityRelationshipConfidenceFeatureSchema = z
  .object({
    field: attrPathSchema,
    algorithm: EntityRelationshipScoringAlgorithmSchema,
    weight: z.number().positive(),
  })
  .strict();
export type EntityRelationshipConfidenceFeature = z.infer<
  typeof EntityRelationshipConfidenceFeatureSchema
>;

export const EntityRelationshipConfidenceScoringSchema = z
  .object({
    features: z
      .array(EntityRelationshipConfidenceFeatureSchema)
      .min(1, 'At least one confidence feature is required'),
  })
  .strict();
export type EntityRelationshipConfidenceScoring = z.infer<
  typeof EntityRelationshipConfidenceScoringSchema
>;

export const EntityRelationshipTemporalSchema = z
  .object({
    validity_field_left: attrPathSchema.optional(),
    validity_field_right: attrPathSchema.optional(),
  })
  .strict()
  .refine((value) => value.validity_field_left || value.validity_field_right, {
    message: 'At least one temporal validity field is required',
  });
export type EntityRelationshipTemporal = z.infer<typeof EntityRelationshipTemporalSchema>;

export const EntityRelationshipReviewThresholdsSchema = z
  .object({
    auto_confirm: z.number().min(0).max(1),
    review: z.number().min(0).max(1),
    auto_reject: z.number().min(0).max(1),
  })
  .strict()
  .refine((value) => value.auto_confirm > value.review && value.review >= value.auto_reject, {
    message: 'thresholds must satisfy auto_confirm > review >= auto_reject',
  });
export type EntityRelationshipReviewThresholds = z.infer<
  typeof EntityRelationshipReviewThresholdsSchema
>;

export const EntityRelationshipReviewSchema = z
  .object({
    thresholds: EntityRelationshipReviewThresholdsSchema,
  })
  .strict();
export type EntityRelationshipReview = z.infer<typeof EntityRelationshipReviewSchema>;

export const EntityRelationshipSpecSchema = z
  .object({
    spec_version: z.literal('0.2'),
    type: z.literal('entity_relationship'),
    name: relationNameSchema,
    description: z.string().optional(),

    left_entity: entityRefSchema,
    right_entity: entityRefSchema,

    join_columns: z
      .array(EntityRelationshipJoinColumnPairSchema)
      .min(1, 'At least one join column pair is required'),
    join_type: JoinTypeSchema.default('inner'),
    relationship_type: RelationshipTypeSchema,

    confidence_scoring: EntityRelationshipConfidenceScoringSchema.optional(),
    temporal: EntityRelationshipTemporalSchema.optional(),
    review: EntityRelationshipReviewSchema,

    tags: z.array(z.string().trim().min(1)).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.left_entity !== value.right_entity ||
      value.join_columns.some((pair) => pair.left !== pair.right),
    {
      message:
        'Self entity relationships must join different profile attributes to avoid tautological edges',
      path: ['join_columns'],
    }
  );

export type EntityRelationshipSpec = z.infer<typeof EntityRelationshipSpecSchema>;
