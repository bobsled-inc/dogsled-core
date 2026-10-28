import { z } from 'zod';

import { databaseIdentifierSchema, identifierMsg, identifierRegex } from './shared-validators.js';

// `publish` + `execution` config schemas and their accessors. Split out of
// `schemas.ts` to keep that file under the source-size budget; re-exported from
// `schemas.ts` so existing importers keep resolving these symbols.

const PublishObjectSchema = z
  .object({
    target: z
      .string()
      .min(1, 'Publish target integration handle is required')
      .regex(identifierRegex, identifierMsg),
    target_schema: z.string().min(1).regex(identifierRegex, identifierMsg).optional(),
    // BigQuery project IDs include hyphens (e.g. `my-project-prod`). The
    // integration context rejects hyphens for every other dialect.
    target_database: databaseIdentifierSchema.optional(),
  })
  .strict();

export const PublishConfigSchema = z.union([
  z.string().min(1, 'Publish integration handle is required').regex(identifierRegex, identifierMsg),
  PublishObjectSchema,
]);

export type PublishConfig = z.infer<typeof PublishConfigSchema>;

export function getPublishTarget(publish: PublishConfig | undefined): string | undefined {
  if (publish === undefined) return undefined;
  return typeof publish === 'string' ? publish : publish.target;
}

export function getPublishTargetSchema(publish: PublishConfig | undefined): string | undefined {
  if (publish === undefined || typeof publish === 'string') return undefined;
  return publish.target_schema;
}

export function getPublishTargetDatabase(publish: PublishConfig | undefined): string | undefined {
  if (publish === undefined || typeof publish === 'string') return undefined;
  return publish.target_database;
}

// `execution` declares the engine a (potentially cross-handle) model runs in.
// `engine` always names an **integration handle**: a `duckdb`-typed integration
// is the local/ephemeral engine (stage every input into one DuckDB file, run the
// join, recompute on read); a warehouse-typed integration runs the join inside
// that warehouse, staging foreign inputs into it. The router derives "DuckDB vs
// warehouse path" from the engine integration's `source_type`. Declaring
// `execution` is the explicit signal that a model mixing sources from multiple
// integration handles is intentional — it relaxes the otherwise-strict
// mixed-handle invariant (see `inferDagIntegrations`). `staging` only applies to
// a warehouse engine: `ephemeral` stages foreign inputs as transient temp tables
// (forces the model to be a table), `persistent` keeps managed staging tables (a
// view is then possible). `publish.target` remains a backward-compatible alias
// for a warehouse engine.
export const ExecutionConfigSchema = z
  .object({
    engine: z.string().min(1, 'execution.engine is required').regex(identifierRegex, identifierMsg),
    staging: z.enum(['ephemeral', 'persistent']).optional(),
  })
  .strict();

export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;

export function getExecutionEngine(execution: ExecutionConfig | undefined): string | undefined {
  return execution?.engine;
}
