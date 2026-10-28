import { z } from 'zod';
import { identifierMsg, identifierRegex } from './shared-validators.js';

export const SemanticTriageSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    dimensions: z.number().int().positive().optional(),
    price_per_million_tokens_usd: z.number().nonnegative().optional(),
    fields: z
      .array(z.string().min(1).regex(identifierRegex, identifierMsg))
      .min(1, 'At least one semantic triage field is required'),
    promote_to_merge_threshold: z.number().min(0).max(1),
    promote_to_reject_threshold: z.number().min(0).max(1),
  })
  .strict()
  .refine((triage) => new Set(triage.fields).size === triage.fields.length, {
    path: ['fields'],
    message: 'semantic_triage.fields must not contain duplicates',
  })
  .refine((triage) => triage.promote_to_reject_threshold < triage.promote_to_merge_threshold, {
    path: ['promote_to_reject_threshold'],
    message: 'promote_to_reject_threshold must be < promote_to_merge_threshold',
  });
