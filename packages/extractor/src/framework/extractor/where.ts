import { z } from 'zod';

import { OutputFieldSchema } from '../core/index.js';
import { PredicateSchema, validatePredicatesAgainstOutput } from './predicate.js';

/**
 * `extract.where` — record-level predicates applied per page.
 *
 * Resolution at runtime:
 *   1. Predicates with a matching `compile` binding on `resource.query.filters`
 *      are pushed down into request params/body before the call.
 *   2. Predicates without a binding fall through to client-side evaluation:
 *      after `mapResponse` runs, records that fail every remaining predicate
 *      are dropped before emission.
 *
 * Coexists with `record_filters` (applied first). Both can be present on the
 * same resource.
 */
export const WhereSchema = z.array(PredicateSchema).min(1).max(32);

export type WhereClause = z.infer<typeof WhereSchema>;

export function validateExtractWhere(
  value: {
    output: Record<string, z.infer<typeof OutputFieldSchema>>;
    extract: { where?: WhereClause };
  },
  ctx: z.RefinementCtx
): void {
  if (!value.extract.where) return;
  validatePredicatesAgainstOutput(value.extract.where, value.output, ctx, ['extract', 'where']);
}
