import { AuthEnvVarsSchema } from '@bobsled-inc/protocol';
/**
 * Integration file schema — a minimal view of `integrations/<handle>.yml` sufficient for
 * the loader to resolve connection + auth when a target references the integration.
 *
 * The extractor owns the canonical (strict) integration schemas in
 * `@bobsled-inc/extractor/framework/core/warehouse.ts`. This file deliberately mirrors only
 * the fields the loader needs (connection + auth by warehouse type, source_type for
 * capability checks). Keeping this parse in the loader avoids a cross-package dependency
 * on the extractor's internal framework; when we consolidate connection plumbing into a
 * shared package, this file is what gets replaced.
 */

import { z } from 'zod';

// Source types that accept loader writes (warehouse-shaped).
// Everything not in this set is refused at target-resolution time.
export const TARGET_CAPABLE_SOURCE_TYPES = new Set<string>([
  'snowflake',
  'bigquery',
  // Add as loader destinations land: 'postgres', 'mysql', 'databricks', 'clickhouse', ...
]);

// Source types that are extract-only (no loader destination of the same name exists).
export const API_SOURCE_TYPE = 'api';

// ---------------------------------------------------------------------------
// Dual-shape validation helper
// ---------------------------------------------------------------------------

interface DualFieldPair {
  newField: string;
  legacyField: string;
  required: boolean;
}

function validateDualShapeFields(
  val: Record<string, unknown>,
  ctx: z.RefinementCtx,
  pairs: DualFieldPair[]
): void {
  for (const { newField, legacyField, required } of pairs) {
    const hasNew = val[newField] !== undefined;
    const hasLegacy = val[legacyField] !== undefined;

    if (hasNew && hasLegacy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Cannot set both "${newField}" and "${legacyField}"; use one or the other.`,
        path: [newField],
      });
    }

    if (required && !hasNew && !hasLegacy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Either "${newField}" or "${legacyField}" must be set.`,
        path: [newField],
      });
    }
  }
}

// ── Snowflake ──────────────────────────────────────────────────────────────

const SnowflakeConnectionSchema = z
  .object({
    account_identifier: z.string().optional(),
    account_identifier_env: z.string().optional(),
    warehouse: z.string().optional(),
    warehouse_env: z.string().optional(),
    user: z.string().optional(),
    user_env: z.string().optional(),
    database: z.string().optional(),
    schema: z.string().optional(),
    role: z.string(),
  })
  .strict()
  .superRefine((val, ctx) => {
    validateDualShapeFields(val, ctx, [
      { newField: 'account_identifier', legacyField: 'account_identifier_env', required: true },
      { newField: 'warehouse', legacyField: 'warehouse_env', required: true },
      { newField: 'user', legacyField: 'user_env', required: false },
    ]);
  });

const SnowflakePatAuthSchema = z
  .object({
    type: z.literal('pat'),
    token: z.string().optional(),
    token_env: z.string().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    validateDualShapeFields(val, ctx, [
      { newField: 'token', legacyField: 'token_env', required: true },
    ]);
  });

const SnowflakeRsaKeyAuthSchema = z
  .object({
    type: z.literal('rsa_key'),
    private_key_path: z.string().optional(),
    private_key_path_env: z.string().optional(),
    private_key_passphrase: z.string().optional(),
    private_key_passphrase_env: z.string().optional(),
    // Username lives on connection.user/user_env so PAT + rsa_key + oauth all share it.
  })
  .strict()
  .superRefine((val, ctx) => {
    validateDualShapeFields(val, ctx, [
      { newField: 'private_key_path', legacyField: 'private_key_path_env', required: true },
      {
        newField: 'private_key_passphrase',
        legacyField: 'private_key_passphrase_env',
        required: false,
      },
    ]);
  });

const SnowflakeOAuthSchema = z
  .object({
    type: z.literal('oauth'),
    client_id: z.string().optional(),
    client_id_env: z.string().optional(),
    client_secret: z.string().optional(),
    client_secret_env: z.string().optional(),
    token_url: z.string().url(),
  })
  .strict()
  .superRefine((val, ctx) => {
    validateDualShapeFields(val, ctx, [
      { newField: 'client_id', legacyField: 'client_id_env', required: true },
      { newField: 'client_secret', legacyField: 'client_secret_env', required: true },
    ]);
  });

const SnowflakeAuthSchema = z.discriminatedUnion('type', [
  SnowflakePatAuthSchema,
  SnowflakeRsaKeyAuthSchema,
  SnowflakeOAuthSchema,
]);

const SnowflakeIntegrationSchema = z
  .object({
    spec_version: z.literal('1'),
    type: z.literal('integration'),
    name: z.string(),
    auth_env_vars: AuthEnvVarsSchema,
    source_type: z.literal('snowflake'),
    connection: SnowflakeConnectionSchema,
    auth: SnowflakeAuthSchema,
  })
  .passthrough(); // Tolerate fields we don't consume (storage, ssl, etc.)

// ── BigQuery ───────────────────────────────────────────────────────────────

const BigQueryConnectionSchema = z
  .object({
    project_ids: z.array(z.string()).optional(),
    project_id: z.string().optional(),
    billing_project_id: z.string().optional(),
    default_location: z.string().optional(),
    location: z.string().optional(),
    dataset: z.string().optional(),
  })
  .passthrough();

const BigQueryAdcAuthSchema = z.object({ type: z.literal('adc') }).strict();
const BigQueryWifAuthSchema = z
  .object({
    type: z.literal('wif'),
    service_account_email_env: z.string(),
  })
  .strict();
const BigQueryServiceAccountAuthSchema = z
  .object({
    type: z.literal('service_account'),
    credentials: z.string().optional(),
    credentials_env: z.string().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    validateDualShapeFields(val, ctx, [
      { newField: 'credentials', legacyField: 'credentials_env', required: true },
    ]);
  });

const BigQueryAuthSchema = z.discriminatedUnion('type', [
  BigQueryAdcAuthSchema,
  BigQueryWifAuthSchema,
  BigQueryServiceAccountAuthSchema,
]);

const BigQueryIntegrationSchema = z
  .object({
    spec_version: z.literal('1'),
    type: z.literal('integration'),
    name: z.string(),
    auth_env_vars: AuthEnvVarsSchema,
    source_type: z.literal('bigquery'),
    connection: BigQueryConnectionSchema,
    auth: BigQueryAuthSchema,
  })
  .passthrough();

// ── Generic (for capability rejection of non-warehouse source types) ──────

const UnsupportedIntegrationSchema = z
  .object({
    spec_version: z.literal('1'),
    type: z.literal('integration'),
    name: z.string(),
    auth_env_vars: AuthEnvVarsSchema,
    source_type: z.string(),
  })
  .passthrough();

// ── Union ──────────────────────────────────────────────────────────────────

export const IntegrationFileSchema = z.union([
  SnowflakeIntegrationSchema,
  BigQueryIntegrationSchema,
  UnsupportedIntegrationSchema,
]);

export type IntegrationFile = z.infer<typeof IntegrationFileSchema>;
export type SnowflakeIntegration = z.infer<typeof SnowflakeIntegrationSchema>;
export type BigQueryIntegration = z.infer<typeof BigQueryIntegrationSchema>;
