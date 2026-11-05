/**
 * Zod schema for extractor state file.
 *
 * Persists incremental cursors for resume-from-checkpoint.
 */

import { z } from 'zod';

import { CursorTypeSchema } from '../framework/core/index.js';

const StreamStateSchema = z
  .object({
    cursor_field: z.string().optional(),
    cursor_type: CursorTypeSchema.optional(),
    cursor_value: z.string().optional(),
    last_run_at: z.string(),
    record_count: z.number(),
    files: z
      .record(
        z.string(),
        z
          .object({
            last_modified: z.string().optional(),
            etag: z.string().optional(),
            size: z.number().optional(),
            // Document Resources record the parsed version to skip unchanged content.
            document_version_id: z.string().optional(),
          })
          .strict()
      )
      .optional(),
  })
  .strict();

export const ExtractorStateSchema = z
  .object({
    streams: z.record(z.string(), StreamStateSchema),
  })
  .strict();
