import { isObject } from '@bobsled-inc/protocol';
import { z } from 'zod';

import { SpecNameSchema } from '../core/index.js';

import { FileLimitsSchema, PathTraversalRefine, isFileStorageResource } from './file-resource.js';

/** A copy moves each file as it is, so it takes no setting that changes how a file is read. */
const refusedOnCopy = (setting: string, reason: string) =>
  z.never({ error: `${setting} is not allowed for a copy: ${reason}` }).optional();

// A copy has no columns. `output` stays an empty record, not absent, so code that reads the
// output of any Resource keeps working.
const CopyOutputSchema = z
  .record(z.string(), z.never({ error: 'output is not allowed for a copy: it has no columns' }))
  .default({});

const CopyFileSourceConfigSchema = z
  .object({
    kind: z.literal('copy'),
    path: z.string().min(1),
    format: refusedOnCopy('source.format', 'it moves files as they are'),
    compression: refusedOnCopy('source.compression', 'it moves files as they are'),
    options: refusedOnCopy('source.options', 'it moves files as they are'),
    include_filename: refusedOnCopy('source.include_filename', 'it moves files as they are'),
    include_file_metadata: refusedOnCopy(
      'source.include_file_metadata',
      'it moves files as they are'
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    PathTraversalRefine(value.path, ctx);
  });

/** Files with a `last_modified` this far behind the newest file copied are still taken. */
export const COPY_DEFAULT_LOOKBACK_SECONDS = 3600;

const CopyReplicationSchema = z
  .object({
    method: z.literal('incremental_append', {
      error: 'replication.method must be incremental_append for a copy',
    }),
    cursor: z
      .object(
        {
          field: z.literal('last_modified', {
            error: 'replication.cursor.field must be last_modified for a copy',
          }),
          lookback_seconds: z
            .number()
            .int()
            .nonnegative('replication.cursor.lookback_seconds must be zero or more')
            .optional(),
        },
        { error: 'replication.cursor is required for a copy' }
      )
      .strict(),
  })
  .strict();

/** Whether a parsed Resource document asks for a copy (`source.kind: copy`). */
export const isCopyResourceDocument = (input: unknown): boolean =>
  isObject(input) && isObject(input['source']) && input['source']['kind'] === 'copy';

/**
 * Fails a Resource that is not a copy before the copy rules run, and stops there. The issue is a
 * custom one at path `type`, which the error formatter reads as "wrong variant", so it shows
 * the errors of the Resource kind the file was written for, not this one's.
 */
const CopyGateSchema = z.any().refine(isCopyResourceDocument, {
  abort: true,
  path: ['type'],
  error: 'not a copy Resource',
});

/** A file Resource that copies each new file to a file destination without reading it. */
const FileCopyResourceObjectSchema = z
  .object({
    spec_version: z.literal('1'),
    type: z.literal('resource'),
    name: SpecNameSchema,
    integration: SpecNameSchema.optional(),
    target: SpecNameSchema.optional(),
    description: z.string().default(''),
    input: z.record(z.string(), z.never()).default({}),
    api: z.never().optional(),
    tool: z.never().optional(),
    billing: z.never().optional(),
    source: CopyFileSourceConfigSchema,
    replication: CopyReplicationSchema,
    limits: FileLimitsSchema.optional(),
    extract: z
      .object({ incremental: z.never().optional(), table: z.never().optional() })
      .strict()
      .default({}),
    output: CopyOutputSchema,
  })
  .strict();

export const FileCopyResourceSpecSchema = CopyGateSchema.pipe(FileCopyResourceObjectSchema);

export type FileCopyResourceSpec = z.infer<typeof FileCopyResourceSpecSchema>;

/** A file Resource that copies files as they are (`source.kind: copy`). */
export function isFileCopyResource(resource: unknown): resource is FileCopyResourceSpec {
  return isFileStorageResource(resource) && (resource.source as { kind?: string }).kind === 'copy';
}
