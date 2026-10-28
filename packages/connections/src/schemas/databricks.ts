/**
 * Databricks integration schema — connection + auth.
 *
 * Auth variants:
 *   - `pat`        — Personal Access Token (workspace-scoped)
 *   - `oauth_m2m`  — OAuth machine-to-machine (service principal; workspace or
 *                    account-level; short-lived tokens)
 */

import { z } from 'zod';

import { validateDualShapeFields } from './shared.js';

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export const DatabricksConnectionSchema = z
  .object({
    workspace_url: z
      .string()
      .optional()
      .describe('Databricks workspace URL (e.g. https://<workspace>.cloud.databricks.com)'),
    workspace_url_env: z.string().optional(),
    http_path: z
      .string()
      .optional()
      .describe('SQL warehouse HTTP path (e.g. /sql/1.0/warehouses/<warehouse-id>)'),
    http_path_env: z.string().optional(),
    catalog: z
      .string()
      .optional()
      .describe('Optional default catalog (Model Spec models can override at the model level)'),
    schema: z
      .string()
      .optional()
      .describe('Optional default schema (Model Spec models can override at the model level)'),
  })
  .strict()
  .superRefine((val, ctx) => {
    validateDualShapeFields(val, ctx, [
      { newField: 'workspace_url', legacyField: 'workspace_url_env', required: true },
      { newField: 'http_path', legacyField: 'http_path_env', required: true },
    ]);
  });

export type DatabricksConnection = z.infer<typeof DatabricksConnectionSchema>;

// ---------------------------------------------------------------------------
// Auth variants
// ---------------------------------------------------------------------------

export const DatabricksPatAuthSchema = z
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

export const DatabricksOAuthM2mAuthSchema = z
  .object({
    type: z.literal('oauth_m2m'),
    client_id: z.string().optional(),
    client_id_env: z.string().optional(),
    client_secret: z.string().optional(),
    client_secret_env: z.string().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    validateDualShapeFields(val, ctx, [
      { newField: 'client_id', legacyField: 'client_id_env', required: true },
      { newField: 'client_secret', legacyField: 'client_secret_env', required: true },
    ]);
  });

export const DatabricksAuthSchema = z.discriminatedUnion('type', [
  DatabricksPatAuthSchema,
  DatabricksOAuthM2mAuthSchema,
]);

export type DatabricksAuth = z.infer<typeof DatabricksAuthSchema>;
