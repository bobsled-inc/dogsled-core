/**
 * Shared SQL regression-invariant helpers for entity-graph integration tests.
 *
 * These back three production-bug regressions that string-assertion unit tests
 * missed because they never parsed the literal/branch structure of compiled SQL:
 *
 *  1. Raw control chars (`\n`, `\r`, `\t`, ...) inside single-quoted SQL string
 *     literals — BigQuery rejects these with "Unclosed string literal". The
 *     fix escapes them in model-spec's `escapeSqlString` (dialect.ts). Note
 *     that raw control chars inside literals are *legal* on DuckDB / Snowflake /
 *     Postgres, so callers must scope this check to BigQuery output.
 *
 *  2. Asymmetric UNION ALL branches — `generateStandardizeSql` once projected
 *     different column sets per input, so branches referenced columns missing
 *     from their own input. The fix NULL-pads absent columns so every branch
 *     shares an identical alias sequence (codegen-standardize.ts).
 */

/**
 * Walk `sql` char-by-char tracking single-quoted-literal state and return a
 * short context snippet for every raw control char found *inside* a literal.
 *
 * Inside a literal:
 *   - `\\` consumes two chars (a backslash escape — the escaped char is legal).
 *   - `''` consumes two chars (a doubled-quote escape, still inside the literal).
 *   - a raw `\n`, `\r`, `\t`, `\b` (0x08), or `\f` is a violation: record a
 *     snippet and exit the literal to avoid cascading false positives.
 *
 * Content outside single-quoted literals (identifiers, BigQuery `r"""..."""`
 * raw UDF bodies, etc.) is ignored — only single-quoted literals are scanned.
 */
export function findRawControlCharsInLiterals(sql: string): string[] {
  const hits: string[] = [];
  const n = sql.length;
  let i = 0;

  while (i < n) {
    if (sql[i] !== "'") {
      i++;
      continue;
    }

    // Enter a single-quoted literal.
    i++;
    while (i < n) {
      const c = sql[i];
      if (c === '\\') {
        // Backslash escape — consume the backslash and the escaped char.
        i += 2;
        continue;
      }
      if (c === "'") {
        if (i + 1 < n && sql[i + 1] === "'") {
          // Doubled-quote escape — stays inside the literal.
          i += 2;
          continue;
        }
        // Closing quote.
        i++;
        break;
      }
      if (c === '\n' || c === '\r' || c === '\t' || c === '\b' || c === '\f') {
        const snippet = sql
          .slice(Math.max(0, i - 24), i + 4)
          .replaceAll('\n', '\\n')
          .replaceAll('\r', '\\r')
          .replaceAll('\t', '\\t')
          .replaceAll('\f', '\\f')
          .replaceAll('\b', '\\b');
        hits.push(snippet);
        // Skip to the closing quote to keep parser state consistent and avoid
        // cascading violations from the same literal. Mirrors the main loop:
        // handle backslash escapes and doubled-quote escapes inside this skip.
        i++;
        while (i < n) {
          if (sql[i] === "'") {
            if (i + 1 < n && sql[i + 1] === "'") {
              // Doubled-quote escape — stays inside the literal.
              i += 2;
              continue;
            }
            // Found the closing quote.
            break;
          }
          if (sql[i] === '\\') {
            i += 2;
          } else {
            i++;
          }
        }
        if (i < n) i++; // consume closing quote
        break;
      }
      i++;
    }
  }

  return hits;
}

/**
 * Split a UNION ALL query into branches and collect the projected output-alias
 * names per branch.
 *
 * Aliases are matched as `AS \`name\`` (BigQuery / Databricks / MySQL) or
 * `AS "name"` (Snowflake / Postgres / DuckDB) at the end of a projection line
 * (optionally followed by a trailing comma). The `FROM <table> AS <alias>` line
 * is excluded so only SELECT-list aliases are returned.
 *
 * Returns one alias array per branch, in branch (= input) order.
 */
export function extractUnionBranchAliases(sql: string): string[][] {
  const aliasRe = /\sAS\s+(?:`([^`]+)`|"([^"]+)")\s*,?\s*$/;
  return sql.split('\nUNION ALL\n').map((branch) => {
    const aliases: string[] = [];
    for (const line of branch.split('\n')) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('FROM ')) {
        // Skip the FROM-clause table alias (`FROM tbl AS "src"`).
        continue;
      }
      const match = line.match(aliasRe);
      if (match) {
        const alias = match[1] ?? match[2];
        if (alias !== undefined) {
          aliases.push(alias);
        }
      }
    }
    return aliases;
  });
}

/**
 * Find every `UNION` keyword not immediately followed by `ALL` or `DISTINCT`.
 *
 * BigQuery rejects bare `UNION` ("Syntax error: Expected keyword ALL or
 * keyword DISTINCT"), so any bare occurrence in BigQuery output is a
 * compile-time bug. String literals, quoted identifiers, and `--` comments
 * are masked before matching. Returns a short context snippet per hit.
 */
export function findBareUnions(sql: string): string[] {
  // Mask literals / quoted identifiers / line comments so keyword matching
  // can't false-positive on their contents.
  let masked = '';
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const char = sql[i]!;
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      let end = i + 1;
      while (end < n) {
        if (quote === "'" && sql[end] === "'" && sql[end + 1] === "'") {
          end += 2;
          continue;
        }
        if (sql[end] === quote) break;
        end += sql[end] === '\\' && quote === "'" ? 2 : 1;
      }
      end = Math.min(end + 1, n);
      masked += ' '.repeat(end - i);
      i = end;
      continue;
    }
    if (char === '-' && sql[i + 1] === '-') {
      let end = i;
      while (end < n && sql[end] !== '\n') end++;
      masked += ' '.repeat(end - i);
      i = end;
      continue;
    }
    masked += char;
    i++;
  }

  const hits: string[] = [];
  const re = /\bUNION\b(?!\s+(?:ALL|DISTINCT)\b)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(masked)) !== null) {
    const start = Math.max(0, match.index - 40);
    const end = Math.min(sql.length, match.index + 45);
    hits.push(sql.slice(start, end).replace(/\s+/g, ' ').trim());
  }
  return hits;
}
