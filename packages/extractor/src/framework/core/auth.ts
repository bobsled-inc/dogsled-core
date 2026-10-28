import { z } from 'zod';

import { AbsoluteHttpsUrlSchema, JsonValueSchema, SafeHeadersSchema } from './shared.js';

/** Blocks transport headers but allows Authorization (which api-key auth legitimately targets). */
const API_KEY_RESTRICTED_HEADERS = ['host', 'content-length', 'transfer-encoding', 'connection'];
const HeaderNameFormatSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9-]*$/, 'Must be a valid HTTP header name')
  .refine(
    (value) => !API_KEY_RESTRICTED_HEADERS.includes(value.toLowerCase()),
    'Cannot override restricted HTTP transport headers'
  );

export const AuthSchema = z.union([
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
      type: z.literal('api-key'),
      header: HeaderNameFormatSchema.optional(),
      query_param: z.string().optional(),
      key: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('basic'),
      username: z.string(),
      password: z.string(),
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
      resource: AbsoluteHttpsUrlSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('oauth2'),
      grant_type: z.literal('authorization_code'),
      token_url: AbsoluteHttpsUrlSchema,
      client_id: z.string(),
      client_secret: z.string(),
      refresh_token: z.string(),
      scopes: z.array(z.string()).optional(),
      token_prefix: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('custom-token'),
      token_url: AbsoluteHttpsUrlSchema,
      token_request: z
        .object({
          method: z.enum(['GET', 'POST', 'PUT']).optional(),
          headers: SafeHeadersSchema.optional(),
          body: JsonValueSchema.optional(),
        })
        .strict()
        .optional(),
      token_response_path: z.string().optional(),
      token_prefix: z.string().optional(),
      token_ttl_seconds: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('aws-sigv4'),
      region: z.string(),
      service: z.string(),
      access_key_id: z.string(),
      secret_access_key: z.string(),
      session_token: z.string().optional(),
    })
    .strict(),
]);

export type AuthConfig = z.infer<typeof AuthSchema>;
export type NoneAuth = Extract<AuthConfig, { type: 'none' }>;
export type BearerAuth = Extract<AuthConfig, { type: 'bearer' }>;
export type ApiKeyAuth = Extract<AuthConfig, { type: 'api-key' }>;
export type BasicAuth = Extract<AuthConfig, { type: 'basic' }>;
export type OAuth2Auth = Extract<AuthConfig, { type: 'oauth2' }>;
export type CustomTokenAuth = Extract<AuthConfig, { type: 'custom-token' }>;
export type AwsSigV4Auth = Extract<AuthConfig, { type: 'aws-sigv4' }>;
