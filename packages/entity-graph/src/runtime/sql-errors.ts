/**
 * Classifies runner errors as "the table/view is missing" — the signal the
 * access-plane services use to treat a surface as not-yet-built instead of
 * failing.
 *
 * The patterns are deliberately anchored to table-shaped phrasings: a bare
 * `does not exist` / `not found` match would also swallow missing-COLUMN
 * binder errors (DuckDB: `Referenced column "x" not found`, Postgres:
 * `column "x" does not exist`), turning a spec typo into a silent miss —
 * and, on the assign path, into a duplicate entity.
 */
const MISSING_TABLE_PATTERNS: readonly RegExp[] = [
  /table with name .* does not exist/i, // duckdb
  /no such table/i, // sqlite-style
  /unknown table/i, // mysql
  /relation .* does not exist/i, // postgres
  /object .* does not exist/i, // snowflake
  /table or view .* not found/i, // databricks / spark
  /table_or_view_not_found/i, // databricks error class
  /not found: table/i, // bigquery
  /table .* (?:does not exist|not found)/i, // generic fallback
  /SQLSTATE\s*42P01/i, // postgres undefined_table
];

export function isMissingTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return MISSING_TABLE_PATTERNS.some((pattern) => pattern.test(message));
}
