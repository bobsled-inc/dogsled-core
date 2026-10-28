import { z } from 'zod';
import { identifierRegex, identifierMsg } from './shared-validators.js';
import { dangerousExprRegex, dangerousExprMsg } from './schemas-shared.js';

/**
 * Bounded fixpoint (`recurse`) and its declarative hierarchy sugar.
 *
 * Recursion lives inside one model rather than as a cycle between models. The
 * DAG stays acyclic, the output schema is still the model's own `columns`, and
 * column lineage still resolves, none of which survive a hand-written SQL body.
 *
 * `prior` names the previous iteration and `source` the row being joined in.
 * Both are scoped to the step, so neither becomes a model reference.
 */
const RECURSE_ALIAS_PRIOR = 'prior';
const RECURSE_ALIAS_SOURCE = 'source';

export const RECURSE_INTERNAL_DEPTH = '__bms_depth';
export const RECURSE_INTERNAL_PATH = '__bms_path';

/** Maximum accepted `max_depth`. Past this a fixpoint is a runaway, not a walk. */
export const RECURSE_MAX_DEPTH_LIMIT = 100;

/**
 * Prefix the compiler reserves for columns and aliases it generates.
 *
 * Recursion adds depth, path and node columns; QUALIFY emulation adds a hoisted
 * predicate column. All of them sit alongside the model's own columns, so a
 * declared name in this namespace produces a duplicate alias that the warehouse
 * either rejects or silently resolves to the wrong one.
 */
export const MODEL_SPEC_RESERVED_COLUMN_PREFIX = '__bms_';

const RecurseStepSchema = z.object({
  source: z.object({
    /** Defaults to the model's own source when omitted. */
    ref: z.string().min(1).optional(),
    join_on: z
      .string()
      .min(1, 'recurse.step.source.join_on is required')
      .refine((v) => !dangerousExprRegex.test(v), dangerousExprMsg),
    where: z
      .string()
      .refine((v) => !dangerousExprRegex.test(v), dangerousExprMsg)
      .optional(),
  }),
  columns: z
    .array(
      z.object({
        name: z.string().min(1).regex(identifierRegex, identifierMsg),
        expr: z
          .string()
          .min(1)
          .refine((v) => !dangerousExprRegex.test(v), dangerousExprMsg),
      })
    )
    .min(1, 'recurse.step.columns is required'),
});

const RecurseCycleSchema = z.object({
  /** Output column whose repetition along a path means a cycle. */
  on: z.string().min(1).regex(identifierRegex, identifierMsg),
  /** Optional boolean output column flagging the row that closed the cycle. */
  emit: z.string().min(1).regex(identifierRegex, identifierMsg).optional(),
  /**
   * Delimiter for the carried path. The path is text rather than an array
   * because array containment has no portable spelling across the targets;
   * keys must therefore not contain this character.
   */
  delimiter: z.string().length(1).default('/'),
});

export const RecurseSpecSchema = z.object({
  max_depth: z.number().int().positive().max(RECURSE_MAX_DEPTH_LIMIT),
  step: RecurseStepSchema,
  cycle: RecurseCycleSchema.optional(),
});

export type RecurseSpec = z.infer<typeof RecurseSpecSchema>;

export const HierarchySpecSchema = z.object({
  /** Column on the child row pointing at its parent. */
  parent_key: z.string().min(1).regex(identifierRegex, identifierMsg),
  /** Column identifying the row itself. */
  child_key: z.string().min(1).regex(identifierRegex, identifierMsg),
  max_depth: z.number().int().positive().max(RECURSE_MAX_DEPTH_LIMIT),
  /**
   * `roots` walks down from rows with no parent. `all_nodes` starts a walk at
   * every row, which is what a cycle audit needs: a cycle has no root, so
   * root-seeded walks never reach an isolated one and report only the entry
   * row of a reachable one.
   */
  seed: z.enum(['roots', 'all_nodes']).default('roots'),
  emit: z
    .object({
      root: z.string().min(1).regex(identifierRegex, identifierMsg).optional(),
      depth: z.string().min(1).regex(identifierRegex, identifierMsg).optional(),
      path: z.string().min(1).regex(identifierRegex, identifierMsg).optional(),
      cycle: z.string().min(1).regex(identifierRegex, identifierMsg).optional(),
    })
    .optional(),
  path_delimiter: z.string().length(1).default('/'),
});

export type HierarchySpec = z.infer<typeof HierarchySpecSchema>;

export { RECURSE_ALIAS_PRIOR, RECURSE_ALIAS_SOURCE };
