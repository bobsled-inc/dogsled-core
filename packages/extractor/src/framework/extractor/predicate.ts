import { z } from 'zod';

import { OutputFieldSchema } from '../core/index.js';

/**
 * Shared predicate vocabulary used by `extract.where`, `extract.stop_when`, and
 * `extract.for_each.where`. A predicate names an output field plus one operator
 * with a scalar (or array, for `in`) value. Values may be ISO 8601 timestamps
 * or relative durations like `-6mo`, `1d`, `2h` when the target field is a
 * timestamp.
 *
 * Predicates are author-declared in YAML with literal values, distinct from
 * `record_filters` which bind operator values to caller-supplied inputs.
 */

const PREDICATE_SCALAR_TYPES: ReadonlySet<string> = new Set([
  'string',
  'integer',
  'number',
  'boolean',
  'timestamp',
]);

const ScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const ScalarArraySchema = z.array(ScalarSchema).min(1);

const FieldOnly = z.object({ field: z.string().min(1) });

const PredicateEq = FieldOnly.extend({ eq: ScalarSchema }).strict();
const PredicateNeq = FieldOnly.extend({ neq: ScalarSchema }).strict();
const PredicateGt = FieldOnly.extend({ gt: ScalarSchema }).strict();
const PredicateGte = FieldOnly.extend({ gte: ScalarSchema }).strict();
const PredicateLt = FieldOnly.extend({ lt: ScalarSchema }).strict();
const PredicateLte = FieldOnly.extend({ lte: ScalarSchema }).strict();
const PredicateIn = FieldOnly.extend({ in: ScalarArraySchema }).strict();
const PredicateContains = FieldOnly.extend({ contains: z.string().min(1) }).strict();

export const PredicateSchema = z.union([
  PredicateEq,
  PredicateNeq,
  PredicateGt,
  PredicateGte,
  PredicateLt,
  PredicateLte,
  PredicateIn,
  PredicateContains,
]);

export type Predicate = z.infer<typeof PredicateSchema>;

/** Operators that may legitimately accept a relative duration string when the field is a timestamp. */
const RELATIVE_DURATION_OPERATORS: ReadonlySet<string> = new Set(['gt', 'gte', 'lt', 'lte']);

const RELATIVE_DURATION_RE = /^-?\d+(m|h|d|w|mo|y)$/;

/**
 * Identify the operator key on a predicate union variant. The union has a
 * single non-`field` key per variant — return it so downstream consumers can
 * dispatch without re-typing.
 */
export function predicateOperator(predicate: Predicate): string {
  for (const key of Object.keys(predicate)) {
    if (key !== 'field') return key;
  }
  return 'eq';
}

export function isRelativeDurationLiteral(value: unknown): value is string {
  return typeof value === 'string' && RELATIVE_DURATION_RE.test(value);
}

function addIssue(ctx: z.RefinementCtx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
}

/**
 * Validate a list of predicates against a resource's output schema. Used by
 * `extract.where` (and `extract.stop_when`, which carries one inline predicate).
 *
 * Rules:
 *   1. `field` must reference an output field of the resource
 *   2. Output field must be a scalar type (string, integer, number, boolean, timestamp)
 *   3. Relative-duration values (e.g. `-6mo`) only allowed on timestamp fields with comparison operators
 */
export function validatePredicatesAgainstOutput(
  predicates: ReadonlyArray<Predicate>,
  output: Record<string, z.infer<typeof OutputFieldSchema>>,
  ctx: z.RefinementCtx,
  basePath: (string | number)[]
): void {
  predicates.forEach((predicate, index) => {
    const field = predicate.field;
    const outputField = output[field];
    const fieldPath = [...basePath, index, 'field'];
    if (!outputField) {
      addIssue(ctx, fieldPath, `predicate field "${field}" must reference an output field`);
      return;
    }
    if (!PREDICATE_SCALAR_TYPES.has(outputField.type)) {
      addIssue(
        ctx,
        fieldPath,
        `predicate field "${field}" must reference a scalar output field ` +
          `(string, integer, number, boolean, timestamp) but got "${outputField.type}"`
      );
      return;
    }

    const operator = predicateOperator(predicate);
    const rawValue = (predicate as Record<string, unknown>)[operator];

    if (operator === 'contains' && outputField.type !== 'string') {
      addIssue(
        ctx,
        [...basePath, index, operator],
        `predicate "contains" requires a string output field but "${field}" is "${outputField.type}"`
      );
      return;
    }

    if (operator === 'in') {
      if (!Array.isArray(rawValue)) {
        addIssue(ctx, [...basePath, index, operator], 'predicate "in" requires an array value');
      }
      return;
    }

    if (isRelativeDurationLiteral(rawValue)) {
      if (outputField.type !== 'timestamp') {
        addIssue(
          ctx,
          [...basePath, index, operator],
          `predicate value "${rawValue}" is a relative duration; only allowed on timestamp output fields ` +
            `("${field}" is "${outputField.type}")`
        );
      } else if (!RELATIVE_DURATION_OPERATORS.has(operator)) {
        addIssue(
          ctx,
          [...basePath, index, operator],
          `predicate value "${rawValue}" is a relative duration; only allowed with comparison operators ` +
            `(gt/gte/lt/lte)`
        );
      }
    }
  });
}
