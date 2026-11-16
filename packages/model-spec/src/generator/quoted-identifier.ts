/**
 * Snowflake double-quoted identifier handling for the SQL → Model Spec generator.
 *
 * `node-sql-parser` surfaces `"..."` SELECT-list identifiers as a
 * `double_quote_string` node — without this helper they would be rejected as
 * an unsupported construct. We treat them as column references and emit
 * BobsledExpr-compatible tokens, keeping quotes only when they carry semantic
 * weight (reserved words, non-uppercase letters, punctuation).
 */

import { isReservedWord } from '../compiler/dialect.js';

/**
 * Snowflake's unquoted-identifier alphabet. A quoted identifier whose body
 * matches this regex is case-equivalent to the bare unquoted form (Snowflake
 * uppercases unquoted identifiers), so we can emit it without quotes and let
 * BobsledExpr / dialect codegen treat it like any other column reference.
 */
const SNOWFLAKE_UNQUOTED_RE = /^[A-Z_][A-Z0-9_$]*$/;

/**
 * Translate a `"..."` Snowflake-quoted identifier (which `node-sql-parser`
 * surfaces as `double_quote_string`) into a BobsledExpr-compatible token.
 *
 * Two cases:
 * - `"COUNTRY"` / `"_SH_LOADED_AT"` — body matches the unquoted-identifier
 *   alphabet and isn't a reserved word, so it's case-equivalent to the bare
 *   form. Emit unquoted.
 * - `"FROM"`, `"col"`, `"col with space"`, `"a.b"` — body is reserved,
 *   non-uppercase, or contains punctuation, so the quoting carries semantic
 *   weight. Preserve the quotes; BobsledExpr's tokenizer doesn't recognise
 *   `"`, so the whole expression falls back to a `raw_sql` node and the
 *   dialect codegen passes the quoted identifier through verbatim.
 *
 * Reserved-word membership is sourced from `compiler/dialect.ts` so the
 * generator and the rest of the Model Spec compiler agree on a single Snowflake
 * keyword list.
 */
export function emitQuotedIdentifier(value: string): string {
  if (SNOWFLAKE_UNQUOTED_RE.test(value) && !isReservedWord(value, 'snowflake')) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}
