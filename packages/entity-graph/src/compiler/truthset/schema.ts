import { z } from 'zod';
import { identifierMsg, identifierRegex } from '@bobsled-inc/model-spec/shared';

export const TruthsetSpecSchema = z.object({
  spec_version: z.literal('0.2'),
  name: z.string().min(1).regex(identifierRegex, identifierMsg),
  type: z.literal('truthset'),
  description: z.string().min(1),
  resolution_ref: z.string().min(1),
  labels: z.object({
    format: z.literal('csv'),
    path: z.string().min(1),
    delimiter: z.string().min(1).max(1).default(','),
  }),
  targets: z
    .object({
      min_auto_merge_precision: z.number().min(0).max(1).optional(),
    })
    .optional(),
});

export type TruthsetSpec = z.infer<typeof TruthsetSpecSchema>;
