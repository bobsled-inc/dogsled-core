import { getCanonicalDialect, quoteIdentifier, quoteLiteral } from '@bobsled-inc/model-spec';

import type { SupportedDialect } from '@bobsled-inc/model-spec';

const BLOCKING_KEYWORDS = new Set([
  'AND',
  'AS',
  'ASC',
  'BETWEEN',
  'BY',
  'CASE',
  'CAST',
  'COALESCE',
  'CROSS',
  'DESC',
  'DISTINCT',
  'ELSE',
  'END',
  'EXCEPT',
  'EXTRACT',
  'FALSE',
  'FROM',
  'FULL',
  'GROUP',
  'HAVING',
  'INNER',
  'INTERSECT',
  'IN',
  'IS',
  'JOIN',
  'LEFT',
  'LIKE',
  'LIMIT',
  'NATURAL',
  'NOT',
  'NULL',
  'OFFSET',
  'ON',
  'OR',
  'ORDER',
  'OUTER',
  'RIGHT',
  'SELECT',
  'THEN',
  'TRUE',
  'UNION',
  'USING',
  'WHEN',
  'WHERE',
]);

const SQL_TYPE_KEYWORDS = new Set([
  'BIGINT',
  'BOOL',
  'BOOLEAN',
  'CHAR',
  'DATE',
  'DATETIME',
  'DECIMAL',
  'DOUBLE',
  'FLOAT',
  'INT',
  'INTEGER',
  'NUMBER',
  'PRECISION',
  'SMALLINT',
  'STRING',
  'TEXT',
  'TIMESTAMP',
  'VARCHAR',
  'YEAR',
]);

type SqlToken =
  | { type: 'identifier'; value: string }
  | { type: 'number'; value: string }
  | { type: 'string'; value: string }
  | { type: 'quoted_identifier'; value: string }
  | { type: 'whitespace'; value: string }
  | { type: 'symbol'; value: string };

export function stringType(dialect: SupportedDialect): string {
  switch (dialect) {
    case 'bigquery':
    case 'databricks':
      return 'STRING';
    case 'mysql':
      return 'CHAR';
    case 'redshift':
      return 'VARCHAR(65535)';
    case 'postgres':
    case 'pgvector':
    case 'duckdb':
      return 'TEXT';
    case 'snowflake':
      return 'VARCHAR';
    // ClickHouse type names are case-sensitive: `String`, never `STRING`.
    case 'clickhouse':
      return 'String';
  }
}

export function castToString(expr: string, dialect: SupportedDialect): string {
  return `CAST(${expr} AS ${stringType(dialect)})`;
}

export function timestampType(dialect: SupportedDialect): string {
  return getCanonicalDialect(dialect) === 'mysql' ? 'DATETIME' : 'TIMESTAMP';
}

/**
 * ClickHouse types that reject a `Nullable(...)` wrapper. Every other dialect
 * keeps its type name unchanged, so this list only has to cover what the
 * type helpers in this package can actually emit for ClickHouse.
 */
function clickhouseRejectsNullable(type: string): boolean {
  const normalized = type.trim();
  return normalized.endsWith('[]') || /^(?:Nullable|Array|Map|Tuple|JSON)\b/i.test(normalized);
}

/**
 * Make a type name accept NULL. ClickHouse types are non-nullable by default
 * and reject `CAST(NULL AS String)` outright, so a typed NULL needs an
 * explicit `Nullable(...)`; every other dialect's type name already admits
 * NULL and passes through unchanged.
 */
export function nullableType(type: string, dialect: SupportedDialect): string {
  // Only ClickHouse needs the wrapper, so the profile is consulted only for
  // ClickHouse. Callers in this package accept an absent or unrecognised
  // dialect — `quoteLiteral` already tolerates one — and resolving a profile
  // eagerly would turn that into a crash on a path that never needed the
  // dialect before.
  if (dialect !== 'clickhouse') return type;
  if (clickhouseRejectsNullable(type)) return type;
  return `Nullable(${type})`;
}

/**
 * A NULL literal with an explicit type. BigQuery infers bare NULL columns as
 * INT64, which breaks UNION ALL branches and COALESCE/CONCAT calls that
 * combine them with string columns; ClickHouse needs the type to be nullable.
 */
export function nullOfType(type: string, dialect: SupportedDialect): string {
  return `CAST(NULL AS ${nullableType(type, dialect)})`;
}

/** A NULL literal with an explicit string type (see nullOfType). */
export function nullString(dialect: SupportedDialect): string {
  return nullOfType(stringType(dialect), dialect);
}

/** A NULL literal with an explicit timestamp type (see nullOfType). */
export function nullTimestamp(dialect: SupportedDialect): string {
  return nullOfType(timestampType(dialect), dialect);
}

/**
 * Dialect-aware distinct set operator. BigQuery and ClickHouse both reject a
 * bare UNION: BigQuery requires an explicit UNION DISTINCT (or UNION ALL), and
 * ClickHouse errors unless the `union_default_mode` setting is populated.
 */
export function unionDistinct(dialect: SupportedDialect): string {
  const canonical = getCanonicalDialect(dialect);
  return canonical === 'bigquery' || canonical === 'clickhouse' ? 'UNION DISTINCT' : 'UNION';
}

export function concatSql(parts: string[], dialect: SupportedDialect): string {
  if (parts.length === 0) {
    return quoteLiteral('', dialect);
  }
  if (parts.length === 1) {
    return parts[0]!;
  }
  return `CONCAT(${parts.join(', ')})`;
}

export function buildJsonObjectExpr(
  entries: ReadonlyArray<readonly [key: string, valueExpr: string]>,
  dialect: SupportedDialect
): string {
  if (entries.length === 0) {
    return quoteLiteral('{}', dialect);
  }

  const args = entries.flatMap(([key, valueExpr]) => [quoteLiteral(key, dialect), valueExpr]);
  switch (dialect) {
    case 'snowflake':
      return `OBJECT_CONSTRUCT(${args.join(', ')})`;
    case 'bigquery':
      return `JSON_OBJECT(${args.join(', ')})`;
    case 'postgres':
    case 'pgvector':
      return `json_build_object(${args.join(', ')})`;
    case 'redshift':
      return `json_parse(json_serialize(json_build_object(${args.join(', ')})))`;
    case 'duckdb':
      return `json_object(${args.join(', ')})`;
    case 'databricks':
      return `TO_JSON(NAMED_STRUCT(${args.join(', ')}))`;
    case 'mysql':
      return `JSON_OBJECT(${args.join(', ')})`;
    // ClickHouse has no JSON-object constructor over heterogeneous scalars:
    // `map()` needs one common value type and a named `Tuple` needs declared
    // field types, and these entries carry neither.
    case 'clickhouse':
      throw new Error(
        'Entity graph does not support compiler target "clickhouse": building a JSON object from arbitrary scalar SQL expressions has no ClickHouse equivalent.'
      );
  }
}

export function jsonExtractString(
  columnExpr: string,
  path: string,
  dialect: SupportedDialect
): string {
  switch (dialect) {
    case 'snowflake':
      return `${columnExpr}:${path}::VARCHAR`;
    case 'bigquery':
      return `JSON_VALUE(${columnExpr}, ${quoteLiteral(`$.${path}`, dialect)})`;
    case 'postgres':
    case 'pgvector':
      return `${columnExpr} ->> ${quoteLiteral(path, dialect)}`;
    case 'redshift':
      return `json_extract_path_text(${columnExpr}, ${quoteLiteral(path, dialect)})`;
    case 'duckdb':
      return `json_extract_string(${columnExpr}, ${quoteLiteral(`$.${path}`, dialect)})`;
    case 'databricks':
      return `get_json_object(${columnExpr}, ${quoteLiteral(`$.${path}`, dialect)})`;
    case 'mysql':
      return `JSON_UNQUOTE(JSON_EXTRACT(${columnExpr}, ${quoteLiteral(`$.${path}`, dialect)}))`;
    // `path` is a single flat key — the Postgres `->>` branch already relies on
    // that — which is exactly what JSONExtractString's key form takes.
    case 'clickhouse':
      return `JSONExtractString(${columnExpr}, ${quoteLiteral(path, dialect)})`;
  }
}

export function timestampMinusDays(
  days: number,
  dialect: SupportedDialect,
  baseExpr = 'CURRENT_TIMESTAMP'
): string {
  switch (dialect) {
    case 'snowflake':
      return `DATEADD(day, -${days}, ${baseExpr})`;
    case 'bigquery':
      return `TIMESTAMP_SUB(${baseExpr}, INTERVAL ${days} DAY)`;
    case 'postgres':
    case 'pgvector':
    case 'redshift':
    case 'duckdb':
      return `${baseExpr} - INTERVAL '${days} day'`;
    case 'databricks':
      return `${baseExpr} - INTERVAL ${days} DAYS`;
    case 'mysql':
      return `DATE_SUB(${baseExpr}, INTERVAL ${days} DAY)`;
    case 'clickhouse':
      return `${baseExpr} - INTERVAL ${days} DAY`;
  }
}

export function md5Expr(value: string, dialect: SupportedDialect): string {
  switch (dialect) {
    case 'bigquery':
      return `TO_HEX(MD5(${value}))`;
    case 'snowflake':
    case 'postgres':
    case 'pgvector':
    case 'redshift':
    case 'duckdb':
    case 'databricks':
    case 'mysql':
      return `MD5(${value})`;
    // ClickHouse MD5() returns raw FixedString(16) bytes, not a hex digest.
    case 'clickhouse':
      return `lower(hex(MD5(${value})))`;
  }
}

function jsonEscapedString(expr: string, dialect: SupportedDialect): string {
  const backslash = quoteLiteral('\\', dialect);
  const escapedBackslash = quoteLiteral('\\\\', dialect);
  const quote = quoteLiteral('"', dialect);
  const escapedQuote = quoteLiteral('\\"', dialect);
  const newline = quoteLiteral('\n', dialect);
  const escapedNewline = quoteLiteral('\\n', dialect);
  const carriageReturn = quoteLiteral('\r', dialect);
  const escapedCarriageReturn = quoteLiteral('\\r', dialect);
  const tab = quoteLiteral('\t', dialect);
  const escapedTab = quoteLiteral('\\t', dialect);
  const backspace = quoteLiteral('\b', dialect);
  const escapedBackspace = quoteLiteral('\\b', dialect);
  const formFeed = quoteLiteral('\f', dialect);
  const escapedFormFeed = quoteLiteral('\\f', dialect);

  const replacements: Array<[string, string]> = [
    [backslash, escapedBackslash],
    [newline, escapedNewline],
    [carriageReturn, escapedCarriageReturn],
    [tab, escapedTab],
    [backspace, escapedBackspace],
    [formFeed, escapedFormFeed],
    [quote, escapedQuote],
  ];

  let sql = `COALESCE(${castToString(expr, dialect)}, ${quoteLiteral('', dialect)})`;
  for (const [search, replacement] of replacements) {
    sql = [`REPLACE(`, `  ${sql},`, `  ${search},`, `  ${replacement}`, `)`].join('\n');
  }
  return sql;
}

function jsonValueExpr(expr: string, dialect: SupportedDialect): string {
  return [
    `CASE`,
    `  WHEN ${expr} IS NULL THEN ${quoteLiteral('null', dialect)}`,
    `  ELSE ${concatSql(
      [quoteLiteral('"', dialect), jsonEscapedString(expr, dialect), quoteLiteral('"', dialect)],
      dialect
    )}`,
    `END`,
  ].join('\n');
}

export function buildSourcePkJsonExpr(
  idFields: string[],
  dialect: SupportedDialect,
  qualifier?: string
): string {
  if (idFields.length === 0) {
    throw new Error('At least one id_field is required to build source_pk_json.');
  }

  const prefix = qualifier ? `${qualifier}.` : '';
  const segments = idFields.flatMap((field, index) => {
    const columnRef = `${prefix}${quoteIdentifier(field, dialect)}`;
    const pieces = [
      quoteLiteral(`${index === 0 ? '' : ','}"${field}":`, dialect),
      jsonValueExpr(columnRef, dialect),
    ];
    return pieces;
  });

  return concatSql([quoteLiteral('{', dialect), ...segments, quoteLiteral('}', dialect)], dialect);
}

export function buildSourceEntityIdExpr(
  idFields: string[],
  dialect: SupportedDialect,
  qualifier?: string
): string {
  if (idFields.length === 0) {
    throw new Error('At least one id_field is required to build source_entity_id.');
  }

  const prefix = qualifier ? `${qualifier}.` : '';
  if (idFields.length === 1) {
    return castToString(`${prefix}${quoteIdentifier(idFields[0]!, dialect)}`, dialect);
  }

  const pieces = idFields.flatMap((field, index) => {
    const columnRef = `${prefix}${quoteIdentifier(field, dialect)}`;
    return [
      quoteLiteral(`${index === 0 ? '' : '|'}${field}=`, dialect),
      `COALESCE(${castToString(columnRef, dialect)}, ${quoteLiteral('<null>', dialect)})`,
    ];
  });
  return concatSql(pieces, dialect);
}

export function buildRecordIdExpr(
  sourceRef: string,
  sourcePkJsonExpr: string,
  dialect: SupportedDialect
): string {
  return md5Expr(
    concatSql(
      [quoteLiteral(sourceRef, dialect), quoteLiteral('|', dialect), sourcePkJsonExpr],
      dialect
    ),
    dialect
  );
}

export function pairIdExpr(aId: string, bId: string, dialect: SupportedDialect): string {
  const lo = `LEAST(${aId}, ${bId})`;
  const hi = `GREATEST(${aId}, ${bId})`;
  return md5Expr(concatSql([lo, quoteLiteral('||', dialect), hi], dialect), dialect);
}

function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;

  while (index < sql.length) {
    const char = sql[index]!;

    if (/\s/.test(char)) {
      let end = index + 1;
      while (end < sql.length && /\s/.test(sql[end]!)) {
        end += 1;
      }
      tokens.push({ type: 'whitespace', value: sql.slice(index, end) });
      index = end;
      continue;
    }

    if (char === "'") {
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === "'" && sql[end + 1] === "'") {
          end += 2;
          continue;
        }
        if (sql[end] === "'") {
          end += 1;
          break;
        }
        end += 1;
      }
      tokens.push({ type: 'string', value: sql.slice(index, end) });
      index = end;
      continue;
    }

    if (char === '"' || char === '`') {
      const quote = char;
      let end = index + 1;
      while (end < sql.length && sql[end] !== quote) {
        end += 1;
      }
      end = Math.min(end + 1, sql.length);
      tokens.push({ type: 'quoted_identifier', value: sql.slice(index, end) });
      index = end;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end]!)) {
        end += 1;
      }
      tokens.push({ type: 'identifier', value: sql.slice(index, end) });
      index = end;
      continue;
    }

    if (/[0-9]/.test(char)) {
      let end = index + 1;
      while (end < sql.length && /[0-9]/.test(sql[end]!)) {
        end += 1;
      }
      if (end < sql.length && sql[end] === '.') {
        end += 1;
        while (end < sql.length && /[0-9]/.test(sql[end]!)) {
          end += 1;
        }
      }
      tokens.push({ type: 'number', value: sql.slice(index, end) });
      index = end;
      continue;
    }

    tokens.push({ type: 'symbol', value: char });
    index += 1;
  }

  return tokens;
}

function previousSignificant(tokens: SqlToken[], index: number): SqlToken | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (tokens[cursor]!.type !== 'whitespace') {
      return tokens[cursor];
    }
  }
  return undefined;
}

function nextSignificant(tokens: SqlToken[], index: number): SqlToken | undefined {
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    if (tokens[cursor]!.type !== 'whitespace') {
      return tokens[cursor];
    }
  }
  return undefined;
}

export function qualifyBlockingExpression(
  expression: string,
  alias: string,
  dialect: SupportedDialect
): string {
  const tokens = tokenizeSql(expression);
  return tokens
    .map((token, index) => {
      if (token.type !== 'identifier') {
        return token.value;
      }

      const previous = previousSignificant(tokens, index);
      const next = nextSignificant(tokens, index);
      const previousIdentifier =
        previous?.type === 'identifier' ? previous.value.toUpperCase() : undefined;
      const tokenUpper = token.value.toUpperCase();
      if (
        previous?.value === '.' ||
        next?.value === '.' ||
        next?.value === '(' ||
        previousIdentifier === 'AS' ||
        BLOCKING_KEYWORDS.has(tokenUpper) ||
        SQL_TYPE_KEYWORDS.has(tokenUpper)
      ) {
        return token.value;
      }

      return `${alias}.${quoteIdentifier(token.value, dialect)}`;
    })
    .join('');
}
