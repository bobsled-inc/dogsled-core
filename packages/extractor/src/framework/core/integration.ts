import { z } from 'zod';

import { AuthSchema } from './auth.js';
import { AbsoluteHttpsUrlSchema, SafeHeaderNameSchema, SafeHeadersSchema } from './shared.js';

const NON_OPTIONAL_REFERENCE_RE = /\$\{\{\s*(?!env\.|secrets\.)[A-Za-z_]/;

/**
 * Optional headers carry host-supplied request-scoped values, so their
 * templates may reference only the `env` and `secrets` namespaces. An `input`,
 * `mapped` or `integration` reference belongs in `headers`, where the request
 * router and strict interpolation account for it.
 */
const OptionalHeadersSchema = SafeHeadersSchema.superRefine((headers, ctx) => {
  for (const [name, value] of Object.entries(headers)) {
    if (NON_OPTIONAL_REFERENCE_RE.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'optional_headers may reference only ${{ env.* }} and ${{ secrets.* }}',
        path: [name],
      });
    }
  }
});

export const RetryConfigSchema = z
  .object({
    retry_on: z.array(z.number().int().min(400).max(599)).optional(),
    max_retries: z.number().int().nonnegative().max(10).optional(),
    backoff: z.enum(['fixed', 'exponential']).optional(),
    retry_after_header: z.boolean().optional(),
  })
  .strict();

export const RateLimitConfigSchema = z
  .object({
    requests_per_second: z.number().positive(),
    burst: z.number().positive(),
  })
  .strict();

export const HttpTransportSchema = z
  .object({
    type: z.literal('http'),
    base_url: AbsoluteHttpsUrlSchema,
    headers: SafeHeadersSchema.optional(),
    // Sent only when every referenced variable resolves to a non-empty value;
    // see `optional_headers` in the transport reference.
    optional_headers: OptionalHeadersSchema.optional(),
    auth: AuthSchema.optional(),
    timeout_ms: z.number().int().positive().optional(),
    retry: RetryConfigSchema.optional(),
    rate_limit: RateLimitConfigSchema.optional(),
  })
  .strict();

export const McpTransportAuthSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('none'),
    })
    .strict(),
  z
    .object({
      type: z.literal('bearer'),
      token: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('oauth2'),
      grant_type: z.literal('client_credentials'),
      token_url: AbsoluteHttpsUrlSchema,
      client_id: z.string(),
      client_secret: z.string(),
      scopes: z.array(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('api-key'),
      header: SafeHeaderNameSchema,
      key: z.string(),
    })
    .strict(),
]);

export const McpRetryConfigSchema = z
  .object({
    max_retries: z.number().int().nonnegative().max(10).optional(),
    backoff: z.enum(['fixed', 'exponential']).optional(),
  })
  .strict();

export const McpHttpTransportSchema = z
  .object({
    type: z.literal('mcp_http'),
    url: AbsoluteHttpsUrlSchema,
    auth: McpTransportAuthSchema.optional(),
    headers: SafeHeadersSchema.optional(),
    timeout_ms: z.number().int().positive().optional(),
    retry: McpRetryConfigSchema.optional(),
    rate_limit: RateLimitConfigSchema.optional(),
  })
  .strict();

export const McpStdioTransportSchema = z
  .object({
    type: z.literal('mcp_stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    timeout_ms: z.number().int().positive().optional(),
    retry: McpRetryConfigSchema.optional(),
    rate_limit: RateLimitConfigSchema.optional(),
  })
  .strict();

const TransportConfigSchemaCore = z.discriminatedUnion('type', [
  HttpTransportSchema,
  McpHttpTransportSchema,
  McpStdioTransportSchema,
]);

export const TransportConfigSchema = z.preprocess((input) => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return input;
  }

  const transport = input as Record<string, unknown>;
  if (!Object.hasOwn(transport, 'type') && typeof transport['base_url'] === 'string') {
    return {
      type: 'http',
      ...transport,
    };
  }

  return input;
}, TransportConfigSchemaCore);

export type RetryConfig = z.infer<typeof RetryConfigSchema>;
export type McpRetryConfig = z.infer<typeof McpRetryConfigSchema>;
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;
export type TransportConfig = z.infer<typeof TransportConfigSchema>;
export type HttpTransportConfig = z.infer<typeof HttpTransportSchema>;
export type McpTransportAuthConfig = z.infer<typeof McpTransportAuthSchema>;
export type McpHttpTransportConfig = z.infer<typeof McpHttpTransportSchema>;
export type McpStdioTransportConfig = z.infer<typeof McpStdioTransportSchema>;
