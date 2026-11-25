import { z } from 'zod';

import { SpecNameSchema, WarehouseOutputFieldSchema } from '../core/index.js';

import type { FileCopyResourceSpec } from './file-copy-resource.js';

const FileFormatStructuredSchema = z.enum(['csv', 'jsonl', 'parquet']);
const FileCompressionSchema = z.enum(['none', 'gzip']).default('none').optional();

export const FileFormatOptionsSchema = z
  .object({
    header: z.boolean().optional(),
    delimiter: z.string().min(1).max(8).optional(),
    null_values: z.array(z.string()).optional(),
  })
  .strict();

/**
 * Document parser config (document resources only). The format enum mirrors
 * `DocumentFormat` in `@bobsled-inc/document-parsers/types.ts`. CSV stays out of the
 * document branch — it's a structured-source format.
 */
export const DocumentParseConfigSchema = z
  .object({
    formats: z
      .array(z.enum(['pdf', 'docx', 'pptx', 'html', 'md', 'txt', 'eml']))
      .nonempty()
      .default(['pdf', 'docx', 'pptx', 'html', 'md', 'txt', 'eml']),
    max_file_size_mb: z.number().int().positive().max(500).default(100).optional(),
    on_error: z.enum(['record', 'skip', 'fail']).default('record').optional(),
  })
  .strict();

/** Recursive token-aware chunker config (document resources only). */
export const DocumentChunkConfigSchema = z
  .object({
    max_tokens: z.number().int().positive().default(800).optional(),
    overlap_tokens: z.number().int().nonnegative().default(120).optional(),
    tokenizer: z.enum(['cl100k_base', 'o200k_base', 'p50k_base']).default('cl100k_base').optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const max = value.max_tokens ?? 800;
    const overlap = value.overlap_tokens ?? 120;
    if (overlap >= max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'chunk.overlap_tokens must be less than chunk.max_tokens',
        path: ['overlap_tokens'],
      });
    }
  });

/**
 * Accepted so that existing specs stay valid, but nothing reads it: project validation
 * warns about it. A pipeline's `embed` block embeds the chunks of a document resource.
 */
export const EmbeddingConfigSchema = z
  .object({
    role: SpecNameSchema,
    field: z.string().min(1).default('text').optional(),
    as: z.string().min(1).default('text_embedding').optional(),
  })
  .strict();

/**
 * Read-in-place mode + freshness controls — uniform across all resource kinds.
 * Warehouse / API resources currently support `extract` only; `lazy` / `live` are
 * document-only at v1.
 */
export const IngestConfigSchema = z
  .object({
    mode: z.enum(['extract', 'lazy', 'live']).default('extract').optional(),
    freshness: z
      .string()
      .regex(/^\d+(ms|s|m|h|d)$/, 'freshness must be a duration like "1h", "5m", "30s"')
      .optional(),
  })
  .strict();

/**
 * Permission evidence capture. OSS extracts and stores ACL evidence when sources
 * expose it; OSS does NOT enforce. See the Permission Evidence (`__acl`) Contract.
 */
export const PermissionsCaptureSchema = z
  .object({
    capture: z.boolean().default(true).optional(),
    enforcement: z
      .object({
        // Locked to false in OSS. Enforcement belongs to the host application.
        enabled: z.literal(false).default(false).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const PathTraversalRefine = (path: string, ctx: z.RefinementCtx) => {
  if (path.includes('..')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'source.path must not contain ".." path traversal segments',
      path: ['path'],
    });
  }
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'source.path must be provider-relative, not absolute',
      path: ['path'],
    });
  }
};

const StructuredFileSourceConfigSchema = z
  .object({
    kind: z.literal('structured'),
    path: z.string().min(1),
    format: FileFormatStructuredSchema,
    compression: FileCompressionSchema,
    options: FileFormatOptionsSchema.optional(),
    include_filename: z.boolean().default(false).optional(),
    include_file_metadata: z.boolean().default(false).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    PathTraversalRefine(value.path, ctx);
    if (value.compression === 'gzip' && value.format === 'parquet') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'gzip compression is only supported for csv and jsonl file resources',
        path: ['compression'],
      });
    }
  });

const DocumentFileSourceConfigSchema = z
  .object({
    kind: z.literal('document'),
    path: z.string().min(1),
    /**
     * Optional format declaration for the document branch. `format: document` is the
     * user-facing alias for `kind: document` (see Resource Grammar Contract). The
     * preprocess step on FileSourceConfigSchema infers `kind: document` from
     * `format: document` when kind is unset, so callers can use either signal.
     */
    format: z.literal('document').optional(),
    parse: DocumentParseConfigSchema.optional(),
    chunk: DocumentChunkConfigSchema.optional(),
    embedding: EmbeddingConfigSchema.optional(),
    ingest: IngestConfigSchema.optional(),
    permissions: PermissionsCaptureSchema.optional(),
    include_filename: z.boolean().default(false).optional(),
    include_file_metadata: z.boolean().default(false).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    PathTraversalRefine(value.path, ctx);
  });

/**
 * Discriminated union of file source variants. The preprocess infers the discriminator
 * from the `format: document` alias so YAML authors can use either `kind: document` or
 * `format: document`. When neither is set, defaults to `kind: structured` for
 * backwards compatibility with existing csv/jsonl/parquet resources.
 */
export const FileSourceConfigSchema = z.preprocess(
  (input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return input;
    }
    const obj = input as Record<string, unknown>;
    if (obj.kind !== undefined) return obj;
    if (obj.format === 'document') {
      return { ...obj, kind: 'document' };
    }
    return { ...obj, kind: 'structured' };
  },
  z.discriminatedUnion('kind', [StructuredFileSourceConfigSchema, DocumentFileSourceConfigSchema])
);

export const FileReplicationSchema = z
  .object({
    method: z.enum(['full_refresh', 'incremental_append']),
    cursor: z
      .object({
        field: z.enum(['last_modified', 'etag']),
        tie_breaker: z.enum(['path', 'size']).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.method === 'incremental_append' && !value.cursor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'replication.cursor is required for incremental_append file resources',
        path: ['cursor'],
      });
    }
  });

export const FileLimitsSchema = z
  .object({
    max_file_size_bytes: z.number().int().positive().default(5_368_709_120).optional(),
    max_files_per_run: z.number().int().positive().default(10_000).optional(),
  })
  .strict();

export const FileResourceSpecSchema = z
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
    source: FileSourceConfigSchema,
    replication: FileReplicationSchema,
    limits: FileLimitsSchema.optional(),
    schema_contract: z.enum(['evolve', 'freeze']).default('evolve').optional(),
    extract: z
      .object({
        incremental: z.never().optional(),
        table: z
          .object({
            primary_key: z.array(z.string()).optional(),
            trust_tier: z.enum(['bronze', 'silver', 'gold']).optional(),
            load_strategy: z.enum(['append', 'merge', 'full_refresh']).optional(),
            partition_by: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({}),
    output: z.record(z.string(), WarehouseOutputFieldSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    const metadataFields: Record<string, string> = {
      _file_path: 'string',
      _file_uri: 'string',
      _file_modified_at: 'timestamp',
      _file_etag: 'string',
      _file_size: 'integer',
    };

    for (const [field, expectedType] of Object.entries(metadataFields)) {
      const actual = value.output[field]?.type;
      if (actual && actual !== expectedType) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} output must be type "${expectedType}"`,
          path: ['output', field, 'type'],
        });
      }
    }
  });

export type FileSourceKind = 'structured' | 'document';
export type FileSourceConfig = z.infer<typeof FileSourceConfigSchema>;
export type DocumentFileSourceConfig = z.infer<typeof DocumentFileSourceConfigSchema>;
export type StructuredFileSourceConfig = z.infer<typeof StructuredFileSourceConfigSchema>;
export type DocumentParseConfig = z.infer<typeof DocumentParseConfigSchema>;
export type DocumentChunkConfig = z.infer<typeof DocumentChunkConfigSchema>;
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;
export type IngestConfig = z.infer<typeof IngestConfigSchema>;
export type PermissionsCapture = z.infer<typeof PermissionsCaptureSchema>;
export type FileResourceSpec = z.infer<typeof FileResourceSpecSchema>;

export function isFileStorageResource(
  resource: unknown
): resource is FileResourceSpec | FileCopyResourceSpec {
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
    return false;
  }
  const candidate = resource as { source?: unknown };
  if (
    !candidate.source ||
    typeof candidate.source !== 'object' ||
    Array.isArray(candidate.source)
  ) {
    return false;
  }
  const source = candidate.source as Record<string, unknown>;
  // Either the `format` enum (csv/jsonl/parquet/document) or `kind` discriminator
  // is enough; a resource with `path` and a document or copy marker is still a file
  // storage resource even if `format` is absent.
  return (
    'path' in source && ('format' in source || source.kind === 'document' || source.kind === 'copy')
  );
}

export function isDocumentFileSource(source: FileSourceConfig): source is DocumentFileSourceConfig {
  // Treat the user-facing `format: document` alias as document at the runtime layer too
  // so test fixtures and other callers that bypass the schema preprocess still classify
  // correctly, per the Resource Grammar Contract.
  if (source.kind === 'document') return true;
  const probe = source as { format?: string };
  return probe.format === 'document';
}

export function isStructuredFileSource(
  source: FileSourceConfig
): source is StructuredFileSourceConfig {
  // Treat absence of the `kind` discriminator as `structured` (back-compat with raw
  // FileResourceSpec casts in older tests / library callers that bypass the schema
  // preprocess step). The schema itself always materializes a kind via preprocess.
  if (source.kind === 'structured') return true;
  if (source.kind === 'document') return false;
  const probe = source as { format?: string };
  return probe.format !== 'document';
}
