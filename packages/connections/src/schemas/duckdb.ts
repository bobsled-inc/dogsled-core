/**
 * DuckDB integration schema — connection + auth.
 *
 * DuckDB is embedded — there are no credentials. The "auth variant" selects
 * between a file-backed persistent database and a transient in-memory one.
 *
 * Auth variants:
 *   - `file`    — file-backed DB (default for Model Spec runs that need persistence)
 *   - `memory`  — in-memory DB (default for tests and scratch work)
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export const DuckDbConnectionSchema = z
  .object({
    schema: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Optional default schema (Model Spec models can override at the model level)'),
  })
  .strict();

export type DuckDbConnection = z.infer<typeof DuckDbConnectionSchema>;

// ---------------------------------------------------------------------------
// Auth variants
// ---------------------------------------------------------------------------

export const DuckDbFileAuthSchema = z
  .object({
    type: z.literal('file'),
    path: z
      .string()
      .trim()
      .min(1)
      .describe('Filesystem path to the DuckDB database file (created if it does not exist)'),
    read_only: z.boolean().optional().default(false),
  })
  .strict();

export const DuckDbMemoryAuthSchema = z
  .object({
    type: z.literal('memory'),
  })
  .strict();

export const DuckDbAuthSchema = z.discriminatedUnion('type', [
  DuckDbFileAuthSchema,
  DuckDbMemoryAuthSchema,
]);

export type DuckDbAuth = z.infer<typeof DuckDbAuthSchema>;
