/**
 * Barrel export for metadata entities (metrics / relationships / VQs).
 *
 * Consumed by `dogsled model compile --include-metadata`, `dogsled model validate`, and the
 * Model Spec programmatic library API. Entity schemas live under `./metric.ts`,
 * `./relationship.ts`, `./vq.ts`; directory loaders and cross-reference
 * validation live in `./registry.ts` and `./cross-references.ts`.
 */

export { MetricSpecSchema, type MetricSpec } from './metric.js';
export {
  AiContextSchema,
  DatasetReferenceSchema,
  OssieLogicalDataTypeSchema,
  SemanticExpressionSchema,
  type AiContext,
  type DatasetReference,
  type OssieLogicalDataType,
  type SemanticExpression,
} from './semantic-metadata.js';
export {
  RelationshipSpecSchema,
  JoinTypeSchema,
  RelationshipTypeSchema,
  JoinColumnPairSchema,
  type RelationshipSpec,
  type JoinType,
  type RelationshipType,
  type JoinColumnPair,
} from './relationship.js';
export {
  EntityRelationshipSpecSchema,
  EntityRelationshipJoinColumnPairSchema,
  EntityRelationshipScoringAlgorithmSchema,
  EntityRelationshipConfidenceFeatureSchema,
  EntityRelationshipConfidenceScoringSchema,
  EntityRelationshipTemporalSchema,
  EntityRelationshipReviewThresholdsSchema,
  EntityRelationshipReviewSchema,
  type EntityRelationshipSpec,
  type EntityRelationshipJoinColumnPair,
  type EntityRelationshipScoringAlgorithm,
  type EntityRelationshipConfidenceFeature,
  type EntityRelationshipConfidenceScoring,
  type EntityRelationshipTemporal,
  type EntityRelationshipReviewThresholds,
  type EntityRelationshipReview,
} from './entity-relationship.js';
export {
  MentionExtractionCandidateRetrievalSchema,
  MentionExtractionSurfaceFiltersSchema,
  MentionExtractionSpecSchema,
  type MentionExtractionCandidateRetrieval,
  type MentionExtractionSurfaceFilters,
  type MentionExtractionSpec,
} from './mention-extraction.js';
export {
  OntologyRelationTypeSchema,
  RelationshipDirectionSchema,
  RelationshipOntologyRelationSchema,
  RelationshipOntologySpecSchema,
  RelationshipSemanticsSchema,
  RelationshipTemporalKindSchema,
  type OntologyRelationType,
  type RelationshipDirection,
  type RelationshipOntologyRelation,
  type RelationshipOntologySpec,
  type RelationshipSemantics,
  type RelationshipTemporalKind,
} from './relationship-ontology.js';
export {
  RelationshipExtractionCandidatePairRulesSchema,
  RelationshipExtractionChunkFilterSchema,
  RelationshipExtractionModelConfigSchema,
  RelationshipExtractionReviewSchema,
  RelationshipExtractionSpecSchema,
  type RelationshipExtractionCandidatePairRules,
  type RelationshipExtractionChunkFilter,
  type RelationshipExtractionModelConfig,
  type RelationshipExtractionReview,
  type RelationshipExtractionSpec,
} from './relationship-extraction.js';
export {
  VqSpecSchema,
  VqParameterSchema,
  extractVqSqlTokens,
  type VqSpec,
  type VqParameter,
  type VqSqlToken,
} from './vq.js';
export {
  loadMetricsDirectory,
  loadRelationshipsDirectory,
  loadEntityRelationshipsDirectory,
  loadVqsDirectory,
  loadMetadataRegistry,
  loadIndexedMetadataRegistry,
  createEmptyMetadataRegistry,
  type MetadataRegistry,
} from './registry.js';
export { validateMetadataReferences, type MetadataValidationContext } from './cross-references.js';
