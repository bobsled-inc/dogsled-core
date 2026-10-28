import { z } from 'zod';

/** Reject expressions that contain SQL statement separators or dangerous keywords. */
const dangerousExprStartRegex =
  /^\s*(DROP|ALTER|CREATE|TRUNCATE|INSERT|UPDATE|DELETE|REPLACE\s+INTO|MERGE|GRANT|REVOKE|EXEC|EXECUTE|CALL|DECLARE|PRAGMA|COPY|LOAD|UNLOAD)\b/i;
const dangerousExprAnywhereRegex =
  /;|\b(UNION\s+(ALL\s+)?SELECT|EXCEPT\s+(ALL\s+)?SELECT|INTERSECT\s+(ALL\s+)?SELECT)\b/i;
export const dangerousExprRegex = {
  test: (v: string) => dangerousExprStartRegex.test(v) || dangerousExprAnywhereRegex.test(v),
};
export const dangerousExprMsg =
  'Expression must not contain semicolons, DDL/command statements, or UNION/EXCEPT/INTERSECT';

export const TrustTierSchema = z.enum(['bronze', 'silver', 'gold']);
export type TrustTier = z.infer<typeof TrustTierSchema>;
