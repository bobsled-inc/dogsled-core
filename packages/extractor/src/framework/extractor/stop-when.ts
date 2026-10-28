import { z } from 'zod';

import { OutputFieldSchema } from '../core/index.js';
import { validatePredicatesAgainstOutput, type Predicate } from './predicate.js';

/**
 * `extract.stop_when` — single record predicate plus a required-sort guard.
 *
 * After each page is mapped + filtered, if every emitted record on the page
 * fails the predicate, pagination halts. The `requires_sort` declaration
 * forces the resource author to acknowledge that the API is sorted in the
 * direction that makes the early-halt safe — otherwise users would
 * accidentally terminate on page 1 of an ascending feed.
 *
 * Validation requires the resource declare a matching sort directive in
 * `api.query_params` or `api.request_body` (cross-checked at parse time).
 */
const SortDirectionSchema = z.enum(['asc', 'desc']);

const RequiresSortSchema = z
  .object({
    field: z.string().min(1),
    direction: SortDirectionSchema,
  })
  .strict();

export const StopWhenSchema = z
  .object({
    field: z.string().min(1),
    eq: z.union([z.string(), z.number(), z.boolean()]).optional(),
    neq: z.union([z.string(), z.number(), z.boolean()]).optional(),
    gt: z.union([z.string(), z.number(), z.boolean()]).optional(),
    gte: z.union([z.string(), z.number(), z.boolean()]).optional(),
    lt: z.union([z.string(), z.number(), z.boolean()]).optional(),
    lte: z.union([z.string(), z.number(), z.boolean()]).optional(),
    in: z
      .array(z.union([z.string(), z.number(), z.boolean()]))
      .min(1)
      .optional(),
    contains: z.string().min(1).optional(),
    requires_sort: RequiresSortSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const operatorKeys = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains'] as const;
    const present = operatorKeys.filter(
      (key) => (value as Record<string, unknown>)[key] !== undefined
    );
    if (present.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'stop_when requires exactly one of: eq, neq, gt, gte, lt, lte, in, contains',
        path: [],
      });
    } else if (present.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `stop_when accepts exactly one operator but multiple were declared: ${present.join(', ')}`,
        path: [present[1]!],
      });
    }
  });

export type StopWhen = z.infer<typeof StopWhenSchema>;

/** Pull the operator + value out of a StopWhen — for runtime evaluation. */
export function stopWhenAsPredicate(stop: StopWhen): Predicate {
  const keys = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains'] as const;
  for (const op of keys) {
    const value = (stop as Record<string, unknown>)[op];
    if (value !== undefined) {
      return { field: stop.field, [op]: value } as Predicate;
    }
  }
  // Schema refinement guarantees at least one operator is present, but the
  // type-narrowed switch above doesn't tell TypeScript that — fall through
  // with eq:'' so the type checker stays happy. This branch is unreachable.
  return { field: stop.field, eq: '' };
}

/** Walks api.query_params and api.request_body looking for a string mention of `field`. */
function isFieldReferenced(haystack: unknown, field: string): boolean {
  if (typeof haystack === 'string') {
    return haystack.includes(field);
  }
  if (Array.isArray(haystack)) {
    return haystack.some((entry) => isFieldReferenced(entry, field));
  }
  if (haystack && typeof haystack === 'object') {
    for (const [key, value] of Object.entries(haystack as Record<string, unknown>)) {
      if (key.includes(field)) return true;
      if (isFieldReferenced(value, field)) return true;
    }
  }
  return false;
}

export function validateExtractStopWhen(
  value: {
    api?: {
      query_params?: Record<string, unknown>;
      request_body?: unknown;
    };
    output: Record<string, z.infer<typeof OutputFieldSchema>>;
    extract: { stop_when?: StopWhen };
  },
  ctx: z.RefinementCtx
): void {
  const stop = value.extract.stop_when;
  if (!stop) return;

  validatePredicatesAgainstOutput([stopWhenAsPredicate(stop)], value.output, ctx, [
    'extract',
    'stop_when',
  ]);

  const requiresSort = stop.requires_sort;
  const sortFieldOutput = value.output[requiresSort.field];
  if (!sortFieldOutput) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `stop_when.requires_sort.field "${requiresSort.field}" must reference an output field`,
      path: ['extract', 'stop_when', 'requires_sort', 'field'],
    });
    return;
  }

  // The api block may be absent (MCP resource); in that case we cannot
  // cross-check, but we leave the sort guarantee to the author. For HTTP
  // resources, require a string mention of the sort field somewhere in the
  // request configuration to catch the "no sort declared" footgun.
  if (!value.api) return;

  // The output field name is the column the predicate consumes, but the API
  // request side typically uses the *source* field name (e.g. `updatedAt`
  // when the output column is `updated_at`). Derive the source leaf from
  // `output[field].path` so the cross-check also fires when the integration
  // renames in the output mapping.
  const candidateNames = [requiresSort.field, extractPathLeaf(sortFieldOutput.path)].filter(
    (name): name is string => Boolean(name)
  );
  const referenced = candidateNames.some(
    (name) =>
      isFieldReferenced(value.api?.query_params, name) ||
      isFieldReferenced(value.api?.request_body, name)
  );

  if (!referenced) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `stop_when.requires_sort.field "${requiresSort.field}" was not found in api.query_params ` +
        `or api.request_body — declare a sort directive on the resource so early termination is safe`,
      path: ['extract', 'stop_when', 'requires_sort'],
    });
  }
}

/**
 * Pull the leaf identifier out of an output field's JSONPath. Handles
 * `$.updatedAt`, `$.foo.bar.baz`, and bracketed `$['foo']['bar']` shapes.
 * Returns undefined when the path has no usable leaf (e.g. wildcards).
 */
function extractPathLeaf(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const tokens = path.split(/[.\[\]'"$]/).filter((tok) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(tok));
  return tokens.length > 0 ? tokens[tokens.length - 1] : undefined;
}
