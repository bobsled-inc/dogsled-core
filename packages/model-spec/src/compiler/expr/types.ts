/**
 * DogsledExpr — discriminated-union AST for SQL expressions.
 *
 * Every node carries a `kind` tag so consumers can pattern-match exhaustively.
 * The tree is intentionally dialect-agnostic; dialect-specific rendering is the
 * emitter's responsibility.
 */

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

export type ArithmeticOp = '+' | '-' | '*' | '/' | '%';
export type ComparisonOp = '=' | '!=' | '<' | '>' | '<=' | '>=';
export type LogicalOp = 'AND' | 'OR';
export type StringOp = 'LIKE' | 'ILIKE' | 'NOT LIKE' | 'NOT ILIKE' | '||';

export type BinaryOp = ArithmeticOp | ComparisonOp | LogicalOp | StringOp;
export type UnaryOp = '-' | 'NOT';

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/** SQL type reference, e.g. `VARCHAR(255)` or `NUMERIC(10, 2)`. */
export interface TypeRef {
  readonly name: string;
  readonly params?: readonly number[];
}

/** A single WHEN … THEN branch inside a CASE expression. */
export interface CaseWhen {
  readonly condition: DogsledExpr;
  readonly result: DogsledExpr;
}

export type JsonPathStep =
  { readonly kind: 'key'; readonly name: string } | { readonly kind: 'index'; readonly n: number };

// ---------------------------------------------------------------------------
// AST node variants
// ---------------------------------------------------------------------------

export interface ColumnRefExpr {
  readonly kind: 'column_ref';
  readonly table?: string;
  readonly column: string;
}

export interface LiteralStringExpr {
  readonly kind: 'literal_string';
  readonly value: string;
}

export interface LiteralNumberExpr {
  readonly kind: 'literal_number';
  readonly value: number;
  /** Original text representation, preserving decimal notation (e.g. '100.0'). */
  readonly raw?: string;
}

export interface LiteralBooleanExpr {
  readonly kind: 'literal_boolean';
  readonly value: boolean;
}

export interface LiteralNullExpr {
  readonly kind: 'literal_null';
}

export interface LiteralStarExpr {
  readonly kind: 'literal_star';
  readonly table?: string;
}

export interface BinaryOpExpr {
  readonly kind: 'binary_op';
  readonly op: BinaryOp;
  readonly left: DogsledExpr;
  readonly right: DogsledExpr;
}

export interface UnaryOpExpr {
  readonly kind: 'unary_op';
  readonly op: UnaryOp;
  readonly operand: DogsledExpr;
}

export interface FunctionCallExpr {
  readonly kind: 'function_call';
  readonly name: string;
  readonly args: readonly DogsledExpr[];
  readonly distinct?: boolean;
  /** IGNORE NULLS / RESPECT NULLS modifier (window functions like FIRST_VALUE, LAST_VALUE). */
  readonly nullsHandling?: 'ignore' | 'respect';
}

export interface CastExpr {
  readonly kind: 'cast';
  readonly expr: DogsledExpr;
  readonly targetType: TypeRef;
  /** True when parsed from PostgreSQL-style `::` cast shorthand. Affects emitter output for Snowflake, Postgres, and DuckDB. */
  readonly shorthand?: boolean;
}

export interface JsonPathAccessExpr {
  readonly kind: 'json_path_access';
  readonly base: DogsledExpr;
  readonly steps: readonly JsonPathStep[];
}

export interface CaseExpr {
  readonly kind: 'case';
  readonly operand?: DogsledExpr;
  readonly whens: readonly CaseWhen[];
  readonly elseExpr?: DogsledExpr;
}

export interface BetweenExpr {
  readonly kind: 'between';
  readonly expr: DogsledExpr;
  readonly low: DogsledExpr;
  readonly high: DogsledExpr;
  readonly negated?: boolean;
}

export interface InListExpr {
  readonly kind: 'in_list';
  readonly expr: DogsledExpr;
  readonly list: readonly DogsledExpr[];
  readonly negated?: boolean;
}

export interface IsNullExpr {
  readonly kind: 'is_null';
  readonly expr: DogsledExpr;
  readonly negated?: boolean;
}

export interface ParenthesizedExpr {
  readonly kind: 'parenthesized';
  readonly expr: DogsledExpr;
}

export interface RawSqlExpr {
  readonly kind: 'raw_sql';
  readonly sql: string;
  /** true = user explicitly wrote raw_sql(), false/undefined = parse fallback */
  readonly explicit?: boolean;
}

/** Scalar subquery: `(SELECT MAX(x) FROM t)`. Stored as raw SQL. */
export interface SubqueryExpr {
  readonly kind: 'subquery';
  readonly sql: string;
}

/** `expr [NOT] IN (SELECT ...)` — subquery variant of IN. */
export interface InSubqueryExpr {
  readonly kind: 'in_subquery';
  readonly expr: DogsledExpr;
  readonly subquerySql: string;
  readonly negated?: boolean;
}

/** `[NOT] EXISTS (SELECT ...)`. */
export interface ExistsExpr {
  readonly kind: 'exists';
  readonly subquerySql: string;
  readonly negated?: boolean;
}

/** ORDER BY item inside a window specification. */
/**
 * `INTERVAL <n> <unit>`.
 *
 * Carried structurally rather than as text because the spelling diverges:
 * Postgres, Redshift and Snowflake want the amount and unit inside one string
 * literal, while BigQuery, DuckDB, MySQL and Databricks want them bare.
 */
export interface IntervalExpr {
  readonly kind: 'interval';
  readonly amount: number;
  readonly unit: IntervalUnit;
}

/** Interval units every supported target accepts. */
export type IntervalUnit = 'YEAR' | 'MONTH' | 'WEEK' | 'DAY' | 'HOUR' | 'MINUTE' | 'SECOND';

export interface WindowOrderByItem {
  readonly expr: DogsledExpr;
  readonly direction?: 'ASC' | 'DESC';
  /**
   * NULLS FIRST / NULLS LAST modifier. Left undefined the target's default
   * null ordering applies, which differs per dialect, so authors who care
   * about null placement must state it.
   */
  readonly nulls?: 'FIRST' | 'LAST';
}

// ---------------------------------------------------------------------------
// Window frame types
// ---------------------------------------------------------------------------

/** A single bound in a window frame specification. */
export type FrameBound =
  | 'CURRENT ROW'
  | 'UNBOUNDED PRECEDING'
  | 'UNBOUNDED FOLLOWING'
  | { readonly offset: DogsledExpr; readonly direction: 'PRECEDING' | 'FOLLOWING' };

/**
 * Window frame EXCLUDE clause (SQL:2003). Selects which rows in the frame are
 * removed after the frame bounds are applied.
 */
export type FrameExclude = 'CURRENT ROW' | 'GROUP' | 'TIES' | 'NO OTHERS';

/** Structured window frame specification (ROWS/RANGE/GROUPS BETWEEN ...). */
export interface WindowFrameSpec {
  readonly kind: 'window_frame';
  readonly type: 'ROWS' | 'RANGE' | 'GROUPS';
  readonly start: FrameBound;
  readonly end?: FrameBound;
  readonly exclude?: FrameExclude;
}

export interface WindowExpr {
  readonly kind: 'window';
  readonly fn: FunctionCallExpr;
  readonly partitionBy?: readonly DogsledExpr[];
  readonly orderBy?: readonly WindowOrderByItem[];
  readonly frame?: WindowFrameSpec | RawSqlExpr;
  readonly windowName?: string;
}

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

export type DogsledExpr =
  | ColumnRefExpr
  | LiteralStringExpr
  | LiteralNumberExpr
  | LiteralBooleanExpr
  | LiteralNullExpr
  | LiteralStarExpr
  | BinaryOpExpr
  | UnaryOpExpr
  | FunctionCallExpr
  | CastExpr
  | JsonPathAccessExpr
  | CaseExpr
  | BetweenExpr
  | InListExpr
  | InSubqueryExpr
  | IsNullExpr
  | IntervalExpr
  | ParenthesizedExpr
  | RawSqlExpr
  | SubqueryExpr
  | ExistsExpr
  | WindowExpr;

/** All possible `kind` values for exhaustive switch checks. */
export type DogsledExprKind = DogsledExpr['kind'];
