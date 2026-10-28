import { transpile } from '@polyglot-sql/sdk';
import {
  caseName,
  getCanonicalDialect,
  supportsDialectCapability,
  toPolyglotDialect,
} from './dialect.js';
import type { SupportedDialect } from './dialect.js';
import { emitExpr, mapExpr, parseExprField, parseWindowFrameClause } from './expr/index.js';
import type { DogsledExpr, WindowFrameSpec, WindowOrderByItem } from './expr/index.js';
import type { ResolvedFlattenJson, ResolvedTransformSpec, SourceEntryRegistry } from './parser.js';

// ---------------------------------------------------------------------------
// Expression transpilation (0.1 Expression AST)
// ---------------------------------------------------------------------------

/**
 * Transpile a single SQL expression from source dialect to target dialect.
 *
 * Wraps the expression in a SELECT statement, transpiles, then extracts
 * the result. Falls back to the original expression on failure.
 */
export function transpileExpr(
  expr: string,
  sourceDialect: SupportedDialect,
  targetDialect: SupportedDialect
): string {
  if (sourceDialect === targetDialect) return expr;

  const from = toPolyglotDialect(sourceDialect);
  const to = toPolyglotDialect(targetDialect);

  try {
    const result = transpile(`SELECT ${expr} AS __expr`, from, to);
    const sql = result.sql?.[0];
    if (!sql) return expr;
    // Extract expression between SELECT and AS __expr
    const match = sql.match(/^SELECT\s+([\s\S]*?)\s+AS\s+__expr/i);
    return match?.[1]?.trim() ?? expr;
  } catch {
    return expr; // passthrough on failure
  }
}

/**
 * Transpile a column expression using the AST path when possible,
 * falling back to polyglot-sql transpilation for raw_sql nodes.
 */
export function transpileOrEmit(
  exprStr: string,
  sourceDialect: SupportedDialect,
  targetDialect: SupportedDialect,
  options?: {
    warnings?: string[];
    strict?: boolean;
    flattenAliases?: ReadonlySet<string>;
    namedWindows?: ReadonlyMap<string, ResolvedNamedWindow>;
    modelName?: string;
  }
): string {
  const ast = parseExprField(exprStr);
  if (ast.kind === 'raw_sql') {
    if (options?.strict && !ast.explicit) {
      throw new Error(`Strict mode: expression could not be parsed: ${exprStr}`);
    }
    options?.warnings?.push(`Expression fell back to raw_sql (not transpiled): ${exprStr}`);
    return transpileExpr(ast.sql, sourceDialect, targetDialect);
  }
  return emitExpr(prepareAstForEmit(ast, targetDialect, options), targetDialect);
}

/**
 * Apply the transforms codegen runs before emitting any expression: flatten
 * alias normalisation, then named-window inlining for targets with no WINDOW
 * clause. Shared so an AST built inside codegen emits identically to one parsed
 * from a spec field.
 */
export function prepareAstForEmit(
  ast: DogsledExpr,
  targetDialect: SupportedDialect,
  options?: {
    flattenAliases?: ReadonlySet<string>;
    namedWindows?: ReadonlyMap<string, ResolvedNamedWindow>;
    modelName?: string;
  }
): DogsledExpr {
  const flattened = normalizeFlattenValueRefs(ast, targetDialect, options?.flattenAliases);
  if (options?.namedWindows && !supportsDialectCapability(targetDialect, 'namedWindowClause')) {
    return inlineNamedWindows(flattened, options.namedWindows, options.modelName ?? 'unknown');
  }
  return flattened;
}

// ---------------------------------------------------------------------------
// Shared options type for helper functions
// ---------------------------------------------------------------------------

/** Options shared across codegen helper functions. */
export interface CodegenOptions {
  sourceDialect: SupportedDialect;
  isFullRefresh: boolean;
  targetSchema?: string;
  targetDatabase?: string;
  warnings?: string[];
  strict?: boolean;
  flattenAliases?: ReadonlySet<string>;
  entryRegistry?: SourceEntryRegistry;
  /**
   * Model-level named windows, resolved to ASTs. Targets with a WINDOW clause
   * emit these once; targets without one inline them at each use site.
   */
  namedWindows?: ReadonlyMap<string, ResolvedNamedWindow>;
  /** Model name, used in named-window error messages. */
  modelName?: string;
}

// ---------------------------------------------------------------------------
// Helper: named windows
// ---------------------------------------------------------------------------

/** A model-level named window resolved into emitter-ready pieces. */
interface ResolvedNamedWindow {
  partitionBy?: DogsledExpr[];
  orderBy?: WindowOrderByItem[];
  frame?: WindowFrameSpec;
}

/**
 * Resolve each `windows` declaration into AST pieces.
 *
 * Partition and order columns are normalized through the qualified-reference
 * normalizer first and carried as verbatim nodes, so named windows resolve
 * references exactly like every other clause. The frame is parsed rather than
 * passed through, which gives it the same validation and per-dialect capability
 * gating as a frame written inline in a column expression.
 */
export function resolveNamedWindows(
  spec: ResolvedTransformSpec,
  dialect: SupportedDialect,
  opts: CodegenOptions
): ReadonlyMap<string, ResolvedNamedWindow> | undefined {
  if (!spec.windows || spec.windows.length === 0) return undefined;
  const verbatim = (text: string): DogsledExpr => ({ kind: 'raw_sql', sql: text, explicit: true });
  const resolved = new Map<string, ResolvedNamedWindow>();
  for (const w of spec.windows) {
    let frame: WindowFrameSpec | undefined;
    if (w.frame) {
      try {
        frame = parseWindowFrameClause(w.frame);
      } catch (err) {
        throw new Error(
          `Model "${spec.name}" window "${w.name}" has an invalid frame clause ${JSON.stringify(w.frame)}`,
          { cause: err }
        );
      }
    }
    resolved.set(w.name.toLocaleLowerCase(), {
      partitionBy: w.partitionBy?.map((p) =>
        verbatim(normalizeQualifiedValueReference(p, dialect, opts.flattenAliases))
      ),
      orderBy: w.orderBy?.map((o) => ({
        expr: verbatim(normalizeQualifiedValueReference(o.column, dialect, opts.flattenAliases)),
        ...(o.direction ? { direction: o.direction.toUpperCase() as 'ASC' | 'DESC' } : {}),
        ...(o.nulls ? { nulls: o.nulls.toUpperCase() as 'FIRST' | 'LAST' } : {}),
      })),
      ...(frame ? { frame } : {}),
    });
  }
  return resolved;
}

/**
 * Replace `OVER <name>` references with the named window's own specification.
 *
 * Used for targets with no WINDOW clause. Rewriting the AST rather than the
 * emitted text means a reference nested inside a CASE, a cast or a function
 * argument is expanded too.
 */
function inlineNamedWindows(
  expr: DogsledExpr,
  namedWindows: ReadonlyMap<string, ResolvedNamedWindow>,
  modelName: string
): DogsledExpr {
  return mapExpr(expr, (node) => {
    if (node.kind !== 'window' || node.windowName === undefined) return node;
    const spec = namedWindows.get(node.windowName.toLocaleLowerCase());
    if (!spec) {
      throw new Error(
        `Model "${modelName}" references window "${node.windowName}", which is not declared in "windows"`
      );
    }
    const { windowName: _dropped, ...rest } = node;
    return {
      ...rest,
      ...(spec.partitionBy ? { partitionBy: spec.partitionBy } : {}),
      ...(spec.orderBy ? { orderBy: spec.orderBy } : {}),
      ...(spec.frame ? { frame: spec.frame } : {}),
    };
  });
}

export function getFlattenAlias(step: ResolvedFlattenJson): string {
  return step.alias ?? 'flattened';
}

export function collectFlattenAliases(
  flattenJson: ResolvedTransformSpec['flattenJson']
): ReadonlySet<string> | undefined {
  if (!flattenJson || flattenJson.length === 0) {
    return undefined;
  }

  return new Set(flattenJson.map((flatten) => getFlattenAlias(flatten).toLowerCase()));
}

function usesDirectFlattenValue(dialect: SupportedDialect): boolean {
  const canonicalDialect = getCanonicalDialect(dialect);
  return (
    canonicalDialect === 'bigquery' ||
    canonicalDialect === 'databricks' ||
    canonicalDialect === 'duckdb'
  );
}

/**
 * Predicate: does this `alias.column` reference point to the VALUE column of a
 * flatten alias on a dialect that treats the flatten output as a scalar
 * (BigQuery/Databricks/DuckDB)? Shared by the AST walker and the regex-based
 * GROUP BY / ORDER BY normalizer.
 */
function isFlattenValueReference(
  table: string | undefined,
  column: string,
  dialect: SupportedDialect,
  flattenAliases?: ReadonlySet<string>
): boolean {
  return (
    !!table &&
    !!flattenAliases &&
    flattenAliases.size > 0 &&
    usesDirectFlattenValue(dialect) &&
    column.toLowerCase() === 'value' &&
    flattenAliases.has(table.toLowerCase())
  );
}

function normalizeFlattenValueRefs(
  expr: ReturnType<typeof parseExprField>,
  dialect: SupportedDialect,
  flattenAliases?: ReadonlySet<string>
) {
  if (!flattenAliases || flattenAliases.size === 0 || !usesDirectFlattenValue(dialect)) {
    return expr;
  }

  return mapExpr(expr, (node) => {
    if (
      node.kind === 'column_ref' &&
      isFlattenValueReference(node.table, node.column, dialect, flattenAliases)
    ) {
      return { kind: 'column_ref', column: node.table! };
    }
    return node;
  });
}

export function normalizeQualifiedValueReference(
  reference: string,
  dialect: SupportedDialect,
  flattenAliases?: ReadonlySet<string>
): string {
  const match = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(reference.trim());
  const table = match?.[1];
  const column = match?.[2];
  if (table && column && isFlattenValueReference(table, column, dialect, flattenAliases)) {
    return caseName(table, dialect);
  }
  return caseName(reference, dialect);
}
