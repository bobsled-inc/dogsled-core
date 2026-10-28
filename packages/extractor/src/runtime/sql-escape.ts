/**
 * Shared SQL string escape utility.
 * Escapes backslashes then single quotes for safe SQL string literals.
 *
 * Backslash escaping is applied universally here as a conservative
 * defense-in-depth measure. BigQuery Standard SQL and Databricks SQL both
 * require backslash escaping because they treat backslash as an escape
 * character in single-quoted string literals (e.g. `\n` is a newline). The
 * extractor applies it to all dialects to avoid any risk of driver-level or
 * session-level backslash interpretation. See `@bobsled-inc/model-spec`'s
 * `escapeSqlString` for a dialect-aware approach that restricts backslash
 * escaping to dialects that require it (MySQL, BigQuery, Databricks).
 */
export function escapeSqlString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "''");
}
