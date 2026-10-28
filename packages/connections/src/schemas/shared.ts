/**
 * Shared validators used by every per-dialect integration schema.
 *
 * These mirror the conventions already established by the extractor and loader
 * packages (snake_case handle, dual-shape `${{ env.VAR }}` / `_env` fields) so
 * that the same `integrations/<handle>.yml` file parses under the shared
 * schema and under the existing canonical one. Both schemas coexist until the
 * consolidation lands.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

/**
 * Integration and target handles. Constrained to snake_case so they can be
 * safely interpolated into filesystem paths (`integrations/<handle>.yml`)
 * without path-traversal risk.
 */
export const snakeCaseHandleSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9_]*$/,
    'Must be snake_case: start with a lowercase letter, only lowercase letters, digits, and underscores.'
  );

// ---------------------------------------------------------------------------
// Dual-shape env-var validation
// ---------------------------------------------------------------------------

/**
 * One pair of fields in the dual-shape pattern: `new` is the preferred
 * `${{ env.VAR }}`-style field; `legacy` is the deprecated `<name>_env`
 * suffixed variant. Exactly one must be set when the pair is required.
 */
export interface DualFieldPair {
  newField: string;
  legacyField: string;
  required: boolean;
}

/**
 * Enforce the "one of new/legacy, never both" dual-shape invariant on a
 * collection of field pairs. Called from inside a Zod `superRefine`.
 */
export function validateDualShapeFields(
  val: Record<string, unknown>,
  ctx: z.RefinementCtx,
  pairs: DualFieldPair[]
): void {
  for (const { newField, legacyField, required } of pairs) {
    const hasNew = val[newField] !== undefined;
    const hasLegacy = val[legacyField] !== undefined;

    if (hasNew && hasLegacy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Cannot set both "${newField}" and "${legacyField}"; use one or the other.`,
        path: [newField],
      });
    }

    if (required && !hasNew && !hasLegacy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Either "${newField}" or "${legacyField}" must be set.`,
        path: [newField],
      });
    }
  }
}
