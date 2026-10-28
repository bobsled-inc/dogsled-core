import { AuthEnvVarsSchema } from '@bobsled-inc/protocol';
import { z } from 'zod';

import {
  AbsoluteHttpsUrlSchema,
  ApiConfigSchema,
  InputFieldSchema,
  JsonValueSchema,
  SafeHeaderValueSchema,
  SpecNameSchema,
} from '../core/index.js';

export const ErrorHandlingSchema = z
  .object({
    on_record_error: z.enum(['skip', 'fail', 'retry']).default('skip'),
    consecutive_failure_threshold: z.number().int().positive().default(10),
    max_retries: z.number().int().nonnegative().default(3),
  })
  .strict();

const DEFAULT_ERROR_HANDLING = ErrorHandlingSchema.parse({});
const RESTRICTED_WEBHOOK_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

const ActionBaseFields = {
  spec_version: z.literal('1').optional(),
  type: z.literal('action'),
  name: SpecNameSchema,
  integration: SpecNameSchema.optional(),
  tags: z.array(z.string()).default([]),
  description: z.string().min(1),
  input: z.record(z.string(), InputFieldSchema),
  error_handling: ErrorHandlingSchema.default(DEFAULT_ERROR_HANDLING),
} as const;

export const FieldTransformSchema = z.enum(['as_is', 'to_string']);

export const FieldMappingEntrySchema = z.union([
  z.string(),
  z
    .object({
      source: z.string(),
      transform: FieldTransformSchema.default('as_is'),
      default: JsonValueSchema.optional(),
      required: z.boolean().default(false),
    })
    .strict(),
]);

export const FieldMappingSchema = z
  .object({
    fields: z.record(z.string(), FieldMappingEntrySchema),
    unmapped_fields: z.enum(['ignore', 'passthrough', 'error']).default('ignore'),
  })
  .strict();

const ActionIdentitySchema = z
  .object({
    fields: z
      .array(z.string())
      .min(1)
      .refine(
        (fields) => new Set(fields).size === fields.length,
        'identity.fields must contain unique values'
      ),
    strategy: z.enum(['external_id', 'lookup', 'composite_key']),
    lookup_endpoint: z
      .string()
      .trim()
      .min(1, 'lookup_endpoint must be a non-empty string')
      .refine(
        (value) => /^\/(?!\/)/.test(value),
        'lookup_endpoint must start with "/" and be a relative API path'
      )
      .optional(),
  })
  .strict();

const CreateActivateConfigSchema = z
  .object({
    operation: z.literal('create'),
    result_path: z.string().default('$'),
    success_indicator: z.string().optional(),
  })
  .strict();

const MutatingActivateConfigSchema = z
  .object({
    operation: z.enum(['upsert', 'update']),
    identity: ActionIdentitySchema,
    result_path: z.string().default('$'),
    success_indicator: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.identity.strategy === 'lookup' && value.identity.lookup_endpoint === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['identity', 'lookup_endpoint'],
        message: 'lookup_endpoint is required when identity.strategy is "lookup"',
      });
    }
  });

export const ActivateConfigSchema = z.discriminatedUnion('operation', [
  CreateActivateConfigSchema,
  MutatingActivateConfigSchema,
]);

export const ApiActionSchema = z
  .object({
    ...ActionBaseFields,
    transport: z.literal('api'),
    integration: SpecNameSchema,
    api: ApiConfigSchema,
    field_mapping: FieldMappingSchema,
    activate: ActivateConfigSchema,
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (spec.activate.operation === 'create') {
      return;
    }

    const mappedFields = new Set(Object.keys(spec.field_mapping.fields));

    for (const field of spec.activate.identity.fields) {
      if (!mappedFields.has(field) && !Object.hasOwn(spec.input, field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['activate', 'identity', 'fields'],
          message: `Identity field "${field}" must exist in field_mapping.fields or input`,
        });
      }
    }
  });

export const WebhookActionSchema = z
  .object({
    ...ActionBaseFields,
    transport: z.literal('webhook'),
    auth_env_vars: AuthEnvVarsSchema,
    webhook: z
      .object({
        url: AbsoluteHttpsUrlSchema,
        method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
        headers: z
          .record(
            z
              .string()
              .regex(/^[A-Za-z][A-Za-z0-9-]*$/, 'Must be a valid HTTP header name')
              .refine(
                // Unlike SafeHeaderNameSchema / RESTRICTED_HEADERS, webhook actions may
                // intentionally forward Authorization. Only block hop-by-hop headers here.
                (value) => !RESTRICTED_WEBHOOK_HEADERS.has(value.toLowerCase()),
                'Cannot override restricted HTTP headers'
              ),
            SafeHeaderValueSchema
          )
          .default({}),
        request_body: JsonValueSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const ActionSpecSchema = z.discriminatedUnion('transport', [
  ApiActionSchema,
  WebhookActionSchema,
]);

export type ErrorHandlingConfig = z.infer<typeof ErrorHandlingSchema>;
export type FieldTransform = z.infer<typeof FieldTransformSchema>;
export type FieldMappingEntry = z.infer<typeof FieldMappingEntrySchema>;
export type FieldMapping = z.infer<typeof FieldMappingSchema>;
export type ActivateConfig = z.infer<typeof ActivateConfigSchema>;
export type ApiAction = z.infer<typeof ApiActionSchema>;
export type WebhookAction = z.infer<typeof WebhookActionSchema>;
export type ActionSpec = z.infer<typeof ActionSpecSchema>;
export type ActionTransport = ActionSpec['transport'];
