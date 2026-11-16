/**
 * Snowflake integration schema — connection + auth.
 *
 * Auth variants:
 *   - `pat`              — personal access token (Snowflake programmatic access tokens)
 *   - `rsa_key`          — key-pair JWT (dbt's default; Snowflake recommended)
 *   - `oauth`            — OAuth 2.0 client_credentials grant
 *   - `workload_identity` — generic custom-runner workload identity token
 *   - `sledhouse_oidc`   — platform-managed OIDC; **no built-in runner**, requires
 *                          a host-registered CustomRunnerFactory
 */

import { z } from 'zod';

import { validateDualShapeFields } from './shared.js';

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/**
 * True when a field value is a `${{ env.VAR }}` interpolation template rather
 * than a literal. Such values resolve at runtime, so parse-time membership
 * checks must skip them (the literal name is unknown until interpolation).
 */
function isEnvInterpolation(value: string): boolean {
  return /^\s*\$\{\{\s*env\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}\s*$/.test(value);
}

export const SnowflakeConnectionSchema = z
  .object({
    account_identifier: z
      .string()
      .optional()
      .describe('Snowflake account identifier (use `${{ env.VAR }}` interpolation)'),
    account_identifier_env: z
      .string()
      .optional()
      .describe('[DEPRECATED] Env var holding the Snowflake account identifier'),
    warehouse: z
      .string()
      .optional()
      .describe('Default Snowflake warehouse name (use `${{ env.VAR }}` interpolation)'),
    warehouse_env: z
      .string()
      .optional()
      .describe('[DEPRECATED] Env var holding the Snowflake warehouse name'),
    warehouses: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Named map of selectable warehouses (id -> warehouse name). Each value is ' +
          'env-interpolable like `warehouse`. A pipeline picks one via its ' +
          '`warehouse:` selector; the default `warehouse` must be one of these values.'
      ),
    user: z.string().optional().describe('Snowflake username (use `${{ env.VAR }}` interpolation)'),
    user_env: z.string().optional().describe('[DEPRECATED] Env var holding the Snowflake username'),
    database: z
      .string()
      .optional()
      .describe(
        'Optional default database name (Model Spec models can override this at the model level)'
      ),
    schema: z
      .string()
      .optional()
      .describe(
        'Optional default schema name (Model Spec models can override this at the model level)'
      ),
    role: z.string().describe('Snowflake role to assume — session-wide permission boundary'),
  })
  .strict()
  .superRefine((val, ctx) => {
    validateDualShapeFields(val, ctx, [
      { newField: 'account_identifier', legacyField: 'account_identifier_env', required: true },
      { newField: 'warehouse', legacyField: 'warehouse_env', required: true },
      { newField: 'user', legacyField: 'user_env', required: false },
    ]);

    if (val.warehouses === undefined) return;

    const values = Object.values(val.warehouses);
    if (values.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'warehouses must declare at least one entry when set.',
        path: ['warehouses'],
      });
      return;
    }

    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const name of values) {
      if (seen.has(name)) duplicates.add(name);
      seen.add(name);
    }
    if (duplicates.size > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `warehouses must not repeat warehouse names: ${[...duplicates].join(', ')}.`,
        path: ['warehouses'],
      });
    }

    // The default `warehouse` must be one of the declared set's VALUES. The
    // membership check runs on the literal value because interpolation happens
    // later in the runtime — a default supplied via `warehouse_env` (legacy) or
    // a `${{ env.VAR }}` template (current) has no resolved name here, so it is
    // skipped (its real value is unknown at parse time). Only plain literal
    // warehouse names are checked against the set.
    if (
      typeof val.warehouse === 'string' &&
      !isEnvInterpolation(val.warehouse) &&
      !values.includes(val.warehouse)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `Default warehouse "${val.warehouse}" must be one of the declared ` +
          `warehouses values: ${values.join(', ')}.`,
        path: ['warehouse'],
      });
    }
  });

export type SnowflakeConnection = z.infer<typeof SnowflakeConnectionSchema>;

// ---------------------------------------------------------------------------
// Auth variants
// ---------------------------------------------------------------------------

export const SnowflakePatAuthSchema = z
  .object({
    type: z.literal('pat'),
    token: z
      .string()
      .optional()
      .describe('Personal access token (use `${{ env.VAR }}` interpolation)'),
    token_env: z.string().optional().describe('[DEPRECATED] Env var holding the PAT'),
  })
  .strict()
  .superRefine((val, ctx) => {
    validateDualShapeFields(val, ctx, [
      { newField: 'token', legacyField: 'token_env', required: true },
    ]);
  });

export const SnowflakeRsaKeyAuthSchema = z
  .object({
    type: z.literal('rsa_key'),
    private_key_path: z.string().optional().describe('Filesystem path to the RSA private key PEM'),
    private_key_path_env: z
      .string()
      .optional()
      .describe('[DEPRECATED] Env var holding the private-key file path'),
    private_key_passphrase: z
      .string()
      .optional()
      .describe('Passphrase for the RSA private key (omit for unencrypted keys)'),
    private_key_passphrase_env: z
      .string()
      .optional()
      .describe('[DEPRECATED] Env var holding the private-key passphrase'),
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

export const SnowflakeOAuthAuthSchema = z
  .object({
    type: z.literal('oauth'),
    client_id: z.string().optional(),
    client_id_env: z.string().optional(),
    client_secret: z.string().optional(),
    client_secret_env: z.string().optional(),
    token_url: z
      .string()
      .url()
      .describe('OAuth 2.0 token endpoint (HTTPS required)')
      .refine((v) => v.startsWith('https://'), 'token_url must use HTTPS'),
  })
  .strict()
  .superRefine((val, ctx) => {
    validateDualShapeFields(val, ctx, [
      { newField: 'client_id', legacyField: 'client_id_env', required: true },
      { newField: 'client_secret', legacyField: 'client_secret_env', required: true },
    ]);
  });

/**
 * Generic Snowflake workload identity authentication.
 *
 * This is a custom-runner contract, not a Bobsled Core built-in runner. The token
 * remains outside integration YAML and is supplied by the host's registered
 * CustomRunnerFactory.
 */
export const SnowflakeWorkloadIdentityAuthSchema = z
  .object({
    type: z.literal('workload_identity'),
  })
  .strict();

/**
 * Snowflake auth via platform-managed OIDC.
 *
 * Model Spec ships NO built-in runner for this variant — it exists in the schema so
 * that `integrations/<handle>.yml` files using it validate cleanly, but
 * `resolveRunner((snowflake, sledhouse_oidc))` returns a hard error unless
 * the host has registered a matching `CustomRunnerFactory`. The host application
 * app owns that factory; open-source consumers should never need this
 * variant.
 *
 * `.passthrough()` is used so that host-specific metadata fields (e.g.
 * `data_source_slug`, `workspace_id`) travel through unchanged without Model Spec
 * needing to know their shape.
 */
export const SnowflakeSledhouseOidcAuthSchema = z
  .object({
    type: z.literal('sledhouse_oidc'),
  })
  .passthrough();

export const SnowflakeAuthSchema = z.discriminatedUnion('type', [
  SnowflakePatAuthSchema,
  SnowflakeRsaKeyAuthSchema,
  SnowflakeOAuthAuthSchema,
  SnowflakeWorkloadIdentityAuthSchema,
  SnowflakeSledhouseOidcAuthSchema,
]);

export type SnowflakeAuth = z.infer<typeof SnowflakeAuthSchema>;
