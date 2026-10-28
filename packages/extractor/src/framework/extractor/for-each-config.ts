import { z } from 'zod';

import { SpecNameSchema } from '../core/index.js';
import { PredicateSchema } from './predicate.js';

const ForEachBindingSchema = z
  .object({
    field: z.string(),
    input: z.string(),
    source: z.enum(['input', 'output']).optional().default('output'),
  })
  .strict();

const ForEachConcurrencySchema = z.number().int().min(1).max(64).default(1).optional();

/**
 * Predicates filter the parent record set in the for_each cache **before**
 * iterating. Children are only fetched for parents that pass — highest
 * leverage when the parent set is large and the child fan-out is expensive.
 * Field references the parent resource's output; cross-resource validation
 * happens at runtime since the parent schema is not in scope here.
 */
const ForEachWhereSchema = z.array(PredicateSchema).min(1).max(32).optional();

const LegacyForEachConfigSchema = z
  .object({
    resource: SpecNameSchema,
    field: z.string(),
    input: z.string(),
    concurrency: ForEachConcurrencySchema,
    where: ForEachWhereSchema,
  })
  .strict();

const BindingForEachConfigSchema = z
  .object({
    resource: SpecNameSchema,
    bindings: z.array(ForEachBindingSchema).min(1),
    concurrency: ForEachConcurrencySchema,
    where: ForEachWhereSchema,
  })
  .strict();

export const ForEachConfigSchema = z.union([LegacyForEachConfigSchema, BindingForEachConfigSchema]);

export type ForEachConfig = z.infer<typeof ForEachConfigSchema>;
