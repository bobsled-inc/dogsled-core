/** CTE construction shared by source, join and set-operation relations. */
import { transpileOrEmit, type CodegenOptions } from './codegen-expressions.js';
import { caseName, getOrThrow, type SupportedDialect } from './dialect.js';
import type { ResolvedTransformSpec } from './parser.js';

// ---------------------------------------------------------------------------
// Helper: Nested CTE hoisting
// ---------------------------------------------------------------------------

/**
 * Extract nested CTE definitions from SQL that starts with a WITH clause.
 *
 * When ephemeral models depend on other ephemeral models, the stored SQL
 * may contain `WITH __cte_a AS (...) SELECT ...`. This function extracts
 * the inner CTE definitions and returns the bare SELECT body, allowing
 * the caller to hoist all CTEs to the top-level WITH clause.
 *
 * Handles arbitrarily nested parentheses within CTE bodies.
 */
function hoistNestedCtes(sql: string): {
  innerCteDefs: Array<{ cteName: string; sql: string }>;
  body: string;
  recursive: boolean;
} {
  const trimmed = sql.trimStart();
  if (!trimmed.toUpperCase().startsWith('WITH ')) {
    return { innerCteDefs: [], body: sql, recursive: false };
  }

  const innerCteDefs: Array<{ cteName: string; sql: string }> = [];
  let pos = 5; // skip 'WITH '

  // `WITH RECURSIVE` marks the whole WITH list, not one CTE, so a recursive
  // definition hoisted upward only needs the keyword to travel with it. Without
  // this the parse below reads RECURSIVE as a CTE name, gives up, and leaves a
  // nested WITH inside a CTE body — legal in DuckDB and Postgres, rejected by
  // Snowflake and BigQuery.
  let recursive = false;
  {
    const afterWith = trimmed.slice(pos).trimStart();
    if (/^RECURSIVE\b/i.test(afterWith)) {
      recursive = true;
      pos = trimmed.length - afterWith.length + 'RECURSIVE'.length;
    }
  }

  // Skip whitespace
  while (pos < trimmed.length && /\s/.test(trimmed[pos]!)) pos++;

  // Parse CTE definitions: name AS (...), name AS (...), ... SELECT
  while (pos < trimmed.length) {
    // Read CTE name
    const nameStart = pos;
    while (pos < trimmed.length && /\w/.test(trimmed[pos]!)) pos++;
    const cteName = trimmed.slice(nameStart, pos);
    if (!cteName) break;

    // Skip whitespace
    while (pos < trimmed.length && /\s/.test(trimmed[pos]!)) pos++;

    // Expect 'AS'
    if (trimmed.slice(pos, pos + 2).toUpperCase() !== 'AS') break;
    pos += 2;

    // Skip whitespace
    while (pos < trimmed.length && /\s/.test(trimmed[pos]!)) pos++;

    // Expect '(' — read balanced parens for the CTE body
    if (trimmed[pos] !== '(') break;
    pos++; // skip opening '('
    let depth = 1;
    const bodyStart = pos;
    while (pos < trimmed.length && depth > 0) {
      if (trimmed[pos] === '(') depth++;
      else if (trimmed[pos] === ')') depth--;
      if (depth > 0) pos++;
    }
    const cteBody = trimmed.slice(bodyStart, pos);
    pos++; // skip closing ')'

    innerCteDefs.push({ cteName, sql: cteBody });

    // Skip whitespace
    while (pos < trimmed.length && /\s/.test(trimmed[pos]!)) pos++;

    // If next char is ',', there are more CTEs
    if (trimmed[pos] === ',') {
      pos++;
      while (pos < trimmed.length && /\s/.test(trimmed[pos]!)) pos++;
      continue;
    }

    // Otherwise, the rest is the SELECT body
    break;
  }

  const body = trimmed.slice(pos);
  return { innerCteDefs, body, recursive };
}

// ---------------------------------------------------------------------------
// Helper: CTE definitions
// ---------------------------------------------------------------------------

/**
 * Build CTE definitions from the cteMap (ephemeral model refs) and
 * pre-aggregate CTEs for joins that need them.
 *
 * When ephemeral models reference other ephemeral models, the stored SQL
 * may contain nested WITH clauses. This function hoists all inner CTEs
 * to the top level, deduplicating by name, to avoid nested WITH clauses
 * that are invalid in BigQuery and other dialects.
 *
 * Returns the CTE definitions array and the fqTableName-to-cteName mapping.
 */
export function buildCteDefinitions(
  spec: ResolvedTransformSpec,
  cteMap: Map<string, string> | undefined,
  dialect: SupportedDialect,
  opts: CodegenOptions
): {
  cteDefs: Array<{ cteName: string; sql: string }>;
  fqToCte: Map<string, string>;
  inlineFqToCte: Map<string, string>;
  recursive: boolean;
} {
  const cteDefs: Array<{ cteName: string; sql: string }> = [];
  const fqToCte = new Map<string, string>();
  const seenCteNames = new Set<string>();
  let recursive = false;

  /** Add a CTE definition, deduplicating by name. */
  function addCteDef(cteName: string, sql: string): void {
    if (seenCteNames.has(cteName)) return;
    seenCteNames.add(cteName);
    cteDefs.push({ cteName, sql });
  }

  /**
   * Process a raw CTE SQL string: hoist any nested CTEs, then add the outer CTE.
   * A hoisted recursive definition marks the whole assembled WITH as RECURSIVE.
   */
  function addCteWithHoisting(cteName: string, rawSql: string): void {
    const hoisted = hoistNestedCtes(rawSql);
    const { innerCteDefs, body } = hoisted;
    if (hoisted.recursive) recursive = true;
    // Add inner (dependency) CTEs first
    for (const inner of innerCteDefs) {
      addCteDef(inner.cteName, inner.sql);
    }
    // Then add the outer CTE with its nested WITH stripped
    addCteDef(cteName, body);
  }

  if (cteMap) {
    const addRelation = (fqTableName: string, ref: string): void => {
      if (!cteMap.has(fqTableName) || fqToCte.has(fqTableName)) return;
      const cteName = caseName(`__cte_${ref.replace(/\W/g, '_')}`, dialect);
      fqToCte.set(fqTableName, cteName);
      addCteWithHoisting(cteName, getOrThrow(cteMap, fqTableName, 'cteMap relation'));
    };
    addRelation(spec.source.fqTableName, spec.sourceRef);
    for (const join of spec.joins) {
      addRelation(join.fqTableName, join.ref);
    }
    for (const branch of spec.union ?? []) {
      addRelation(branch.fqTableName, branch.ref ?? branch.fqTableName);
    }
  }

  // A pre-aggregate belongs to its join; UNION branches still read the complete
  // inlined relation, even when they share that join's dependency.
  const inlineFqToCte = new Map(fqToCte);

  // Generate pre-aggregate CTEs for joins that need them
  for (const join of spec.joins) {
    if (join.preAggregate) {
      const pa = join.preAggregate;
      const joinTable = fqToCte.get(join.fqTableName) ?? join.fqTableName;
      const paCols = pa.columns
        .map(
          (c) =>
            `${transpileOrEmit(c.expr, opts.sourceDialect, dialect, opts)} AS ${caseName(c.name, dialect)}`
        )
        .join(', ');
      const groupByCols = pa.group_by.map((g) => caseName(g, dialect)).join(', ');
      const paCteName = caseName(`__pa_${join.alias}`, dialect);
      const paSql = `SELECT ${groupByCols}, ${paCols} FROM ${joinTable} GROUP BY ${groupByCols}`;
      cteDefs.push({ cteName: paCteName, sql: paSql });
      fqToCte.set(join.fqTableName, paCteName);
    }
  }

  return { cteDefs, fqToCte, inlineFqToCte, recursive };
}
