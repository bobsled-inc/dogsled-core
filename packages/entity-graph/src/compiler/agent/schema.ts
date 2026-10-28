import { z } from 'zod';

export const AgentTaskOperationSchema = z.enum([
  'triage',
  'review_batch',
  'survivorship_refresh',
  'truthset_regress',
  'onboard_discover',
  'onboard_generate',
  'onboard_propose_cleaning',
  'onboard_verify',
]);

export const AgentTaskModeSchema = z.enum(['propose', 'apply']);

// 'review' = score-band pairs; 'deterministic_review' = pairs flagged by a
// deterministic rule with action: flag_for_review (queued regardless of score).
export const AGENT_THRESHOLD_BANDS = ['review', 'deterministic_review'] as const;

export const AgentThresholdBandSchema = z.enum(AGENT_THRESHOLD_BANDS);

export const AgentTaskProfileSchema = z.strictObject({
  spec_version: z.literal('0.2'),
  type: z.literal('agent_task_profile'),
  name: z.string().min(1),
  entity: z.string().min(1),
  operation: AgentTaskOperationSchema,
  mode: AgentTaskModeSchema.optional(),
  selection: z
    .strictObject({
      threshold_bands: z.array(AgentThresholdBandSchema).min(1).optional(),
      limit: z.number().int().positive().optional(),
    })
    .optional(),
  policy: z
    .strictObject({
      allow_writes: z.boolean().optional(),
      max_apply_count: z.number().int().positive().nullable().optional(),
      require_truthset_precision: z.number().min(0).max(1).nullable().optional(),
      auto_apply_threshold: z.number().min(0).max(1).optional(),
      agent_confidence_floor: z.number().min(0).max(1).default(0.5),
    })
    .optional(),
  post_apply: z
    .strictObject({
      cluster: z.boolean().optional(),
      survivorship: z.boolean().optional(),
    })
    .optional(),
  output: z
    .strictObject({
      decision_bundle_path: z.string().min(1).optional(),
    })
    .optional(),
});

export type AgentTaskOperation = z.infer<typeof AgentTaskOperationSchema>;
export type AgentTaskMode = z.infer<typeof AgentTaskModeSchema>;
export type AgentThresholdBand = z.infer<typeof AgentThresholdBandSchema>;
export type AgentTaskProfile = z.infer<typeof AgentTaskProfileSchema>;
