import { z } from 'zod';

import { identifierSchema } from '../compiler/shared-validators.js';

export const MentionExtractionCandidateRetrievalSchema = z
  .object({
    strategy: z
      .enum(['profile_exact', 'profile_fts', 'profile_vector', 'hybrid'])
      .default('hybrid'),
    k: z.number().int().positive().default(10),
    min_similarity: z.number().min(0).max(1).default(0.55),
  })
  .strict();
export type MentionExtractionCandidateRetrieval = z.infer<
  typeof MentionExtractionCandidateRetrievalSchema
>;

export const MentionExtractionSurfaceFiltersSchema = z
  .object({
    stopwords: z.array(z.string().trim().min(1)).optional(),
    exclude_regex: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .superRefine((pattern, ctx) => {
            try {
              new RegExp(pattern, 'iu');
            } catch (err) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Invalid regular expression: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              });
            }
          })
      )
      .optional(),
    min_chars: z.number().int().positive().optional(),
    max_words: z.number().int().positive().optional(),
  })
  .strict();
export type MentionExtractionSurfaceFilters = z.infer<typeof MentionExtractionSurfaceFiltersSchema>;

export const MentionExtractionSpecSchema = z
  .object({
    spec_version: z.literal('0.2'),
    type: z.literal('mention_extraction'),
    name: identifierSchema,
    entity_types: z.array(identifierSchema).min(1, 'At least one entity type is required'),
    ontology_ref: identifierSchema.optional(),
    candidate_retrieval: MentionExtractionCandidateRetrievalSchema.default({
      strategy: 'hybrid',
      k: 10,
      min_similarity: 0.55,
    }),
    surface_filters: MentionExtractionSurfaceFiltersSchema.optional(),
    extraction_role: identifierSchema.default('mention_disambiguation_v1'),
  })
  .strict();
export type MentionExtractionSpec = z.infer<typeof MentionExtractionSpecSchema>;
