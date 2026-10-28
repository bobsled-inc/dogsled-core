/**
 * Postgres integration schema — connection + auth.
 *
 * Auth variants:
 *   - `password`  — username + password (the common case)
 *   - `iam`       — AWS IAM database authentication (RDS / Aurora)
 */

import { z } from 'zod';

import { validateDualShapeFields } from './shared.js';

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

const sslConfigSchema = z
  .object({
    mode: z.enum(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']).optional(),
    ca_cert: z.string().min(1).optional(),
    ca_cert_env: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    validateDualShapeFields(val, ctx, [
      { newField: 'ca_cert', legacyField: 'ca_cert_env', required: false },
    ]);
  })
  .optional();

export const PostgresConnectionSchema = z
  .object({
    host: z.string().trim().min(1).optional(),
    host_env: z.string().trim().min(1).optional(),
    port: z.number().int().positive().optional().default(5432),
    database: z.string().trim().min(1).describe('Postgres database name (session-scoped)'),
    schema: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Optional default schema (Model Spec models can override at the model level)'),
    application_name: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Sent as application_name on connect for observability'),
    ssl: sslConfigSchema,
  })
  .strict()
  .superRefine((val, ctx) => {
    validateDualShapeFields(val, ctx, [
      { newField: 'host', legacyField: 'host_env', required: true },
    ]);
  });

export type PostgresConnection = z.infer<typeof PostgresConnectionSchema>;

// ---------------------------------------------------------------------------
// Auth variants
// ---------------------------------------------------------------------------

export const PostgresPasswordAuthSchema = z
  .object({
    type: z.literal('password'),
    user: z.string().trim().min(1).optional(),
    user_env: z.string().trim().min(1).optional(),
    password: z.string().min(1).optional(),
    password_env: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    validateDualShapeFields(val, ctx, [
      { newField: 'user', legacyField: 'user_env', required: true },
      { newField: 'password', legacyField: 'password_env', required: true },
    ]);
  });

/**
 * AWS IAM database authentication. User is still required (used as the DB
 * user); password is issued by the AWS SDK at connect time and never lives
 * in YAML.
 */
export const PostgresIamAuthSchema = z
  .object({
    type: z.literal('iam'),
    user: z.string().trim().min(1).optional(),
    user_env: z.string().trim().min(1).optional(),
    region: z.string().trim().min(1).describe('AWS region for the IAM signer'),
  })
  .strict()
  .superRefine((val, ctx) => {
    validateDualShapeFields(val, ctx, [
      { newField: 'user', legacyField: 'user_env', required: true },
    ]);
  });

export const PostgresAuthSchema = z.discriminatedUnion('type', [
  PostgresPasswordAuthSchema,
  PostgresIamAuthSchema,
]);

export type PostgresAuth = z.infer<typeof PostgresAuthSchema>;
