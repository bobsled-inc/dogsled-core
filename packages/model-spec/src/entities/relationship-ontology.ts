import { z } from 'zod';

import { identifierSchemaWithRequiredMessage } from '../compiler/shared-validators.js';
import { EntityRelationshipReviewThresholdsSchema } from './entity-relationship.js';
import { RelationshipTypeSchema } from './relationship.js';

const lowerSnakeIdentifierRegex = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

const entityRefSchema = identifierSchemaWithRequiredMessage('Entity reference is required');

export const RelationshipDirectionSchema = z.enum(['symmetric', 'directed']);
export type RelationshipDirection = z.infer<typeof RelationshipDirectionSchema>;

export const RelationshipTemporalKindSchema = z.enum(['stateful', 'event', 'static']);
export type RelationshipTemporalKind = z.infer<typeof RelationshipTemporalKindSchema>;

export const RelationshipSemanticsSchema = z
  .object({
    definition: z.string().trim().min(1),
    positive_examples: z.array(z.string().trim().min(1)).default([]),
    negative_examples: z.array(z.string().trim().min(1)).default([]),
    signal_phrases: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();
export type RelationshipSemantics = z.infer<typeof RelationshipSemanticsSchema>;

export const OntologyRelationTypeSchema = z
  .string()
  .trim()
  .min(1, 'Relation type is required')
  .regex(
    lowerSnakeIdentifierRegex,
    'Relation type must be lower_snake_case and start with a lowercase letter'
  );
export type OntologyRelationType = z.infer<typeof OntologyRelationTypeSchema>;

export const RelationshipOntologyRelationSchema = z
  .object({
    relation_type: OntologyRelationTypeSchema,
    description: z.string().trim().default(''),
    ontology_ref: z
      .object({
        ontology: z.string().min(1),
        concept: z.string().min(1),
        relationship: z.string().min(1),
        left_concept: z.string().min(1),
        right_concept: z.string().min(1),
      })
      .strict()
      .optional(),
    left_entity: entityRefSchema,
    right_entity: entityRefSchema,
    direction: RelationshipDirectionSchema,
    cardinality: RelationshipTypeSchema,
    aliases: z.array(OntologyRelationTypeSchema).default([]),
    exclusive_with: z.array(OntologyRelationTypeSchema).default([]),
    temporal: RelationshipTemporalKindSchema,
    review_thresholds: EntityRelationshipReviewThresholdsSchema,
    relationship_semantics: RelationshipSemanticsSchema.optional(),
  })
  .strict();
export type RelationshipOntologyRelation = z.infer<typeof RelationshipOntologyRelationSchema>;

export const RelationshipOntologySpecSchema = z
  .object({
    spec_version: z.literal('0.2'),
    type: z.literal('relationship_ontology'),
    name: identifierSchemaWithRequiredMessage('Ontology name is required'),
    relations: z
      .array(RelationshipOntologyRelationSchema)
      .min(1, 'At least one relation is required'),
  })
  .strict()
  .superRefine((value, ctx) => {
    const relationTypes = new Set<string>();
    const aliases = new Map<string, string>();

    value.relations.forEach((relation, relationIndex) => {
      if (!relation.description && !relation.ontology_ref) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['relations', relationIndex, 'description'],
          message: 'Relation description is required without ontology_ref.',
        });
      }
      if (relationTypes.has(relation.relation_type)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['relations', relationIndex, 'relation_type'],
          message: `Duplicate relation_type '${relation.relation_type}'`,
        });
      }
      relationTypes.add(relation.relation_type);

      relation.aliases.forEach((alias, aliasIndex) => {
        const previousOwner = aliases.get(alias);
        if (previousOwner) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['relations', relationIndex, 'aliases', aliasIndex],
            message: `Alias '${alias}' is already used by relation '${previousOwner}'`,
          });
        }
        aliases.set(alias, relation.relation_type);
      });
    });

    value.relations.forEach((relation, relationIndex) => {
      relation.aliases.forEach((alias, aliasIndex) => {
        if (relationTypes.has(alias)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['relations', relationIndex, 'aliases', aliasIndex],
            message: `Alias '${alias}' collides with a canonical relation_type`,
          });
        }
      });

      relation.exclusive_with.forEach((exclusive, exclusiveIndex) => {
        if (exclusive === relation.relation_type) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['relations', relationIndex, 'exclusive_with', exclusiveIndex],
            message: `exclusive_with cannot reference the relation itself`,
          });
          return;
        }
        if (!relationTypes.has(exclusive)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['relations', relationIndex, 'exclusive_with', exclusiveIndex],
            message: `exclusive_with relation '${exclusive}' is not declared in this ontology`,
          });
          return;
        }
        const inverse = value.relations.find((candidate) => candidate.relation_type === exclusive);
        if (inverse && !inverse.exclusive_with.includes(relation.relation_type)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['relations', relationIndex, 'exclusive_with', exclusiveIndex],
            message:
              `exclusive_with must be symmetric: '${exclusive}' must also list ` +
              `'${relation.relation_type}'`,
          });
        }
      });
    });
  });

export type RelationshipOntologySpec = z.infer<typeof RelationshipOntologySpecSchema>;
