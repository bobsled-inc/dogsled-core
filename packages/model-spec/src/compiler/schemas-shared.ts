import { z } from 'zod';
import { expressionSyntaxVariants } from './sql-expression-syntax.js';
import type { SupportedDialect } from './dialect.js';

/** Reject expressions that contain SQL statement separators or dangerous keywords. */
const dangerousExprStartRegex =
  /(?:^|\braw_sql\s*\()\s*(?:\(\s*)*(DROP|ALTER|CREATE|TRUNCATE|INSERT|UPDATE|DELETE|REPLACE\s+INTO|MERGE|GRANT|REVOKE|EXEC|EXECUTE|CALL|DECLARE|PRAGMA|COPY|LOAD|UNLOAD)\b/i;
const dangerousExprAnywhereRegex =
  /;|\b(?:UNION|EXCEPT|INTERSECT)\s+(?:(?:ALL|DISTINCT)\s+)?SELECT\b/i;
export const dangerousExprRegex = {
  test: (v: string, dialect?: SupportedDialect) => {
    const variants = expressionSyntaxVariants(v, dialect);
    return (
      variants.length === 0 ||
      variants.some(
        (sql) => dangerousExprStartRegex.test(sql) || dangerousExprAnywhereRegex.test(sql)
      )
    );
  },
};
export const dangerousExprMsg =
  'Expression must have terminated SQL quoting/comments and must not contain statement separators, DDL/command statements, or UNION/EXCEPT/INTERSECT';

/** Apply the schema expression boundary to native SQL, with its dialect at codegen. */
export function isDangerousRawSql(sql: string, dialect?: SupportedDialect): boolean {
  return dangerousExprRegex.test(sql, dialect);
}

export const TrustTierSchema = z.enum(['bronze', 'silver', 'gold']);
export type TrustTier = z.infer<typeof TrustTierSchema>;
