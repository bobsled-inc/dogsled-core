/**
 * `mention_resolution` chunker-config-change migration handler.
 *
 * When a chunker config changes — `chunker_config_hash` or `CHUNKER_VERSION`
 * drift in the chunker — the regenerated `chunk_id`s no longer match
 * existing `__document_mentions.chunk_id` values, orphaning every mention.
 *
 * This helper:
 *  1. Marks orphaned mentions (rows whose chunk_id is absent from the new
 *     chunks table) as `superseded_at = now()`.
 *  2. Returns the count of orphans so the worker can emit it as a structured
 *     log event.
 *
 * The SQL re-extract path is a follow-up; this is currently a callable helper
 * for batch jobs or future workers.
 */

import { CommandError } from '@bobsled-inc/protocol';
import { z } from 'zod';

import { assertSafeIdentifier } from '../candidate-retrieval/sql-utils.js';

/**
 * Local mirror of `TaskHandlerContext` from
 * an owning package's worker/task dispatcher.
 * The helper is kept structural so this leaf module can be used without
 * importing from the caller package and without inverting package
 * dependencies.
 */
export interface TaskHandlerContext {
  task: {
    task_id: string;
    task_type: string;
    payload: unknown;
  };
  deadline: Date;
}

export const ChunkerConfigChangePayloadSchema = z
  .object({
    reason: z.literal('chunker_config_changed'),
    old_chunks_table: z.string().min(1),
    new_chunks_table: z.string().min(1),
    mentions_table: z.string().min(1),
    /** Captured for audit. */
    previous_chunker_config_hash: z.string().optional(),
    current_chunker_config_hash: z.string().optional(),
    previous_chunker_version: z.string().optional(),
    current_chunker_version: z.string().optional(),
  })
  .strict();

export type ChunkerConfigChangePayload = z.infer<typeof ChunkerConfigChangePayloadSchema>;

/**
 * Build the SQL that marks orphaned mentions superseded. Pure function so
 * tests can assert the shape without running a warehouse.
 *
 * `assertSafeIdentifier` is the shared utility from
 * `../candidate-retrieval/sql-utils.js` — keeping a single source of
 * truth for the identifier-safety pattern.
 */
export function buildSupersedeOrphansSql(payload: ChunkerConfigChangePayload): string {
  const mentions = assertSafeIdentifier(payload.mentions_table, 'mentions_table');
  const newChunks = assertSafeIdentifier(payload.new_chunks_table, 'new_chunks_table');
  return `UPDATE ${mentions}
  SET superseded_at = CURRENT_TIMESTAMP
  WHERE superseded_at IS NULL
    AND chunk_id NOT IN (SELECT chunk_id FROM ${newChunks})`;
}

export interface ChunkerConfigChangeRunner {
  /** Execute parameter-less SQL and return the number of affected rows. */
  exec: (sql: string) => Promise<{ rowCount: number }>;
}

/**
 * Build a helper for the `mention_resolution` orphan sweep. Callers can execute
 * this in batch jobs or wire it to a future worker runtime.
 */
export function createChunkerConfigChangeHandler(runner: ChunkerConfigChangeRunner) {
  return async (ctx: TaskHandlerContext): Promise<number> => {
    const parsed = ChunkerConfigChangePayloadSchema.safeParse(ctx.task.payload);
    if (!parsed.success) {
      throw new CommandError(
        `mention_resolution payload failed validation: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
        2
      );
    }
    const sql = buildSupersedeOrphansSql(parsed.data);
    const result = await runner.exec(sql);
    return result.rowCount;
  };
}
