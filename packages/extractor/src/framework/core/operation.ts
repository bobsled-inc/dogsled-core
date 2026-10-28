import { z } from 'zod';

import { AuthSchema } from './auth.js';
import { InputFieldSchema, OutputFieldSchema } from './fields.js';
import {
  AbsoluteHttpsUrlSchema,
  HttpMethodSchema,
  JsonValueSchema,
  IntegrationRelativeEndpointSchema,
  SafeHeadersSchema,
} from './shared.js';

export const ApiEndpointSchema = z.union([
  AbsoluteHttpsUrlSchema,
  IntegrationRelativeEndpointSchema,
]);

export const ApiConfigSchema = z
  .object({
    endpoint: ApiEndpointSchema,
    method: HttpMethodSchema,
    /**
     * How a successful response body should be decoded. JSON remains the
     * default; JSONL is useful for APIs such as Vercel's FOCUS billing feed.
     */
    response_format: z.enum(['json', 'jsonl']).optional(),
    timeout_ms: z.number().int().positive().optional(),
    headers: SafeHeadersSchema.optional(),
    query_params: z.record(z.string(), z.string()).optional(),
    request_body: JsonValueSchema.optional(),
    auth: AuthSchema.optional(),
  })
  .strict();

export const McpToolConfigSchema = z
  .object({
    tool_name: z.string().min(1),
    arguments: z.record(z.string(), JsonValueSchema).optional(),
    timeout_ms: z.number().positive().optional(),
  })
  .strict();

export const OperationFixtureSchema = z
  .object({
    name: z.string(),
    input: z.record(z.string(), JsonValueSchema),
    expect: z.record(z.string(), JsonValueSchema).optional(),
  })
  .strict();

export const OperationTestSchema = z
  .object({
    fixtures: z.array(OperationFixtureSchema),
  })
  .strict();

export const OperationSpecSchema = z
  .object({
    description: z.string(),
    api: ApiConfigSchema,
    input: z.record(z.string(), InputFieldSchema),
    output: z.record(z.string(), OutputFieldSchema),
    test: OperationTestSchema.optional(),
  })
  .strict();

export type ApiConfig = z.infer<typeof ApiConfigSchema>;
export type OperationSpec = z.infer<typeof OperationSpecSchema>;
export type McpToolConfig = z.infer<typeof McpToolConfigSchema>;
