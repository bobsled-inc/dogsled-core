/**
 * ClickHouse integration schema — connection + auth.
 *
 * Auth variants:
 *   - `password` — username + password over the HTTP interface
 *
 * ClickHouse exposes no schema level between database and table, so
 * `connection.database` is the only namespace this schema carries. Models
 * address tables as `database.table`; see `DialectFqnStyle` in
 * `@bobsled-inc/model-spec`.
 */

import { z } from 'zod';

import { validateDualShapeFields } from './shared.js';

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/**
 * `require` verifies against the system CA unless `ca_cert` supplies one.
 *
 * TLS is the default: omitting `ssl` entirely means `require`, because
 * ClickHouse Cloud is HTTPS-only and is the common target. A plain local
 * server opts out explicitly with `mode: disable`, which is the safer way
 * round — a forgotten setting fails to connect rather than silently sending
 * credentials in the clear.
 */
const sslConfigSchema = z
  .object({
    mode: z.enum(['disable', 'require']).optional(),
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

export const ClickHouseConnectionSchema = z
  .object({
    host: z.string().trim().min(1).optional(),
    host_env: z.string().trim().min(1).optional(),
    port: z
      .number()
      .int()
      .positive()
      .max(65535)
      .optional()
      .describe(
        'ClickHouse HTTP interface port. Defaults to 8443 with TLS (ClickHouse Cloud) or 8123 without.'
      ),
    database: z.string().trim().min(1).describe('ClickHouse database name'),
    statement_timeout_ms: z
      .number()
      .int()
      .positive()
      .max(86_400_000)
      .optional()
      .describe('Statement timeout in milliseconds (max 24h), sent as max_execution_time'),
    ssl: sslConfigSchema,
  })
  .strict()
  .superRefine((val, ctx) => {
    validateDualShapeFields(val, ctx, [
      { newField: 'host', legacyField: 'host_env', required: true },
    ]);
  });

export type ClickHouseConnection = z.infer<typeof ClickHouseConnectionSchema>;

// ---------------------------------------------------------------------------
// Auth variants
// ---------------------------------------------------------------------------

export const ClickHousePasswordAuthSchema = z
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
      // ClickHouse permits a passwordless user, so the value stays optional
      // while the dual-shape rule still rejects supplying both forms.
      { newField: 'password', legacyField: 'password_env', required: false },
    ]);
  });

export const ClickHouseAuthSchema = z.discriminatedUnion('type', [ClickHousePasswordAuthSchema]);

export type ClickHouseAuth = z.infer<typeof ClickHouseAuthSchema>;
