/**
 * `targets/<handle>.yml` file schema.
 *
 * A target is a thin load-intent wrapper that references an integration by
 * handle and optionally narrows it with overrides (role, database, schema,
 * warehouse, catalog) and defaults (load_strategy, buffer_size, …).
 *
 * Targets never carry credentials inline — they always reference an
 * integration file. Capability enforcement (is the referenced integration
 * warehouse-shaped?) happens at resolve time, not in this schema.
 */

import { SCHEMA_BEHAVIORS } from '@bobsled-inc/protocol';
import { z } from 'zod';

import { snakeCaseHandleSchema } from './shared.js';

const OverridesSchema = z
  .object({
    role: z.string().trim().min(1).optional(),
    database: z.string().trim().min(1).optional(),
    schema: z.string().trim().min(1).optional(),
    warehouse: z.string().trim().min(1).optional(),
    catalog: z.string().trim().min(1).optional(),
  })
  .strict()
  .optional();

const DefaultsSchema = z
  .object({
    load_strategy: z.enum(['append', 'merge', 'full_refresh']).optional(),
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
    name: snakeCaseHandleSchema,
    integration: snakeCaseHandleSchema,
    overrides: OverridesSchema,
    defaults: DefaultsSchema,
  })
  .strict();

export type TargetFile = z.infer<typeof TargetFileSchema>;
export type TargetOverrides = z.infer<typeof OverridesSchema>;
export type TargetDefaults = z.infer<typeof DefaultsSchema>;
