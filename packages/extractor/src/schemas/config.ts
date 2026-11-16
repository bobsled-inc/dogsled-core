/**
 * Zod schema for extractor.yml project configuration.
 */

import { z } from 'zod';

import { SAFE_NAME_RE } from '../framework/core/shared.js';
import { LoadBlockSchema } from '../framework/extractor/resource.js';

export const ExtractorConfigSchema = z
  .object({
    /** Declares the extractor configuration so it can live outside the project root. */
    type: z.literal('extractor_config').optional(),
    integrations_dir: z.string().default('integrations'),
    resources_dir: z.string().default('resources'),
    state_dir: z.string().default('.extractor'),
    output_dir: z.string().default('output'),
    batch_dir: z.string().default('batch'),
    default_batch_format: z.enum(['jsonl', 'parquet']).default('jsonl'),
    default_output: z.enum(['stdout', 'file']).default('stdout'),
    /**
     * Handle of the target file under `targets/<handle>.yml` used when a resource does not
     * specify its own `target:` field. Read by Bobsled Core's orchestrator, not by the extractor itself.
     * Must be a safe snake_case identifier (prevents `..` and `/` traversal when composing
     * the filesystem path).
     */
    default_target: z.string().regex(SAFE_NAME_RE, 'Must be lowercase snake_case').optional(),
    /**
     * Project-level default load block, used when a V2 three-block resource omits its
     * own `load:` block. Same shape as the inline `load:` on a resource.
     * Resolution order: resource.load > default_load > CLI --load-file > error.
     */
    default_load: LoadBlockSchema.optional(),
  })
  .strict();
