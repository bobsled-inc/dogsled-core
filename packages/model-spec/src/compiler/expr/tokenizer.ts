/**
 * Expression DSL tokenizer.
 *
 * Produces a flat token stream consumed by the recursive-descent parser.
 * Case-insensitive keyword recognition; tracks position for error reporting.
 */

import { MODEL_SPEC_ERROR_CODES, modelSpecHint } from '../error-hints.js';

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

export type TokenKind =
  | 'Identifier'
  | 'Number'
  | 'String'
  | 'Operator'
  | 'LParen'
  | 'RParen'
  | 'LBracket'
  | 'RBracket'
  | 'Comma'
  | 'Dot'
  | 'Colon'
  | 'Star'
  | 'Keyword'
  | 'EOF';

export interface Token {
  kind: TokenKind;
  value: string;
  /** 0-based character offset in the source string. */
  pos: number;
}

// ---------------------------------------------------------------------------
// Keywords (upper-cased for lookup)
// ---------------------------------------------------------------------------

const KEYWORDS = new Set([
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'AND',
  'OR',
  'NOT',
  'IN',
  'BETWEEN',
  'IS',
  'LIKE',
  'ILIKE',
  'NULL',
  'TRUE',
  'FALSE',
  'CAST',
  'AS',
  'RAW_SQL',
  'OVER',
  'PARTITION',
  'BY',
  'ORDER',
  'ASC',
  'DESC',
  'ROWS',
  'RANGE',
  'GROUPS',
  'UNBOUNDED',
  'PRECEDING',
  'FOLLOWING',
  'CURRENT',
  'IGNORE',
  'RESPECT',
  'NULLS',
  'SELECT',
  'EXISTS',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentChar(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

// ---------------------------------------------------------------------------
// Two-char operators (checked before single-char)
// ---------------------------------------------------------------------------

const TWO_CHAR_OPS = new Set(['!=', '<>', '<=', '>=', '||', '::']);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Tokenize an expression string into a list of {@link Token}s.
 * The list always ends with an `EOF` token.
 *
 * @throws {Error} on unrecognized characters.
 */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;

    // Skip whitespace
    if (isWhitespace(ch)) {
      i++;
      continue;
    }

    // Single-quoted string literal
    if (ch === "'") {
      const start = i;
      i++; // skip opening quote
      let value = '';
      while (i < input.length) {
        if (input[i] === "'") {
          // escaped quote ('')
          if (i + 1 < input.length && input[i + 1] === "'") {
            value += "'";
            i += 2;
          } else {
            break;
          }
        } else {
          value += input[i];
          i++;
        }
      }
      if (i >= input.length) {
        throw new Error(`Unterminated string literal at position ${start}`);
      }
      i++; // skip closing quote
      tokens.push({ kind: 'String', value, pos: start });
      continue;
    }

    // Number (integer or decimal)
    if (isDigit(ch)) {
      const start = i;
      while (i < input.length && isDigit(input[i]!)) i++;
      if (i < input.length && input[i] === '.') {
        i++;
        while (i < input.length && isDigit(input[i]!)) i++;
      }
      tokens.push({ kind: 'Number', value: input.slice(start, i), pos: start });
      continue;
    }

    // Identifier or keyword
    if (isIdentStart(ch)) {
      const start = i;
      while (i < input.length && isIdentChar(input[i]!)) i++;
      const raw = input.slice(start, i);
      const upper = raw.toUpperCase();
      if (KEYWORDS.has(upper)) {
        tokens.push({ kind: 'Keyword', value: upper, pos: start });
      } else {
        tokens.push({ kind: 'Identifier', value: raw, pos: start });
      }
      continue;
    }

    // Two-character operators
    if (i + 1 < input.length) {
      const twoChar = input.slice(i, i + 2);
      if (TWO_CHAR_OPS.has(twoChar)) {
        tokens.push({ kind: 'Operator', value: twoChar, pos: i });
        i += 2;
        continue;
      }
    }

    // Single-character tokens
    switch (ch) {
      case '(':
        tokens.push({ kind: 'LParen', value: '(', pos: i });
        i++;
        continue;
      case ')':
        tokens.push({ kind: 'RParen', value: ')', pos: i });
        i++;
        continue;
      case ',':
        tokens.push({ kind: 'Comma', value: ',', pos: i });
        i++;
        continue;
      case '[':
        tokens.push({ kind: 'LBracket', value: '[', pos: i });
        i++;
        continue;
      case ']':
        tokens.push({ kind: 'RBracket', value: ']', pos: i });
        i++;
        continue;
      case '.':
        // Leading-dot decimal literal: .5 → 0.5
        if (i + 1 < input.length && isDigit(input[i + 1]!)) {
          const start = i;
          i++; // skip dot
          while (i < input.length && isDigit(input[i]!)) i++;
          tokens.push({ kind: 'Number', value: input.slice(start, i), pos: start });
          continue;
        }
        tokens.push({ kind: 'Dot', value: '.', pos: i });
        i++;
        continue;
      case ':':
        tokens.push({ kind: 'Colon', value: ':', pos: i });
        i++;
        continue;
      case '*':
        tokens.push({ kind: 'Star', value: '*', pos: i });
        i++;
        continue;
      case '+':
      case '-':
      case '/':
      case '%':
      case '=':
      case '<':
      case '>':
        tokens.push({ kind: 'Operator', value: ch, pos: i });
        i++;
        continue;
      default:
        if (ch === '`') {
          // Backtick-quoted identifiers (` `col` `) are MySQL/BigQuery syntax
          // and not part of the Model Spec DSL. The compiler auto-quotes reserved
          // words per-dialect, so users almost never need this — and when
          // they do (non-standard-case identifiers), raw_sql() is the escape
          // hatch.
          throw new Error(
            modelSpecHint(
              MODEL_SPEC_ERROR_CODES.BACKTICK_IDENT,
              `Backtick-quoted identifiers are not part of the Model Spec expression DSL (at position ${i}). ` +
                `MODEL_SPEC auto-quotes reserved words per-dialect; for non-standard-case identifiers wrap them in raw_sql('"col"') ` +
                `(Snowflake/Postgres/DuckDB) or raw_sql('\`col\`') (BigQuery/Databricks/MySQL).`
            )
          );
        }
        throw new Error(`Unexpected character '${ch}' at position ${i}`);
    }
  }

  tokens.push({ kind: 'EOF', value: '', pos: input.length });
  return tokens;
}
