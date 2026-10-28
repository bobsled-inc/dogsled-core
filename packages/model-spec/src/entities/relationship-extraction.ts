import { z } from 'zod';

import { identifierSchema } from '../compiler/shared-validators.js';

const DEFAULT_CHUNK_FILTER = {
  has_resolved_mentions_min: 2,
} as const;

const DEFAULT_CANDIDATE_PAIR_RULES = {
  max_pairs_per_chunk: 8,
  same_chunk_only: true,
  max_pair_span_distance_chars: 500,
} as const;

export const RelationshipExtractionChunkFilterSchema = z
  .object({
    has_resolved_mentions_min: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_CHUNK_FILTER.has_resolved_mentions_min),
    document_format_in: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();
export type RelationshipExtractionChunkFilter = z.infer<
  typeof RelationshipExtractionChunkFilterSchema
>;

export const RelationshipExtractionCandidatePairRulesSchema = z
  .object({
    max_pairs_per_chunk: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_CANDIDATE_PAIR_RULES.max_pairs_per_chunk),
    same_chunk_only: z.boolean().default(DEFAULT_CANDIDATE_PAIR_RULES.same_chunk_only),
    max_pair_span_distance_chars: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_CANDIDATE_PAIR_RULES.max_pair_span_distance_chars),
  })
  .strict();
export type RelationshipExtractionCandidatePairRules = z.infer<
  typeof RelationshipExtractionCandidatePairRulesSchema
>;

export const RelationshipExtractionModelConfigSchema = z
  .object({
    role: identifierSchema,
    prompt_version: z.string().trim().min(1, 'Prompt version is required'),
    constrained_decoding: z.boolean().default(true),
    require_span_evidence: z.boolean().default(true),
  })
  .strict();
export type RelationshipExtractionModelConfig = z.infer<
  typeof RelationshipExtractionModelConfigSchema
>;

export const RelationshipExtractionReviewSchema = z
  .object({
    use_ontology_thresholds: z.boolean().default(true),
  })
  .strict();
export type RelationshipExtractionReview = z.infer<typeof RelationshipExtractionReviewSchema>;

export const RelationshipExtractionSpecSchema = z
  .object({
    spec_version: z.literal('0.2'),
    type: z.literal('relationship_extraction'),
    name: identifierSchema,
    ontology_ref: identifierSchema,
    chunk_filter: RelationshipExtractionChunkFilterSchema.default(DEFAULT_CHUNK_FILTER),
    candidate_pair_rules: RelationshipExtractionCandidatePairRulesSchema.default(
      DEFAULT_CANDIDATE_PAIR_RULES
    ),
    extraction: RelationshipExtractionModelConfigSchema,
    review: RelationshipExtractionReviewSchema.default({
      use_ontology_thresholds: true,
    }),
  })
  .strict();
export type RelationshipExtractionSpec = z.infer<typeof RelationshipExtractionSpecSchema>;
