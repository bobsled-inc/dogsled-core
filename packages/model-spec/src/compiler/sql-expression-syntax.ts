/**
 * Extract syntax for expression safety and CTE hoisting, replacing quoted values
 * and identifiers with inert tokens and comments with whitespace. The expression
 * DSL lexer cannot do this: native SQL intentionally falls back from that parser.
 *
 * Schemas have no dialect yet. Codegen checks again with the actual dialect, so
 * a quoting form supported by one warehouse cannot hide syntax on another.
 * Each pass is linear in the input size.
 */
import type { SupportedDialect } from './dialect.js';

interface Quoting {
  escapes: boolean;
  doubleEscapes?: boolean;
  backticks?: 'doubled' | 'escaped';
  dollar?: 'tagged' | 'untagged';
  triple?: boolean;
  raw?: boolean;
  lineComments?: 'mysql' | 'hash' | 'clickhouse';
}

const standard: Quoting = { escapes: false, dollar: 'tagged' };
const snowflake: Quoting = { escapes: true, dollar: 'untagged' };
const bigquery: Quoting = {
  escapes: true,
  doubleEscapes: true,
  backticks: 'escaped',
  triple: true,
  raw: true,
  lineComments: 'hash',
};
const databricks: Quoting = {
  escapes: true,
  doubleEscapes: true,
  backticks: 'doubled',
  raw: true,
};
const mysql: Quoting = {
  escapes: true,
  doubleEscapes: true,
  backticks: 'doubled',
  lineComments: 'mysql',
};
const mysqlNoEscapes: Quoting = { ...mysql, escapes: false, doubleEscapes: false };
const clickhouse: Quoting = {
  escapes: true,
  doubleEscapes: true,
  backticks: 'escaped',
  dollar: 'tagged',
  lineComments: 'clickhouse',
};
const quoting: Record<SupportedDialect, Quoting[]> = {
  postgres: [standard],
  pgvector: [standard],
  redshift: [standard, { ...standard, escapes: true }],
  duckdb: [standard],
  snowflake: [snowflake],
  bigquery: [bigquery],
  databricks: [databricks],
  mysql: [mysql, mysqlNoEscapes],
  clickhouse: [clickhouse],
};

/** Syntax masks preserve input length and character offsets for structural scans. */
export function expressionSyntaxVariants(sql: string, dialect?: SupportedDialect): string[] {
  const variants: string[] = [];
  const profiles = dialect
    ? quoting[dialect]
    : [standard, snowflake, bigquery, databricks, mysql, mysqlNoEscapes, clickhouse];
  for (const profile of profiles) {
    const syntax = expressionSyntax(sql, profile);
    if (syntax !== undefined) variants.push(syntax.text);
  }
  return variants;
}

/** Keep a final line comment from consuming an alias, predicate or FROM clause. */
export function terminateSqlLineComment(sql: string, dialect: SupportedDialect): string {
  return quoting[dialect].some((profile) => expressionSyntax(sql, profile)?.endsInLineComment)
    ? `${sql}\n`
    : sql;
}

function expressionSyntax(
  sql: string,
  profile: Quoting
): { text: string; endsInLineComment: boolean } | undefined {
  const parts: string[] = [];
  let endsInLineComment = false;
  let i = 0;
  while (i < sql.length) {
    const tokenStart = i;
    const ch = sql[i]!;
    const afterDash = sql.charCodeAt(i + 2);
    const dashComment =
      sql.startsWith('--', i) &&
      (profile.lineComments !== 'mysql' || afterDash <= 32 || afterDash === 127);
    const hashComment =
      ch === '#' &&
      profile.lineComments &&
      (profile.lineComments !== 'clickhouse' || sql[i + 1] === ' ' || sql[i + 1] === '!');
    const slashComment = profile.lineComments === 'clickhouse' && sql.startsWith('//', i);
    if (dashComment || hashComment || slashComment) {
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++;
      endsInLineComment = i === sql.length;
      parts.push(' '.repeat(i - tokenStart));
      continue;
    }
    if (sql.startsWith('/*', i)) {
      // Executable MySQL comments and ambiguous nested block comments cannot be
      // discarded safely across dialects. Fail closed, as for unclosed comments.
      const end = sql.indexOf('*/', i + 2);
      const nested = sql.indexOf('/*', i + 2);
      if (sql[i + 2] === '!' || end < 0 || (nested >= 0 && nested < end)) return;
      i = end + 2;
      parts.push(' '.repeat(i - tokenStart));
      continue;
    }
    if (ch === '$') {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        if (!profile.dollar || (profile.dollar === 'untagged' && tag !== '$$')) return;
        const end = sql.indexOf(tag, i + tag.length);
        if (end < 0) return;
        i = end + tag.length;
        parts.push('?'.padEnd(i - tokenStart, ' '));
        continue;
      }
    }

    // Keep identifiers intact (including embedded $), recognizing native literal
    // prefixes only at token boundaries: E, N, B, X, R, BR and RB.
    let prefix = '';
    if (/[A-Za-z_]/.test(ch)) {
      const start = i++;
      while (i < sql.length && /[\w$]/.test(sql[i]!)) i++;
      prefix = sql.slice(start, i);
      if (!/^(?:e|n|b|x|r|br|rb)$/i.test(prefix) || !/["']/.test(sql[i] ?? '')) {
        parts.push(prefix);
        continue;
      }
    }

    const quote = sql[i]!;
    if (quote === "'" || quote === '"' || quote === '`') {
      if (quote === '`' && !profile.backticks) return;
      const raw = /r/i.test(prefix);
      if (raw && !profile.raw) return;
      const escape =
        !raw &&
        (quote === '`'
          ? profile.backticks === 'escaped'
          : quote === '"'
            ? profile.doubleEscapes
            : profile.escapes || /^e$/i.test(prefix));
      const triple = profile.triple && quote !== '`' && sql.startsWith(quote.repeat(3), i);
      const delimiter = triple ? quote.repeat(3) : quote;
      i += delimiter.length;
      let closed = false;
      while (i < sql.length) {
        if (escape && sql[i] === '\\') {
          i += 2;
        } else if (!triple && sql[i] === quote && sql[i + 1] === quote) {
          i += 2;
        } else if (sql.startsWith(delimiter, i)) {
          if (raw) {
            let backslashes = 0;
            for (let j = i - 1; j >= 0 && sql[j] === '\\'; j--) backslashes++;
            if (backslashes % 2 !== 0) return;
          }
          i += delimiter.length;
          closed = true;
          break;
        } else {
          i++;
        }
      }
      if (!closed) return;
      parts.push('?'.padEnd(i - tokenStart, ' '));
      continue;
    }
    parts.push(ch);
    i++;
  }
  return { text: parts.join(''), endsInLineComment };
}
