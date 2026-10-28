import { z } from 'zod';

/** Reject warehouse resources that would otherwise create a destination without columns. */
export function validateNonEmptyColumns(
  columns: Record<string, unknown>,
  resourceName: string,
  path: string[],
  ctx: z.RefinementCtx
): void {
  if (Object.keys(columns).length > 0) return;

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: `Resource "${resourceName}" declares no columns; add at least one field under "${path.join('.')}"`,
    path,
  });
}
