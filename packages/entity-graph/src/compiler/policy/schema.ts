import { z } from 'zod';

export const PolicyActivationGatesSchema = z
  .object({
    min_entity_trust_score: z.number().min(0).max(1).optional(),
  })
  .strict();

export const PolicyReviewExportSchema = z
  .object({
    redact_fields_for_agent_review: z.array(z.string()).default([]),
  })
  .strict();

export const PolicyApprovalGatesSchema = z
  .object({
    require_human_approval_for: z
      .array(z.enum(['high_impact_merge', 'all_agent_decisions']))
      .default([]),
  })
  .strict();

export const PolicySpecSchema = z
  .object({
    spec_version: z.literal('1'),
    type: z.literal('policy'),
    name: z.string().min(1),
    activation_gates: PolicyActivationGatesSchema.optional(),
    review_export: PolicyReviewExportSchema.optional(),
    approval_gates: PolicyApprovalGatesSchema.optional(),
  })
  .strict();

export type PolicySpec = z.infer<typeof PolicySpecSchema>;
export type PolicyActivationGates = z.infer<typeof PolicyActivationGatesSchema>;
export type PolicyReviewExport = z.infer<typeof PolicyReviewExportSchema>;
export type PolicyApprovalGates = z.infer<typeof PolicyApprovalGatesSchema>;
