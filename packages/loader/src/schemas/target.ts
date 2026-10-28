/**
 * Target file schema — the file shape declared at `<project>/targets/<handle>.yml`.
 *
 * Targets are **thin load-intent wrappers around an integration**:
 *
 *   spec_version, type, name,
 *   integration: <handle>,         # required — no inline connection/auth allowed
 *   overrides:  { ... },           # optional — narrow integration defaults at load time
 *   defaults:   { ... },           # optional — per-load behavior (load_strategy, buffer_size, ...)
 *
 * The referenced integration (in `integrations/<handle>.yml`, from @bobsled-inc/extractor)
 * owns `source_type`, connection, and auth. This keeps credentials in one place and lets
 * the same integration be used for both extract and load (with a role override per side).
 *
 * Capability enforcement — refusing a source-only integration as a target — happens in the
 * resolver/adapter (see `resolveTargetConfig`), not in this schema.
 */

import { z } from 'zod';

import { LOAD_STRATEGIES, SCHEMA_BEHAVIORS } from '@bobsled-inc/protocol';

const snakeCaseHandle = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9_]*$/,
    'Must be snake_case: start with a lowercase letter, only lowercase letters, digits, and underscores.'
  );

const OverridesSchema = z
  .object({
    role: z.string().trim().min(1).optional(),
    database: z.string().trim().min(1).optional(),
    schema: z.string().trim().min(1).optional(),
    warehouse: z.string().trim().min(1).optional(),
  })
  .strict()
  .optional();

const DefaultsSchema = z
  .object({
    load_strategy: z.enum(LOAD_STRATEGIES).optional(),
    schema_behavior: z.enum(SCHEMA_BEHAVIORS).optional(),
    target_schema_template: z.string().optional(),
    buffer_size: z.coerce.number().int().positive().optional(),
  })
  .strict()
  .optional();

export const TargetFileSchema = z
  .object({
    spec_version: z.literal('1'),
    type: z.literal('target'),
    name: snakeCaseHandle,
    integration: snakeCaseHandle,
    overrides: OverridesSchema,
    defaults: DefaultsSchema,
  })
  .strict();

export type TargetFile = z.infer<typeof TargetFileSchema>;
export type TargetOverrides = z.infer<typeof OverridesSchema>;
export type TargetDefaults = z.infer<typeof DefaultsSchema>;
