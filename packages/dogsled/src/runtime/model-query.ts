/**
 * `resolveModelReferences` — Phase 2 query-time resolution of derived models.
 *
 * The on-read query engine (`runQueryCommand` in `lazy-query-engine.ts`) only
 * understands `sources.X` tokens: it finds them textually, hydrates the
 * referenced `live`/`lazy` API sources into in-memory/scratch tables, rewrites
 * `sources.X` to the physical tables, and runs the query. It has no concept of
 * a derived Model Spec *model*.
 *
 * This module is a pure SQL front-end that runs BEFORE the engine. It:
 *
 *   1. `loadProject(projectRoot)` to learn the set of derived model names.
 *   2. Scans the user SQL's FROM/JOIN clauses for those names (case-insensitive,
 *      excluding names shadowed by the query's own `WITH` CTEs).
 *   3. For each directly-referenced model, compiles a self-contained SELECT with
 *      `compileProject({ inlineDeps: true, selectOnly: true, models: [name] })`
 *      — upstream models are folded into CTEs so the result references ONLY
 *      `sources.X`.
 *   4. Splices those model SELECTs in as leading CTEs:
 *      `WITH <model> AS (<select>), ... <original SQL>`. A pre-existing user
 *      `WITH [RECURSIVE]` is merged by injecting the model CTEs FIRST (they
 *      depend only on `sources.X`, so they must precede any user CTE that
 *      references them).
 *
 * The combined SQL is handed to the unchanged engine, which now finds the
 * `sources.X` introduced by the model CTEs and hydrates them. Nothing is
 * persisted — every query recomputes each model from a fresh source fetch
 * (live = refetch, lazy = cache by max_age). This realizes the settled
 * "live model = view recomputed on read" decision.
 *
 * When the SQL references no models, the original SQL is returned UNCHANGED so
 * existing `sources.X`-only queries stay byte-identical.
 *
 * See `local-research/live-derived/phase-2-implementation-plan.md`.
 */

import { CommandError } from '@bobsled-inc/protocol';
import {
  compileProject,
  loadProject,
  type CompileProjectResult,
  type LoadedProject,
} from '@bobsled-inc/model-spec/project';

import { maskSqlIgnoredSegments } from './lazy-query-engine.js';

export interface ResolveModelReferencesOptions {
  /**
   * Pre-loaded project to reuse — skips the FS load. When omitted the project
   * is loaded from `projectRoot`.
   */
  project?: LoadedProject;
  /** Test seam: injectable `loadProject`. Defaults to the real loader. */
  loadProjectImpl?: typeof loadProject;
  /** Test seam: injectable `compileProject`. Defaults to the real compiler. */
  compileProjectImpl?: typeof compileProject;
}

/**
 * Blank out single-quoted string literals and `--` / block comments with
 * equal-length whitespace, leaving DOUBLE-quoted identifiers intact. Used by
 * `normalizeCompiledSourceRefs`, which must still see `"sources"` as a real
 * token (unlike `maskSqlIgnoredSegments`, which masks quoted identifiers too).
 * Offsets stay aligned so a caller can splice from the original string.
 */
function maskStringsAndComments(sql: string): string {
  let out = '';
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === "'") {
      const start = index;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      out += ' '.repeat(index - start);
      continue;
    }

    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index + 2);
      const stop = end === -1 ? sql.length : end;
      out += ' '.repeat(stop - index);
      index = stop;
      continue;
    }

    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += ' '.repeat(stop - index);
      index = stop;
      continue;
    }

    out += char;
    index += 1;
  }
  return out;
}

/**
 * Collect the lowercased CTE names declared by the query's own top-level
 * `WITH [RECURSIVE] name AS (...), name2 AS (...)` clause. These shadow any
 * same-named model, so a model with that name is NOT spliced (the user defined
 * their own). Only the names matter; the masked SQL keeps comment/string
 * offsets aligned so the scan never trips on a `WITH`-looking literal.
 */
function collectUserCteNames(maskedSql: string): Set<string> {
  const names = new Set<string>();
  // Match a leading WITH (optionally RECURSIVE). Only a top-level WITH defines
  // the CTE names we must not shadow; nested WITHs inside subqueries are scoped
  // away and cannot collide with our leading model CTEs.
  const withMatch = /^\s*WITH\s+(?:RECURSIVE\s+)?/i.exec(maskedSql);
  if (!withMatch) return names;

  // Walk the CTE list: `name [(col, ...)] AS ( ... )` separated by commas, until
  // the depth returns to 0 and the next non-CTE token (the main SELECT) begins.
  // We only need the CTE *names*, which appear before an optional column list
  // and the `AS (`. The optional `(...)` covers `WITH foo(a, b) AS (...)`.
  const cteHead = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\)\s*)?AS\s*\(/giy;
  let cursor = withMatch[0].length;

  while (cursor < maskedSql.length) {
    cteHead.lastIndex = cursor;
    const head = cteHead.exec(maskedSql);
    if (!head || head.index !== cursor) {
      // Allow a quoted CTE name `"name" AS (` — masking blanked the quotes, so
      // fall through to the generic skip below if it is not a bare identifier.
      break;
    }
    names.add(head[1]!.toLowerCase());

    // Skip the parenthesized CTE body, tracking nesting depth.
    let index = cteHead.lastIndex;
    let depth = 1;
    while (index < maskedSql.length && depth > 0) {
      const char = maskedSql[index];
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      index += 1;
    }

    // Skip whitespace, then expect a comma (another CTE) or stop (main query).
    while (index < maskedSql.length && /\s/.test(maskedSql[index]!)) index += 1;
    if (maskedSql[index] === ',') {
      cursor = index + 1;
      while (cursor < maskedSql.length && /\s/.test(maskedSql[cursor]!)) cursor += 1;
      continue;
    }
    break;
  }

  return names;
}

/**
 * Detect which of `modelNames` the user SQL references in a FROM/JOIN position.
 * Reuses the engine's masking so comments and string/identifier literals never
 * produce false positives. Names shadowed by the query's own top-level CTEs are
 * excluded. Matching is case-insensitive (DuckDB identifiers are
 * case-insensitive; model names are stored lowercased). A model referenced as
 * `schema.model` is NOT matched — derived models are bare, single-identifier
 * references in `dogsled query`.
 *
 * Returns the matched names in their original (lowercased) model-name form,
 * in stable sorted order for deterministic CTE emission.
 */
export function detectModelReferences(sql: string, modelNames: Iterable<string>): string[] {
  const known = new Map<string, string>();
  for (const name of modelNames) known.set(name.toLowerCase(), name.toLowerCase());
  if (known.size === 0) return [];

  const masked = maskSqlIgnoredSegments(sql);
  const shadowed = collectUserCteNames(masked);

  // Scan for `FROM <id>` / `JOIN <id>` where <id> is a bare identifier not
  // followed by a `.` (qualified `sources.X` / `schema.tbl` are handled by the
  // engine, not us) and not preceded by one (so it is a real table position).
  const fromJoin = /\b(?:FROM|JOIN)\b\s+/giy;
  const matched = new Set<string>();
  let index = 0;

  while (index < masked.length) {
    fromJoin.lastIndex = index;
    const kw = fromJoin.exec(masked);
    if (!kw || kw.index !== index) {
      index += 1;
      continue;
    }
    const cursor = fromJoin.lastIndex;
    // A leading `(` is a derived-table/subquery, not a model name.
    if (masked[cursor] === '(') {
      index = cursor;
      continue;
    }
    const idMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(masked.slice(cursor));
    if (!idMatch) {
      index = cursor;
      continue;
    }
    const ident = idMatch[0];
    const after = cursor + ident.length;
    // A trailing `.` means this is a qualified reference (e.g. `sources.x`),
    // which the engine resolves — never a bare derived-model reference.
    let probe = after;
    while (probe < masked.length && /\s/.test(masked[probe]!)) probe += 1;
    const isQualified = masked[probe] === '.';
    const lower = ident.toLowerCase();
    if (!isQualified && known.has(lower) && !shadowed.has(lower)) {
      matched.add(known.get(lower)!);
    }
    index = after;
  }

  return [...matched].sort();
}

/**
 * Extract the self-contained SELECT for a single model from a `compileProject`
 * result compiled with `{ inlineDeps: true, selectOnly: true, models: [name] }`.
 * Mirrors how `dryRunProject` buckets per-`modelName` SQL. The model may be
 * referenced under multiple integrations only in pathological multi-integration
 * projects; `dogsled query`'s live/lazy projects are single-integration, so a
 * unique compiled SELECT is expected.
 */
/**
 * Normalize the compiler's source references into the engine's logical
 * `sources.X` token form.
 *
 * The compiler emits source reads as a fully-quoted, fixed logical namespace:
 * `"sources"."<name>"` (the `sources` namespace is the Model Spec convention for
 * `type: source` reads, independent of the integration's physical schema). The
 * lazy engine's `referencedSources` scanner only recognizes a BARE `sources`
 * keyword (`sources.X` or `sources."X"`), so the quoted schema part would be
 * invisible to it. Unquoting just the `"sources"` schema segment (preserving
 * the quoted source name) yields `sources."<name>"`, which the engine resolves
 * and rewrites to the hydrated physical table. Masking keeps string/comment
 * offsets aligned so a `'... "sources"."x" ...'` literal is never rewritten.
 */
export function normalizeCompiledSourceRefs(sql: string): string {
  // NOTE: do NOT use `maskSqlIgnoredSegments` here — it blanks double-quoted
  // identifiers, which would erase the very `"sources"` token we need to match.
  // We only need to avoid rewriting inside single-quoted string literals and
  // comments, so mask just those.
  const masked = maskStringsAndComments(sql);
  // Match `"sources"` (optionally with whitespace around the dot) immediately
  // followed by `.`. Rewrite only the schema token to the bare `sources`
  // keyword; leave the source-name segment untouched (the engine accepts both
  // `sources.x` and `sources."x"`).
  const re = /"sources"(\s*\.)/g;
  let out = '';
  let last = 0;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(masked)) !== null) {
    out += sql.slice(last, hit.index);
    out += `sources${hit[1]}`;
    last = hit.index + hit[0].length;
  }
  out += sql.slice(last);
  return out;
}

function selectSqlForModel(result: CompileProjectResult, modelName: string): string {
  const lower = modelName.toLowerCase();
  const hits: string[] = [];
  for (const group of result.byIntegration) {
    for (const entry of group.results) {
      if (entry.ok && entry.modelName.toLowerCase() === lower) {
        hits.push(entry.sql);
      } else if (!entry.ok && entry.modelName?.toLowerCase() === lower) {
        throw new CommandError(
          `Failed to compile derived model "${modelName}" referenced in SQL: ${entry.error}`,
          2
        );
      }
    }
  }
  if (hits.length === 0) {
    throw new CommandError(
      `Derived model "${modelName}" referenced in SQL did not compile to a SELECT. ` +
        'Ensure it is a `type: model` over `sources.*` in this project.',
      2
    );
  }
  if (hits.length > 1) {
    throw new CommandError(
      `Derived model "${modelName}" resolves under multiple integrations; ` +
        '`dogsled query` requires an unambiguous single-integration model. ' +
        'Narrow the project or reference the model under a single integration.',
      2
    );
  }
  return normalizeCompiledSourceRefs(hits[0]!);
}

const LEADING_WITH_RE = /^\s*WITH\s+(?:RECURSIVE\s+)?/i;

/**
 * Splice the model SELECTs into the user SQL as leading CTEs. Model CTEs always
 * come FIRST — they depend only on `sources.X` and may be referenced by user
 * CTEs, so they must be in scope before any user CTE is defined.
 *
 *   - No pre-existing WITH: `WITH <m1> AS (<sql1>), <m2> AS (<sql2>)\n<sql>`.
 *   - Pre-existing `WITH [RECURSIVE]`: the model CTEs are injected immediately
 *     after the `WITH [RECURSIVE]` keyword, followed by a comma, preserving the
 *     user's CTE list. `RECURSIVE` (if present) stays on the original WITH and
 *     applies to the whole list — model CTEs are non-recursive plain SELECTs,
 *     which a recursive WITH list permits.
 */
function spliceModelCtes(sql: string, modelCtes: Array<{ name: string; sql: string }>): string {
  if (modelCtes.length === 0) return sql;

  const cteDefs = modelCtes
    .map((cte) => `${cte.name} AS (\n${cte.sql.trim().replace(/;\s*$/, '')}\n)`)
    .join(',\n');

  const leadingWith = LEADING_WITH_RE.exec(sql);
  if (leadingWith) {
    const head = sql.slice(0, leadingWith[0].length);
    const rest = sql.slice(leadingWith[0].length);
    return `${head}${cteDefs},\n${rest}`;
  }

  return `WITH ${cteDefs}\n${sql}`;
}

/**
 * Resolve derived-model references in `sql` by splicing each directly-referenced
 * model's self-contained SELECT in as a leading CTE. Returns the combined SQL
 * ready for the unchanged `runQueryCommand` engine.
 *
 * Pure read: nothing is persisted. When `sql` references no models the original
 * string is returned unchanged (no-op).
 *
 * @throws CommandError(2) when a model CTE name collides with a user CTE/table
 *   alias, or when a referenced model fails to compile.
 */
export async function resolveModelReferences(
  sql: string,
  projectRoot: string,
  opts: ResolveModelReferencesOptions = {}
): Promise<string> {
  const loadProjectImpl = opts.loadProjectImpl ?? loadProject;
  const compileProjectImpl = opts.compileProjectImpl ?? compileProject;

  const project = opts.project ?? (await loadProjectImpl(projectRoot));
  const modelNames = project.models.map((node) => node.name);
  if (modelNames.length === 0) return sql;

  const referenced = detectModelReferences(sql, modelNames);
  if (referenced.length === 0) return sql;

  // Guard: a model CTE name must not collide with a user-declared top-level CTE
  // or table alias. `detectModelReferences` already excludes user CTE names, so
  // any overlap here means an *aliased* collision. Two alias forms shadow the
  // model name we are about to splice as a CTE:
  //   - explicit:  `... AS stg_issues`           (covers subquery/table + AS)
  //   - implicit:  `FROM/JOIN <table> stg_issues` (a bare alias, no AS)
  // Reuse the engine's masking so the alias scan ignores comments/literals.
  const masked = maskSqlIgnoredSegments(sql);
  for (const name of referenced) {
    const explicitAlias = new RegExp(`\\bAS\\s+${name}\\b`, 'i');
    // A bare alias sits right after a table reference in a FROM/JOIN item. The
    // preceding `[A-Za-z_][\\w.]*` is that table ref, so `FROM stg_issues x`
    // (model ref + its own alias) does not match — only `FROM other stg_issues`.
    const bareAlias = new RegExp(`\\b(?:FROM|JOIN)\\s+[A-Za-z_][\\w.]*\\s+${name}\\b`, 'i');
    if (explicitAlias.test(masked) || bareAlias.test(masked)) {
      throw new CommandError(
        `Derived model "${name}" collides with a table/CTE alias "${name}" in the query. ` +
          'Rename the alias before referencing the model in dogsled query.',
        2
      );
    }
  }

  const modelCtes: Array<{ name: string; sql: string }> = [];
  for (const name of referenced) {
    const compiled = await compileProjectImpl(projectRoot, {
      models: [name],
      inlineDeps: true,
      selectOnly: true,
      project,
    });
    modelCtes.push({ name, sql: selectSqlForModel(compiled, name) });
  }

  return spliceModelCtes(sql, modelCtes);
}
