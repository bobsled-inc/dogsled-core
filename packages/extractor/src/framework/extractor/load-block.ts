/**
 * Load-block schemas extracted from resource.ts to keep that file under the
 * monorepo's per-file size budget. These describe the shape of `load:` blocks
 * that appear in:
 *   - `extractor.yml`'s `default_load:` (carries integration + overrides + defaults)
 *   - `--load-file` payloads (same shape as default_load)
 *   - V2 resource `load:` blocks (overrides + defaults only — no integration)
 */

import { z } from 'zod';

import { LOAD_STRATEGIES, SCHEMA_BEHAVIORS } from '@bobsled-inc/protocol';

import { SpecNameSchema } from '../core/shared.js';

export const LoadOverridesSchema = z
  .object({
    role: z.string().trim().min(1).optional(),
    database: z.string().trim().min(1).optional(),
    schema: z.string().trim().min(1).optional(),
    warehouse: z.string().trim().min(1).optional(),
  })
  .strict();

export const LoadDefaultsSchema = z
  .object({
    load_strategy: z.enum(LOAD_STRATEGIES).optional(),
    schema_behavior: z.enum(SCHEMA_BEHAVIORS).optional(),
    target_schema_template: z.string().optional(),
    buffer_size: z.coerce.number().int().positive().optional(),
  })
  .strict();

/**
 * The `load:` block in `extractor.yml`'s `default_load:` or in a `--load-file`
 * payload. Carries the destination integration plus optional overrides/defaults.
 */
export const LoadBlockSchema = z
  .object({
    integration: SpecNameSchema,
    overrides: LoadOverridesSchema.optional(),
    defaults: LoadDefaultsSchema.optional(),
  })
  .strict();

/**
 * The `load:` block on a V2 resource. A resource isn't tied to a destination
 * (the same data can land in many warehouses), so this block carries only
 * defaults and overrides — never the destination integration. The destination
 * binding comes from the pipeline (bobsled.yml), CLI `--load-integration`, or
 * `extractor.yml` `default_load.integration`.
 */
export const ResourceLoadBlockSchema = z
  .object({
    overrides: LoadOverridesSchema.optional(),
    defaults: LoadDefaultsSchema.optional(),
  })
  .strict();

export type LoadBlock = z.infer<typeof LoadBlockSchema>;
export type ResourceLoadBlock = z.infer<typeof ResourceLoadBlockSchema>;
