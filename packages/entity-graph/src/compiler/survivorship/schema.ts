/**
 * Survivorship spec schema (forward-compat, no codegen in this phase).
 *
 * Defines the Zod schema for type: survivorship specs so they can
 * be parsed and validated. Actual codegen is deferred to Phase 3.
 */

import { z } from 'zod';
import { identifierMsg, identifierRegex } from '@bobsled-inc/model-spec/shared';

const schemaIdentifierRegex = /^[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)*$/;
const schemaIdentifierMsg = 'Must be a valid identifier (e.g. PUBLIC, my_schema, project.dataset)';

export const SurvivorshipSpecSchema = z
  .object({
    spec_version: z.literal('0.2'),
    name: z.string().min(1).regex(identifierRegex, identifierMsg),
    type: z.literal('survivorship'),
    description: z.string().min(1),
    resolution_ref: z.string().min(1),
    entity_id_policy: z
      .object({
        strategy: z.enum(['stable_uuid', 'min_source_id']),
      })
      .optional(),
    attribute_rules: z
      .array(
        z
          .object({
            attribute: z.string().regex(identifierRegex, identifierMsg),
            strategy: z.enum([
              'source_priority',
              'recency',
              'most_common',
              'most_complete',
              'value_priority',
              'pinned_value',
            ]),
            source_order: z.array(z.string()).optional(),
            timestamp_field: z.string().regex(identifierRegex, identifierMsg).optional(),
            fallback: z.string().optional(),
            value_priority: z.array(z.string()).optional(),
            pinned_value: z.string().optional(),
          })
          .superRefine((rule, ctx) => {
            if (
              rule.strategy === 'source_priority' &&
              (!rule.source_order || rule.source_order.length === 0)
            ) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['source_order'],
                message: 'source_order is required for source_priority strategy',
              });
            }
            if (rule.strategy === 'recency' && !rule.timestamp_field) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['timestamp_field'],
                message: 'timestamp_field is required for recency strategy',
              });
            }
            if (
              rule.strategy === 'value_priority' &&
              (!rule.value_priority || rule.value_priority.length === 0)
            ) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['value_priority'],
                message: 'value_priority is required for value_priority strategy',
              });
            }
            if (rule.strategy === 'pinned_value' && !rule.pinned_value) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['pinned_value'],
                message: 'pinned_value is required for pinned_value strategy',
              });
            }
          })
      )
      .optional(),
    default_timestamp_field: z.string().regex(identifierRegex, identifierMsg).optional(),
    outputs: z
      .object({
        target_schema: z.string().regex(schemaIdentifierRegex, schemaIdentifierMsg).optional(),
      })
      .optional(),
  })
  .superRefine((spec, ctx) => {
    if (spec.default_timestamp_field && (spec.attribute_rules?.length ?? 0) > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default_timestamp_field'],
        message: 'default_timestamp_field is only allowed when attribute_rules is omitted',
      });
    }
  });

export type SurvivorshipSpec = z.infer<typeof SurvivorshipSpecSchema>;
