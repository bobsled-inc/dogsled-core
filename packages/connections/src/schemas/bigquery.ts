/**
 * BigQuery integration schema — connection + auth.
 *
 * Auth variants:
 *   - `adc`              — Application Default Credentials (no fields)
 *   - `wif`              — Workload Identity Federation (service account email
 *                           via `service_account_email` or legacy
 *                           `service_account_email_env`)
 *   - `service_account`  — explicit service-account JSON (payload or file path)
 */

import { z } from 'zod';

import { validateDualShapeFields } from './shared.js';

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export const BigQueryConnectionSchema = z
  .object({
    project_ids: z
      .array(z.string().trim().min(1))
      .min(1)
      .optional()
      .describe('GCP project IDs the integration may read from / write to'),
    project_id: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('GCP project ID (single-project shorthand)'),
    billing_project_id: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('GCP project used for BigQuery billing (defaults to project_id if omitted)'),
    default_location: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Default BigQuery dataset location (e.g. US, EU)'),
    location: z.string().trim().min(1).optional().describe('Alias for default_location'),
    dataset: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Optional default dataset (Model Spec models can override this at the model level)'
      ),
  })
  .strict()
  .superRefine((val, ctx) => {
    // Require at least one of project_id / project_ids.
    if (
      val.project_id === undefined &&
      (val.project_ids === undefined || val.project_ids.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Either "project_id" or a non-empty "project_ids" array must be set.',
        path: ['project_id'],
      });
    }
    // `location` and `default_location` are aliases; setting both is ambiguous.
    if (val.location !== undefined && val.default_location !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          '"location" and "default_location" are aliases; set only one. ' +
          'Prefer "default_location".',
        path: ['location'],
      });
    }
  });

export type BigQueryConnection = z.infer<typeof BigQueryConnectionSchema>;

// ---------------------------------------------------------------------------
// Auth variants
// ---------------------------------------------------------------------------

export const BigQueryAdcAuthSchema = z
  .object({
    type: z.literal('adc'),
  })
  .strict();

export const BigQueryWifAuthSchema = z
  .object({
    type: z.literal('wif'),
    service_account_email: z.string().trim().min(1).optional(),
    service_account_email_env: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    validateDualShapeFields(val, ctx, [
      {
        newField: 'service_account_email',
        legacyField: 'service_account_email_env',
        required: true,
      },
    ]);
  });

export const BigQueryServiceAccountAuthSchema = z
  .object({
    type: z.literal('service_account'),
    credentials: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Service-account JSON payload or file path (use `${{ env.VAR }}`)'),
    credentials_env: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('[DEPRECATED] Env var holding the credentials payload or file path'),
  })
  .strict()
  .superRefine((val, ctx) => {
    validateDualShapeFields(val, ctx, [
      { newField: 'credentials', legacyField: 'credentials_env', required: true },
    ]);
  });

export const BigQueryAuthSchema = z.discriminatedUnion('type', [
  BigQueryAdcAuthSchema,
  BigQueryWifAuthSchema,
  BigQueryServiceAccountAuthSchema,
]);

export type BigQueryAuth = z.infer<typeof BigQueryAuthSchema>;
