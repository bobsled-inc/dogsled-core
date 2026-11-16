/**
 * Recursive-descent parser for BobsledExpr DSL.
 *
 * Precedence (lowest → highest):
 *   1. OR
 *   2. AND
 *   3. NOT (prefix)
 *   4. Comparison: =, !=, <, >, <=, >=, IS NULL, IS NOT NULL, IN, NOT IN,
 *      BETWEEN, NOT BETWEEN, LIKE, ILIKE
 *   5. Addition: +, -, ||
 *   6. Multiplication: *, /, %
 *   7. Unary: - (prefix)
 *   8. Primary: literals, column refs, function calls, CASE, CAST, parens, raw_sql()
 */

import type { Token } from './tokenizer.js';
import { tokenize } from './tokenizer.js';
import { expressionSyntaxVariants } from '../sql-expression-syntax.js';
import type {
  BobsledExpr,
  BinaryOp,
  CaseWhen,
  FrameBound,
  FrameExclude,
  IntervalUnit,
  FunctionCallExpr,
  JsonPathStep,
  TypeRef,
  WindowFrameSpec,
  WindowOrderByItem,
} from './types.js';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ParseResult = { ok: true; expr: BobsledExpr } | { ok: false; error: string };

/** Interval units every supported target accepts. */
const INTERVAL_UNITS = new Set(['YEAR', 'MONTH', 'WEEK', 'DAY', 'HOUR', 'MINUTE', 'SECOND']);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Continuation keywords for multi-word type names (e.g. TIMESTAMP WITH TIME ZONE). */
const TYPE_CONTINUATIONS = new Set(['WITH', 'WITHOUT', 'TIME', 'ZONE', 'VARYING', 'PRECISION']);

// ---------------------------------------------------------------------------
// Parser state
// ---------------------------------------------------------------------------

/** Maximum expression nesting depth before the parser bails out. */
const MAX_DEPTH = 128;

class Parser {
  private readonly tokens: Token[];
  private pos: number;
  private depth: number;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
    this.depth = 0;
  }

  // -------------------------------------------------------------------------
  // Token helpers
  // -------------------------------------------------------------------------

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private advance(): Token {
    const tok = this.tokens[this.pos]!;
    this.pos++;
    return tok;
  }

  private isAtEnd(): boolean {
    return this.peek().kind === 'EOF';
  }

  /** Check if current token matches kind and optional value. */
  private check(kind: Token['kind'], value?: string): boolean {
    const tok = this.peek();
    if (tok.kind !== kind) return false;
    if (value !== undefined && tok.value !== value) return false;
    return true;
  }

  /** Consume token if it matches, otherwise return false. */
  private match(kind: Token['kind'], value?: string): boolean {
    if (this.check(kind, value)) {
      this.advance();
      return true;
    }
    return false;
  }

  /** Consume and return token, or throw with message. */
  private expect(kind: Token['kind'], value?: string): Token {
    const tok = this.peek();
    if (tok.kind !== kind || (value !== undefined && tok.value !== value)) {
      const expected = value !== undefined ? `${kind} '${value}'` : kind;
      throw new ParseError(
        `Expected ${expected} but got ${tok.kind} '${tok.value}' at position ${tok.pos}`
      );
    }
    return this.advance();
  }

  /** Check if current token is a keyword with the given value. */
  private isKeyword(value: string): boolean {
    return this.check('Keyword', value);
  }

  /**
   * True when the next token spells `word`, whether the tokenizer classified it
   * as a keyword or an identifier. Frame and null-ordering grammar words such as
   * FIRST, LAST, GROUP, TIES and EXCLUDE are deliberately absent from the
   * keyword set because they are plausible column names; matching on the token
   * text keeps those columns usable.
   */
  private isWord(value: string): boolean {
    const tok = this.peek();
    if (tok.kind !== 'Keyword' && tok.kind !== 'Identifier') return false;
    return tok.value.toUpperCase() === value;
  }

  private expectWord(value: string): void {
    if (!this.isWord(value)) {
      const tok = this.peek();
      throw new ParseError(
        `Expected ${value} but got ${tok.kind} '${tok.value}' at position ${tok.pos}`
      );
    }
    this.advance();
  }

  // -------------------------------------------------------------------------
  // Entry point
  // -------------------------------------------------------------------------

  parse(): BobsledExpr {
    const expr = this.parseExpr();
    if (!this.isAtEnd()) {
      throw new ParseError(
        `Unexpected token '${this.peek().value}' at position ${this.peek().pos}`
      );
    }
    return expr;
  }

  // -------------------------------------------------------------------------
  // 1. OR
  // -------------------------------------------------------------------------

  /** Run `fn` inside a depth-guard to prevent unbounded recursion. */
  private withDepthGuard<T>(fn: () => T): T {
    if (++this.depth > MAX_DEPTH) {
      throw new ParseError(`Maximum expression nesting depth (${MAX_DEPTH}) exceeded`);
    }
    try {
      return fn();
    } finally {
      this.depth--;
    }
  }

  private parseExpr(): BobsledExpr {
    return this.withDepthGuard(() => {
      let left = this.parseAnd();
      while (this.isKeyword('OR')) {
        this.advance();
        const right = this.parseAnd();
        left = { kind: 'binary_op', op: 'OR', left, right };
      }
      return left;
    });
  }

  // -------------------------------------------------------------------------
  // 2. AND
  // -------------------------------------------------------------------------

  private parseAnd(): BobsledExpr {
    let left = this.parseNot();
    while (this.isKeyword('AND')) {
      this.advance();
      const right = this.parseNot();
      left = { kind: 'binary_op', op: 'AND', left, right };
    }
    return left;
  }

  // -------------------------------------------------------------------------
  // 3. NOT (prefix)
  // -------------------------------------------------------------------------

  private parseNot(): BobsledExpr {
    if (this.isKeyword('NOT')) {
      return this.withDepthGuard(() => {
        this.advance();
        // NOT EXISTS (SELECT ...) → ExistsExpr with negated
        if (this.isKeyword('EXISTS')) {
          this.advance(); // consume EXISTS
          this.expect('LParen');
          const subquerySql = this.extractBalancedSubquery();
          this.expect('RParen');
          return { kind: 'exists', subquerySql, negated: true };
        }
        const operand = this.parseNot();
        return { kind: 'unary_op', op: 'NOT', operand };
      });
    }
    return this.parseComparison();
  }

  // -------------------------------------------------------------------------
  // 4. Comparison
  // -------------------------------------------------------------------------

  private parseComparison(): BobsledExpr {
    let left = this.parseAddSub();

    // IS [NOT] NULL
    if (this.isKeyword('IS')) {
      this.advance();
      const negated = this.match('Keyword', 'NOT');
      this.expect('Keyword', 'NULL');
      return { kind: 'is_null', expr: left, ...(negated ? { negated: true } : {}) };
    }

    // [NOT] BETWEEN ... AND ...
    if (this.isKeyword('NOT')) {
      const saved = this.pos;
      this.advance();
      if (this.isKeyword('BETWEEN')) {
        this.advance();
        const low = this.parseAddSub();
        this.expect('Keyword', 'AND');
        const high = this.parseAddSub();
        return { kind: 'between', expr: left, low, high, negated: true };
      }
      if (this.isKeyword('IN')) {
        this.advance();
        this.expect('LParen');
        if (this.isKeyword('SELECT')) {
          const subquerySql = this.extractBalancedSubquery();
          this.expect('RParen');
          return { kind: 'in_subquery', expr: left, subquerySql, negated: true };
        }
        const list = this.parseExprList();
        this.expect('RParen');
        return { kind: 'in_list', expr: left, list, negated: true };
      }
      if (this.isKeyword('LIKE') || this.isKeyword('ILIKE')) {
        const likeKw = this.advance().value; // LIKE or ILIKE
        const op = `NOT ${likeKw}` as BinaryOp;
        const right = this.parseAddSub();
        return { kind: 'binary_op', op, left, right };
      }
      // NOT didn't lead to BETWEEN, IN, LIKE, or ILIKE — backtrack
      this.pos = saved;
    }

    if (this.isKeyword('BETWEEN')) {
      this.advance();
      const low = this.parseAddSub();
      this.expect('Keyword', 'AND');
      const high = this.parseAddSub();
      return { kind: 'between', expr: left, low, high };
    }

    // IN (list) or IN (SELECT ...)
    if (this.isKeyword('IN')) {
      this.advance();
      this.expect('LParen');
      if (this.isKeyword('SELECT')) {
        const subquerySql = this.extractBalancedSubquery();
        this.expect('RParen');
        return { kind: 'in_subquery', expr: left, subquerySql };
      }
      const list = this.parseExprList();
      this.expect('RParen');
      return { kind: 'in_list', expr: left, list };
    }

    // LIKE / ILIKE
    if (this.isKeyword('LIKE') || this.isKeyword('ILIKE')) {
      const op = this.advance().value as 'LIKE' | 'ILIKE';
      const right = this.parseAddSub();
      left = { kind: 'binary_op', op, left, right };
      return left;
    }

    // Standard comparison operators
    if (this.check('Operator')) {
      const opVal = this.peek().value;
      if (
        opVal === '=' ||
        opVal === '!=' ||
        opVal === '<>' ||
        opVal === '<' ||
        opVal === '>' ||
        opVal === '<=' ||
        opVal === '>='
      ) {
        this.advance();
        const op: BinaryOp = opVal === '<>' ? '!=' : (opVal as BinaryOp);
        const right = this.parseAddSub();
        left = { kind: 'binary_op', op, left, right };
      }
    }

    return left;
  }

  // -------------------------------------------------------------------------
  // 5. Addition / subtraction / string concat
  // -------------------------------------------------------------------------

  private parseAddSub(): BobsledExpr {
    let left = this.parseMulDiv();
    while (this.check('Operator')) {
      const opVal = this.peek().value;
      if (opVal !== '+' && opVal !== '-' && opVal !== '||') break;
      this.advance();
      const right = this.parseMulDiv();
      left = { kind: 'binary_op', op: opVal as BinaryOp, left, right };
    }
    return left;
  }

  // -------------------------------------------------------------------------
  // 6. Multiplication / division / modulo
  // -------------------------------------------------------------------------

  private parseMulDiv(): BobsledExpr {
    let left = this.parseUnary();
    while (this.check('Operator') || this.check('Star')) {
      const tok = this.peek();
      // Star token represents * in multiplication context
      const opVal = tok.kind === 'Star' ? '*' : tok.value;
      if (opVal !== '*' && opVal !== '/' && opVal !== '%') break;
      this.advance();
      const right = this.parseUnary();
      left = { kind: 'binary_op', op: opVal as BinaryOp, left, right };
    }
    return left;
  }

  // -------------------------------------------------------------------------
  // 7. Unary minus
  // -------------------------------------------------------------------------

  private parseUnary(): BobsledExpr {
    if (this.check('Operator', '-')) {
      this.advance();
      const operand = this.parseUnary();
      return { kind: 'unary_op', op: '-', operand };
    }
    let expr = this.parsePrimary();
    expr = this.parseJsonPathChain(expr);
    while (this.check('Operator', '::')) {
      expr = this.parseShorthandCast(expr);
    }
    return expr;
  }

  // -------------------------------------------------------------------------
  // 8. Primary
  // -------------------------------------------------------------------------

  private parsePrimary(): BobsledExpr {
    const tok = this.peek();

    // Parenthesized expression or scalar subquery (SELECT ...)
    if (tok.kind === 'LParen') {
      this.advance();
      if (this.isKeyword('SELECT')) {
        const subquerySql = this.extractBalancedSubquery();
        this.expect('RParen');
        return { kind: 'subquery', sql: subquerySql };
      }
      const inner = this.parseExpr();
      this.expect('RParen');
      return { kind: 'parenthesized', expr: inner };
    }

    // Number literal
    if (tok.kind === 'Number') {
      this.advance();
      return { kind: 'literal_number', value: Number(tok.value), raw: tok.value };
    }

    // String literal
    if (tok.kind === 'String') {
      this.advance();
      return { kind: 'literal_string', value: tok.value };
    }

    // Star (standalone, e.g. SELECT *)
    if (tok.kind === 'Star') {
      this.advance();
      return { kind: 'literal_star' };
    }

    // Keywords that start expressions
    if (tok.kind === 'Keyword') {
      switch (tok.value) {
        case 'NULL':
          this.advance();
          return { kind: 'literal_null' };
        case 'TRUE':
          this.advance();
          return { kind: 'literal_boolean', value: true };
        case 'FALSE':
          this.advance();
          return { kind: 'literal_boolean', value: false };
        case 'CASE':
          return this.parseCaseExpr();
        case 'CAST':
          return this.parseCastExpr();
        case 'RAW_SQL':
          return this.parseRawSqlPseudoFunction();
        case 'EXISTS':
          return this.parseExistsExpr();
        case 'NOT':
          // NOT as prefix at primary level — delegate to parseNot
          return this.parseNot();
        default:
          throw new ParseError(`Unexpected keyword '${tok.value}' at position ${tok.pos}`);
      }
    }

    // Identifier: could be column_ref, table.column, table.*, or function call
    if (tok.kind === 'Identifier') {
      return this.parseIdentifierExpr();
    }

    throw new ParseError(`Unexpected token '${tok.value}' (${tok.kind}) at position ${tok.pos}`);
  }

  // -------------------------------------------------------------------------
  // Identifier-starting expressions
  // -------------------------------------------------------------------------

  private parseIdentifierExpr(): BobsledExpr {
    // `INTERVAL 7 DAY` / `INTERVAL '7' DAY`. Recognised by shape rather than by
    // reserving the word, so a column named `interval` stays usable.
    if (this.isWord('INTERVAL') && this.startsIntervalLiteral()) {
      return this.parseIntervalLiteral();
    }

    const name = this.advance(); // consume identifier

    // Function call: name(...)
    if (this.check('LParen')) {
      let fnCall = this.parseFunctionCall(name.value);
      // IGNORE NULLS / RESPECT NULLS modifier (e.g. LAST_VALUE(x) IGNORE NULLS OVER (...))
      if (this.isKeyword('IGNORE') || this.isKeyword('RESPECT')) {
        const handling =
          this.advance().value === 'IGNORE' ? ('ignore' as const) : ('respect' as const);
        this.expect('Keyword', 'NULLS');
        fnCall = { ...fnCall, nullsHandling: handling };
      }
      // Check for window function: fn(...) OVER (...)
      if (this.isKeyword('OVER')) {
        return this.parseWindowExpr(fnCall);
      }
      return fnCall;
    }

    // Dot: table.column or table.*
    if (this.check('Dot')) {
      this.advance(); // consume dot

      // table.*
      if (this.check('Star')) {
        this.advance();
        return { kind: 'literal_star', table: name.value };
      }

      // table.column
      const col = this.expect('Identifier');

      // table.column could still be followed by ( for function calls,
      // but that's unusual in SQL — treat as column_ref
      return { kind: 'column_ref', table: name.value, column: col.value };
    }

    // Simple column ref
    return { kind: 'column_ref', column: name.value };
  }

  private parseJsonPathChain(base: BobsledExpr): BobsledExpr {
    const steps: JsonPathStep[] = [];

    while (true) {
      if (this.check('Colon')) {
        this.advance();
        const key = this.expect('Identifier');
        steps.push({ kind: 'key', name: key.value });
        continue;
      }

      if (this.check('LBracket')) {
        this.advance();
        const rawIndex = Number(this.expect('Number').value);
        if (!Number.isInteger(rawIndex)) {
          throw new ParseError(`JSON path indexes must be integers`);
        }
        this.expect('RBracket');
        steps.push({ kind: 'index', n: rawIndex });
        continue;
      }

      break;
    }

    if (steps.length === 0) {
      return base;
    }

    return { kind: 'json_path_access', base, steps };
  }

  // -------------------------------------------------------------------------
  // Function call: name(args...) with DISTINCT support
  // -------------------------------------------------------------------------

  private parseFunctionCall(rawName: string): FunctionCallExpr {
    const fnName = rawName.toLowerCase();
    this.expect('LParen');

    // Empty args: fn()
    if (this.check('RParen')) {
      this.advance();
      return { kind: 'function_call', name: fnName, args: [] };
    }

    // count(*) special case
    if (this.check('Star')) {
      // Only treat as literal_star if this is the sole argument
      const nextPos = this.pos + 1;
      const nextTok = this.tokens[nextPos];
      if (nextTok && nextTok.kind === 'RParen') {
        this.advance(); // consume star
        this.advance(); // consume rparen
        return {
          kind: 'function_call',
          name: fnName,
          args: [{ kind: 'literal_star' } as const],
        };
      }
    }

    // DISTINCT modifier (not a keyword in our tokenizer — arrives as an Identifier)
    let distinct = false;
    if (this.check('Identifier') && this.peek().value.toUpperCase() === 'DISTINCT') {
      distinct = true;
      this.advance();
    }

    const args = this.parseExprList();
    this.expect('RParen');

    return {
      kind: 'function_call',
      name: fnName,
      args,
      ...(distinct ? { distinct: true } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // CASE expression
  // -------------------------------------------------------------------------

  private parseCaseExpr(): BobsledExpr {
    this.expect('Keyword', 'CASE');

    // Determine simple vs searched CASE
    let operand: BobsledExpr | undefined;
    if (!this.isKeyword('WHEN') && !this.isKeyword('END')) {
      // Simple CASE: CASE expr WHEN ...
      operand = this.parseExpr();
    }

    const whens: CaseWhen[] = [];
    while (this.isKeyword('WHEN')) {
      this.advance();
      const condition = this.parseExpr();
      this.expect('Keyword', 'THEN');
      const result = this.parseExpr();
      whens.push({ condition, result });
    }

    let elseExpr: BobsledExpr | undefined;
    if (this.isKeyword('ELSE')) {
      this.advance();
      elseExpr = this.parseExpr();
    }

    this.expect('Keyword', 'END');

    return {
      kind: 'case',
      ...(operand !== undefined ? { operand } : {}),
      whens,
      ...(elseExpr !== undefined ? { elseExpr } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // CAST expression
  // -------------------------------------------------------------------------

  private parseCastExpr(): BobsledExpr {
    this.expect('Keyword', 'CAST');
    this.expect('LParen');
    const expr = this.parseExpr();
    this.expect('Keyword', 'AS');
    const targetType = this.parseTypeRef();
    this.expect('RParen');
    return { kind: 'cast', expr, targetType };
  }

  private parseShorthandCast(expr: BobsledExpr): BobsledExpr {
    this.expect('Operator', '::');
    const targetType = this.parseTypeRef();
    return { kind: 'cast', expr, targetType, shorthand: true };
  }

  private parseTypeRef(): TypeRef {
    // Type name can be an identifier or keyword (e.g. NULL could theoretically appear,
    // but mostly we expect identifiers like VARCHAR, INTEGER, etc.)
    const tok = this.peek();
    if (tok.kind !== 'Identifier' && tok.kind !== 'Keyword') {
      throw new ParseError(
        `Expected type name but got ${tok.kind} '${tok.value}' at position ${tok.pos}`
      );
    }

    // Consume multi-word type names: TIMESTAMP WITH TIME ZONE, DOUBLE PRECISION, etc.
    const typeParts: string[] = [this.advance().value.toUpperCase()];
    while (
      (this.check('Identifier') || this.check('Keyword')) &&
      TYPE_CONTINUATIONS.has(this.peek().value.toUpperCase())
    ) {
      typeParts.push(this.advance().value.toUpperCase());
    }
    const name = typeParts.join(' ');

    // Optional type params: (p1, p2)
    if (this.check('LParen')) {
      this.advance();
      const params: number[] = [];
      params.push(Number(this.expect('Number').value));
      while (this.match('Comma')) {
        params.push(Number(this.expect('Number').value));
      }
      this.expect('RParen');
      return { name, params };
    }

    return { name };
  }

  // -------------------------------------------------------------------------
  // raw_sql() pseudo-function
  // -------------------------------------------------------------------------

  private parseRawSqlPseudoFunction(): BobsledExpr {
    this.expect('Keyword', 'RAW_SQL');
    this.expect('LParen');

    // Read everything until matching ) as raw content — NOT parsed as expression.
    // We track paren depth so nested parens inside the raw SQL are handled.
    let depth = 1;
    const startPos = this.peek().pos;
    // We need the original input. Reconstruct from tokens.
    // Actually, we just consume tokens until we find the matching RParen.
    const parts: string[] = [];

    while (!this.isAtEnd() && depth > 0) {
      const t = this.peek();
      if (t.kind === 'LParen') {
        depth++;
        parts.push('(');
        this.advance();
      } else if (t.kind === 'RParen') {
        depth--;
        if (depth === 0) {
          this.advance(); // consume the closing paren
          break;
        }
        parts.push(')');
        this.advance();
      } else {
        // Reconstruct the token's original text
        parts.push(this.tokenToString(t));
        this.advance();
      }
    }

    if (depth !== 0) {
      throw new ParseError(`Unterminated raw_sql() at position ${startPos}`);
    }

    const sql = parts.join(' ').trim();
    return { kind: 'raw_sql', sql, explicit: true };
  }

  /** Reconstruct a token's approximate original text. */
  private tokenToString(tok: Token): string {
    switch (tok.kind) {
      case 'String':
        return `'${tok.value.replace(/'/g, "''")}'`;
      case 'Star':
        return '*';
      case 'Dot':
        return '.';
      case 'Comma':
        return ',';
      case 'LParen':
        return '(';
      case 'RParen':
        return ')';
      default:
        return tok.value;
    }
  }

  // -------------------------------------------------------------------------
  // Window expression: fn(...) OVER (...)
  // -------------------------------------------------------------------------

  private parseWindowExpr(fn: FunctionCallExpr): BobsledExpr {
    this.expect('Keyword', 'OVER');

    // Check if this is a named window reference (OVER identifier)
    // vs an inline window spec (OVER (...))
    if (this.peek().kind === 'Identifier') {
      const windowName = this.advance().value;
      return {
        kind: 'window',
        fn,
        windowName,
      };
    }

    this.expect('LParen');

    let partitionBy: BobsledExpr[] | undefined;
    let orderBy: WindowOrderByItem[] | undefined;
    let frame: WindowFrameSpec | { kind: 'raw_sql'; sql: string } | undefined;

    // PARTITION BY
    if (this.isKeyword('PARTITION')) {
      this.advance(); // consume PARTITION
      this.expect('Keyword', 'BY');
      partitionBy = this.parseExprList();
    }

    // ORDER BY
    if (this.isKeyword('ORDER')) {
      this.advance(); // consume ORDER
      this.expect('Keyword', 'BY');
      orderBy = [];
      do {
        const expr = this.parseExpr();
        let direction: 'ASC' | 'DESC' | undefined;
        if (this.isKeyword('ASC')) {
          this.advance();
          direction = 'ASC';
        } else if (this.isKeyword('DESC')) {
          this.advance();
          direction = 'DESC';
        }
        const nulls = this.parseNullsOrdering();
        orderBy.push({ expr, ...(direction ? { direction } : {}), ...(nulls ? { nulls } : {}) });
      } while (this.match('Comma'));
    }

    // Frame clause (ROWS/RANGE/GROUPS BETWEEN ...) — structured parse with raw fallback
    if (this.isKeyword('ROWS') || this.isKeyword('RANGE') || this.isKeyword('GROUPS')) {
      frame = this.parseWindowFrame();
    }

    this.expect('RParen');

    return {
      kind: 'window',
      fn,
      ...(partitionBy ? { partitionBy } : {}),
      ...(orderBy ? { orderBy } : {}),
      ...(frame ? { frame } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // EXISTS (SELECT ...)
  // -------------------------------------------------------------------------

  private parseExistsExpr(): BobsledExpr {
    this.expect('Keyword', 'EXISTS');
    this.expect('LParen');
    const subquerySql = this.extractBalancedSubquery();
    this.expect('RParen');
    return { kind: 'exists', subquerySql };
  }

  // -------------------------------------------------------------------------
  // Subquery SQL extraction
  // -------------------------------------------------------------------------

  /**
   * Extract the raw SQL of a subquery starting at the current position.
   * Assumes the opening `(` has already been consumed and that the current
   * token is `SELECT`. Collects tokens until the matching `)` is found
   * (tracking nested parens). Does NOT consume the closing `)`.
   */
  private extractBalancedSubquery(): string {
    const parts: string[] = [];
    let depth = 0;

    while (!this.isAtEnd()) {
      const t = this.peek();
      if (t.kind === 'LParen') {
        depth++;
        parts.push('(');
        this.advance();
      } else if (t.kind === 'RParen') {
        if (depth === 0) {
          // This is the matching close paren — don't consume it
          break;
        }
        depth--;
        parts.push(')');
        this.advance();
      } else {
        parts.push(this.tokenToString(t));
        this.advance();
      }
    }

    return parts.join(' ').trim();
  }

  // -------------------------------------------------------------------------
  // Window frame parsing
  // -------------------------------------------------------------------------

  /**
   * Parse a structured window frame clause (ROWS/RANGE/GROUPS ...).
   * Falls back to RawSqlExpr if the frame cannot be parsed structurally.
   */
  /** True when the tokens after INTERVAL look like an interval literal. */
  private startsIntervalLiteral(): boolean {
    // An optional leading minus, so `INTERVAL -7 DAY` is recognised too.
    const signed = this.tokens[this.pos + 1]?.value === '-';
    const amount = this.tokens[this.pos + (signed ? 2 : 1)];
    const unit = this.tokens[this.pos + (signed ? 3 : 2)];
    if (!amount || !unit) return false;
    if (amount.kind !== 'Number' && amount.kind !== 'String') return false;
    return unit.kind === 'Keyword' || unit.kind === 'Identifier';
  }

  private parseIntervalLiteral(): BobsledExpr {
    this.advance(); // consume INTERVAL
    const negative = this.peek().value === '-';
    if (negative) this.advance();
    const amountTok = this.advance();
    const parsed = Number(amountTok.value);
    const amount = negative ? -parsed : parsed;
    if (!Number.isInteger(amount)) {
      // BigQuery, MySQL, DuckDB and Databricks all require a whole number, so a
      // fractional amount would compile here and fail at the warehouse.
      throw new ParseError(
        `INTERVAL amount must be a whole number but got '${amountTok.value}' at position ${amountTok.pos}. ` +
          `Use a smaller unit, for example 12 HOUR instead of 0.5 DAY.`
      );
    }
    const unitTok = this.advance();
    // Accept the plural spelling and normalise, since dialects differ on it.
    const raw = unitTok.value.toUpperCase().replace(/S$/, '');
    if (!INTERVAL_UNITS.has(raw)) {
      throw new ParseError(
        `Unsupported INTERVAL unit '${unitTok.value}' at position ${unitTok.pos}. ` +
          `Supported: ${[...INTERVAL_UNITS].join(', ')}`
      );
    }
    return { kind: 'interval', amount, unit: raw as IntervalUnit };
  }

  /** Parse an optional `NULLS FIRST` / `NULLS LAST` modifier. */
  private parseNullsOrdering(): 'FIRST' | 'LAST' | undefined {
    if (!this.isKeyword('NULLS')) return undefined;
    this.advance();
    if (this.isWord('FIRST')) {
      this.advance();
      return 'FIRST';
    }
    if (this.isWord('LAST')) {
      this.advance();
      return 'LAST';
    }
    const tok = this.peek();
    throw new ParseError(
      `Expected FIRST or LAST after NULLS but got ${tok.kind} '${tok.value}' at position ${tok.pos}`
    );
  }

  /** Parse an optional frame `EXCLUDE` clause. */
  private parseFrameExclude(): FrameExclude | undefined {
    if (!this.isWord('EXCLUDE')) return undefined;
    this.advance();
    if (this.isKeyword('CURRENT')) {
      this.advance();
      this.expectWord('ROW');
      return 'CURRENT ROW';
    }
    if (this.isWord('GROUP')) {
      this.advance();
      return 'GROUP';
    }
    if (this.isWord('TIES')) {
      this.advance();
      return 'TIES';
    }
    if (this.isWord('NO')) {
      this.advance();
      this.expectWord('OTHERS');
      return 'NO OTHERS';
    }
    const tok = this.peek();
    throw new ParseError(
      `Expected CURRENT ROW, GROUP, TIES or NO OTHERS after EXCLUDE but got ` +
        `${tok.kind} '${tok.value}' at position ${tok.pos}`
    );
  }

  /**
   * Frame-only entry point used by `parseWindowFrameClause`. Unlike the
   * in-expression path there is no raw-SQL fallback: a frame that does not
   * parse is a validation error, because the alternative is emitting
   * unvalidated text into every dialect.
   */
  parseStandaloneWindowFrame(): WindowFrameSpec {
    if (!this.isKeyword('ROWS') && !this.isKeyword('RANGE') && !this.isKeyword('GROUPS')) {
      const tok = this.peek();
      throw new ParseError(
        `Window frame must start with ROWS, RANGE or GROUPS but got ${tok.kind} '${tok.value}'`
      );
    }
    const frame = this.parseWindowFrame();
    if (frame.kind !== 'window_frame') {
      throw new ParseError(`Unsupported window frame clause`);
    }
    if (!this.isAtEnd()) {
      const tok = this.peek();
      throw new ParseError(
        `Unexpected ${tok.kind} '${tok.value}' after window frame at position ${tok.pos}`
      );
    }
    return frame;
  }

  private parseWindowFrame(): WindowFrameSpec | { kind: 'raw_sql'; sql: string } {
    const frameType = this.advance().value as 'ROWS' | 'RANGE' | 'GROUPS';

    // Try structured parse of the bounds. Bounds the structured grammar cannot
    // represent — an INTERVAL offset, for one — fall back to raw frame text.
    const saved = this.pos;
    let frame: WindowFrameSpec;
    try {
      if (this.isKeyword('BETWEEN')) {
        this.advance(); // consume BETWEEN
        const start = this.parseFrameBound();
        this.expect('Keyword', 'AND');
        const end = this.parseFrameBound();
        frame = { kind: 'window_frame', type: frameType, start, end };
      } else {
        // Shorthand: ROWS UNBOUNDED PRECEDING (no BETWEEN)
        frame = { kind: 'window_frame', type: frameType, start: this.parseFrameBound() };
      }
    } catch {
      // Fallback: collect remaining tokens as raw SQL
      this.pos = saved;
      const parts: string[] = [frameType];
      while (!this.check('RParen') && !this.isAtEnd()) {
        parts.push(this.tokenToString(this.peek()));
        this.advance();
      }
      return { kind: 'raw_sql', sql: parts.join(' ') };
    }

    // EXCLUDE is parsed outside the fallback: once the bounds parsed, a word
    // that is not a valid exclude target is a typo, and letting it degrade to
    // raw frame text would slip it past the per-dialect capability gate.
    const exclude = this.parseFrameExclude();
    return exclude === undefined ? frame : { ...frame, exclude };
  }

  /**
   * Parse a single frame bound: CURRENT ROW, UNBOUNDED PRECEDING/FOLLOWING,
   * or <expr> PRECEDING/FOLLOWING.
   */
  private parseFrameBound(): FrameBound {
    if (this.isKeyword('CURRENT')) {
      this.advance(); // consume CURRENT
      // Accept ROW as either keyword or identifier
      const tok = this.peek();
      if (
        (tok.kind === 'Keyword' || tok.kind === 'Identifier') &&
        tok.value.toUpperCase() === 'ROW'
      ) {
        this.advance();
        return 'CURRENT ROW';
      }
      throw new ParseError(`Expected ROW after CURRENT at position ${tok.pos}`);
    }

    if (this.isKeyword('UNBOUNDED')) {
      this.advance(); // consume UNBOUNDED
      if (this.isKeyword('PRECEDING')) {
        this.advance();
        return 'UNBOUNDED PRECEDING';
      }
      if (this.isKeyword('FOLLOWING')) {
        this.advance();
        return 'UNBOUNDED FOLLOWING';
      }
      throw new ParseError(
        `Expected PRECEDING or FOLLOWING after UNBOUNDED at position ${this.peek().pos}`
      );
    }

    // Numeric (or expression) offset: <expr> PRECEDING/FOLLOWING
    const offset = this.parseExpr();
    if (this.isKeyword('PRECEDING')) {
      this.advance();
      return { offset, direction: 'PRECEDING' };
    }
    if (this.isKeyword('FOLLOWING')) {
      this.advance();
      return { offset, direction: 'FOLLOWING' };
    }
    throw new ParseError(
      `Expected PRECEDING or FOLLOWING after frame offset at position ${this.peek().pos}`
    );
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Parse a comma-separated list of expressions. */
  private parseExprList(): BobsledExpr[] {
    const list: BobsledExpr[] = [];
    list.push(this.parseExpr());
    while (this.match('Comma')) {
      list.push(this.parseExpr());
    }
    return list;
  }
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse an expression string. Returns `raw_sql` node on parse failure.
 *
 * Auto-detection: attempts DSL parse → if it succeeds and consumes all input,
 * returns AST. If it fails or doesn't consume all input, returns
 * `{ kind: 'raw_sql', sql: input }`.
 */
export function parseExprField(input: string): BobsledExpr {
  // Preserve native quoting and comments in a complete raw_sql() field. The DSL
  // tokenizer deliberately does not recognize every warehouse's literal syntax.
  const raw = /^\s*raw_sql\s*\(([\s\S]*)\)\s*$/i.exec(input);
  if (raw && expressionSyntaxVariants(input).some(isCompleteRawSqlCall)) {
    return { kind: 'raw_sql', sql: raw[1]!.trim(), explicit: true };
  }
  const result = tryParseExpr(input);
  if (result.ok) {
    return result.expr;
  }
  return { kind: 'raw_sql', sql: input };
}

function isCompleteRawSqlCall(syntax: string): boolean {
  const trimmed = syntax.trim();
  let depth = 0;
  for (let i = trimmed.indexOf('('); i < trimmed.length; i++) {
    if (trimmed[i] === '(') depth++;
    if (trimmed[i] === ')' && --depth === 0) return i === trimmed.length - 1;
  }
  return false;
}

/**
 * Parse an expression string. Returns structured error on failure.
 */
export function tryParseExpr(input: string): ParseResult {
  if (input.trim() === '') {
    return { ok: false, error: 'Empty expression' };
  }

  const fromClauseKeyword = input.match(/^\s*(LATERAL|JSON_TABLE)\b/i)?.[1]?.toUpperCase();
  const fromClauseHint =
    fromClauseKeyword === 'LATERAL'
      ? ' LATERAL FLATTEN is a FROM-clause construct — use the `flatten_json` config field instead.'
      : fromClauseKeyword === 'JSON_TABLE'
        ? ' JSON_TABLE is a FROM-clause construct — use the `flatten_json` config field instead.'
        : '';

  let tokens: Token[];
  try {
    tokens = tokenize(input);
  } catch (err) {
    return {
      ok: false,
      error: (err instanceof Error ? err.message : String(err)) + fromClauseHint,
    };
  }

  try {
    const parser = new Parser(tokens);
    const expr = parser.parse();
    return { ok: true, expr };
  } catch (err) {
    return {
      ok: false,
      error: (err instanceof Error ? err.message : String(err)) + fromClauseHint,
    };
  }
}

/**
 * Parse a standalone window frame clause such as
 * `ROWS BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE TIES`.
 *
 * Model-level named windows carry their frame as its own field rather than
 * inside an expression, so they need an entry point that parses just the frame.
 * Throws when the text is not a complete frame clause; callers surface that as
 * a validation error rather than passing the text through to the warehouse.
 */
export function parseWindowFrameClause(clause: string): WindowFrameSpec {
  const tokens = tokenize(clause);
  const parser = new Parser(tokens);
  return parser.parseStandaloneWindowFrame();
}
