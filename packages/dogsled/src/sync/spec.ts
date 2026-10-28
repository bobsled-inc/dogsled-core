import { readFileSync, statSync } from 'node:fs';

import {
  duplicateIdentityIssues,
  entriesOfKind,
  entryFilePath,
  findNamedEntry,
  ProjectIndexError,
  resolveProjectIndex,
  type ProjectIndex,
} from '@bobsled-inc/project-index';
import {
  CommandError,
  formatSpecValidationMessage,
  isValidSqlIdentifier,
} from '@bobsled-inc/protocol';
import YAML from 'yaml';
import { z } from 'zod';

const HANDLE_RE = /^[a-z][a-z0-9_]*$/;
const MAX_SYNC_SPEC_SIZE = 1_024 * 1_024;

const DEFAULT_SYNC_OPTIONS = {
  state_backend: 'local' as const,
  page_size: 500,
  on_record_error: 'skip' as const,
  consecutive_failure_threshold: 10,
  lease_ttl_seconds: 900,
  checkpoint_interval_records: 100,
};

const CursorSchema = z.object({
  field: z.string().refine(isValidSqlIdentifier, 'cursor field must be a SQL identifier'),
  tie_breaker_fields: z
    .array(z.string().refine(isValidSqlIdentifier, 'tie breaker must be a SQL identifier'))
    .default([]),
  initial_value: z.union([z.string(), z.number(), z.boolean()]),
});

export const SyncSpecInputSchema = z.object({
  spec_version: z.literal('1'),
  type: z.literal('sync'),
  name: z.string().regex(HANDLE_RE).max(64),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  schedule: z.string().trim().min(1).default('manual'),
  graph_id: z.string().trim().min(1).optional(),
  source: z.object({
    type: z.literal('projection'),
    connection: z.string().regex(HANDLE_RE),
    projection_ref: z
      .string()
      .refine(isValidSqlIdentifier, 'projection_ref must be a dot-qualified SQL identifier'),
    cursor: CursorSchema,
    filters: z
      .record(
        z.string().refine(isValidSqlIdentifier, 'filter key must be a SQL identifier'),
        z.union([z.string(), z.number(), z.boolean(), z.null()])
      )
      .default({}),
  }),
  target: z.object({
    action: z.string().includes('/'),
    destination_connection: z.string().regex(HANDLE_RE).optional(),
    entity_key: z.object({
      fields: z.array(z.string().refine(isValidSqlIdentifier)).min(1),
    }),
    input_mapping: z
      .record(z.string(), z.string().refine(isValidSqlIdentifier))
      .refine((mapping) => Object.keys(mapping).length > 0, {
        message: 'input_mapping must not be empty when provided',
      })
      .optional(),
  }),
  options: z
    .object({
      state_backend: z.literal('local').default('local'),
      checkpoint_interval_records: z.number().int().min(1).optional(),
      page_size: z.number().int().min(1).max(10_000).default(500),
      on_record_error: z.enum(['skip', 'fail']).default('skip'),
      consecutive_failure_threshold: z.number().int().min(1).default(10),
      lease_ttl_seconds: z.number().int().min(60).max(3600).default(900),
    })
    .optional(),
});

export const SyncSpecSchema = SyncSpecInputSchema.superRefine((spec, ctx) => {
  const options = { ...DEFAULT_SYNC_OPTIONS, ...spec.options };
  if (options.checkpoint_interval_records > options.page_size) {
    ctx.addIssue({
      code: 'custom',
      path: ['options', 'checkpoint_interval_records'],
      message: 'checkpoint_interval_records must be less than or equal to page_size',
    });
  }
}).transform((spec) => ({
  ...spec,
  options: { ...DEFAULT_SYNC_OPTIONS, ...spec.options },
}));

export type SyncSpec = z.infer<typeof SyncSpecSchema>;

export interface LoadedSyncSpec {
  name: string;
  filePath: string;
  spec: SyncSpec;
}

export function parseSyncSpecDocument(raw: unknown, filePath: string): SyncSpec {
  const parsed = SyncSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CommandError(
      formatSpecValidationMessage('sync', filePath, parsed.error, {
        schema: SyncSpecSchema,
      }),
      2
    );
  }
  return parsed.data;
}

export function parseSyncSpecFile(filePath: string): SyncSpec {
  const stats = statSync(filePath);
  if (stats.size > MAX_SYNC_SPEC_SIZE) {
    throw new CommandError(`Sync spec ${filePath} exceeds maximum size of 1 MB`, 2);
  }
  return parseSyncSpecDocument(YAML.parse(readFileSync(filePath, 'utf-8')) as unknown, filePath);
}

/**
 * Every sync the project declares (`type: sync`, wherever the file lives),
 * identified by its `name` and sorted by it. Two syncs sharing a name are an
 * error naming both files.
 */
export function listSyncSpecs(projectRoot: string, index?: ProjectIndex): LoadedSyncSpec[] {
  const project = resolveProjectIndex(projectRoot, index);
  const loaded = entriesOfKind(project, 'sync').map((entry) => {
    const filePath = entryFilePath(project, entry);
    const spec = parseSyncSpecDocument(entry.document, filePath);
    return { name: spec.name, filePath, spec, path: entry.path };
  });
  const duplicates = duplicateIdentityIssues(loaded, (sync) => sync.name, 'sync name');
  if (duplicates.length > 0) throw new ProjectIndexError(duplicates);
  return loaded
    .map(({ name, filePath, spec }) => ({ name, filePath, spec }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The sync whose declared `name` is `name`, wherever its file lives. Only that
 * file is validated; two files declaring the name are an error naming both.
 */
export function loadSyncSpec(
  projectRoot: string,
  name: string,
  index?: ProjectIndex
): LoadedSyncSpec {
  if (!HANDLE_RE.test(name)) {
    throw new CommandError(`Invalid sync name "${name}".`, 2);
  }
  const project = resolveProjectIndex(projectRoot, index);
  const entry = findNamedEntry(project, 'sync', name);
  if (!entry) {
    throw new CommandError(`Sync "${name}" not found. Declare it in a file with type: sync.`, 2);
  }
  const filePath = entryFilePath(project, entry);
  return { name, filePath, spec: parseSyncSpecDocument(entry.document, filePath) };
}
