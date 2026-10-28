/**
 * SQL preprocessing for Snowflake JSON-path access.
 *
 * `node-sql-parser` does not understand Snowflake's `col:path` syntax. We mask
 * the entire `<root>:<path>` expression with `__MODEL_SPEC_JSONP_<n>__` placeholders
 * before parsing and restore the original text when emitting DogsledExpr —
 * which natively understands the colon syntax.
 *
 * The regex anchors on a word boundary, so any preceding table qualifier
 * (`f.value:name` → `f` survives, `value:name` is masked) and the parser sees
 * the placeholder as a plain column reference under the original qualifier.
 */

// Quoted Snowflake identifiers may contain `""` as an escaped double-quote
// inside the body (e.g. `"col""1"`). We allow either a regular character or a
// literal `""` pair in both the root and path segments so masking covers
// inputs like `payload:"a""b"`.
const QUOTED_BODY = `(?:[^"]|"")+`;
const JSON_PATH_RE = new RegExp(
  `(\\b[a-zA-Z_][a-zA-Z0-9_]*|"${QUOTED_BODY}")` +
    `((?::[a-zA-Z_][a-zA-Z0-9_]*|:"${QUOTED_BODY}"|\\[\\d+\\])+)`,
  'g'
);

export interface PreprocessResult {
  sql: string;
  /** masks[i] is the original text for placeholder `__MODEL_SPEC_JSONP_${i}__`. */
  masks: string[];
}

export function preprocessJsonPaths(sql: string): PreprocessResult {
  const masks: string[] = [];
  // The regex requires at least one `:` or `[` segment in the path group, so
  // every match is guaranteed to be a JSON-path expression we need to mask.
  const out = sql.replace(JSON_PATH_RE, (_match, root: string, path: string) => {
    const id = masks.length;
    masks.push(`${root}${path}`);
    return `__MODEL_SPEC_JSONP_${id}__`;
  });
  return { sql: out, masks };
}

const PLACEHOLDER_RE = /^__MODEL_SPEC_JSONP_(\d+)__$/;

export function isJsonPathPlaceholder(name: string): boolean {
  return PLACEHOLDER_RE.test(name);
}

/** Returns the original `<root>:<path>` text for a placeholder column name, or null. */
export function restoreJsonPath(name: string, masks: readonly string[]): string | null {
  const match = PLACEHOLDER_RE.exec(name);
  if (!match) return null;
  const idx = Number(match[1]);
  return masks[idx] ?? null;
}
